'use strict';
// 机器人侧独立校验：纯只读，不操作浏览器、中控或任何业务状态。
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');
const RULES = require('../../config/report-c-rules.json');

const HEADER = ['门店名称', '大类', '小类', '金额'];
function date(value) {
  const m = String(value || '').match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!m) return null;
  const out = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const d = new Date(`${out}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === out ? out : null;
}
function cents(value) {
  if (typeof value === 'number') {
    const n = Math.round(value * 100);
    return Number.isSafeInteger(n) && Math.abs(value * 100 - n) < 0.00001 ? n : null;
  }
  const text = String(value ?? '').trim().replace(/[￥¥,，\s]/g, '');
  return /^[+-]?\d+(?:\.\d{1,2})?$/.test(text) && Number.isSafeInteger(Math.round(Number(text) * 100))
    ? Math.round(Number(text) * 100) : null;
}
function validateReportCBuffer(buffer, businessDate) {
  const errors = [];
  const add = error => { if (errors.length < 20) errors.push(error); };
  if (!Buffer.isBuffer(buffer) || buffer.length < 100 || buffer.length > 10 * 1024 * 1024) add('file_size_invalid');
  if (date(businessDate) !== businessDate) add('business_date_invalid');
  if (errors.length) return { ok: false, errors };
  let workbook;
  try { workbook = XLSX.read(buffer, { type: 'buffer' }); }
  catch { return { ok: false, errors: ['workbook_unreadable'] }; }
  if (workbook.SheetNames.length !== 1 || workbook.SheetNames[0] !== RULES.worksheet_name)
    return { ok: false, errors: ['sheet_identity_invalid'] };
  let range;
  try { range = XLSX.utils.decode_range(workbook.Sheets[RULES.worksheet_name]['!ref']); }
  catch { return { ok: false, errors: ['sheet_range_invalid'] }; }
  if (range.s.c !== 0 || range.e.c !== 3 || range.s.r !== 0 || range.e.r > 10003)
    return { ok: false, errors: ['sheet_range_invalid'] };
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[RULES.worksheet_name], { header: 1, raw: true, defval: '' });
  if (grid.length < 4 || grid.length > 10004) return { ok: false, errors: ['row_count_invalid'] };
  if (String(grid[0][0]).trim() !== RULES.report_name) add('title_invalid');
  const filters = String(grid[1][0] || '').trim();
  const match = filters.match(/^门店【全部】；大类【全部】；小类【全部】；日期【(\d{4}[/-]\d{1,2}[/-]\d{1,2})-(\d{4}[/-]\d{1,2}[/-]\d{1,2})】$/);
  if (!match) add('filters_invalid');
  else if (date(match[1]) !== businessDate || date(match[2]) !== businessDate) add('not_expected_single_day');
  if (grid[2].length !== 4 || HEADER.some((h, i) => String(grid[2][i] || '').trim() !== h)) add('header_invalid');
  const last = grid.at(-1);
  if (String(last[0] || '').trim() !== '合计') add('total_row_missing');
  let sum = 0;
  const stores = new Set();
  for (let i = 3; i < grid.length - 1; i++) {
    const row = grid[i];
    const amount = cents(row[3]);
    if (row.length !== 4 || !String(row[0] || '').trim() || !String(row[1] || '').trim()
      || !String(row[2] || '').trim() || amount === null) { add(`row_invalid:${i + 1}`); continue; }
    stores.add(String(row[0]).trim());
    sum += amount;
  }
  if (!Number.isSafeInteger(sum) || cents(last[3]) !== sum) add('total_mismatch');
  return { ok: errors.length === 0, report_type: RULES.report_type, business_date: businessDate,
    row_count: grid.length - 4, store_count: stores.size, total_cents: sum,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'), errors };
}
function validateReportCFile(file, businessDate) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return { ok: false, errors: ['file_size_invalid'] };
    return validateReportCBuffer(fs.readFileSync(file), businessDate);
  } catch { return { ok: false, errors: ['file_unreadable'] }; }
}
module.exports = { validateReportCBuffer, validateReportCFile };
