#!/usr/bin/env node
'use strict';
/** 品项销售明细单日人工补齐；唯一真实入口仍是 workflow-run.js。绝不创建 timer。 */

function parse(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const modeFlags = ['--preflight', '--confirm-manual-catchup', '--confirm-scheduled'].filter(x => args.includes(x));
  const mode = modeFlags.length === 1 ? ({ '--preflight': 'preflight',
    '--confirm-manual-catchup': 'manual_catchup', '--confirm-scheduled': 'scheduled' })[modeFlags[0]] : null;
  const retryPreExport = args.includes('--retry-pre-export');
  const resumeExisting = args.includes('--resume-existing');
  const resumeValidated = args.includes('--resume-validated');
  const recoveryCount = [retryPreExport, resumeExisting, resumeValidated].filter(Boolean).length;
  if (!mode || args.length !== (recoveryCount ? 3 : 2)
    || (recoveryCount && mode !== 'manual_catchup') || recoveryCount > 1
    || new Set(args).size !== args.length || args.some(x => !/^--date=/.test(x)
      && !['--preflight', '--confirm-manual-catchup', '--confirm-scheduled', '--retry-pre-export', '--resume-existing', '--resume-validated'].includes(x)))
    return { ok: false, reason: 'usage: --date=YYYY-MM-DD (--preflight | --confirm-manual-catchup [--retry-pre-export|--resume-existing|--resume-validated] | --confirm-scheduled)' };
  const raw = args.find(x => /^--date=/.test(x));
  const date = raw && raw.slice(7);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')))
    return { ok: false, reason: 'business_date_invalid' };
  const d = new Date(date + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date)
    return { ok: false, reason: 'business_date_not_real' };
  return { ok: true, date, mode, retryPreExport, resumeExisting, resumeValidated };
}

async function main(argv = process.argv.slice(2), { now } = {}) {
  const parsed = parse(argv);
  if (!parsed.ok) return { exitCode: 2, reason: parsed.reason };
  if (parsed.mode === 'scheduled') {
    const PLAN = require('../src/schedule/plan');
    const current = PLAN.resolveNow(now);
    const scheduledTime = process.env.SYNCBOT_REPORT_SCHEDULE_TIME || '03:20';
    if (parsed.date !== PLAN.previousCompleteDate(current)
      || !PLAN.parseHHmm(scheduledTime).ok || current.time.slice(0, 5) !== scheduledTime)
      return { exitCode: 3, reason: 'report_b_scheduled_date_or_window_invalid' };
    process.env.SYNCBOT_REPORT_B_SCHEDULED = '1';
  } else {
    process.env.SYNCBOT_REPORT_B_MANUAL_CATCHUP = '1';
  }
  const P = require('../src/paths');
  const WF = require('../src/phase3/workflow-run');
  const A = require('../src/phase3/production-sync-runner');
  const ZK = require('../src/schedule/zk-client');
  const IC = require('../src/phase3/import-client');
  const V = require('../src/phase2/report-b-file-validate');
  const G = require('../src/phase3/report-b-coverage-gates');
  const { withSharedBrowserLock } = require('../src/shared-browser-lock');
  const { createReportBDownloadStage } = require('../src/phase3/report-b-download-stage');
  const { createReportBImportStage } = require('../src/phase3/report-b-import-stage');
  const zk = ZK.createZkClient({});
  if (zk.base_ok !== true || typeof zk.itemSalesCoverage !== 'function')
    return { exitCode: 3, reason: 'item_coverage_client_unavailable' };
  if (parsed.mode === 'preflight') {
    const raw = await zk.itemSalesCoverage({ business_date: parsed.date });
    const coverage = G.normalizeItemCoverage(raw, parsed.date);
    if (!coverage.ok || coverage.covered) return { exitCode: 3, reason: coverage.reason || 'item_coverage_hit' };
    const browser = require('../src/phase2/client');
    const R = require('../src/phase2/report-b-export-readiness');
    const ready = await R.checkReportBExportReadiness({ client: browser, businessDate: parsed.date });
    return ready.ok ? { exitCode: 0, preflight: { ok: true, business_date: parsed.date,
      declared_count: ready.declared_count, first_row_date: ready.first_row_date,
      store_codes: coverage.store_codes.length, existing_b_records: coverage.record_count } }
      : { exitCode: 3, reason: ready.reason };
  }
  const mapping = A.resolveStoreMapping();
  if (!mapping.ok) return { exitCode: 3, reason: mapping.reason };
  const browser = require('../src/phase2/client');
  const flow = require('../src/phase2/meituan-flow');
  const archive = require('../src/archive');
  const approvals = A.createFileApprovals();
  // 当前常驻浏览器只监听 A 的 _incoming。仅此人工补齐进程借用该落地区；
  // B 工作表、业务日、机构编码与 SHA 必须校验后才可归档到 B 独立日目录。
  const stageDownload = createReportBDownloadStage({ client: browser, flow, approvals,
    coverageClient: zk, storeMapping: mapping.json, archiveFn: archive.archive,
    waitForDownloadFile: A.defaultWaitForDownloadFile,
    incomingDir: P.incoming('meituan', 'cashier_composite'), applicant: 'LongXia',
    mode: parsed.mode });
  const stageImport = createReportBImportStage({ importClient: IC.createImportClient({}),
    coverageClient: zk, validateFile: V.validateReportBFile, storeMapping: mapping.json,
    mode: parsed.mode });
  const wf = WF.createWorkflowRun({ reportType: 'item_sales_detail', businessDate: parsed.date,
    platform: 'meituan', taskIdPrefix: parsed.mode === 'scheduled' ? 'bsched' : 'bmanual',
    confirm: true, backfill: parsed.mode === 'manual_catchup', reportBMode: parsed.mode,
    gates: G.createReportBCoverageGates(zk),
    stageDownload, stageImport });
  const result = await withSharedBrowserLock({ taskId: `${parsed.mode === 'scheduled' ? 'bsched' : 'bmanual'}-meituan-item_sales_detail-${parsed.date}`,
    reportType: 'item_sales_detail' }, () => wf.runOnce({ confirm: true, retryPreExport: parsed.retryPreExport,
    resumeExisting: parsed.resumeExisting, resumeValidated: parsed.resumeValidated }));
  let audit = null;
  if (result && result.ok === true) {
    try {
      const bridge = require('../src/phase3/report-b-audit-bridge');
      audit = await bridge.record({ businessDate: parsed.date, coverageClient: zk });
    } catch (_) { audit = { ok: false, reason: 'audit_bridge_exception' }; }
  }
  // 审计失败不能重跑已经成功的导出/导入；只保留待补送状态。
  return { exitCode: result && result.ok === true ? 0 : 3, result, audit };
}

if (require.main === module) main().then(out => {
  console.log(JSON.stringify(out));
  process.exitCode = out.exitCode;
}).catch(e => { console.error(JSON.stringify({ exitCode: 3, reason: 'report_b_manual_unhandled' })); process.exitCode = 3; });

module.exports = { parse, main };
