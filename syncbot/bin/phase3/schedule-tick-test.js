#!/usr/bin/env node
'use strict';
/**
 * 调度 worker（契约角色 D）· **纯离线套件**
 *
 * 边界：worker 侧全部离线 —— 中控用 **127.0.0.1 随机端口 mock**（校验 HMAC、实现 I1–I4、
 * 记录调用次数与请求体）；sync 执行器用 **fake runner**；
 * **不访问美团、不真实导出/下载/导入/发送、不读 webhook、不建 timer/cron**；报表 B 永远锁定。
 *
 * 运行：
 *   $env:SYNCBOT_BOT='F:\NewDeom\_syncbot\stage0'; $env:P3_OUT='...\res-schedule-tick.json';
 *   node app/bin/phase3/schedule-tick-test.js
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p6sched-'));
process.env.SYNCBOT_ROOT = ROOT;

const BOT = process.env.SYNCBOT_BOT || '/opt/zhongkong-sync-bot';
const P = require(BOT + '/app/src/paths.js');
const PLAN = require(BOT + '/app/src/schedule/plan.js');
const SSTATE = require(BOT + '/app/src/schedule/state.js');
const ZK = require(BOT + '/app/src/schedule/zk-client.js');
const WORKER = require(BOT + '/app/src/schedule/worker.js');
const CLI = require(BOT + '/app/bin/schedule-tick.js');

const SECRET = crypto.randomBytes(32).toString('hex');
const SECRET_FILE = path.join(ROOT, 'state', 'secrets', 'audit-hmac.json');
fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true, mode: 0o700 });
fs.writeFileSync(SECRET_FILE, JSON.stringify({ secret: SECRET, endpoint: 'http://127.0.0.1:3456/api/internal/syncbot/events' }), { mode: 0o600 });

const RUN = 'test-sched-' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');
const out = {
  suite: 'schedule-tick-offline', offline: true, fixture: true,
  real_meituan_run: false, real_export: false, real_download: false, real_import: false,
  real_wecom_message_sent: false, real_webhook_read: false, timers_created: false,
  report_b: 'locked_not_started', test_run_id: RUN, checks: [], skips: [],
};
const ck = (n, ok, d) => out.checks.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });
const stripComments = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const readSrc = (rel) => { try { return fs.readFileSync(BOT + '/' + rel, 'utf8'); } catch (e) { return ''; } };

// 日期工具：每个检查用独立日期 ⇒ 本地状态文件互不干扰
const BASE_DAY = Date.UTC(2026, 3, 1);
const D = (off) => new Date(BASE_DAY + off * 86400000).toISOString().slice(0, 10);
const at = (off, time) => D(off) + ' ' + time;

function walkFiles(dir, acc = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, acc); else acc.push(p);
  }
  return acc;
}
function countStateFiles() {
  return walkFiles(path.join(ROOT, 'state', 'schedule')).filter((f) => f.endsWith('.json')).length;
}
function listLockFiles() {
  return walkFiles(path.join(ROOT, 'state', 'locks')).filter((f) => f.endsWith('.lock'));
}

// ------------------------------------------------------------------ mock 中控
const P_SCHEDULE = '/api/internal/syncbot/schedule';
function createMockCenter() {
  const st = {
    secret: SECRET,
    counts: { i1: 0, i2: 0, i3: 0, i4: 0, other: 0, hmac_fail: 0 },
    total: { i1: 0, i2: 0, i3: 0, i4: 0, other: 0, hmac_fail: 0 },
    requests: [], all_requests: [], settles: [], pushes: [], claims: [],
    ledger: new Map(),
    config: { sync_enabled: 0, sync_time: '01:05', report_enabled: 0, report_time: '09:00', version: 1, timezone: 'Asia/Shanghai' },
    claim_mode: 'ok', i4_mode: 'sent', now_local: '2026-04-01 01:05:00',
    injected_i1: null,
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = String(req.url || '').split('?')[0];
      const ts = String(req.headers['x-syncbot-timestamp'] || '');
      const sig = String(req.headers['x-syncbot-signature'] || '');
      const want = crypto.createHmac('sha256', st.secret).update(ts + '.' + raw, 'utf8').digest('hex');
      const hmacOk = /^\d{10,16}$/.test(ts) && sig === want;
      const rec = { method: req.method, path: url, ts, body_raw: raw, hmac_ok: hmacOk, at: new Date().toISOString() };
      let body = null;
      try { body = JSON.parse(raw || '{}'); } catch (e) { body = null; }
      rec.body = body;
      st.requests.push(rec);
      st.all_requests.push(rec);
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (!hmacOk) { st.counts.hmac_fail += 1; st.total.hmac_fail += 1; return json(401, { ok: false, error: 'signature_invalid' }); }

      if (url === P_SCHEDULE && req.method === 'GET') {
        st.counts.i1 += 1; st.total.i1 += 1;
        if (st.injected_i1) return json(200, st.injected_i1);
        return json(200, {
          ok: true, now_local: st.now_local, timezone: 'Asia/Shanghai',
          config: Object.assign({}, st.config), runs: { sync: null, report: null }, pending_manual: [],
        });
      }
      if (url === P_SCHEDULE + '/claim' && req.method === 'POST') {
        st.counts.i2 += 1; st.total.i2 += 1;
        st.claims.push(body);
        if (st.claim_mode === 'timeout') return;                       // 挂住 → 客户端超时
        if (st.claim_mode === 'error500') return json(500, { ok: false, error: 'mock_500' });
        if (st.claim_mode === 'conflict') return json(200, { ok: true, claimed: false, reason: 'in_flight_unknown', run: { job: body.job, business_date: body.business_date, status: 'running' } });
        const key = body.job + ':' + body.business_date;
        const cur = st.ledger.get(key);
        if (!cur) {
          st.ledger.set(key, { job: body.job, business_date: body.business_date, status: 'running', attempt: 1, worker_id: body.worker_id, trigger: body.trigger });
          return json(200, { ok: true, claimed: true, run: { job: body.job, business_date: body.business_date, status: 'running', attempt: 1 } });
        }
        if (cur.status === 'refused') {
          cur.status = 'running'; cur.attempt = (cur.attempt || 0) + 1; cur.worker_id = body.worker_id;
          return json(200, { ok: true, claimed: true, run: Object.assign({}, cur) });
        }
        if (cur.status === 'success') return json(200, { ok: true, claimed: false, reason: 'already_success', run: Object.assign({}, cur) });
        if (cur.status === 'waiting_human' || cur.status === 'failed') return json(200, { ok: true, claimed: false, reason: 'no_active_run_slot', run: Object.assign({}, cur) });
        return json(200, { ok: true, claimed: false, reason: 'in_flight_unknown', run: Object.assign({}, cur) });
      }
      if (url === P_SCHEDULE + '/settle' && req.method === 'POST') {
        st.counts.i3 += 1; st.total.i3 += 1;
        st.settles.push(body);
        if (st.claim_mode === 'timeout') return;
        const key = body.job + ':' + body.business_date;
        const cur = st.ledger.get(key) || { job: body.job, business_date: body.business_date, attempt: 0 };
        cur.status = body.status; cur.reason = body.reason || null; cur.attempt = (cur.attempt || 0) + 1;
        st.ledger.set(key, cur);
        return json(200, { ok: true, run: Object.assign({}, cur) });
      }
      if (url === P_SCHEDULE + '/report-push' && req.method === 'POST') {
        st.counts.i4 += 1; st.total.i4 += 1;
        st.pushes.push(body);
        if (st.i4_mode === 'timeout') return;                          // 超时：不响应
        if (st.i4_mode === 'lost') { try { req.socket.destroy(); } catch (e) {} return; }   // 响应丢失
        if (st.i4_mode === 'error500') return json(500, { ok: false, error: 'mock_500' });
        if (st.i4_mode === 'sync_not_succeeded') return json(200, { ok: true, sent: false, reason: 'sync_not_succeeded', run: null });
        if (st.i4_mode === 'in_flight') return json(200, { ok: true, sent: false, reason: 'push_in_flight_unknown', run: { job: 'report', business_date: body.business_date, status: 'running' } });
        if (st.i4_mode === 'already_pushed') return json(200, { ok: true, sent: false, reason: 'already_pushed', run: { job: 'report', business_date: body.business_date, status: 'success' } });
        return json(200, { ok: true, sent: true, pushed: 22, push_log_ids: [9001, 9002], run: { job: 'report', business_date: body.business_date, status: 'success', send_attempts: 1 } });
      }
      st.counts.other += 1; st.total.other += 1;
      return json(404, { ok: false, error: 'not_found' });
    });
  });
  return {
    server, state: st,
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      this.baseUrl = 'http://127.0.0.1:' + server.address().port;
      return this;
    },
    async stop() {
      try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch (e) {}
      await new Promise((r) => server.close(r));
    },
    reset() { st.counts = { i1: 0, i2: 0, i3: 0, i4: 0, other: 0, hmac_fail: 0 }; st.requests = []; st.settles = []; st.pushes = []; st.claims = []; },
    config(c) { Object.assign(st.config, c); },
    claimedKeys() { return Array.from(st.ledger.keys()); },
  };
}
let MOCK = null;
const mkZk = (over = {}) => ZK.createZkClient(Object.assign({ base: MOCK.baseUrl, timeoutMs: 400, allowTestBase: true }, over));
const ENV = {};
const OUTPUTS = [];   // 全部 tick 结果（泄漏扫描用）
async function tickAt(local, deps = {}) {
  const res = await WORKER.tick({ now: local, deps: Object.assign({ zk: mkZk(), env: ENV }, deps), workerId: deps.workerId || 'test-worker' });
  try { OUTPUTS.push(JSON.stringify(res)); } catch (e) {}
  return res;
}

// ------------------------------------------------------------------ fake sync runner（data-only 测试替身，绝不发送）
function makeRunner(mode = 'ok') {
  const rec = { calls: 0, args: [] };
  const runner = {
    report_type: 'cashier_composite', data_only: true, test_double: true, source: 'test-double(no-network)',
    async runOnce(args) {
      rec.calls += 1;
      rec.args.push({ businessDate: args.businessDate, reportType: args.reportType, workerId: args.workerId, idempotencyKey: args.idempotencyKey });
      if (mode === 'timeout') return new Promise(() => {});
      if (mode === 'throw') throw Object.assign(new Error('mock runner boom at F:\\secret\\x.js'), { code: 'EFAKE' });
      if (mode === 'ok') return { ok: true, action: 'COMPLETED', reason: null, stage_calls: { download: 1, import: 1 }, push_calls: 0, side_effects: true };
      if (mode === 'download_failed') return { ok: false, action: 'WAITING_HUMAN', reason: 'download_failed', stage_calls: { download: 0, import: 0 }, push_calls: 0, side_effects: false };
      if (mode === 'import_failed') return { ok: false, action: 'WAITING_HUMAN', reason: 'import_failed', stage_calls: { download: 1, import: 1 }, push_calls: 0, side_effects: true };
      if (mode === 'g3_hit') return { ok: false, action: 'WAITING_HUMAN', reason: 'g3_coverage_gate_hit', stage_calls: { download: 1, import: 0 }, push_calls: 0, side_effects: true };
      if (mode === 'pushed') return { ok: true, action: 'COMPLETED', stage_calls: { download: 1, import: 1 }, push_calls: 1, side_effects: true };
      return { ok: false, action: 'WAITING_HUMAN', reason: 'unknown_mode', side_effects: true, push_calls: 0 };
    },
  };
  return { runner, rec };
}
const CFG_ON_BOTH = { sync_enabled: 1, sync_time: '01:05', report_enabled: 1, report_time: '09:00', version: 3 };

(async () => {
  MOCK = await createMockCenter().start();

  // ============================================================ R3 强化（**最先执行**：此刻本地 state 目录必须仍是空的）
  {
    const off = 5;
    const before = countStateFiles();
    const scheduleDir = path.join(ROOT, 'state', 'schedule');
    MOCK.reset(); MOCK.config({ sync_enabled: 0, report_enabled: 0, sync_time: '01:05', report_time: '09:00' });
    const res = await tickAt(at(off, '12:00:00'), { syncRunner: makeRunner('ok').runner });
    ck('r3d【强化】两个作业都 disabled：tick 只允许 I1 读取 —— **i2/i3/i4 调用次数必须为 0**，且本地 state/schedule 目录**零文件**（不建目录、不写状态、不落锁）',
      before === 0 && countStateFiles() === 0 && !fs.existsSync(scheduleDir) &&
      MOCK.state.counts.i1 === 1 && MOCK.state.counts.i2 === 0 && MOCK.state.counts.i3 === 0 && MOCK.state.counts.i4 === 0 &&
      MOCK.state.counts.other === 0 && listLockFiles().length === 0 && res.exit_code === 0,
      JSON.stringify({ counts: MOCK.state.counts, state_files: countStateFiles(), schedule_dir_exists: fs.existsSync(scheduleDir), locks: listLockFiles().length }));
  }

  // ============================================================ R1 两个时间分别生效
  {
    const off = 10;
    const bd = D(off - 1);
    MOCK.reset(); MOCK.config(CFG_ON_BOTH);
    const r1 = makeRunner('ok');
    const res = await tickAt(at(off, '01:05:00'), { syncRunner: r1.runner });
    const s = res.jobs.sync; const rp = res.jobs.report;
    ck('r1a 01:05 到点「只跑 sync」：sync 到期并成功执行一次（I2/I3 各 1、runner 1 次），report 未到期 ⇒ I4 调用 0、report 无本地状态文件',
      s.due === true && s.action === 'success' && r1.rec.calls === 1 && MOCK.state.counts.i2 === 1 && MOCK.state.counts.i3 === 1 &&
      rp.due === false && rp.due_reason === 'before_scheduled_time' && rp.action === 'not_due' && MOCK.state.counts.i4 === 0 &&
      SSTATE.exists('sync', bd) === true && SSTATE.exists('report', bd) === false,
      JSON.stringify({ sync: { due: s.due, action: s.action, reason: s.reason }, report: { due: rp.due, action: rp.action }, i2: MOCK.state.counts.i2, i3: MOCK.state.counts.i3, i4: MOCK.state.counts.i4 }));
    ck('r1a-2 业务日期 = 今天-1，幂等键 = sync:<今天-1>，runner 收到的 report_type 恒为 cashier_composite',
      s.business_date === bd && s.idempotency_key === 'sync:' + bd && r1.rec.args[0].reportType === 'cashier_composite' && r1.rec.args[0].businessDate === bd,
      JSON.stringify({ business_date: s.business_date, key: s.idempotency_key, runner_args: r1.rec.args[0] }));

    MOCK.reset();
    const res2 = await tickAt(at(off, '09:00:00'), { syncRunner: r1.runner });
    ck('r1b 同一日期 09:00 到点「只跑 report」：sync 已是本地终态 ⇒ 0 claim/0 执行；report 走 I4 恰好 1 次并成功',
      res2.jobs.sync.action === 'skipped_terminal' && res2.jobs.sync.status === 'success' && r1.rec.calls === 1 &&
      MOCK.state.counts.i2 === 0 && MOCK.state.counts.i3 === 0 && MOCK.state.counts.i4 === 1 &&
      res2.jobs.report.action === 'success' && res2.jobs.report.due === true && SSTATE.read('report', bd).status === 'success',
      JSON.stringify({ sync: res2.jobs.sync.action, runner_calls: r1.rec.calls, i2: MOCK.state.counts.i2, i4: MOCK.state.counts.i4, report: res2.jobs.report.action }));
    ck('r1b-2 I4 请求体：{business_date, worker_id, confirm:true}（worker 自己不发送、不渲染、不读 webhook）',
      MOCK.state.pushes.length === 1 && MOCK.state.pushes[0].confirm === true && MOCK.state.pushes[0].business_date === bd &&
      JSON.stringify(Object.keys(MOCK.state.pushes[0]).sort()) === JSON.stringify(['business_date', 'confirm', 'worker_id']),
      JSON.stringify(MOCK.state.pushes[0]));
  }

  // ============================================================ R2 配置改时只影响下一次（不补跑）
  {
    const off = 12;
    const bd = D(off - 1);
    const r2 = makeRunner('ok');
    MOCK.reset(); MOCK.config({ sync_enabled: 1, sync_time: '03:00', report_enabled: 0, report_time: '09:00', version: 4 });
    const a = await tickAt(at(off, '01:10:00'), { syncRunner: r2.runner });
    const noState1 = !SSTATE.exists('sync', bd);
    MOCK.config({ sync_time: '02:00', version: 5 });
    const b = await tickAt(at(off, '01:30:00'), { syncRunner: r2.runner });
    ck('r2a 改时刻只影响下一次：03:00 时 01:10 不触发、改成 02:00 后 01:30 仍不触发（0 claim / 0 执行 / 0 状态文件）',
      a.jobs.sync.due === false && a.jobs.sync.due_reason === 'before_scheduled_time' && b.jobs.sync.due === false &&
      r2.rec.calls === 0 && MOCK.state.counts.i2 === 0 && noState1 && !SSTATE.exists('sync', bd),
      JSON.stringify({ a: a.jobs.sync.due_reason, b: b.jobs.sync.due_reason, calls: r2.rec.calls, i2: MOCK.state.counts.i2 }));
    const c = await tickAt(at(off, '02:05:00'), { syncRunner: r2.runner });
    const d = await tickAt(at(off, '02:30:00'), { syncRunner: r2.runner });
    ck('r2b 到点后（02:05）才执行一次；此后同一日期重复 tick 不再重复执行（旧时刻不会再触发第二次）',
      c.jobs.sync.action === 'success' && c.jobs.sync.scheduled_moment === D(off) + ' 02:00:00' && r2.rec.calls === 1 &&
      d.jobs.sync.action === 'skipped_terminal' && d.jobs.sync.calls.claim === 0 && r2.rec.calls === 1,
      JSON.stringify({ first: c.jobs.sync.action, moment: c.jobs.sync.scheduled_moment, calls: r2.rec.calls, second: d.jobs.sync.action }));

    const off2 = 16;
    const r2b = makeRunner('ok');
    MOCK.reset(); MOCK.config({ sync_enabled: 1, sync_time: '01:05', report_enabled: 0, report_time: '09:00' });
    const e = await tickAt(at(off2 + 1, '00:30:00'), { syncRunner: r2b.runner });
    ck('r2c 跨天停机恢复不补跑：次日 00:30（未到 01:05）不触发，昨天的计划时刻不会被补跑',
      e.jobs.sync.due === false && e.jobs.sync.due_reason === 'before_scheduled_time' && r2b.rec.calls === 0 && MOCK.state.counts.i2 === 0,
      JSON.stringify({ reason: e.jobs.sync.due_reason, calls: r2b.rec.calls }));
    MOCK.reset();
    const f = await tickAt(at(off2 + 1, '01:06:00'), { syncRunner: r2b.runner });
    const keys = MOCK.claimedKeys();
    ck('r2c-2 恢复后只处理「今天-1」这一个业务日期：只 claim sync:' + D(off2) + '，绝不出现被跳过的 sync:' + D(off2 - 1),
      f.jobs.sync.business_date === D(off2) && keys.indexOf('sync:' + D(off2)) >= 0 && keys.indexOf('sync:' + D(off2 - 1)) < 0 &&
      !SSTATE.exists('sync', D(off2 - 1)),
      JSON.stringify({ claimed: keys, business_date: f.jobs.sync.business_date }));
  }

  // ============================================================ R3 disabled ⇒ 零调用
  {
    const off = 20;
    const bd = D(off - 1);
    MOCK.reset(); MOCK.config({ sync_enabled: 0, report_enabled: 0 });
    const before = countStateFiles();
    const r3 = await tickAt(at(off, '12:00:00'), { syncRunner: makeRunner('ok').runner });
    ck('r3a 两个作业都 disabled：HTTP 只有 I1 读取，claim/settle/push 全为 0；不建任何本地状态文件、不留任何锁',
      MOCK.state.counts.i1 === 1 && MOCK.state.counts.i2 === 0 && MOCK.state.counts.i3 === 0 && MOCK.state.counts.i4 === 0 &&
      MOCK.state.counts.other === 0 && countStateFiles() === before && listLockFiles().length === 0 &&
      r3.jobs.sync.due_reason === 'job_disabled' && r3.jobs.report.due_reason === 'job_disabled' && r3.exit_code === 0,
      JSON.stringify({ counts: MOCK.state.counts, state_files: countStateFiles(), locks: listLockFiles().length }));

    const off2 = 21;
    MOCK.reset(); MOCK.config({ sync_enabled: 0, sync_time: '01:05', report_enabled: 1, report_time: '09:00' });
    const r3b = await tickAt(at(off2, '12:00:00'), { syncRunner: makeRunner('ok').runner });
    ck('r3b 只有 sync disabled：sync 零调用（0 claim / 0 执行 / 0 状态文件），report 照常只走 I4 一次',
      r3b.jobs.sync.due === false && r3b.jobs.sync.due_reason === 'job_disabled' && MOCK.state.counts.i2 === 0 &&
      MOCK.state.counts.i3 === 0 && !SSTATE.exists('sync', D(off2 - 1)) && MOCK.state.counts.i4 === 1 &&
      r3b.jobs.report.action === 'success',
      JSON.stringify({ sync: r3b.jobs.sync.due_reason, i2: MOCK.state.counts.i2, i4: MOCK.state.counts.i4 }));

    const off3 = 22;
    const r3c = makeRunner('ok');
    MOCK.reset(); MOCK.config({ sync_enabled: 1, sync_time: '01:05', report_enabled: 0, report_time: '09:00' });
    const res = await tickAt(at(off3, '12:00:00'), { syncRunner: r3c.runner });
    ck('r3c 只有 report disabled：I4 调用 0、report 无本地状态文件；sync 照常执行一次',
      MOCK.state.counts.i4 === 0 && res.jobs.report.due === false && res.jobs.report.due_reason === 'job_disabled' &&
      !SSTATE.exists('report', D(off3 - 1)) && res.jobs.sync.action === 'success' && r3c.rec.calls === 1,
      JSON.stringify({ i4: MOCK.state.counts.i4, report: res.jobs.report.due_reason, sync: res.jobs.sync.action }));
  }

  // ============================================================ R4 同步成功但未到日报时间 ⇒ 零推送
  {
    const off = 25;
    const bd = D(off - 1);
    const r4 = makeRunner('ok');
    MOCK.reset(); MOCK.config(CFG_ON_BOTH);
    const res = await tickAt(at(off, '01:10:00'), { syncRunner: r4.runner });
    ck('r4 同步成功（01:10）但未到 09:00 ⇒ **I4 调用次数 0**、report 无本地状态文件、无任何推送请求体',
      res.jobs.sync.action === 'success' && MOCK.state.counts.i4 === 0 && MOCK.state.pushes.length === 0 &&
      !SSTATE.exists('report', bd) && res.jobs.report.due === false,
      JSON.stringify({ sync: res.jobs.sync.action, i4: MOCK.state.counts.i4, report_exists: SSTATE.exists('report', bd) }));
    const recorded = SSTATE.read('report', bd);
    ck('r4b【强化】同步成功后但**未到日报时间**：i4 调用次数**必须为 0**，且本地 recorded 状态里 report **未执行**（无状态文件、无 running/终态记录），sync 侧则已落 success',
      MOCK.state.counts.i4 === 0 && MOCK.state.pushes.length === 0 && recorded === null &&
      SSTATE.statusOf('report', bd).exists === false && res.jobs.report.action === 'not_due' &&
      SSTATE.read('sync', bd).status === 'success',
      JSON.stringify({ i4: MOCK.state.counts.i4, pushes: MOCK.state.pushes.length, report_record: recorded, report_action: res.jobs.report.action, sync_record: SSTATE.read('sync', bd).status }));
  }

  // ============================================================ R5 同步失败/导入失败/G3 命中 ⇒ 零推送
  {
    const cases = [
      ['r5a', 'download_failed', 27, 'refused', 'download_failed'],
      ['r5b', 'import_failed', 29, 'waiting_human', 'import_failed'],
      ['r5c', 'g3_hit', 31, 'waiting_human', 'g3_coverage_gate_hit'],
    ];
    for (const [tag, mode, off, wantStatus, wantReason] of cases) {
      const runner = makeRunner(mode);
      MOCK.reset(); MOCK.config(CFG_ON_BOTH);
      const res = await tickAt(at(off, '01:10:00'), { syncRunner: runner.runner });
      ck(tag + ' 同步执行失败（' + mode + '）⇒ 落 ' + wantStatus + '、同步动作只发生 1 次、**I4 调用 0**（零推送）；report 无状态文件',
        res.jobs.sync.status === wantStatus && res.jobs.sync.reason === wantReason && runner.rec.calls === 1 &&
        MOCK.state.counts.i4 === 0 && MOCK.state.pushes.length === 0 && !SSTATE.exists('report', D(off - 1)) &&
        MOCK.state.settles.length === 1 && MOCK.state.settles[0].status === wantStatus,
        JSON.stringify({ status: res.jobs.sync.status, reason: res.jobs.sync.reason, settle: MOCK.state.settles[0], i4: MOCK.state.counts.i4 }));
    }
    // 同一 tick 内两个作业都到期且 sync 失败 ⇒ 仍零推送
    const off = 33;
    const runner = makeRunner('import_failed');
    MOCK.reset(); MOCK.config(CFG_ON_BOTH);
    const res = await tickAt(at(off, '09:30:00'), { syncRunner: runner.runner });
    ck('r5d 同一次 tick 内 sync（01:05，补跑）与 report（09:00）都到期且 sync 失败 ⇒ report 拒绝（sync_not_succeeded）、**I4 仍为 0**',
      res.jobs.sync.due === true && res.jobs.report.due === true && res.jobs.sync.status === 'waiting_human' &&
      res.jobs.report.action === 'refused' && res.jobs.report.reason === 'sync_not_succeeded' && MOCK.state.counts.i4 === 0,
      JSON.stringify({ sync: res.jobs.sync.status, report: res.jobs.report, i4: MOCK.state.counts.i4 }));
  }

  // ============================================================ R6 重复 tick / 重启恢复 / 并发 ⇒ 零重复动作
  {
    const off = 35;
    const bd = D(off - 1);
    const r6 = makeRunner('ok');
    MOCK.reset(); MOCK.config(CFG_ON_BOTH);
    const a = await tickAt(at(off, '01:10:00'), { syncRunner: r6.runner });
    MOCK.reset();
    const b = await tickAt(at(off, '01:20:00'), { syncRunner: r6.runner });
    const c = await tickAt(at(off, '09:00:00'), { syncRunner: r6.runner });
    MOCK.reset();
    const d = await tickAt(at(off, '09:30:00'), { syncRunner: r6.runner });
    ck('r6a 同一日期重复 tick：第 2 次 sync 0 claim/0 执行、第 2 次 report 0 次 I4（总计 runner 1 次、I4 1 次）',
      a.jobs.sync.action === 'success' && b.jobs.sync.action === 'skipped_terminal' && b.jobs.sync.calls.claim === 0 &&
      c.jobs.report.action === 'success' && d.jobs.report.action === 'skipped_terminal' && d.jobs.report.calls.report_push === 0 &&
      r6.rec.calls === 1 && MOCK.state.counts.i4 === 0,
      JSON.stringify({ sync1: a.jobs.sync.action, sync2: b.jobs.sync.action, report1: c.jobs.report.action, report2: d.jobs.report.action, runner: r6.rec.calls }));

    // 崩溃残留 running ⇒ 只能标记 waiting_human
    const off2 = 37;
    const bd2 = D(off2 - 1);
    SSTATE.write('sync', bd2, { status: 'running', attempt: 1, worker_id: 'crashed-worker' });
    SSTATE.write('report', bd2, { status: 'running', attempt: 1, worker_id: 'crashed-worker' });
    const r6b = makeRunner('ok');
    MOCK.reset(); MOCK.config(CFG_ON_BOTH);
    const e = await tickAt(at(off2, '09:10:00'), { syncRunner: r6b.runner });
    const eSettle = MOCK.state.settles.slice();
    MOCK.reset();
    const f = await tickAt(at(off2, '09:20:00'), { syncRunner: r6b.runner });
    ck('r6b 崩溃残留 running：sync 只能被标记 waiting_human（0 claim / 0 执行，settle 1 次 waiting_human），report 同样转人工且 **I4 = 0**；再 tick 一次零动作',
      e.jobs.sync.action === 'recovered_running' && e.jobs.sync.status === 'waiting_human' && e.jobs.sync.calls.claim === 0 &&
      e.jobs.sync.calls.execute === 0 && r6b.rec.calls === 0 && eSettle.length === 1 && eSettle[0].status === 'waiting_human' &&
      e.jobs.report.action === 'recovered_running' && e.jobs.report.status === 'waiting_human' && eSettle.length === 1 &&
      SSTATE.read('sync', bd2).status === 'waiting_human' && SSTATE.read('report', bd2).status === 'waiting_human' &&
      f.jobs.sync.action === 'skipped_terminal' && f.jobs.report.action === 'skipped_terminal' && f.jobs.sync.calls.claim === 0,
      JSON.stringify({ e: { sync: e.jobs.sync.action, report: e.jobs.report.action }, settles: eSettle.map((x) => x.status), i4: MOCK.state.counts.i4 }));

    // 并发 worker：中控 claim 竞争失败 ⇒ 零重复动作
    const off3 = 39;
    const bd3 = D(off3 - 1);
    const r6c = makeRunner('ok');
    MOCK.reset(); MOCK.config(CFG_ON_BOTH); MOCK.state.claim_mode = 'conflict';
    const g = await tickAt(at(off3, '01:10:00'), { syncRunner: r6c.runner, workerId: 'worker-b' });
    MOCK.state.claim_mode = 'ok';
    ck('r6c 并发 worker：中控 claim 竞争返回 claimed:false（in_flight_unknown）⇒ **0 执行**、0 settle、本地 waiting_human（不重抢、不重做）',
      g.jobs.sync.action === 'waiting_human' && g.jobs.sync.reason === 'in_flight_unknown' && r6c.rec.calls === 0 &&
      MOCK.state.counts.i3 === 0 && g.jobs.sync.calls.execute === 0 && SSTATE.read('sync', bd3).status === 'waiting_human',
      JSON.stringify({ action: g.jobs.sync.action, reason: g.jobs.sync.reason, runner: r6c.rec.calls, i3: MOCK.state.counts.i3 }));

    // 真实竞态：worker A 已成功 ⇒ worker B 同日期再来只能 already_success（合计只执行 1 次）
    const off4 = 41;
    const r6d = makeRunner('ok');
    MOCK.reset(); MOCK.config(CFG_ON_BOTH);
    const h1 = await tickAt(at(off4, '01:10:00'), { syncRunner: r6d.runner, workerId: 'worker-a' });
    // worker-b 是"另一台机器/另一个 worker"：本地状态互不可见，只能靠中控账本仲裁
    try { fs.rmSync(SSTATE.stateFile('sync', D(off4 - 1)), { force: true }); } catch (e) {}
    const h2 = await tickAt(at(off4, '01:11:00'), { syncRunner: r6d.runner, workerId: 'worker-b' });
    ck('r6d 真实竞态（同日期两个 worker）：**合计实际执行恰好 1 次**，第二个 worker 未执行（跳过/终态之一，不断言具体理由码）',
      h1.jobs.sync.action === 'success' && r6d.rec.calls === 1 &&
      ['skipped_terminal', 'success'].indexOf(String(h2.jobs.sync.action)) >= 0 && h2.jobs.sync.calls.execute === 0,
      JSON.stringify({ w1: h1.jobs.sync.action, w2: h2.jobs.sync.action, w2_reason: h2.jobs.sync.reason, executions_total: r6d.rec.calls }));

    // 有界重试：refused（无副作用）当天最多 3 次，第 4 次不再执行
    const off5 = 43;
    const r6e = makeRunner('download_failed');
    MOCK.reset(); MOCK.config(CFG_ON_BOTH);
    const t1 = await tickAt(at(off5, '01:10:00'), { syncRunner: r6e.runner });
    const t2 = await tickAt(at(off5, '01:20:00'), { syncRunner: r6e.runner });
    const t3 = await tickAt(at(off5, '01:30:00'), { syncRunner: r6e.runner });
    MOCK.reset();
    const t4 = await tickAt(at(off5, '01:40:00'), { syncRunner: r6e.runner });
    ck('r6e 无副作用拒绝（refused）当天最多重试 3 次：前 3 次执行、第 4 次 attempt_limit_reached（0 claim / 0 执行），且全程 I4 = 0',
      t1.jobs.sync.status === 'refused' && t2.jobs.sync.status === 'refused' && t3.jobs.sync.status === 'refused' &&
      r6e.rec.calls === 3 && t4.jobs.sync.action === 'refused' && t4.jobs.sync.reason === 'attempt_limit_reached' &&
      t4.jobs.sync.calls.claim === 0 && MOCK.state.counts.i2 === 0,
      JSON.stringify({ calls: r6e.rec.calls, t4: t4.jobs.sync.reason, t4_claim: t4.jobs.sync.calls.claim }));
  }

  // ============================================================ R7 I4 超时/响应丢失 ⇒ waiting_human，零自动重发
  {
    const cases = [['r7a', 'timeout', 'push_timeout_unknown'], ['r7b', 'lost', 'push_in_flight_unknown'], ['r7c', 'in_flight', 'push_in_flight_unknown']];
    let off = 50;
    for (const [tag, mode, wantReason] of cases) {
      const bd = D(off - 1);
      MOCK.reset(); MOCK.config({ sync_enabled: 0, report_enabled: 1, report_time: '09:00' });
      MOCK.state.i4_mode = mode;
      const a = await tickAt(at(off, '09:00:00'));
      const afterFirst = MOCK.state.counts.i4;
      MOCK.reset(); MOCK.state.i4_mode = mode;
      const b = await tickAt(at(off, '09:30:00'));
      ck(tag + ' I4 ' + (mode === 'timeout' ? '超时' : mode === 'lost' ? '响应丢失' : '返回 push_in_flight_unknown') +
        ' ⇒ waiting_human、**I4 只发 1 次**；后续 tick 也不再调用 I4（零自动重发），且 worker 不回写 settle（report 的 settle 归 I4）',
        a.jobs.report.status === 'waiting_human' && a.jobs.report.reason === wantReason && afterFirst === 1 &&
        b.jobs.report.action === 'skipped_terminal' && MOCK.state.counts.i4 === 0 && MOCK.state.counts.i3 === 0 &&
        SSTATE.read('report', bd).status === 'waiting_human',
        JSON.stringify({ first: a.jobs.report, i4_first: afterFirst, second: b.jobs.report.action, i4_second: MOCK.state.counts.i4 }));
      off += 2;
    }
    MOCK.state.i4_mode = 'sent';
  }

  // ============================================================ R9 报表 B 一律拒绝
  {
    const off = 60;
    MOCK.reset(); MOCK.config(CFG_ON_BOTH);
    const a = await tickAt(at(off, '12:00:00'), { reportType: 'item_sales_detail', syncRunner: makeRunner('ok').runner });
    ck('r9a 入口出现报表 B（deps.reportType=item_sales_detail）⇒ report_b_locked、exit 3，且**连 I1 都不发**（零 HTTP）',
      a.reason === 'report_b_locked' && a.report_b_locked === true && a.exit_code === 3 &&
      MOCK.state.counts.i1 === 0 && MOCK.state.counts.i2 === 0 && MOCK.state.counts.i3 === 0 && MOCK.state.counts.i4 === 0,
      JSON.stringify({ reason: a.reason, counts: MOCK.state.counts }));

    MOCK.reset();
    MOCK.state.injected_i1 = { ok: true, now_local: '2026-04-01 12:00:00', timezone: 'Asia/Shanghai', config: Object.assign({}, CFG_ON_BOTH, { report_type: 'item_sales_detail' }), runs: {}, pending_manual: [] };
    const b = await tickAt(at(off + 1, '12:00:00'), { syncRunner: makeRunner('ok').runner });
    MOCK.state.injected_i1 = null;
    ck('r9b I1 内容出现报表 B ⇒ 立即 report_b_locked（I1 之后零 claim/零执行/零推送）',
      b.reason === 'report_b_locked' && b.exit_code === 3 && MOCK.state.counts.i1 === 1 &&
      MOCK.state.counts.i2 === 0 && MOCK.state.counts.i3 === 0 && MOCK.state.counts.i4 === 0,
      JSON.stringify({ reason: b.reason, counts: MOCK.state.counts }));

    MOCK.reset(); MOCK.config(CFG_ON_BOTH);
    const badRunner = { report_type: 'item_sales_detail', data_only: true, runOnce: async () => ({ ok: true }) };
    const c = await tickAt(at(off + 2, '01:10:00'), { syncRunner: badRunner });
    ck('r9c sync 执行器声明报表 B ⇒ 拒绝（report_b_locked）且**零副作用**：0 claim / 0 执行 / 0 状态文件',
      c.jobs.sync.action === 'refused' && c.jobs.sync.reason === 'report_b_locked' && c.exit_code === 3 &&
      MOCK.state.counts.i2 === 0 && !SSTATE.exists('sync', D(off + 1)),
      JSON.stringify({ job: c.jobs.sync, i2: MOCK.state.counts.i2 }));

    let planThrew = false; let stateThrew = false;
    try { PLAN.idempotencyKey('item_sales_detail', '2026-04-01'); } catch (e) { planThrew = true; }
    try { SSTATE.stateFile('item_sales_detail', '2026-04-01'); } catch (e) { stateThrew = true; }
    ck('r9d plan/state 层同样拒绝报表 B（幂等键与本地状态路径都不得为 item_sales_detail 生成）',
      planThrew && stateThrew && walkFiles(path.join(ROOT, 'state', 'schedule')).every((f) => f.indexOf('item_sales_detail') < 0),
      JSON.stringify({ plan_threw: planThrew, state_threw: stateThrew }));
  }

  // ============================================================ sync 执行器缺失 / data-only 守卫
  {
    const off = 66;
    const bd = D(off - 1);
    MOCK.reset(); MOCK.config(CFG_ON_BOTH);
    const before = countStateFiles();
    const a = await tickAt(at(off, '01:10:00'), {});   // 不注入 runner、env 也未指定
    ck('r8a 未提供 sync 执行器 ⇒ sync_runner_missing 拒绝、exit 3，且**零副作用**：不建状态文件、不写锁、不发任何 HTTP（仅 I1 只读）',
      a.jobs.sync.action === 'refused' && a.jobs.sync.reason === 'sync_runner_missing' && a.jobs.sync.cause === 'env_not_set' &&
      a.exit_code === 3 && MOCK.state.counts.i1 === 1 && MOCK.state.counts.i2 === 0 && MOCK.state.counts.i3 === 0 &&
      MOCK.state.counts.i4 === 0 && countStateFiles() === before && listLockFiles().length === 0 && !SSTATE.exists('sync', bd),
      JSON.stringify({ job: a.jobs.sync, counts: MOCK.state.counts, state_files: countStateFiles(), locks: listLockFiles().length }));

    const undeclared = { runOnce: async () => ({ ok: true, side_effects: true, push_calls: 0 }) };
    const b = await tickAt(at(off, '01:20:00'), { syncRunner: undeclared });
    ck('r8b 执行器未声明 data-only（未声明只调用 data-only workflow）⇒ fail-closed 拒绝，零 claim / 零执行',
      b.jobs.sync.action === 'refused' && b.jobs.sync.reason === 'sync_runner_missing' && b.jobs.sync.cause === 'sync_runner_invalid' &&
      MOCK.state.counts.i2 === 0,
      JSON.stringify(b.jobs.sync));

    MOCK.reset();
    const rb = { report_type: 'cashier_composite', data_only: true, runOnce: async () => ({ ok: true, push_calls: 1, side_effects: true }) };
    const c = await tickAt(at(off, '01:30:00'), { syncRunner: rb });
    ck('r8c data-only 守卫：执行器结果里出现任何推送痕迹（push_calls=1）⇒ 判 waiting_human（sync_runner_push_forbidden），绝不当作成功',
      c.jobs.sync.status === 'waiting_human' && c.jobs.sync.reason === 'sync_runner_push_forbidden' && c.exit_code === 3,
      JSON.stringify(c.jobs.sync));

    const rThrow = makeRunner('throw');
    MOCK.reset(); MOCK.config(CFG_ON_BOTH);
    const d = await tickAt(at(off + 1, '01:10:00'), { syncRunner: rThrow.runner });
    ck('r8d 执行器抛异常（结果未知）⇒ waiting_human（绝不自动重做），且错误文本已脱敏（无绝对路径）',
      d.jobs.sync.status === 'waiting_human' && d.jobs.sync.reason === 'sync_runner_threw' &&
      JSON.stringify(d).indexOf('secret') < 0 && d.exit_code === 3,
      JSON.stringify({ job: d.jobs.sync, has_secret_word: JSON.stringify(d).indexOf('secret') >= 0 }));

    // 生产路径：内置 data-only workflow runner（未显式启用生产适配器 ⇒ fail-closed，零副作用）
    const builtin = WORKER.createWorkflowRunSyncRunner({ deps: {}, env: {} });
    const br = await builtin.runOnce({ businessDate: '2026-04-01', workerId: 'w', idempotencyKey: 'sync:2026-04-01' });
    ck('r8e 内置 runner 声明 data_only + report_type=cashier_composite；未显式启用生产适配器时 fail-closed（production_adapters_not_enabled，零副作用、零推送）',
      builtin.data_only === true && builtin.report_type === 'cashier_composite' && br.ok === false &&
      br.reason === 'production_adapters_not_enabled' && br.side_effects === false && br.push_calls === 0 &&
      !fs.existsSync(path.join(ROOT, 'downloads')),
      JSON.stringify({ reason: br.reason, side_effects: br.side_effects }));

    const off2 = 68;
    MOCK.reset(); MOCK.config(CFG_ON_BOTH);
    const e = await WORKER.tick({ now: at(off2, '01:10:00'), deps: { zk: mkZk(), env: { SYNCBOT_SCHEDULE_SYNC_RUNNER: 'builtin-data-only' } }, workerId: 'test-builtin' });
    try { OUTPUTS.push(JSON.stringify(e)); } catch (e2) {}
    ck('r8f 通过 env SYNCBOT_SCHEDULE_SYNC_RUNNER=builtin-data-only 走完整生产路径：claim→执行（内置 data-only workflow）→settle，适配器未启用 ⇒ refused 且零推送',
      e.jobs.sync.action === 'refused' && e.jobs.sync.reason === 'production_adapters_not_enabled' &&
      MOCK.state.counts.i2 === 1 && MOCK.state.counts.i3 === 1 && MOCK.state.counts.i4 === 0 &&
      MOCK.state.settles.length === 1 && MOCK.state.settles[0].status === 'refused',
      JSON.stringify({ job: e.jobs.sync, counts: MOCK.state.counts }));
  }

  // ============================================================ CLI 行为（同一代码路径，不 spawn 子进程）
  {
    const logs = [];
    const collect = (s) => logs.push(String(s));
    const off = 70;
    MOCK.reset(); MOCK.config(CFG_ON_BOTH);
    const rCli = makeRunner('ok');
    const deps = { zk: mkZk(), syncRunner: rCli.runner };
    const bad = await CLI.runCli(['--bogus-flag'], { env: ENV, deps, out: collect });
    const conflict = await CLI.runCli(['--once', '--dry-run'], { env: ENV, deps, out: collect });
    const intervalBad = await CLI.runCli(['--loop', '--interval=0'], { env: ENV, deps, out: collect });
    const nowBad = await CLI.runCli(['--once', '--now=2026-04-01 01:10:00'], { env: ENV, deps, out: collect });
    ck('cli1 参数校验：未知参数 / 互斥模式 / 非法 interval / --now 未搭配只读模式 ⇒ 一律 exit 2，且不触发任何作业',
      bad.exitCode === 2 && conflict.exitCode === 2 && intervalBad.exitCode === 2 && nowBad.exitCode === 2 &&
      MOCK.state.counts.i1 === 0 && MOCK.state.counts.i2 === 0 && rCli.rec.calls === 0,
      JSON.stringify({ bad: bad.exitCode, conflict: conflict.exitCode, interval: intervalBad.exitCode, now: nowBad.exitCode }));

    const loop = await CLI.runCli(['--loop'], { env: ENV, deps, out: collect });
    ck('cli2 --loop 本轮不启用：无 SYNCBOT_SCHEDULE_LOOP_ENABLED=1 时 exit 3（loop_disabled），不进入循环、不建 timer',
      loop.exitCode === 3 && loop.payload && loop.payload.reason === 'loop_disabled' && MOCK.state.counts.i1 === 0,
      JSON.stringify(loop.payload));

    const before = countStateFiles();
    const dry = await CLI.runCli(['--dry-run', '--now=2026-04-01 01:10:00'], { env: ENV, deps, out: collect });
    ck('cli3 --dry-run：只计算到期，**不 claim、不执行、不写任何状态**（0 I2 / 0 I3 / 0 I4 / runner 0 次 / 状态文件数不变）',
      dry.exitCode === 0 && MOCK.state.counts.i1 === 1 && MOCK.state.counts.i2 === 0 && MOCK.state.counts.i3 === 0 &&
      MOCK.state.counts.i4 === 0 && rCli.rec.calls === 0 && countStateFiles() === before && dry.payload.jobs.sync.action === 'dry_run',
      JSON.stringify({ exit: dry.exitCode, counts: MOCK.state.counts, action: dry.payload.jobs.sync.action }));

    MOCK.reset();
    const status = await CLI.runCli(['--status'], { env: ENV, deps, out: collect });
    ck('cli4 --status：只读（仅 I1 一次 GET），不 claim/不执行/不写状态，exit 0，且输出里带配置与本地状态摘要',
      status.exitCode === 0 && MOCK.state.counts.i1 === 1 && MOCK.state.counts.i2 === 0 && MOCK.state.counts.i3 === 0 &&
      MOCK.state.counts.i4 === 0 && status.payload.mode === 'status' && status.payload.center.reachable === true &&
      status.payload.center.config.sync_time === '01:05' && Array.isArray(status.payload.local.files),
      JSON.stringify({ counts: MOCK.state.counts, center: status.payload.center.config }));

    MOCK.reset(); MOCK.config(CFG_ON_BOTH);
    const onceOff = 72;
    const rOnce = makeRunner('ok');
    const once = await CLI.runCli(['--once'], { env: ENV, deps: { zk: mkZk(), syncRunner: rOnce.runner }, out: collect, now: at(onceOff, '01:10:00') });
    ck('cli5 --once（默认模式）：跑一次 tick 并返回 0（成功路径），输出可 JSON 解析',
      once.exitCode === 0 && rOnce.rec.calls === 1 && MOCK.state.counts.i2 === 1,
      JSON.stringify({ exit: once.exitCode, runner: rOnce.rec.calls }));

    MOCK.reset(); MOCK.config(CFG_ON_BOTH);
    const refOff = 74;
    const ref = await CLI.runCli(['--once'], { env: ENV, deps: { zk: mkZk() }, out: collect, now: at(refOff, '01:10:00') });
    ck('cli6 sync 到期但未提供 sync 执行器 ⇒ CLI 退出码 **3**（fail-closed），且零副作用：0 claim / 0 settle / 0 I4 / 无本地状态文件',
      ref.exitCode === 3 && ref.payload.jobs.sync.reason === 'sync_runner_missing' &&
      MOCK.state.counts.i2 === 0 && MOCK.state.counts.i3 === 0 && MOCK.state.counts.i4 === 0 &&
      !SSTATE.exists('sync', D(refOff - 1)) && ref.payload.jobs.sync.calls.claim === 0 && ref.payload.jobs.sync.calls.execute === 0,
      JSON.stringify({ exit: ref.exitCode, reason: ref.payload.jobs.sync.reason, counts: MOCK.state.counts, state_file: SSTATE.exists('sync', D(refOff - 1)) }));

    out.cli_outputs = logs;
  }

  // ============================================================ 纯函数（plan）与 zk 客户端硬约束
  {
    const n1 = PLAN.shanghaiNow(new Date('2026-03-01T17:05:00Z'));
    const n2 = PLAN.shanghaiNow(new Date('2026-03-01T16:00:00Z'));
    ck('p1 上海时区用 Intl(timeZone) 计算（不硬编码 +08:00）：UTC 17:05 ⇒ 次日 01:05；UTC 16:00 ⇒ 当日 24→00:00',
      n1.local === '2026-03-02 01:05:00' && n1.date === '2026-03-02' && n2.local === '2026-03-02 00:00:00' &&
      /timeZone/.test(readSrc('app/src/schedule/plan.js')) && !/\+0?8:00/.test(stripComments(readSrc('app/src/schedule/plan.js'))) &&
      !/getTimezoneOffset|8 \* 60 \* 60|28800/.test(stripComments(readSrc('app/src/schedule/plan.js'))),
      JSON.stringify({ n1: n1.local, n2: n2.local }));
    ck('p2 HH:mm 校验：合法 01:05/23:59 通过；24:00 / 1:05 / 01:60 / 空 一律拒绝',
      PLAN.parseHHmm('01:05').ok === true && PLAN.parseHHmm('23:59').ok === true && PLAN.parseHHmm('24:00').ok === false &&
      PLAN.parseHHmm('1:05').ok === false && PLAN.parseHHmm('01:60').ok === false && PLAN.parseHHmm('').ok === false,
      '');
    ck('p3 previousCompleteDate：跨月/跨年/闰年边界正确',
      PLAN.previousCompleteDate('2026-04-01') === '2026-03-31' && PLAN.previousCompleteDate('2026-01-01') === '2025-12-31' &&
      PLAN.previousCompleteDate('2028-03-01') === '2028-02-29',
      JSON.stringify({ a: PLAN.previousCompleteDate('2026-04-01'), b: PLAN.previousCompleteDate('2026-01-01'), c: PLAN.previousCompleteDate('2028-03-01') }));
    ck('p4 isDue 语义：仅当计划时刻所在日期==今天且 now>=计划时刻；disabled / 非法时刻一律 false',
      PLAN.isDue({ job: 'sync', now: '2026-04-02 01:05:00', scheduledTime: '01:05', enabled: true }) === true &&
      PLAN.isDue({ job: 'sync', now: '2026-04-02 01:04:59', scheduledTime: '01:05', enabled: true }) === false &&
      PLAN.isDue({ job: 'sync', now: '2026-04-02 01:05:00', scheduledTime: '01:05', enabled: false }) === false &&
      PLAN.isDue({ job: 'sync', now: '2026-04-02 01:05:00', scheduledTime: '25:00', enabled: true }) === false,
      '');
    ck('p5 幂等键格式 sync:<date> / report:<date>；未知作业与非法日期抛错',
      PLAN.idempotencyKey('sync', '2026-04-01') === 'sync:2026-04-01' && PLAN.idempotencyKey('report', '2026-04-01') === 'report:2026-04-01' &&
      (() => { try { PLAN.idempotencyKey('purge', '2026-04-01'); return false; } catch (e) { return true; } })() &&
      (() => { try { PLAN.idempotencyKey('sync', '2026-4-1'); return false; } catch (e) { return true; } })(),
      '');

    const baseCases = [
      ['http://127.0.0.1:3456', true, null],
      ['http://localhost:3456', false, 'base_host_not_allowed'],
      ['http://127.0.0.1:9999', false, 'base_port_not_allowed'],
      ['http://example.com:3456', false, 'base_host_not_allowed'],
      ['https://127.0.0.1:3456', false, 'base_scheme_not_allowed'],
      ['http://user:pw@127.0.0.1:3456', false, 'base_credentials_not_allowed'],
      ['http://127.0.0.1:3456/?x=1', false, 'base_query_not_allowed'],
    ];
    const bad = baseCases.filter(([b, want]) => ZK.assertBase(b).ok !== want);
    ck('z1 zk 客户端**硬拒**非 127.0.0.1:3456 的 base（host/端口/协议/凭据/查询串一律拒绝）',
      bad.length === 0, JSON.stringify(baseCases.map(([b]) => b + '=' + JSON.stringify(ZK.assertBase(b)))));
    MOCK.reset();
    const badClient = ZK.createZkClient({ base: 'http://127.0.0.1:9999' });
    const badRes = await badClient.getSchedule();
    const nosh = await ZK.createZkClient({ base: MOCK.baseUrl, allowTestBase: true, secretFile: path.join(ROOT, 'nope.json') }).getSchedule();
    ck('z2 非法 base / 密钥不可读：fail-closed 返回且**一个 HTTP 都不发**（单次请求、绝不重试）',
      badRes.ok === false && badRes.reason === 'base_port_not_allowed' && nosh.ok === false && nosh.reason === 'secret_unreadable' &&
      MOCK.state.counts.i1 === 0 && MOCK.state.counts.other === 0,
      JSON.stringify({ bad: badRes.reason, nosh: nosh.reason, counts: MOCK.state.counts }));
    ck('z3 客户端不打印/不返回密钥与签名（返回值里没有 secret/signature 字段）',
      JSON.stringify(Object.keys(badClient)).indexOf('secret') < 0 && JSON.stringify(badRes).indexOf(SECRET) < 0 &&
      JSON.stringify(badRes).indexOf('signature') < 0,
      JSON.stringify(Object.keys(badClient)));
  }

  // ============================================================ R10 泄漏扫描 + 自证
  {
    const stripSecretDir = (f) => f.indexOf(path.join(ROOT, 'state', 'secrets')) < 0;
    const files = walkFiles(ROOT).filter(stripSecretDir);
    const texts = [];
    for (const f of files) { try { texts.push({ f, t: fs.readFileSync(f, 'utf8') }); } catch (e) {} }
    const bodiesRaw = MOCK.state.all_requests.map((r) => r.body_raw);
    const secretFiles = walkFiles(ROOT).filter((f) => !stripSecretDir(f));
    const allState = texts.map((x) => x.t).join('\n');
    const allBodies = bodiesRaw.join('\n');
    const outputs = OUTPUTS.join('\n') + '\n' + (out.cli_outputs || []).join('\n');
    // 只匹配**真实泄漏形态**：裸词（如 webhook / 理由码 webhook_not_configured）不算泄漏
    const LEAK = [
      ['jwt', /eyJ[A-Za-z0-9_-]{10,}\./],
      ['bearer', /Bearer\s+[A-Za-z0-9._-]{10,}/],
      ['webhook_url', /https?:\/\/qyapi\.weixin\.qq\.com\//i],
      ['webhook_key', /key=[A-Za-z0-9-]{8,}/],
      ['webhook_json_url', /"webhook"\s*:\s*"http/i],
      ['password_value', /"(?:password|passwd|pwd)"\s*:\s*"[^"]+"/i],
      ['cookie_header', /"(?:cookie|authorization)"\s*:\s*"[^"]{8,}"/i],
      ['full_sha_64hex', /[0-9a-f]{64}/],
      ['base64_40', /[A-Za-z0-9+/]{40,}={0,2}/],
      ['abs_path_unix', /\/(?:home|opt|etc|var|root|tmp|usr)\//],
      ['abs_path_win', /[A-Za-z]:[\\/]/],
    ];
    const leaks = [];
    for (const [name, re] of LEAK) {
      if (re.test(allState)) leaks.push('state:' + name);
      if (re.test(allBodies)) leaks.push('http_body:' + name);
      if (re.test(outputs)) leaks.push('output:' + name);
    }
    if (allState.indexOf(SECRET) >= 0) leaks.push('state:hmac_secret');
    if (allBodies.indexOf(SECRET) >= 0) leaks.push('http_body:hmac_secret');
    if (outputs.indexOf(SECRET) >= 0) leaks.push('output:hmac_secret');
    ck('r10a 状态文件 / HTTP 请求体 / 套件输出：无 JWT、无口令、无 Authorization/Cookie、无 webhook、无 base64、无完整 SHA、无绝对路径、无 HMAC 密钥',
      leaks.length === 0, JSON.stringify({ leaks: leaks.slice(0, 6), scanned_files: files.length, bodies: bodiesRaw.length }));
    const secretMode = fs.statSync(SECRET_FILE).mode & 0o777;
    const state0600 = /0o600/.test(readSrc('app/src/schedule/state.js'));
    ck('r10b 密钥只存在于 0600 的 state/secrets/audit-hmac.json（唯一持有者），本地状态文件也按 0600 原子写',
      secretFiles.length === 1 && secretFiles[0] === SECRET_FILE &&
      (process.platform === 'win32' || secretMode === 0o600) && state0600,
      JSON.stringify({ secret_files: secretFiles.length, mode: secretMode.toString(8), platform: process.platform, state_atomic_write_0600: state0600 }));
    ck('r10c 中控侧从未收到完整 SHA（>12 位）或任何密钥字段；所有请求都带合法 HMAC 时间戳与签名',
      MOCK.state.total.hmac_fail === 0 && MOCK.state.all_requests.every((r) => r.hmac_ok) &&
      bodiesRaw.every((b) => !/[0-9a-fA-F]{64}/.test(b)),
      JSON.stringify({ hmac_fail: MOCK.state.total.hmac_fail, requests: MOCK.state.all_requests.length }));
  }

  {
    const sched = ['app/src/schedule/plan.js', 'app/src/schedule/state.js', 'app/src/schedule/zk-client.js', 'app/src/schedule/worker.js', 'app/bin/schedule-tick.js'];
    const srcs = sched.map((rel) => ({ rel, raw: readSrc(rel), code: stripComments(readSrc(rel)) }));
    const missing = srcs.filter((s) => !s.raw);
    const noInterval = srcs.every((s) => !/\bsetInterval\b/.test(s.code));
    // 只匹配"真实调度创建"：require('cron'|'node-cron'|'node-schedule') / new CronJob / crontab / systemd-run / 写 .timer 文件
    const SCHEDULER_CALL = /require\(\s*['"](?:cron|node-cron|node-schedule)['"]\s*\)|new\s+CronJob\b|\bcrontab\b|\bsystemd-run\b|\.timer['"]/;
    const noCron = srcs.every((s) => !SCHEDULER_CALL.test(s.code));
    // 代码字符串里也不留裸词 cron（注释里允许保留说明）
    const CRON_IN_STRING = /(['"])[^'"\n]*\bcron\b[^'"\n]*\1/;
    const noCronWordInCode = srcs.every((s) => !CRON_IN_STRING.test(s.code));
    const setTimeoutCount = srcs.reduce((n, s) => n + (s.code.match(/\bsetTimeout\b/g) || []).length, 0);
    const noPushMod = srcs.every((s) => !/require\(\s*['"][^'"]*push-(?:run|client)/.test(s.code));
    const noBrowser = srcs.every((s) => !/playwright|puppeteer|chromium/i.test(s.code));
    const noDb = srcs.every((s) => !/sqlite|better-sqlite3|mysql|pg\./i.test(s.code));
    const noWebhook = srcs.every((s) => !/webhook|qyapi|corpsecret|corpid/i.test(s.code));
    ck('s1 调度源码全部存在，且**不含任何 setInterval / 真实调度创建（node-cron/CronJob/crontab/systemd-run/.timer 写入）/ 推送模块 / 浏览器 / 数据库 / webhook 调用**（去掉注释后扫描可执行代码）',
      missing.length === 0 && noInterval && noCron && noCronWordInCode && noPushMod && noBrowser && noDb && noWebhook,
      JSON.stringify({ missing: missing.map((m) => m.rel), setInterval: !noInterval, scheduler_call: !noCron, cron_word_in_code_string: !noCronWordInCode, push: !noPushMod, browser: !noBrowser, db: !noDb, webhook: !noWebhook }));
    ck('s2 全仓唯一的时间函数是 CLI 里的 --loop 睡眠（setTimeout 恰好 1 处，且本轮默认拒绝启用）',
      setTimeoutCount === 1 && /setTimeout/.test(readSrc('app/bin/schedule-tick.js')) &&
      srcs.filter((s) => s.rel.indexOf('app/bin/') === 0 && /setTimeout/.test(s.code)).length === 1,
      JSON.stringify({ setTimeout_count: setTimeoutCount }));

    // 仓库布局：app/systemd/<name>.service + phase5-timers-not-installed/（未安装模板目录）
    const sysd = path.join(BOT, 'app', 'systemd');
    const units = fs.existsSync(sysd) ? fs.readdirSync(sysd) : [];
    const repoUnits = walkFiles(sysd);
    const timerFiles = repoUnits.filter((f) => /\.timer$/.test(f));
    const strayTemplates = repoUnits.filter((f) => /\.timer\.template$/.test(f)).filter((f) => f.indexOf('phase5-timers-not-installed') < 0);
    const svc = readSrc('app/systemd/syncbot-schedule.service');
    ck('s3 systemd 仓库布局：**仓库内没有任何 .timer**（phase5-timers-not-installed/ 内的 .timer.template 属未安装模板，不计）；service 含 Type=oneshot + --once + User/Group=syncbot + 固定 WorkingDirectory + TZ=Asia/Shanghai',
      timerFiles.length === 0 && strayTemplates.length === 0 && svc.length > 0 &&
      /^Type=oneshot$/m.test(svc) && /ExecStart=\/usr\/local\/bin\/node \/opt\/zhongkong-sync-bot\/app\/bin\/schedule-tick\.js --once/.test(svc) &&
      /^User=syncbot$/m.test(svc) && /^Group=syncbot$/m.test(svc) && /^WorkingDirectory=\/opt\/zhongkong-sync-bot$/m.test(svc) &&
      /^Environment=TZ=Asia\/Shanghai$/m.test(svc) && svc.indexOf('--loop') < 0,
      JSON.stringify({ units: units, timers: timerFiles.length, stray_timer_templates: strayTemplates.length, tz: /^Environment=TZ=Asia\/Shanghai$/m.test(svc) }));

    // /etc/systemd/system 只在可读时断言"是否已安装/已启用"，否则记 skip（不假装通过）
    let etcList = null;
    try { etcList = fs.readdirSync('/etc/systemd/system'); } catch (e) { etcList = null; }
    if (etcList === null) {
      out.skips.push('s4b /etc/systemd/system 不可读（本机为 ' + process.platform + ' 或权限不足）⇒ 跳过"是否已安装/已启用"断言');
    }
    const etcOk = etcList === null ? true : (etcList.indexOf('syncbot-schedule.timer') < 0);
    ck('s4 service 明写「默认 disabled，需人工批准后才 enable」；仓库内无 syncbot-schedule.timer' + (etcList === null ? '（/etc/systemd/system 不可读 ⇒ 该侧跳过）' : '，且 /etc/systemd/system 下也没有'),
      svc.indexOf('默认 disabled + inactive') >= 0 && svc.indexOf('人工明确批准后才允许') >= 0 &&
      !fs.existsSync(path.join(sysd, 'syncbot-schedule.timer')) && etcOk,
      JSON.stringify({ has_approval_note: svc.indexOf('人工明确批准后才允许') >= 0, etc_readable: etcList !== null, etc_timer_absent: etcOk }));

    ck('self1 本套件自证：全程离线 —— 不访问美团、不真实导出/下载/导入/发送、不读 webhook、不建 timer/cron，且 mock 从未收到非 I1–I4 路径',
      out.real_meituan_run === false && out.real_export === false && out.real_download === false && out.real_import === false &&
      out.real_wecom_message_sent === false && out.real_webhook_read === false && out.timers_created === false &&
      MOCK.state.total.other === 0 && MOCK.state.all_requests.every((r) => r.path.indexOf('/api/internal/syncbot/schedule') === 0) &&
      MOCK.state.all_requests.every((r) => r.hmac_ok),
      JSON.stringify({ other_paths: MOCK.state.total.other, requests: MOCK.state.all_requests.length }));
    ck('self2 报表 B 全程锁定：report_type 恒为 cashier_composite，mock 侧未出现任何 item_sales_detail 请求；plan/state/worker 三层都拒绝它',
      out.report_b === 'locked_not_started' && MOCK.state.all_requests.every((r) => r.body_raw.indexOf('item_sales_detail') < 0) &&
      WORKER.REPORT_TYPE === 'cashier_composite' && PLAN.LOCKED_REPORT_TYPE === 'item_sales_detail',
      JSON.stringify({ report_type: WORKER.REPORT_TYPE }));
    ck('self3 状态文件字段固定为契约 7 项（job/business_date/status/attempt/reason/updated_at/worker_id），不落任何额外字段',
      SSTATE.list().every((r) => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['attempt', 'business_date', 'job', 'reason', 'status', 'updated_at', 'worker_id'])) &&
      SSTATE.FIELDS.join(',') === 'job,business_date,status,attempt,reason,updated_at,worker_id',
      JSON.stringify({ files: SSTATE.list().length, fields: SSTATE.FIELDS }));
  }

  await MOCK.stop();
  out.total = out.checks.length;
  out.failed = out.checks.filter((c) => !c.ok).length;
  out.ok = out.failed === 0;
  out.summary = {
    http_calls_total: MOCK.state.total,
    http_calls_last_case: MOCK.state.counts,
    state_files: SSTATE.list().length,
    locks_left: listLockFiles().length,
    report_b: out.report_b, timers_created: false, push_owner: 'project_daily_report_bot（中控 I4）',
    skipped: out.skips.length, skips: out.skips,
  };
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}
  if (process.env.P3_OUT) { try { fs.writeFileSync(process.env.P3_OUT, JSON.stringify(out, null, 2), 'utf8'); } catch (e) {} }
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
})().catch((e) => {
  const fatal = { ok: false, fatal: String((e && e.stack) || e).slice(0, 900), total: out.checks.length, failed: out.checks.filter((c) => !c.ok).length, checks: out.checks };
  if (process.env.P3_OUT) { try { fs.writeFileSync(process.env.P3_OUT, JSON.stringify(fatal, null, 2), 'utf8'); } catch (e2) {} }
  console.log(JSON.stringify(fatal, null, 2));
  process.exit(9);
});
