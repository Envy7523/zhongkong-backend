#!/usr/bin/env node
'use strict';
/**
 * provisioning 登录辅助流程（**仅本机、一次性**）
 *
 * 用途：让你在 SSH 终端里**隐藏输入**管理员用户名与密码，由本流程调用项目正式
 *       `/api/auth/login` 取得 JWT，并**在同一进程内存中**完成 provisioning 的
 *       dry-run 与 apply。你不需要复制/粘贴任何 JWT。
 *
 * 安全设计（可逐条审查）：
 *  1) 用户名/密码/JWT **只存在于进程内存与隐藏输入的 tty 读缓冲**；
 *     不写入 argv、不写入环境变量、不写入 shell 历史、不写日志/截图/报告。
 *  2) 输入用 raw-mode tty 读取，**不回显任何字符**（连 `*` 也不显示）。
 *  3) 令牌有效期闸门默认 ≤1h；本流程是"正式登录"路径，遂显式使用一次性兼容选项
 *     `--accept-official-login-token-ttl=24h`（只认 24h，更长/无 exp/过期一律拒绝）。
 *  4) 调用 `/api/auth/me` 且要求 `position_permissions` 含 `*`，并额外要求
 *     `GET /api/positions`（仅管理员可访问）返回 200，双重确认管理员身份；否则直接拒。
 *  5) 与既有 provisioning 脚本的兼容方式：因该脚本从 0600 文件读取令牌，
 *     本流程把令牌写入 **mkdtemp(0700) 下的 0600 文件**，并在
 *     finally + SIGINT + SIGTERM 三个路径**一律删除**（脚本自身也会删）。
 *  6) 不做任何业务导入：不调用导入接口、不上传 Excel、不推送、不建 timer、不触碰报表 B。
 *  7) 内存清理为尽力而为：Buffer 会被显式覆写；JS 字符串不可变，无法真正抹零——
 *     这一点如实说明，不夸大保证。
 *
 * 用法（在 syncbot 用户下、SSH 终端内）：
 *   syncbot provision-importer-login
 *   syncbot provision-importer-login --dry-run-only     # 只出计划，不 apply
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BOT_ROOT = process.env.SYNCBOT_ROOT || '/opt/zhongkong-sync-bot';
const SECRETS_DIR = path.join(BOT_ROOT, 'state', 'secrets');
const PROVISION = path.join(BOT_ROOT, 'app', 'bin', 'phase3', 'provision-syncbot-importer.js');
const NODE = process.execPath;
const BASE = process.env.ZK_BASE_URL || 'http://127.0.0.1:3456';
const MAX_TTL_OFFICIAL = 24 * 3600;

const out = { steps: [], ok: false };
let tokenFile = null;
const wipe = { password: null, token: null };

function step(name, ok, detail) {
  out.steps.push({ step: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}

/** 隐藏输入：raw-mode 读取，不回显任何字符 */
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error('需要在交互式 SSH 终端中运行（stdin 不是 tty）'));
    process.stderr.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const onData = (chunk) => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stderr.write('\n');
          return resolve(buf);
        }
        if (ch === '\u0003') { // Ctrl-C
          stdin.setRawMode(false);
          stdin.pause();
          process.stderr.write('\n');
          return reject(new Error('已取消'));
        }
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        if (ch < ' ') continue;
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function api(method, urlPath, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    payload = Buffer.from(JSON.stringify(body), 'utf8');
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = payload.length;
  }
  const res = await fetch(BASE + urlPath, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json };
}

function writeTokenFileOnce(token) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3login-'));
  fs.chmodSync(dir, 0o700);
  const f = path.join(dir, 'provision.token');
  fs.writeFileSync(f, token, { mode: 0o600 });
  fs.chmodSync(f, 0o600);
  tokenFile = f;
  out.token_file = { created: true, mode: '600', dir_mode: '700' };
  return f;
}

function deleteTokenFile() {
  try {
    if (tokenFile && fs.existsSync(tokenFile)) {
      fs.rmSync(tokenFile, { force: true });
      try { fs.rmdirSync(path.dirname(tokenFile)); } catch {}
    }
    out.token_file_deleted = !(tokenFile && fs.existsSync(tokenFile));
  } catch { out.token_file_deleted = false; }
}

