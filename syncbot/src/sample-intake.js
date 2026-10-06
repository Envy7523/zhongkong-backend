'use strict';
/**
 * 阶段1 样本只读留档工具
 *   node src/sample-intake.js [--dir=<目录>] [--file=<单个文件>] [--screenshot=<png>] [--csv-out=<csv>] [--json]
 *
 * 严格边界（阶段1 要求）：
 *   · 只读：不移动、不改名、不删除样本文件；不写入任何数据库；
 *   · 不调用现有项目导入接口，不调用日报/企业微信推送，不创建定时任务；
 *   · 输出：原始文件名 / 路径 / 大小 / 创建与修改时间 / SHA-256 / 是否仍有未完成下载，
 *           以及 xlsx 的**多层表头**（标题行/筛选条件行/分组行/叶子表头行）与逐列扁平表头、
 *           类型推断、非空计数、数据起始行与门店行数（用于阶段2 字段映射）。
 *
 * 表头识别策略（阶段1 实测改进）：
 *   美团「综合营业统计」导出为多层表头：row1=标题、row2=筛选条件、row3=顶层指标列、
 *   row4=业务分组、row5=叶子表头、row6 起为门店数据行。
 *   因此不再用「第一个非空行」当表头，而是：
 *     1) 叶子表头行 = 前 12 行中文本单元格最多的行；
 *     2) 向上扩展，把仍有 ≥2 个文本单元格的连续行并入表头块（自动排除只有 1 个单元格的标题/筛选行）；
 *     3) 每列扁平表头 = 表头块中该列各非空单元格按层级拼接（如「店内销售 / 营业额(元)」）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./paths');
const config = require('./config');

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    else out._.push(a);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const botCfg = config.bot();
const PLATFORM = String(args.platform || botCfg.platform || 'meituan');
const TC = require('./task-context');
// 报表A 专用工具：显式指定 report_type（不读取任何隐式上下文）
const REPORT_TYPE = TC.assertResidentReportType('cashier_composite');
const INCOMING = P.incoming(PLATFORM, REPORT_TYPE);

function sha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function colLetter(i) {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

const isEmptyCell = (v) => v === null || v === undefined || String(v).trim() === '';
const isTextCell = (v) => !isEmptyCell(v) && typeof v !== 'number' && !(v instanceof Date);

/** 从取值样本推断列类型（不输出具体业务数值，仅用于识别日期列/门店列/订单列/金额列） */
function inferType(values) {
  const nonEmpty = values.filter((v) => !isEmptyCell(v));
  if (nonEmpty.length === 0) return { type: 'empty', nonEmpty: 0, total: values.length };
  let num = 0;
  let dateLike = 0;
  let bool = 0;
  let text = 0;
  for (const v of nonEmpty) {
    if (v instanceof Date) {
      dateLike++;
      continue;
    }
    if (typeof v === 'number') {
      num++;
      continue;
    }
    if (typeof v === 'boolean') {
      bool++;
      continue;
    }
    const s = String(v).trim();
    if (/^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}(日)?([ T]\d{1,2}:\d{2}(:\d{2})?)?$/.test(s)) dateLike++;
    else if (/^-?\d+(\.\d+)?$/.test(s.replace(/,/g, ''))) num++;
    else text++;
  }
  const total = nonEmpty.length;
  const ret = (t) => ({ type: t, nonEmpty: total, total: values.length });
  if (dateLike / total >= 0.8) return ret('date');
  if (num / total >= 0.8) return ret('number');
  if (bool / total >= 0.8) return ret('bool');
  if (text / total >= 0.8) return ret('text');
  return ret('mixed');
}

/** 识别多层表头块：返回 0 基的 {start,end,leaf} */
function detectHeaderBlock(rows, maxScan = 12) {
  let leaf = -1;
  let best = 0;
  for (let i = 0; i < Math.min(maxScan, rows.length); i++) {
    const t = (rows[i] || []).filter(isTextCell).length;
    if (t > best) {
      best = t;
      leaf = i;
    }
  }
  if (leaf < 0) return { start: -1, end: -1, leaf: -1 };
  let start = leaf;
  while (start - 1 >= 0 && (rows[start - 1] || []).filter(isTextCell).length >= 2) start--;
  return { start, end: leaf, leaf };
}

