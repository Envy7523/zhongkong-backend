'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database, body } = require('./delivery-client-cloud.test.cjs');
const sync = require('../lib/delivery-client-sync');
const analytics = require('../lib/business-analytics');
const health = require('../lib/delivery-client-health');
const operating = require('../syncbot/src/meituan-delivery/operating-contract');
const product = require('../syncbot/src/meituan-delivery/product-contract');

async function fixture(date = '2026-10-23', additionalBlank = false) {
  const db = await database();
  db.run("INSERT INTO stores VALUES(25,'麦地店','正常营业','2025-06-14','')");
  db.run("INSERT INTO store_platforms VALUES(25,'美团外卖','29547426','2025-09-01')");
  const device = sync.enroll(db, { name: '临时豁免核验', account: 'test' });
  const current = sync.scope(db, date);
  const rows = current.bindings.map(b => {
    const base = { 日期: date.replaceAll('-', ''), 门店名称: b.store_name, 门店id: b.platform_id, 省份: '广东', 门店所在城市: '惠州', 区县市: '惠城' };
    return operating.fields.map(f => base[f] ?? (b.store_id === 25 || additionalBlank ? '' : '0')).join(',');
  });
  sync.importFile(db, analytics, device, body('operating', date, Buffer.from(operating.fields.join(',') + '\n' + rows.join('\n') + '\n'), current));
  sync.importFile(db, analytics, device, body('product', date, Buffer.from(product.fields.join(',') + '\n'), current));
  return { db, device, current, date, finish: type => sync.finish(db, device, { type, date, scope_version: current.version }) };
}

test('approved Maidi exception passes only completeness while preserving source blanks, store lifecycle and audit reason', async () => {
  const f = await fixture();
  try {
    for (const type of ['operating', 'product']) {
      const result = f.finish(type);
      assert.equal(result.status, 'success');
      assert.equal(result.verification.temporary_exceptions.length, 1);
      assert.equal(result.verification.temporary_exceptions[0].platform_id, '29547426');
      assert.equal(health.evidence(f.db, sync.TYPES[type], f.date).status, 'passed');
      assert.match(health.evidence(f.db, sync.TYPES[type], f.date).reason, /临时豁免/);
    }
    assert.equal(f.finish('operating').verification.source_blank_metrics, true);
    assert.equal(JSON.parse(f.db.queryOne("SELECT raw_json FROM meituan_delivery_operation_records WHERE meituan_store_id='29547426'").raw_json).营业收入, '');
    assert.equal(f.db.queryOne('SELECT status FROM stores WHERE id=25').status, '正常营业');
  } finally { f.db.close(); }
});

test('other store blanks and missing product evidence still fail; exceptions do not change historical dates', async () => {
  for (const [date, other] of [['2026-10-22', false], ['2026-10-23', true]]) {
    const f = await fixture(date, other);
    try { assert.equal(f.finish('operating').status, 'unverified'); assert.equal(f.finish('product').status, 'unverified'); }
    finally { f.db.close(); }
  }
});

test('source hash tampering, database changes, missing files and binding changes cannot be waived', async () => {
  const f = await fixture();
  try {
    f.db.run("UPDATE meituan_delivery_operation_records SET income_amount=1 WHERE meituan_store_id='29547426'");
    assert.throws(() => f.finish('operating'), /metric_mismatch/);
    f.db.run("UPDATE meituan_delivery_operation_records SET income_amount=0 WHERE meituan_store_id='29547426'");
    f.db.run("UPDATE delivery_collector_files SET sha256='invalid' WHERE report_type='meituan_delivery_operating'");
    assert.throws(() => f.finish('operating'), /source_hash_changed/);
    f.db.run("DELETE FROM delivery_collector_files WHERE report_type='meituan_delivery_product'");
    assert.throws(() => f.finish('product'), /files_incomplete/);
    f.db.run("UPDATE store_platforms SET platform_id='999' WHERE store_id=25 AND platform_name='美团外卖'");
    assert.throws(() => f.finish('operating'), /scope_changed/);
  } finally { f.db.close(); }
});

test('restored zero or nonzero metrics and product sales automatically end the temporary exception', async () => {
  for (const mode of ['zero', 'positive', 'product']) {
    const f = await fixture();
    try {
      if (mode === 'product') f.db.run("INSERT INTO meituan_delivery_product_records(biz_date,meituan_store_id,product_name,quantity,sales_amount) VALUES('2026-10-23','29547426','恢复销量',1,10)");
      else {
        const raw = { 营业收入: mode === 'zero' ? '0' : '10', 优惠前总额: '', 有效订单: '' };
        f.db.run("INSERT INTO meituan_delivery_operation_records(biz_date,meituan_store_id,raw_json) VALUES('2026-10-24','29547426',?)", [JSON.stringify(raw)]);
      }
      const policy = require('../lib/delivery-review-exceptions');
      assert.deepEqual(policy.active(f.db, 'operating', '2026-10-24', f.current.bindings), []);
      assert.deepEqual(policy.active(f.db, 'product', '2026-10-24', f.current.bindings), []);
    } finally { f.db.close(); }
  }
});
