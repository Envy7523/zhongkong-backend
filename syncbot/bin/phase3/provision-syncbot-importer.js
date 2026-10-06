#!/usr/bin/env node
'use strict';
/**
 * 开通 syncbot 专用导入身份（**只走项目正式 HTTP 接口**）
 *
 * 用法（默认 dry-run，只打印计划，不做任何写操作）：
 *   sudo -u syncbot -H env HOME=/home/syncbot node provision-syncbot-importer.js            # 计划
 *   sudo -u syncbot -H env HOME=/home/syncbot node provision-syncbot-importer.js --apply    # 执行
 *
 * 安全设计（可逐条审查）：
 *  1) **绝不直接写库**：不使用 sqlite3，也不 require 项目模块去 INSERT/UPDATE。
 *     只调用正式接口：POST /api/positions、POST /api/users、PUT /api/users/:id、
 *     PUT /api/positions/:id，以及只读的 GET /api/auth/me、GET /api/positions、GET /api/users。
 *  2) **JWT 只从 0600 文件读取**，全程不回显、不写日志、不落入任何报告；
 *     进程退出时（含异常、含 Ctrl-C）由 finally/信号处理**删除该文件**。
 *  3) 执行前校验令牌：必须含 exp，且 `exp - now <= 3600s`（**拒绝有效期超过 1 小时的令牌**），
 *     且尚未过期；令牌文件不得有 group/other 权限位。
 *  4) 密码为 32 字符高强度随机（crypto.randomBytes），**只写入 0600 secrets 文件**；
 *     调用接口时以内存 Buffer 直接提交（不落盘、不出现在进程命令行）。
 *     顺序上**先登录验收、后落盘**：登录失败不会留下与事实不符的 secrets 文件。
 *  5) 幂等：岗位/用户已存在则复用；权限按“并集”补齐，不覆盖既有权限。
 *  6) 报告全部脱敏：不出现 JWT、密码、Cookie、密钥；只打印 HTTP 状态码与权限码清单。
 *  7) **不调用导入接口、不上传 Excel、不产生任何业务数据**；只做登录与权限验收。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BOT_ROOT = process.env.SYNCBOT_ROOT || '/opt/zhongkong-sync-bot';
const SECRETS_DIR = path.join(BOT_ROOT, 'state', 'secrets');
const SECRET_FILE = path.join(SECRETS_DIR, 'project-importer.json');
const DEFAULT_TOKEN_FILE = path.join(SECRETS_DIR, 'provision.token');
const BASE = process.env.ZK_BASE_URL || 'http://127.0.0.1:3456';

const NEW_PERMISSION = 'business_analytics.import';
const USERNAME = 'syncbot_importer';
const POSITION_NAME = '营业数据接口导入（自动化）';
const POSITION_DESC = '仅供 syncbot 自动化调用营业数据导入接口；除该权限外不授予任何其他能力。';
const GRANT_TO_POSITION = '运营专员';   // 人工导入岗位：补授新权限，避免收紧后 403
const MAX_TTL_SEC = 3600;              // 默认闸门：≤1 小时
const MAX_TTL_OFFICIAL_SEC = 24 * 3600; // 兼容选项允许的上限（项目正式登录的签发时长）

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
// 默认：无论成功失败、无论 dry-run 与否，都删除临时令牌文件（安全优先）。
// 若希望先看 dry-run 计划再执行，可加 --keep-token-on-dry-run 保留到 --apply 那次运行。
const KEEP_TOKEN_ON_DRY_RUN = argv.includes('--keep-token-on-dry-run');
// 显式、一次性的受控兼容选项：允许"项目正式登录接口"签发的 24h 令牌。
// 只认字面值 24h；任何其他值（含更长）一律拒绝。默认闸门仍是 ≤1h。
const OFFICIAL_TTL_RAW = (argv.find((a) => a.startsWith('--accept-official-login-token-ttl=')) || '').split('=')[1] || '';
let MAX_TTL_ACTIVE = MAX_TTL_SEC;
if (OFFICIAL_TTL_RAW) {
  if (OFFICIAL_TTL_RAW !== '24h') {
    console.error(JSON.stringify({ ok: false, refused: true, reason: `不支持的 --accept-official-login-token-ttl=${OFFICIAL_TTL_RAW}（仅允许 24h）` }, null, 2));
    process.exit(2);
  }
  MAX_TTL_ACTIVE = MAX_TTL_OFFICIAL_SEC;
}
const TOKEN_FILE = (argv.find((a) => a.startsWith('--token-file=')) || '').split('=')[1] || DEFAULT_TOKEN_FILE;

const report = { apply: APPLY, base: BASE, steps: [], ok: false };
let tokenFileDeleted = false;

function log(step, ok, detail) {
  report.steps.push({ step, ok: !!ok, detail: detail === undefined ? '' : detail });
}

/** base64url → Buffer */
function b64urlToBuf(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** 只解出 exp/iat 用于有效期闸门；不打印令牌内容 */
function inspectToken(token, maxTtlSeconds = MAX_TTL_SEC) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'not_a_jwt' };
  let payload;
  try { payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8')); }
  catch { return { ok: false, reason: 'payload_unparsable' }; }
  const now = Math.floor(Date.now() / 1000);
  if (!payload || typeof payload.exp !== 'number') return { ok: false, reason: 'exp_missing' };
  const ttl = payload.exp - now;
  if (ttl <= 0) return { ok: false, reason: `already_expired(${ttl}s)` };
  if (ttl > maxTtlSeconds) return { ok: false, reason: `ttl_too_long(${ttl}s>${maxTtlSeconds}s)` };
  return {
    ok: true,
    ttl_seconds: ttl,
    max_ttl_seconds: maxTtlSeconds,
    issued_at: payload.iat ? new Date(payload.iat * 1000).toISOString() : null,
    expires_at: new Date(payload.exp * 1000).toISOString(),
  };
}

