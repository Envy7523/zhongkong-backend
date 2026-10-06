#!/usr/bin/env node
'use strict';
/**
 * 生产 data-only 同步接线 · **纯离线套件**（契约 v2 §2.1 / §2.2 / §4）
 *
 * 被测对象：app/src/phase3/production-sync-runner.js（唯一新增生产装配点）
 * 边界：中控用 **127.0.0.1 随机端口 mock**（校验 HMAC、实现只读覆盖接口、记录调用次数与请求体）；
 *       download/import 一律用 **fake 工厂**；
 *       **不访问美团、不真实导出/下载/导入/推送、不读任何凭据、不建 timer/cron**；报表 B 永远锁定。
 *
 * 运行（PowerShell）：
 *   $env:SYNCBOT_BOT='F:\NewDeom\_syncbot\stage0'; $env:P3_OUT='F:\NewDeom\_syncbot\schedule\res-prodrunner.json';
 *   node app/bin/phase3/production-sync-runner-test.js
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p6prod-'));
process.env.SYNCBOT_ROOT = ROOT;

const BOT = process.env.SYNCBOT_BOT || '/opt/zhongkong-sync-bot';
const P = require(BOT + '/app/src/paths.js');
const RUNNER = require(BOT + '/app/src/phase3/production-sync-runner.js');
const WFP = require(BOT + '/app/src/phase3/workflow-production-adapters.js');
const ZK = require(BOT + '/app/src/schedule/zk-client.js');
const PLAN = require(BOT + '/app/src/schedule/plan.js');
const WORKER = require(BOT + '/app/src/schedule/worker.js');

const SECRET = crypto.randomBytes(32).toString('hex');
const SECRET_DIR = path.join(ROOT, 'state', 'secrets');
const SECRET_FILE = path.join(SECRET_DIR, 'audit-hmac.json');
fs.mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 });
fs.writeFileSync(SECRET_FILE, JSON.stringify({ secret: SECRET, endpoint: 'http://127.0.0.1:3456/api/internal/syncbot/events' }), { mode: 0o600 });
const WRONG_SECRET_FILE = path.join(SECRET_DIR, 'wrong-hmac.json');
fs.writeFileSync(WRONG_SECRET_FILE, JSON.stringify({ secret: crypto.randomBytes(32).toString('hex') }), { mode: 0o600 });

const RUN = 'test-prodrunner-' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');
const out = {
  suite: 'production-sync-runner-offline', offline: true, fixture: true,
  real_meituan_run: false, real_export: false, real_download: false, real_import: false,
  real_wecom_message_sent: false, real_webhook_read: false, timers_created: false,
  report_b: 'locked_not_started', test_run_id: RUN, checks: [], skips: [],
};
const ck = (n, ok, d) => out.checks.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });
const stripComments = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const readSrc = (rel) => { try { return fs.readFileSync(BOT + '/' + rel, 'utf8'); } catch (e) { return ''; } };

const BASE_DAY = Date.UTC(2026, 4, 1);
const D = (off) => new Date(BASE_DAY + off * 86400000).toISOString().slice(0, 10);

// ------------------------------------------------------------------ 出站 HTTP 记录器（自证"未访问美团"）
const HTTP_LOG = [];
let HTTPS_CALLS = 0;
const origHttpRequest = http.request;
http.request = function () {
  try {
    const a = arguments;
    let host = null; let port = null; let p = null;
    if (a[0] && typeof a[0] === 'object') { host = a[0].host || a[0].hostname || null; port = a[0].port || null; p = a[0].path || null; }
    else if (typeof a[0] === 'string') { const u = new URL(a[0]); host = u.hostname; port = u.port || null; p = u.pathname; }
    HTTP_LOG.push({ host: String(host), port: String(port || ''), path: String(p || '') });
  } catch (e) { HTTP_LOG.push({ host: 'parse_error', port: '', path: '' }); }
  return origHttpRequest.apply(http, arguments);
};
const origHttpsRequest = https.request;
https.request = function () { HTTPS_CALLS += 1; return origHttpsRequest.apply(https, arguments); };

// ------------------------------------------------------------------ 定时器计数（自证"未建 timer"）
let TIMER_CREATIONS = 0;
const origSetTimeout = global.setTimeout;
const origSetInterval = global.setInterval;
const origSetImmediate = global.setImmediate;
global.setTimeout = function () { TIMER_CREATIONS += 1; return origSetTimeout.apply(global, arguments); };
global.setInterval = function () { TIMER_CREATIONS += 1; return origSetInterval.apply(global, arguments); };
global.setImmediate = function () { TIMER_CREATIONS += 1; return origSetImmediate.apply(global, arguments); };
function timersDuring(fn) { const t0 = TIMER_CREATIONS; return Promise.resolve().then(fn).then((v) => ({ value: v, created: TIMER_CREATIONS - t0 })); }

// ------------------------------------------------------------------ 文件清点
function walkFiles(dir, acc) {
  acc = acc || [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) walkFiles(p, acc); else acc.push(p); }
  return acc;
}
/** 业务状态文件（排除 state/secrets —— 那里是密钥本体，单独断言） */
function stateFiles() {
  return walkFiles(path.join(ROOT, 'state')).filter((f) => f.indexOf(SECRET_DIR) < 0);
}
function stateFileCount() { return stateFiles().filter((f) => f.endsWith('.json')).length; }
function lockFiles() { return walkFiles(path.join(ROOT, 'state', 'locks')).filter((f) => f.endsWith('.lock')); }

// ------------------------------------------------------------------ mock 中控（只读 coverage：G1/G3 闸门 + active_stores 五态）
const COVERAGE_PATH = '/api/internal/syncbot/coverage';
function createMockCenter() {
  const st = {
    counts: { coverage: 0, hmac_fail: 0, other: 0, wrong_method: 0 },
    total: { coverage: 0, hmac_fail: 0, other: 0, wrong_method: 0 },
    requests: [], all_requests: [],
    mode: 'not_covered',          // not_covered | zero_with_static_flags | covered | covered_from_2 | covered_with_static_flags | report_ineligible | legacy_covered_only | inconsistent | http500 | hmac_fail | timeout | bad_body | date_mismatch | unverifiable
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const full = String(req.url || '');
      const url = full.split('?')[0];
      const qs = full.indexOf('?') >= 0 ? full.slice(full.indexOf('?') + 1) : '';
      const query = {};
      for (const kv of qs.split('&')) { if (!kv) continue; const i = kv.indexOf('='); query[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1)); }
      const ts = String(req.headers['x-syncbot-timestamp'] || '');
      const sig = String(req.headers['x-syncbot-signature'] || '');
      const want = crypto.createHmac('sha256', SECRET).update(ts + '.' + raw, 'utf8').digest('hex');
      const hmacOk = /^\d{10,16}$/.test(ts) && sig === want;
      const rec = { method: req.method, path: url, query: query, body_raw: raw, hmac_ok: hmacOk, at: new Date().toISOString() };
      st.requests.push(rec); st.all_requests.push(rec);
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (!hmacOk) { st.counts.hmac_fail += 1; st.total.hmac_fail += 1; return json(401, { ok: false, error: 'signature_invalid' }); }
      if (url === COVERAGE_PATH && req.method === 'GET') {
        st.counts.coverage += 1; st.total.coverage += 1;
        const bd = String(query.business_date || '');
        if (st.mode === 'timeout') return;                                   // 挂住 → 客户端超时
        if (st.mode === 'http500') return json(500, { ok: false, error: 'mock_500' });
        if (st.mode === 'bad_body') return json(200, { ok: true, business_date: bd, covered: 'yes' });
        if (st.mode === 'date_mismatch') return json(200, { ok: true, business_date: '1999-01-01', covered: false, evidence: {} });
        let covered = false;
        if (st.mode === 'covered') covered = true;
        else if (st.mode === 'covered_from_2') covered = st.counts.coverage >= 2;
        else if (st.mode === 'unverifiable' || st.mode === 'covered_with_static_flags' || st.mode === 'report_ineligible' || st.mode === 'legacy_covered_only') covered = true;
        const body = {
          ok: true, business_date: bd, covered: covered, has_records: covered,
          reason: covered ? 'coverage_hit' : 'not_covered',
          evidence: { revenue_records: covered ? 22 : 0, product_sales: covered ? 18 : 0, batches: covered ? 1 : 0 },
          checked_at: new Date().toISOString(),
        };
        // §G.1 / §G-补.2：否决信号（即便 has_records=true）
        if (st.mode === 'unverifiable') { body.has_records = true; body.provenance = 'unverifiable'; body.safe_to_skip_sync = false; body.report_eligible = false; }
        // Real middle-control contract: these static safety flags do not imply
        // data exists. The zero-data case must still enter the data path.
        if (st.mode === 'zero_with_static_flags') { body.has_records = false; body.covered = false; body.provenance = 'none'; body.safe_to_skip_sync = false; body.report_eligible = false; }
        if (st.mode === 'covered_with_static_flags') { body.has_records = true; body.covered = true; body.provenance = 'partially_verifiable'; body.safe_to_skip_sync = false; body.report_eligible = false; }
        if (st.mode === 'report_ineligible') { body.has_records = true; body.covered = true; body.provenance = 'partially_verifiable'; body.safe_to_skip_sync = true; body.report_eligible = false; }
        if (st.mode === 'legacy_covered_only') { delete body.has_records; body.covered = true; }
        if (st.mode === 'inconsistent') { body.has_records = false; body.covered = true; }
        return json(200, body);
      }
      if (url === COVERAGE_PATH) { st.counts.wrong_method += 1; st.total.wrong_method += 1; return json(405, { ok: false, error: 'method_not_allowed' }); }
      st.counts.other += 1; st.total.other += 1;
      return json(404, { ok: false, error: 'not_found' });
    });
  });
  return {
    server: server, state: st,
    async start() { await new Promise((r) => server.listen(0, '127.0.0.1', r)); this.baseUrl = 'http://127.0.0.1:' + server.address().port; this.port = String(server.address().port); return this; },
    async stop() { try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch (e) {} await new Promise((r) => server.close(r)); },
    reset() { st.counts = { coverage: 0, hmac_fail: 0, other: 0, wrong_method: 0 }; st.requests = []; },
    mode(m) { st.mode = m; },
  };
}
let MOCK = null;

