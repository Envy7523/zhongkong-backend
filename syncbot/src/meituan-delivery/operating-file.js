'use strict';
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');
const contract = require('./operating-contract');
const key = value => String(value ?? '').trim().replace(/[\s（）()]/g, '').toLowerCase();
const aliases = { 门店所在城市: ['门店所在城市', '城市'], 区县市: ['区县市', '区县'] };
function plainDate(value) {
  let text = String(value ?? '').trim();
  if (typeof value === 'number') {
    if (/^\d{8}$/.test(text)) text = text.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    else {
      const d = XLSX.SSF.parse_date_code(value);
      if (!d || d.H || d.M || d.S) return null;
      text = `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
    }
  }
  if (/^\d{8}$/.test(text)) text = text.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  const m = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) return null;
  const date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const d = new Date(date + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === date ? date : null;
}
function numeric(value, { integer = false, nullable = false, percent = false, money = false } = {}) {
  if (nullable && ['', '--', '—', '-'].includes(String(value ?? '').trim())) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw Error('non_finite_number');
    if (money && Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) throw Error('invalid_money_precision');
    if (integer && (!Number.isSafeInteger(value) || value < 0)) throw Error('invalid_count');
    return value;
  }
  let text = String(value ?? '').trim().replace(/[,，￥¥\s]/g, '');
  if (percent && text.endsWith('%')) text = text.slice(0, -1);
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) throw Error('invalid_number');
  if (money && !/^[+-]?\d+(?:\.\d{1,2})?$/.test(text)) throw Error('invalid_money_precision');
  return numeric(Number(text), { integer, money });
}
function parseOperatingBuffer(buffer, { from, to = from, expectedStoreIds } = {}) {
  if (plainDate(from) !== from || plainDate(to) !== to || from > to) throw Error('operating_date_range_invalid');
  if (!Buffer.isBuffer(buffer) || buffer.length < 30 || buffer.length > 20 * 1024 * 1024) throw Error('operating_file_size_invalid');
  const binary = buffer.slice(0, 2).toString() === 'PK' || buffer.slice(0, 2).equals(Buffer.from([0xd0, 0xcf]));
  const utf8 = buffer.toString('utf8');
  const utf8Text = !binary && Buffer.from(utf8).equals(buffer);
  const workbook = XLSX.read(utf8Text ? utf8.replace(/^\uFEFF/, '') : buffer,
    { type: utf8Text ? 'string' : 'buffer', cellDates: false, raw: true,
      ...(!binary && !utf8Text ? { codepage: 936 } : {}) });
  if (workbook.SheetNames.length !== 1) throw Error('operating_sheet_ambiguous');
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true, defval: '' });
  if (grid.length > 100001) throw Error('operating_row_limit');
  const candidates = [];
  for (let i = 0; i < Math.min(15, grid.length); i++) {
    if (grid[i].some(v => key(v) === key('门店id')) && grid[i].some(v => key(v) === key('日期'))) candidates.push(i);
  }
  if (candidates.length !== 1) throw Error('operating_header_ambiguous');
  const index = candidates[0], headers = grid[index];
  const columns = {};
  for (const field of contract.fields) {
    const wanted = (aliases[field] || [field]).map(key);
    const hits = headers.map((v, i) => wanted.includes(key(v)) ? i : -1).filter(i => i >= 0);
    if (hits.length !== 1) throw Error('operating_column_missing_or_duplicate:' + field);
    columns[field] = hits[0];
  }
  if (headers.filter(v => String(v).trim()).length !== contract.fields.length) throw Error('operating_selection_mismatch');
  const counts = new Set(['有效订单', '曝光人数', '入店人数', '下单人数']);
  const rows = [], seen = new Set(), stores = new Set(), dates = new Set();
  const blankMetricCounts = Object.fromEntries(contract.metrics.map(field => [field, 0]));
  const expected = expectedStoreIds === undefined ? null : new Set(expectedStoreIds.map(String));
  if (expected && (!expected.size || expected.size !== expectedStoreIds.length)) throw Error('operating_expected_stores_invalid');
  for (let i = index + 1; i < grid.length; i++) {
    const source = grid[i];
    if (source.every(v => v === '' || v === null)) continue;
    const row = Object.fromEntries(contract.fields.map(field => [field, source[columns[field]] ?? '']));
    const date = plainDate(row.日期);
    if (!date || date < from || date > to) throw Error('operating_row_date_mismatch:' + (i + 1));
    if (typeof row.门店id === 'number' && !Number.isSafeInteger(row.门店id)) throw Error('operating_store_id_precision');
    const storeId = String(row.门店id).trim();
    if (!/^\d+$/.test(storeId) || !String(row.门店名称).trim()) throw Error('operating_store_identity_invalid:' + (i + 1));
    if (expected && !expected.has(storeId)) throw Error('operating_unknown_store:' + storeId);
    const identity = date + ':' + storeId;
    if (seen.has(identity)) throw Error('operating_duplicate_store_day:' + identity);
    for (const field of contract.metrics) {
      const rate = field.endsWith('转化率'), rating = field === '综合体验分';
      const value = numeric(row[field], { integer: counts.has(field), nullable: true,
        percent: rate, money: ['营业收入', '优惠前总额'].includes(field) });
      if (rating && value !== null && (value < 0 || value > 5)) throw Error('operating_rating_out_of_range');
      if (rate && value !== null && (value < 0 || value > (String(row[field]).trim().endsWith('%') ? 100 : 1))) throw Error('operating_rate_out_of_range');
      if (value === null) blankMetricCounts[field]++;
    }
    seen.add(identity); stores.add(storeId); dates.add(date); rows.push({ ...row, 日期: date, 门店id: storeId });
  }
  if (!rows.length) throw Error('operating_empty_report');
  for (let date = from, n = 0; date <= to; n++) {
    if (n >= 62) throw Error('operating_date_range_too_large');
    if (!dates.has(date)) throw Error('operating_date_coverage_incomplete');
    if (expected && rows.filter(row => row.日期 === date).length !== expected.size) throw Error('operating_store_coverage_incomplete');
    const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
    date = d.toISOString().slice(0, 10);
  }
  if (expected && stores.size !== expected.size) throw Error('operating_store_coverage_incomplete');
  const incomeCents = rows.reduce((sum, r) => sum + Math.round((numeric(r.营业收入, { money: true, nullable: true }) ?? 0) * 100), 0);
  const grossCents = rows.reduce((sum, r) => sum + Math.round((numeric(r.优惠前总额, { money: true, nullable: true }) ?? 0) * 100), 0);
  if (!Number.isSafeInteger(incomeCents) || !Number.isSafeInteger(grossCents)) throw Error('operating_total_overflow');
  const orderCount = rows.reduce((sum, r) => sum + (numeric(r.有效订单, { integer: true, nullable: true }) ?? 0), 0);
  if (!Number.isSafeInteger(orderCount)) throw Error('operating_total_overflow');
  return { ok: true, report_type: contract.reportType, from, to, row_count: rows.length,
    store_ids: [...stores].sort(), store_count: stores.size, dates: [...dates].sort(),
    expected_stores_checked: !!expected, income_cents: incomeCents, gross_cents: grossCents,
    blank_metric_counts: blankMetricCounts,
    totals_complete: ['营业收入', '优惠前总额', '有效订单'].every(field => blankMetricCounts[field] === 0),
    order_count: orderCount,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'), rows };
}
function parseOperatingFile(file, options) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw Error('operating_file_size_invalid');
  return parseOperatingBuffer(fs.readFileSync(file), options);
}
module.exports = { parseOperatingBuffer, parseOperatingFile, plainDate };
