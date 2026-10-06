#!/usr/bin/env node
'use strict';
/**
 * 「自动同步与日报计划」**端到端集成套件**（进程内 HTTP 桥，零真实副作用）
 *
 * 结构：真实 http 服务器暴露**中控侧路由**（lib/schedule-*，配内存假 db）← 真实 HMAC 签名 ←
 *       **syncbot 侧调度 worker**（app/src/schedule/*，真实 zk-client）→ tick 驱动。
 * 不访问美团、不真实导出/导入/推送、不读企业微信凭据、不建 timer、报表 B 永久锁定。
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p6int-'));
process.env.SYNCBOT_ROOT = ROOT;                       // 必须在 require syncbot 模块之前
const BOT = process.env.SYNCBOT_BOT || path.resolve(__dirname, '..', '..');
const ZK = process.env.SCHEDULE_ZK_DIR || path.join(__dirname, 'zk');

const core = require(path.join(ZK, 'lib', 'schedule-core.js'));
const { createScheduleStore } = require(path.join(ZK, 'lib', 'schedule-store.js'));
const { createScheduleRoutes } = require(path.join(ZK, 'lib', 'schedule-routes.js'));
const WORKER = require(BOT + '/app/src/schedule/worker.js');
const PLAN = require(BOT + '/app/src/schedule/plan.js');
const ZKC = require(BOT + '/app/src/schedule/zk-client.js');

const SECRET = crypto.randomBytes(32).toString('hex');
const RUN = 'test-sched-int-' + Date.now().toString(36);

const out = {
  suite: 'schedule-integration-fixture', fixture: true, offline: true,
  real_meituan_run: false, real_export: false, real_download: false, real_import: false,
  real_wecom_message_sent: false, real_webhook_read: false, timers_created: false, report_b: 'locked_not_started',
  checks: [], test_run_id: RUN,
};
const ck = (n, ok, d) => out.checks.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });

/* ---------------------------------------------------------------- 内存假 db（支持本套件用到的 SQL 子集） */
function fakeDb() {
  const t = { schedule_config: [], schedule_config_audit: [], schedule_job_runs: [] };
  let as = 0; let rs = 0;
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  const find = (job, bd) => t.schedule_job_runs.find((r) => r.job === job && r.business_date === bd);
  function run(sql, p = []) {
    const s = norm(sql);
    if (/^CREATE |^INSERT (OR IGNORE )?INTO schedule_config |^CREATE INDEX/i.test(s)) {
      if (/^INSERT (OR IGNORE )?INTO schedule_config/i.test(s)) t.schedule_config.push({ id: 1, sync_enabled: 0, sync_time: '01:05', report_enabled: 0, report_time: '09:00', timezone: 'Asia/Shanghai', version: 1, updated_at: null, updated_by: null, updated_by_name: null });
      return;
    }
    if (/^UPDATE schedule_config SET /i.test(s)) { Object.assign(t.schedule_config[0], { sync_enabled: p[0], sync_time: p[1], report_enabled: p[2], report_time: p[3], timezone: p[4], version: (t.schedule_config[0].version || 1) + 1, updated_at: p[5], updated_by: p[6], updated_by_name: p[7] }); return; }
    if (/^INSERT INTO schedule_config_audit /i.test(s)) { as += 1; t.schedule_config_audit.push({ id: as, at: p[0], user_id: p[1], user_name: p[2], action: p[3], before_json: p[4], after_json: p[5], note: p[6] }); return; }
    if (/^INSERT INTO schedule_job_runs /i.test(s)) {
      if (find(p[0], p[1])) { const e = new Error('UNIQUE constraint failed'); e.code = 'SQLITE_CONSTRAINT'; throw e; }
      rs += 1;
      t.schedule_job_runs.push({ id: rs, job: p[0], business_date: p[1], idempotency_key: p[2], trigger: p[3], status: p[4], attempt: p[5], send_attempts: p[6], requested_at: p[7], claimed_at: p[8], started_at: p[9], worker_id: p[10], reason: null, detail_json: null, finished_at: null });
      return;
    }
    if (/^UPDATE schedule_job_runs SET status='running', attempt=attempt\+1, claimed_at=\?/i.test(s)) { const r = find(p[3], p[4]); if (r && r.status === 'requested') Object.assign(r, { status: 'running', attempt: (r.attempt || 0) + 1, claimed_at: p[0], started_at: p[1], worker_id: p[2] }); return; }
    if (/^UPDATE schedule_job_runs SET status='running', attempt=attempt\+1/i.test(s)) { const r = find(p[3], p[4]); if (r && r.status === 'refused') Object.assign(r, { status: 'running', attempt: (r.attempt || 0) + 1, claimed_at: p[0], started_at: p[1], reason: null, worker_id: p[2] }); return; }
    if (/^UPDATE schedule_job_runs SET status=\?, reason=\?, detail_json=\?, finished_at=\?, worker_id=\?, send_attempts=send_attempts\+\?/i.test(s)) { const r = find(p[6], p[7]); if (r) Object.assign(r, { status: p[0], reason: p[1], detail_json: p[2], finished_at: p[3], worker_id: p[4] || r.worker_id, send_attempts: (r.send_attempts || 0) + Number(p[5] || 0) }); return; }
    if (/^UPDATE schedule_job_runs SET send_attempts=send_attempts\+1/i.test(s)) { const r = find(p[2], p[3]); if (r) Object.assign(r, { send_attempts: (r.send_attempts || 0) + 1, status: p[0], started_at: p[1] }); return; }
    throw new Error('fakeDb.run unsupported: ' + s.slice(0, 90));
  }
  function queryAll(sql, p = []) {
    const s = norm(sql);
    if (/^SELECT \* FROM schedule_config WHERE id = 1/i.test(s)) return t.schedule_config.slice(0, 1);
    if (/^SELECT id FROM schedule_config_audit ORDER BY id DESC LIMIT 1/i.test(s)) { const l = t.schedule_config_audit[t.schedule_config_audit.length - 1]; return l ? [{ id: l.id }] : []; }
    if (/^SELECT id, at, user_name, action/i.test(s)) return t.schedule_config_audit.slice().reverse().slice(0, Number(p[0]));
    if (/^SELECT \* FROM schedule_job_runs WHERE job = \? AND business_date = \?/i.test(s)) { const r = find(p[0], p[1]); return r ? [r] : []; }
    if (/WHERE job = \? ORDER BY id DESC LIMIT 1/i.test(s)) { const rows = t.schedule_job_runs.filter((r) => r.job === p[0]); return rows.length ? [rows[rows.length - 1]] : []; }
    if (/^SELECT job, business_date, trigger, status/i.test(s) && /ORDER BY id DESC LIMIT \?/i.test(s)) return t.schedule_job_runs.slice().reverse().slice(0, Number(p[0]));
    throw new Error('fakeDb.queryAll unsupported: ' + s.slice(0, 90));
  }
  return { run, queryAll, queryOne: (s, p) => (queryAll(s, p)[0] || null), save() {}, _t: t };
}