function analyzeXlsx(file) {
  let XLSX;
  try {
    XLSX = require('xlsx');
  } catch (e) {
    return { error: '未安装 xlsx，无法解析（npm install --save-exact xlsx@0.18.5）' };
  }
  const ext = path.extname(file).toLowerCase();
  const wb = XLSX.readFile(file, { cellDates: true, cellText: false, sheetRows: 300, raw: true });
  const sheets = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const range = ws['!ref'] || null;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: true, defval: null });
    const merges = (ws['!merges'] || []).map((m) => `${colLetter(m.s.c)}${m.s.r + 1}:${colLetter(m.e.c)}${m.e.r + 1}`);
    const colCount = Math.max(...rows.map((r) => (r ? r.length : 0)), 0);

    const blk = detectHeaderBlock(rows, 12);
    const headerRows = blk.start >= 0 ? rows.slice(blk.start, blk.leaf + 1) : [];
    const dataRows = blk.leaf >= 0 ? rows.slice(blk.leaf + 1) : [];

    // 合并单元格的组头只在左上角有值 → 按 !merges 填充到整个合并区域，
    // 否则同一分组内除首列外都会丢掉分组名（如只有 M 列带「店内销售」）。
    const filledHeaderRows = headerRows.map((r) => (r ? r.slice() : []));
    for (const m of ws['!merges'] || []) {
      if (blk.start < 0) break;
      if (m.s.r < blk.start || m.s.r > blk.leaf) continue; // 只处理表头块内的合并
      const top = (rows[m.s.r] || [])[m.s.c];
      if (isEmptyCell(top)) continue;
      const rFrom = Math.max(m.s.r, blk.start);
      const rTo = Math.min(m.e.r, blk.leaf);
      for (let r = rFrom; r <= rTo; r++) {
        const row = filledHeaderRows[r - blk.start];
        if (!row) continue;
        for (let c = m.s.c; c <= m.e.c; c++) {
          if (isEmptyCell(row[c])) row[c] = top;
        }
      }
    }

    // 每列扁平表头 = 填充后的表头块中该列非空文本按层级拼接
    const columns = [];
    for (let c = 0; c < colCount; c++) {
      const parts = [];
      for (const hr of filledHeaderRows) {
        const v = hr ? hr[c] : null;
        if (isEmptyCell(v)) continue;
        const s = String(v).trim();
        if (parts[parts.length - 1] !== s) parts.push(s);
      }
      const flat = parts.join(' / ');
      const colValues = dataRows.slice(0, 60).map((r) => (r ? r[c] : null));
      const t = inferType(colValues);
      columns.push({
        index: c + 1,
        letter: colLetter(c),
        header_flat: flat || null,
        header_parts: parts,
        inferred_type: t.type,
        non_empty_in_sample: t.nonEmpty,
        sampled_rows: t.total,
      });
    }

    sheets.push({
      name,
      range,
      merge_count: merges.length,
      merges_sample: merges.slice(0, 40),
      total_rows_read: rows.length,
      column_count: colCount,
      header_block_rows_1based: blk.start >= 0 ? [blk.start + 1, blk.leaf + 1] : null,
      leaf_header_row_1based: blk.leaf >= 0 ? blk.leaf + 1 : null,
      // 标题行与筛选条件行（各自只有 1 个单元格），单独记录便于确认导出条件
      title_row_text: (() => {
        const r = rows[0] || [];
        const v = r.find((x) => !isEmptyCell(x));
        return v === undefined ? null : String(v);
      })(),
      filter_row_text: (() => {
        for (let i = 1; i < Math.min(4, rows.length); i++) {
          const ne = (rows[i] || []).filter((x) => !isEmptyCell(x));
          if (ne.length === 1 && isTextCell(ne[0])) return String(ne[0]);
        }
        return null;
      })(),
      data_start_row_1based: blk.leaf >= 0 ? blk.leaf + 2 : null,
      data_rows: dataRows.length,
      // 数据行中的文本列（通常是城市/门店名称等主键列）
      key_text_columns: columns
        .filter((c) => c.inferred_type === 'text')
        .map((c) => ({ letter: c.letter, header_flat: c.header_flat, non_empty_in_sample: c.non_empty_in_sample })),
      columns,
    });
  }
  return { file_type: ext === '.xlsx' ? 'xlsx' : ext, sheets };
}

/** 读取「不参与分析/导入」的排除清单（人工决定，保持文件原样保留） */
function loadExcluded() {
  const f = path.join(P.config, 'excluded-samples.json');
  const names = new Map();
  const shas = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const e of j.excluded || []) {
      if (e.file_name) names.set(e.file_name, e);
      if (e.sha256) shas.set(e.sha256, e);
    }
    return { file: f, status: j.status || 'active', names, shas, available: true };
  } catch (e) {
    return { file: f, status: '(未配置)', names, shas, available: false };
  }
}

