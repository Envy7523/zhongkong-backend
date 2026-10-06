'use strict';
/** 报表 B 的 G1/G3：只认可 B 专属覆盖接口，任何不完整/矛盾应答均 fail-closed。 */
const REPORT_TYPE = 'item_sales_detail';

function normalizeItemCoverage(result, businessDate) {
  const fail = reason => ({ ok: false, covered: false, reason, business_date: businessDate });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate || ''))) return fail('business_date_invalid');
  if (!result || result.ok !== true || !result.body || result.body.ok !== true)
    return fail('item_coverage_query_failed');
  const b = result.body;
  if (b.report_type !== REPORT_TYPE || b.business_date !== businessDate)
    return fail('item_coverage_identity_mismatch');
  const numbers = [b.record_count, b.store_count, b.order_count];
  if (numbers.some(n => !Number.isInteger(n) || n < 0) || typeof b.has_records !== 'boolean'
    || b.has_records !== (b.record_count > 0) || b.store_count > b.record_count
    || b.order_count > b.record_count)
    return fail('item_coverage_counts_invalid');
  if (!Array.isArray(b.import_batches) || b.import_batches.some(x => !x
    || !Number.isInteger(x.batch_id) || x.batch_id <= 0
    || !Number.isInteger(x.row_count) || x.row_count < 0
    || x.date_from !== businessDate || x.date_to !== businessDate))
    return fail('item_coverage_batches_invalid');
  if (b.store_codes_complete !== true || b.truncated === true || !Array.isArray(b.store_codes) || b.store_codes.length === 0)
    return fail('item_coverage_codes_incomplete');
  const ids = new Set(), codes = new Set();
  for (const x of b.store_codes) {
    const code = String(x && x.pos_store_code || '').trim();
    if (!x || !Number.isInteger(x.id) || x.id <= 0 || !String(x.name || '').trim() || !code
      || ids.has(x.id) || codes.has(code)) return fail('item_coverage_codes_invalid');
    ids.add(x.id); codes.add(code);
  }
  if (b.safe_to_skip_sync !== false || b.report_eligible !== false)
    return fail('item_coverage_semantics_invalid');
  // 即使旧批次没有留下明细行，也不能据此再次覆盖同日；先转人工核对批次来源。
  const covered = b.has_records || b.import_batches.length > 0;
  return { ok: true, covered, reason: covered ? 'item_coverage_hit' : null,
    business_date: businessDate, record_count: b.record_count, store_count: b.store_count,
    order_count: b.order_count, store_codes: b.store_codes, coverage: b };
}

function createReportBCoverageGates(client) {
  if (!client || typeof client.itemSalesCoverage !== 'function')
    throw new Error('B 覆盖客户端必须提供 itemSalesCoverage');
  async function check(stage, businessDate) {
    let response;
    try { response = await client.itemSalesCoverage({ business_date: businessDate }); }
    catch (_) { return { ok: false, coverage_hit: false, reason: 'item_coverage_query_failed', stage }; }
    const c = normalizeItemCoverage(response, businessDate);
    return { ok: c.ok && !c.covered, coverage_hit: c.covered === true,
      reason: c.ok ? (c.covered ? 'item_coverage_hit' : null) : c.reason,
      stage, evidence: c.ok ? { record_count: c.record_count, store_count: c.store_count,
        order_count: c.order_count, store_codes: c.store_codes, coverage: c.coverage } : null };
  }
  return {
    g1: ({ businessDate }) => check('g1', businessDate),
    g3: ({ businessDate }) => check('g3', businessDate),
  };
}

module.exports = { REPORT_TYPE, normalizeItemCoverage, createReportBCoverageGates };
