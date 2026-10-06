#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path');
const { request } = require('../src/phase2/proto');
const api = require('../src/meituan-delivery/api');
function local(now) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(x => [x.type,x.value]));
  const date = `${values.year}-${values.month}-${values.day}`, time = `${values.hour}:${values.minute}`;
  return { date, time, previous: new Date(Date.parse(date + 'T00:00:00Z') - 86400000).toISOString().slice(0,10) };
}
async function tick({ root = process.env.SYNCBOT_ROOT || '/opt/zhongkong-sync-bot', now = new Date() } = {}) {
  const result = await api.call(root, '/api/internal/syncbot/report-sync-plans/meituan_delivery_operating');
  if (result.plan?.enabled !== true) return { skipped: 'plan_disabled' };
  const at = local(now), scheduled = result.plan.run_time;
  if (!/^\d{2}:\d{2}$/.test(scheduled || '')) throw Error('operating_schedule_invalid');
  const minutes = value => Number(value.slice(0,2)) * 60 + Number(value.slice(3,5));
  // 启用不会补跑旧日；只在计划时刻后的 15 分钟窗口启动当天一次任务。
  const elapsed = minutes(at.time) - minutes(scheduled);
  if (elapsed < 0 || elapsed >= 15) return { skipped: 'outside_schedule_window' };
  const file = path.join(root, 'state/meituan-delivery-schedule.json');
  const prior = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : null;
  if (prior?.date === at.date) return { skipped: 'already_attempted_today', status: prior.status };
  const state = { date: at.date, business_date: at.previous, status: 'running', started_at: now.toISOString() };
  fs.writeFileSync(file, JSON.stringify(state), {mode:0o600});
  try {
    const run = await request(path.join(root,'state/runtime/meituan-delivery/host.sock'), 'run', { date: at.previous }, {timeoutMs:15*60*1000});
    state.status = run.phase; state.batch_id = run.batch_id;
  } catch (error) { state.status = 'needs_attention'; state.reason = /^[a-z][a-z0-9_:.-]{0,150}$/.test(error.message) ? error.message : 'robot_request_failed'; }
  state.finished_at = new Date().toISOString(); fs.writeFileSync(file,JSON.stringify(state),{mode:0o600}); return state;
}
if (require.main === module) tick().then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('operating_schedule_failed');process.exitCode=1});
module.exports = { tick, local };
