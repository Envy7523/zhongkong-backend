#!/usr/bin/env node
'use strict';
const PLAN = require('../src/schedule/plan');
const REVIEW = require('../src/schedule/bookkeeping-review-plan');
function plan(now = new Date(), settings = { enabled: true, run_time: '02:00' }) {
  const current = PLAN.resolveNow(now);
  const changed = settings.updated_at && new Date(settings.updated_at);
  const changedLocal = changed && Number.isFinite(changed.getTime()) ? PLAN.resolveNow(changed) : null;
  const eligible = settings.enabled === true && PLAN.parseHHmm(settings.run_time).ok
    && !(changedLocal && changedLocal.date === current.date && changedLocal.local >= current.date + ' ' + settings.run_time + ':00');
  return { date: PLAN.previousCompleteDate(current), current: current.local, today: current.date,
    scheduled_time: settings.run_time, allowed: eligible && current.time.slice(0, 5) === settings.run_time,
    catchup_allowed: eligible && current.time.slice(0, 5) > settings.run_time,
    timezone: PLAN.TIMEZONE, review: REVIEW.reviewPlan(now) };
}
async function runReviews(p) {
  const fs = require('fs'), path = require('path'), P = require('../src/paths');
  const runKey = `daily-${p.today}`;
  const file = path.join(P.root, 'state/tasks/reviews', runKey, 'meituan/pos_bookkeeping_daily/review-manifest.json');
  if (fs.existsSync(file)) {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (['success', 'partial'].includes(m.status)) return { exitCode: m.status === 'success' ? 0 : 3,
      action: 'review_already_finished', review_status: m.status, failed: m.failed };
  }
  const days = p.review.dates;
  return new Promise(resolve => {
    const child = require('child_process').spawn(process.execPath, [path.join(__dirname, 'run-report-c-review.js'),
      '--from=' + days[0], '--to=' + days.at(-1), '--run-key=' + runKey,
      '--reuse-yesterday=' + p.date, '--confirm'], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', () => resolve({ exitCode: 3, action: 'review_start_failed' }));
    child.once('close', code => resolve({ exitCode: code === 0 ? 0 : 3, action: 'review_completed', review_days: days.length }));
  });
}
async function main(argv = process.argv.slice(2), opts = {}) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--check')) return { exitCode: 2, reason: 'invalid_arguments' };
  if (argv[0] === '--check') return { exitCode: 0, plan: plan(opts.now || new Date()), side_effects: false };
  const client = opts.client || require('../src/schedule/zk-client').createZkClient({});
  const response = await client.reportSyncPlan('pos_bookkeeping_daily');
  if (!response?.ok || !response.body?.plan || response.body.plan.report_type !== 'pos_bookkeeping_daily') return { exitCode: 3, reason: 'report_c_plan_unavailable' };
  const p = plan(opts.now || new Date(), response.body.plan);
  if (!p.allowed && !p.catchup_allowed) return { exitCode: 0, action: 'not_due', plan: p };
  process.env.SYNCBOT_REPORT_C_SCHEDULED = '1';
  const state = require('../src/state').read('meituan', p.date, 'pos_bookkeeping_daily');
  const done = state.workflow?.status === 'success' && state.workflow?.phase === 'COMPLETED';
  if (!done) {
    const fs = require('fs'), path = require('path'), P = require('../src/paths');
    const marker = path.join(P.tasks, 'meituan', 'pos_bookkeeping_daily', p.date + '.catchup-attempt.json');
    if (fs.existsSync(marker)) return { exitCode: 3, action: 'first_export_requires_review', plan: p };
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), date: p.date }));
    process.env.SYNCBOT_REPORT_SCHEDULE_TIME = p.scheduled_time;
    const result = await require('./run-report-c-manual').main(['--date=' + p.date,
      p.allowed ? '--confirm-scheduled' : '--confirm-manual-catchup'], { now: opts.now });
    if (result.exitCode !== 0) return { ...result, plan: p };
  }
  return { ...await (opts.runReviews || runReviews)(p), plan: p };
}
if (require.main === module) main().then(out => { console.log(JSON.stringify(out)); process.exitCode = out.exitCode; })
  .catch(e => { console.error(JSON.stringify({ exitCode: 3, reason: e.message })); process.exitCode = 3; });
module.exports = { plan, main, runReviews };
