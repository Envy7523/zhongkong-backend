'use strict';
/** C 独立下载阶段。只做网页导出/文件归档和校验；不导入、不发群。 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const P = require('../paths');
const STATE = require('../state');
const E = require('../phase2/report-c-construction-exception');
const Q = require('../phase2/report-c-query-flow');
const R = require('../phase2/report-c-export-readiness');
const V = require('../phase2/report-c-file-validate');
const G = require('./report-c-coverage-gates');
const RA = require('../phase2/real-download-adapters');
const RD = require('../phase2/real-download');
const A = require('./production-sync-runner');

function createReportCDownloadStage({ client, flow, approvals, coverageClient,
  archiveFn, waitForDownloadFile, incomingDir, applicant, mode = 'manual_catchup', review = false, audit = () => {} } = {}) {
  if (!client || typeof client.call !== 'function' || !flow || !approvals
    || typeof approvals.read !== 'function' || typeof approvals.write !== 'function'
    || !coverageClient || typeof coverageClient.bookkeepingCoverage !== 'function'
    || typeof archiveFn !== 'function' || typeof waitForDownloadFile !== 'function'
    || !incomingDir || !applicant || !['manual_catchup', 'scheduled'].includes(mode))
    throw new Error('report_c_download_dependencies_incomplete');
  return {
    async resumeValidated({ ctx, archivedName, shaPrefix, allowException = false } = {}) {
      if (!ctx || ctx.reportType !== 'pos_bookkeeping_daily' || !ctx.taskId
        || !/^[0-9a-f]{12}$/.test(String(shaPrefix || ''))
        || !/^[^\\/]+\.xlsx$/i.test(String(archivedName || '')))
        return { ok: false, failure_reason: 'validated_archive_identity_invalid' };
      const taskState = STATE.read(ctx.platform, ctx.businessDate, ctx.reportType);
      const rd = taskState?.phase2?.real_download;
      if (!rd || rd.task_id !== ctx.taskId || rd.phase !== 'STOPPED'
        || !rd.export_submitted_at || rd.irreversible?.export_submit !== true
        || !(rd.history || []).some(h => h.to === 'FILE_VALIDATED'))
        return { ok: false, failure_reason: 'validated_archive_state_invalid' };
      let file, bytes, stat;
      try {
        const dayDir = P.dayDownloads('meituan', ctx.reportType, ctx.businessDate);
        file = path.join(dayDir, archivedName);
        if (fs.realpathSync(path.dirname(file)) !== fs.realpathSync(dayDir)) throw new Error('outside');
        stat = fs.statSync(file);
        bytes = fs.readFileSync(file);
      } catch { return { ok: false, failure_reason: 'validated_archive_unreadable' }; }
      const validation = V.validateReportCFile(file, ctx.businessDate);
      let sha = crypto.createHash('sha256').update(bytes).digest('hex');
      if (!stat.isFile() || !validation.ok || validation.sha256 !== sha || sha.slice(0, 12) !== shaPrefix)
        return { ok: false, failure_reason: 'validated_archive_mismatch' };
      let derivedEvidence = null;
      if (allowException === true) {
        const derived = E.derive({ file, businessDate: ctx.businessDate });
        if (!derived.ok) return { ok: false, failure_reason: derived.reason };
        file = derived.file;
        stat = fs.statSync(file);
        sha = derived.sha256;
        derivedEvidence = derived.evidence;
      }
      const effective = V.validateReportCFile(file, ctx.businessDate);
      if (!effective.ok) return { ok: false, failure_reason: 'effective_archive_validation_failed' };
      const backfill = mode === 'manual_catchup';
      return { ok: true, result: 'FILE_VALIDATED', phase: 'STOPPED', export_submitted: true,
        file, archived_name: path.basename(file),
        sha256_prefix: sha.slice(0, 12), exception_evidence: derivedEvidence,
        archive: { file, size: stat.size, sha256: sha, platform: ctx.platform,
          report_type: ctx.reportType, business_date: ctx.businessDate, historical_backfill: backfill },
        task: { task_id: ctx.taskId, report_type: ctx.reportType, platform: ctx.platform,
          business_date: ctx.businessDate, historical_backfill: backfill },
        manual_catchup: backfill, scheduled_report_c: !backfill, validation: effective };
    },
    async run({ ctx, resumeExisting = false, retryPreExport = false } = {}) {
      const fail = reason => ({ ok: false, phase: 'PRECHECK', failure_stage: 'report_c_download',
        failure_reason: reason, export_submitted: resumeExisting === true });
      if (!ctx || ctx.reportType !== Q.RULES.report_type || ctx.platform !== 'meituan'
        || !/^\d{4}-\d{2}-\d{2}$/.test(String(ctx.businessDate || '')) || !ctx.taskId
        || retryPreExport) return fail('report_c_context_or_retry_invalid');
      let raw;
      try { raw = await coverageClient.bookkeepingCoverage({ business_date: ctx.businessDate }); }
      catch { return fail('bookkeeping_coverage_unavailable'); }
      const coverage = G.beforeExport(raw, ctx.businessDate, { review });
      if (!coverage.ok) return fail(coverage.reason);
      if (typeof approvals.bind === 'function') approvals.bind(ctx.taskId);
      const archiveWithRecovery = Object.assign((opts) => archiveFn(opts), {
        recoverArchived: ({ srcFile }) => {
          const stat = fs.lstatSync(srcFile);
          if (!stat.isFile() || stat.size <= 0) throw new Error('recorded_archive_invalid');
          return { file: srcFile, size: stat.size,
            sha256: crypto.createHash('sha256').update(fs.readFileSync(srcFile)).digest('hex') };
        },
      });
      const adapters = RA.createProductionAdapters({ client, flow, approvals,
        rules: Q.RULES, selectors: { get: key => null },
        queryFlow: args => Q.navigateAndQueryReportC({ ...args, allowEmpty: review }),
        exportReadiness: args => R.checkReportCExportReadiness({ ...args, allowEmpty: review }),
        validateFileFn: (file, opts) => V.validateReportCFile(file, opts.businessDate),
        archiveFn: archiveWithRecovery, waitForDownloadFile, incomingDir, applicant,
        coverageRequired: false, audit });
      const store = A.createFlowStore({ reportType: ctx.reportType,
        businessDate: ctx.businessDate, taskId: ctx.taskId });
      const orchestrator = RD.createOrchestrator({ ctx, store, adapters,
        reportName: Q.RULES.report_name });
      const summary = await orchestrator.run({ applicant, resumeExisting });
      const result = A.mapDownloadResult(summary, ctx);
      if (result.archive) result.archive.historical_backfill = mode === 'manual_catchup';
      if (result.task) result.task.historical_backfill = mode === 'manual_catchup';
      result.manual_catchup = mode === 'manual_catchup';
      result.scheduled_report_c = mode === 'scheduled';
      return result;
    },
  };
}
module.exports = { createReportCDownloadStage };
