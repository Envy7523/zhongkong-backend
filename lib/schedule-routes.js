'use strict';
/**
 * 「自动同步与日报计划」路由层（中控侧）
 *
 * 两条通道：
 *  A. 后台用户通道（JWT + 权限 enterprise-settings.manage）
 *     GET  /api/enterprise-settings/schedule
 *     POST /api/enterprise-settings/schedule          保存（只影响未来计划；不执行、不补跑）
 *     POST /api/enterprise-settings/schedule/disable  一键停用
 *     POST /api/enterprise-settings/schedule/sync-request  人工请求"仅同步"一次（需 confirm + 显式业务日期）
 *  B. 内部通道（仅回环 + HMAC，供 syncbot 调度 worker）
 *     GET  /api/internal/syncbot/schedule
 *     POST /api/internal/syncbot/schedule/claim
 *     POST /api/internal/syncbot/schedule/settle
 *     POST /api/internal/syncbot/schedule/report-push   项目侧自己发送（含全部闸门与幂等）
 *
 * 所有外部依赖通过 deps 注入 → 可用内存假 db / 假推送函数做离线验收。
 * 报表 B（item_sales_detail）在本层被硬拒：永远 locked_not_started。
 */

const PERMISSION_POINT = 'enterprise-settings.manage';
const USER_PREFIX = '/api/enterprise-settings/schedule';
const INTERNAL_PREFIX = '/api/internal/syncbot/schedule';

