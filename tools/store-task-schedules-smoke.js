'use strict';
const assert=require('assert/strict'),service=require('../lib/store-tasks');
(async()=>{
  const {db}=await require('./store-tasks-fixture')();
  const admin={id:1,position_permissions:['*']};
  const {id}=service.saveTemplate(db,service.seed,admin);
  const create=(frequency,from,store=1)=>service.dispatch(db,{template_id:id,store_ids:[store],from,frequency,due_time:'10:00',long_term:true},admin);
  create('daily','2025-01-01');
  assert.throws(()=>create('daily','2025-01-01'),/已有/);
  assert.equal(service.generateScheduled(db,'2025-01-31').created,31);
  assert.equal(service.generateScheduled(db,'2025-01-31').created,0);
  // Multiple ticks continue beyond the old 93-day limit and recover offline gaps.
  for(let i=0;i<12;i++)service.generateScheduled(db,'2025-12-31');
  assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM store_task_instances').n,365);
  const plan=service.schedules(db,admin)[0];
  assert.throws(()=>service.stopSchedule(db,plan.id,admin,2),/无权/);
  assert.throws(()=>service.stopSchedule(db,plan.id,{id:2,position_permissions:['store-tasks.execute']}),/权限/);
  service.stopSchedule(db,plan.id,admin);
  assert.equal(service.generateScheduled(db,'2026-01-01').created,0);
  assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM store_task_instances').n,365);
  // Frozen form version, month-end anchor, no drift after February.
  create('monthly','2026-01-31');
  const old=service.templates(db)[0];service.saveTemplate(db,{...old,title:'新版开早检查'},admin);
  for(let i=0;i<4;i++)service.generateScheduled(db,'2026-04-30');
  const months=db.queryAll("SELECT business_date,title,template_version FROM store_task_instances WHERE business_date>='2026-01-01' ORDER BY business_date");
  assert.deepEqual(months.map(r=>r.business_date),['2026-01-31','2026-02-28','2026-03-31','2026-04-30']);
  assert(months.every(r=>r.title==='开早检查'&&r.template_version===1));
  create('weekly','2026-05-01',2);service.generateScheduled(db,'2026-05-31');
  assert.deepEqual(db.queryAll('SELECT business_date FROM store_task_instances WHERE store_id=2 ORDER BY business_date').map(r=>r.business_date),['2026-05-01','2026-05-08','2026-05-15','2026-05-22','2026-05-29']);
  assert(service.schedules(db,admin,2).every(r=>r.store_id===2));
  assert.throws(()=>create('once','2026-06-01'),/单次/);
  // All selected stores roll back if any already has an active plan.
  service.stopSchedule(db,service.schedules(db,admin,1).find(r=>r.active).id,admin);
  assert.throws(()=>service.dispatch(db,{template_id:id,store_ids:[1,2],from:'2026-06-01',frequency:'daily',due_time:'10:00',long_term:true},admin),/已有/);
  assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM store_task_schedules WHERE active=1').n,1);
  console.log('PASS: year-long recurrence, bounded catch-up, idempotency, pause/history, store permissions, frozen versions, weekly and month-end anchors, atomic duplicate rejection');
})().catch(e=>{console.error(e);process.exitCode=1});
