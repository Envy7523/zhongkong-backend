'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const C = require('../syncbot/src/meituan-delivery/operating-contract');
const { parseOperatingBuffer: parse } = require('../syncbot/src/meituan-delivery/operating-file');
const { validateJobFilename, downloadOperatingJob, prepareOperatingReport } = require('../syncbot/src/meituan-delivery/operating-download');
const row = () => ['2026-10-05', '测试店', '12345678', '广东', '深圳', '龙岗',
  '1,234.56', 1600, 50, 1000, 100, '10%', '50%', 45, 4.8];
function file(rows = [row()], header = [...C.fields], prefix = []) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([...prefix, header, ...rows]), '营业数据');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}
const scope = { from: '2026-10-05', expectedStoreIds: ['12345678'] };
test('截图规定的 15 个字段，保留原比率并使用分汇总金额', () => {
  const result = parse(file(), scope);
  assert.equal(result.row_count, 1); assert.equal(result.income_cents, 123456);
  assert.equal(result.gross_cents, 160000); assert.equal(result.order_count, 50);
  assert.equal(result.rows[0].入店转化率, '10%'); assert.equal(result.expected_stores_checked, true);
});
test('支持前置标题、Excel 日期和 UTF8 CSV 原件', () => {
  const r = row(); r[0] = (Date.UTC(2026, 9, 5) - Date.UTC(1899, 11, 30)) / 86400000;
  assert.equal(parse(file([r], [...C.fields], [['门店经营日报']]), scope).row_count, 1);
  const csv = '\uFEFF' + C.fields.join(',') + '\r\n' + row().map(x => '"' + String(x).replaceAll('"', '""') + '"').join(',');
  assert.equal(parse(Buffer.from(csv), scope).income_cents, 123456);
});
test('缺少、重复或额外选择字段均拒绝', () => {
  assert.throws(() => parse(file([row()], C.fields.slice(0, -1)), scope), /column_missing/);
  assert.throws(() => parse(file([row()], [...C.fields, '曝光次数']), scope), /selection_mismatch/);
  const headers = [...C.fields]; headers[6] = '日期';
  assert.throws(() => parse(file([row()], headers), scope), /column_missing_or_duplicate/);
});
test('同日门店重复和错误业务日均拒绝', () => {
  assert.throws(() => parse(file([row(), row()]), scope), /duplicate_store_day/);
  const r = row(); r[0] = '2026-10-04';
  assert.throws(() => parse(file([r]), scope), /row_date_mismatch/);
});
test('不能把非法金额、计数或超出范围的指标静默当作零', () => {
  for (const [col, value, reason] of [[6, '错误', /invalid_number/], [7, 1.234, /money_precision/],
    [8, -1, /invalid_count/], [11, '101%', /rate_out_of_range/], [14, 5.1, /rating_out_of_range/]]) {
    const r = row(); r[col] = value; assert.throws(() => parse(file([r]), scope), reason);
  }
});
test('无评分或无转化率保留源缺失值', () => {
  const r = row(); r[11] = '--'; r[14] = '';
  const result = parse(file([r]), scope);
  assert.equal(result.rows[0].综合体验分, ''); assert.equal(result.rows[0].入店转化率, '--');
});
test('核对门店 ID，拒绝其他平台串号和缺门店', () => {
  assert.throws(() => parse(file(), { ...scope, expectedStoreIds: ['87654321'] }), /unknown_store/);
  assert.throws(() => parse(file(), { ...scope, expectedStoreIds: ['12345678', '99999999'] }), /coverage_incomplete/);
  const r = row(); r[2] = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => parse(file([r]), scope), /store_id_precision/);
});
test('空文件、错误月份日期及不完整区间拒绝', () => {
  assert.throws(() => parse(file([]), scope), /empty_report/);
  assert.throws(() => parse(file(), { from: '2026-02-30' }), /date_range_invalid/);
  assert.throws(() => parse(file(), { from: '2026-10-04', to: '2026-10-05' }), /date_coverage_incomplete/);
});
test('真实 CSV 的紧凑日期、空营业指标与小数转化率保持原值', () => {
  const r = row(); r[0] = '20261005'; r[6] = ''; r[7] = ''; r[8] = '';
  r[11] = '0.0957'; r[12] = '0.125';
  const result = parse(file([r]), scope);
  assert.equal(result.rows[0].日期, '2026-10-05');
  assert.equal(result.rows[0].营业收入, ''); assert.equal(result.rows[0].有效订单, '');
  assert.equal(result.blank_metric_counts.营业收入, 1); assert.equal(result.totals_complete, false);
  assert.equal(result.rows[0].入店转化率, '0.0957');
  r[11] = '1.01'; assert.throws(() => parse(file([r]), scope), /rate_out_of_range/);
});
test('多日范围要求每天覆盖所有目标门店', () => {
  const a = row(), b = row(); b[0] = '2026-10-06'; b[2] = '99999999';
  assert.throws(() => parse(file([a,b]), {from:'2026-10-05',to:'2026-10-06',expectedStoreIds:['12345678','99999999']}), /store_coverage_incomplete/);
});
test('下载任务必须同时匹配门店范围、日期及账号', () => {
  const name = '门店_全部门店_20261005_20261005_testaccount_2026-10-06 15_45_31';
  assert.equal(validateJobFilename(name,{from:'2026-10-05',account:'testaccount'}),name);
  for (const options of [{from:'2026-10-04',account:'testaccount'},{from:'2026-10-05',account:'otheraccount'}]) {
    assert.throws(()=>validateJobFilename(name,options),/job_name_mismatch/);
  }
});
test('日期未设置正确时停止，不能误导出昨日以外的数据', async () => {
  let clicked = false;
  const locator = {filter(){return this},async evaluateAll(){return ['2026-10-04','2026-10-04']}};
  await assert.rejects(prepareOperatingReport({locator(){return locator},getByRole(){clicked=true}},scope),/ui_date_mismatch/);
  assert.equal(clicked,false);
});
test('恢复任务遇到不存在或未完成任务时不能创建重复导出', async () => {
  const name='门店_全部门店_20261005_20261005_testaccount_2026-10-06 15_45_31';
  const task={filter(){return this},async count(){return 0}};
  await assert.rejects(downloadOperatingJob({locator(){return task},getByText(){return {}}},{filename:name,...scope,account:'testaccount',targetPath:'unused.csv'}),/missing_or_ambiguous/);
});
