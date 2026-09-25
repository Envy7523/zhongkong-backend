'use strict';

const assert = require('node:assert/strict');
const { preflight, pushPosDaily } = require('../lib/pos-daily-push');
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

assert.equal(validWebhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678-abc'), true);
assert.equal(validWebhook('http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678-abc'), false);
assert.equal(validWebhook('https://evil.example/cgi-bin/webhook/send?key=12345678-abc'), false);
assert.equal(validWebhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678-abc&x=1'), false);
assert.equal(preflight(fakeDb(null), '2026-09-24').reason, 'pos_daily_route_not_active');
assert.equal(preflight(fakeDb({ route_enabled: 0, bot_id: 2, bot_enabled: 1, webhook_url: 'https://example.test' }), '2026-09-24').ok, false);
assert.equal(preflight(fakeDb({ route_enabled: 1, bot_id: 2, bot_enabled: 1, webhook_url: 'https://example.test' }), '2026-09-24').ok, true);

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
  console.log('pos-daily-push: 11 assertions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