const ENV_ON = { SYNCBOT_WORKFLOW_PROD_ADAPTERS: '1' };
const ENV_OFF = {};
const OUTPUTS = [];

/** 建 runner（默认注入测试用覆盖 base / 密钥文件；生产默认永远走 127.0.0.1:3456） */
function runnerFor(o) {
  const opt = o || {};
  const deps = Object.assign({
    base: MOCK.baseUrl, secretFile: opt.secretFile || SECRET_FILE, allowTestBase: true,
  }, opt.deps || {});
  return RUNNER.createRunner({
    reportType: opt.reportType || 'cashier_composite', platform: 'meituan',
    env: opt.env || ENV_ON, deps: deps, logger: null,
  });
}
async function runOnce(runner, args) {
  const r = await runner.runOnce(args);
  try { OUTPUTS.push(JSON.stringify(r)); } catch (e) {}
  return r;
}

// ------------------------------------------------------------------ fake 适配器工厂
function makeDownloadFake(mode) {
  const rec = { factory_calls: 0, run_calls: 0, factory_args: [], run_args: [], exported: false };
  const factory = function (a) {
    rec.factory_calls += 1; rec.factory_args.push({ reportType: a && a.reportType, businessDate: a && a.businessDate, platform: a && a.platform });
    return {
      async run(arg) {
        rec.run_calls += 1;
        rec.run_args.push({ task_id: arg && arg.ctx && arg.ctx.taskId, business_date: arg && arg.ctx && arg.ctx.businessDate, report_type: arg && arg.ctx && arg.ctx.reportType, platform: arg && arg.ctx && arg.ctx.platform });
        if (mode === 'throw') throw new Error('fake download boom');
        if (mode === 'fail') {
          return {
            ok: false, result: 'FAILED', phase: 'FAILED', export_submitted: true, export_submit_calls: 1,
            file: null, archived_name: null, sha256_prefix: null, archive: null, validation: null,
            task: { task_id: arg.ctx.taskId, report_type: 'cashier_composite', platform: 'meituan', business_date: arg.ctx.businessDate, historical_backfill: false },
            failure_reason: 'download_failed',
          };
        }
        if (mode === 'direct_download_not_observed') {
          // v0.3.2：站内确认弹窗不存在、且等待窗口内也没有新的完整文件 ⇒ 专门的 fail-closed 码
          return {
            ok: false, result: 'FAILED', phase: 'FAILED', export_submitted: true, export_submit_calls: 1,
            file: null, archived_name: null, sha256_prefix: null, archive: null, validation: null,
            task: { task_id: arg.ctx.taskId, report_type: 'cashier_composite', platform: 'meituan', business_date: arg.ctx.businessDate, historical_backfill: false },
            failure_stage: 'export_direct_download', failure_reason: 'export_direct_download_not_observed',
            confirmation_mode: 'absent_direct_download', export_submitted_uncertain: false, confirm_click_calls: 0, download_calls: 0,
          };
        }
        rec.exported = true;
        return {
          ok: true, result: 'FILE_VALIDATED', phase: 'STOPPED', export_submitted: true, export_submit_calls: 1,
          file: path.join(ROOT, 'downloads', 'meituan', 'cashier_composite', arg.ctx.businessDate, 'fake-report-a.xlsx'),
          archived_name: 'fake-report-a.xlsx', sha256_prefix: 'abcdef012345',
          archive: { file: 'fake-report-a.xlsx', size: 24952, sha256: 'abcdef012345' + '0'.repeat(52), platform: 'meituan', report_type: 'cashier_composite', business_date: arg.ctx.businessDate, historical_backfill: false },
          task: { task_id: arg.ctx.taskId, report_type: 'cashier_composite', platform: 'meituan', business_date: arg.ctx.businessDate, historical_backfill: false },
          validation: { ok: true, checks: { row2_metadata: { ok: true } }, errors: null },
          failure_reason: null,
          confirmation_mode: 'absent_direct_download',
        };
      },
    };
  };
  return { factory: factory, rec: rec };
}
function makeImportFake(mode) {
  const rec = { factory_calls: 0, run_calls: 0, factory_args: [], seen: [] };
  const factory = function (a) {
    rec.factory_calls += 1; rec.factory_args.push({ reportType: a && a.reportType, businessDate: a && a.businessDate, platform: a && a.platform });
    return {
      async runOnce(arg) {
        rec.run_calls += 1;
        const d = (arg && arg.download) || {};
        rec.seen.push({
          task_id: arg && arg.ctx && arg.ctx.taskId,
          business_date: arg && arg.ctx && arg.ctx.businessDate,
          g3_ok: !!(arg && arg.g3 && arg.g3.ok === true),
          download_ok: d.ok === true,
          archive_bd: d.archive ? d.archive.business_date : null,
          task_bd: d.task ? d.task.business_date : null,
          validation_ok: !!(d.validation && d.validation.ok === true),
        });
        if (mode === 'throw') throw new Error('fake import boom');
        if (mode === 'fail') return { ok: false, action: 'IMPORT_FAILED', reason: 'import_failed', http_requests: 1, import_batch_id: null };
        if (mode === 'waiting') return { ok: false, action: 'WAITING_HUMAN', reason: 'import_result_unknown', http_requests: 1, import_batch_id: null };
        return { ok: true, action: 'IMPORT_SUCCEEDED', import_batch_id: 'fake-batch-1', http_requests: 1, ready_to_push: false };
      },
    };
  };
  return { factory: factory, rec: rec };
}

