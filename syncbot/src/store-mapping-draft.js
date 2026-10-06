'use strict';
/**
 * 阶段1 只读：生成「美团报表门店名 → 项目门店 ID/门店名」映射草案（供人工确认）
 *   node src/store-mapping-draft.js <报表xlsx> <项目门店主档json> [--csv-out=<csv>]
 *
 * 匹配规则（仅限人工批准的三种，**不含任何模糊/包含/相似度匹配**）：
 *   1) 平台门店 ID —— 本报表未提供该列，故不适用（会在输出中明确标注）
 *   2) 门店名称**完全一致**
 *   3) 去除首尾空格、并把连续空格折叠为一个后再完全一致
 *   4) 显式人工映射表 config/store-mapping.json 中已人工确认的条目
 * 无法精确匹配的门店 → 进入"待映射"，**不导入、不猜测归属**。
 *
 * 只读：不写数据库、不调用导入、不推送、不创建定时任务。
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const P = require('./paths');

const args = process.argv.slice(2);
const sampleFile = args.find((a) => !a.startsWith('--'));
const storesFile = args.filter((a) => !a.startsWith('--'))[1];
const csvArg = args.find((a) => a.startsWith('--csv-out='));
if (!sampleFile || !storesFile) {
  console.error('用法: node src/store-mapping-draft.js <报表xlsx> <项目门店主档json> [--csv-out=<csv>]');
  process.exit(2);
}

const isEmpty = (v) => v === null || v === undefined || String(v).trim() === '';
const isTextCell = (v) => !isEmpty(v) && typeof v !== 'number' && !(v instanceof Date);
const norm = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');

// ---- 读取人工映射表（可能为空）----
function loadManualMapping() {
  const f = path.join(P.config, 'store-mapping.json');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { file: f, status: j.status || 'unconfirmed', mappings: j.mappings || {}, rules: j };
  } catch (e) {
    return { file: f, status: '(未配置)', mappings: {}, rules: {} };
  }
}

// ---- 从报表中取出「门店名 + 营业日期」数据行（跳过合计行与无效日期行）----
function readReportStores(file) {
  const wb = XLSX.readFile(file, { cellDates: false, raw: true });
  const sheetName = wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: true });
  let leaf = -1;
  let best = 0;
  for (let i = 0; i < Math.min(12, rows.length); i++) {
    const t = (rows[i] || []).filter(isTextCell).length;
    if (t > best) {
      best = t;
      leaf = i;
    }
  }
  const out = [];
  const skipped = [];
  for (let i = leaf + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const name = norm(r[1]);
    const dateRaw = norm(r[2]);
    const isTotal = /^(合计|总计|汇总|total)$/i.test(norm(r[0])) || /^(合计|总计|汇总)$/i.test(name);
    const dateOk = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(dateRaw.replace(/[/.]/g, '-'));
    if (isTotal) {
      skipped.push({ row_1based: i + 1, reason: '合计行（按确认规则必须跳过）', store_name: name, raw_date: dateRaw });
      continue;
    }
    if (!name || !dateOk) {
      skipped.push({ row_1based: i + 1, reason: !name ? '门店名为空' : '营业日期无效', store_name: name, raw_date: dateRaw });
      continue;
    }
    out.push({ row_1based: i + 1, store_name: name, biz_date: dateRaw.replace(/[/.]/g, '-') });
  }
  return { sheet: sheetName, leaf_header_row_1based: leaf + 1, data_start_row_1based: leaf + 2, stores: out, skipped };
}

const master = JSON.parse(fs.readFileSync(storesFile, 'utf8'));
const masterList = (Array.isArray(master) ? master : master.stores || []).map((s) => ({
  id: s.id !== undefined ? s.id : s.store_id,
  store_name: norm(s.store_name !== undefined ? s.store_name : s.storeName),
  status: s.status || null,
  city: s.city || null,
}));

const manual = loadManualMapping();
const report = readReportStores(sampleFile);

// 归一化后的主档索引（用于第 3 条规则）
const byExact = new Map();
const byNorm = new Map();
const dupNorm = new Set();
for (const m of masterList) {
  if (!byExact.has(m.store_name)) byExact.set(m.store_name, []);
  byExact.get(m.store_name).push(m);
  const k = norm(m.store_name);
  if (!byNorm.has(k)) byNorm.set(k, []);
  byNorm.get(k).push(m);
}
for (const [k, v] of byNorm) if (v.length > 1) dupNorm.add(k);

const results = [];
for (const s of report.stores) {
  const rec = { ...s, match_method: null, project_store_id: null, project_store_name: null, status: 'unmatched', note: null };
  // 规则 4：显式人工映射（优先级高于名称匹配）
  const man = manual.mappings[s.store_name];
  if (man && man.project_store_id !== null && man.project_store_id !== undefined) {
    const target = masterList.find((m) => String(m.id) === String(man.project_store_id));
    rec.match_method = '人工显式映射表';
    rec.project_store_id = man.project_store_id;
    rec.project_store_name = target ? target.store_name : man.project_store_name || null;
    rec.status = target ? 'matched' : 'manual_target_missing';
    rec.note = target ? null : '人工映射表指向的项目门店在门店主档中不存在，请复核';
    results.push(rec);
    continue;
  }
  // 规则 2：完全一致
  if (byExact.has(s.store_name)) {
    const cands = byExact.get(s.store_name);
    if (cands.length === 1) {
      rec.match_method = '名称完全一致';
      rec.project_store_id = cands[0].id;
      rec.project_store_name = cands[0].store_name;
      rec.status = 'matched';
    } else {
      rec.match_method = '名称完全一致但主档存在多条同名';
      rec.status = 'ambiguous';
      rec.note = `主档中同名门店 ${cands.length} 条（id: ${cands.map((c) => c.id).join(',')}），需人工指定`;
    }
    results.push(rec);
    continue;
  }
  // 规则 3：去首尾空格 + 连续空格折叠后完全一致
  const k = norm(s.store_name);
  if (byNorm.has(k)) {
    const cands = byNorm.get(k);
    if (cands.length === 1) {
      rec.match_method = '名称归一化后完全一致（去首尾空格+折叠连续空格）';
      rec.project_store_id = cands[0].id;
      rec.project_store_name = cands[0].store_name;
      rec.status = 'matched';
      rec.note = '原文与主档存在空格差异，已按确认规则归一化匹配';
    } else {
      rec.status = 'ambiguous';
      rec.match_method = '归一化后同名多条';
      rec.note = `归一化后同名 ${cands.length} 条，需人工指定`;
    }
    results.push(rec);
    continue;
  }
  rec.note = '按已确认规则（完全一致 / 归一化一致 / 人工映射）均无法匹配 → 待映射，不导入、不猜测';
  results.push(rec);
}

const matched = results.filter((r) => r.status === 'matched');
const pending = results.filter((r) => r.status !== 'matched');
const reportNames = new Set(results.map((r) => r.store_name));
const notInReport = masterList.filter((m) => !reportNames.has(m.store_name));

const out = {
  tool: 'store-mapping-draft（阶段1 只读）',
  generated_at: new Date().toISOString(),
  read_only: true,
  sample_file: path.basename(sampleFile),
  sample_sheet: report.sheet,
  business_dates: [...new Set(report.stores.map((s) => s.biz_date))],
  report_store_count: report.stores.length,
  project_store_count: masterList.length,
  matching_rules_applied: [
    '1) 平台门店 ID（本报表无此列 → 不适用）',
    '2) 门店名称完全一致',
    '3) 去除首尾空格并折叠连续空格后完全一致',
    '4) config/store-mapping.json 中已人工确认的显式映射',
  ],
  matching_rules_forbidden: ['双向包含', '模糊包含', '相似度/编辑距离推断', '跨城市猜测'],
  manual_mapping_file: manual.file,
  manual_mapping_status: manual.status,
  platform_store_id_column_present: false,
  summary: {
    matched: matched.length,
    pending_mapping: pending.length,
    ambiguous: results.filter((r) => r.status === 'ambiguous').length,
  },
  matched,
  pending_mapping: pending,
  skipped_rows: report.skipped,
  project_stores_not_in_report: notInReport,
  note: '本草案仅供人工确认；未导入任何数据，未写数据库，未改动项目。待映射门店在人工确认前不得导入。',
};

console.log(JSON.stringify(out, null, 2));

if (csvArg) {
  const csvPath = csvArg.slice('--csv-out='.length);
  const lines = ['报表门店名,报表行号,营业日期,匹配方式,项目门店ID,项目门店名,状态,备注'];
  const esc = (x) => `"${String(x === null || x === undefined ? '' : x).replace(/"/g, '""')}"`;
  for (const r of results) {
    lines.push([esc(r.store_name), r.row_1based, esc(r.biz_date), esc(r.match_method), esc(r.project_store_id), esc(r.project_store_name), esc(r.status), esc(r.note)].join(','));
  }
  fs.writeFileSync(csvPath, '\ufeff' + lines.join('\r\n'));
  console.error(`映射草案 CSV 已写入：${csvPath}`);
}