(async () => {
  const db = fakeDb();
  const store = createScheduleStore({ db, core });
  store.ensureSchema();

  const state = { pushCalls: 0, pushArgs: [], pushMode: 'ok', evidence: { file_validated: true, import_success: true }, now: new Date('2026-09-22T00:30:00+08:00'), bodies: [], hmacOk: 0, hmacBad: 0 };

  /* ---------------- 中控侧路由（真实实现 + 真实 HMAC 校验） ---------------- */
  function verifyInternal(req) {
    const viaProxy = req.get('x-forwarded-for') || req.get('x-real-ip') || req.get('via') || req.get('forwarded');
    if (viaProxy) return { ok: false, reason: 'via_proxy_denied' };
    const remote = (req.socket && req.socket.remoteAddress) || '';
    if (!/^(127\.|::1$|::ffff:127\.)/.test(remote)) return { ok: false, reason: 'not_loopback' };
    if (!Buffer.isBuffer(req.body)) return { ok: false, reason: 'raw_body_required' };
    const rawBody = req.body.toString('utf8');
    const ts = String(req.get('x-syncbot-timestamp') || '');
    const sig = String(req.get('x-syncbot-signature') || '');
    if (!/^\d{10,16}$/.test(ts) || Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) { state.hmacBad += 1; return { ok: false, reason: 'timestamp_skew' }; }
    const expected = crypto.createHmac('sha256', SECRET).update(ts + '.' + rawBody, 'utf8').digest();
    let given = null;
    try { given = Buffer.from(sig, 'hex'); } catch (e) { given = null; }
    if (!given || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) { state.hmacBad += 1; return { ok: false, reason: 'signature_mismatch' }; }
    state.hmacOk += 1;
    return { ok: true };
  }

  const routes = createScheduleRoutes({
    core, store,
    deps: {
      logger: () => {},
      now: () => state.now,
      checkPermission: () => ({ ok: true, user: { id: 7, name: '测试管理员' } }),
      verifyInternal,
      readRawBody: async (req) => req.body,
      getSyncEvidence: () => state.evidence,
      getLastImport: () => ({ business_date: '2026-09-21', status: 'success' }),
      lastPushLog: () => ({ id: 1, push_type: 'daily', status: 'success' }),
      pushDailyReports: async (arg) => {
        state.pushCalls += 1; state.pushArgs.push(arg);
        if (state.pushMode === 'ok') return { ok: true, sent: true, pushed: 2, push_log_ids: [7, 8] };
        if (state.pushMode === 'unknown') return { ok: false, unknown: true, reason: 'push_timeout_unknown' };
        return { ok: false, reason: 'webhook_not_configured' };
      },
    },
  });
  const handlers = {};
  const app = { get: (p, h) => { handlers['GET ' + p] = h; }, post: (p, h) => { handlers['POST ' + p] = h; } };
  routes.register(app);

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      req.body = Buffer.concat(chunks);
      req.get = (h) => req.headers[String(h).toLowerCase()];
      state.bodies.push({ path: req.url, method: req.method, body: req.body.toString('utf8') });
      const key = String(req.method) + ' ' + String(req.url).split('?')[0];
      const h = handlers[key];
      if (!h) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'not_found' })); return; }
      try { await h(req, res); } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'internal' })); }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  // syncbot 侧密钥文件（0600）：secret + endpoint
  const secretFile = path.join(ROOT, 'state', 'secrets', 'audit-hmac.json');
  fs.mkdirSync(path.dirname(secretFile), { recursive: true });
  fs.writeFileSync(secretFile, JSON.stringify({ secret: SECRET, endpoint: base + '/api/internal/syncbot/schedule', note: 'integration fixture' }), { mode: 0o600 });

  /* ---------------- 注入式 sync 执行器（fake data-only runner） ---------------- */
  const runner = { data_only: true, source: 'integration-test-double', calls: [], runOnce: null };
  let runnerMode = 'ok';
  runner.runOnce = async (arg) => {
    runner.calls.push(arg);
    if (runnerMode === 'ok') return { ok: true, stage_calls: { download: 1, import: 1 }, push_calls: 0, import_batch_id: 900001 };
    return { ok: false, reason: 'import_failed', side_effects: true, stage_calls: { download: 1, import: 0 }, push_calls: 0 };
  };

  const deps = { zkBase: base, secretFile, allowTestBase: true, timeoutMs: 4000, syncRunner: runner };
  const tick = (now, extra) => WORKER.tick({ now, deps: Object.assign({}, deps, extra || {}), workerId: 'it-worker-1' });

  const syncRun = (bd) => store.getRun('sync', bd);
  const reportRun = (bd) => store.getRun('report', bd);

  /* ================================================================ 场景 1：默认 disabled */
  let r = await tick(state.now);
  ck('i1 默认全部 disabled：tick 只读一次调度配置（I1），**零 claim / 零执行 / 零推送**，账本为零行',
    r.calls.schedule_read === 1 && r.calls.claim === 0 && r.calls.execute === 0 && r.calls.report_push === 0 &&
    store.recentRuns(20).length === 0 && state.pushCalls === 0,
    JSON.stringify({ calls: r.calls, runs: store.recentRuns(20).length }));
  ck('i2 disabled 时本地不留任何状态文件（state/schedule 为空）',
    !fs.existsSync(path.join(ROOT, 'state', 'schedule')) || fs.readdirSync(path.join(ROOT, 'state', 'schedule')).length === 0,
    JSON.stringify({ exists: fs.existsSync(path.join(ROOT, 'state', 'schedule')) }));

  /* ================================================================ 场景 2：启用两个时间 */
  function callUser(method, p, body) {
    return new Promise((resolve) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {} }, (res) => {
        let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: t ? JSON.parse(t) : null }));
      });
      req.on('error', () => resolve({ status: 0, body: null }));
      if (payload) req.write(payload);
      req.end();
    });
  }
  const saved = await callUser('POST', '/api/enterprise-settings/schedule', { sync_enabled: true, sync_time: '01:05', report_enabled: true, report_time: '09:00' });
  ck('i3 后台保存计划（同步 01:05 / 日报 09:00）成功并写入审计；保存本身不触发任何执行',
    saved.status === 200 && saved.body.config.sync_enabled === true && saved.body.config.report_time === '09:00' &&
    store.auditList(5).length === 1 && state.pushCalls === 0 && runner.calls.length === 0,
    JSON.stringify({ http: saved.status, cfg: saved.body.config, push: state.pushCalls }));

  state.now = new Date('2026-09-22T01:05:30+08:00');       // 同步到点
  r = await tick(state.now);
  ck('i4 同步到点（01:05）：claim+执行恰好 1 次、中控账本 sync=success、业务日期=前一天；**未到日报时间 ⇒ 零推送**',
    r.calls.execute === 1 && runner.calls.length === 1 && runner.calls[0].businessDate === '2026-09-21' &&
    syncRun('2026-09-21').status === 'success' && r.calls.report_push === 0 && state.pushCalls === 0 && reportRun('2026-09-21') === null,
    JSON.stringify({ calls: r.calls, sync: syncRun('2026-09-21') && syncRun('2026-09-21').status, push: state.pushCalls, report: reportRun('2026-09-21') }));

  r = await tick(state.now);
  ck('i5 同一时刻重复 tick：不再执行（already_success）、零重复导出/导入/推送',
    r.calls.execute === 0 && runner.calls.length === 1 && state.pushCalls === 0,
    JSON.stringify({ calls: r.calls, exec: runner.calls.length }));

  /* ================================================================ 场景 3：日报到点并成功推送 */
  state.now = new Date('2026-09-22T09:00:20+08:00');
  r = await tick(state.now);
  ck('i6 日报到点（09:00）且同步成功 → 只调 I4 一次、项目侧推送函数被调用 1 次、账本 report=success、send_attempts=1',
    r.calls.report_push === 1 && state.pushCalls === 1 && reportRun('2026-09-21').status === 'success' &&
    Number(reportRun('2026-09-21').send_attempts) === 1 && state.pushArgs.length === 1,
    JSON.stringify({ calls: r.calls, push: state.pushCalls, run: reportRun('2026-09-21') && { s: reportRun('2026-09-21').status, a: reportRun('2026-09-21').send_attempts } }));

  const pushAfter = state.pushCalls;
  state.now = new Date('2026-09-22T09:05:00+08:00');
  r = await tick(state.now);
  ck('i7 推送成功后再 tick（重复 tick / 重启恢复）：**零再次发送**（同一业务日期最多一次实际发送）',
    state.pushCalls === pushAfter && r.calls.report_push === 0, JSON.stringify({ push: state.pushCalls - pushAfter, calls: r.calls }));

  /* ================================================================ 场景 4：同步失败 ⇒ 日报零推送 */
  runnerMode = 'failed';
  state.now = new Date('2026-09-23T01:05:30+08:00');
  r = await tick(state.now);
  const d2 = '2026-09-22';
  ck('i8 次日同步失败（导入失败，有副作用）：执行 1 次后落扣**不重做**的终态（waiting_human，绝不自动重试）',
    r.calls.execute === 1 && ['waiting_human', 'failed'].includes(String(syncRun(d2).status)) && Number(syncRun(d2).attempt) === 1,
    JSON.stringify({ calls: r.calls, sync: syncRun(d2) && { s: syncRun(d2).status, a: syncRun(d2).attempt } }));
  const execAfterFail = runner.calls.length;
  state.now = new Date('2026-09-23T01:30:00+08:00');
  const r8b = await tick(state.now);
  ck('i8b 同步失败后再次 tick：**不再重复执行**（终态占位，零重复导出/导入）',
    runner.calls.length === execAfterFail && r8b.calls.execute === 0, JSON.stringify({ exec: runner.calls.length - execAfterFail, calls: r8b.calls }));
  state.now = new Date('2026-09-23T09:00:20+08:00');
  const pushBefore9 = state.pushCalls;
  state.now = new Date('2026-09-23T09:00:20+08:00');
  r = await tick(state.now);
  ck('i9 同步未成功时到点：日报被拒（本地即拒，**零 I4 调用 / 零项目侧推送**），账本无成功记录',
    state.pushCalls === pushBefore9 && r.calls.report_push === 0 &&
    (reportRun(d2) === null || reportRun(d2).status !== 'success'),
    JSON.stringify({ push: state.pushCalls - pushBefore9, calls: r.calls, run: reportRun(d2) && { s: reportRun(d2).status, r: reportRun(d2).reason } }));

  /* ================================================================ 场景 5：推送结果未知 ⇒ 人工处理、绝不重发 */
  runnerMode = 'ok';
  state.pushMode = 'unknown';
  state.now = new Date('2026-09-24T01:05:30+08:00');
  await tick(state.now);
  const d3 = '2026-09-23';
  state.now = new Date('2026-09-24T09:00:20+08:00');
  r = await tick(state.now);
  const pushUnknown = state.pushCalls;
  state.now = new Date('2026-09-24T09:30:00+08:00');
  const r2 = await tick(state.now);
  ck('i10 推送结果未知 → 账本 waiting_human；后续任何 tick **零再次发送**（send_attempts 恒为 1、推送调用不增加）',
    reportRun(d3).status === 'waiting_human' && state.pushCalls === pushUnknown && Number(reportRun(d3).send_attempts) === 1,
    JSON.stringify({ run: reportRun(d3) && reportRun(d3).status, attempts: reportRun(d3).send_attempts, push_now: state.pushCalls, push_then: pushUnknown, calls: r2.calls }));

  /* ================================================================ 场景 6：并发 worker / 崩溃恢复 */
  state.pushMode = 'ok';
  state.now = new Date('2026-09-25T01:05:30+08:00');
  const beforeConc = runner.calls.length;
  const [c1, c2] = await Promise.all([tick(state.now), tick(state.now)]);
  ck('i11 并发两个 worker 同时 tick：**实际执行合计恰好 1 次**（本地锁 + 中控 claim 双保险）',
    runner.calls.length === beforeConc + 1 && (c1.calls.execute + c2.calls.execute) === 1,
    JSON.stringify({ exec: runner.calls.length - beforeConc, c1: c1.calls.execute, c2: c2.calls.execute }));

  // 崩溃恢复：把中控 report 行置为 running + send_attempts=1（模拟"发送中崩溃"），本地状态清空
  const d4 = '2026-09-24';
  runnerMode = 'ok';
  store.claimRun({ job: 'sync', business_date: d4, trigger: 'schedule', worker_id: 'crash' });
  store.settleRun({ job: 'sync', business_date: d4, status: 'success' });
  store.claimRun({ job: 'report', business_date: d4, trigger: 'schedule', worker_id: 'crash' });
  store.beginSend({ job: 'report', business_date: d4 });
  const pushBeforeCrash = state.pushCalls;
  state.now = new Date('2026-09-25T09:00:20+08:00');
  r = await tick(state.now);
  ck('i12 崩溃残留（report=running + 已发送 1 次）后恢复：**零重发**（send_attempts 不增加、推送函数零调用），保持人工处理',
    state.pushCalls === pushBeforeCrash && Number(reportRun(d4).send_attempts) === 1 && r.calls.report_push === 0 &&
    ['running', 'waiting_human'].includes(String(reportRun(d4).status)),
    JSON.stringify({ push: state.pushCalls - pushBeforeCrash, run: reportRun(d4) && { s: reportRun(d4).status, a: reportRun(d4).send_attempts }, calls: r.calls }));

  /* ================================================================ 场景 7：报表 B 与 HMAC */
  const rb = await WORKER.tick({ now: state.now, deps: Object.assign({}, deps, { reportType: 'item_sales_detail' }), workerId: 'it-w2' });
  ck('i13 报表 B（item_sales_detail）：worker 入口即拒绝（report_b_locked），**零 HTTP、零执行**',
    rb.reason === 'report_b_locked' && rb.calls.schedule_read === 0 && rb.calls.execute === 0 && rb.calls.claim === 0,
    JSON.stringify({ reason: rb.reason, calls: rb.calls }));
  function callInternal(p, body) {
    return new Promise((resolve) => {
      const raw = Buffer.from(JSON.stringify(body), 'utf8');
      const ts = String(Date.now());
      const sig = crypto.createHmac('sha256', SECRET).update(ts + '.' + raw.toString('utf8'), 'utf8').digest('hex');
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': raw.length, 'X-Syncbot-Timestamp': ts, 'X-Syncbot-Signature': sig } }, (res) => {
        let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: t ? JSON.parse(t) : null }));
      });
      req.on('error', () => resolve({ status: 0, body: null }));
      req.write(raw); req.end();
    });
  }
  const rbApi = await callInternal('/api/internal/syncbot/schedule/report-push', { business_date: '2026-09-21', confirm: true, report_type: 'item_sales_detail' });
  ck('i14a 带正确 HMAC 签名的内部调用被接受（未签名请求必须被拒）', rbApi.status === 200, JSON.stringify({ status: rbApi.status, body: rbApi.body }));
  ck('i14 报表 B 在内部端点同样被拒（HMAC 通过但业务拒绝）', rbApi.status === 200 && rbApi.body.reason === 'report_b_locked', JSON.stringify(rbApi.body));

  // HMAC 错误：临时换错密钥
  fs.writeFileSync(secretFile, JSON.stringify({ secret: crypto.randomBytes(32).toString('hex'), endpoint: base }), { mode: 0o600 });
  const bad = await tick(state.now);
  fs.writeFileSync(secretFile, JSON.stringify({ secret: SECRET, endpoint: base }), { mode: 0o600 });
  ck('i15 签名错误（密钥不匹配）⇒ 读调度失败 → fail-closed、零 claim/执行/推送（HMAC 真正生效）',
    bad.ok === false && bad.calls.claim === 0 && bad.calls.execute === 0 && bad.calls.report_push === 0 && state.hmacBad > 0,
    JSON.stringify({ reason: bad.reason, calls: bad.calls, hmac_bad: state.hmacBad }));

  /* ================================================================ 场景 8：泄漏与自证 */
  const stateFiles = [];
  const walk = (d) => { let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of e) { const p = path.join(d, x.name); if (x.isDirectory()) walk(p); else stateFiles.push(p); } };
  walk(path.join(ROOT, 'state'));
  const stateText = stateFiles.filter((f) => !/secrets/.test(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const ledgerText = JSON.stringify(db._t);
  const bodiesText = JSON.stringify(state.bodies);
  const LEAK = [/Bearer [A-Za-z0-9._-]{10,}/, /"password"/i, /corpsecret/i, /qyapi\.weixin\.qq\.com/i, /eyJ[A-Za-z0-9_-]{10,}\./,
    /[0-9a-fA-F]{64}/, /[A-Za-z0-9+/]{40,}={0,2}/, /\/(?:home|opt|etc|var|root|usr|tmp)\//, /[A-Za-z]:\\/];
  const leaks = [];
  for (const re of LEAK) {
    if (re.test(stateText)) leaks.push('state:' + String(re));
    if (re.test(ledgerText)) leaks.push('ledger:' + String(re));
    if (re.test(bodiesText)) leaks.push('bodies:' + String(re));
  }
  ck('i16 本地状态 / 中控账本 / 全部 HTTP 请求体：无 JWT、口令、webhook、Cookie、base64、完整 SHA、绝对路径、HMAC 密钥',
    leaks.length === 0, JSON.stringify(leaks.slice(0, 4)));
  ck('i17 本套件自证：进程内 HTTP 桥 + 假 db + 假推送 + 注入式执行器；未访问美团、未真实导出/导入/推送、未建 timer、报表 B 锁定',
    out.real_meituan_run === false && out.real_export === false && out.real_download === false && out.real_import === false &&
    out.real_wecom_message_sent === false && out.real_webhook_read === false && out.timers_created === false && out.report_b === 'locked_not_started' &&
    state.pushCalls === state.pushArgs.length);

  out.push_calls_total = state.pushCalls;
  out.exec_total = runner.calls.length;
  out.hmac = { ok: state.hmacOk, bad: state.hmacBad };
  await new Promise((r2) => server.close(r2));
  out.total = out.checks.length;
  out.failed = out.checks.filter((c) => !c.ok).length;
  out.ok = out.failed === 0;
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
  if (process.env.P3_OUT) { try { fs.writeFileSync(process.env.P3_OUT, JSON.stringify(out, null, 2), 'utf8'); } catch (_) {} }
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
})().catch((e) => {
  const fatal = { ok: false, fatal: String((e && e.stack) || e).slice(0, 900), total: out.checks.length, failed: out.checks.filter((c) => !c.ok).length, checks: out.checks };
  if (process.env.P3_OUT) { try { fs.writeFileSync(process.env.P3_OUT, JSON.stringify(fatal, null, 2), 'utf8'); } catch (_) {} }
  console.log(JSON.stringify(fatal, null, 2));
  process.exit(9);
});