// ------------------------------------------------------------------ 主流程
(async () => {
  MOCK = await createMockCenter().start();

  // ============================================================ p1 未显式启用 ⇒ fail-closed
  {
    const bd = D(1);
    MOCK.reset(); MOCK.mode('not_covered');
    const dl = makeDownloadFake('ok'); const im = makeImportFake('ok');
    const before = stateFileCount(); const httpBefore = HTTP_LOG.length; const t0 = TIMER_CREATIONS;
    const res = await runOnce(runnerFor({ env: ENV_OFF, deps: { adapterFactories: { download: dl.factory, import: im.factory } } }), { businessDate: bd, workerId: 'w', idempotencyKey: 'sync:' + bd });
    ck('p1a 未置位 SYNCBOT_WORKFLOW_PROD_ADAPTERS ⇒ fail-closed production_adapters_not_enabled，side_effects=false、push_calls=0、stage_calls 全 0；工厂零调用、覆盖接口零请求、零状态文件、零锁、零出站 HTTP',
      res.ok === false && res.reason === 'production_adapters_not_enabled' && res.side_effects === false && res.push_calls === 0 &&
      res.stage_calls.download === 0 && res.stage_calls.import === 0 &&
      dl.rec.factory_calls === 0 && dl.rec.run_calls === 0 && im.rec.factory_calls === 0 && im.rec.run_calls === 0 &&
      MOCK.state.counts.coverage === 0 && MOCK.state.counts.other === 0 &&
      stateFileCount() === before && lockFiles().length === 0 && HTTP_LOG.length === httpBefore && (TIMER_CREATIONS - t0) === 0,
      JSON.stringify({ reason: res.reason, side_effects: res.side_effects, push_calls: res.push_calls, coverage_calls: MOCK.state.counts.coverage, state_files: stateFileCount(), locks: lockFiles().length, http: HTTP_LOG.length - httpBefore, timers: TIMER_CREATIONS - t0 }));
    const res2 = await runOnce(runnerFor({ env: { SYNCBOT_WORKFLOW_PROD_ADAPTERS: 'true' }, deps: { adapterFactories: { download: dl.factory, import: im.factory } } }), { businessDate: bd });
    ck('p1b 开关只认精确值 "1"：置为 "true" 同样 fail-closed（production_adapters_not_enabled），零调用',
      res2.ok === false && res2.reason === 'production_adapters_not_enabled' && dl.rec.factory_calls === 0 && MOCK.state.counts.coverage === 0,
      JSON.stringify({ reason: res2.reason, coverage_calls: MOCK.state.counts.coverage }));
  }

  // ============================================================ p2 adapter 工厂缺失
  {
    const bd = D(2);
    MOCK.reset(); MOCK.mode('not_covered');
    const dl = makeDownloadFake('ok'); const im = makeImportFake('ok');
    const before = stateFileCount(); const httpBefore = HTTP_LOG.length;
    const r1 = await runOnce(runnerFor({ deps: { adapterFactories: { download: dl.factory } } }), { businessDate: bd });
    const r2 = await runOnce(runnerFor({ deps: { adapterFactories: { import: im.factory } } }), { businessDate: bd });
    ck('p2a 缺 import 工厂 ⇒ adapter_factory_missing:import；缺 download 工厂 ⇒ adapter_factory_missing:download；两者都零副作用（无 HTTP、无状态文件、无锁、无工厂调用）',
      r1.ok === false && r1.reason === 'adapter_factory_missing:import' && r1.side_effects === false &&
      r2.ok === false && r2.reason === 'adapter_factory_missing:download' && r2.side_effects === false &&
      dl.rec.factory_calls === 0 && im.rec.factory_calls === 0 && MOCK.state.counts.coverage === 0 &&
      stateFileCount() === before && lockFiles().length === 0 && HTTP_LOG.length === httpBefore,
      JSON.stringify({ a: r1.reason, b: r2.reason, coverage_calls: MOCK.state.counts.coverage, state_files: stateFileCount() }));
  }

  // ============================================================ p3 零数据正向路径（fake 下载 + fake 导入 + fake 覆盖）
  {
    const bd = D(3);
    // This exactly models the deployed coverage provider for an empty date:
    // static safety flags remain false, but has_records=false is authoritative.
    MOCK.reset(); MOCK.mode('zero_with_static_flags');
    const dl = makeDownloadFake('ok'); const im = makeImportFake('ok');
    const t0 = TIMER_CREATIONS;
    const res = await runOnce(runnerFor({ deps: { adapterFactories: { download: dl.factory, import: im.factory } } }), { businessDate: bd, workerId: 'w-ok', idempotencyKey: 'sync:' + bd });
    const timers = TIMER_CREATIONS - t0;
    ck('p3a 零数据日期：has_records=false 即使 safe_to_skip_sync/report_eligible=false，仍通过 G1/G3 并完成数据链路；download=1/import=1/push=0，覆盖接口恰好 2 次只读 GET',
      res.ok === true && res.action === 'COMPLETED' && res.push_calls === 0 && res.data_only === true &&
      res.stage_calls && res.stage_calls.download === 1 && res.stage_calls.import === 1 &&
      dl.rec.factory_calls === 1 && dl.rec.run_calls === 1 && im.rec.factory_calls === 1 && im.rec.run_calls === 1 &&
      MOCK.state.counts.coverage === 2 && MOCK.state.counts.other === 0 &&
      MOCK.state.all_requests.every((x) => x.path === COVERAGE_PATH && x.method === 'GET' && x.hmac_ok),
      JSON.stringify({ ok: res.ok, action: res.action, stage_calls: res.stage_calls, push_calls: res.push_calls, coverage_calls: MOCK.state.counts.coverage, other_paths: MOCK.state.counts.other }));
    ck('p3b 业务日期贯穿全链路：download.run 与 import.runOnce 收到同一 businessDate / report_type=cashier_composite；导入侧拿到下载证据（archive/task/validation）',
      dl.rec.run_args.length === 1 && dl.rec.run_args[0].business_date === bd && dl.rec.run_args[0].report_type === 'cashier_composite' &&
      im.rec.seen.length === 1 && im.rec.seen[0].business_date === bd && im.rec.seen[0].download_ok === true &&
      im.rec.seen[0].archive_bd === bd && im.rec.seen[0].task_bd === bd && im.rec.seen[0].validation_ok === true && im.rec.seen[0].g3_ok === true,
      JSON.stringify({ dl: dl.rec.run_args[0], im: im.rec.seen[0] }));
    ck('p3c 覆盖接口请求体/查询串严格为只读 GET ?business_date=YYYY-MM-DD（无其它参数、无 POST、无其它路径），且 HMAC 全部合法',
      MOCK.state.requests.length === 2 && MOCK.state.requests.every((x) => Object.keys(x.query).length === 1 && x.query.business_date === bd && x.body_raw === '') &&
      MOCK.state.counts.wrong_method === 0 && MOCK.state.counts.hmac_fail === 0,
      JSON.stringify({ requests: MOCK.state.requests.length, methods: MOCK.state.requests.map((x) => x.method), keys: MOCK.state.requests.map((x) => Object.keys(x.query).join(',')) }));
    ck('p3d 全链路后落 workflow 状态文件（终态 success / phase COMPLETED），且不残留任何锁；本用例运行期间创建的定时器 = 0',
      stateFileCount() > 0 && lockFiles().length === 0 && timers === 0,
      JSON.stringify({ state_files: stateFileCount(), locks: lockFiles().length, timers: timers }));
    // 幂等：同一 runner 再跑一次同日期（workflow 已是 success）⇒ 不重复下载/导入
    const res2 = await runOnce(runnerFor({ deps: { adapterFactories: { download: dl.factory, import: im.factory } } }), { businessDate: bd });
    ck('p3e 重复触发同一业务日期：workflow 已 success ⇒ 0 阶段调用（download/import 各仍为 1 次，绝不重复下载/重复导入）；runner 原样透传既有 reason workflow_already_completed（worker 层据此落 success=already_success）',
      res2.ok === false && res2.reason === 'workflow_already_completed' &&
      res2.stage_calls.download === 0 && res2.stage_calls.import === 0 && res2.push_calls === 0 &&
      dl.rec.run_calls === 1 && im.rec.run_calls === 1,
      JSON.stringify({ ok: res2.ok, reason: res2.reason, stage_calls: res2.stage_calls, download_calls: dl.rec.run_calls, import_calls: im.rec.run_calls }));
  }

  // ============================================================ p4 G1 覆盖命中 ⇒ 既有数据不可核验 ⇒ WAITING_HUMAN（阶段 1 冻结语义）
  {
    const bd = D(4);
    // Existing data with the same static safety flags is still a G1 hit and
    // must not be downloaded or imported in Phase 1.
    MOCK.reset(); MOCK.mode('covered_with_static_flags');
    const dl = makeDownloadFake('ok'); const im = makeImportFake('ok');
    const before = stateFileCount();
    const t0 = TIMER_CREATIONS;
    const res = await runOnce(runnerFor({ deps: { adapterFactories: { download: dl.factory, import: im.factory } } }), { businessDate: bd, workerId: 'w-g1', idempotencyKey: 'sync:' + bd });
    const cls = WORKER.classifyRunnerResult(res);
    ck('p4  has_records=true（即使 safe_to_skip_sync/report_eligible=false）⇒ G1 覆盖命中并 WAITING_HUMAN：零下载、零导入、零推送、零状态新增、零锁、零定时器，覆盖接口恰好 1 次只读 GET',
      res.ok === false && res.reason === 'coverage_integrity_unverified' &&
      res.action === 'WAITING_HUMAN' && res.requires_human === true && cls.status === 'waiting_human' &&
      res.side_effects === false && res.push_calls === 0 && res.stage_calls.download === 0 && res.stage_calls.import === 0 &&
      dl.rec.factory_calls === 0 && dl.rec.run_calls === 0 && dl.rec.exported === false && im.rec.factory_calls === 0 && im.rec.run_calls === 0 &&
      MOCK.state.counts.coverage === 1 && stateFileCount() === before && lockFiles().length === 0 && (TIMER_CREATIONS - t0) === 0,
      JSON.stringify({ ok: res.ok, reason: res.reason, action: res.action, requires_human: res.requires_human, worker: cls.status, coverage_calls: MOCK.state.counts.coverage, download_calls: dl.rec.run_calls, import_calls: im.rec.run_calls, state_files: stateFileCount() }));
    ck('p4b worker 侧闭合：coverage_integrity_unverified（requires_human）落 waiting_human（**非 success** ⇒ 09:00 日报闸门判 sync_not_succeeded、零推送）；已删除的旧语义 coverage_verified_existing / coverage_already_imported 在生产 runner 源码中均不存在',
      cls.status === 'waiting_human' && cls.reason === 'coverage_integrity_unverified' &&
      stripComments(readSrc('app/src/phase3/production-sync-runner.js')).indexOf('coverage_verified_existing') < 0 &&
      stripComments(readSrc('app/src/phase3/production-sync-runner.js')).indexOf('coverage_already_imported') < 0,
      JSON.stringify({ worker: cls.status + ':' + cls.reason }));
  }
  // ============================================================ p5 G3 覆盖命中 ⇒ 保守拒绝且零导入
  {
    const bd = D(5);
    MOCK.reset(); MOCK.mode('covered_from_2');
    const dl = makeDownloadFake('ok'); const im = makeImportFake('ok');
    const res = await runOnce(runnerFor({ deps: { adapterFactories: { download: dl.factory, import: im.factory } } }), { businessDate: bd });
    ck('p5  G3 覆盖命中（下载后复查发现已被导入）⇒ 保守拒绝 g3_coverage_gate_hit：download=1 / import=0、push_calls=0、导入 runOnce 零调用（绝不重复导入；导入工厂仅在装配期构造）',
      res.ok === false && res.reason === 'g3_coverage_gate_hit' && res.push_calls === 0 &&
      res.stage_calls.download === 1 && res.stage_calls.import === 0 &&
      dl.rec.run_calls === 1 && im.rec.run_calls === 0 && im.rec.factory_calls === 1 &&
      MOCK.state.counts.coverage === 2,
      JSON.stringify({ ok: res.ok, reason: res.reason, stage_calls: res.stage_calls, coverage_calls: MOCK.state.counts.coverage, import_calls: im.rec.run_calls }));
  }

  // ============================================================ p6 各阶段失败 ⇒ 对应拒绝 + 零后续动作
  {
    const bd = D(6);
    MOCK.reset(); MOCK.mode('not_covered');
    const dl = makeDownloadFake('fail'); const im = makeImportFake('ok');
    const r = await runOnce(runnerFor({ deps: { adapterFactories: { download: dl.factory, import: im.factory } } }), { businessDate: bd });
    ck('p6a 下载失败 ⇒ 拒绝 download_failed：download=1 / import=0、导入 runOnce 零调用（零后续动作）、push_calls=0',
      r.ok === false && r.reason === 'download_failed' && r.stage_calls.download === 1 && r.stage_calls.import === 0 &&
      r.push_calls === 0 && im.rec.run_calls === 0,
      JSON.stringify({ reason: r.reason, stage_calls: r.stage_calls, import_calls: im.rec.run_calls }));
  }
  {
    const bd = D(7);
    MOCK.reset(); MOCK.mode('not_covered');
    const dl = makeDownloadFake('ok'); const im = makeImportFake('fail');
    const r = await runOnce(runnerFor({ deps: { adapterFactories: { download: dl.factory, import: im.factory } } }), { businessDate: bd });
    ck('p6b 导入失败 ⇒ 拒绝 import_failed：download=1 / import=1、push_calls=0、导入恰好 1 次 HTTP 语义（不重试）',
      r.ok === false && r.reason === 'import_failed' && r.stage_calls.download === 1 && r.stage_calls.import === 1 &&
      r.push_calls === 0 && im.rec.run_calls === 1,
      JSON.stringify({ reason: r.reason, stage_calls: r.stage_calls, import_calls: im.rec.run_calls }));
  }
  {
    const bd = D(8);
    MOCK.reset(); MOCK.mode('not_covered');
    const dl = makeDownloadFake('ok'); const im = makeImportFake('waiting');
    const r = await runOnce(runnerFor({ deps: { adapterFactories: { download: dl.factory, import: im.factory } } }), { businessDate: bd });
    ck('p6c 导入结果未知（WAITING_HUMAN）⇒ 拒绝且转人工（import_waiting_human），push_calls=0，绝不重试导入',
      r.ok === false && String(r.reason) === 'import_waiting_human' && r.action === 'WAITING_HUMAN' && r.push_calls === 0 && im.rec.run_calls === 1,
      JSON.stringify({ reason: r.reason, action: r.action, import_calls: im.rec.run_calls }));
  }
  {
    const bd = D(9);
    MOCK.reset(); MOCK.mode('http500');
    const dl = makeDownloadFake('ok'); const im = makeImportFake('ok');
    const before = stateFileCount(); const httpBefore = HTTP_LOG.length;
    const r = await runOnce(runnerFor({ deps: { adapterFactories: { download: dl.factory, import: im.factory } } }), { businessDate: bd });
    ck('p6d G1 覆盖查询失败（中控 500）⇒ fail-closed 拒绝 g1_coverage_gate_failed：零下载、零导入、零状态文件、零锁',
      r.ok === false && r.reason === 'g1_coverage_gate_failed' && r.side_effects === false && r.push_calls === 0 &&
      dl.rec.factory_calls === 0 && im.rec.factory_calls === 0 &&
      MOCK.state.counts.coverage === 1 && HTTP_LOG.length === httpBefore + 1 &&
      stateFileCount() === before && lockFiles().length === 0,
      JSON.stringify({ reason: r.reason, coverage_calls: MOCK.state.counts.coverage, state_files: stateFileCount() }));
  }
  {
    const bd = D(10);
    MOCK.reset(); MOCK.mode('timeout');
    const dl = makeDownloadFake('ok'); const im = makeImportFake('ok');
    const r = await runOnce(runnerFor({ deps: { adapterFactories: { download: dl.factory, import: im.factory }, timeoutMs: 400 } }), { businessDate: bd });
    ck('p6e G1 覆盖查询超时（结果未知）⇒ 同样 fail-closed 拒绝，且**绝不重试**（覆盖接口请求恰好 1 次）',
      r.ok === false && r.reason === 'g1_coverage_gate_failed' && MOCK.state.counts.coverage === 1 && dl.rec.factory_calls === 0,
      JSON.stringify({ reason: r.reason, coverage_calls: MOCK.state.counts.coverage }));
  }
  {
    const bd = D(11);
    MOCK.reset(); MOCK.mode('bad_body');
    const dl = makeDownloadFake('ok'); const im = makeImportFake('ok');
    const r1 = await runOnce(runnerFor({ deps: { adapterFactories: { download: dl.factory, import: im.factory } } }), { businessDate: bd });
    MOCK.mode('date_mismatch');
    const r2 = await runOnce(runnerFor({ deps: { adapterFactories: { download: dl.factory, import: im.factory } } }), { businessDate: bd });
    MOCK.mode('inconsistent');
    const r3 = await runOnce(runnerFor({ deps: { adapterFactories: { download: dl.factory, import: im.factory } } }), { businessDate: bd });
    MOCK.mode('legacy_covered_only');
    const r4 = await runOnce(runnerFor({ deps: { adapterFactories: { download: dl.factory, import: im.factory } } }), { businessDate: bd });
    ck('p6f 覆盖应答非法（has_records 缺失/非布尔、business_date 不一致、covered 与 has_records 冲突、或遗留 covered-only）⇒ 一律 fail-closed 拒绝；不得把看不懂或互相矛盾的存在性信息当成未覆盖',
      r1.ok === false && r1.reason === 'g1_coverage_gate_failed' && r2.ok === false && r2.reason === 'g1_coverage_gate_failed' &&
      r3.ok === false && r3.reason === 'g1_coverage_gate_failed' && r4.ok === false && r4.reason === 'g1_coverage_gate_failed' && dl.rec.factory_calls === 0,
      JSON.stringify({ bad_body: r1.reason, date_mismatch: r2.reason, inconsistent: r3.reason, legacy_covered_only: r4.reason }));
  }
  {
    const bd = D(11);
    MOCK.reset(); MOCK.mode('report_ineligible');
    const dl = makeDownloadFake('ok'); const im = makeImportFake('ok');
    const r = await runOnce(runnerFor({ deps: { adapterFactories: { download: dl.factory, import: im.factory } } }), { businessDate: bd });
    ck('p6h has_records=true 且仅 report_eligible=false（safe_to_skip_sync=true）⇒ 同样 G1 完整性不可核验并 WAITING_HUMAN，零下载、零导入、零推送',
      r.ok === false && r.reason === 'coverage_integrity_unverified' && r.action === 'WAITING_HUMAN' &&
      r.stage_calls.download === 0 && r.stage_calls.import === 0 && r.push_calls === 0 &&
      dl.rec.factory_calls === 0 && im.rec.factory_calls === 0 && MOCK.state.counts.coverage === 1,
      JSON.stringify({ reason: r.reason, action: r.action, download_factory_calls: dl.rec.factory_calls, import_factory_calls: im.rec.factory_calls }));
  }
  {
    const bd = D(12);
    MOCK.reset(); MOCK.mode('not_covered');
    const dl = makeDownloadFake('ok'); const im = makeImportFake('ok');
    const r = await runOnce(runnerFor({ secretFile: WRONG_SECRET_FILE, deps: { adapterFactories: { download: dl.factory, import: im.factory } } }), { businessDate: bd });
    ck('p6g 覆盖接口 HMAC 校验失败（401）⇒ fail-closed 拒绝 g1_coverage_gate_failed；mock 侧确认签名不合法、零下载',
      r.ok === false && r.reason === 'g1_coverage_gate_failed' && MOCK.state.counts.hmac_fail === 1 && dl.rec.factory_calls === 0,
      JSON.stringify({ reason: r.reason, hmac_fail: MOCK.state.counts.hmac_fail }));
  }

  // ============================================================ p7 报表 B / 依赖缺失
  {
    const bd = D(13);
    MOCK.reset(); MOCK.mode('not_covered');
    const dl = makeDownloadFake('ok'); const im = makeImportFake('ok');
    const before = stateFileCount(); const httpBefore = HTTP_LOG.length;
    const r1 = await runOnce(runnerFor({ reportType: 'item_sales_detail', deps: { adapterFactories: { download: dl.factory, import: im.factory } } }), { businessDate: bd });
    const r2 = await runOnce(runnerFor({ deps: { adapterFactories: { download: dl.factory, import: im.factory } } }), { businessDate: bd, reportType: 'item_sales_detail' });
    const r3 = await runOnce(RUNNER, { businessDate: bd, report_type: 'item_sales_detail' });
    ck('p7a 报表 B（item_sales_detail）在三个入口（createRunner 指定 / runOnce 参数 / 模块默认 runner）**一律拒绝** report_b_locked，零 HTTP、零工厂、零状态文件',
      r1.ok === false && r1.reason === 'report_b_locked' && r2.ok === false && r2.reason === 'report_b_locked' && r3.ok === false && r3.reason === 'report_b_locked' &&
      MOCK.state.counts.coverage === 0 && MOCK.state.counts.other === 0 && dl.rec.factory_calls === 0 && im.rec.factory_calls === 0 &&
      stateFileCount() === before && HTTP_LOG.length === httpBefore && lockFiles().length === 0,
      JSON.stringify({ a: r1.reason, b: r2.reason, c: r3.reason, coverage_calls: MOCK.state.counts.coverage, http: HTTP_LOG.length - httpBefore }));
    ck('p7b 模块默认 runner 恒声明 report_type=cashier_composite + data_only=true；mock 从未收到含 item_sales_detail 的请求',
      RUNNER.report_type === 'cashier_composite' && RUNNER.data_only === true &&
      PLAN.containsLockedReport({ report_type: 'item_sales_detail' }) === true &&
      MOCK.state.all_requests.every((x) => x.body_raw.indexOf('item_sales_detail') < 0 && String(x.query.business_date || '').indexOf('item_sales_detail') < 0),
      JSON.stringify({ report_type: RUNNER.report_type, data_only: RUNNER.data_only }));
    const r4 = await runOnce(runnerFor({ deps: { downloadDeps: { client: {}, flow: {} }, adapterFactories: undefined } }), { businessDate: bd });
    ck('p7c download 真实依赖缺失（注入不完整的 downloadDeps）⇒ fail-closed 拒绝 download_adapter_deps_missing，零副作用（无 HTTP、无状态文件、无工厂调用）',
      r4.ok === false && r4.reason === 'download_adapter_deps_missing' && r4.side_effects === false && r4.push_calls === 0 &&
      Array.isArray(r4.missing) && r4.missing.indexOf('approvals') >= 0 && r4.missing.indexOf('rules') >= 0 && r4.missing.indexOf('selectors') >= 0 &&
      MOCK.state.counts.coverage === 0 && stateFileCount() === before && HTTP_LOG.length === httpBefore,
      JSON.stringify({ reason: r4.reason, missing: r4.missing, coverage_calls: MOCK.state.counts.coverage }));
  }

  // ============================================================ p8 静态自检
  {
    const wfSrc = readSrc('app/src/phase3/workflow-run.js');
    const hits = WFP.scanForbiddenCalls(wfSrc);
    ck('p8a 静态自检：workflow-run.js（去注释后的可执行代码）中禁止调用扫描 scanForbiddenCalls 仍为 0 命中；生产适配器白名单仍只有 download/import（无 push）',
      wfSrc.length > 0 && hits.length === 0 &&
      JSON.stringify(WFP.ADAPTER_KEYS) === JSON.stringify(['download', 'import']) &&
      typeof WFP.ADAPTER_CALL_WHITELIST.push === 'undefined',
      JSON.stringify({ hits: hits.map((h) => h.name), adapter_keys: WFP.ADAPTER_KEYS, push_whitelisted: typeof WFP.ADAPTER_CALL_WHITELIST.push !== 'undefined' }));

    const newSrc = readSrc('app/src/phase3/production-sync-runner.js');
    const code = stripComments(newSrc);
    const RULES = [
      ['push_channel_module', /require\(\s*['"][^'"]*push-(?:run|client)[^'"]*['"]\s*\)/],
      ['bot_channel', /qyapi\.weixin\.qq\.com|corpsecret|corpid|webhook|sendMessage|sendTextMessage/i],
      ['credential_read', /\b(?:cookie|password|jwt|token)\b/i],
      ['auth_header', /Authorization\s*:/],
      ['real_scheduler', /require\(\s*['"](?:cron|node-cron|node-schedule)['"]\s*\)|new\s+CronJob\b|setInterval\b|crontab\b|systemd-run\b/],
      ['non_loopback_url', /https?:\/\/(?!127\.0\.0\.1)/],
    ];
    const bad = RULES.filter((x) => x[1].test(code)).map((x) => x[0]);
    const timerHits = (code.match(/\bsetTimeout\b/g) || []).length;
    ck('p8b 新文件静态自检：不 require 任何 push 模块、无 webhook/企业微信/凭据字样、无 Authorization、无 setInterval/真实调度创建、无任何非回环 URL 字面量；唯一延时是下载文件到达轮询（setTimeout 恰好 1 处，非调度器）',
      newSrc.length > 0 && bad.length === 0 && timerHits === 1,
      JSON.stringify({ violations: bad, setTimeout_hits: timerHits }));
    const rawHits = WFP.scanForbiddenCalls(newSrc);
    const names = Array.from(new Set(rawHits.map((h) => h.name))).sort();
    ck('p8c 透明记录：workflow 专用禁用规则集对**新文件**的残留命中只允许是 {project_file_write, timer}（前者=审批文件落盘所需的 fs 写；后者=下载到达轮询的 setTimeout 与 ../schedule/* 模块路径），绝不允许出现 browser/database/webhook/credentials/push 模块',
      names.length > 0 && names.every((n) => n === 'project_file_write' || n === 'timer') &&
      rawHits.every((h) => h.name !== 'browser' && h.name !== 'database' && h.name !== 'webhook_direct' && h.name !== 'credentials' && h.name !== 'push_channel_module'),
      JSON.stringify({ residue_rules: names.join(',') }));
    ck('p8d 静态自检：zk-client 只允许 http://127.0.0.1:3456（生产不接受覆盖），两个只读接口路径与契约 §2.2/§G.6 一致，且仍是"单次请求、绝不重试"',
      ZK.DEFAULT_HOST === '127.0.0.1' && ZK.DEFAULT_PORT === 3456 && ZK.PATHS.coverage === '/api/internal/syncbot/coverage' &&

      typeof ZK.createZkClient({ base: 'http://127.0.0.1:3456' }).importedSummary === 'function' &&
      /allowTestBase/.test(readSrc('app/src/schedule/zk-client.js')) &&
      ZK.assertBase('http://10.0.0.9:3456').ok === false && ZK.assertBase('http://127.0.0.1:3456').ok === true &&
      ZK.assertBase('https://127.0.0.1:3456').ok === false && ZK.assertBase('http://127.0.0.1:8080').ok === false,
      JSON.stringify({ host: ZK.DEFAULT_HOST, port: ZK.DEFAULT_PORT, coverage: ZK.PATHS.coverage }));
  }

  // ============================================================ p9 泄漏扫描
  {
    const files = stateFiles().filter((f) => f.endsWith('.json'));
    const bodiesRaw = MOCK.state.all_requests.map((x) => x.body_raw + '|' + JSON.stringify(x.query));
    const outputs = OUTPUTS.join('\n');
    let allState = '';
    for (const f of files) { try { allState += fs.readFileSync(f, 'utf8') + '\n'; } catch (e) {} }
    const allBodies = bodiesRaw.join('\n');
    const LEAK = [
      ['jwt', /eyJ[A-Za-z0-9_-]{10,}\./],
      ['bot_hook_url', /https?:\/\/qyapi\.weixin\.qq\.com\//i],
      ['bot_key', /key=[A-Za-z0-9-]{8,}/],
      ['auth_header', /Bearer\s+[A-Za-z0-9._-]{10,}/],
      ['password_field', /"password"\s*:\s*"[^"]+"/],
      ['cookie_field', /"cookie"\s*:\s*"[^"]+"/i],
      ['complete_sha256', /[0-9a-f]{64}/i],
      ['abs_path_nix', /\/(?:home|opt|etc|var|root|usr)\//],
      ['abs_path_win', /[A-Za-z]:[\\/]/],
    ];
    const leaks = [];
    for (const kv of LEAK) {
      if (kv[1].test(allState)) leaks.push('state:' + kv[0]);
      if (kv[1].test(allBodies)) leaks.push('http_body:' + kv[0]);
      if (kv[1].test(outputs)) leaks.push('output:' + kv[0]);
    }
    if (allState.indexOf(SECRET) >= 0) leaks.push('state:hmac_secret');
    if (allBodies.indexOf(SECRET) >= 0) leaks.push('http_body:hmac_secret');
    if (outputs.indexOf(SECRET) >= 0) leaks.push('output:hmac_secret');
    ck('p9  状态文件 / HTTP 请求体 / 套件输出：无凭据、无企业微信 hook、无 Authorization/Cookie、无完整 SHA（摘要只允许 12 位前缀）、无绝对路径、无 HMAC 密钥',
      leaks.length === 0, JSON.stringify({ leaks: leaks.slice(0, 8), scanned: files.length, bodies: bodiesRaw.length }));
  }

  // ============================================================ p10 自证
  {
    const dests = Array.from(new Set(HTTP_LOG.map((x) => x.host + ':' + x.port)));
    const onlyMock = HTTP_LOG.length > 0 && HTTP_LOG.every((x) => x.host === '127.0.0.1' && x.port === MOCK.port);
    const cacheKeys = Object.keys(require.cache).map((k) => k.split(path.sep).join('/'));
    const loaded = {
      push_channel: cacheKeys.filter((k) => /push-(run|client)\.js$/.test(k)).length,
      importer_client: cacheKeys.filter((k) => /phase3\/import-client\.js$/.test(k)).length,
      real_download_adapters: cacheKeys.filter((k) => /phase2\/real-download-adapters\.js$/.test(k)).length,
      browser_stack: cacheKeys.filter((k) => /playwright|puppeteer|chromium/i.test(k)).length,
      host_server: cacheKeys.filter((k) => /phase2\/host-server\.js$/.test(k)).length,
    };
    ck('p10a 自证（离线）：全部出站 HTTP 目的地均为 127.0.0.1:<mock 端口>（未访问美团、无任何外部主机）；https.request 调用 0 次',
      onlyMock && HTTPS_CALLS === 0 && MOCK.state.counts.other === 0,
      JSON.stringify({ destinations: dests, https_calls: HTTPS_CALLS, other_paths: MOCK.state.counts.other }));
    ck('p10b 自证（无真实能力被装载）：未 require 任何 push 模块、未 require 导入 HTTP 客户端、未 require 真实下载适配器、未装载浏览器栈/host-server',
      loaded.push_channel === 0 && loaded.importer_client === 0 && loaded.real_download_adapters === 0 && loaded.browser_stack === 0 && loaded.host_server === 0,
      JSON.stringify(loaded));
    const allPushZero = OUTPUTS.length > 0 && OUTPUTS.every((s) => {
      try { const j = JSON.parse(s); return Number(j.push_calls || 0) === 0 && !j.sent && !j.push; } catch (e) { return false; }
    });
    ck('p10c 自证（无副作用）：未真实导出/下载/导入/推送、未读任何凭据、未创建任何定时器/计划任务；全部结果 push_calls 恒为 0（含 G1 命中核验的全部情形）',
      out.real_export === false && out.real_download === false && out.real_import === false &&
      out.real_wecom_message_sent === false && out.real_webhook_read === false && out.timers_created === false &&
      allPushZero,
      JSON.stringify({ results: OUTPUTS.length, push_all_zero: allPushZero, timers_counted: TIMER_CREATIONS }));
  }

  // ============================================================ p16 v0.3.3 金额证据与口径（冻结白名单）
  {
    const IA = require(BOT + '/app/src/phase3/import-audit.js');
    const BASIS = { scope: 'import_batch_id', mappings: [ { file_column: '营业收入(元)', db_column: 'recorded_amount' }, { file_column: '营业额(元)', db_column: 'gross_amount' }, { file_column: '优惠金额(元)', db_column: 'discount_amount' } ] };
    const base = { excel_business_date: '2026-09-22', raw_imported: 22, matched_stores: 22, imported: 110, errors: [], amount_excel: 75997.23, amount_db: 75997.23, import_batch_id: 180, sha256: 'a'.repeat(64), amount_basis: BASIS };
    const exp = { raw_imported: 22, matched_stores: 22, imported: null };
    const v = (o) => IA.verifyImportResult(Object.assign({}, base, o), exp, '2026-09-22');
    const okRes = v({});
    ck('p16a 同口径（scope=import_batch_id）delta=0 ⇒ 通过', okRes.ok === true && okRes.problems.length === 0, JSON.stringify(okRes.problems));
    const miss = v({ amount_excel: null, amount_db: null });
    ck('p16b amount_missing ⇒ fail-closed', miss.ok === false && miss.problems.indexOf('amount_missing') >= 0, JSON.stringify(miss.problems));
    const noBasis = v({ amount_basis: null });
    ck('p16c basis 缺失 ⇒ amount_basis_mismatch（fail-closed）', noBasis.ok === false && noBasis.problems.indexOf('amount_basis_mismatch') >= 0, JSON.stringify(noBasis.problems));
    const dateScope = v({ amount_basis: { scope: 'biz_date', mappings: BASIS.mappings } });
    ck('p16d 日期级 scope（会混入 39 条外部团购数据）⇒ amount_basis_mismatch，绝不误通过', dateScope.ok === false && dateScope.problems.indexOf('amount_basis_mismatch') >= 0, JSON.stringify(dateScope.problems));
    const wrong = v({ amount_basis: { scope: 'import_batch_id', mappings: [ { file_column: '营业收入(元)', db_column: 'gross_amount' } ] } });
    ck('p16e 非白名单映射（跨列猜测）⇒ amount_basis_mismatch', wrong.ok === false && wrong.problems.indexOf('amount_basis_mismatch') >= 0, JSON.stringify(wrong.problems));
    const noBatch = v({ import_batch_id: null });
    ck('p16f 缺 batch_id ⇒ batch_id_missing（fail-closed）', noBatch.ok === false && noBatch.problems.indexOf('batch_id_missing') >= 0, JSON.stringify(noBatch.problems));
    const over = v({ amount_db: 75997.30 });
    ck('p16g delta=0.07 > 0.01 ⇒ amount_mismatch（fail-closed）', over.ok === false && String(over.problems.join(',')).indexOf('amount_mismatch') >= 0, JSON.stringify(over.problems));
    const tol = v({ amount_db: 75997.231 });
    ck('p16h 容差内（delta<=0.01）⇒ 通过', tol.ok === true, JSON.stringify(tol.problems));
    const scopes = v({ interface_row_count: 154, db_row_count: 149 });
    ck('p16i 22 门店行 / 110 batch 明细 / 154 interface_row_count 三种口径不要求相等', scopes.ok === true, JSON.stringify(scopes.problems));
  }

  // ============================================================ p14 v0.3.2 直接下载（无站内确认弹窗）
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p14-dl-'));
    try {
      fs.writeFileSync(path.join(tmp, 'old-report-a.xlsx'), Buffer.alloc(100, 1));
      fs.writeFileSync(path.join(tmp, 'pending.crdownload'), Buffer.alloc(100, 2));
      fs.writeFileSync(path.join(tmp, 'new-report-a.xlsx'), Buffer.alloc(25179, 3));
      const got = await RUNNER.defaultWaitForDownloadFile({ dir: tmp, timeoutMs: 3000, pollMs: 20, startedAt: 0, excludeNames: ['old-report-a.xlsx', 'pending.crdownload'], stablePolls: 2 });
      ck('p14a 直接下载：只接受本轮新增且大小稳定的完整 xlsx（旧 xlsx 与 .crdownload 一律排除）',
        got.ok === true && got.name === 'new-report-a.xlsx' && got.size === 25179 && Number(got.stable_polls) >= 2, JSON.stringify(got));
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'p14-dl2-'));
      try {
        fs.writeFileSync(path.join(tmp2, 'old-only.xlsx'), Buffer.alloc(25179, 4));
        const miss = await RUNNER.defaultWaitForDownloadFile({ dir: tmp2, timeoutMs: 300, pollMs: 20, startedAt: 0, excludeNames: ['old-only.xlsx'], stablePolls: 2 });
        ck('p14b 直接下载：export 前已存在的文件绝不误认成本轮产物（excludeNames 生效 ⇒ 超时 fail-closed）',
          miss.ok === false && miss.reason === 'wait_download_file_timeout', JSON.stringify(miss));
      } finally { try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch (e) {} }
      const legacy = await RUNNER.defaultWaitForDownloadFile({ dir: tmp, timeoutMs: 500, pollMs: 20, startedAt: 0 });
      ck('p14c 多个候选文件必须拒绝猜选，即使未指定排除项', legacy.ok === false && legacy.reason === 'ambiguous_new_download_files' && legacy.candidate_count === 2, JSON.stringify(legacy));
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }

    const bd = D(14);
    MOCK.reset(); MOCK.mode('not_covered');
    const dl = makeDownloadFake('direct_download_not_observed'); const im = makeImportFake('ok');
    const r = await runOnce(runnerFor({ deps: { adapterFactories: { download: dl.factory, import: im.factory } } }), { businessDate: bd });
    ck('p14d 无确认弹窗且无新完整文件 ⇒ 汇总 WAITING_HUMAN / download=1 / import=0 / push=0，reason=download_failed:export_direct_download:export_direct_download_not_observed',
      r.ok === false && r.action === 'WAITING_HUMAN' && r.stage_calls.download === 1 && r.stage_calls.import === 0 && r.push_calls === 0 &&
      String(r.reason).indexOf('download_failed') === 0 && r.failure_stage === 'export_direct_download' && r.failure_reason === 'export_direct_download_not_observed' &&
      im.rec.run_calls === 0,
      JSON.stringify({ ok: r.ok, action: r.action, reason: r.reason, stage_calls: r.stage_calls, push_calls: r.push_calls, failure_stage: r.failure_stage, failure_reason: r.failure_reason, import_calls: im.rec.run_calls }));
    const mapped = RUNNER.mapDownloadResult({ ok: true, result: 'FILE_VALIDATED', archived: { path: '/tmp/a.xlsx', name: 'a.xlsx', sha256: 'a'.repeat(64), size: 1 }, validation: { ok: true }, confirmation_mode: 'absent_direct_download' },
      { taskId: 't', reportType: 'cashier_composite', platform: 'meituan', businessDate: bd });
    ck('p14e confirmation_mode 透传到下载结果（absent_direct_download）', mapped.confirmation_mode === 'absent_direct_download', String(mapped.confirmation_mode));
  }

  // ============================================================ p13 下载失败阶段/原因透传（导出确认弹窗修复）
  {
    const CTX_D = { taskId: 'sched:meituan:cashier_composite:2026-09-22', reportType: 'cashier_composite', platform: 'meituan', businessDate: '2026-09-22' };
    const stale = RUNNER.mapDownloadResult({
      ok: false, result: 'FAILED', phases_final: 'FAILED', export_submitted_at: '2026-09-23T10:11:32.000Z',
      failure_stage: 'export_dialog_confirm', failure_reason: 'export_dialog_confirm_stale',
      export_submitted_uncertain: true, confirm_click_calls: 1, download_calls: 0,
    }, CTX_D);
    ck('p13a 导出确认失败：failure_stage/failure_reason 透传（不再只留 download_FAILED）',
      stale.failure_stage === 'export_dialog_confirm' && stale.failure_reason === 'export_dialog_confirm_stale',
      JSON.stringify({ stage: stale.failure_stage, reason: stale.failure_reason }));
    ck('p13b 已点击导出 ⇒ export_submitted=true 且 export_submitted_uncertain=true（重跑不得再点导出）',
      stale.export_submitted === true && stale.export_submitted_uncertain === true,
      JSON.stringify({ export_submitted: stale.export_submitted, uncertain: stale.export_submitted_uncertain }));
    ck('p13c 确认点击次数透传=1、下载调用=0', stale.confirm_click_calls === 1 && stale.download_calls === 0,
      JSON.stringify({ confirm_click_calls: stale.confirm_click_calls, download_calls: stale.download_calls }));
    const notFound = RUNNER.mapDownloadResult({ ok: false, result: 'FAILED', export_submitted_at: 'x', failure_stage: 'export_dialog_confirm', failure_reason: 'export_dialog_confirm_not_found' }, CTX_D);
    ck('p13d not_found 码同样透传', notFound.failure_reason === 'export_dialog_confirm_not_found', String(notFound.failure_reason));
    const rejected = RUNNER.mapDownloadResult({ ok: false, result: 'FAILED', export_submitted_at: 'x', failure_stage: 'export_dialog_confirm', failure_reason: 'export_dialog_confirm_rejected' }, CTX_D);
    ck('p13e rejected 码同样透传', rejected.failure_reason === 'export_dialog_confirm_rejected', String(rejected.failure_reason));
    const legacy = RUNNER.mapDownloadResult({ ok: false, result: 'FAILED', export_submitted_at: null }, CTX_D);
    ck('p13f 无具体码时保持既有 download_<result> 约定（向后兼容）',
      legacy.failure_reason === 'download_FAILED' && legacy.failure_stage === null && legacy.export_submitted_uncertain === false,
      JSON.stringify({ reason: legacy.failure_reason, stage: legacy.failure_stage }));
    const okRes = RUNNER.mapDownloadResult({ ok: true, result: 'FILE_VALIDATED', archived: { path: '/x/a.xlsx', name: 'a.xlsx', sha256: 'a'.repeat(64), size: 1 }, validation: { ok: true } }, CTX_D);
    ck('p13g 成功路径 failure_* 保持 null/false', okRes.failure_stage === null && okRes.failure_reason === null && okRes.export_submitted_uncertain === false,
      JSON.stringify({ stage: okRes.failure_stage, reason: okRes.failure_reason }));
    ck('p13h 状态机 reason 正则兼容：具体码可被 safeReason 原样保留（不含中文/空格/斜杠）',
      RUNNER.safeReason('export_dialog_confirm_stale') === 'export_dialog_confirm_stale' && RUNNER.safeReason('export_dialog_confirm_not_found') === 'export_dialog_confirm_not_found',
      String(RUNNER.safeReason('export_dialog_confirm_stale')));
  }

  // ============================================================ p12 生产装配路径（模块加载 + 只允许回环）
  {
    const modPath = BOT + '/app/src/phase3/production-sync-runner.js';
    const loadedMod = WORKER.loadRunnerFromModule(modPath);
    const resolved = WORKER.resolveSyncRunner({ deps: {}, env: { SYNCBOT_SCHEDULE_SYNC_RUNNER: modPath } });
    const bd = D(14);
    MOCK.reset(); MOCK.mode('not_covered');
    const httpBefore = HTTP_LOG.length;
    const r = await runOnce(loadedMod.ok ? loadedMod.runner : { runOnce: async () => ({}) }, { businessDate: bd });
    ck('p12a 生产模块路径可被调度 worker 加载：loadRunnerFromModule/resolveSyncRunner 均 ok，且声明 report_type=cashier_composite + data_only=true（worker 的报表B/类型守卫因此不会拒绝它）',
      loadedMod.ok === true && loadedMod.runner.report_type === 'cashier_composite' && loadedMod.runner.data_only === true &&
      resolved.ok === true && resolved.runner.report_type === 'cashier_composite' &&
      typeof loadedMod.runner.source === 'string' && loadedMod.runner.source.indexOf('production-sync-runner.js') >= 0,
      JSON.stringify({ loaded: loadedMod.ok, resolved: resolved.ok, source_ok: resolved.ok ? resolved.runner.source.indexOf('production-sync-runner.js') >= 0 : false }));
    ck('p12b 模块路径（无 deps 注入）在 env 未置位时同样 fail-closed（production_adapters_not_enabled），且零出站 HTTP',
      r.ok === false && r.reason === 'production_adapters_not_enabled' && r.side_effects === false &&
      MOCK.state.counts.coverage === 0 && HTTP_LOG.length === httpBefore,
      JSON.stringify({ reason: r.reason, coverage_calls: MOCK.state.counts.coverage, http: HTTP_LOG.length - httpBefore }));
    const nonLoop = await runOnce(runnerFor({ deps: { base: 'http://10.0.0.9:3456' } }), { businessDate: bd });
    ck('p12c 覆盖客户端只允许 http://127.0.0.1:3456：非回环 base（http://10.0.0.9:3456）在**发请求之前**即被拒绝（coverage_client_unavailable:base_host_not_allowed），零副作用',
      nonLoop.ok === false && String(nonLoop.reason).indexOf('coverage_client_unavailable') === 0 &&
      String(nonLoop.reason).indexOf('base_host_not_allowed') > 0 && nonLoop.side_effects === false &&
      MOCK.state.counts.coverage === 0 && HTTP_LOG.length === httpBefore,
      JSON.stringify({ reason: nonLoop.reason, coverage_calls: MOCK.state.counts.coverage }));
  }

  // ============================================================ p11 真实依赖可装载性（只读探针，不执行任何真实动作）
  {
    const dl = RUNNER.resolveDownloadDeps({ deps: {}, env: {}, reportType: 'cashier_composite', platform: 'meituan' });
    const keys = dl.ok ? Object.keys(dl.bundle) : [];
    ck('p11 生产真实依赖装载路径可用（本机只读探针，不执行任何真实动作）：client/flow/approvals/rules/selectors 齐备，且 selectors 以「已绑定注册表」的 1 参 get(key) 注入（签名守卫生效）',
      dl.ok === true && RUNNER.DOWNLOAD_DEP_KEYS.every((k) => keys.indexOf(k) >= 0) &&
      typeof dl.bundle.selectors.get === 'function' && dl.bundle.selectors.get.length === 1 &&
      typeof dl.bundle.approvals.read === 'function' && typeof dl.bundle.approvals.write === 'function' &&
      typeof dl.bundle.archiveFn === 'function' && typeof dl.bundle.validateFileFn === 'function' && typeof dl.bundle.waitForDownloadFile === 'function',
      JSON.stringify({ ok: dl.ok, source: dl.source, keys: keys.join(','), selectors_get_arity: dl.ok ? dl.bundle.selectors.get.length : null }));
  }

  await MOCK.stop();
  out.total = out.checks.length;
  out.failed = out.checks.filter((c) => !c.ok).length;
  out.ok = out.failed === 0;
  out.summary = {
    coverage_calls_total: MOCK.state.total,
    http_destinations: Array.from(new Set(HTTP_LOG.map((x) => x.host + ':' + x.port))),
    https_calls: HTTPS_CALLS,
    timers_created_offline: TIMER_CREATIONS,
    state_files: stateFileCount(),
    locks_left: lockFiles().length,
    report_b: out.report_b,
    push_owner: 'project_daily_report_bot（中控侧 9 点日报推送；syncbot 侧 push_calls 恒为 0）',
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
