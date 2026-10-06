'use strict';
/**
 * 调度 **worker**（契约第 5 节）—— syncbot 侧唯一执行入口
 *
 * tick 流程（冻结）：
 *   读 I1（只读） → 判定同步到期 → 幂等检查（本地 + 中控 claim）
 *   → 执行 → settle
 *
 * 硬约束：
 *  - **sync 执行器是注入式的**（deps.syncRunner；默认从 env SYNCBOT_SCHEDULE_SYNC_RUNNER 指定的模块文件加载）。
 *    未提供 ⇒ 'sync_runner_missing' 拒绝，且**零副作用**（不建状态文件、不写锁、不发 HTTP）。
 *    runner 存在时必须只调用 **data-only workflow**，report_type **恒为 cashier_composite**。
 *  - 日报的触发、生成和发送均归中控；本 worker 不调用 I4。
 *  - 任何 unknown/超时 ⇒ waiting_human，**永不自动重发 / 永不自动重做**。
 *  - 报表 B（item_sales_detail）在任何入口出现一律拒绝（report_b_locked）。
 *  - 本模块**不创建任何 timer/cron**（无 setInterval/setTimeout/cron）。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const LOCK = require('../lock');
const PLAN = require('./plan');
const SSTATE = require('./state');
const ZK = require('./zk-client');

const REPORT_TYPE = PLAN.ALLOWED_REPORT_TYPE;   // 恒为 cashier_composite
const PLATFORM = 'meituan';
const TRIGGER = 'schedule';
const LOCK_PREFIX = 'schedule-';
const DEFAULT_MAX_ATTEMPTS = 3;
/** 中控返回、代表"结果未知"的 reason ⇒ 只能 waiting_human */
const UNKNOWN_REASONS = ['in_flight_unknown', 'push_in_flight_unknown', 'push_timeout_unknown'];
/** runner 声明未携带时必须fail-closed的报表 */
const ABS_PATH_RE = /(^|[\s"'(=])(\/(?:home|opt|etc|var|root|tmp|usr)\/[^\s"')]*)|([A-Za-z]:\\[^\s"')]*)/g;
const REASON_RE = /^[A-Za-z][A-Za-z0-9_.:=-]{0,79}$/;

/** 脱敏：绝对路径 → [path]；只保留机器可读的短代码 */
function sanitizeReason(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).replace(ABS_PATH_RE, '$1[path]');
  return REASON_RE.test(s) ? s : 'unrecognized_reason';
}
/** 深脱敏 detail（复用既有审计脱敏；失败则整体丢弃） */
function safeDetail(value) {
  if (value == null) return null;
  try {
    const R = require('../phase3/audit-reporter.js');
    const s = R.sanitize(value);
    const txt = JSON.stringify(s);
    return txt && txt.length <= 800 ? s : null;
  } catch (e) {
    return null;
  }
}
function safeText(value, max) {
  const s = String(value == null ? '' : value).replace(ABS_PATH_RE, '$1[path]');
  return s.slice(0, max || 80);
}

function defaultWorkerId() {
  return 'syncbot-schedule@' + String(os.hostname() || 'host') + '#' + String(process.pid);
}

/** 统一包装：注入的客户端**永不抛出** */
async function safeCall(fn) {
  try {
    const r = await fn();
    if (!r || typeof r !== 'object') return { ok: false, reason: 'client_bad_response', unknown: true };
    return r;
  } catch (e) {
    return { ok: false, reason: 'client_threw', unknown: true };
  }
}

// ------------------------------------------------------------------ zk 客户端解析
function resolveZkClient({ deps = {}, env = process.env } = {}) {
  const injected = deps.zk || deps.zkClient;
  if (injected && typeof injected.getSchedule === 'function') return { ok: true, client: injected, source: 'injected' };
  const client = ZK.createZkClient({
    base: deps.zkBase || deps.base,
    secretFile: deps.secretFile,
    timeoutMs: deps.timeoutMs,
    allowTestBase: deps.allowTestBase === true || deps.testBase === true,
    env,
  });
  if (client.base_ok !== true) return { ok: false, reason: client.base_reason || 'base_not_allowed', client };
  return { ok: true, client, source: 'created' };
}

