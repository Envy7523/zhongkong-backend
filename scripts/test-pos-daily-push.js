'use strict';

const assert = require('node:assert/strict');
const { preflight, pushPosDaily, sendPosDailyTest } = require('../lib/pos-daily-push');
const { renderPosDailyImage } = require('../lib/pos-daily-image');
const { validWebhook } = require('../lib/wecom-routing');

const data = {
  stores: Array.from({ length: 9 }, (_, i) => ({ id: i + 1, store_name: `门店${i + 1}` })),
  records: Array.from({ length: 9 }, (_, i) => ({ store_id: i + 1, store_name: `门店${i + 1}`, channel: 'store_sales', channel_group: 'offline', gross_amount: 100, recorded_amount: 80, order_count: 3 })),
  compositions: Array.from({ length: 9 }, (_, i) => ({ store_id: i + 1, category: '现金', amount: 80 })),
};
function fakeDb(target) {
  return {
    queryAll(sql) {
      if (sql.includes('FROM stores')) return data.stores;
      if (sql.includes('FROM business_revenue_records')) return data.records;
      if (sql.includes('FROM business_revenue_compositions')) return data.compositions;
      if (sql.includes('FROM pos_daily_scope_exclusions')) return [];
      throw new Error(`unexpected query: ${sql}`);
    },
    queryOne(sql) {
      if (sql.includes('FROM wecom_message_routes')) return target;
      throw new Error(`unexpected query: ${sql}`);
    },
    insert() { return 42; }, save() {},
  };
}
function fakeTestDb(assignedBotId = 2) {
  const db = fakeDb(null);
  const sends = [];
  db.queryOne = (sql, params = []) => {
    if (sql.includes('FROM pos_daily_test_sends') && sql.includes('request_id=')) return sends.find(row => row.request_id === params[0]) || null;
    if (sql.includes('FROM pos_daily_test_sends')) return sends.find(row => row.business_date === params[0] && row.bot_id === params[1] && ['started', 'unknown', 'success'].includes(row.status)) || null;
    if (sql.includes('FROM wecom_webhook_bots')) return { id: 2, name: 'Nameless', webhook_url: 'https://example.test', enabled: 1 };
    if (sql.includes('FROM wecom_message_routes')) return { bot_id: assignedBotId };
    throw new Error(`unexpected query: ${sql}`);
  };
  db.insert = (sql, params) => {
    if (sql.includes('INTO pos_daily_test_sends')) sends.push({ request_id: params[0], business_date: params[1], bot_id: params[2], status: params[3] });
    return 42;
  };
  db.run = (sql, params) => {
    if (sql.includes('UPDATE pos_daily_test_sends')) sends.find(row => row.request_id === params[1]).status = params[0];
  };
  return { db, sends };
}

assert.equal(validWebhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678-abc'), true);
assert.equal(validWebhook('http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678-abc'), false);
assert.equal(validWebhook('https://evil.example/cgi-bin/webhook/send?key=12345678-abc'), false);
assert.equal(validWebhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678-abc&x=1'), false);
assert.equal(preflight(fakeDb(null), '2026-09-24').reason, 'pos_daily_route_not_active');
assert.equal(preflight(fakeDb({ route_enabled: 0, bot_id: 2, bot_enabled: 1, webhook_url: 'https://example.test' }), '2026-09-24').ok, false);
assert.equal(preflight(fakeDb({ route_enabled: 1, bot_id: 2, bot_enabled: 1, webhook_url: 'https://example.test' }), '2026-09-24').ok, true);
const checked = preflight(fakeDb({ route_enabled: 1, bot_id: 2, bot_enabled: 1, webhook_url: 'https://example.test' }), '2026-09-24');
assert.notDeepEqual(renderPosDailyImage(checked.data, { mode: 'preview' }).buffer,
  renderPosDailyImage(checked.data, { mode: 'send' }).buffer);
assert.throws(() => renderPosDailyImage({ ...checked.data, ready: false }, { mode: 'send' }), /incomplete_preview_cannot_send/);

(async () => {
  let calls = 0;
  const denied = await pushPosDaily({ db: fakeDb(null), business_date: '2026-09-24', httpPost: async () => { calls++; return { errcode: 0 }; } });
  assert.equal(denied.sent, false);
  assert.equal(calls, 0);
  const success = await pushPosDaily({ db: fakeDb({ route_enabled: 1, bot_id: 2, bot_enabled: 1, bot_name: '专用群', webhook_url: 'https://example.test' }),
    business_date: '2026-09-24', httpPost: async (_url, payload) => { calls++; assert.equal(payload.msgtype, 'image'); return { errcode: 0 }; } });
  assert.equal(success.sent, true);
  assert.equal(success.pushed, 1);
  assert.equal(calls, 1);
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  const wrongTarget = await sendPosDailyTest({ db: fakeTestDb(3).db, business_date: '2026-09-24', bot_id: 2, request_id: requestId, httpPost: async () => { calls++; } });
  assert.equal(wrongTarget.reason, 'test_target_not_bound');
  assert.equal(calls, 1);
  const { db: testDb, sends } = fakeTestDb();
  const tested = await sendPosDailyTest({ db: testDb, business_date: '2026-09-24', bot_id: 2, request_id: requestId,
    httpPost: async (_url, payload) => { calls++; assert.equal(payload.msgtype, 'image'); return { errcode: 0 }; } });
  assert.equal(tested.sent, true);
  assert.equal(sends[0].status, 'success');
  assert.equal((await sendPosDailyTest({ db: testDb, business_date: '2026-09-24', bot_id: 2, request_id: requestId, httpPost: async () => { calls++; } })).duplicate, true);
  assert.equal((await sendPosDailyTest({ db: testDb, business_date: '2026-09-24', bot_id: 2, request_id: '123e4567-e89b-42d3-a456-426614174001', httpPost: async () => { calls++; } })).duplicate, true);
  assert.equal(calls, 2);
  const unknownDb = fakeTestDb();
  const unknown = await sendPosDailyTest({ db: unknownDb.db, business_date: '2026-09-24', bot_id: 2, request_id: requestId,
    httpPost: async () => { throw new Error('timeout'); } });
  assert.equal(unknown.unknown, true);
  assert.equal(unknownDb.sends[0].status, 'unknown');
  console.log('pos-daily-push: scheduled and one-time test-send guards passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
