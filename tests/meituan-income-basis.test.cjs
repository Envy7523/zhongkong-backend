'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), XLSX = require('xlsx');
const { incomeField, summarizeIncomeBasis } = require('../lib/meituan-income-basis');
const { parseOperatingBuffer } = require('../syncbot/src/meituan-delivery/operating-file');
const { verifyStored } = require('../lib/meituan-delivery-sync');
const contract = require('../syncbot/src/meituan-delivery/operating-contract');
function workbook(field, income = '12.98', extra = []) {
  const headers = contract.fields.map(name => name === '营业收入' ? field : name);
  const row = ['20261102', '测试店', '123', '广东', '深圳', '龙岗', income, '20.00', 2, 20, 10, '50%', '20%', 2, ''];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[...headers, ...extra], [...row, ...extra.map(() => 99)]]), 'data');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}
const options = { from: '2026-11-02', expectedStoreIds: ['123'] };
test('new order income retains exact source provenance, cents and blank status; legacy unchanged', () => {
  for (const field of ['营业收入', '订单收入']) {
    const r = parseOperatingBuffer(workbook(field), options);
    assert.equal(r.income_field, field); assert.equal(r.income_cents, 1298);
    assert.equal(r.income_equivalence_confirmed, true); assert.equal(r.source_fields[6], field);
    const blank = parseOperatingBuffer(workbook(field, ''), options);
    assert.equal(blank.totals_complete, false); assert.equal(blank.rows[0].营业收入, '');
    assert.throws(() => parseOperatingBuffer(workbook(field, '1.234'), options), /money_precision/);
  }
  assert.throws(() => parseOperatingBuffer(workbook('订单收入', '12.98', ['营业收入']), options), /column_missing_or_duplicate/);
});
test('readback rejects equal money stored under a different source financial field', () => {
  const r = parseOperatingBuffer(workbook('订单收入'), options), source = r.rows[0];
  const original = { ...source, 订单收入: source.营业收入 }; delete original.营业收入;
  const saved = { match_status: 'matched', store_id: 1, meituan_store_id: '123', raw_json: JSON.stringify(original),
    income_amount: 12.98, gross_amount: 20, order_count: 2, impression_users: 20, visit_users: 10, visit_rate: .5, order_rate: .2, ordering_users: 2, store_rating: 0 };
  const db = { queryAll() { return [saved]; } };
  assert.equal(verifyStored(db, r).income_field, '订单收入');
  saved.raw_json = JSON.stringify(source);
  assert.throws(() => verifyStored(db, r), /income_basis_mismatch/);
});
test('confirmed renamed fields aggregate historical and current ranges while retaining source labels', () => {
  const records = [{ raw_json: '{"营业收入":10}', income_amount: 10 }, { raw_json: '{"订单收入":12.98}', income_amount: 12.98 }];
  const r = summarizeIncomeBasis(records);
  assert.equal(r.mixed, false); assert.equal(r.equivalence_confirmed, true);
  assert.deepEqual(r.fields.map(x => x.amount), [10, 12.98]); assert.equal(r.label, '订单收入');
  assert.match(summarizeIncomeBasis(records.slice(1)).note, /更名/);
  assert.throws(() => incomeField({ 营业收入: 10, 订单收入: 10 }), /ambiguous/);
});
test('source blanks remain incomplete and new positive income ends a temporary reopening exemption', () => {
  const r = summarizeIncomeBasis([{ raw_json: '{"订单收入":""}', income_amount: 0 }, { raw_json: '{"订单收入":10}', income_amount: 10 }]);
  assert.equal(r.complete, false); assert.equal(r.missing_row_count, 1); assert.match(r.label, /已提供部分/);
  const policy = require('../lib/delivery-review-exceptions');
  const db = { queryOne() { return null; }, queryAll() { return [{ biz_date: '2026-11-02', raw_json: '{"订单收入":1,"优惠前总额":"","有效订单":""}' }]; } };
  assert.deepEqual(policy.active(db, 'operating', '2026-11-02', [{ store_id: 25, platform_id: '29547426' }]), []);
});
test('actual importer stores the original new header, preserves old dates, reuses signed source and rejects changed provenance', async () => {
  const SQL = await require('sql.js')(), sqlite = new SQL.Database();
  const schema = require('fs').readFileSync(require.resolve('../lib/db'), 'utf8');
  for (const name of ['business_import_batches', 'meituan_delivery_operation_records']) {
    const start = schema.indexOf('CREATE TABLE IF NOT EXISTS ' + name + ' (');
    assert(start >= 0); sqlite.run(schema.slice(start, schema.indexOf('\n    )', start) + 6));
  }
  sqlite.run("CREATE TABLE stores(id INTEGER PRIMARY KEY,store_name TEXT); INSERT INTO stores VALUES(1,'测试店'); CREATE TABLE store_platforms(store_id INTEGER,platform_name TEXT,platform_id TEXT); INSERT INTO store_platforms VALUES(1,'美团外卖','123')");
  function queryAll(sql, values = []) { const s = sqlite.prepare(sql); try { s.bind(values); const rows = []; while (s.step()) rows.push(s.getAsObject()); return rows; } finally { s.free(); } }
  const db = { queryAll, queryOne: (s, p) => queryAll(s, p)[0] || null, run: (s, p = []) => sqlite.run(s, p),
    insert(s, p) { this.run(s, p); return this.queryOne('SELECT last_insert_rowid() id').id; }, save() {} };
  const sync = require('../lib/meituan-delivery-sync'), analytics = require('../lib/business-analytics');
  try {
    const source = workbook('订单收入'), parsed = parseOperatingBuffer(source, options);
    const body = { business_date: options.from, file_name: 'new.xlsx', data: source.toString('base64'), sha256: parsed.sha256 };
    const first = sync.importSource(db, analytics, body);
    assert.equal(first.verification.income_field, '订单收入');
    assert.equal(sync.importSource(db, analytics, body).reused, true);
    const saved = db.queryOne('SELECT * FROM meituan_delivery_operation_records');
    assert.equal(saved.income_amount, 12.98); assert.equal(JSON.parse(saved.raw_json).订单收入, '12.98');
    assert.equal(Object.hasOwn(JSON.parse(saved.raw_json), '营业收入'), false);
    assert.equal(db.queryOne('SELECT COUNT(*) n FROM business_import_batches').n, 1);
    const alternate = workbook('营业收入');
    assert.throws(() => sync.importSource(db, analytics, { ...body, data: alternate.toString('base64'), sha256: require('crypto').createHash('sha256').update(alternate).digest('hex') }), /source_changed_manual_review/);
  } finally { sqlite.close(); }
});