// ------------------------------------------------------------------ sync runner 解析
/**
 * 内置 **data-only workflow** runner（生产默认路径之一）：
 * 只装配 createWorkflowRun + 生产适配器（download/import），**不装配任何 push**，report_type 恒为 cashier_composite。
 */
function createWorkflowRunSyncRunner({ deps = {}, env = process.env, logger = null } = {}) {
  return {
    report_type: REPORT_TYPE,
    data_only: true,
    source: 'app/src/phase3/workflow-run.js + phase3/workflow-production-adapters.js（data-only）',
    async runOnce({ businessDate, workerId, idempotencyKey, resumeExisting }) {
      const WFMOD = require('../phase3/workflow-run.js');
      const PROD = require('../phase3/workflow-production-adapters.js');
      const prod = PROD.createWorkflowProductionAdapters({
        enable: env.SYNCBOT_WORKFLOW_PROD_ADAPTERS === '1',
        confirmRealWorkflow: true,
        reportType: REPORT_TYPE,
        businessDate,
        platform: PLATFORM,
        deps: deps.adapterFactories || {},
      });
      // 适配器未显式启用/未齐备 ⇒ fail-closed（**零副作用**：连 workflow 实例都不创建）
      if (!prod.ok) return { ok: false, action: 'REFUSED', reason: prod.reason, side_effects: false, push_calls: 0 };
      const wf = WFMOD.createWorkflowRun({
        reportType: REPORT_TYPE,
        businessDate,
        platform: PLATFORM,
        confirm: true,                                   // 真实运行必须显式 confirm
        production: { enabled: true, adapters: prod.adapters, whitelist: prod.whitelist },
        gates: deps.gates || {},
        taskIdPrefix: 'sched',
        logger,
      });
      const r = await wf.runOnce(resumeExisting === true ? { resumeExisting: true } : {});
      const sc = (r && r.stage_calls) || null;
      const sideEffects = sc ? (Number(sc.download) || 0) + (Number(sc.import) || 0) > 0 : true;
      return {
        ok: r && r.ok === true, action: r && r.action, reason: r && r.reason,
        stage_calls: sc, push_calls: 0, side_effects: sideEffects,
        // 失败阶段/原因透传（脱敏值由 workflow 层给出；下游 CLI 必须能看到，不得只留 download_failed）
        failure_stage: (r && r.failure_stage) || null,
        failure_reason: (r && r.failure_reason) || null,
        idempotency_key: idempotencyKey, worker_id: workerId,
      };
    },
  };
}

/** 从模块文件加载 runner（模块可导出 createRunner() / runOnce / 函数 / {runner}） */
function loadRunnerFromModule(file) {
  const abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  let mod = null;
  try {
    if (!fs.existsSync(abs)) return { ok: false, reason: 'sync_runner_module_unreadable' };
    mod = require(abs);
  } catch (e) {
    return { ok: false, reason: 'sync_runner_module_load_failed' };
  }
  if (mod && typeof mod.createRunner === 'function') {
    try { mod = mod.createRunner({ reportType: REPORT_TYPE, platform: PLATFORM }); } catch (e) { return { ok: false, reason: 'sync_runner_factory_threw' }; }
  }
  if (mod && mod.runner && typeof mod.runner.runOnce === 'function') mod = mod.runner;
  if (mod && typeof mod.runOnce === 'function') return { ok: true, runner: mod };
  if (typeof mod === 'function') return { ok: true, runner: { runOnce: mod } };
  return { ok: false, reason: 'sync_runner_module_shape_invalid' };
}

/**
 * 解析 sync 执行器。
 * @returns {{ok:true, runner:object, source:string}|{ok:false, reason:string, cause?:string}}
 */
