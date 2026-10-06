'use strict';
/**
 * B 导入成功后的审计桥：只核对现有状态和中控只读覆盖，再上报一条可幂等的摘要事件。
 * 不触发浏览器、导出、导入、日报发送，也不把历史补记伪称为实时审计时间线。
 */
const P = require('../paths');
const STATE = require('../state');
const OUTBOX = require('./audit-outbox');

const REPORT_TYPE = 'item_sales_detail';
const PLATFORM = 'meituan';

function evidenceOf({ businessDate, state, coverage } = {}) {
  const w = state && state.workflow || {};
  const stages = w.stages || {};
  const imported = stages.import || {};
  const downloaded = stages.download || {};
  const artifact = w.download_result || {};
  if (w.report_type !== REPORT_TYPE || w.platform !== PLATFORM || w.business_date !== businessDate
    || w.status !== 'success' || w.phase !== 'COMPLETED' || w.terminal !== true
    || downloaded.status !== 'success' || imported.status !== 'success'
    || !Number.isInteger(imported.import_batch_id) || imported.import_batch_id <= 0
    || !w.task_id || artifact.ok !== true || !artifact.archived_name)
    return { ok: false, reason: 'workflow_success_evidence_missing' };
  const c = coverage || {};
  if (c.ok !== true || c.report_type !== REPORT_TYPE || c.business_date !== businessDate
    || c.has_records !== true || !Number.isInteger(c.record_count) || c.record_count <= 0
    || !Number.isInteger(c.store_count) || c.store_count <= 0 || !Array.isArray(c.import_batches))
    return { ok: false, reason: 'coverage_evidence_missing' };
  const batch = c.import_batches.find((b) => b && b.batch_id === imported.import_batch_id);
  if (!batch || batch.file_name !== artifact.archived_name || batch.date_from !== businessDate
    || batch.date_to !== businessDate || !Number.isInteger(batch.row_count) || batch.row_count < c.record_count)
    return { ok: false, reason: 'batch_identity_mismatch' };
  const started = w.created_at;
  const finished = imported.finished_at;
  if (!started || !finished || !Number.isFinite(Date.parse(started)) || !Number.isFinite(Date.parse(finished))
    || Date.parse(finished) < Date.parse(started)) return { ok: false, reason: 'time_evidence_invalid' };
  return { ok: true, taskId: w.task_id, batchId: batch.batch_id, fileName: batch.file_name,
    sourceRows: batch.row_count, dbRows: c.record_count, storeCount: c.store_count,
    shaPrefix: /^[0-9a-f]{12}$/i.test(String(artifact.sha256_prefix || '')) ? artifact.sha256_prefix : null,
    started, finished, durationMs: Date.parse(finished) - Date.parse(started),
    manualCatchup: w.manual_catchup === true };
}

async function record({ businessDate, coverageClient, outbox = OUTBOX, readState = STATE.read, dryRun = false } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate || '')))
    return { ok: false, reason: 'business_date_invalid' };
  P.assertReportType(REPORT_TYPE);
  if (!coverageClient || typeof coverageClient.itemSalesCoverage !== 'function')
    return { ok: false, reason: 'coverage_client_missing' };
  const state = readState(PLATFORM, businessDate, REPORT_TYPE);
  let response;
  try { response = await coverageClient.itemSalesCoverage({ business_date: businessDate }); }
  catch { return { ok: false, reason: 'coverage_query_failed' }; }
  const proof = evidenceOf({ businessDate, state, coverage: response && response.body });
  if (!proof.ok) return proof;
  const summary = { business_date: businessDate, import_batch_id: proof.batchId,
    reconstructed: proof.manualCatchup, source_rows: proof.sourceRows, db_rows: proof.dbRows,
    store_count: proof.storeCount };
  if (dryRun) return { ok: true, dry_run: true, ...summary };
  const metrics = {
    started_at: proof.started, finished_at: proof.finished, duration_ms: proof.durationMs,
    import_batch_id: proof.batchId, imported: proof.sourceRows,
    raw_store_count: proof.storeCount, matched_store_count: proof.storeCount,
    original_filename: proof.fileName, ready_to_push: false,
    is_backfill: proof.manualCatchup, reconstructed: proof.manualCatchup,
    not_a_realtime_success: proof.manualCatchup,
    note: proof.manualCatchup ? 'verified_existing_workflow_and_batch' : 'verified_scheduled_workflow_and_batch',
  };
  if (proof.shaPrefix) metrics.sha256_prefix = proof.shaPrefix;
  const result = await outbox.emit({ ctx: { taskId: proof.taskId, reportType: REPORT_TYPE,
    platform: PLATFORM, businessDate }, stage: 'IMPORT_SUCCEEDED', seq: 90, metrics });
  return { ok: result.ok === true, queued: result.queued === true,
    reason: result.ok === true ? null : String(result.reason || 'audit_pending'), ...summary };
}

module.exports = { evidenceOf, record };
