'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), X = require('xlsx');
const { refreshPolicy } = require('../lib/delivery-rejected-sources');
const sync = require('../lib/delivery-client-sync'), analytics = require('../lib/business-analytics');
const { database } = require('./delivery-platform-cloud.test.cjs');
const date = '2026-10-20';
function workbook(platform, id) {
  const headers = [platform === 'jd_delivery' ? '门店id' : '门店编号', '门店名称', '日期', '收入', '营业额', '有效订单', '曝光人数', '进店转化率'];
  const book = X.utils.book_new();
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([headers, ...(id ? [[id, '原件店', date, 10, 20, 1, 30, .1]] : [])]), 'data');
  return X.write(book, { bookType: 'xlsx', type: 'buffer' });
}
for (const platform of ['jd_delivery', 'taobao_flash']) test(platform + ' independently distinguishes empty export from unmapped stores before permitting refresh', async () => {
  const db = await database(), device = { id: 'fixture', name: '核验' }, current = sync.scope(db, date, platform);
  const body = { platform, type: 'operating', date, error: 'collector_no_active_source_rows', scope_version: current.version };
  try {
    const empty = workbook(platform);
    assert.deepEqual(refreshPolicy(empty, body, current), { refresh_allowed: true, refresh_reason: 'empty_source_verified', refresh_policy_version: 2 });
    for (const [id, reason] of [['999', 'source_stores_unmapped'], [current.bindings[0].platform_id, 'source_has_active_rows']]) {
      const bytes = workbook(platform, id), policy = refreshPolicy(bytes, body, current);
      assert.equal(policy.refresh_allowed, false); assert.equal(policy.refresh_reason, reason);
      if (id === '999') assert.throws(() => sync.importFile(db, analytics, device, {
        ...body, data: bytes.toString('base64'), sha256: require('crypto').createHash('sha256').update(bytes).digest('hex'),
      }), /collector_source_stores_unmapped/);
    }
    assert.equal(refreshPolicy(Buffer.concat([Buffer.from('PK'), Buffer.alloc(40)]), body, current).refresh_allowed, false);
    assert.equal(refreshPolicy(empty, { ...body, type: 'product' }, current).refresh_allowed, false);
    assert.equal(refreshPolicy(workbook(platform, '999'), { ...body, error: 'settlement_bill_reconciliation_failed' }, current).refresh_allowed, false);
  } finally { db.close(); }
});

for (const platform of ['jd_delivery', 'taobao_flash']) test(platform + ' rejects identical money linked to the wrong backend store in operating and settlement data', async () => {
  const db = await database(), device = { id: 'binding-proof', name: '核验' }, current = sync.scope(db, date, platform);
  const id = current.bindings[0].platform_id, multi = require('../lib/delivery-platform-sync');
  function upload(type, bytes) { return sync.importFile(db, analytics, device, { platform, type, date, scope_version: current.version, data: bytes.toString('base64'), sha256: require('crypto').createHash('sha256').update(bytes).digest('hex') }); }
  const finish = type => sync.finish(db, device, { platform, type, date, scope_version: current.version, dryRun: true });
  try {
    upload('operating', workbook(platform, id)); assert.equal(finish('operating').status, 'success');
    db.run('UPDATE delivery_operation_records SET store_id=999');
    assert.throws(() => finish('operating'), /database_store_mismatch/);
    db.run('UPDATE delivery_operation_records SET store_id=1');
    const bill = platform === 'jd_delivery' ? { 门店编号: id, 门店名称: '营业店', '订单完成/退款完成时间': date + ' 12:00:00', 应结金额: 10, 订单类型: '正常订单' } : { 门店ID: id, 门店名称: '营业店', 账单日期: date, 结算金额: 10, 账单类型: '外卖' };
    const book = X.utils.book_new(); X.utils.book_append_sheet(book, X.utils.json_to_sheet([bill]), 'data');
    upload('settlement', X.write(book, { bookType: 'xlsx', type: 'buffer' })); assert.equal(finish('settlement').status, 'success');
    db.run('UPDATE ' + multi.platforms[platform].bills + ' SET store_id=999');
    assert.throws(() => finish('settlement'), /database_store_mismatch/);
  } finally { db.close(); }
});
