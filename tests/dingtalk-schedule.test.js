const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{createRequire}=require('node:module');
const ding=require('../lib/dingtalk-schedule');
const source=fs.readFileSync(require.resolve('./payroll-workflow.test.js'),'utf8');
const prefix=source.slice(0,source.indexOf("test('旧月份")).replace('before(async()=> { SQL=await initSqlJs(); });','').replace('const server=app.listen',`db.run("ALTER TABLE employees ADD COLUMN dingtalk_user_id TEXT DEFAULT ''");db.run("UPDATE employees SET dingtalk_user_id='u'||id");db.run('CREATE TABLE dingtalk_attendance_records(id INTEGER,employee_id INTEGER,work_date TEXT,check_time TEXT,check_type TEXT,time_result TEXT)');require('../lib/dingtalk-schedule').initialize(db);const schedule=require('../lib/dingtalk-schedule').service(db,{fetchSchedules:probe});require('../lib/staff-roster').initialize(db,'2026-10-01');require('../lib/staff-roster').mount({app,db,today:()=> '2026-11-01',dingSchedule:schedule,...helpers});const server=app.listen`);
async function fixture(probe){return new Function('require','probe',prefix+';return async()=>{SQL=await initSqlJs();return fixture(()=> "2026-10");};')(createRequire(__filename),probe)()}
const rows=(user,date,rest=false)=>rest?[{userid:user,work_date:date+' 00:00:00',is_rest:'Y'}]:['OnDuty','OffDuty'].map((type,i)=>({userid:user,work_date:date+' 00:00:00',is_rest:'N',check_type:type,plan_check_time:date+(i?' 16:00:00':' 08:00:00')}));
test('normalize distinguishes rest, split shifts, mixed nodes, approvals and missing plans',()=>{
 const date='2026-10-06',work=ding.normalize(rows('u1',date),date);assert.equal(work.type,'work');assert.equal(work.pending,false);assert.equal(work.segments[0].hours,8);
 assert.equal(ding.normalize(rows('u1',date,true),date).type,'rest');assert.equal(ding.normalize([],date).pending,true);
 assert.equal(ding.normalize([...rows('u1',date),...rows('u1',date,true)],date).pending,true);
 assert.equal(ding.normalize(rows('u1',date).map(r=>({...r,approve_id:10})),date).pending,true);
 const multi=[...rows('u1',date),...rows('u1',date).map(r=>({...r,plan_check_time:r.plan_check_time.replace('08:00','18:00').replace('16:00','21:00')}))];assert.equal(ding.normalize(multi,date).segments.length,2);
});
test('read-only API blocks manual schedules and cross-store sync, returns DingTalk planned and actual times',async()=>{
 const f=await fixture(async({userIds,dateFrom})=>userIds.flatMap(u=>rows(u,dateFrom)));try{
  assert.equal((await f.api('/api/staff-roster/sync','POST',{scope:'store:2',week_start:'2026-10-05'})).status,403);
  assert.equal((await f.api('/api/staff-roster/sync','POST',{scope:'store:1',week_start:'2026-10-05'})).status,200);
  const w=(await f.api('/api/staff-roster/week?scope=store:1&week_start=2026-10-05')).data.week;
  assert.equal(w.source,'dingtalk');assert.equal(w.can_submit,false);assert.equal(w.employees.length,1);assert.equal(w.employees[0].days[0].type,'work');assert.equal(w.employees[0].days[0].can_edit,false);assert.equal(w.employees[0].days[0].attendance.hours,null);
  assert.equal((await f.api('/api/staff-roster/week','PUT',{})).status,403);
  assert.equal((await f.api('/api/staff-roster/employees/1/exceptions/2026-10-05','PUT',{},2)).status,403);
  assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM staff_roster_weeks').n,0);
 }finally{await f.close()}
});
test('sync replaces removed shifts with unknown, repeat sync stays unique, failed batches preserve prior data',async()=>{
 let mode='work',calls=0;
 const f=await fixture(async({userIds,dateFrom})=>{calls++;if(mode==='fail'&&calls===2)throw Error('network');return mode==='empty'?[]:userIds.flatMap(u=>rows(u,dateFrom))});try{
  const body={scope:'store:1',week_start:'2026-10-05'};
  for(let i=0;i<2;i++)assert.equal((await f.api('/api/staff-roster/sync','POST',body)).status,200);
  assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM dingtalk_schedule_days').n,7);
  const before=f.db.queryAll('SELECT * FROM dingtalk_schedule_days');mode='fail';calls=0;assert.equal((await f.api('/api/staff-roster/sync','POST',body)).status,400);assert.deepEqual(f.db.queryAll('SELECT * FROM dingtalk_schedule_days'),before);
  mode='empty';await f.api('/api/staff-roster/sync','POST',body);assert.equal(JSON.parse(f.db.queryOne('SELECT plan_json FROM dingtalk_schedule_days').plan_json).type,'unassigned');
 }finally{await f.close()}
});
test('confirmed DingTalk month previews and applies salary, repeat payroll source validation prevents stale writes',async()=>{
 const f=await fixture(async()=>[]);try{
  await f.api('/api/payroll-month-settings/2026-10','PUT',{staff_group:'store',scheduled_days:25,version:0},2);
  for(let i=1;i<=31;i++){const date='2026-10-'+String(i).padStart(2,'0');f.db.run('INSERT INTO dingtalk_schedule_days VALUES(?,?,?,?,?)',[1,date,'u1',JSON.stringify(ding.normalize(rows('u1',date,i>26),date)),'stamp']);if(i<=26)f.db.run("INSERT INTO dingtalk_attendance_records VALUES(?,1,?,?,'OnDuty','Normal'),(?,1,?,?,'OffDuty','Normal')",[i*2,date,date+' 08:00:00',i*2+1,date,date+' 16:00:00'])}
  let sheet=(await f.api('/api/payroll-sheets/prepare','POST',{store_name:'A店',period:'2026-10'})).data.sheet;
  let preview=(await f.api(`/api/staff-roster/payroll/${sheet.id}/preview`)).data;assert.equal(preview.rows[0].eligible,true);assert.equal(preview.rows[0].paid_days,25);assert.equal(preview.rows[0].banked,1);
  f.db.run("UPDATE dingtalk_schedule_days SET synced_at='changed' WHERE work_date='2026-10-01'");assert.equal((await f.api(`/api/staff-roster/payroll/${sheet.id}/apply`,'POST',{version:sheet.version,source_token:preview.source_token})).status,409);
  preview=(await f.api(`/api/staff-roster/payroll/${sheet.id}/preview`)).data;assert.equal((await f.api(`/api/staff-roster/payroll/${sheet.id}/apply`,'POST',{version:sheet.version,source_token:preview.source_token})).status,200);
  sheet=(await f.api(`/api/payroll-sheets/${sheet.id}`)).data.sheet;assert.equal(sheet.items[0].gross_salary,6500);assert.equal(sheet.items[0].actual_days,25);
  f.db.run("DELETE FROM dingtalk_schedule_days WHERE work_date='2026-10-01'");preview=(await f.api(`/api/staff-roster/payroll/${sheet.id}/preview`)).data;assert.equal(preview.rows[0].eligible,false);
 }finally{await f.close()}
});
test('part-time payroll uses paired actual hours and blocks unconfirmed approval schedules',async()=>{
 const f=await fixture(async()=>[]);try{
  f.db.run("UPDATE employees SET hire_type='兼职',salary=20 WHERE id=1");
  await f.api('/api/payroll-month-settings/2026-10','PUT',{staff_group:'store',scheduled_days:25,version:0},2);
  for(let i=1;i<=31;i++){const date='2026-10-'+String(i).padStart(2,'0');f.db.run('INSERT INTO dingtalk_schedule_days VALUES(?,?,?,?,?)',[1,date,'u1',JSON.stringify(ding.normalize(rows('u1',date,i>2),date)),'stamp']);if(i<=2)f.db.run("INSERT INTO dingtalk_attendance_records VALUES(?,1,?,?,'OnDuty','Normal'),(?,1,?,?,'OffDuty','Normal')",[i*2,date,date+' 10:00:00',i*2+1,date,date+' 16:00:00'])}
  let sheet=(await f.api('/api/payroll-sheets/prepare','POST',{store_name:'A店',period:'2026-10'})).data.sheet;
  const path=`/api/staff-roster/payroll/${sheet.id}`;let p=(await f.api(path+'/preview')).data;assert.equal(p.rows[0].eligible,true);assert.equal(p.rows[0].part_time_hours,12);
  assert.equal((await f.api(path+'/apply','POST',{version:sheet.version,source_token:p.source_token})).status,200);
  sheet=(await f.api(`/api/payroll-sheets/${sheet.id}`)).data.sheet;assert.equal(sheet.items[0].part_time_hours,12);assert.equal(sheet.items[0].part_time_salary,240);
  f.db.run('UPDATE dingtalk_schedule_days SET plan_json=? WHERE work_date=?',[JSON.stringify(ding.normalize(rows('u1','2026-10-01').map(r=>({...r,approve_id:1})),'2026-10-01')),'2026-10-01']);
  p=(await f.api(path+'/preview')).data;assert.equal(p.rows[0].eligible,false);
 }finally{await f.close()}
});

