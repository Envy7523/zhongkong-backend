'use strict';

/**
 * Stage 1 的最小只读 coverage 接口。
 *
 * 本模块刻意不依赖 schedule、webhook、日报、计划配置或任何写入 API：
 *   GET /api/internal/syncbot/coverage?business_date=YYYY-MM-DD
 *
 * 返回的 has_records 只表示该日期存在业务记录，绝不表示完整、可跳过同步或可推送。
 * 由于现阶段缺少 batch_id × 归档摘要的可靠关联，safe_to_skip_sync / report_eligible
 * 始终为 false；G1 命中仍必须由 syncbot 转 WAITING_HUMAN。
 */

const PATH = '/api/internal/syncbot/coverage';
const MAX_ACTIVE_STORES = 200;
// 已获业务确认的唯一主档口径；报表 A 专属排除只在 syncbot 侧处理，绝不篡改这里的主档事实。
const ACTIVE_STORES_BASIS = 'stores.status=正常营业';
// 已获业务确认的数据源口径：source_type='pos' = 收银系统（报表 A 来源），
// source_type='platform' = 团购/外卖人工导入。coverage 的"该日期已有数据"只认收银系统记录，
// 以免人工导入的平台数据把 G1 闸门误判给报表 A；平台数据既不计入 has_records 也不计入 record_count。
const CASHIER_SOURCE_TYPE = 'pos';
const RECORD_COUNT_BASIS = "source_type='" + CASHIER_SOURCE_TYPE + "'";

function isRealDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function json(res, status, body) {
  if (res && typeof res.status === 'function' && typeof res.json === 'function') return res.status(status).json(body);
  if (res && typeof res.writeHead === 'function') {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(body));
  }
  throw new Error('syncbot-coverage: unsupported response');
}

function loopbackOnly(req) {
  const viaProxy = req.get('x-forwarded-for') || req.get('x-real-ip') || req.get('via') || req.get('forwarded');
  if (viaProxy) return { ok: false, reason: 'via_proxy_denied' };
  const remote = String((req.socket && req.socket.remoteAddress) || '');
  if (!/^(127\.|::1$|::ffff:127\.)/.test(remote)) return { ok: false, reason: 'not_loopback' };
  return { ok: true };
}

function rawGetBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body === undefined || req.body === null) return '';
  // express.raw leaves an empty GET as {}; accept only that exact empty-object shape.
  if (typeof req.body === 'object' && Object.keys(req.body).length === 0) return '';
  return null;
}

function verifyRequest(req, audit) {
  const loopback = loopbackOnly(req);
  if (!loopback.ok) return loopback;
  const rawBody = rawGetBody(req);
  if (rawBody === null) return { ok: false, reason: 'raw_body_required' };
  const secret = audit && typeof audit.loadSecret === 'function' ? audit.loadSecret() : '';
  if (!secret) return { ok: false, reason: 'hmac_secret_not_configured' };
  const timestamp = String(req.get('x-syncbot-timestamp') || '');
  const signature = String(req.get('x-syncbot-signature') || '');
  const time = audit.timestampAcceptable(timestamp);
  if (!time || time.ok !== true) return { ok: false, reason: (time && time.reason) || 'timestamp_invalid' };
  const signed = audit.verifySignature({ secret, timestamp, signature, rawBody });
  return signed && signed.ok === true ? { ok: true } : { ok: false, reason: (signed && signed.reason) || 'signature_mismatch' };
}

/**
 * 已确认的只读主档 provider。
 * 此处只返回 stores.status='正常营业' 的主档事实；湖南宜章店等报表 A 数据源专属
 * 排除项由 syncbot 映射台账处理，不能在中控主档 provider 中静默删除。
 */
function createStoresStatusActiveProvider(db) {
  if (!db || typeof db.queryOne !== 'function' || typeof db.queryAll !== 'function') {
    throw new Error('syncbot-coverage: db.queryOne/queryAll required for active stores');
  }
  return function storesStatusActiveProvider({ limit = MAX_ACTIVE_STORES } = {}) {
    const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= MAX_ACTIVE_STORES ? limit : MAX_ACTIVE_STORES;
    const totalRow = db.queryOne("SELECT COUNT(*) AS n FROM stores WHERE status='正常营业'");
    const total = Number((totalRow && totalRow.n) || 0);
    if (!Number.isInteger(total) || total < 0) throw new Error('syncbot-coverage: active store count invalid');
    const rows = db.queryAll("SELECT id, store_name AS name FROM stores WHERE status='正常营业' ORDER BY id ASC LIMIT ?", [safeLimit + 1]);
    if (!Array.isArray(rows)) throw new Error('syncbot-coverage: active store rows invalid');
    const list = rows.slice(0, safeLimit).map((row) => ({ id: Number(row && row.id), name: String((row && row.name) || '').trim() }));
    // 不丢弃异常行：清单本身无法证明完整时必须 fail-closed。
    if (list.some((row) => !Number.isInteger(row.id) || row.id <= 0 || !row.name)) {
      throw new Error('syncbot-coverage: active store row invalid');
    }
    return {
      ok: true,
      active_stores: list,
      total_active: total,
      truncated: total > safeLimit || rows.length > safeLimit,
      active_stores_basis: ACTIVE_STORES_BASIS,
      active_stores_basis_confirmed: true,
    };
  };
}

