'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const initSqlJs = require('sql.js');
const { createRouter } = require('../lib/wecom-routing');

(async () => {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  raw.run("CREATE TABLE stores(id INTEGER PRIMARY KEY,store_name TEXT); INSERT INTO stores VALUES(1,'甲店')");
  raw.run("CREATE TABLE wecom_webhook_bots(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,webhook_url TEXT,enabled INTEGER,updated_at TEXT)");
  raw.run("CREATE TABLE wecom_message_routes(message_code TEXT PRIMARY KEY,bot_id INTEGER,enabled INTEGER,updated_at TEXT); INSERT INTO wecom_message_routes VALUES('pos_daily',NULL,0,'')");
  raw.run('CREATE TABLE pos_daily_scope_exclusions(store_id INTEGER PRIMARY KEY,reason TEXT)');
  const db = {
    queryAll(sql, params = []) { const stmt = raw.prepare(sql); stmt.bind(params); const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); stmt.free(); return rows; },
    queryOne(sql, params = []) { return this.queryAll(sql, params)[0] || null; },
    run(sql, params = []) { raw.run(sql, params); },
    insert(sql, params = []) { raw.run(sql, params); return this.queryOne('SELECT last_insert_rowid() AS id').id; },
    save() {},
  };
  const app = express(); app.use(express.json()); app.use('/routing', createRouter({ db }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}/routing`;
  const request = async (method, path, body) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, json: await response.json() };
  };
  try {
    const secret = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678-abc';
    assert.equal((await request('POST', '/bots', { name: '收银日报群', webhook_url: secret })).status, 201);
    const listing = await request('GET', '/');
    assert.equal(listing.json.bots[0].name, '收银日报群');
    assert.equal(JSON.stringify(listing.json).includes(secret), false);
    assert.equal((await request('POST', '/routes/pos_daily/activation', { enabled: true, confirm_template_approved: true, confirm_target_verified: true })).status, 400);
    assert.equal((await request('PUT', '/routes/pos_daily', { bot_id: 1 })).json.enabled, false);
    assert.equal((await request('POST', '/routes/pos_daily/activation', { enabled: true })).status, 400);
    assert.equal((await request('POST', '/routes/pos_daily/activation', { enabled: true, confirm_template_approved: true, confirm_target_verified: true })).json.enabled, true);
    assert.equal((await request('PUT', '/bots/1', { webhook_url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=new12345678' })).status, 200);
    assert.equal((await request('GET', '/')).json.routes[0].enabled, false);
    assert.equal((await request('PUT', '/pos-daily/exclusions', { exclusions: [{ store_id: 1, reason: '已停业' }] })).status, 200);
    assert.equal((await request('GET', '/')).json.exclusions[0].reason, '已停业');
    console.log('wecom-routing: 10 assertions passed');
  } finally { server.close(); raw.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
