const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const initSqlJs = require('sql.js');
const express = require('express');

(async () => {
  const SQL = await initSqlJs(); const raw = new SQL.Database();
  const db = {
    run: (sql, p = []) => { raw.run(sql, p); return raw.getRowsModified(); },
    exec: sql => raw.run(sql), save() {},
    queryAll(sql, p = []) { const stmt = raw.prepare(sql); stmt.bind(p); const out = []; while (stmt.step()) out.push(stmt.getAsObject()); stmt.free(); return out; },
    queryOne(sql, p = []) { return this.queryAll(sql, p)[0] || null; },
  };
  raw.run(`CREATE TABLE users (id INTEGER PRIMARY KEY,username TEXT,role TEXT,display_name TEXT,phone TEXT,avatar_url TEXT,store_id INTEGER,position_id INTEGER);
    INSERT INTO users VALUES(1,'manager','店长','测试店长','','',9,1);
    CREATE TABLE position_settings(id INTEGER PRIMARY KEY,name TEXT,permissions_json TEXT);
    INSERT INTO position_settings VALUES(1,'店长','["analysis.view"]');
    CREATE TABLE user_positions(user_id INTEGER,position_id INTEGER); INSERT INTO user_positions VALUES(1,1);
    CREATE TABLE mp_identities(id INTEGER PRIMARY KEY,identity_type TEXT,identity_id TEXT,user_id INTEGER,status TEXT,store_id INTEGER,last_login_at TEXT,auth_version INTEGER NOT NULL DEFAULT 0,UNIQUE(identity_type,identity_id));
    CREATE TABLE mp_audit_logs(user_id INTEGER,identity_type TEXT,action TEXT,target TEXT,detail TEXT);
    CREATE TABLE stores(id INTEGER PRIMARY KEY,store_name TEXT,status TEXT,store_type TEXT,province TEXT,city TEXT,district TEXT);
    INSERT INTO stores VALUES(9,'本店','营业','','','',''),(10,'他店','营业','','','','');`);
  require('../lib/mp/wechat-binding').initialize(db);
  function load(file, overrides, globals = {}) {
    const mod = { exports: {} }; const full = path.resolve(file);
    const req = name => name in overrides ? overrides[name] : require(name.startsWith('.') ? path.resolve(path.dirname(full), name) : name);
    vm.runInNewContext(fs.readFileSync(full, 'utf8'), { require: req, module: mod, exports: mod.exports, __dirname: path.dirname(full), process, console, URLSearchParams, AbortSignal, ...globals }, { filename: full });
    return mod.exports;
  }
  const auth = load('lib/mp/auth.js', {
    '../db': db,
    fs: { readFileSync: () => JSON.stringify({ mp: { appid: 'test', secret: 'test-secret' } }) },
    './wechat-binding': { createService: options => require('../lib/mp/wechat-binding').createService({ ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ openid: 'test-openid' }) }) }) },
  });
  const pending = await auth.login('openid', { code: 'test', invite: 'manager' });
  assert.equal(pending.bindingRequired, true); assert.equal(pending.token, undefined);
  const application = auth.wechatBinding.apply({ ticket: pending.ticket, name: '员工' }).binding;
  auth.wechatBinding.review(application.id, { action: 'approve', user_id: 1 }, 1);
  const approved = await auth.login('openid', { code: 'fresh' });
  assert.equal(approved.user.id, 1); assert.equal(approved.storeScope, 9);
  const router = load('lib/mp/router.js', { '../db': db, './auth': auth, '../business-analytics': null, '../collab-service': { addReply() {} }, './upload': {} });
  const app = express(); app.use(express.json()); app.use(router);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (url, token = approved.token) => fetch(base + url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await call('/revenue?store_id=10')).status, 403);
    assert.equal((await call('/collab/issues')).status, 403);
    assert.deepEqual((await (await call('/stores')).json()).stores.map(s => s.id), [9]);
    db.run('UPDATE users SET store_id=10 WHERE id=1');
    assert.deepEqual((await (await call('/stores')).json()).stores.map(s => s.id), [10]);
    db.run("UPDATE position_settings SET permissions_json='[]' WHERE id=1");
    assert.equal((await call('/stores')).status, 403);
    db.run("UPDATE position_settings SET permissions_json='[\"analysis.view\"]' WHERE id=1");
    auth.wechatBinding.review(application.id, { action: 'revoke' }, 1);
    assert.equal((await call('/me')).status, 401);
    auth.wechatBinding.apply({ ticket: pending.ticket, name: '员工' });
    auth.wechatBinding.review(application.id, { action: 'approve', user_id: 1 }, 1);
    assert.equal((await call('/me')).status, 401);
    const renewed = await auth.login('openid', { code: 'fresh-again' });
    assert.equal((await call('/me', renewed.token)).status, 200);
    assert.equal(require('../lib/permissions').requiredPermission('/api/users/wechat-bindings/1/review', 'POST'), 'users.manage');
  } finally { await new Promise(resolve => server.close(resolve)); raw.close(); }
  console.log('PASS: no token before review, username cannot self-bind, approved login, live permissions/store scope, cross-store denial, revoke and reapproval invalidate old tokens, admin route permission');
})().catch(e => { console.error(e); process.exitCode = 1; });
