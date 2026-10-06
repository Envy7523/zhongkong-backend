'use strict';
/** C 专用导入阶段；只接受当前 workflow 的已归档、已校验文件。 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const V = require('../phase2/report-c-file-validate');
const G = require('./report-c-coverage-gates');

function createReportCImportStage({ importClient, mode = 'manual_catchup' } = {}) {
  if (!importClient || typeof importClient.importArchived !== 'function'
    || !['manual_catchup', 'scheduled'].includes(mode))
    throw new Error('report_c_import_dependencies_incomplete');
  return {
    async runOnce({ ctx, download, g3 } = {}) {
      const fail = (reason, calls = 0, submitted = false) => ({ ok: false,
        action: 'WAITING_HUMAN', reason, http_requests: calls, import_submitted: submitted,
        retryable: false });
      const day = ctx?.businessDate;
      if (ctx?.reportType !== 'pos_bookkeeping_daily' || ctx?.platform !== 'meituan'
        || !/^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) || !ctx.taskId)
        return fail('report_c_context_invalid');
      if (!g3?.ok || g3.coverage_hit || !G.beforeExport(g3.evidence?.coverage, day).ok)
        return fail('report_c_g3_evidence_invalid');
      const archive = download?.archive;
      const file = download?.file;
      const backfill = mode === 'manual_catchup';
      if (!download?.ok || !file || !archive || archive.file !== file
        || archive.platform !== ctx.platform || archive.report_type !== ctx.reportType
        || archive.business_date !== day || archive.historical_backfill !== backfill
        || download.task?.task_id !== ctx.taskId || download.task?.historical_backfill !== backfill
        || download.manual_catchup !== backfill
        || (mode === 'scheduled' && download.scheduled_report_c !== true))
        return fail('report_c_archive_identity_invalid');
      const validation = V.validateReportCFile(file, day);
      if (!validation.ok || !Number.isInteger(archive.size) || !/^[0-9a-f]{64}$/.test(String(archive.sha256 || '')))
        return fail('report_c_file_validation_failed');
      let stat, sha;
      try {
        stat = fs.statSync(file);
        sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      } catch { return fail('report_c_archive_unreadable'); }
      if (!stat.isFile() || stat.size !== archive.size || sha !== archive.sha256
        || sha !== validation.sha256 || path.basename(file) !== download.archived_name)
        return fail('report_c_archive_sha_or_size_mismatch');
      const result = await importClient.importArchived({ file, businessDate: day,
        validation, archiveSha256: sha, confirm: true });
      const requests = result?.requests || {};
      const calls = Number(requests.login || 0) + Number(requests.preview || 0) + Number(requests.commit || 0);
      if (!result?.ok) return fail('report_c_import_' + String(result?.reason || 'unknown'),
        calls, result?.import_submitted === true);
      return { ok: true, action: 'IMPORT_SUCCEEDED', import_batch_id: result.batch_id,
        http_requests: calls, source_rows: result.row_count, db_rows: result.row_count,
        store_count: result.store_count, total_cents: result.total_cents };
    },
  };
}
module.exports = { createReportCImportStage };
