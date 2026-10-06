'use strict';
/** C 独立覆盖闸门：只相信中控记账本与 C 导入批次，不借 A/B 状态推断。 */
function normalizeCoverage(raw, businessDate) {
  const body = raw?.body;
  if (raw?.ok !== true || body?.ok !== true || body.report_type !== 'pos_bookkeeping_daily'
    || body.business_date !== businessDate || !Number.isInteger(body.entry_count) || body.entry_count < 0
    || !Number.isSafeInteger(body.total_cents))
    return { ok: false, reason: 'bookkeeping_coverage_unverifiable' };
  const batch = body.import_batch;
  if (batch !== null && (typeof batch !== 'object' || !Number.isInteger(batch.id) || batch.id <= 0
    || !Number.isInteger(batch.row_count) || batch.row_count < 0
    || !Number.isInteger(batch.store_count) || batch.store_count < 0
    || !Number.isSafeInteger(batch.total_cents)
    || !/^[0-9a-f]{12}$/.test(String(batch.sha256_prefix || ''))
    || !Number.isInteger(batch.linked_rows) || batch.linked_rows < 0
    || !Number.isSafeInteger(batch.linked_cents)))
    return { ok: false, reason: 'bookkeeping_batch_unverifiable' };
  return { ok: true, entry_count: body.entry_count, total_cents: body.total_cents, batch };
}

function beforeExport(raw, businessDate, { review = false } = {}) {
  const coverage = normalizeCoverage(raw, businessDate);
  if (!coverage.ok) return coverage;
  if (!review && (coverage.entry_count !== 0 || coverage.batch !== null))
    return { ok: false, reason: 'bookkeeping_existing_data_manual_review', coverage };
  return { ok: true, coverage };
}

function afterImport(raw, validated) {
  if (!validated?.ok || validated.report_type !== 'pos_bookkeeping_daily'
    || !/^[0-9a-f]{64}$/.test(String(validated.sha256 || '')))
    return { ok: false, reason: 'source_validation_missing' };
  const coverage = normalizeCoverage(raw, validated.business_date);
  if (!coverage.ok) return coverage;
  const batch = coverage.batch;
  if (!batch || batch.sha256_prefix !== validated.sha256.slice(0, 12)
    || batch.row_count !== validated.row_count || batch.store_count !== validated.store_count
    || batch.total_cents !== validated.total_cents || batch.linked_rows !== validated.row_count
    || batch.linked_cents !== validated.total_cents || coverage.entry_count !== validated.row_count
    || coverage.total_cents !== validated.total_cents)
    return { ok: false, reason: 'bookkeeping_post_import_mismatch' };
  return { ok: true, batch_id: batch.id, coverage };
}

function createReportCCoverageGates(client) {
  if (!client || typeof client.bookkeepingCoverage !== 'function')
    throw new Error('report_c_coverage_client_missing');
  async function check(stage, businessDate) {
    let raw;
    try { raw = await client.bookkeepingCoverage({ business_date: businessDate }); }
    catch { return { ok: false, coverage_hit: false, reason: 'bookkeeping_coverage_unavailable', stage }; }
    const checked = beforeExport(raw, businessDate);
    return { ok: checked.ok === true,
      coverage_hit: checked.coverage?.entry_count > 0 || checked.coverage?.batch !== null,
      reason: checked.reason || null, stage,
      evidence: checked.ok ? { coverage: raw } : null };
  }
  return { g1: ({ businessDate }) => check('g1', businessDate),
    g3: ({ businessDate }) => check('g3', businessDate) };
}
module.exports = { normalizeCoverage, beforeExport, afterImport, createReportCCoverageGates };
