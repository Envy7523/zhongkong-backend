'use strict';
/**
 * 「自动同步与日报计划」装配层（中控侧唯一挂载点）
 *
 * 职责：把 schedule-routes 需要的所有真实依赖接上（权限、HMAC、同步证据、项目日报推送），
 * 并把模块挂到 express app 上。**本模块不创建任何定时器/子进程/端口**：
 * 计划由 syncbot 侧独立的调度 worker 主动拉取（回环 + HMAC），中控只负责配置、闸门与推送。
 *
 * 调用点：server.js 中所有依赖函数（loadConfig/httpPost/ensureDailyDataLoaded/...）定义**之后**。
 */

const core = require('./schedule-core');
const { createScheduleStore } = require('./schedule-store');
const { createScheduleRoutes } = require('./schedule-routes');
const posDailyPush = require('./pos-daily-push');

const INTERNAL_PREFIX = '/api/internal/syncbot/schedule';

function mountSchedule({ app, express, db, permissions, syncJobAudit, daily, logger }) {
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
      const run = db.queryOne("SELECT id,status,imported,pushed,push_status,business_date FROM sync_job_runs WHERE business_date=? AND report_type='cashier_composite' ORDER BY id DESC LIMIT 1", [businessDate]);
      if (!run) return { file_validated: false, import_success: false, reason: 'no_sync_run' };
      const fv = db.queryOne("SELECT COUNT(*) AS n FROM sync_job_events WHERE run_id=? AND stage='FILE_VALIDATED'", [run.id]);
      const imported = Number(run.imported || 0) === 1;
      return {
        run_id: run.id, status: run.status, imported,
        file_validated: Number((fv && fv.n) || 0) > 0,
        import_success: imported && String(run.status) === 'success',
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
    },
  });
  routes.register(app, { wrapApp });          // 注册路由时套上"惰性建表兜底"
  log('schedule.mounted', { internal_prefix: INTERNAL_PREFIX, default_disabled: true, schema_ready_at_mount: schemaReady });
  return { store, routes, core };
}

module.exports = { mountSchedule, INTERNAL_PREFIX };