function resolveSyncRunner({ deps = {}, env = process.env, logger = null } = {}) {
  const injected = deps.syncRunner;
  if (injected !== undefined && injected !== null) {
    let runner = injected;
    if (typeof injected === 'function') runner = { runOnce: injected };
    if (!runner || typeof runner.runOnce !== 'function') return { ok: false, reason: 'sync_runner_missing', cause: 'sync_runner_shape_invalid' };
    const declared = runner.report_type || runner.reportType || REPORT_TYPE;
    if (PLAN.containsLockedReport(declared)) return { ok: false, reason: 'report_b_locked' };
    if (String(declared) !== REPORT_TYPE) return { ok: false, reason: 'sync_runner_missing', cause: 'sync_runner_report_type_not_allowed' };
    if (runner.data_only !== true && runner.test_double !== true) return { ok: false, reason: 'sync_runner_missing', cause: 'sync_runner_invalid' };
    return { ok: true, runner, source: runner.source || 'injected' };
  }
  const spec = String((env && env.SYNCBOT_SCHEDULE_SYNC_RUNNER) || '').trim();
  if (!spec) return { ok: false, reason: 'sync_runner_missing', cause: 'env_not_set' };
  if (spec === 'builtin-data-only') {
    const runner = createWorkflowRunSyncRunner({ deps, env, logger });
    return { ok: true, runner, source: runner.source };
  }
  const loaded = loadRunnerFromModule(spec);
  if (!loaded.ok) return { ok: false, reason: 'sync_runner_missing', cause: loaded.reason };
  const declared = loaded.runner.report_type || loaded.runner.reportType || REPORT_TYPE;
  if (PLAN.containsLockedReport(declared)) return { ok: false, reason: 'report_b_locked' };
  if (String(declared) !== REPORT_TYPE) return { ok: false, reason: 'sync_runner_missing', cause: 'sync_runner_report_type_not_allowed' };
  if (loaded.runner.data_only !== true && loaded.runner.test_double !== true) return { ok: false, reason: 'sync_runner_missing', cause: 'sync_runner_invalid' };
  return { ok: true, runner: loaded.runner, source: 'module:' + safeText(path.basename(spec), 40) };
}

// ------------------------------------------------------------------ 结果分类
/** runner 结果 ⇒ 本地/中控状态。**永不自动重做**：有副作用或结果未知一律 waiting_human */
function classifyRunnerResult(r) {
  const res = (r && typeof r === 'object') ? r : {};
  // data-only 违规守卫：sync 路径绝不允许出现任何推送/发送痕迹
  const pushed = (Number(res.push_calls) || 0) > 0 || res.sent === true || res.push === true || !!(res.stages && res.stages.push);
  if (pushed) return { status: 'waiting_human', reason: 'sync_runner_push_forbidden' };
  const reason = sanitizeReason(res.reason);
  if (res.ok === true) return { status: 'success', reason: reason };
  // runner **显式声明"需要人工"**（契约 v2 追加 D–E §G 语义校正：G1 命中但无法严格证明归属 ⇒ 转人工）
  // ⇒ 直接 waiting_human：即便 side_effects===false（确实零副作用），也**绝不自动重做**、
  //    更不得"顺手跑一次完整同步"（同日先删后插有覆盖风险）。
  // 该分支只在新字段 requires_human===true 时生效，对既有 runner/既有套件行为零影响。
  if (res.requires_human === true) return { status: 'waiting_human', reason: reason || 'runner_requires_human' };
  if (reason && reason.indexOf('workflow_already_completed') === 0) return { status: 'success', reason: 'already_success' };
  if (res.side_effects === false) return { status: 'refused', reason: reason || 'sync_refused' };
  return { status: 'waiting_human', reason: reason || 'sync_failed' };
}

/** I2 结果 ⇒ {action:'claimed'|'success'|'waiting_human'|'refused', reason} */
function classifyClaimResult(res) {
  if (!res) return { action: 'waiting_human', reason: 'claim_in_flight_unknown' };
  if (res.ok === true) {
    const b = res.body || {};
    if (b.claimed === true) return { action: 'claimed', reason: null };
    const code = sanitizeReason(b.reason) || 'no_active_run_slot';
    if (code === 'already_success') return { action: 'success', reason: code };
    if (UNKNOWN_REASONS.indexOf(code) >= 0 || code === 'no_active_run_slot') return { action: 'waiting_human', reason: code };
    return { action: 'refused', reason: code };
  }
  if (res.unknown === true) return { action: 'waiting_human', reason: 'claim_in_flight_unknown' };
  return { action: 'refused', reason: sanitizeReason(res.reason) || 'claim_failed' };
}