function createScheduleRoutes({ core, store, deps = {} }) {
  if (!core || !store) throw new Error('schedule-routes: core/store required');
  const log = typeof deps.logger === 'function' ? deps.logger : () => {};
  const now = typeof deps.now === 'function' ? deps.now : () => new Date();

  const json = (res, status, body) => {
    if (res && typeof res.status === 'function' && typeof res.json === 'function') { res.status(status).json(body); return; }
    if (res && typeof res.writeHead === 'function') {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(text);
      return;
    }
    throw new Error('schedule-routes: unsupported res');
  };

  async function readJsonBody(req) {
    if (typeof deps.readRawBody === 'function') {
      const raw = await deps.readRawBody(req);
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
      if (!text.trim()) return { ok: true, body: {}, raw: text };
      try { return { ok: true, body: JSON.parse(text), raw: text }; } catch (_) { return { ok: false, reason: 'invalid_json' }; }
    }
    const body = req && req.body;
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return { ok: true, body, raw: JSON.stringify(body) };
    if (typeof body === 'string') { try { return { ok: true, body: JSON.parse(body), raw: body }; } catch (_) { return { ok: false, reason: 'invalid_json' }; } }
    return { ok: true, body: {}, raw: '{}' };
  }

  /* ------------------------------------------------------------ 状态摘要（只读） */

  function statusSnapshot() {
    const cfg = store.getConfig();
    const t = now();
    const lastSync = store.lastRunOf('sync');
    const lastReport = store.lastRunOf('report');
    let lastImport = null;
    let evidence = null;
    try { lastImport = typeof deps.getLastImport === 'function' ? deps.getLastImport() : null; } catch (e) { lastImport = { error: 'unavailable' }; }
    try {
      const bd = lastSync && lastSync.business_date;
      evidence = bd && typeof deps.getSyncEvidence === 'function' ? deps.getSyncEvidence(bd) : null;
    } catch (e) { evidence = { error: 'unavailable' }; }
    let lastPushLog = null;
    try { lastPushLog = typeof deps.lastPushLog === 'function' ? deps.lastPushLog() : null; } catch (e) { lastPushLog = { error: 'unavailable' }; }
    return {
      config: core.publicConfig(cfg),
      timezone: core.TIMEZONE,
      server_now: core.localParts(t).date_time,
      next_run: {
        sync: core.nextRunAt({ now: t, time: cfg.sync_time, enabled: Number(cfg.sync_enabled) === 1 }),
        report: core.nextRunAt({ now: t, time: cfg.report_time, enabled: Number(cfg.report_enabled) === 1 }),
      },
      last: {
        sync: lastSync, report: lastReport, import: lastImport, push_log: lastPushLog,
        evidence,
      },
      recent_runs: store.recentRuns(8),
      audit: store.auditList(20),
      safety: { default_disabled: true, report_b: 'locked_not_started', real_timer_created: false, wecom_credentials_on_syncbot: 'none' },
    };
  }

  /* ------------------------------------------------------------ A. 后台用户通道 */

  function guard(req, res) {
    if (typeof deps.checkPermission !== 'function') { json(res, 500, { ok: false, error: 'permission_checker_missing' }); return null; }
    let r = null;
    try { r = deps.checkPermission(req, PERMISSION_POINT); } catch (e) { r = { ok: false, status: 403, error: '无权限' }; }
    if (!r || r.ok !== true) { json(res, (r && r.status) || 403, { ok: false, error: (r && r.error) || '无权限' }); log('schedule.permission_denied', { path: req && req.path }); return null; }
    return r.user || null;
  }

  async function handleGetSchedule(req, res) {
    if (!guard(req, res)) return;
    json(res, 200, Object.assign({ ok: true }, statusSnapshot()));
  }

  async function handleSaveSchedule(req, res) {
    const user = guard(req, res);
    if (!user) return;
    const parsed = await readJsonBody(req);
    if (!parsed.ok) { json(res, 400, { ok: false, reason: 'invalid_json' }); return; }
    const cfg = store.getConfig();
    const v = core.validateSchedulePatch(parsed.body, cfg, now());
    if (!v.ok) { json(res, 400, { ok: false, reason: v.reason, field: v.field || null }); return; }
    if (v.patch.report_enabled === 1 && typeof deps.reportRouteReady === 'function') {
      let ready = false;
      try { ready = deps.reportRouteReady() === true; } catch { /* fail closed */ }
      if (!ready) { json(res, 400, { ok: false, reason: 'pos_daily_route_not_active', field: 'report_enabled' }); return; }
    }
    const saved = store.saveConfig(v.patch, { user_id: user.id || null, user_name: user.name || user.username || null, action: 'update', note: (parsed.body && parsed.body.note) || null });
    log('schedule.config_saved', { reason: null, fields: Object.keys(v.patch) });
    json(res, 200, Object.assign({ ok: true, saved: true, config: core.publicConfig(saved.config), audit_id: saved.audit_id }, { note: '保存只影响未来计划：不会立即执行、不补跑过去日期' }));
  }

  async function handleDisable(req, res) {
    const user = guard(req, res);
    if (!user) return;
    const cfg = store.getConfig();
    const patch = { sync_enabled: false, report_enabled: false };
    const v = core.validateSchedulePatch(patch, cfg, now());
    if (!v.ok && v.reason !== core.REFUSAL.NO_CHANGES) { json(res, 400, { ok: false, reason: v.reason }); return; }
    if (v.ok) store.saveConfig(v.patch, { user_id: user.id || null, user_name: user.name || user.username || null, action: 'disable', note: '后台一键停用' });
    log('schedule.disabled', {});
    json(res, 200, { ok: true, disabled: true, config: core.publicConfig(store.getConfig()) });
  }

  /** 人工请求"仅同步一次"（不做任何真实动作，只登记 requested；由 worker 在下次 tick 认领） */
  async function handleSyncRequest(req, res) {
    const user = guard(req, res);
    if (!user) return;
    const parsed = await readJsonBody(req);
    if (!parsed.ok) { json(res, 400, { ok: false, reason: 'invalid_json' }); return; }
    const body = parsed.body || {};
    if (body.confirm !== true) { json(res, 400, { ok: false, reason: core.REFUSAL.CONFIRM_REQUIRED }); return; }
    const allowed = core.assertReportAllowed(body.report_type === undefined ? core.REPORT_TYPE : body.report_type);
    if (!allowed.ok) { json(res, 400, { ok: false, reason: allowed.reason }); return; }
    const dv = core.validateManualBusinessDate(body.business_date, now());
    if (!dv.ok) { json(res, 400, { ok: false, reason: dv.reason }); return; }
    const r = store.requestRun({ job: 'sync', business_date: dv.business_date, trigger: 'manual', ctx: { user_name: user.name || user.username || null } });
    log('schedule.sync_requested', { business_date: dv.business_date, ok: r.ok, reason: r.reason || null });
    json(res, r.ok ? 200 : 409, Object.assign({ ok: r.ok, business_date: dv.business_date, note: '本操作不执行任何真实动作；需由调度 worker 与已有闸门决定是否执行' }, r));
  }

  /* ------------------------------------------------------------ B. 内部通道（回环 + HMAC） */

  function guardInternal(req, res) {
    if (typeof deps.verifyInternal !== 'function') { json(res, 503, { ok: false, reason: 'internal_verifier_missing' }); return false; }
    let v = null;
    try { v = deps.verifyInternal(req); } catch (e) { v = { ok: false, reason: 'internal_verify_error' }; }
    if (!v || v.ok !== true) { json(res, 401, { ok: false, reason: (v && v.reason) || 'internal_unauthorized' }); log('schedule.internal_denied', { reason: (v && v.reason) || null }); return false; }
    return true;
  }

  function handleInternalSchedule(req, res) {
    if (!guardInternal(req, res)) return;
    const cfg = store.getConfig();
    const t = now();
    const bdYesterday = core.previousCompleteDate(t);
    const pending = (store.recentRuns(50) || []).filter((r) => String(r.status) === 'requested');
    json(res, 200, {
      ok: true,
      now_local: core.localParts(t).date_time,
      timezone: core.TIMEZONE,
      config: {
        sync_enabled: Number(cfg.sync_enabled) === 1, sync_time: cfg.sync_time,
        report_enabled: Number(cfg.report_enabled) === 1, report_time: cfg.report_time,
        version: Number(cfg.version || 1),
        // worker 用于避免“计划时刻已过后才启用”导致当天补跑。
        updated_at: cfg.updated_at || null,
      },
      due_hint: {
        sync: core.dueDecision({ job: 'sync', now: t, time: cfg.sync_time, enabled: Number(cfg.sync_enabled) === 1 }),
        report: core.dueDecision({ job: 'report', now: t, time: cfg.report_time, enabled: Number(cfg.report_enabled) === 1 }),
        business_date_yesterday: bdYesterday,
      },
      runs: { sync: store.lastRunOf('sync'), report: store.lastRunOf('report') },
      pending_manual: pending,
      report_type: core.REPORT_TYPE,
      // 注意：**绝不回显 locked 报表类型名**（syncbot worker 会对 I1 内容做深扫，
      // 出现报表 B 名称会立即 fail-closed 拒绝整次 tick）—— 只回传布尔标记。
      report_b_locked: true,
    });
  }

  async function handleClaim(req, res) {
    if (!guardInternal(req, res)) return;
    const parsed = await readJsonBody(req);
    if (!parsed.ok) { json(res, 400, { ok: false, reason: 'invalid_json' }); return; }
    const b = parsed.body || {};
    if (!core.JOBS.includes(b.job)) { json(res, 400, { ok: false, claimed: false, reason: core.REFUSAL.JOB_INVALID }); return; }
    if (!core.isValidDateStr(b.business_date)) { json(res, 400, { ok: false, claimed: false, reason: core.REFUSAL.BUSINESS_DATE_INVALID }); return; }
    const dv = core.validateManualBusinessDate(b.business_date, now());
    if (!dv.ok) { json(res, 400, { ok: false, claimed: false, reason: dv.reason }); return; }
    const rt = core.assertReportAllowed(b.report_type === undefined ? core.REPORT_TYPE : b.report_type);
    if (!rt.ok) { json(res, 400, { ok: false, claimed: false, reason: rt.reason }); return; }
    const trigger = b.trigger === 'manual' ? 'manual' : 'schedule';
    const cur = store.getRun(b.job, b.business_date);
    let r;
    if (cur && String(cur.status) === 'requested') r = store.claimRequested({ job: b.job, business_date: b.business_date, worker_id: b.worker_id || null });
    else {
      if (trigger === 'schedule' && !jobEnabled(b.job)) { json(res, 200, { ok: true, claimed: false, reason: core.REFUSAL.JOB_DISABLED, run: cur || null }); return; }
      r = store.claimRun({ job: b.job, business_date: b.business_date, trigger, worker_id: b.worker_id || null });
    }
    log('schedule.claim', { job: b.job, business_date: b.business_date, claimed: !!r.claimed, reason: r.reason || null });
    json(res, 200, { ok: true, claimed: r.claimed === true, reason: r.reason || null, run: r.run || null });
  }

  function jobEnabled(job) {
    const cfg = store.getConfig();
    return job === 'sync' ? Number(cfg.sync_enabled) === 1 : Number(cfg.report_enabled) === 1;
  }

  async function handleSettle(req, res) {
    if (!guardInternal(req, res)) return;
    const parsed = await readJsonBody(req);
    if (!parsed.ok) { json(res, 400, { ok: false, reason: 'invalid_json' }); return; }
    const b = parsed.body || {};
    if (!core.JOBS.includes(b.job)) { json(res, 400, { ok: false, reason: core.REFUSAL.JOB_INVALID }); return; }
    if (!core.isValidDateStr(b.business_date)) { json(res, 400, { ok: false, reason: core.REFUSAL.BUSINESS_DATE_INVALID }); return; }
    const status = String(b.status || '');
    if (!['success', 'failed', 'waiting_human', 'refused'].includes(status)) { json(res, 400, { ok: false, reason: 'status_invalid' }); return; }
    let run = null;
    try { run = store.settleRun({ job: b.job, business_date: b.business_date, status, reason: b.reason || null, detail: b.detail || null, worker_id: b.worker_id || null }); }
    catch (e) { json(res, 409, { ok: false, reason: 'no_run_row' }); return; }
    log('schedule.settle', { job: b.job, business_date: b.business_date, status, reason: b.reason || null });
    json(res, 200, { ok: true, run });
  }

  /**
   * 日报推送（项目侧自己发送）。闸门顺序见契约第 4 节；任何"结果未知"一律 waiting_human 且禁止自动重发。
   */
  async function handleReportPush(req, res) {
    if (!guardInternal(req, res)) return;
    const parsed = await readJsonBody(req);
    if (!parsed.ok) { json(res, 400, { ok: false, sent: false, reason: 'invalid_json' }); return; }
    const b = parsed.body || {};
    const reply = (status, body) => json(res, status, Object.assign({ ok: true, sent: false }, body));

    if (b.confirm !== true) return reply(200, { reason: core.REFUSAL.CONFIRM_REQUIRED });
    if (b.report_type !== undefined) {
      const rt = core.assertReportAllowed(b.report_type);
      if (!rt.ok) return reply(200, { reason: rt.reason });
    }
    if (!core.isValidDateStr(b.business_date)) return reply(400, { reason: core.REFUSAL.BUSINESS_DATE_INVALID });
    const dv = core.validateManualBusinessDate(b.business_date, now());
    if (!dv.ok) return reply(200, { reason: dv.reason });
    const bd = dv.business_date;

    // 幂等占位：I4 **自带 claim**（worker 对 report 不调 I2/I3，避免双重 claim 与 send_attempts 被覆盖）
    const existing = store.getRun('report', bd);
    let claimed = null;
    if (!existing) {
      claimed = store.claimRun({ job: 'report', business_date: bd, trigger: b.trigger === 'manual' ? 'manual' : 'schedule', worker_id: b.worker_id || null });
    } else if (String(existing.status) === 'requested') {
      claimed = store.claimRequested({ job: 'report', business_date: bd, worker_id: b.worker_id || null });
    } else {
      // 其余状态统一交给 claimRun 裁决：refused（零副作用拒绝）可回收重试，
      // success/running/waiting_human/failed 一律 claimed:false 并给出对应 reason。
      claimed = store.claimRun({ job: 'report', business_date: bd, trigger: b.trigger === 'manual' ? 'manual' : 'schedule', worker_id: b.worker_id || null });
    }
    if (claimed.claimed !== true) {
      const st = claimed.run ? String(claimed.run.status) : null;
      const reason = st === 'success' ? core.REFUSAL.ALREADY_SUCCESS
        : (st === 'running' || st === 'waiting_human') ? core.REFUSAL.PUSH_IN_FLIGHT_UNKNOWN
          : (claimed.reason || core.REFUSAL.NO_ACTIVE_RUN_SLOT);
      const unknown = reason === core.REFUSAL.PUSH_IN_FLIGHT_UNKNOWN;
      if (unknown && claimed.run && st !== 'waiting_human') {
        store.settleRun({ job: 'report', business_date: bd, status: 'waiting_human', reason });
      }
      log('schedule.report_push_denied', { business_date: bd, reason });
      return reply(200, { reason, run: store.getRun('report', bd) });
    }

    const cur = store.getRun('report', bd);
    if (String(cur.status) === 'success') return reply(200, { reason: core.REFUSAL.ALREADY_SUCCESS, run: cur });
    if (Number(cur.send_attempts || 0) >= 1) {
      const unknown = String(cur.status) === 'running' || String(cur.status) === 'waiting_human';
      const status = unknown ? 'waiting_human' : String(cur.status);
      const run = store.settleRun({ job: 'report', business_date: bd, status: status === 'success' ? 'success' : (unknown ? 'waiting_human' : 'failed'), reason: unknown ? core.REFUSAL.PUSH_IN_FLIGHT_UNKNOWN : core.REFUSAL.ALREADY_PUSHED, detail: { send_attempts: cur.send_attempts } });
      return reply(200, { reason: unknown ? core.REFUSAL.PUSH_IN_FLIGHT_UNKNOWN : core.REFUSAL.ALREADY_PUSHED, run });
    }

    // 同步闸门
    const syncRun = store.getRun('sync', bd);
    if (!syncRun || String(syncRun.status) !== 'success') {
      const run = store.settleRun({ job: 'report', business_date: bd, status: 'refused', reason: core.REFUSAL.SYNC_NOT_SUCCEEDED, detail: { sync_status: syncRun ? syncRun.status : null } });
      return reply(200, { reason: core.REFUSAL.SYNC_NOT_SUCCEEDED, run });
    }
    let ev = null;
    try { ev = typeof deps.getSyncEvidence === 'function' ? deps.getSyncEvidence(bd) : null; } catch (e) { ev = null; }
    if (!ev || ev.file_validated !== true || ev.import_success !== true) {
      const run = store.settleRun({ job: 'report', business_date: bd, status: 'refused', reason: core.REFUSAL.IMPORT_NOT_VERIFIED, detail: { evidence: ev ? { file_validated: !!ev.file_validated, import_success: !!ev.import_success } : null } });
      return reply(200, { reason: core.REFUSAL.IMPORT_NOT_VERIFIED, run });
    }

    // 路由、机器人与当日收银数据覆盖全部通过后才占用一次性发送名额。
    if (typeof deps.preflightDailyReport === 'function') {
      let check;
      try { check = deps.preflightDailyReport(bd); } catch { check = { ok: false, reason: 'pos_daily_preflight_failed' }; }
      if (!check || check.ok !== true) {
        const reason = check?.reason || 'pos_daily_preflight_failed';
        const run = store.settleRun({ job: 'report', business_date: bd, status: 'refused', reason,
          detail: { problems: (check?.problems || []).slice(0, 10) } });
        return reply(200, { reason, run });
      }
    }

    // 发送前占位（同一业务日期最多一次实际发送）
    const began = store.beginSend({ job: 'report', business_date: bd });
    if (!began.ok) return reply(200, { reason: began.reason, run: began.run || null });

    let out = null;
    try { out = await deps.pushDailyReports({ business_date: bd, trigger: 'schedule', worker_id: b.worker_id || null }); }
    catch (e) { out = { ok: false, unknown: true, reason: core.REFUSAL.PUSH_TIMEOUT_UNKNOWN }; }

    if (out && out.ok === true && out.sent === true) {
      const run = store.settleRun({ job: 'report', business_date: bd, status: 'success', reason: null, detail: { pushed: out.pushed || 0, push_log_ids: out.push_log_ids || [] } });
      log('schedule.report_pushed', { business_date: bd, pushed: out.pushed || 0 });
      return json(res, 200, { ok: true, sent: true, pushed: out.pushed || 0, push_log_ids: out.push_log_ids || [], run });
    }
    const unknown = !!(out && out.unknown === true);
    const reason = (out && out.reason) || (unknown ? core.REFUSAL.PUSH_TIMEOUT_UNKNOWN : core.REFUSAL.PUSH_FAILED);
    const run = store.settleRun({ job: 'report', business_date: bd, status: unknown ? 'waiting_human' : 'failed', reason, detail: { unknown, retryable: !unknown && String(reason).indexOf('webhook_not_configured') === 0 } });
    log('schedule.report_push_failed', { business_date: bd, reason, unknown });
    if (unknown) return json(res, 200, { ok: false, sent: false, unknown: true, reason, run, note: '结果未知：必须人工处理，禁止自动重发' });
    if (String(reason).indexOf('webhook_not_configured') === 0) {
      // 未配置 webhook = 零副作用（没发出去），允许后续重试：回写为 refused
      const again = store.settleRun({ job: 'report', business_date: bd, status: 'refused', reason });
      return reply(200, { reason, run: again });
    }
    return reply(200, { reason, run });
  }

  /** 注册到 express 风格 app（也支持注入 fake app 做离线断言） */
  function register(app, opts = {}) {
    if (!app || (typeof app.get !== 'function' && typeof app.post !== 'function')) throw new Error('schedule-routes: bad app');
    // 注意：必须 **return** 处理函数的 Promise，否则上层 await 会在处理完成前返回
    const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => { log('schedule.handler_error', { error: String(e && e.message).slice(0, 80) }); json(res, 500, { ok: false, error: 'internal_error' }); });
    // opts.wrapApp：允许装配层在 handler 外层再套一层（例如"惰性建表兜底"）
    const reg = typeof opts.wrapApp === 'function' ? opts.wrapApp : (method, path, fn) => app[method](path, wrap(fn));
    reg('get', USER_PREFIX, wrap(handleGetSchedule));
    reg('post', USER_PREFIX, wrap(handleSaveSchedule));
    reg('post', USER_PREFIX + '/disable', wrap(handleDisable));
    reg('post', USER_PREFIX + '/sync-request', wrap(handleSyncRequest));
    reg('get', INTERNAL_PREFIX, wrap(handleInternalSchedule));
    reg('post', INTERNAL_PREFIX + '/claim', wrap(handleClaim));
    reg('post', INTERNAL_PREFIX + '/settle', wrap(handleSettle));
    reg('post', INTERNAL_PREFIX + '/report-push', wrap(handleReportPush));
    return {
      USER_PREFIX, INTERNAL_PREFIX, PERMISSION_POINT,
      handleGetSchedule, handleSaveSchedule, handleDisable, handleSyncRequest,
      handleInternalSchedule, handleClaim, handleSettle, handleReportPush, statusSnapshot,
    };
  }

  return { register, statusSnapshot, handleGetSchedule, handleSaveSchedule, handleDisable, handleSyncRequest, handleInternalSchedule, handleClaim, handleSettle, handleReportPush, USER_PREFIX, INTERNAL_PREFIX, PERMISSION_POINT };
}

module.exports = { createScheduleRoutes, PERMISSION_POINT, USER_PREFIX, INTERNAL_PREFIX };
