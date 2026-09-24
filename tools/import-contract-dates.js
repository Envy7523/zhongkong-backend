/**
 * 合同起止时间补录 — 从《门店员工管理》表格把「合同起始日 / 合同到期日」写入 employees。
 *
 * 表格格式（已实际核对，见 _tmp/staff-xlsx-raw.json）：
 *   第 1 行空，第 2 行为表头「名字 / 合同起始日 / 合同到期日」，数据从第 3 行起。
 *   B、C 两列是 **Excel 日期序列号**（真实日期，不是文本）。
 *   列显示格式不同（B 列 "3/1/26"、C 列 "2027/3/1"）只是单元格格式差异，底层值一致，
 *   因此统一按序列号解析，不依赖显示文本。
 *
 * 匹配规则（与 lib/staff-import.js 的约定保持一致）：
 *   1. 按姓名精确匹配；
 *   2. 命中多条时，若其中恰好只有 1 人在职，则取该在职员工；
 *   3. 仍不唯一 → 标记 ambiguous 并跳过（绝不猜），由人工核对。
 *
 * 写入策略：
 *   默认**只填空值**（不覆盖人事已填的合同时间）；加 --overwrite 才会覆盖。
 *
 * 安全约束：
 *   - 默认干跑，只读不改；加 --apply 才写库。
 *   - --apply 前会检测 3456 端口。lib/db.js 用 sql.js（整库在内存中、save() 全量重写文件），
 *     若服务正在运行，它的内存副本会在下一次 save() 时覆盖本脚本的写入 —— 因此服务运行时拒绝写入。
 *
 * 用法：
 *   node tools/import-contract-dates.js --dry-run                 # 干跑（默认）
 *   node tools/import-contract-dates.js --apply                   # 写库（需先停服）
 *   node tools/import-contract-dates.js --apply --overwrite       # 覆盖已有值
 *   node tools/import-contract-dates.js --file "D:\x.xlsx"        # 指定来源
 */
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const net = require('net');

const DEFAULT_SRC = 'F:\\deepseek-harness\\uploads\\门店员工管理(1).xlsx';
const SHEET_NAME = 'Sheet2';
const HEADER_ROW_INDEX = 1;   // 0-based：第 2 行
const COL_NAME = 0;
const COL_START = 1;
const COL_END = 2;

const argv = process.argv.slice(2);
const has = flag => argv.includes(flag);
const valueOf = (flag, fallback = '') => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const APPLY = has('--apply');
const OVERWRITE = has('--overwrite');
const SRC = valueOf('--file', DEFAULT_SRC);
const REPORT = valueOf('--report', path.join(__dirname, '..', '_tmp', 'contract-import-report.json'));

/** Excel 序列号 → YYYY-MM-DD。以 1899-12-30 为基准（含 1900 闰年 bug 的标准修正）。 */
function excelSerialToISO(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return '';
  const ms = Date.UTC(1899, 11, 30) + Math.round(n) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 姓名归一化兜底：表格里部分单元格把门店/岗位/手机号写进了姓名列，例如
 *   「李三兰(京基御景店长-[手机号])」→ 李三兰
 *   「方洲店-韦泽月-[手机号]」        → 韦泽月
 *   「欧景店-谢开铭[手机号]」          → 谢开铭
 * 只做**保守**清洗：剥离括号内容、按分隔符取「纯中文 2~4 字」片段、去掉尾随数字。
 * 清洗后才命中的，会在报告里单独归类为 matched_cleaned，方便人工复核。
 */
function cleanName(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  // 1) 去掉括号及其内容（中英文括号）：李三兰(京基御景店长-[手机号]) → 李三兰
  const bare = text.replace(/[（(][^）)]*[）)]/g, '').trim();
  // 2) 按常见分隔符拆段，逐段去掉尾随数字，取「纯中文 2~4 字且不含机构字」的片段
  //    机构字过滤是必需的：否则「方洲店-韦泽月-192****0467」会先命中「方洲店」。
  const ORG_CHARS = /[店部组司厂仓区县市镇村]/;
  const candidates = bare
    .split(/[-—–_/、,，\s]+/)
    .map(part => part.replace(/\d+$/, '').trim())
    .filter(part => /^[\u4e00-\u9fa5]{2,4}$/.test(part) && !ORG_CHARS.test(part));
  if (candidates.length) return candidates[0];
  // 3) 整体去数字后若已是纯姓名则直接用
  const noDigits = bare.replace(/\d+$/, '').trim();
  if (/^[\u4e00-\u9fa5]{2,4}$/.test(noDigits) && !ORG_CHARS.test(noDigits)) return noDigits;
  // 4) 兜底：返回原文（交给精确匹配失败路径处理）
  return bare || text;
}

