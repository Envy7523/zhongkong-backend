'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const initSqlJs = require('sql.js');
const { createRouter, syncDefaultWebhookBot } = require('../lib/wecom-routing');

(async () => {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  raw.run("CREATE TABLE stores(id INTEGER PRIMARY KEY,store_name TEXT); INSERT INTO stores VALUES(1,'甲店'),(2,'乙店')");
  raw.run("CREATE TABLE wecom_webhook_bots(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,webhook_url TEXT,enabled INTEGER,source TEXT DEFAULT 'manual',audience TEXT NOT NULL DEFAULT 'management',store_id INTEGER,updated_at TEXT)");
  raw.run("CREATE UNIQUE INDEX idx_wecom_bots_store ON wecom_webhook_bots(store_id) WHERE audience='store' AND store_id IS NOT NULL");
  raw.run("CREATE TABLE wecom_message_routes(message_code TEXT PRIMARY KEY,bot_id INTEGER,enabled INTEGER,revision INTEGER DEFAULT 0,updated_at TEXT); INSERT INTO wecom_message_routes VALUES('pos_daily',NULL,0,0,''); INSERT INTO wecom_message_routes VALUES('group_buy_daily',NULL,0,0,'')");
  // GET / 会读取排除名单；缺这张表会让整个列表接口 500（此前本测试脚本即因此跑不起来）
  raw.run("CREATE TABLE pos_daily_scope_exclusions(store_id INTEGER PRIMARY KEY,reason TEXT)");
  const db = {
    queryAll(sql, params = []) { const stmt = raw.prepare(sql); stmt.bind(params); const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); stmt.free(); return rows; },
    queryOne(sql, params = []) { return this.queryAll(sql, params)[0] || null; },
    run(sql, params = []) { raw.run(sql, params); },
    insert(sql, params = []) { raw.run(sql, params); return this.queryOne('SELECT last_insert_rowid() AS id').id; },
    save() {},
  };
  const legacy = { webhookName: 'Nameless', webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=nameless12345' };
  const originalId = syncDefaultWebhookBot(db, legacy);
  assert.equal(syncDefaultWebhookBot(db, legacy), originalId);
  assert.equal(db.queryOne('SELECT count(*) AS n FROM wecom_webhook_bots').n, 1);
  const app = express(); app.use(express.json()); app.use('/routing', createRouter({ db,
    loadConfig: () => legacy,
    saveConfig: next => Object.assign(legacy, next),
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}/routing`;
  const request = async (method, path, body) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, json: await response.json() };
  };
  const route = listing => listing.routes.find(item => item.message_code === 'pos_daily');
  try {
    const secret = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678-abc';
    let listing = await request('GET', '/');
    assert.equal(listing.json.bots[0].name, 'Nameless');
    assert.equal(JSON.stringify(listing.json).includes(legacy.webhook), false);
    assert.equal((await request('PUT', '/routes/pos_daily', { bot_id: originalId })).json.enabled, false);
    assert.equal((await request('POST', '/routes/pos_daily/activation', { enabled: true, expected_bot_id: originalId, expected_revision: 1, confirm_template_approved: true, confirm_target_verified: true })).json.enabled, true);
    legacy.webhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=namelessChanged12345';
    assert.equal(syncDefaultWebhookBot(db, legacy), originalId);
    assert.equal(route((await request('GET', '/')).json).enabled, false);
    assert.equal((await request('POST', '/bots', { name: '重复群', webhook_url: legacy.webhook })).status, 409);
    assert.equal((await request('POST', '/bots', { name: '收银日报群', webhook_url: secret })).status, 201);
    listing = await request('GET', '/');
    assert.equal(listing.json.bots[1].name, '收银日报群');
    assert.equal(JSON.stringify(listing.json).includes(secret), false);
    assert.deepEqual(listing.json.stores.map(store => store.store_name), ['乙店', '甲店']);
    const storeBot = await request('POST', '/bots', { name: '甲店群', webhook_url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=storebot12345', audience: 'store', store_id: 1 });
    assert.equal(storeBot.status, 201);
    assert.equal(storeBot.json.bot.store_name, '甲店');
    assert.equal((await request('POST', '/bots', { name: '甲店重复', webhook_url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=storebot67890', audience: 'store', store_id: 1 })).status, 409);
    assert.equal((await request('PUT', '/routes/pos_daily', { bot_id: storeBot.json.bot.id })).status, 400);
    assert.equal((await request('PUT', '/routes/group_buy_daily', { bot_id: storeBot.json.bot.id })).status, 400);
    assert.equal((await request('PUT', '/routes/pos_daily', { bot_id: null })).json.enabled, false);
    assert.equal((await request('POST', '/routes/pos_daily/activation', { enabled: true, expected_bot_id: originalId, expected_revision: 1, confirm_template_approved: true, confirm_target_verified: true })).status, 400);
    assert.equal((await request('PUT', '/routes/pos_daily', { bot_id: 2 })).json.enabled, false);
    assert.equal((await request('POST', '/routes/pos_daily/activation', { enabled: true })).status, 400);
    assert.equal((await request('POST', '/routes/pos_daily/activation', { enabled: true, expected_bot_id: originalId, expected_revision: 3, confirm_template_approved: true, confirm_target_verified: true })).status, 409);
    assert.equal((await request('POST', '/routes/pos_daily/activation', { enabled: true, expected_bot_id: 2, expected_revision: 4, confirm_template_approved: true, confirm_target_verified: true })).json.enabled, true);
    assert.equal((await request('PUT', '/bots/2', { webhook_url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=new12345678' })).status, 200);
    assert.equal(route((await request('GET', '/')).json).enabled, false);
    assert.equal((await request('PUT', '/bots/2', { audience: 'store', store_id: 2 })).status, 200);
    assert.equal((await request('PUT', '/routes/pos_daily', { bot_id: 2 })).status, 400);
    assert.equal((await request('PUT', '/bots/2', { audience: 'management' })).status, 200);
    assert.equal((await request('PUT', '/routes/group_buy_daily', { bot_id: originalId })).json.enabled, false);
    assert.equal((await request('POST', '/routes/group_buy_daily/activation', { enabled: true, expected_bot_id: originalId, expected_revision: 1, confirm_template_approved: true, confirm_target_verified: true })).json.enabled, true);
    assert.equal((await request('PUT', '/routes/group_buy_daily', { bot_id: 2 })).json.enabled, false);
    assert.equal((await request('PUT', `/bots/${originalId}`, { name: 'Nameless 报表测试', webhook_url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=namelessTest12345' })).status, 200);
    assert.equal(legacy.webhookName, 'Nameless 报表测试');
    assert.equal(JSON.stringify((await request('GET', '/')).json).includes(legacy.webhook), false);
    // 排除名单接口已实现（原断言停在"接口不存在"的旧状态，与实现不符）
    const exclusionsPut = await fetch(base + '/pos-daily/exclusions', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ exclusions: [{ store_id: 1, reason: '已停业' }] }) });
    assert.equal(exclusionsPut.status, 200);
    assert.deepEqual((await exclusionsPut.json()).exclusions, [{ store_id: 1, reason: '已停业' }]);
    const afterExclusion = (await request('GET', '/')).json;
    assert.deepEqual(afterExclusion.exclusions.map(row => row.store_id), [1]);
    assert.equal(afterExclusion.exclusions[0].store_name, '甲店');
    // 非法输入必须零写入（门店不存在 -> 400）
    assert.equal((await fetch(base + '/pos-daily/exclusions', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ exclusions: [{ store_id: 999, reason: '不存在' }] }) })).status, 400);
    assert.deepEqual((await request('GET', '/')).json.exclusions.map(row => row.store_id), [1]);
    // 管理端分组所需字段必须回传（缺失会让接收机器人下拉框只显示裸 id）
    const finalListing = (await request('GET', '/')).json;
    assert.equal(finalListing.bots.every(bot => typeof bot.audience === 'string'), true);
    const finalStoreBot = finalListing.bots.find(bot => bot.audience === 'store');
    assert.equal(Boolean(finalStoreBot), true);
    assert.equal(finalStoreBot.store_id, 1);
    assert.equal(finalStoreBot.store_name, '甲店');
    // 管理群机器人不应带门店绑定
    assert.equal(finalListing.bots.filter(bot => bot.audience === 'management').every(bot => bot.store_id === null), true);
    assert.equal(finalListing.stores.length, 2);
    console.log('wecom-routing: existing bot registry, routing and secret safety passed');
  } finally { server.close(); raw.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
