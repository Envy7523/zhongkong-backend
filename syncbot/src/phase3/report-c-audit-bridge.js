'use strict';
/** C 成功批次的脱敏审计桥；只消费既有任务和只读覆盖，不触发浏览器/导入/群消息。 */
const STATE = require('../state');
const OUTBOX = require('./audit-outbox');
const REPORT_TYPE = 'pos_bookkeeping_daily';
const PLATFORM = 'meituan';
function evidenceOf({ businessDate, state, coverage } = {}) {
  const w = state?.workflow || {};
  const download = w.stages?.download || {};
  const imported = w.stages?.import || {};
  const artifact = w.download_result || {};
  const c = coverage || {};
  const b = c.import_batch || {};
  if (w.report_type !== REPORT_TYPE || w.platform !== PLATFORM || w.business_date !== businessDate
    || w.status !== 'success' || w.phase !== 'COMPLETED' || w.terminal !== true
    || download.status !== 'success' || imported.status !== 'success'
    || !w.task_id || !artifact.ok || !artifact.archived_name
    || !/^[0-9a-f]{12}$/.test(String(artifact.sha256_prefix || ''))
    || !c.ok || c.report_type !== REPORT_TYPE || c.business_date !== businessDate
    || !Number.isInteger(c.entry_count) || c.entry_count <= 0
    || !Number.isSafeInteger(c.total_cents) || !Number.isInteger(b.id)
    || b.id !== imported.import_batch_id || b.row_count !== c.entry_count
    || b.linked_rows !== c.entry_count || b.total_cents !== c.total_cents
    || b.linked_cents !== c.total_cents || b.sha256_prefix !== artifact.sha256_prefix
    || !Number.isInteger(b.store_count) || b.store_count <= 0)
    return { ok: false, reason: 'report_c_success_evidence_incomplete' };
  if (w.exception_evidence && (w.exception_evidence.derived_file !== artifact.archived_name
    || w.exception_evidence.derived_sha256?.slice(0, 12) !== artifact.sha256_prefix
    || w.exception_evidence.imported_rows !== b.row_count))
    return { ok: false, reason: 'report_c_exception_evidence_mismatch' };
  const started = w.created_at, finished = imported.finished_at;
  if (!started || !finished || !Number.isFinite(Date.parse(started))
    || !Number.isFinite(Date.parse(finished)) || Date.parse(finished) < Date.parse(started))
    return { ok: false, reason: 'report_c_time_evidence_invalid' };
  return { ok: true, taskId: w.task_id, batchId: b.id, fileName: artifact.archived_name,
    rows: b.row_count, stores: b.store_count, shaPrefix: b.sha256_prefix,
    started, finished, durationMs: Date.parse(finished) - Date.parse(started),
    historical: w.manual_catchup_c === true };
}
async function record({ businessDate, coverageClient, outbox = OUTBOX,
  readState = STATE.read, dryRun = false } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate || ''))
    || !coverageClient || typeof coverageClient.bookkeepingCoverage !== 'function')
    return { ok: false, reason: 'report_c_audit_context_invalid' };
  const state = readState(PLATFORM, businessDate, REPORT_TYPE);
  let response;
  try { response = await coverageClient.bookkeepingCoverage({ business_date: businessDate }); }
  catch { return { ok: false, reason: 'report_c_coverage_unavailable' }; }
  const proof = evidenceOf({ businessDate, state, coverage: response?.body });
  if (!proof.ok) return proof;
  const summary = { business_date: businessDate, import_batch_id: proof.batchId,
    rows: proof.rows, store_count: proof.stores, reconstructed: proof.historical };
  if (dryRun) return { ok: true, dry_run: true, ...summary };
  const metrics = { started_at: proof.started, finished_at: proof.finished,
    duration_ms: proof.durationMs, import_batch_id: proof.batchId,
    imported: proof.rows, raw_store_count: proof.stores, matched_store_count: proof.stores,
    original_filename: proof.fileName, sha256_prefix: proof.shaPrefix,
    ready_to_push: false, is_backfill: proof.historical,
    reconstructed: proof.historical, not_a_realtime_success: proof.historical,
    note: proof.historical ? 'verified_existing_workflow_and_batch' : 'verified_scheduled_workflow_and_batch' };
  const sent = await outbox.emit({ ctx: { taskId: proof.taskId, reportType: REPORT_TYPE,
    platform: PLATFORM, businessDate }, stage: 'IMPORT_SUCCEEDED', seq: 90, metrics });
  return { ok: sent?.ok === true, queued: sent?.queued === true,
    reason: sent?.ok ? null : String(sent?.reason || 'audit_pending'), ...summary };
}
module.exports = { evidenceOf, record };