/**
 * activeStoresProvider 是明确的只读函数。未注入时，createCoverageHandler 会使用
 * 已确认的 stores.status provider；provider 查询异常仍明确返回 null，供 syncbot fail-closed。
 */
function readActiveStores(activeStoresProvider) {
  if (typeof activeStoresProvider !== 'function') {
    return { active_stores: null, truncated: false, total_active: null, active_stores_basis: null, active_stores_basis_confirmed: false, reason: 'active_stores_basis_unconfirmed' };
  }
  try {
    const out = activeStoresProvider({ limit: MAX_ACTIVE_STORES });
    if (!out || out.ok !== true || !Array.isArray(out.active_stores)) {
      return { active_stores: null, truncated: false, total_active: null, active_stores_basis: null, active_stores_basis_confirmed: false, reason: 'active_stores_query_failed' };
    }
    const basis = String(out.active_stores_basis || '').trim();
    if (!basis) {
      return { active_stores: null, truncated: false, total_active: null, active_stores_basis: null, active_stores_basis_confirmed: false, reason: 'active_stores_basis_unconfirmed' };
    }
    const list = out.active_stores.slice(0, MAX_ACTIVE_STORES).map((row) => ({ id: Number(row.id), name: String(row.name || '') }))
      .filter((row) => Number.isFinite(row.id) && row.name);
    return {
      active_stores: list,
      truncated: out.truncated === true || Number(out.total_active || list.length) > MAX_ACTIVE_STORES,
      total_active: Number.isFinite(Number(out.total_active)) ? Number(out.total_active) : list.length,
      active_stores_basis: basis,
      active_stores_basis_confirmed: out.active_stores_basis_confirmed === true,
      reason: out.active_stores_basis_confirmed === true ? null : 'active_stores_basis_unconfirmed',
    };
  } catch (_) {
    return { active_stores: null, truncated: false, total_active: null, active_stores_basis: null, active_stores_basis_confirmed: false, reason: 'active_stores_query_failed' };
  }
}

function createCoverageHandler({ db, audit, activeStoresProvider, logger } = {}) {
  if (!db || typeof db.queryOne !== 'function') throw new Error('syncbot-coverage: db.queryOne required');
  const provider = activeStoresProvider === undefined ? createStoresStatusActiveProvider(db) : activeStoresProvider;
  const log = typeof logger === 'function' ? logger : () => {};
  return function coverageHandler(req, res) {
    const auth = verifyRequest(req, audit);
    if (!auth.ok) return json(res, 401, { ok: false, reason: auth.reason });
    const businessDate = String(req.query && req.query.business_date || '');
    if (!isRealDate(businessDate)) return json(res, 400, { ok: false, reason: 'business_date_invalid' });
    let count = 0;
    try {
      // 只统计收银系统记录；CASHIER_SOURCE_TYPE 是模块内常量（非用户输入），故可安全内联为字面量。
      const row = db.queryOne("SELECT COUNT(*) AS n FROM business_revenue_records WHERE biz_date=? AND source_type='" + CASHIER_SOURCE_TYPE + "'", [businessDate]);
      count = Number((row && row.n) || 0);
    } catch (_) {
      log('syncbot.coverage_query_failed', { business_date: businessDate });
      return json(res, 503, {
        ok: false, reason: 'coverage_query_failed', business_date: businessDate,
        has_records: false, safe_to_skip_sync: false, report_eligible: false,
        provenance: 'unverifiable', active_stores: null,
      });
    }
    const active = readActiveStores(provider);
    const hasRecords = count > 0;
    const body = {
      ok: true,
      business_date: businessDate,
      has_records: hasRecords,
      record_count: count,
      // 只读审计字段：说明 record_count/has_records 的口径，便于事后核对
      record_count_basis: RECORD_COUNT_BASIS,
      // Hard Stage-1 rule: neither is inferred from has_records.
      safe_to_skip_sync: false,
      report_eligible: false,
      provenance: hasRecords ? 'partially_verifiable' : 'none',
      active_stores: active.active_stores,
      truncated: active.truncated,
      total_active: active.total_active,
      active_stores_basis: active.active_stores_basis,
      active_stores_basis_confirmed: active.active_stores_basis_confirmed,
      reason: active.reason,
    };
    log('syncbot.coverage_read', { business_date: businessDate, has_records: hasRecords, active_stores_ready: active.active_stores !== null });
    return json(res, 200, body);
  };
}

function mountCoverage({ app, express, db, audit, activeStoresProvider, logger } = {}) {
  if (!app || typeof app.get !== 'function') throw new Error('syncbot-coverage: app.get required');
  if (!express || typeof express.raw !== 'function') throw new Error('syncbot-coverage: express.raw required');
  app.use(PATH, express.raw({ type: () => true, limit: '16kb' }));
  const handler = createCoverageHandler({ db, audit, activeStoresProvider, logger });
  app.get(PATH, handler);
  return { PATH, handler };
}

module.exports = { PATH, MAX_ACTIVE_STORES, ACTIVE_STORES_BASIS, CASHIER_SOURCE_TYPE, RECORD_COUNT_BASIS, isRealDate, loopbackOnly, rawGetBody, verifyRequest, createStoresStatusActiveProvider, readActiveStores, createCoverageHandler, mountCoverage };
