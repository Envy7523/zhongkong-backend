const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function initialize(db) {
  db.run(`CREATE TABLE IF NOT EXISTS mp_wechat_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, identity_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL, contact TEXT DEFAULT '', verification TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', user_id INTEGER, reviewed_by INTEGER,
    reviewed_at TEXT, created_at TEXT DEFAULT (datetime('now','localtime')))`);
}

function createService({ db, secret, readConfig, fetchImpl = (...args) => fetch(...args) }) {
  const config = () => {
    const mp = readConfig().mp || {};
    return { appid: process.env.MP_APPID || mp.appid, secret: process.env.MP_APPSECRET || mp.secret };
  };
  const available = () => Boolean(config().appid && config().secret);
  async function exchange(code) {
    const mp = config();
    if (!available()) throw fail('微信登录尚未配置，请联系管理员', 501);
    if (typeof code !== 'string' || !code || code.length > 256) throw fail('缺少有效微信登录凭证');
    const params = new URLSearchParams({ appid: mp.appid, secret: mp.secret, js_code: code, grant_type: 'authorization_code' });
    let data;
    try {
      const response = await fetchImpl(`https://api.weixin.qq.com/sns/jscode2session?${params}`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error('upstream');
      data = await response.json();
    } catch { throw fail('微信身份验证暂不可用，请稍后重试', 502); }
    if (data.errcode || !data.openid) throw fail('微信登录凭证已失效，请重新点击微信登录', 401);
    return data.openid;
  }
  function ticket(openid) {
    return jwt.sign({ purpose: 'wechat-binding', openid, appid: config().appid }, secret, { expiresIn: '10m' });
  }
  function verifyTicket(value) {
    try {
      const p = jwt.verify(value, secret);
      if (p.purpose !== 'wechat-binding' || !p.openid || p.appid !== config().appid) throw Error();
      return p.openid;
    } catch { throw fail('申请凭证已过期，请重新点击微信登录', 401); }
  }
  function status(openid) {
    const row = db.queryOne('SELECT id,status,verification,name,contact FROM mp_wechat_requests WHERE identity_id=?', [openid]);
    return row || null;
  }
  function apply({ ticket: value, name, contact }) {
    const openid = verifyTicket(value);
    const cleanName = String(name || '').trim();
    const cleanContact = String(contact || '').trim();
    if (!cleanName || cleanName.length > 30 || cleanContact.length > 60) throw fail('请填写姓名（最多30字），联系方式最多60字');
    const identity = db.queryOne("SELECT * FROM mp_identities WHERE identity_type='openid' AND identity_id=?", [openid]);
    const old = status(openid);
    if (identity?.status === 'active' && old?.status === 'approved') throw fail('此微信已绑定，请重新登录', 409);
    if (old?.status === 'pending') return { binding: status(openid) };
    const verification = crypto.randomBytes(6).toString('hex').toUpperCase();
    db.run(`INSERT INTO mp_wechat_requests (identity_id,name,contact,verification) VALUES (?,?,?,?)
      ON CONFLICT(identity_id) DO UPDATE SET name=excluded.name,contact=excluded.contact,
      verification=excluded.verification,status='pending',user_id=NULL,reviewed_by=NULL,reviewed_at=NULL`,
      [openid, cleanName, cleanContact, verification]);
    db.save();
    return { binding: status(openid) };
  }
  function list() {
    return db.queryAll(`SELECT r.id,r.name,r.contact,r.verification,r.status,r.user_id,r.created_at,r.reviewed_at,
      u.username,u.display_name FROM mp_wechat_requests r LEFT JOIN users u ON u.id=r.user_id ORDER BY r.id DESC LIMIT 500`);
  }
  function review(id, { action, user_id }, reviewer) {
    if (!['approve', 'reject', 'revoke'].includes(action)) throw fail('审核操作无效');
    const row = db.queryOne('SELECT * FROM mp_wechat_requests WHERE id=?', [Number(id)]);
    if (!row) throw fail('申请不存在', 404);
    if (action === 'revoke' ? row.status !== 'approved' : row.status !== 'pending') throw fail('申请状态已变化，请刷新', 409);
    const userId = Number(user_id);
    if (action === 'approve') {
      if (!Number.isInteger(userId) || userId <= 0 || !db.queryOne('SELECT id FROM users WHERE id=?', [userId])) throw fail('请选择有效后台人员');
      const other = db.queryOne("SELECT id FROM mp_identities WHERE identity_type='openid' AND user_id=? AND status='active' AND identity_id<>?", [userId, row.identity_id]);
      if (other) throw fail('该人员已绑定其他微信，请先解除旧绑定', 409);
    }
    db.exec('BEGIN');
    try {
      if (action === 'approve') {
        db.run(`INSERT INTO mp_identities (identity_type,identity_id,user_id,status) VALUES ('openid',?,?,'active')
          ON CONFLICT(identity_type,identity_id) DO UPDATE SET user_id=excluded.user_id,status='active',store_id=NULL,auth_version=auth_version+1`, [row.identity_id, userId]);
      } else {
        db.run("UPDATE mp_identities SET status='disabled',auth_version=auth_version+1 WHERE identity_type='openid' AND identity_id=?", [row.identity_id]);
      }
      db.run("UPDATE mp_wechat_requests SET status=?,user_id=?,reviewed_by=?,reviewed_at=datetime('now','localtime') WHERE id=?",
        [action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'revoked', action === 'approve' ? userId : row.user_id, reviewer, row.id]);
      db.run("INSERT INTO mp_audit_logs (user_id,identity_type,action,target,detail) VALUES (?,'admin',?,?,?)",
        [reviewer, `wechat.${action}`, String(row.id), JSON.stringify({ user_id: action === 'approve' ? userId : row.user_id })]);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    db.save();
    return { ok: true };
  }
  return { available, exchange, ticket, status, apply, list, review };
}
module.exports = { initialize, createService };