/** 读取并解析表格 → [{ row, name, start, end }] */
function readSource() {
  if (!fs.existsSync(SRC)) throw new Error(`找不到来源文件：${SRC}`);
  const wb = XLSX.readFile(SRC, { cellDates: false, raw: true });
  const sheetName = wb.SheetNames.includes(SHEET_NAME) ? SHEET_NAME : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`表格里没有工作表：${sheetName}`);
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });

  const rows = [];
  for (let i = HEADER_ROW_INDEX + 1; i < grid.length; i++) {
    const line = grid[i] || [];
    const name = String(line[COL_NAME] ?? '').trim();
    if (!name) continue;
    rows.push({
      row: i + 1,
      name,
      start: excelSerialToISO(line[COL_START]),
      end: excelSerialToISO(line[COL_END]),
    });
  }
  return { sheetName, rows };
}

/** 3456 端口是否在监听（用于阻止服务运行时的危险写入） */
function serverRunning(port = 3456) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(1200);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function main() {
  const { sheetName, rows } = readSource();
  console.log(`来源：${SRC}（工作表 ${sheetName}）`);
  console.log(`解析到 ${rows.length} 行数据 · 模式：${APPLY ? (OVERWRITE ? '写库(覆盖已有值)' : '写库(只填空值)') : '干跑(不改库)'}\n`);

  if (!rows.length) throw new Error('表格里没有解析到数据行（请检查表头行位置）');

  // 一致性自检：到期日不应早于起始日
  const badRange = rows.filter(r => r.start && r.end && r.end < r.start);

  const db = require('../lib/db');
  await db.init();

  const report = { source: SRC, sheet: sheetName, mode: APPLY ? 'apply' : 'dry-run', overwrite: OVERWRITE, total: rows.length, matched: [], matched_cleaned: [], unmatched: [], ambiguous: [], no_dates: [], unchanged: [], bad_range: badRange.map(r => ({ row: r.row, name: r.name, start: r.start, end: r.end })) };

  for (const row of rows) {
    if (!row.start && !row.end) {
      const guess = cleanName(row.name);
      report.no_dates.push(guess !== row.name ? { row: row.row, name: row.name, cleaned: guess } : { row: row.row, name: row.name });
      continue;
    }

    let hits = db.queryAll('SELECT id, name, status, store_name, contract_start_date, contract_end_date FROM employees WHERE name=?', [row.name]);
    let cleanedFrom = '';
    if (!hits.length) {
      const guess = cleanName(row.name);
      if (guess && guess !== row.name) {
        hits = db.queryAll('SELECT id, name, status, store_name, contract_start_date, contract_end_date FROM employees WHERE name=?', [guess]);
        if (hits.length) cleanedFrom = row.name;
      }
    }
    if (!hits.length) { report.unmatched.push({ row: row.row, name: row.name, start: row.start, end: row.end, cleaned: cleanName(row.name) }); continue; }

    let target = hits[0];
    if (hits.length > 1) {
      const active = hits.filter(h => h.status === '在职');
      if (active.length === 1) target = active[0];
      else {
        report.ambiguous.push({
          row: row.row, name: row.name, start: row.start, end: row.end,
          candidates: hits.map(h => ({ id: h.id, status: h.status, store_name: h.store_name })),
        });
        continue;
      }
    }

    const beforeStart = String(target.contract_start_date || '');
    const beforeEnd = String(target.contract_end_date || '');
    const nextStart = OVERWRITE ? row.start : (beforeStart || row.start);
    const nextEnd = OVERWRITE ? row.end : (beforeEnd || row.end);
    const changed = nextStart !== beforeStart || nextEnd !== beforeEnd;

    const item = {
      row: row.row, employee_id: target.id, name: target.name, store_name: target.store_name,
      status: target.status, before: { start: beforeStart, end: beforeEnd },
      after: { start: nextStart, end: nextEnd }, changed, cleaned_from: cleanedFrom,
    };
    if (changed) (cleanedFrom ? report.matched_cleaned : report.matched).push(item); else report.unchanged.push(item);

    if (APPLY && changed) {
      db.run("UPDATE employees SET contract_start_date=?, contract_end_date=?, updated_at=datetime('now','localtime') WHERE id=?",
        [nextStart, nextEnd, target.id]);
    }
  }

  if (APPLY) {
    if (report.matched.length + report.matched_cleaned.length) db.save();
    console.log(`已写入 ${report.matched.length + report.matched_cleaned.length} 人（库已保存）\n`);
  }

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf-8');

  // ---- 汇总 ----
  const writable = report.matched.length + report.matched_cleaned.length;
  console.log('=== 汇总 ===');
  console.log(`表格数据行          : ${report.total}`);
  console.log(`无日期（跳过）      : ${report.no_dates.length}`);
  console.log(`可写入（有变化）    : ${writable}（其中姓名清洗后命中 ${report.matched_cleaned.length}）`);
  console.log(`无需改动（已一致）  : ${report.unchanged.length}`);
  console.log(`未匹配到员工        : ${report.unmatched.length}`);
  console.log(`重名无法判定        : ${report.ambiguous.length}`);
  console.log(`到期日早于起始日    : ${report.bad_range.length}`);

  const show = (title, list, fmt) => {
    if (!list.length) return;
    console.log(`\n--- ${title}（${list.length}）---`);
    list.slice(0, 40).forEach(item => console.log('  ' + fmt(item)));
    if (list.length > 40) console.log(`  … 其余 ${list.length - 40} 条见报告文件`);
  };
  show('未匹配到员工', report.unmatched, x => `第 ${x.row} 行 「${x.name}」（清洗后「${x.cleaned}」）（${x.start} ~ ${x.end}）`);
  show('重名无法判定', report.ambiguous, x => `第 ${x.row} 行 ${x.name} → 候选 ${x.candidates.map(c => `#${c.id}(${c.status}${c.store_name ? '·' + c.store_name : ''})`).join(' / ')}`);
  show('无日期（跳过）', report.no_dates, x => `第 ${x.row} 行 ${x.name}${x.cleaned ? `（清洗后「${x.cleaned}」）` : ''}`);
  show('到期日早于起始日', report.bad_range, x => `第 ${x.row} 行 ${x.name}：${x.start} → ${x.end}`);
  show('可写入', report.matched, x => `${x.name}｜${x.store_name || '未归属门店'}｜${x.before.start || '(空)'}~${x.before.end || '(空)'} → ${x.after.start}~${x.after.end}`);
  show('可写入·姓名清洗后命中（请复核）', report.matched_cleaned, x => `${x.name}｜原格「${x.cleaned_from}」｜${x.store_name || '未归属门店'}｜${x.before.start || '(空)'}~${x.before.end || '(空)'} → ${x.after.start}~${x.after.end}`);

  console.log(`\n报告：${REPORT}`);
}

(async () => {
  if (APPLY) {
    const running = await serverRunning();
    if (running) {
      console.error('✗ 检测到 3456 端口有服务在运行，已阻止写库。');
      console.error('  原因：lib/db.js 用 sql.js（整库在内存、save() 全量重写文件），');
      console.error('        运行中的服务会在下一次 save() 时覆盖本次写入。');
      console.error('  请先停止服务（或执行 restart-app.ps1 前先停），再重跑本命令。');
      process.exit(2);
    }
  }
  main().catch(err => { console.error('执行失败：' + err.message); process.exit(1); });
})();
