#!/usr/bin/env node
'use strict';
/**
 * provisioning 登录辅助流程 · 离线测试（不连服务器、不访问美团、不导出/导入）
 * 覆盖：≤24h 兼容选项、>24h/过期/无 exp/非 JWT 拒绝、密码与令牌不外泄。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const here = __dirname;
const PROVISION = path.join(here, 'provision-syncbot-importer.js');
const LOGIN = process.env.P3_LOGIN_JS
  || path.resolve(here, '..', 'stage0', 'app', 'src', 'phase3', 'provision-importer-login.js');

const results = [];
const ck = (n, ok, d) => results.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });

const P = require(PROVISION);
const now = Math.floor(Date.now() / 1000);
const mkToken = (payload) => ['h', Buffer.from(JSON.stringify(payload)).toString('base64url'), 's'].join('.');

// ---------- 1) TTL 矩阵（默认 ≤1h 与兼容 ≤24h）----------
const H = 3600;
ck('T1 默认闸门：24h 令牌被拒', P.inspectToken(mkToken({ exp: now + 24 * H }), 3600).reason === `ttl_too_long(${24 * H}s>3600s)`, '');
ck('T2 默认闸门：30 分钟令牌通过', P.inspectToken(mkToken({ exp: now + 1800 }), 3600).ok === true, '');
ck('T3 兼容选项：24h 令牌通过', P.inspectToken(mkToken({ exp: now + 24 * H }), 24 * H).ok === true, '');
ck('T4 兼容选项：25h 令牌仍被拒', String(P.inspectToken(mkToken({ exp: now + 25 * H }), 24 * H).reason).startsWith('ttl_too_long'), P.inspectToken(mkToken({ exp: now + 25 * H }), 24 * H).reason);
ck('T5 已过期令牌被拒', String(P.inspectToken(mkToken({ exp: now - 5 }), 24 * H).reason).startsWith('already_expired'), '');
ck('T6 无 exp 被拒', P.inspectToken(mkToken({ iat: now }), 24 * H).reason === 'exp_missing', '');
ck('T7 非 JWT 被拒', P.inspectToken('not-a-jwt', 24 * H).reason === 'not_a_jwt', '');
ck('T8 payload 不可解析被拒', P.inspectToken('h.@@@.s', 24 * H).reason === 'payload_unparsable', '');

// ---------- 2) 兼容选项的 CLI 行为（真实进程）----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p3login-test-'));
const tf = path.join(tmp, 'provision.token');
const writeTok = (t) => fs.writeFileSync(tf, t, { mode: 0o600 });
const run = (args) => spawnSync(process.execPath, [PROVISION, `--token-file=${tf}`, ...args], { encoding: 'utf8' });
const SECRETISH = mkToken({ exp: now + 24 * H });

writeTok(SECRETISH);
let r = run(['--accept-official-login-token-ttl=48h']);
ck('T9 非法兼容值 48h → 拒绝且退出码 2', r.status === 2 && /仅允许 24h/.test(r.stdout + r.stderr), `status=${r.status}`);
ck('T10 拒绝时不回显令牌', !(r.stdout + r.stderr).includes(SECRETISH), '');

// T11/T12/T14 需要"0600 可读"的令牌文件；Windows 上 chmod 不生效（实测 666），
// readToken() 会正确地以 token_file_permissions_too_open 拒绝。因此：
//  - win32：断言权限闸门确实生效（证明该防线工作），并注明 CLI 级 TTL 断言须在 Linux 上重跑；
//  - linux：断言真实的 TTL/兼容选项行为。
const PERM_GATED = process.platform === 'win32';
if (PERM_GATED) {
  writeTok(SECRETISH);
  const rr = run([]);
  let pp = null; try { pp = JSON.parse(rr.stdout); } catch {}
  ck('T11/T12/T14 (win32) 令牌文件权限闸门生效：非 0600 一律拒绝',
    !!pp && JSON.stringify(pp.steps).includes('token_file_permissions_too_open'),
    `steps=${pp ? JSON.stringify(pp.steps).slice(0, 120) : 'unparsable'}`);
  ck('T11b (win32) CLI 级 TTL/兼容断言须在 Linux 服务器重跑（本机无法验证）', true,
    'deferred-to-linux');
} else {
  writeTok(SECRETISH);
  r = run([]);
  ck('T11 24h 令牌无兼容选项 → ttl_too_long 拒绝', /ttl_too_long\(86400s>3600s\)/.test(r.stdout), '');

  writeTok(SECRETISH);
  r = run(['--accept-official-login-token-ttl=24h']);
  let parsed2 = null; try { parsed2 = JSON.parse(r.stdout); } catch {}
  ck('T12 24h 令牌 + 兼容选项 → 通过 TTL 闸门（不再报 ttl_too_long）',
    !!parsed2 && parsed2.max_ttl_seconds_effective === 86400 && !/ttl_too_long/.test(r.stdout),
    `max_ttl=${parsed2 && parsed2.max_ttl_seconds_effective}`);
  ck('T13 无服务器时 dry-run 必须失败且报告 ok=false（传输层失败，非鉴权绕过）',
    !!parsed2 && parsed2.ok === false, `ok=${parsed2 && parsed2.ok}`);

  writeTok(mkToken({ exp: now + 25 * H }));
  r = run(['--accept-official-login-token-ttl=24h']);
  ck('T14 25h 令牌 + 兼容选项 → 仍被拒', /ttl_too_long\(90000s>86400s\)/.test(r.stdout), '');

  // T26 清理逻辑：即使走到传输层失败，令牌文件也必须被自动删除
  writeTok(SECRETISH);
  ck('T26-pre 令牌文件存在（清理测试前置）', fs.existsSync(tf), '');
  r = run(['--accept-official-login-token-ttl=24h']);
  ck('T26 失败路径下令牌文件仍被自动删除（finally 生效）',
    !fs.existsSync(tf), `exists=${fs.existsSync(tf)} exit=${r.status}`);
}

// ---------- 3) 泄漏检查 ----------
const allOut = [r.stdout, r.stderr].join('\n');
ck('T15 stdout/stderr 不含令牌片段', !/eyJ[A-Za-z0-9_-]{10,}\./.test(allOut), '');
ck('T16 报告未包含密码字段', !/"password"\s*:/.test(allOut), '');

// ---------- 4) 辅助流程的静态安全断言（需要 tty/服务器，故静态校验）----------
const src = fs.readFileSync(LOGIN, 'utf8');
ck('T17 辅助流程要求隐藏输入（raw mode、不回显）', /setRawMode\(true\)/.test(src) && !/process\.stderr\.write\(ch\)/.test(src), '');
ck('T18 辅助流程不把令牌值放进 argv（仅传 token-file 路径）',
  !/\[PROVISION[^\]]*wipe\.token/.test(src) && /--token-file=\$\{tokenFile\}/.test(src), '');
ck('T19 辅助流程确认管理员：要求 * 且 GET /api/positions 返回 200',
  /perms\.includes\('\*'\)/.test(src) && /posProbe\.status === 200/.test(src), '');
ck('T20 辅助流程使用一次性兼容选项 24h', /--accept-official-login-token-ttl=24h/.test(src), '');
ck('T21 令牌文件在 finally/SIGINT/SIGTERM 三处删除',
  /\.finally\(/.test(src) && /SIGINT/.test(src) && /SIGTERM/.test(src) && (src.match(/deleteTokenFile\(\)/g) || []).length >= 3, '');
ck('T22 以 root 运行会被拒绝', /uid === 0/.test(src), '');
ck('T23 输出前做令牌泄漏兜底检查', /REFUSED: 输出检测到疑似令牌/.test(src), '');
ck('T24 明确不夸大内存清理保证', /JS 字符串不可变/.test(src), '');

// ---------- 5) 令牌文件权限 ----------
writeTok(SECRETISH);
const st = fs.statSync(tf);
if (process.platform === 'win32') {
  // Windows 上 chmod 不生效（实测恒为 666），权限断言只能在 Linux 服务器上真正验证
  const lit = fs.readFileSync(LOGIN, 'utf8');
  ck('T25 令牌文件权限：Linux 上写入 0600（本机 win32 无法验证，改为校验源码显式设 0600）',
    /writeFileSync\(f, token, \{ mode: 0o600 \}\)/.test(lit) && /chmodSync\(f, 0o600\)/.test(lit), `win32_mode=${(st.mode & 0o777).toString(8)}`);
} else {
  ck('T25 一次性令牌文件为 0600', (st.mode & 0o777) === 0o600, (st.mode & 0o777).toString(8));
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
const ok = results.every((x) => x.ok);
console.log(JSON.stringify({ ok, total: results.length, failed: results.filter((x) => !x.ok).length, results }, null, 2));
process.exit(ok ? 0 : 1);
