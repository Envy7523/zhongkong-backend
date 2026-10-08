'use strict';
const assert=require('node:assert/strict'),service=require('../lib/store-tasks');
(async()=>{
 const {db,raw}=await require('./store-tasks-fixture')();
 const admin={id:1,username:'店长',position_permissions:['*']},a={id:2,username:'A',position_permissions:['store-tasks.execute']},b={...a,id:3,username:'B'};
 const schema=await import('../frontend/src/utils/store-task-form-schema.mjs');
 const qs=Array.from({length:10},(_,i)=>({id:'check-'+(i+1),title:'任务'+(i+1),type:'text',required:true,execution_mode:i===9?'shared':'single'}));
 try{
  assert.equal(schema.fromDesignerRules(qs.map(schema.toDesignerRule))[0].execution_mode,'single');
  assert.throws(()=>service.saveTemplate(db,{title:'错误执行方式',questions:[{...qs[0],execution_mode:'anything'}]},admin));
  const template=service.saveTemplate(db,{title:'全店共享进度验收',questions:qs},admin).id;
  service.dispatch(db,{template_id:template,store_ids:[1],from:'2026-10-08',to:'2026-10-09',frequency:'daily',due_time:'10:00'},admin,null);
  const task=service.list(db,{from:'2026-10-08',to:'2026-10-09'},1).find(r=>r.business_date==='2026-10-08').id;
  const detail=()=>service.detail(db,task,1),write=(user,n,value='完成',revision=detail().revision)=>service.writeAnswer(db,task,{question_id:'check-'+n,value,revision},user,1);
  assert.equal(detail().completed,0);write(admin,1);assert.equal(detail().completed,1);const stale=detail().revision;write(a,4);write(b,6);write(b,7);write(b,8);assert.equal(detail().completed,5);assert.equal(detail().total-detail().completed,5);
  assert.equal(detail().results[0].owner.name,'店长');assert.equal(detail().results[3].completed_by[0].name,'A');
  const summary=service.list(db,{from:'2026-10-08',to:'2026-10-08'},1)[0];assert.equal(summary.completed,5);assert.equal(summary.in_progress,5);assert.equal(summary.total,10);
  assert.throws(()=>write(b,4),e=>e.status===409);assert.throws(()=>write(a,2,'完成',stale),e=>e.status===409);assert.equal(detail().completed,5);
  write(a,10,'补充A');write(b,10,'补充B');assert.equal(detail().completed,6);assert.equal(detail().results[9].contributions.length,2);
  // Clearing one's single-person result releases it, without deleting the history.
  write(a,4,'');assert.equal(detail().completed,5);write(b,4);assert.equal(detail().results[3].owner.name,'B');assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM store_task_answers WHERE task_id=? AND question_id=?',[task,'check-4']).n,3);
  const tomorrow=service.list(db,{from:'2026-10-09',to:'2026-10-09'},1)[0].id;service.writeAnswer(db,tomorrow,{question_id:'check-1',value:'完成',revision:0},b,1);assert.equal(service.detail(db,tomorrow,1).results[0].owner.name,'B');
  service.saveTemplate(db,{id:template,version:1,title:'全店共享进度验收',questions:qs.map(q=>({...q,execution_mode:'shared'}))},admin);assert.equal(detail().results[0].execution_mode,'single');
  for(const n of [2,3,5,9])write(a,n);service.submit(db,task,{revision:detail().revision},admin,1);assert.equal(detail().submissions[0].snapshot[0].execution_mode,'single');assert.equal(detail().completed,10);
  service.review(db,task,{status:'rejected',version:1,note:'补充任务1说明'},admin,1);assert.throws(()=>write(b,1),e=>e.status===409);write(admin,1,'重新检查完成');assert.equal(detail().submissions[0].snapshot[0].contributions[0].response.value,'完成');
  console.log('PASS: store shared 10→9→5 remaining; single-person ownership and duplicate/stale rejection; multi-person contributions; release with history; next-day free executor; frozen template/submission rules; rejected edits limited to owner');
 }finally{raw.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
