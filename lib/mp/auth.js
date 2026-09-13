/**
 * 小程序（/api/mp）身份模块
 *
 * 设计要点（决定个人测试期的代码能否 100% 复用到企业阶段）：
 *   把「身份来源」抽象成 provider，登录接口统一为 POST /api/mp/auth/login/:provider
 *     - password : 用户名 + 密码（复用现有 users 表的 MD5 口令）—— 个人测试期主力
 *     - openid   : wx.login → code2session → openid + 邀请码绑定员工 —— 普通微信小程序
 *     - wxwork   : wx.qy.login → userid —— 企业微信小程序免登（需企业主体，配置为空时返回 501）
 *   业务代码只认「业务用户(user) + 数据范围(store scope)」，切换身份源不需要改业务。
 *
 * 与后台账号体系(server.js 的 JWT)完全隔离：小程序用自己的 token，互不影响。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const db = require('../db');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');
const MP_JWT_SECRET = process.env.MP_JWT_SECRET || 'etaigong-mp-jwt-secret-2026';
const MP_JWT_EXPIRES = '7d';

/** 允许的登录方式（前端可据此渲染登录页） */
const PROVIDERS = ['password', 'openid', 'wxwork'];

// ==================== 配置 ====================

function stripBOM(str) {
  return typeof str === 'string' && str.codePointAt(0) === 0xFEFF ? str.slice(1) : str;
}

function readConfig() {
  try {
    return JSON.parse(stripBOM(fs.readFileSync(CONFIG_PATH, 'utf-8')));
  } catch {
    return {};
  }
}

/** 已配置好的登录方式（wxwork/openid 需相应凭据，未配置则不暴露给前端） */
function availableProviders() {
  const cfg = readConfig();
  const mp = cfg.mp || {};
  const list = ['password'];
  if (mp.appid && mp.secret) list.push('openid');
  if (cfg.corpid && cfg.corpsecret) list.push('wxwork');
  return list;
}

// ==================== 企业微信 access_token（wxwork provider 用） ====================

let tokenCache = { token: null, expiresAt: 0 };
async function wecomToken() {
  const cfg = readConfig();
  if (!cfg.corpid || !cfg.corpsecret) throw Object.assign(new Error('未配置企业微信 corpid/corpsecret'), { status: 501 });
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${cfg.corpid}&corpsecret=${cfg.corpsecret}`;
  const data = await (await fetch(url)).json();
  if (data.errcode !== 0) throw new Error(`获取企业微信 token 失败: [${data.errcode}] ${data.errmsg}`);
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 300) * 1000 };
  return tokenCache.token;
}

// ==================== 身份映射（mp_identities） ====================

function findIdentity(type, id) {
  return db.queryOne('SELECT * FROM mp_identities WHERE identity_type=? AND identity_id=?', [type, id]);
}

function bindIdentity({ type, id, userId, unionId = '', nickname = '', avatarUrl = '', storeId = null, status = 'active' }) {
  const existing = findIdentity(type, id);
  if (existing) {
    db.run('UPDATE mp_identities SET union_id=?, nickname=?, avatar_url=?, status=? WHERE id=?',
      [unionId || existing.union_id, nickname || existing.nickname, avatarUrl || existing.avatar_url, status, existing.id]);
    return findIdentity(type, id);
  }
  const id_ = db.insert(
    `INSERT INTO mp_identities (identity_type, identity_id, user_id, union_id, nickname, avatar_url, store_id, status)
     VALUES (?,?,?,?,?,?,?,?)`,
    [type, id, userId, unionId, nickname, avatarUrl, storeId, status]
  );
  return db.queryOne('SELECT * FROM mp_identities WHERE id=?', [id_]);
}

function touchLogin(identityId) {
  db.run("UPDATE mp_identities SET last_login_at=datetime('now','localtime') WHERE id=?", [identityId]);
}

// ==================== 业务用户与数据范围 ====================

function loadUser(userId) {
  return db.queryOne('SELECT id,username,role,display_name,phone,avatar_url FROM users WHERE id=?', [userId]);
}

/** 全量可见门店的角色（其余角色只看 mp_identities.store_id 绑定的门店） */
const ALL_STORE_ROLES = ['管理员', '督导'];

/**
 * 数据范围：返回 null 表示全部门店，返回数字表示仅该门店
 */
function storeScope(user) {
  if (!user) return null;
  if (ALL_STORE_ROLES.includes(user.role)) return null;
  const rows = db.queryAll('SELECT store_id FROM mp_identities WHERE user_id=? AND store_id IS NOT NULL', [user.id]);
  if (!rows.length) return null; // 未绑定门店时不下发限制，避免个人测试期看不到数据
  return rows[0].store_id;
}

// ==================== Provider 实现 ====================

/** 1) 用户名 + 密码（复用现有 users 表，MD5 与新库保持一致） */
async function providerPassword({ username, password }) {
  if (!username || !password) throw Object.assign(new Error('用户名和密码不能为空'), { status: 400 });
  const hash = crypto.createHash('md5').update(String(password)).digest('hex');
  const user = db.queryOne('SELECT * FROM users WHERE username=? AND password_hash=?', [String(username).trim(), hash]);
  if (!user) throw Object.assign(new Error('用户名或密码错误'), { status: 401 });
  const identity = bindIdentity({ type: 'password', id: user.username, userId: user.id });
  touchLogin(identity.id);
  return { user, identity };
}

/**
 * 2) 微信小程序 openid（普通微信里打开时使用）
 * 首次登录必须带邀请码：邀请码 = 管理员预先建好的账号用户名（users.username）
 */
async function providerOpenid({ code, invite }) {
  const cfg = readConfig();
  const mp = cfg.mp || {};
  if (!mp.appid || !mp.secret) {
    throw Object.assign(new Error('未配置小程序 AppID/AppSecret（config.json 的 mp.appid / mp.secret）'), { status: 501 });
  }
  if (!code) throw Object.assign(new Error('缺少 code'), { status: 400 });

  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${mp.appid}&secret=${mp.secret}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const data = await (await fetch(url)).json();
  if (data.errcode) throw new Error(`code2session 失败: [${data.errcode}] ${data.errmsg}`);
  const openid = data.openid;

  let identity = findIdentity('openid', openid);
  if (!identity) {
    if (!invite) throw Object.assign(new Error('首次使用需要填写邀请码（员工账号）'), { status: 428 });
    const user = db.queryOne('SELECT * FROM users WHERE username=?', [String(invite).trim()]);
    if (!user) throw Object.assign(new Error('邀请码无效，请联系管理员'), { status: 400 });
    identity = bindIdentity({
      type: 'openid', id: openid, userId: user.id, unionId: data.unionid || '',
      status: mp.autoApprove === false ? 'pending' : 'active',
    });
  }
  assertActive(identity);
  touchLogin(identity.id);
  return { user: loadUser(identity.user_id), identity };
}

/**
 * 3) 企业微信小程序免登（企业阶段启用；个人主体无法调通，配置缺失时返回 501）
 */
async function providerWxwork({ code }) {
  const cfg = readConfig();
  if (!cfg.corpid || !cfg.corpsecret) {
    throw Object.assign(new Error('未配置企业微信凭据，wxwork 免登不可用（企业主体阶段启用）'), { status: 501 });
  }
  if (!code) throw Object.assign(new Error('缺少 code'), { status: 400 });

  const token = await wecomToken();
  const url = `https://qyapi.weixin.qq.com/cgi-bin/miniprogram/jscode2session?access_token=${token}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const data = await (await fetch(url)).json();
  if (data.errcode !== 0) throw new Error(`企业微信 jscode2session 失败: [${data.errcode}] ${data.errmsg}`);
  const userid = data.userid;

  let identity = findIdentity('wxwork', userid);
  if (!identity) {
    // 优先按企业微信 userid 匹配同名后台账号，其次按手机号（通讯录获取）匹配
    const user = db.queryOne('SELECT * FROM users WHERE username=?', [userid]);
    if (!user) throw Object.assign(new Error('企业微信账号未在系统中登记，请联系管理员开号'), { status: 403 });
    identity = bindIdentity({ type: 'wxwork', id: userid, userId: user.id });
  }
  assertActive(identity);
  touchLogin(identity.id);
  return { user: loadUser(identity.user_id), identity };
}

