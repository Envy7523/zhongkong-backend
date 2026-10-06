'use strict';
/** B 专属导入阶段；由 workflow-run 注入，绝不作为独立绕过 workflow 的入口。 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { verifyReportBImport } = require('./report-b-import-verification');

function createReportBImportStage({ importClient, coverageClient, validateFile, storeMapping,
  mode = 'manual_catchup' } = {}) {
  if (!importClient || typeof importClient.importArchivedFile !== 'function'
    || typeof importClient.resolveArchivedFile !== 'function'
    || !coverageClient || typeof coverageClient.itemSalesCoverage !== 'function'
    || typeof validateFile !== 'function' || !storeMapping)
    throw new Error('report_b_import_stage_dependencies_incomplete');
  if (!['manual_catchup', 'scheduled'].includes(mode)) throw new Error('report_b_import_mode_invalid');
  return {
    async runOnce({ ctx, download, g3 } = {}) {
      const fail = (reason, httpRequests = 0) => ({ ok: false, action: 'WAITING_HUMAN', reason,
        http_requests: httpRequests, retryable: false });
      const date = ctx && ctx.businessDate;
      if (!ctx || ctx.reportType !== 'item_sales_detail' || ctx.platform !== 'meituan'
        || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || !ctx.taskId)
        return fail('report_b_context_invalid');
      if (!g3 || g3.ok !== true || g3.coverage_hit === true || !g3.evidence
        || !g3.evidence.coverage || g3.evidence.coverage.ok !== true
        || g3.evidence.coverage.report_type !== ctx.reportType
        || g3.evidence.coverage.business_date !== date
        || g3.evidence.coverage.has_records !== false
        || g3.evidence.coverage.record_count !== 0)
        return fail('report_b_g3_evidence_invalid');
      const file = download && download.file;
      const archive = download && download.archive;
      if (!file || !archive || archive.report_type !== ctx.reportType
        || archive.business_date !== date || archive.historical_backfill !== (mode === 'manual_catchup')
        || !download.task || download.task.historical_backfill !== (mode === 'manual_catchup')
        || download.manual_catchup !== (mode === 'manual_catchup')
        || (mode === 'scheduled' && download.scheduled_report_b !== true))
        return fail('report_b_archive_identity_invalid');
      const fresh = await validateFile(file, { businessDate: date, storeMapping,
        storeCodesCoverage: g3.evidence.coverage, requireStoreCodes: true });
      if (!fresh || fresh.ok !== true || fresh.report_type !== ctx.reportType
        || fresh.business_date !== date) return fail('report_b_file_validation_failed');
      const prep = importClient.resolveArchivedFile({ file, reportType: ctx.reportType,
        platform: ctx.platform, businessDate: date, validation: fresh });
      if (!prep.ok) return fail('report_b_archive_' + prep.reason);
      let sha;
      try { sha = crypto.createHash('sha256').update(fs.readFileSync(prep.file)).digest('hex'); }
      catch (_) { return fail('report_b_archive_unreadable'); }
      if (!archive.sha256 || archive.sha256 !== sha || !Number.isInteger(archive.size)
        || archive.size !== prep.size) return fail('report_b_archive_sha_or_size_mismatch');
      const imported = await importClient.importArchivedFile({ file: prep.file,
        reportType: ctx.reportType, platform: ctx.platform, businessDate: date,
        validation: fresh, archiveSha256: sha });
      const calls = Number(imported && imported.requests && imported.requests.import) || 0;
      if (!imported || imported.ok !== true) return fail('report_b_import_' + String(imported && imported.error_code || 'unknown'), calls);
      let after;
      try { const r = await coverageClient.itemSalesCoverage({ business_date: date }); after = r && r.body; }
      catch (_) { after = null; }
      const proof = verifyReportBImport({ businessDate: date, fileName: path.basename(prep.file),
        validation: fresh, response: imported, coverageBefore: g3.evidence.coverage, coverageAfter: after });
      if (!proof.ok) return fail('report_b_post_import_verification_failed', calls);
      return { ok: true, action: 'IMPORT_SUCCEEDED', import_batch_id: proof.batch_id,
        http_requests: calls, source_rows: proof.source_rows, db_rows: proof.db_rows,
        store_count: proof.store_count, order_count: proof.order_count };
    },
  };
}

module.exports = { createReportBImportStage };
