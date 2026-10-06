'use strict';
/**
 * 「自动同步与日报计划」装配层（中控侧唯一挂载点）
 *
 * 职责：把 schedule-routes 需要的所有真实依赖接上（权限、HMAC、同步证据、项目日报推送），
 * 并把模块挂到 express app 上。采集由 syncbot 触发；已批准的单张总览日报由中控自身触发并发送。
 *
 * 调用点：server.js 中所有依赖函数（loadConfig/httpPost/ensureDailyDataLoaded/...）定义**之后**。
 */

const core = require('./schedule-core');
const { createScheduleStore } = require('./schedule-store');
const { createScheduleRoutes } = require('./schedule-routes');
const posDailyPush = require('./pos-daily-push');
const { conflictWithPlans, REPORTS } = require('./report-sync-plans');

const INTERNAL_PREFIX = '/api/internal/syncbot/schedule';

function mountSchedule({ app, express, db, permissions, syncJobAudit, daily, logger, startReportTimer = true, clock = () => new Date() }) {
  for (const [k, v] of Object.entries({ app, express, db, permissions, syncJobAudit, daily })) {
    if (!v) throw new Error('schedule-wiring: missing dependency ' + k);
  }
  const log = typeof logger === 'function' ? logger : (msg, extra) => {
    try { console.log('[schedule]', msg, extra === undefined ? '' : JSON.stringify(extra)); } catch (_) { console.log('[schedule]', msg); }
  };

  const store = createScheduleStore({ db, core });

  /**
   * 建表兜底（幂等）。**必须惰性执行**：server.js 中 db.init() 在本模块挂载之后才完成，
   * 挂载期直接访问 db 会因 sql.js 实例尚未创建而抛 "Cannot read properties of null (reading 'run')"，
   * 从而导致整个模块挂不上（路由 404）。
   * DDL 的权威位置仍是 lib/db.js 的 createTables()（init 时执行），这里只做兜底 + 重试。
   */
  let schemaReady = false;
  function ensureReady() {
    if (schemaReady) return true;
    try { store.ensureSchema(); schemaReady = true; return true; }
    catch (e) {
      log('schedule.schema_not_ready', { error: String((e && e.message) || e).slice(0, 80) });
      return false;
    }
  }
  try { ensureReady(); } catch (_) { /* 绝不让建表失败拖垮整个模块挂载 */ }

  // 内部通道必须拿到**原始字节**（HMAC 覆盖未被重新序列化的 body）
  app.use(INTERNAL_PREFIX, express.raw({ type: () => true, limit: '256kb' }));

  /* ---------------- 权限（与全局岗位权限中间件同源，做二次校验） ---------------- */
  function checkPermission(req, point) {
    const user = req && req.user;
    if (!user || user.id === undefined || user.id === null) return { ok: false, status: 401, error: '未登录' };
    let perms = [];
    try {
      const row = db.queryOne('SELECT u.id,u.username,p.permissions_json FROM users u LEFT JOIN position_settings p ON p.id=u.position_id WHERE u.id=?', [user.id]);
      perms = permissions.normalizePermissions(row && row.permissions_json);
    } catch (e) {
      return { ok: false, status: 403, error: '权限查询失败' };
    }
    if (!permissions.can(perms, point)) return { ok: false, status: 403, error: '当前岗位没有「企业设置」权限，请联系系统管理员开通' };
    return { ok: true, user: { id: user.id, username: user.username || null, name: user.name || user.username || null } };
  }

  /* ---------------- 内部通道鉴权（与 /api/internal/syncbot/events 完全同源） ---------------- */
  function verifyInternal(req) {
    const viaProxy = req.get('x-forwarded-for') || req.get('x-real-ip') || req.get('via') || req.get('forwarded');
    if (viaProxy) return { ok: false, reason: 'via_proxy_denied' };
    const remote = (req.socket && req.socket.remoteAddress) || '';
    if (!/^(127\.|::1$|::ffff:127\.)/.test(remote)) return { ok: false, reason: 'not_loopback' };
    const secret = syncJobAudit.loadSecret();
    if (!secret) return { ok: false, reason: 'hmac_secret_not_configured' };
    // express.raw 对**无 body 的 GET** 不会产生 Buffer（req.body 为 {}）——真实生产路径正是如此。
    // 因此这里显式把"空 body"归一化为空串，与 worker 侧对 GET 的签名原文（ts + '.'）保持一致；
    // 其余非 Buffer（例如被 express.json 解析过的对象）仍然拒绝，保持严格。
    let rawBody = null;
    if (Buffer.isBuffer(req.body)) rawBody = req.body.toString('utf8');
    else if (req.body === undefined || req.body === null) rawBody = '';
    else if (typeof req.body === 'object' && Object.keys(req.body).length === 0) rawBody = '';
    if (rawBody === null) return { ok: false, reason: 'raw_body_required' };
    const ts = String(req.get('x-syncbot-timestamp') || '');
    const sig = String(req.get('x-syncbot-signature') || '');
    const tsv = syncJobAudit.timestampAcceptable(ts);
    if (!tsv.ok) return { ok: false, reason: tsv.reason };
    const sv = syncJobAudit.verifySignature({ secret, timestamp: ts, signature: sig, rawBody });
    if (!sv.ok) return { ok: false, reason: sv.reason };
    return { ok: true };
  }

  /* ---------------- 同步证据（只读查询，失败一律 fail-closed） ---------------- */
  function getSyncEvidence(businessDate) {
    try {
      const run = db.queryOne("SELECT id,status,imported,pushed,push_status,business_date,import_batch_id,is_test,reconstructed,not_a_realtime_success FROM sync_job_runs WHERE business_date=? AND report_type='cashier_composite' ORDER BY id DESC LIMIT 1", [businessDate]);
      if (!run) return { file_validated: false, import_success: false, reason: 'no_sync_run' };
      const fv = db.queryOne("SELECT COUNT(*) AS n FROM sync_job_events WHERE run_id=? AND stage='FILE_VALIDATED'", [run.id]);
      const imported = Number(run.imported || 0) === 1;
      const batch = Number(run.import_batch_id || 0) > 0
        ? db.queryOne('SELECT id,source_type,date_from,date_to,row_count FROM business_import_batches WHERE id=?', [run.import_batch_id]) : null;
      const fileValidated = Number((fv && fv.n) || 0) > 0;
      const importSuccess = imported && String(run.status) === 'success';
      return {
        run_id: run.id, status: run.status, imported,
        file_validated: fileValidated,
        import_success: importSuccess,
        // 手工续接可用于“人工明确请求的一次日报”，但绝不能伪装成计划同步成功。
        manual_recovery_verified: fileValidated && importSuccess && Number(run.is_test || 0) === 0 &&
          Number(run.reconstructed || 0) === 0 && Number(run.not_a_realtime_success || 0) === 0 &&
          Boolean(batch && batch.source_type === 'pos' && batch.date_from === businessDate &&
            batch.date_to === businessDate && Number(batch.row_count || 0) > 0),
        import_batch_id: batch ? batch.id : null,
      };
    } catch (e) {
      // 查询失败 ⇒ 视为"未验证"（绝不误放行推送）
      return { file_validated: false, import_success: false, reason: 'evidence_query_failed' };
    }
  }

  function getLastImport() {
    try {
      const r = db.queryOne("SELECT business_date,status,imported,push_status,updated_at FROM sync_job_runs WHERE report_type='cashier_composite' ORDER BY id DESC LIMIT 1");
      if (!r) return null;
      return { business_date: r.business_date, status: r.status, imported: Number(r.imported || 0) === 1, push_status: r.push_status || null, at: r.updated_at || null };
    } catch (e) { return null; }
  }

  function lastPushLog() {
    try {
      return db.queryOne('SELECT id,push_type,status,content_preview,created_at FROM push_logs ORDER BY id DESC LIMIT 1');
    } catch (e) { return null; }
  }

  /* ---------------- 收银系统单张总览日报；显式绑定专用机器人，不复用旧 Excel 缓存/默认机器人 ---------------- */
  async function pushDailyReports({ business_date }) {
    return posDailyPush.pushPosDaily({ db, business_date, httpPost: daily.httpPost });
  }

  // 每个入口先确保建表兜底（首次成功后仅剩一次布尔判断）
  const withReady = (fn) => (req, res) => { ensureReady(); return fn(req, res); };
  const wrapApp = (method, path, fn) => app[method](path, withReady(fn));

  const routes = createScheduleRoutes({
    core, store,
    deps: {
      logger: log,
      now: clock,
      checkPermission,
      verifyInternal,
      readRawBody: async (req) => {
        if (Buffer.isBuffer(req.body)) return req.body;
        if (typeof req.body === 'string') return req.body;
        return JSON.stringify(req.body || {});
      },
      getSyncEvidence, getLastImport, lastPushLog, pushDailyReports,
      preflightDailyReport: businessDate => posDailyPush.preflight(db, businessDate),
      reportRouteReady: () => posDailyPush.routeReady(db),
      validateSyncTime: (time) => {
        const peers = db.queryAll('SELECT report_type,enabled,run_time FROM report_sync_plans WHERE report_type IN (?,?)', ['item_sales_detail', 'pos_bookkeeping_daily']);
        return conflictWithPlans(time, peers.map(p => ({ ...p, name: REPORTS[p.report_type]?.name || p.report_type })));
      },
    },
  });
  routes.register(app, { wrapApp });          // 注册路由时套上"惰性建表兜底"
  let reportTickBusy = false;
  let lastReportMinute = '';
  async function reportTick(at = clock()) {
    if (reportTickBusy || !ensureReady()) return { action: 'not_ready' };
    const local = core.localParts(at);
    const minuteKey = local.date_time.slice(0, 16);
    if (minuteKey === lastReportMinute) return { action: 'already_checked_minute' };
    lastReportMinute = minuteKey;
    const cfg = store.getConfig();
    const due = core.dueDecision({ job: 'report', now: at, time: cfg.report_time, enabled: Number(cfg.report_enabled) === 1 });
    if (!due.due) return { action: 'not_due', reason: due.reason };
    const changed = cfg.updated_at && new Date(cfg.updated_at);
    if (changed && Number.isFinite(changed.getTime())) {
      const changedLocal = core.localParts(changed);
      if (changedLocal.date === local.date && changedLocal.date_time >= due.scheduled_at_local) return { action: 'configured_after_time' };
    }
    const existing = store.getRun('report', due.business_date);
    if (existing && existing.status !== 'refused') return { action: 'existing_run', status: existing.status };
    if (existing && Number(existing.send_attempts || 0) > 0) return { action: 'send_attempt_exists' };
    reportTickBusy = true;
    const response = { code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    try {
      await routes.executeReportPush({ business_date: due.business_date, confirm: true, trigger: 'schedule', worker_id: 'zhongkong-report-scheduler' }, response);
      log('schedule.center_report_tick', { business_date: due.business_date, sent: response.body?.sent === true, reason: response.body?.reason || null });
      return { action: 'executed', status: response.code, sent: response.body?.sent === true, reason: response.body?.reason || null };
    } finally { reportTickBusy = false; }
  }
  if (startReportTimer) {
    const timer = setInterval(() => { reportTick().catch((e) => log('schedule.center_report_tick_failed', { error: String(e?.message || e).slice(0, 80) })); }, 15_000);
    timer.unref?.();
  }
  log('schedule.mounted', { internal_prefix: INTERNAL_PREFIX, default_disabled: true, schema_ready_at_mount: schemaReady });
  return { store, routes, core, reportTick };
}

module.exports = { mountSchedule, INTERNAL_PREFIX };