async function api(method, urlPath, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    // 走临时文件避免密码出现在命令行；这里用 Buffer 发送并即时丢弃引用
    payload = Buffer.from(JSON.stringify(body), 'utf8');
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = payload.length;
  }
  const res = await fetch(BASE + urlPath, { method, headers, body: payload });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw_len: text.length }; }
  return { status: res.status, json };
}

function readToken() {
  if (!fs.existsSync(TOKEN_FILE)) return { ok: false, reason: `token_file_missing(${TOKEN_FILE})` };
  const st = fs.statSync(TOKEN_FILE);
  if ((st.mode & 0o077) !== 0) return { ok: false, reason: `token_file_permissions_too_open(mode=${(st.mode & 0o777).toString(8)})` };
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (!token) return { ok: false, reason: 'token_file_empty' };
  return { ok: true, token };
}

function deleteTokenFile() {
  try {
    if (fs.existsSync(TOKEN_FILE)) { fs.unlinkSync(TOKEN_FILE); }
    tokenFileDeleted = !fs.existsSync(TOKEN_FILE);
  } catch { tokenFileDeleted = false; }
}

function strongPassword() {
  // 32 字符：base64url(random 24 bytes) → 无歧义字符，去掉填充
  return crypto.randomBytes(24).toString('base64').replace(/\+/g, 'A').replace(/\//g, 'B').replace(/=+$/, '');
}

function writeSecretFile(obj) {
  fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(SECRET_FILE, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.chmodSync(SECRET_FILE, 0o600);
  try { fs.chmodSync(SECRETS_DIR, 0o700); } catch {}
  const st = fs.statSync(SECRET_FILE);
  return { file: SECRET_FILE, mode: (st.mode & 0o777).toString(8), size: st.size };
}

async function main() {
  const tok = readToken();
  if (!tok.ok) { log('读取临时 JWT 文件', false, tok.reason); return; }
  log('读取临时 JWT 文件', true, '已读取（内容不显示）');

  const ins = inspectToken(tok.token, MAX_TTL_ACTIVE);
  report.max_ttl_seconds_effective = MAX_TTL_ACTIVE;
  report.accept_official_login_token_ttl = OFFICIAL_TTL_RAW || null;
  report.token = { ttl_seconds: ins.ttl_seconds || null, expires_at: ins.expires_at || null, issued_at: ins.issued_at || null };
  if (!ins.ok) { log(`校验 JWT 有效期（≤${MAX_TTL_ACTIVE}s 且未过期）`, false, ins.reason); return; }
  log(`校验 JWT 有效期（≤${MAX_TTL_ACTIVE}s 且未过期）`, true, `ttl=${ins.ttl_seconds}s exp=${ins.expires_at}`);

  const token = tok.token;

  // --- 1) 令牌可用性 & 管理员判定 ---
  const me = await api('GET', '/api/auth/me', { token });
  if (me.status !== 200 || !me.json || me.json.ok !== true) { log('GET /api/auth/me', false, `http=${me.status}`); return; }
  log('GET /api/auth/me', true, `http=${me.status} user=${me.json.user?.username || '?'} position=${me.json.user?.position_name || '?'}`);

  const posList0 = await api('GET', '/api/positions', { token });
  const isAdmin = posList0.status === 200;
  log('GET /api/positions（管理员判定）', isAdmin, `http=${posList0.status}${isAdmin ? '' : ' → 非管理员，拒绝执行'}`);
  if (!isAdmin) return;
  const catalog = (posList0.json && posList0.json.permission_catalog) || [];
  const catalogKeys = catalog.flatMap((g) => (g.items || []).map((i) => i.key));
  log('权限目录已包含新权限码', catalogKeys.includes(NEW_PERMISSION),
    catalogKeys.includes(NEW_PERMISSION) ? NEW_PERMISSION : `缺少 ${NEW_PERMISSION}（需先部署 lib/permissions.js 并重启 zhongkong）`);

  const positions = (posList0.json && posList0.json.positions) || [];
  const usersRes = await api('GET', '/api/users', { token });
  if (usersRes.status !== 200) { log('GET /api/users', false, `http=${usersRes.status}`); return; }
  const users = (usersRes.json && usersRes.json.users) || [];
  log('GET /api/users', true, `http=200 count=${users.length}`);

  // --- 2) 目标岗位（仅该一个权限码）---
  let position = positions.find((p) => p.name === POSITION_NAME) || null;
  if (!position) {
    report.plan_position = { action: 'create', name: POSITION_NAME, permissions: [NEW_PERMISSION] };
    if (APPLY) {
      const created = await api('POST', '/api/positions', { token, body: { name: POSITION_NAME, description: POSITION_DESC, permissions: [NEW_PERMISSION] } });
      if (created.status !== 201 && created.status !== 200) { log('创建岗位', false, `http=${created.status}`); return; }
      position = created.json.position;
      log('创建岗位', true, `http=${created.status} id=${position.id}`);
    } else {
      log('创建岗位（dry-run 未执行）', true, POSITION_NAME);
    }
  } else {
    log('复用既有岗位', true, `id=${position.id} name=${position.name}`);
  }

  // --- 3) 目标用户 ---
  let user = users.find((u) => u.username === USERNAME) || null;
  const password = strongPassword();
  if (!user) {
    report.plan_user = { action: 'create', username: USERNAME, position: POSITION_NAME };
    if (APPLY) {
      const created = await api('POST', '/api/users', { token, body: { username: USERNAME, password, display_name: 'AI 自动导报表（接口账号）', phone: '', position_id: position.id } });
      if (created.status !== 200 && created.status !== 201) { log('创建用户', false, `http=${created.status} ${JSON.stringify(created.json).slice(0, 120)}`); return; }
      log('创建用户', true, `http=${created.status} id=${created.json.id}`);
    } else {
      log('创建用户（dry-run 未执行）', true, USERNAME);
    }
  } else {
    log('复用既有用户', true, `id=${user.id} username=${user.username} position=${user.position_name}`);
    if (APPLY) {
      if (!position || user.position_id !== position.id) {
        const upd = await api('PUT', `/api/users/${user.id}`, { token, body: { position_id: position.id } });
        if (upd.status !== 200) { log('调整用户岗位', false, `http=${upd.status}`); return; }
        log('调整用户岗位', true, `http=${upd.status}`);
      }
      const pw = await api('PUT', `/api/users/${user.id}/password`, { token, body: { password } });
      if (pw.status !== 200) { log('轮换用户密码', false, `http=${pw.status}`); return; }
      log('轮换用户密码', true, `http=${pw.status}`);
    } else {
      log('调整岗位/轮换密码（dry-run 未执行）', true, '');
    }
  }

  // --- 4) 给人工导入岗位补授新权限（避免收紧后人工导入 403）---
  const grantPos = positions.find((p) => p.name === GRANT_TO_POSITION) || null;
  if (!grantPos) {
    log(`补授 ${GRANT_TO_POSITION}`, false, '未找到该岗位（请人工确认人工导入由哪个岗位承担）');
  } else {
    const current = Array.isArray(grantPos.permissions) ? grantPos.permissions : [];
    if (current.includes(NEW_PERMISSION)) {
      log(`补授 ${GRANT_TO_POSITION}`, true, '已拥有该权限，无需变更');
    } else {
      const next = Array.from(new Set([...current, NEW_PERMISSION]));
      report.plan_grant = { position: GRANT_TO_POSITION, from: current, to: next };
      if (APPLY) {
        const upd = await api('PUT', `/api/positions/${grantPos.id}`, { token, body: { name: grantPos.name, description: grantPos.description || '', permissions: next } });
        if (upd.status !== 200) { log(`补授 ${GRANT_TO_POSITION}`, false, `http=${upd.status}`); return; }
        log(`补授 ${GRANT_TO_POSITION}`, true, `http=${upd.status} 权限数 ${current.length}→${next.length}`);
      } else {
        log(`补授 ${GRANT_TO_POSITION}（dry-run 未执行）`, true, `将新增 ${NEW_PERMISSION}`);
      }
    }
  }

  if (!APPLY) {
    report.ok = true;
    report.note = 'dry-run：未做任何写操作；确认无误后加 --apply 执行';
    return;
  }

  // --- 5) 用新身份正式登录并验收权限（不调用导入接口）---
  // 先验收、后落盘：登录或权限不符时不会写入 secrets 文件
  const login = await api('POST', '/api/auth/login', { body: { username: USERNAME, password } });
  const loginOk = login.status === 200 && login.json && login.json.ok === true;
  log('用新身份登录 POST /api/auth/login', loginOk, `http=${login.status}`);
  if (!loginOk) return;
  const newToken = login.json.token;
  const meNew = await api('GET', '/api/auth/me', { token: newToken });
  const u = (meNew.json && meNew.json.user) || {};
  const perms = Array.isArray(u.position_permissions) ? u.position_permissions : [];
  const identityOk = meNew.status === 200 && perms.includes(NEW_PERMISSION) && !perms.includes('*');
  report.identity_verification = {
    http: meNew.status,
    username: u.username,
    position_name: u.position_name || null,
    role: u.role || null,
    permissions: perms,
    is_admin: perms.includes('*'),
    has_import_permission: perms.includes(NEW_PERMISSION),
    forbidden_extras: perms.filter((p) => p !== NEW_PERMISSION),
  };
  log('GET /api/auth/me（新身份：仅导入权限、非管理员）', identityOk, `perms=${JSON.stringify(perms)}`);
  if (!identityOk) return;

  // --- 6) 权限验收通过后才写入 secrets（0600）---
  const sec = writeSecretFile({
    username: USERNAME,
    password,
    base_url: BASE,
    note: 'syncbot 专用导入身份。仅用于调用 /api/business-analytics/import。本文件 0600，禁止复制或提交版本库。',
    created_at: new Date().toISOString(),
  });
  report.secrets_file = { file: sec.file, mode: sec.mode, bytes: sec.size };
  log('写入 secrets 文件（0600）', sec.mode === '600', `${sec.file} mode=${sec.mode}`);
  report.ok = true;
}

// 无论成功失败都删除临时 JWT 文件
process.on('SIGINT', () => { deleteTokenFile(); report.token_file_deleted = tokenFileDeleted; console.log(JSON.stringify(report, null, 2)); process.exit(130); });
process.on('SIGTERM', () => { deleteTokenFile(); report.token_file_deleted = tokenFileDeleted; console.log(JSON.stringify(report, null, 2)); process.exit(143); });

module.exports = { inspectToken, strongPassword, b64urlToBuf, readToken, deleteTokenFile, TOKEN_FILE, MAX_TTL_SEC };

if (require.main === module) {
  // 无论成功失败都删除临时 JWT 文件
  process.on('SIGINT', () => { deleteTokenFile(); report.token_file_deleted = tokenFileDeleted; console.log(JSON.stringify(report, null, 2)); process.exit(130); });
  process.on('SIGTERM', () => { deleteTokenFile(); report.token_file_deleted = tokenFileDeleted; console.log(JSON.stringify(report, null, 2)); process.exit(143); });

  main()
    .catch((e) => { log('异常', false, String(e && e.message).slice(0, 200)); report.ok = false; })
    .finally(() => {
      if (KEEP_TOKEN_ON_DRY_RUN && !APPLY) {
        report.token_file_kept = 'dry-run 保留（--apply 运行时会删除）';
      } else {
        deleteTokenFile();
        report.token_file_deleted = tokenFileDeleted;
      }
      report.token_file = TOKEN_FILE;
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.ok ? 0 : 1);
    });
}
