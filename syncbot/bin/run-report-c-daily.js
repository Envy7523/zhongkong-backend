#!/usr/bin/env node
'use strict';
/** C 独立日计划：读取中控时间，处理前一业务日，数据导入而不发群。 */
const PLAN = require('../src/schedule/plan');
function plan(now = new Date(), settings = { enabled: true, run_time: '04:40' }) {
  const current = PLAN.resolveNow(now);
  const scheduledTime = String(settings.run_time || '');
  const changed = settings.updated_at && new Date(settings.updated_at);
  const changedLocal = changed && Number.isFinite(changed.getTime()) ? PLAN.resolveNow(changed) : null;
  return { date: PLAN.previousCompleteDate(current), current: current.local,
    scheduled_time: scheduledTime,
    allowed: settings.enabled === true && PLAN.parseHHmm(scheduledTime).ok
      && current.time.slice(0, 5) === scheduledTime
      && !(changedLocal && changedLocal.date === current.date && changedLocal.local >= current.date + ' ' + scheduledTime + ':00'),
    catchup_allowed: settings.enabled === true && PLAN.parseHHmm(scheduledTime).ok
      && current.time.slice(0, 5) > scheduledTime
      && !(changedLocal && changedLocal.date === current.date && changedLocal.local >= current.date + ' ' + scheduledTime + ':00'),
    timezone: PLAN.TIMEZONE };
}
async function main(argv = process.argv.slice(2), opts = {}) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--check'))
    return { exitCode: 2, reason: 'no_arguments_allowed_except_check' };
  if (argv[0] === '--check') return { exitCode: 0, plan: plan(opts.now || new Date()), side_effects: false, note: '仅本地时间计算；真实执行还要读取中控计划' };
  const client = opts.client || require('../src/schedule/zk-client').createZkClient({});
  const response = await client.reportSyncPlan('pos_bookkeeping_daily');
  if (!response?.ok || !response.body?.plan || response.body.plan.report_type !== 'pos_bookkeeping_daily')
    return { exitCode: 3, reason: 'report_c_plan_unavailable' };
  const p = plan(opts.now || new Date(), response.body.plan);
  if (!p.allowed && p.catchup_allowed) {
    const fsx = require('fs'); const pathx = require('path');
    const P = require('../src/paths'); const STATE = require('../src/state');
    const st = STATE.read('meituan', p.date, 'pos_bookkeeping_daily');
    const done = !!(st && ((st.import && st.import.status === 'success') || (st.workflow && st.workflow.phase === 'COMPLETED')));
    const marker = pathx.join(P.tasks, 'meituan', 'pos_bookkeeping_daily', p.date + '.catchup-attempt.json');
    if (done || fsx.existsSync(marker)) return { exitCode: 0, action: 'not_due', plan: p, side_effects: false };
    fsx.mkdirSync(pathx.dirname(marker), { recursive: true });
    fsx.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), date: p.date, report_type: 'pos_bookkeeping_daily', reason: 'missed_window_catch_up' }));
    process.env.SYNCBOT_REPORT_SCHEDULE_TIME = p.scheduled_time;
    const M = require('./run-report-c-manual');
    const r = await M.main(['--date=' + p.date, '--confirm-manual-catchup'], { now: opts.now });
    return Object.assign({}, r, { action: 'catch_up', plan: p });
  }
  if (!p.allowed) return { exitCode: 0, action: 'not_due', plan: p, side_effects: false };
  process.env.SYNCBOT_REPORT_SCHEDULE_TIME = p.scheduled_time;
  const C = require('./run-report-c-manual');
  return C.main(['--date=' + p.date, '--confirm-scheduled'], { now: opts.now });
}
if (require.main === module) main().then(out => {
  console.log(JSON.stringify(out)); process.exitCode = out.exitCode;
}).catch((e) => {
  console.error(JSON.stringify({ exitCode: 3, reason: 'report_c_daily_unhandled',
    error: String(e && e.message), stack: String(e && e.stack || '').split('\n').slice(0, 6) }));
  process.exitCode = 3;
});
module.exports = { plan, main };
