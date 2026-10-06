#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const PLAN = require('../src/schedule/bookkeeping-review-plan');
function parse(argv) {
  const values = {};
  for (const arg of argv) {
    if (arg === '--confirm') { if (values.confirm) throw new Error('duplicate_argument'); values.confirm = true; continue; }
    const m = arg.match(/^--(from|to|run-key|adopt-legacy-through|reuse-yesterday)=(.+)$/);
    if (!m || values[m[1]]) throw new Error('review_argument_invalid'); values[m[1]] = m[2];
  }
  if (!values.confirm || !/^[A-Za-z0-9._-]{3,70}$/.test(values['run-key'] || '')) throw new Error('review_confirmation_required');
  const dates = PLAN.dateRange(values.from, values.to);
  const today = require('../src/schedule/plan').resolveNow().date;
  if (values.to >= today) throw new Error('review_incomplete_business_date');
  if (values['adopt-legacy-through'] && (!require('../src/schedule/plan').isPlainDate(values['adopt-legacy-through'])
    || values['adopt-legacy-through'] > values.to)) throw new Error('legacy_date_invalid');
  if (values['reuse-yesterday'] && values['reuse-yesterday'] !== PLAN.shift(today, -1)) throw new Error('reuse_date_invalid');
  return { ...values, dates };
}
async function main(argv = process.argv.slice(2)) {
  const opts = parse(argv);
  process.env.SYNCBOT_REPORT_C_MANUAL_CATCHUP = '1';
  process.env.SYNCBOT_BOOKKEEPING_REVIEW_NAMESPACE = opts['run-key'];
  const P = require('../src/paths');
  const A = require('../src/phase3/production-sync-runner');
  const client = require('../src/phase2/client'), flow = require('../src/phase2/meituan-flow');
  const zk = require('../src/schedule/zk-client').createZkClient({});
  const stage = require('../src/phase3/report-c-download-stage').createReportCDownloadStage({
    client, flow, approvals: A.createFileApprovals(), coverageClient: zk,
    archiveFn: require('../src/archive').archive, waitForDownloadFile: A.defaultWaitForDownloadFile,
    incomingDir: P.incoming('meituan', 'cashier_composite'), applicant: 'LongXia', review: true });
  const importer = require('../src/phase3/report-c-review-client').createReviewClient({});
  const lock = require('../src/shared-browser-lock');
  const directory = P.taskStateDir('meituan', 'pos_bookkeeping_daily'); P.ensureDir(directory);
  const manifestPath = path.join(directory, 'review-manifest.json');
  let manifest = { run_key: opts['run-key'], from: opts.from, to: opts.to,
    started_at: new Date().toISOString(), status: 'running', results: [], failed: [] };
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.from !== opts.from || manifest.to !== opts.to) throw new Error('review_run_scope_conflict');
    manifest.failed = []; manifest.status = 'running';
  }
  function save() { const tmp = manifestPath + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2)); fs.renameSync(tmp, manifestPath); }
  save();
  for (const date of opts.dates) {
    if (manifest.results.some(r => r.business_date === date && r.ok)) continue;
    const ctx = { reportType: 'pos_bookkeeping_daily', platform: 'meituan', businessDate: date,
      taskId: `cr-${opts['run-key']}-${date}` };
    const start = Date.now();
    try {
      const result = await lock.withSharedBrowserLock({ taskId: ctx.taskId, reportType: ctx.reportType, waitMs: 3 * 60 * 60 * 1000 }, async () => {
        const cached = path.join(directory, date + '.download.json');
        let downloaded = null;
        if (fs.existsSync(cached)) downloaded = JSON.parse(fs.readFileSync(cached, 'utf8'));
        if (!downloaded && opts['reuse-yesterday'] === date) {
          const originalPath = path.join(P.root, 'state/tasks/meituan/pos_bookkeeping_daily', date + '.json');
          const original = JSON.parse(fs.readFileSync(originalPath, 'utf8')).workflow;
          if (original?.status !== 'success' || original.business_date !== date
            || require('../src/schedule/plan').resolveNow(original.created_at).date !== require('../src/schedule/plan').resolveNow().date)
            throw new Error('yesterday_snapshot_not_fresh');
          const name = original.download_result?.archived_name;
          if (!/^[^\\/]+\.xlsx$/i.test(name || '')) throw new Error('yesterday_archive_invalid');
          downloaded = { ok: true, file: path.join(P.dayDownloads('meituan', ctx.reportType, date), name), reused_first_export: true };
        }
        if (!downloaded) {
          const state = require('../src/state').read('meituan', date, ctx.reportType);
          const existing = state.phase2?.real_download;
          downloaded = await stage.run({ ctx, resumeExisting: !!existing });
          if (!downloaded.ok || !downloaded.file) throw new Error(downloaded.failure_reason || 'review_download_failed');
        }
        fs.writeFileSync(cached, JSON.stringify(downloaded));
        return importer.review({ file: downloaded.file, businessDate: date, reviewKey: opts['run-key'],
          adoptLegacy: !!opts['adopt-legacy-through'] && date <= opts['adopt-legacy-through'] });
      });
      const item = { ...result, duration_ms: Date.now() - start, finished_at: new Date().toISOString() };
      manifest.results.push(item); save();
      console.log(JSON.stringify({ event: 'review_day_completed', business_date: date, status: result.status,
        differences: result.differences?.length || 0, rows: result.row_count, duration_ms: item.duration_ms,
        completed: manifest.results.length, total: opts.dates.length }));
    } catch (e) {
      const reason = require('../src/phase3/real-download-audit').scrubText(e.message, 160);
      manifest.failed.push({ business_date: date, reason }); save();
      console.log(JSON.stringify({ event: 'review_day_failed', business_date: date, reason }));
      // Do not repeat an uncertain export automatically. Continue other dates, preserving failed state for resume.
    }
  }
  manifest.status = manifest.failed.length ? 'partial' : 'success';
  manifest.finished_at = new Date().toISOString(); save();
  return { ok: manifest.status === 'success', status: manifest.status, completed: manifest.results.length,
    total: opts.dates.length, failed: manifest.failed };
}
if (require.main === module) main().then(r => { console.log(JSON.stringify(r)); process.exitCode = r.ok ? 0 : 1; })
  .catch(e => { console.error(JSON.stringify({ ok: false, reason: e.message })); process.exitCode = 1; });
module.exports = { main, parse };