function assertActive(identity) {
  if (identity.status === 'pending') throw Object.assign(new Error('账号待管理员审核'), { status: 403 });
  if (identity.status === 'disabled') throw Object.assign(new Error('账号已被停用'), { status: 403 });
}

const PROVIDER_IMPL = { password: providerPassword, openid: providerOpenid, wxwork: providerWxwork };

// ==================== 对外：登录 / 校验 / 审计 ====================

async function login(provider, payload) {
  const impl = PROVIDER_IMPL[provider];
  if (!impl) throw Object.assign(new Error(`不支持的登录方式: ${provider}`), { status: 400 });
  const { user, identity } = await impl(payload || {});
  if (!user) throw Object.assign(new Error('账号状态异常，请联系管理员'), { status: 403 });
  const scope = storeScope(user);
  const token = jwt.sign({
    id: user.id,
    username: user.username,
    role: user.role,
    display_name: user.display_name,
    avatar_url: user.avatar_url,
    identity_type: provider,
    store_id: identity.store_id || null,
    mp: true,
  }, MP_JWT_SECRET, { expiresIn: MP_JWT_EXPIRES });

  return {
    token,
    user: { ...user, identity_type: provider, store_id: identity.store_id || null },
    storeScope: scope,
  };
}

function verify(token) {
  const payload = jwt.verify(token, MP_JWT_SECRET);
  if (!payload.mp) throw new Error('token 类型不匹配');
  return payload;
}

function audit(req, action, target = '', detail = '') {
  try {
    db.run('INSERT INTO mp_audit_logs (user_id,identity_type,action,target,detail,ip) VALUES (?,?,?,?,?,?)',
      [req.mpUser?.id || null, req.mpUser?.identity_type || '', action, String(target || ''), String(detail || '').slice(0, 500), req.ip || '']);
  } catch { /* 审计失败不阻塞业务 */ }
}

module.exports = {
  PROVIDERS,
  availableProviders,
  login,
  verify,
  storeScope,
  readConfig,
  audit,
  MP_JWT_SECRET,
};
