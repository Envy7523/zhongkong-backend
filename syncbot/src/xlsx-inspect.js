'use strict';
/**
 * 阶段1 只读结构探查：弄清 xlsx 的真实表头结构（不写入任何东西、不导入、不推送）
 *   node src/xlsx-inspect.js <文件> [--max-rows=10] [--json-out=<路径>]
 *
 * 输出策略（避免业务数值外泄到聊天/日志）：
 *   · 前 N 行：只打印「非空单元格数 / 文本单元格数 / 少量样例」，用于定位真实表头行
 *   · 自动识别的表头行：完整打印其全部单元格（这些是列名，不是业务数值）
 *   · 数据区：只给出逐列类型与非空计数；数值型列的 min/max/合计仅写入 JSON 文件，不打印
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

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
const file = args._[0];
const MAX_ROWS = Number(args['max-rows'] || 10);
if (!file || !fs.existsSync(file)) {
  console.error('用法: node src/xlsx-inspect.js <xlsx文件> [--max-rows=10]');
  process.exit(2);
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
const isText = (v) => v !== null && v !== undefined && String(v).trim() !== '' && !(typeof v === 'number');
const isEmpty = (v) => v === null || v === undefined || String(v).trim() === '';
const cellStr = (v) => {
  if (v instanceof Date) return `[date]${v.toISOString().slice(0, 10)}`;
  const s = String(v);
  return s.length > 48 ? s.slice(0, 48) + '…' : s;
};

const wb = XLSX.readFile(file, { cellDates: true, cellText: false });
const report = { file: path.basename(file), size: fs.statSync(file).size, sheets: [] };

for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: true, defval: null });
  const merges = (ws['!merges'] || []).map((m) => `${colLetter(m.s.c)}${m.s.r + 1}:${colLetter(m.e.c)}${m.e.r + 1}`);
  const colCount = Math.max(...rows.map((r) => (r ? r.length : 0)), 0);

  console.log(`\n############ 工作表「${name}」 ############`);
  console.log(`  range=${ws['!ref']}  行数=${rows.length}  列数=${colCount}  合并单元格=${merges.length}`);
  if (merges.length) {
    console.log(`  合并区域（前 20 个）: ${merges.slice(0, 20).join(' , ')}`);
  }

  console.log(`  --- 前 ${Math.min(MAX_ROWS, rows.length)} 行概况（定位真实表头行）---`);
  for (let i = 0; i < Math.min(MAX_ROWS, rows.length); i++) {
    const r = rows[i] || [];
    const nonEmpty = r.filter((v) => !isEmpty(v));
    const textN = nonEmpty.filter(isText).length;
    const sample = nonEmpty.slice(0, 8).map((v, k) => `${colLetter(r.indexOf(v))}=${cellStr(v)}`);
    console.log(
      `   row${String(i + 1).padStart(2)}  非空=${String(nonEmpty.length).padStart(3)}  文本=${String(textN).padStart(3)}  样例: ${sample.join(' | ')}`
    );
  }

  console.log(`  --- 前 3 行完整内容（标题 / 筛选条件 / 顶层表头，不截断）---`);
  for (let i = 0; i < Math.min(3, rows.length); i++) {
    const r = rows[i] || [];
    const cells = [];
    for (let c = 0; c < colCount; c++) {
      if (isEmpty(r[c])) continue;
      cells.push(`${colLetter(c)}=${r[c] instanceof Date ? r[c].toISOString().slice(0, 10) : String(r[c])}`);
    }
    console.log(`   row${i + 1} (非空 ${cells.length}): ${cells.join('  |  ')}`);
  }

  // 真实表头行 = 前 MAX_ROWS 行中「非空文本单元格最多」的行
  let headerIdx = -1;
  let bestText = 0;
  for (let i = 0; i < Math.min(MAX_ROWS, rows.length); i++) {
    const textN = (rows[i] || []).filter(isText).length;
    if (textN > bestText) {
      bestText = textN;
      headerIdx = i;
    }
  }
  console.log(`  --- 推断表头行 = row${headerIdx + 1}（该行文本单元格 ${bestText} 个）---`);
  const headerRow = headerIdx >= 0 ? rows[headerIdx] || [] : [];
  const headerCells = [];
  for (let c = 0; c < colCount; c++) {
    const v = headerRow[c];
    if (!isEmpty(v)) headerCells.push(`${colLetter(c)}=${cellStr(v)}`);
  }
  console.log(`  表头全部单元格（共 ${headerCells.length} 个）:`);
  console.log('    ' + headerCells.join('  |  '));

  // 数据区逐列统计（只输出类型/计数，数值范围写文件不打印）
  const dataRows = rows.slice(headerIdx + 1);
  const stats = [];
  for (let c = 0; c < colCount; c++) {
    const vals = dataRows.map((r) => (r ? r[c] : null)).filter((v) => !isEmpty(v));
    let num = 0, text = 0, date = 0;
    const nums = [];
    for (const v of vals) {
      if (v instanceof Date) date++;
      else if (typeof v === 'number') { num++; nums.push(v); }
      else if (/^-?[\d,]+(\.\d+)?$/.test(String(v).trim())) { num++; nums.push(Number(String(v).replace(/,/g, ''))); }
      else text++;
    }
    stats.push({
      col: colLetter(c),
      header: isEmpty(headerRow[c]) ? null : String(headerRow[c]).trim(),
      non_empty: vals.length,
      number: num, text, date,
      type: vals.length === 0 ? 'empty' : date / vals.length >= 0.8 ? 'date' : num / vals.length >= 0.8 ? 'number' : text / vals.length >= 0.8 ? 'text' : 'mixed',
      min: nums.length ? Math.min(...nums) : null,
      max: nums.length ? Math.max(...nums) : null,
      sum: nums.length ? nums.reduce((a, b) => a + b, 0) : null,
    });
  }
  console.log(`  --- 数据区：${dataRows.length} 行 × ${colCount} 列 ---`);
  const byType = stats.reduce((a, s) => ((a[s.type] = (a[s.type] || 0) + 1), a), {});
  console.log(`  列类型分布: ${JSON.stringify(byType)}`);
  console.log(`  有表头文字的列（应即为关键指标列）: ${stats.filter((s) => s.header).length} 列`);
  if (stats.filter((s) => s.header).length) {
    console.log('    ' + stats.filter((s) => s.header).map((s) => `${s.col}=${s.header}`).join('  |  '));
  }
  console.log(`  第 1 列数据（前 6 行，用于判断是否门店列，已截断）:`);
  for (let i = 0; i < Math.min(6, dataRows.length); i++) {
    console.log(`    row${headerIdx + 2 + i}  A=${cellStr((dataRows[i] || [])[0])}`);
  }

  report.sheets.push({
    name,
    range: ws['!ref'],
    row_count: rows.length,
    column_count: colCount,
    merge_count: merges.length,
    merges: merges.slice(0, 60),
    detected_header_row_1based: headerIdx + 1,
    header_cells: headerCells,
    data_rows: dataRows.length,
    column_stats: stats,
  });
}

if (args['json-out']) {
  fs.writeFileSync(String(args['json-out']), JSON.stringify(report, null, 2));
  console.log(`\n结构明细（含数值 min/max）已写入：${args['json-out']}`);
}
console.log('\nINSPECT_DONE');