/** I4 结果 ⇒ {status, reason, pushed}。超时/响应丢失 ⇒ waiting_human（**绝不重发**） */
function classifyPushResult(res) {
  if (!res) return { status: 'waiting_human', reason: 'push_in_flight_unknown', pushed: 0 };
  if (res.ok === true) {
    const b = res.body || {};
    if (b.sent === true) return { status: 'success', reason: null, pushed: Number(b.pushed) || 0 };
    const code = sanitizeReason(b.reason) || 'push_refused';
    if (code === 'already_pushed' || code === 'already_success') return { status: 'success', reason: 'already_pushed', pushed: 0 };
    if (UNKNOWN_REASONS.indexOf(code) >= 0) return { status: 'waiting_human', reason: code, pushed: 0 };
    return { status: 'refused', reason: code, pushed: 0 };
  }
  if (res.unknown === true) {
    return { status: 'waiting_human', reason: res.reason === 'timeout' ? 'push_timeout_unknown' : 'push_in_flight_unknown', pushed: 0 };
  }
  return { status: 'refused', reason: sanitizeReason(res.reason) || 'push_transport_failed', pushed: 0 };
}

function actionOfStatus(status) {
  if (status === 'success') return 'success';
  if (status === 'refused') return 'refused';
  if (status === 'failed') return 'failed';
  return 'waiting_human';
}

// ------------------------------------------------------------------ tick
/**
 * 跑一次 tick。
 * @param {{now?:any, deps?:object, workerId?:string}} args
 * @returns {Promise<object>} 永不抛出；exit_code: 0 正常 / 3 被拒-fail-closed / 9 内部错误
 */
async function tick({ now, deps = {}, workerId } = {}) {
  const env = deps.env || process.env;
  const dryRun = deps.dryRun === true || deps.dry_run === true;
  const result = {
    ok: true, dry_run: dryRun, worker_id: null, timezone: PLAN.TIMEZONE,
    now: null, center_now_local: null, business_date: null, config: null,
    report_type_locked: REPORT_TYPE, report_b_locked: false,
    jobs: {}, calls: { schedule_read: 0, claim: 0, settle: 0, report_push: 0, execute: 0, lock_acquired: 0 },
    exit_code: 0, reason: null,
  };
  try {
    const n = PLAN.resolveNow(now);
    result.now = { local: n.local, date: n.date, minutes: n.minutes, timezone: PLAN.TIMEZONE };
    result.business_date = PLAN.previousCompleteDate(n);
    result.worker_id = SSTATE.sanitizeWorkerId(workerId || deps.workerId || defaultWorkerId());

    // ① 报表 B 静态守卫：入口出现 item_sales_detail ⇒ 拒绝，**零 HTTP**
    if (PLAN.containsLockedReport({ reportType: deps.reportType, report_type: deps.report_type })) {
      result.ok = false; result.exit_code = 3; result.reason = 'report_b_locked'; result.report_b_locked = true;
      return result;
    }

    // ② zk 客户端（只允许 127.0.0.1:3456；非法 base 直接 fail-closed，零 HTTP）
    const zkc = resolveZkClient({ deps, env });
    if (!zkc.ok) {
      result.ok = false; result.exit_code = 3; result.reason = 'zk_client_unavailable:' + String(zkc.reason || 'base_not_allowed');
      return result;
    }
    const zk = zkc.client;
    result.calls.schedule_read += 1;

    // ③ 读 I1（只读；失败 ⇒ fail-closed，零副作用）
    const read = await safeCall(() => zk.getSchedule());
    if (read.ok !== true) {
      result.ok = false; result.exit_code = 3;
      result.reason = 'schedule_read_failed:' + String(sanitizeReason(read.reason) || (read.unknown === true ? 'unknown' : 'failed'));
      return result;
    }
    const body = read.body || {};
    // ④ 报表 B 守卫（I1 内容出现 item_sales_detail ⇒ 拒绝）
    if (PLAN.containsLockedReport(body)) {
      result.ok = false; result.exit_code = 3; result.reason = 'report_b_locked'; result.report_b_locked = true;
      return result;
    }
    const cfg = body.config;
    if (!cfg || typeof cfg !== 'object' || cfg.sync_time === undefined || cfg.report_time === undefined) {
      result.ok = false; result.exit_code = 3; result.reason = 'schedule_config_invalid';
      return result;
    }
    result.center_now_local = safeText(body.now_local, 19);
    result.config = {
      sync_enabled: cfg.sync_enabled === true || cfg.sync_enabled === 1,
      sync_time: safeText(cfg.sync_time, 5),
      report_enabled: cfg.report_enabled === true || cfg.report_enabled === 1,
      report_time: safeText(cfg.report_time, 5),
      version: Number.isFinite(Number(cfg.version)) ? Number(cfg.version) : null,
      updated_at: safeText(cfg.updated_at, 35),
      timezone: PLAN.TIMEZONE,
    };

    // ⑤ 采集侧只执行同步。日报由中控独立调度，不依赖采集 worker 的运行。
    const ctx = { n, cfg: result.config, zk, deps, env, worker: result.worker_id, dryRun, calls: result.calls, maxAttempts: Number(deps.maxAttempts || env.SYNCBOT_SCHEDULE_MAX_ATTEMPTS || DEFAULT_MAX_ATTEMPTS) };
    const syncRec = await runSyncJob(ctx);
    result.jobs.sync = syncRec;
    result.jobs.report = { job: 'report', action: 'center_owned', due: false, reason: 'zhongkong_owns_daily_report' };

    result.exit_code = computeExit(result);
    result.ok = result.exit_code === 0;
    if (result.ok !== true && !result.reason) result.reason = 'job_not_completed';
    return result;
  } catch (e) {
    result.ok = false; result.exit_code = 9; result.reason = 'internal_error';
    result.internal = safeText((e && e.message) || e, 120);
    return result;
  }
}

