// 使用独立内存数据库；不读取或修改业务数据库。
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const jwt = require('jsonwebtoken');
const { createService, initialize } = require('../lib/mp/wechat-binding');

(async () => {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  const db = {
    run: (sql, params = []) => { raw.run(sql, params); return raw.getRowsModified(); },
    exec: sql => raw.run(sql), save() {},
    queryAll(sql, params = []) {
      const stmt = raw.prepare(sql); stmt.bind(params); const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject()); stmt.free(); return rows;
    },
    queryOne(sql, params = []) { return this.queryAll(sql, params)[0] || null; },
  };
  raw.run(`CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1),(2);
    CREATE TABLE mp_identities(id INTEGER PRIMARY KEY,identity_type TEXT,identity_id TEXT,user_id INTEGER,
      status TEXT,store_id INTEGER,auth_version INTEGER NOT NULL DEFAULT 0, UNIQUE(identity_type,identity_id));
    CREATE TABLE mp_audit_logs(user_id INTEGER,identity_type TEXT,action TEXT,target TEXT,detail TEXT);`);
  initialize(db); initialize(db);
  let wxResponse = { openid: 'wx-a' };
  const secret = 'isolated-test-secret';
  const service = createService({ db, secret, readConfig: () => ({ mp: { appid: 'test-app', secret: 'test-app-secret' } }),
    fetchImpl: async () => ({ ok: true, json: async () => wxResponse }) });
  assert.equal(await service.exchange('valid-code'), 'wx-a');
  wxResponse = { errcode: 40029 }; await assert.rejects(service.exchange('bad-code'), /凭证已失效/);
  const ticket = service.ticket('wx-a');
  assert.throws(() => service.apply({ ticket: 'forged', name: '员工' }), /申请凭证/);
  assert.throws(() => service.apply({ ticket: jwt.sign({ purpose: 'wechat-binding', openid: 'wx-a', appid: 'wrong' }, secret), name: '员工' }), /申请凭证/);
  assert.throws(() => service.apply({ ticket: jwt.sign({ purpose: 'wechat-binding', openid: 'wx-a', appid: 'test-app', exp: 1 }, secret), name: '员工' }), /申请凭证/);
  const first = service.apply({ ticket, name: '员工', contact: '联系方式' }).binding;
  assert.equal(first.status, 'pending');
  assert.equal(db.queryAll('SELECT * FROM mp_identities').length, 0);
  assert.equal(service.apply({ ticket, name: '重复提交' }).binding.id, first.id);
  assert.throws(() => service.review(first.id, { action: 'approve', user_id: 999 }, 1), /有效后台人员/);
  service.review(first.id, { action: 'approve', user_id: 2 }, 1);
  let identity = db.queryOne('SELECT * FROM mp_identities');
  assert.equal(identity.user_id, 2); assert.equal(identity.status, 'active');
  assert.throws(() => service.review(first.id, { action: 'approve', user_id: 1 }, 1), /状态已变化/);
  assert.throws(() => service.apply({ ticket, name: '员工' }), /此微信已绑定/);
  const second = service.apply({ ticket: service.ticket('wx-b'), name: '另一个微信' }).binding;
  assert.throws(() => service.review(second.id, { action: 'approve', user_id: 2 }, 1), /已绑定其他微信/);
  service.review(second.id, { action: 'reject' }, 1);
  assert.equal(service.status('wx-b').status, 'rejected');
  service.review(first.id, { action: 'revoke' }, 1);
  assert.equal(db.queryOne('SELECT status FROM mp_identities').status, 'disabled');
  const again = service.apply({ ticket, name: '员工' }).binding;
  service.review(again.id, { action: 'approve', user_id: 1 }, 1);
  identity = db.queryOne('SELECT * FROM mp_identities');
  assert.equal(identity.user_id, 1); assert.equal(identity.auth_version, 2);
  assert.equal(db.queryAll('SELECT * FROM mp_audit_logs').length, 4);
  raw.close();
  console.log('PASS: verified tickets, pending isolation, idempotency, approval, rejection, duplicate binding prevention, revocation and session versions');
})().catch(e => { console.error(e); process.exitCode = 1; });