function loadDownloadAudit() {
  const file = path.join(P.state, `downloads-${PLATFORM}.jsonl`);
  const byPath = new Map();
  const bySha = new Map();
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (rec.event !== 'download_saved') continue;
      if (rec.archived_path) byPath.set(rec.archived_path, rec);
      if (rec.sha256) bySha.set(rec.sha256, rec);
      if (rec.suggested_filename && rec.archive_dir) {
        byPath.set(path.join(rec.archive_dir, rec.suggested_filename), rec);
      }
    }
  } catch (e) {
    return { file, exists: false, byPath, bySha };
  }
  return { file, exists: true, byPath, bySha };
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

function main() {
  P.ensureDir(P.samples);
  const dir = args.dir ? String(args.dir) : INCOMING;
  const targets = [];
  const audit = loadDownloadAudit();
  const excluded = loadExcluded();
  const excludedHit = [];

  if (args.file) {
    const f = path.resolve(String(args.file));
    if (!fs.existsSync(f)) {
      console.error(`文件不存在：${f}`);
      process.exit(2);
    }
    if (excluded.names.has(path.basename(f))) {
      console.error(`⚠ 注意：该文件在排除清单中（${excluded.names.get(path.basename(f)).reason}），因显式指定仍将分析。`);
    }
    targets.push(f);
  } else {
    if (!fs.existsSync(dir)) {
      console.error(`目录不存在：${dir}`);
      process.exit(2);
    }
    for (const n of fs.readdirSync(dir).sort()) {
      const f = path.join(dir, n);
      if (!fs.statSync(f).isFile()) continue;
      if (excluded.names.has(n)) {
        excludedHit.push({ file_name: n, ...excluded.names.get(n) });
        continue; // 人工决定：不参与样本分析/后续导入
      }
      targets.push(f);
    }
  }

  const pendingTemp = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(crdownload|part|tmp|download)$/i.test(f)) : [];

  const manifest = {
    tool: 'sample-intake（阶段1 只读留档）',
    generated_at: new Date().toISOString(),
    platform: PLATFORM,
    scanned_dir: dir,
    read_only: true,
    no_move_no_rename: true,
    pending_incomplete_downloads: pendingTemp,
    download_audit_log: audit.file,
    download_audit_available: audit.exists,
    excluded_samples_file: excluded.file,
    excluded_samples: excludedHit,
    file_count: targets.length,
    files: [],
    screenshot: args.screenshot ? { path: String(args.screenshot) } : null,
    notes: [
      '本清单为只读产物：样本文件未被移动、改名、删除，也未被写入任何数据库。',
      '未调用现有项目导入接口，未调用日报/企业微信推送，未创建任何定时任务。',
      '表头按多层结构识别：title_row_text=标题行、filter_row_text=导出筛选条件、header_block_rows=表头块、leaf_header_row=叶子表头行、data_start_row=数据起始行。',
      'header_flat 为按层级拼接的列名（如「店内销售 / 营业额(元)」），供阶段2/3 做字段映射。',
      'inferred_type 来自前 60 行取值样本，仅用于识别日期列/门店列/订单列/金额列，未输出具体业务数值。',
    ],
  };

  for (const f of targets) {
    const st = fs.statSync(f);
    const hash = sha256(f);
    const auditRec = audit.byPath.get(f) || audit.bySha.get(hash) || null;
    const rec = {
      original_name: path.basename(f),
      path: f,
      size: st.size,
      size_human: human(st.size),
      birthtime: st.birthtime ? st.birthtime.toISOString() : null,
      ctime: st.ctime.toISOString(),
      mtime: st.mtime.toISOString(),
      sha256: hash,
      ext: path.extname(f).toLowerCase(),
      download_audit: auditRec
        ? {
            suggested_filename: auditRec.suggested_filename,
            suggested_filename_raw: auditRec.suggested_filename_raw,
            archived_filename: auditRec.archived_filename,
            archived_path: auditRec.archived_path,
            size: auditRec.size,
            sha256: auditRec.sha256,
            created_at: auditRec.created_at,
            saved_at: auditRec.at,
            overwrite_avoided: auditRec.overwrite_avoided,
            guid_temp_removed: auditRec.guid_temp_removed,
            pending_download_temp_files: auditRec.pending_download_temp_files,
            type_allowed: auditRec.type_allowed,
            allowed_extensions: auditRec.allowed_extensions,
          }
        : null,
    };
    if (['.xlsx', '.xlsm', '.xls'].includes(rec.ext)) {
      try {
        rec.excel = analyzeXlsx(f);
      } catch (e) {
        rec.excel = { error: String(e.message).split('\n')[0] };
      }
    }
    manifest.files.push(rec);
  }

  const outFile = path.join(P.samples, `intake-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}Z.json`);
  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2));
  manifest.manifest_file = outFile;

  if (args['csv-out']) {
    const lines = ['文件,工作表,列,扁平表头,类型,非空数,采样行数'];
    for (const r of manifest.files) {
      if (!r.excel || !r.excel.sheets) continue;
      for (const s of r.excel.sheets) {
        for (const c of s.columns) {
          const esc = (x) => `"${String(x === null ? '' : x).replace(/"/g, '""')}"`;
          lines.push([esc(r.original_name), esc(s.name), esc(c.letter), esc(c.header_flat || ''), esc(c.inferred_type), c.non_empty_in_sample, c.sampled_rows].join(','));
        }
      }
    }
    fs.writeFileSync(String(args['csv-out']), '\ufeff' + lines.join('\r\n'));
    manifest.columns_csv = String(args['csv-out']);
  }

  if (args.json) {
    console.log(JSON.stringify(manifest, null, 1));
    return;
  }

  console.log('================ 阶段1 样本只读留档 ================');
  console.log(`扫描目录      : ${dir}`);
  console.log(`未完成下载    : ${pendingTemp.length ? pendingTemp.join(', ') : '无（.crdownload 等临时文件均不存在）'}`);
  console.log(`样本文件数    : ${targets.length}    唯一内容数(SHA-256 去重): ${new Set(manifest.files.map((f) => f.sha256)).size}`);
  if (excludedHit.length) {
    console.log(`已排除文件    : ${excludedHit.length} 个（人工决定不参与分析/导入，保持原样保留）`);
    excludedHit.forEach((e) => console.log(`   · ${e.file_name}  原因：${e.reason}`));
  }
  if (manifest.screenshot) console.log(`浏览器截图    : ${manifest.screenshot.path}`);
  if (manifest.columns_csv) console.log(`列清单 CSV    : ${manifest.columns_csv}`);
  console.log('');
  for (const r of manifest.files) {
    console.log(`● 原始文件名  : ${r.original_name}`);
    console.log(`  完整路径    : ${r.path}`);
    console.log(`  文件大小    : ${r.size} 字节（${r.size_human}）`);
    console.log(`  创建时间    : ${r.birthtime}  (ctime=${r.ctime}  mtime=${r.mtime})`);
    console.log(`  SHA-256     : ${r.sha256}`);
    if (r.download_audit) {
      console.log(`  浏览器建议名: ${r.download_audit.suggested_filename}`);
      console.log(`  实际归档名  : ${r.download_audit.archived_filename}${r.download_audit.overwrite_avoided ? '  (检测到同名，已加时间戳另存，未覆盖)' : ''}`);
      console.log(`  类型白名单  : ${r.download_audit.type_allowed ? '命中（xlsx/xls/csv）' : '未命中，已标记待人工确认'}`);
      console.log(`  未完成临时件: ${(r.download_audit.pending_download_temp_files || []).length === 0 ? '无残留' : JSON.stringify(r.download_audit.pending_download_temp_files)}`);
    } else {
      console.log(`  浏览器建议名: （无审计记录：该文件不是经被动下载处理器落盘）`);
    }
    if (r.excel && r.excel.sheets) {
      for (const s of r.excel.sheets) {
        console.log(`  ── 工作表「${s.name}」  range=${s.range}  列数=${s.column_count}  合并单元格=${s.merge_count}`);
        console.log(`     标题行      : ${s.title_row_text}`);
        console.log(`     筛选条件行  : ${s.filter_row_text}`);
        console.log(`     表头块(1基) : ${JSON.stringify(s.header_block_rows_1based)}   叶子表头行=${s.leaf_header_row_1based}   数据起始行=${s.data_start_row_1based}`);
        console.log(`     数据行数    : ${s.data_rows}`);
        console.log(`     主键文本列  : ${s.key_text_columns.map((c) => `${c.letter}=${c.header_flat}`).join('  |  ')}`);
        console.log(`     全部 ${s.columns.length} 列（列 / 类型 / 非空数 / 扁平表头）:`);
        s.columns.forEach((c) => {
          console.log(`       ${String(c.letter).padEnd(3)} [${String(c.inferred_type).padEnd(7)}] n=${String(c.non_empty_in_sample).padEnd(3)} ${c.header_flat === null ? '(无表头)' : c.header_flat}`);
        });
      }
    } else if (r.excel) {
      console.log(`  Excel 解析  : ${r.excel.error || '（非表格文件，跳过）'}`);
    }
    console.log('');
  }
  console.log(`只读清单位置  : ${outFile}`);
  console.log('===================================================');
}

main();