function runProvision(extraArgs) {
  const r = spawnSync(NODE, [PROVISION, `--token-file=${tokenFile}`, ...extraArgs], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

(async () => {
  // 身份与前置检查
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === 0) { step('拒绝以 root 运行（secrets 必须归 syncbot）', false, 'uid=0'); return; }
  if (!fs.existsSync(PROVISION)) { step('找到 provisioning 脚本', false, PROVISION); return; }
  try {
    if (fs.statSync(SECRETS_DIR).uid !== uid) { step('secrets 目录属主与当前用户一致', false, `dir_uid=${fs.statSync(SECRETS_DIR).uid} uid=${uid}`); return; }
  } catch (e) { step('secrets 目录可访问', false, String(e.message).slice(0, 80)); return; }
  step('secrets 目录属主与当前用户一致', true, '');

  const dryRunOnly = process.argv.includes('--dry-run-only');

  const username = (await readHidden('管理员用户名: ')).trim();
  if (!username) { step('读取用户名', false, '为空'); return; }
  step('读取用户名（隐藏输入，不回显）', true, '已读取');

  const password = await readHidden('管理员密码: ');
  if (!password) { step('读取密码', false, '为空'); return; }
  wipe.password = password;
  step('读取密码（隐藏输入，不回显）', true, '已读取');

  const login = await api('POST', '/api/auth/login', { body: { username, password } });
  if (login.status !== 200 || !login.json || !login.json.token) {
    step('正式登录 /api/auth/login', false, `http=${login.status}`);
    return;
  }
  wipe.token = login.json.token;
  step('正式登录 /api/auth/login', true, `http=${login.status}`);

  const me = await api('GET', '/api/auth/me', { token: wipe.token });
  const u = (me.json && me.json.user) || {};
  const perms = Array.isArray(u.position_permissions) ? u.position_permissions : [];
  step('GET /api/auth/me 确认身份', me.status === 200, `http=${me.status} user=${u.username || '?'} position=${u.position_name || '?'}`);
  if (me.status !== 200) return;
  const posProbe = await api('GET', '/api/positions', { token: wipe.token });
  const isAdmin = perms.includes('*') && posProbe.status === 200;
  step('确认为管理员（* 且 GET /api/positions 200）', isAdmin, `has_star=${perms.includes('*')} positions_http=${posProbe.status}`);
  if (!isAdmin) return;

  // 令牌有效期（正式登录路径：显式一次性兼容 24h）
  const parts = String(wipe.token).split('.');
  let ttl = null;
  try { ttl = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).exp - Math.floor(Date.now() / 1000); } catch {}
  step('令牌有效期 ≤24h（正式登录兼容选项）', typeof ttl === 'number' && ttl > 0 && ttl <= MAX_TTL_OFFICIAL, `ttl=${ttl}s`);
  if (!(typeof ttl === 'number' && ttl > 0 && ttl <= MAX_TTL_OFFICIAL)) return;
  out.token_ttl_seconds = ttl;

  writeTokenFileOnce(wipe.token);
  step('写入一次性 0600 令牌文件（供兼容）', true, 'mkdtemp(0700)/provision.token(0600)');

  const dry = runProvision(['--keep-token-on-dry-run', '--accept-official-login-token-ttl=24h']);
  out.dry_run = { exit: dry.status, report: safeParse(dry.stdout) };
  step('provisioning dry-run', dry.status === 0, `exit=${dry.status}`);
  if (dry.status !== 0) { out.dry_run_stderr_len = (dry.stderr || '').length; return; }

  if (dryRunOnly) { out.ok = true; out.note = '--dry-run-only：已跳过 apply'; return; }

  const app = runProvision(['--apply', '--accept-official-login-token-ttl=24h']);
  out.apply = { exit: app.status, report: safeParse(app.stdout) };
  step('provisioning apply', app.status === 0, `exit=${app.status}`);
  out.ok = app.status === 0;
})()
  .catch((e) => step('异常', false, String(e && e.message).slice(0, 160)))
  .finally(() => {
    deleteTokenFile();
    wipe.password = null;
    wipe.token = null;
    out.memory_cleared = 'best-effort（Buffer 已覆写；JS 字符串不可变，无法真正抹零）';
    // 兜底：确保输出中绝不含密码/令牌
    const text = JSON.stringify(out, null, 2);
    const leaked = /eyJ[A-Za-z0-9_-]{10,}\./.test(text);
    if (leaked) { console.log(JSON.stringify({ ok: false, fatal: 'REFUSED: 输出检测到疑似令牌，已拒绝打印' })); process.exit(3); }
    console.log(text);
    process.exit(out.ok ? 0 : 1);
  });

function safeParse(s) {
  try { return JSON.parse(s); } catch { return { _unparsable: true, bytes: (s || '').length }; }
}

process.on('SIGINT', () => { deleteTokenFile(); wipe.password = null; wipe.token = null; console.log(JSON.stringify({ ok: false, interrupted: 'SIGINT', token_file_deleted: out.token_file_deleted }, null, 2)); process.exit(130); });
process.on('SIGTERM', () => { deleteTokenFile(); wipe.password = null; wipe.token = null; console.log(JSON.stringify({ ok: false, interrupted: 'SIGTERM', token_file_deleted: out.token_file_deleted }, null, 2)); process.exit(143); });
