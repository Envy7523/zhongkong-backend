'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const X = require('xlsx');
const sync = require('../lib/delivery-client-sync');
const analytics = require('../lib/business-analytics');
const operatingContract = require('../syncbot/src/meituan-delivery/operating-contract');
const productContract = require('../syncbot/src/meituan-delivery/product-contract');
const date = '2026-11-02';

function workbook(headers, rows) {
  const book = X.utils.book_new();
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([headers, ...rows]), 'data');
  return X.write(book, { type: 'buffer', bookType: 'xlsx' });
}
async function fixture({ field = '订单收入', income = 0, gross = 0, orders = 0, product = false } = {}) {
  const SQL = await require('sql.js')(), sql = new SQL.Database();
  const schema = fs.readFileSync(require.resolve('../lib/db'), 'utf8');
  for (const name of ['business_import_batches', 'meituan_delivery_operation_records', 'meituan_delivery_product_records', 'business_product_sales']) {
    const start = schema.indexOf('CREATE TABLE IF NOT EXISTS ' + name + ' (');
    assert(start >= 0); sql.run(schema.slice(start, schema.indexOf('\n    )', start) + 6));
  }
  sql.run("CREATE TABLE stores(id INTEGER PRIMARY KEY,store_name TEXT,status TEXT,opening_date TEXT,closed_date TEXT); INSERT INTO stores VALUES(1,'测试店','正常营业','2026-01-01',''); CREATE TABLE store_platforms(store_id INTEGER,platform_name TEXT,platform_id TEXT,online_date TEXT); INSERT INTO store_platforms VALUES(1,'美团外卖','123','2026-01-01')");
  const db = {
    run(q, p = []) { sql.run(q, p); },
    queryAll(q, p = []) { const s = sql.prepare(q); try { s.bind(p); const rows = []; while (s.step()) rows.push(s.getAsObject()); return rows; } finally { s.free(); } },
    queryOne(q, p) { return this.queryAll(q, p)[0] || null; },
    insert(q, p) { this.run(q, p); return this.queryOne('SELECT last_insert_rowid() id').id; },
    save() {}, close() { sql.close(); },
  };
  sync.ready(db);
  const device = { id: 'proof-device', name: '隔离核验设备' }, scope = sync.scope(db, date);
  const upload = (type, buffer) => sync.importFile(db, analytics, device, {
    type, date, scope_version: scope.version, data: buffer.toString('base64'),
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  });
  upload('operating', workbook(operatingContract.fields.map(f => f === '营业收入' ? field : f), [
    [date, '测试店', '123', '广东', '深圳', '龙岗', income, gross, orders, 10, 2, '20%', '0%', 0, ''],
  ]));
  upload('product', workbook(productContract.fields, product ? [[date, '青菜', '深圳', '测试店', '123', 2, 10, 10, 1, 1, '否', '否']] : []));
  return { db, device, scope, finish: () => sync.finish(db, device, { type: 'product', date, scope_version: scope.version, dryRun: true }) };
}

test('Meituan missing product rows need explicit same-day zero gross/orders and a nonblank income in either source header', async () => {
  for (const field of ['营业收入', '订单收入']) for (const values of [
    { income: '', gross: 0, orders: 0 },
    { income: 0, gross: '', orders: 0 },
    { income: 0, gross: 12, orders: 0 },
    { income: 0, gross: 0, orders: '' },
    { income: 0, gross: 0, orders: 1 },
  ]) {
    const f = await fixture({ field, ...values });
    try { assert.equal(f.finish().status, 'unverified', JSON.stringify({ field, ...values })); } finally { f.db.close(); }
  }
});

test('Meituan explicit zero sales may retain a negative fee without fabricating product rows', async () => {
  for (const field of ['营业收入', '订单收入']) {
    const f = await fixture({ field, income: -0.15 });
    try {
      const result = f.finish(); assert.equal(result.status, 'success');
      assert.deepEqual(result.verification.zero_product_store_ids, ['123']);
      assert.equal(f.db.queryOne('SELECT income_amount FROM meituan_delivery_operation_records').income_amount, -0.15);
      assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM business_product_sales').n, 0);
    } finally { f.db.close(); }
  }
});

test('Meituan zero-sales proof requires the original hash and its database readback', async () => {
  const f = await fixture();
  try {
    assert.equal(f.finish().status, 'success');
    f.db.run("UPDATE delivery_collector_files SET sha256=? WHERE report_type='meituan_delivery_operating'", ['0'.repeat(64)]);
    assert.throws(() => f.finish(), /source_hash_changed/);
    f.db.run("DELETE FROM delivery_collector_files WHERE report_type='meituan_delivery_operating'");
    assert.equal(f.finish().status, 'unverified');
  } finally { f.db.close(); }
  const changed = await fixture();
  try {
    changed.db.run('UPDATE meituan_delivery_operation_records SET gross_amount=100');
    assert.throws(() => changed.finish(), /metric_mismatch/);
  } finally { changed.db.close(); }
});

test('Meituan empty source is rechecked against later database rows, including reusing an old upload', async () => {
  const f = await fixture();
  try {
    f.db.run("INSERT INTO meituan_delivery_product_records (biz_date,meituan_store_id,product_name,quantity,sales_amount) VALUES(?,?,?,?,?)", [date, '123', '后来写入', 1, 10]);
    assert.throws(() => f.finish(), /empty_source_conflicts_with_existing_data/);
  } finally { f.db.close(); }
});

test('Meituan product readback includes the final dashboard table and exact store binding', async () => {
  for (const mutation of [
    'UPDATE business_product_sales SET sales_amount=999',
    'DELETE FROM business_product_sales',
    'UPDATE meituan_delivery_product_records SET store_id=999',
  ]) {
    const f = await fixture({ income: 10, gross: 10, orders: 1, product: true });
    try {
      assert.equal(f.finish().status, 'success'); f.db.run(mutation);
      assert.throws(() => f.finish(), /database_(metric|count|store)_mismatch/, mutation);
    } finally { f.db.close(); }
  }
});

test('Meituan operating proof cannot be attributed to a different backend store with identical metrics', async () => {
  const f = await fixture();
  try {
    f.db.run('UPDATE meituan_delivery_operation_records SET store_id=999');
    assert.throws(() => f.finish(), /database_store_mismatch/);
    assert.throws(() => sync.finish(f.db, f.device, { type: 'operating', date, scope_version: f.scope.version, dryRun: true }), /database_store_mismatch/);
  } finally { f.db.close(); }
});
