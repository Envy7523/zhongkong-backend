'use strict';
/** 品项销售明细的只读覆盖核对；与营业收入报表 A 的 coverage 严格分离。 */
const base = require('./syncbot-coverage');

const PATH = '/api/internal/syncbot/item-sales-coverage';
const MAX_STORE_CODES = 200;

function respond(res, status, body) { return res.status(status).json(body); }

function createItemSalesCoverageHandler({ db, audit, logger } = {}) {
  if (!db || typeof db.queryOne !== 'function' || typeof db.queryAll !== 'function')
    throw new Error('item-sales-coverage: db.queryOne/queryAll required');
  const log = typeof logger === 'function' ? logger : () => {};
  return function itemSalesCoverageHandler(req, res) {
    const auth = base.verifyRequest(req, audit);
    if (!auth.ok) return respond(res, 401, { ok: false, reason: auth.reason });
    const businessDate = String(req.query && req.query.business_date || '');
    if (!base.isRealDate(businessDate)) return respond(res, 400, { ok: false, reason: 'business_date_invalid' });
    try {
      const count = db.queryOne(`SELECT COUNT(*) AS n, COUNT(DISTINCT store_id) AS store_count,
        COUNT(DISTINCT store_id || '|' || order_id) AS order_count
        FROM pos_product_sale_details WHERE biz_date=?`, [businessDate]) || {};
      const batches = db.queryAll(`SELECT id, file_name, row_count, date_from, date_to
        FROM business_import_batches WHERE source_type='pos' AND platform='收银机品项销售明细'
          AND date_from<=? AND date_to>=? ORDER BY id DESC LIMIT 10`, [businessDate, businessDate]);
      const codes = db.queryAll(`SELECT id, store_name, pos_store_code FROM stores
        WHERE TRIM(COALESCE(pos_store_code,''))<>'' ORDER BY id LIMIT ?`, [MAX_STORE_CODES + 1]);
      if (!Array.isArray(batches) || !Array.isArray(codes)) throw new Error('query_shape_invalid');
      const recordCount = Number(count.n);
      const storeCount = Number(count.store_count);
      const orderCount = Number(count.order_count);
      if (![recordCount, storeCount, orderCount].every(v => Number.isInteger(v) && v >= 0))
        throw new Error('count_invalid');
      const storeCodes = codes.slice(0, MAX_STORE_CODES).map(row => ({
        id: Number(row.id), name: String(row.store_name || '').trim(), pos_store_code: String(row.pos_store_code || '').trim(),
      }));
      const truncated = codes.length > MAX_STORE_CODES;
      const validCodes = !truncated && storeCodes.every(row => Number.isInteger(row.id) && row.id > 0 && row.name && row.pos_store_code)
        && new Set(storeCodes.map(row => row.pos_store_code)).size === storeCodes.length;
      const body = {
        ok: true, report_type: 'item_sales_detail', business_date: businessDate,
        has_records: recordCount > 0, record_count: recordCount, store_count: storeCount, order_count: orderCount,
        import_batches: batches.map(row => ({ batch_id: Number(row.id), file_name: String(row.file_name || ''),
          row_count: Number(row.row_count), date_from: row.date_from, date_to: row.date_to })),
        store_codes: validCodes ? storeCodes : null, store_codes_complete: validCodes, truncated,
        // 一次只读计数无法证明归档哈希、源文件行数或后续报表可以推送，绝不自动跳过。
        safe_to_skip_sync: false, report_eligible: false, provenance: recordCount > 0 ? 'partially_verifiable' : 'none',
      };
      log('syncbot.item_sales_coverage_read', { business_date: businessDate, record_count: recordCount, store_codes_complete: validCodes });
      return respond(res, 200, body);
    } catch (_) {
      log('syncbot.item_sales_coverage_query_failed', { business_date: businessDate });
      return respond(res, 503, { ok: false, reason: 'coverage_query_failed', business_date: businessDate,
        has_records: false, record_count: null, store_codes: null, store_codes_complete: false,
        safe_to_skip_sync: false, report_eligible: false });
    }
  };
}

function mountItemSalesCoverage({ app, express, db, audit, logger } = {}) {
  if (!app || typeof app.get !== 'function' || !express || typeof express.raw !== 'function')
    throw new Error('item-sales-coverage: app.get/express.raw required');
  app.use(PATH, express.raw({ type: () => true, limit: '16kb' }));
  const handler = createItemSalesCoverageHandler({ db, audit, logger });
  app.get(PATH, handler);
  return { PATH, handler };
}

module.exports = { PATH, MAX_STORE_CODES, createItemSalesCoverageHandler, mountItemSalesCoverage };