function computeExit(result) {
  const actions = PLAN.JOBS.map((j) => (result.jobs[j] || {}).action).filter(Boolean);
  for (const a of actions) if (a === 'refused' || a === 'waiting_human' || a === 'failed' || a === 'recovered_running') return 3;
  return 0;
}

/** settle 回写（尽力而为；结果丢失不影响本地终态） */
async function settleJob({ zk, job, businessDate, status, reason, detail, worker, calls }) {
  calls.settle += 1;
  const res = await safeCall(() => zk.settle({
    job, business_date: businessDate, status,
    reason: reason || null, detail: detail || null, worker_id: worker,
  }));
  return { ok: res.ok === true, unknown: res.unknown === true, reason: sanitizeReason(res.reason) };
}

function baseJobRecord(job, cfg, due) {
  return {
    job, enabled: job === 'sync' ? cfg.sync_enabled === true : cfg.report_enabled === true,
    scheduled_time: job === 'sync' ? cfg.sync_time : cfg.report_time,
    due: due.due, due_reason: due.reason, scheduled_moment: due.scheduled_moment,
    business_date: due.business_date, idempotency_key: due.idempotency_key || null,
    action: 'not_due', status: null, reason: null, cause: null,
    local_before: null, local_after: null, attempt: 0,
    calls: job === 'sync' ? { claim: 0, settle: 0, execute: 0, lock_acquired: 0 } : { report_push: 0 },
  };
}

