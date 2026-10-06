'use strict';
/** B 下载阶段装配。只能由 data-only workflow 注入；不创建计划，不发导入请求。 */
const B = require('../phase2/report-b-query-flow');
const R = require('../phase2/report-b-export-readiness');
const V = require('../phase2/report-b-file-validate');
const G = require('./report-b-coverage-gates');
const RA = require('../phase2/real-download-adapters');
const RD = require('../phase2/real-download');
const A = require('./production-sync-runner');
const E = require('../phase2/report-b-construction-exception');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const P = require('../paths');
const STATE = require('../state');

function createReportBDownloadStage({ client, flow, approvals, coverageClient, storeMapping,
  archiveFn, waitForDownloadFile, incomingDir, applicant, mode = 'manual_catchup', audit = () => {} } = {}) {
  if (!client || typeof client.call !== 'function' || !flow || !approvals
    || typeof approvals.read !== 'function' || typeof approvals.write !== 'function'
    || !coverageClient || typeof coverageClient.itemSalesCoverage !== 'function'
    || !storeMapping || typeof archiveFn !== 'function'
    || typeof waitForDownloadFile !== 'function' || !incomingDir || !applicant)
    throw new Error('report_b_download_stage_dependencies_incomplete');
  if (!['manual_catchup', 'scheduled'].includes(mode)) throw new Error('report_b_download_mode_invalid');
  return {
    async resumeValidated({ ctx, archivedName, shaPrefix } = {}) {
      const fail = reason => ({ ok: false, failure_reason: reason, export_submitted: true });
      if (!ctx || ctx.reportType !== 'item_sales_detail' || ctx.platform !== 'meituan'
        || !ctx.taskId || !/^\d{4}-\d{2}-\d{2}$/.test(String(ctx.businessDate || ''))
        || !archivedName || path.basename(archivedName) !== archivedName
        || !/^[0-9a-f]{12}$/i.test(String(shaPrefix || ''))) return fail('validated_archive_identity_invalid');
      const task = STATE.read(ctx.platform, ctx.businessDate, ctx.reportType);
      const rd = task && task.phase2 && task.phase2.real_download;
      if (!rd || rd.task_id !== ctx.taskId || rd.phase !== 'STOPPED'
        || !rd.export_submitted_at || !rd.irreversible || rd.irreversible.export_submit !== true
        || !(rd.history || []).some(h => h.to === 'FILE_VALIDATED')) return fail('validated_archive_state_invalid');
      const file = path.join(P.dayDownloads(ctx.platform, ctx.reportType, ctx.businessDate), archivedName);
      let stat, sha;
      try {
        stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size <= 0) return fail('validated_archive_missing');
        sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      } catch { return fail('validated_archive_unreadable'); }
      if (!sha.startsWith(shaPrefix.toLowerCase())) return fail('validated_archive_sha_mismatch');
      if (archivedName.includes('_忽略麓城筹建测试行.xlsx')) {
        let sidecar;
        try { sidecar = JSON.parse(fs.readFileSync(file + '.exception.json', 'utf8')); }
        catch { return fail('construction_exception_evidence_missing'); }
        const original = path.join(path.dirname(file), sidecar.original_file || '');
        if (sidecar.business_date !== ctx.businessDate || sidecar.project_id !== 29
          || sidecar.derived_file !== archivedName || sidecar.derived_sha256 !== sha
          || !Number.isInteger(sidecar.excluded_rows) || sidecar.excluded_rows < 1
          || path.basename(original) !== sidecar.original_file) return fail('construction_exception_evidence_invalid');
        try {
          if (crypto.createHash('sha256').update(fs.readFileSync(original)).digest('hex') !== sidecar.original_sha256)
            return fail('construction_original_sha_mismatch');
        } catch { return fail('construction_original_missing'); }
      }
      let raw;
      try { raw = await coverageClient.itemSalesCoverage({ business_date: ctx.businessDate }); }
      catch { return fail('report_b_coverage_query_failed'); }
      const coverage = G.normalizeItemCoverage(raw, ctx.businessDate);
      if (!coverage.ok || coverage.covered) return fail(coverage.reason || 'report_b_coverage_hit');
      const validation = V.validateReportBFile(file, { businessDate: ctx.businessDate,
        storeMapping, storeCodesCoverage: coverage.coverage, requireStoreCodes: true });
      if (!validation.ok) return fail('validated_archive_recheck_failed');
      return { ok: true, result: 'FILE_VALIDATED', phase: 'STOPPED', export_submitted: true,
        file, archived_name: archivedName, sha256_prefix: sha.slice(0, 12),
        archive: { file, size: stat.size, sha256: sha, platform: ctx.platform,
          report_type: ctx.reportType, business_date: ctx.businessDate, historical_backfill: mode === 'manual_catchup' },
        task: { task_id: ctx.taskId, platform: ctx.platform, report_type: ctx.reportType,
          business_date: ctx.businessDate, historical_backfill: mode === 'manual_catchup' },
        validation, manual_catchup: mode === 'manual_catchup', scheduled_report_b: mode === 'scheduled', approvals_reset: true };
    },
    async run({ ctx, resumeExisting = false, retryPreExport = false } = {}) {
      const fail = reason => ({ ok: false, phase: 'PRECHECK', failure_stage: 'report_b_download',
        failure_reason: reason, export_submitted: resumeExisting === true });
      if (!ctx || ctx.reportType !== B.RULES.report_type || ctx.platform !== 'meituan'
        || !/^\d{4}-\d{2}-\d{2}$/.test(String(ctx.businessDate || '')) || !ctx.taskId)
        return fail('report_b_context_invalid');
      let raw;
      try { raw = await coverageClient.itemSalesCoverage({ business_date: ctx.businessDate }); }
      catch (_) { return fail('report_b_coverage_query_failed'); }
      const coverage = G.normalizeItemCoverage(raw, ctx.businessDate);
      if (!coverage.ok || coverage.covered) return fail(coverage.reason || 'report_b_coverage_hit');
      if (typeof approvals.bind === 'function') approvals.bind(ctx.taskId);
      const archiveWithRecovery = Object.assign((opts) => archiveFn(opts), {
        recoverArchived: ({ srcFile }) => {
          const stat = fs.lstatSync(srcFile);
          if (!stat.isFile() || stat.size <= 0) throw new Error('recorded_archive_invalid');
          return { file: srcFile, size: stat.size,
            sha256: crypto.createHash('sha256').update(fs.readFileSync(srcFile)).digest('hex') };
        },
      });
      const validateWithConstructionRule = (file, opts) => {
        const original = V.validateReportBFile(file, opts);
        if (original.ok) return original;
        const assessed = E.assess({ file, businessDate: ctx.businessDate,
          mapping: storeMapping, coverage: coverage.coverage });
        if (!assessed.ok || !assessed.applicable) return original;
        const derived = E.derive({ file, businessDate: ctx.businessDate,
          mapping: storeMapping, coverage: coverage.coverage });
        if (!derived.ok) return { ...original, errors: [...(original.errors || []), derived.reason] };
        const validated = V.validateReportBFile(derived.file, opts);
        if (!validated.ok) return validated;
        return { ...validated, effective_file: derived.file, effective_size: derived.size,
          effective_sha256: derived.sha256, exception_evidence: derived.evidence };
      };
      const adapters = RA.createProductionAdapters({ client, flow, approvals,
        rules: B.RULES, selectors: { get: key => null },
        queryFlow: B.navigateAndQueryReportB,
        exportReadiness: R.checkReportBExportReadiness,
        validateFileFn: validateWithConstructionRule,
        archiveFn: archiveWithRecovery, waitForDownloadFile, incomingDir, applicant,
        storeMapping, storeCodesCoverage: coverage.coverage,
        coverageRequired: true, audit });
      const store = A.createFlowStore({ reportType: ctx.reportType,
        businessDate: ctx.businessDate, taskId: ctx.taskId });
      // reportName 必须显式为 B；否则底层下载清单匹配器会默认匹配 A。
      const orchestrator = RD.createOrchestrator({ ctx, store, adapters,
        reportName: B.RULES.report_name });
      const summary = await orchestrator.run({ applicant, resumeExisting, retryPreExport });
      const result = A.mapDownloadResult(summary, ctx);
      // 9/19 起的缺口由人工补齐：写真实历史属性，绝不冒充实时成功。
      if (result.archive) result.archive.historical_backfill = mode === 'manual_catchup';
      if (result.task) result.task.historical_backfill = mode === 'manual_catchup';
      result.manual_catchup = mode === 'manual_catchup';
      result.scheduled_report_b = mode === 'scheduled';
      return result;
    },
  };
}

module.exports = { createReportBDownloadStage };
