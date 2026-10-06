#!/usr/bin/env node
'use strict';
/** 门店收支统计逐日补齐；所有真实动作都经 workflow-run 和 C 独立覆盖闸门。 */
function parse(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const manual = args.includes('--confirm-manual-catchup');
  const scheduled = args.includes('--confirm-scheduled');
  const resumeExisting = args.includes('--resume-existing');
  const resumeValidated = args.includes('--resume-validated');
  const resumePreviewRejected = args.includes('--resume-preview-rejected');
  const dateFlag = args.find(x => /^--date=/.test(x));
  if (manual === scheduled || args.length !== (resumeExisting || resumeValidated || resumePreviewRejected ? 3 : 2)
    || [resumeExisting, resumeValidated, resumePreviewRejected].filter(Boolean).length > 1
    || (scheduled && (resumeExisting || resumeValidated || resumePreviewRejected))
    || new Set(args).size !== args.length
    || args.some(x => !/^--date=/.test(x) && !['--confirm-manual-catchup', '--confirm-scheduled', '--resume-existing', '--resume-validated', '--resume-preview-rejected'].includes(x)))
    return { ok: false, reason: 'usage: --date=YYYY-MM-DD (--confirm-scheduled | --confirm-manual-catchup [--resume-existing|--resume-validated|--resume-preview-rejected])' };
  const date = dateFlag?.slice(7);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')))
    return { ok: false, reason: 'business_date_invalid' };
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)
    return { ok: false, reason: 'business_date_not_real' };
  return { ok: true, date, mode: scheduled ? 'scheduled' : 'manual_catchup',
    resumeExisting, resumeValidated, resumePreviewRejected };
}

async function main(argv = process.argv.slice(2), { now } = {}) {
  const parsed = parse(argv);
  if (!parsed.ok) return { exitCode: 2, reason: parsed.reason };
  if (parsed.mode === 'scheduled') {
    const PLAN = require('../src/schedule/plan');
    const current = PLAN.resolveNow(now);
    const scheduledTime = process.env.SYNCBOT_REPORT_SCHEDULE_TIME || '04:40';
    if (parsed.date !== PLAN.previousCompleteDate(current)
      || !PLAN.parseHHmm(scheduledTime).ok || current.time.slice(0, 5) !== scheduledTime)
      return { exitCode: 3, reason: 'report_c_scheduled_date_or_window_invalid' };
    process.env.SYNCBOT_REPORT_C_SCHEDULED = '1';
  } else process.env.SYNCBOT_REPORT_C_MANUAL_CATCHUP = '1';
  const P = require('../src/paths');
  const WF = require('../src/phase3/workflow-run');
  const A = require('../src/phase3/production-sync-runner');
  const ZK = require('../src/schedule/zk-client');
  const G = require('../src/phase3/report-c-coverage-gates');
  const { createReportCDownloadStage } = require('../src/phase3/report-c-download-stage');
  const { createReportCImportStage } = require('../src/phase3/report-c-import-stage');
  const { createReportCImportClient } = require('../src/phase3/report-c-import-client');
  const { withSharedBrowserLock } = require('../src/shared-browser-lock');
  const zk = ZK.createZkClient({});
  if (!zk.base_ok || typeof zk.bookkeepingCoverage !== 'function')
    return { exitCode: 3, reason: 'bookkeeping_coverage_client_unavailable' };
  const browser = require('../src/phase2/client');
  const flow = require('../src/phase2/meituan-flow');
  const archive = require('../src/archive');
  const approvals = A.createFileApprovals();
  const stageDownload = createReportCDownloadStage({ client: browser, flow, approvals,
    coverageClient: zk, archiveFn: archive.archive,
    waitForDownloadFile: A.defaultWaitForDownloadFile,
    incomingDir: P.incoming('meituan', 'cashier_composite'), applicant: 'LongXia',
    mode: parsed.mode });
  const stageImport = createReportCImportStage({ importClient: createReportCImportClient({ coverageClient: zk }),
    mode: parsed.mode });
  const wf = WF.createWorkflowRun({ reportType: 'pos_bookkeeping_daily', businessDate: parsed.date,
    platform: 'meituan', taskIdPrefix: parsed.mode === 'scheduled' ? 'csched' : 'cmanual',
    confirm: true, backfill: parsed.mode === 'manual_catchup',
    reportCMode: parsed.mode, gates: G.createReportCCoverageGates(zk),
    stageDownload, stageImport });
  const result = await withSharedBrowserLock({ taskId: `${parsed.mode === 'scheduled' ? 'csched' : 'cmanual'}-meituan-pos_bookkeeping_daily-${parsed.date}`,
    reportType: 'pos_bookkeeping_daily' }, () => wf.runOnce({ confirm: true,
    resumeExisting: parsed.resumeExisting,
    resumeValidated: parsed.resumeValidated || parsed.resumePreviewRejected,
    resumePreviewRejected: parsed.resumePreviewRejected }));
  let audit = null;
  if (result?.ok === true) {
    try { audit = await require('../src/phase3/report-c-audit-bridge').record({
      businessDate: parsed.date, coverageClient: zk }); }
    catch { audit = { ok: false, reason: 'report_c_audit_bridge_exception' }; }
  }
  return { exitCode: result?.ok ? 0 : 3, result, audit };
}
if (require.main === module) main().then(out => {
  console.log(JSON.stringify(out)); process.exitCode = out.exitCode;
}).catch(e => { const { scrubText } = require('../src/phase3/real-download-audit');
  console.error(JSON.stringify({ exitCode: 3, reason: 'report_c_manual_unhandled',
    detail: scrubText(e?.message, 120) })); process.exitCode = 3; });
module.exports = { parse, main };