/** sync 作业：读本地 → 幂等 → claim(I2) → 锁 → data-only workflow → settle(I3) */
async function runSyncJob(ctx) {
  const { n, cfg, zk, deps, env, worker, dryRun, calls, maxAttempts } = ctx;
  const due = PLAN.dueDetail({ job: 'sync', now: n, scheduledTime: cfg.sync_time, enabled: cfg.sync_enabled === true, configUpdatedAt: cfg.updated_at });
  const rec = baseJobRecord('sync', cfg, due);
  if (!due.due) return rec;

  const local = SSTATE.statusOf('sync', due.business_date);
  rec.local_before = local.status;
  rec.attempt = Number(local.record && local.record.attempt) || 0;

  // 崩溃残留 running（结果未知）：**只能标记 waiting_human**，绝不重做
  if (local.exists && String(local.status) === PLAN.UNCERTAIN_STATUS) {
    const r = SSTATE.recoverStaleRunning('sync', due.business_date, { workerId: worker, reason: 'in_flight_unknown' });
    rec.local_after = r.record ? r.record.status : null;
    rec.action = 'recovered_running'; rec.status = 'waiting_human'; rec.reason = 'in_flight_unknown';
    if (dryRun !== true) {
      rec.settle = await settleJob({ zk, job: 'sync', businessDate: due.business_date, status: 'waiting_human', reason: 'in_flight_unknown', detail: safeDetail({ cause: 'crash_residue_running' }), worker, calls });
    }
    return rec;
  }
  // 本地终态 ⇒ 零动作（同 (job, date) 不再自动执行）
  if (local.terminal) {
    rec.action = 'skipped_terminal'; rec.status = String(local.status);
    rec.reason = sanitizeReason(local.record && local.record.reason);
    return rec;
  }
  // 重试上限（无副作用拒绝的兜底闸门：避免整天反复重试）
  if (!dryRun && rec.attempt >= maxAttempts) {
    rec.action = 'refused'; rec.status = 'refused'; rec.reason = 'attempt_limit_reached';
    rec.detail = { attempt: rec.attempt, max: maxAttempts };
    return rec;
  }

  // sync 执行器解析：未提供/不可用 ⇒ 拒绝且**零副作用**（不建状态文件、不写锁、不发 HTTP）
  const resolved = resolveSyncRunner({ deps, env });
  rec.runner = resolved.ok ? { source: safeText(resolved.source, 60), data_only: true } : null;
  if (!resolved.ok) {
    rec.cause = resolved.cause || resolved.reason;
    rec.reason = resolved.reason === 'report_b_locked' ? 'report_b_locked' : 'sync_runner_missing';
    rec.action = 'refused';
    if (dryRun) { rec.action = 'dry_run'; rec.would = 'refuse:' + rec.reason; }
    if (resolved.reason === 'report_b_locked') rec.detail = { cause: 'runner_report_b' };
    return rec;
  }
  if (dryRun) { rec.action = 'dry_run'; rec.would = 'execute'; return rec; }

  // I2 claim（发送类：单次请求，绝不重试）
  calls.claim += 1; rec.calls.claim += 1;
  const claim = classifyClaimResult(await safeCall(() => zk.claim({ job: 'sync', business_date: due.business_date, trigger: TRIGGER, worker_id: worker })));
  if (claim.action !== 'claimed') {
    const status = claim.action === 'success' ? 'success' : claim.action;
    SSTATE.write('sync', due.business_date, { status, reason: claim.reason, worker_id: worker, attempt: rec.attempt });
    rec.local_after = status;
    rec.status = status; rec.reason = claim.reason; rec.action = actionOfStatus(status);
    return rec;
  }

  // 本地 running + 防并发锁（成功后立即释放；锁名按日期区分）
  const lockName = LOCK_PREFIX + due.business_date;
  let lockHandle = null;
  const attempt = rec.attempt + 1;
  try {
    lockHandle = LOCK.acquire(lockName, REPORT_TYPE, { meta: { job: 'sync', business_date: due.business_date, purpose: 'schedule-tick' } });
  } catch (e) {
    lockHandle = null;
  }
  if (!lockHandle) {
    SSTATE.write('sync', due.business_date, { status: 'refused', reason: 'no_active_run_slot', worker_id: worker, attempt: rec.attempt });
    rec.local_after = 'refused'; rec.status = 'refused'; rec.reason = 'no_active_run_slot'; rec.action = 'refused';
    rec.settle = await settleJob({ zk, job: 'sync', businessDate: due.business_date, status: 'refused', reason: 'no_active_run_slot', detail: safeDetail({ cause: 'lock_busy' }), worker, calls });
    return rec;
  }
  calls.lock_acquired += 1; rec.calls.lock_acquired += 1;

  SSTATE.write('sync', due.business_date, { status: 'running', reason: null, worker_id: worker, attempt });
  rec.local_after = 'running';
  let rr = null;
  try {
    calls.execute += 1; rec.calls.execute += 1;
    rr = await resolved.runner.runOnce({
      businessDate: due.business_date, reportType: REPORT_TYPE, workerId: worker,
      idempotencyKey: due.idempotency_key, now: n.local,
    });
  } catch (e) {
    rr = { ok: false, reason: 'sync_runner_threw', side_effects: true };
  } finally {
    try { lockHandle.release(); } catch (_) {}
  }
  const cls = classifyRunnerResult(rr);
  // 先落本地终态（即使 settle 丢失/进程崩溃也不会重做），再回写中控
  SSTATE.write('sync', due.business_date, { status: cls.status, reason: cls.reason, worker_id: worker, attempt });
  rec.local_after = cls.status;
  rec.status = cls.status; rec.reason = cls.reason; rec.action = actionOfStatus(cls.status);
  rec.detail = safeDetail({ stage_calls: (rr && rr.stage_calls) || null, push_calls: 0 });
  rec.settle = await settleJob({ zk, job: 'sync', businessDate: due.business_date, status: cls.status, reason: cls.reason, detail: rec.detail, worker, calls });
  return rec;
}

/** report 作业：**只调 I4**（绝不自己发送/渲染/读 webhook；I4 内部完成 claim→闸门→发送→settle） */
async function runReportJob(ctx) {
  const { n, cfg, zk, worker, dryRun, calls, syncBlocked } = ctx;
  const due = PLAN.dueDetail({ job: 'report', now: n, scheduledTime: cfg.report_time, enabled: cfg.report_enabled === true, configUpdatedAt: cfg.updated_at });
  const rec = baseJobRecord('report', cfg, due);
  if (!due.due) return rec;

  const local = SSTATE.statusOf('report', due.business_date);
  rec.local_before = local.status;
  rec.attempt = Number(local.record && local.record.attempt) || 0;

  if (local.exists && String(local.status) === PLAN.UNCERTAIN_STATUS) {
    const r = SSTATE.recoverStaleRunning('report', due.business_date, { workerId: worker, reason: 'push_in_flight_unknown' });
    rec.local_after = r.record ? r.record.status : null;
    rec.action = 'recovered_running'; rec.status = 'waiting_human'; rec.reason = 'push_in_flight_unknown';
    return rec;   // **绝不重发**：report 的 settle 归 I4 所有，worker 不回写
  }
  if (local.terminal) {
    rec.action = 'skipped_terminal'; rec.status = String(local.status);
    rec.reason = sanitizeReason(local.record && local.record.reason);
    return rec;
  }
  if (dryRun) { rec.action = 'dry_run'; rec.would = syncBlocked ? 'refuse:sync_not_succeeded' : 'report_push'; return rec; }
  // 同一次 tick 里 sync 未成功 ⇒ 不调 I4（零推送；中控闸门同样会拒）
  if (syncBlocked) {
    rec.action = 'refused'; rec.status = 'refused'; rec.reason = 'sync_not_succeeded';
    SSTATE.write('report', due.business_date, { status: 'refused', reason: 'sync_not_succeeded', worker_id: worker, attempt: rec.attempt });
    rec.local_after = 'refused';
    return rec;
  }

  // 先落 running（崩溃残留 ⇒ 后续 tick 只能标记 waiting_human，绝不重发），再调 I4
  const attempt = rec.attempt + 1;
  SSTATE.write('report', due.business_date, { status: 'running', reason: null, worker_id: worker, attempt });
  rec.local_after = 'running';
  calls.report_push += 1; rec.calls.report_push += 1;
  const res = await safeCall(() => zk.reportPush({ business_date: due.business_date, worker_id: worker, confirm: true }));
  const cls = classifyPushResult(res);
  SSTATE.write('report', due.business_date, { status: cls.status, reason: cls.reason, worker_id: worker, attempt });
  rec.local_after = cls.status;
  rec.status = cls.status; rec.reason = cls.reason; rec.action = actionOfStatus(cls.status);
  rec.pushed = cls.pushed;
  return rec;
}

module.exports = {
  REPORT_TYPE, PLATFORM, TRIGGER, LOCK_PREFIX, DEFAULT_MAX_ATTEMPTS, UNKNOWN_REASONS,
  sanitizeReason, safeDetail, safeText, defaultWorkerId,
  resolveZkClient, createWorkflowRunSyncRunner, loadRunnerFromModule, resolveSyncRunner,
  classifyRunnerResult, classifyClaimResult, classifyPushResult, computeExit,
  tick,
};
