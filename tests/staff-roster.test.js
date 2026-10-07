const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{createRequire}=require('node:module');
const roster=require('../lib/staff-roster');
const source=fs.readFileSync(require.resolve('./payroll-workflow.test.js'),'utf8');
const prefix=source.slice(0,source.indexOf("test('旧月份")).replace('before(async()=> { SQL=await initSqlJs(); });','').replace('const server=app.listen',`db.run('CREATE TABLE dingtalk_attendance_records (id INTEGER, employee_id INTEGER,work_date TEXT,check_time TEXT,check_type TEXT,time_result TEXT)');require('../lib/staff-roster').initialize(db,'2026-10-07');require('../lib/staff-roster').mount({app,db,today:()=> rosterToday,...helpers});const server=app.listen`);
const setup=new Function('require','rosterToday',prefix+';return async()=>{SQL=await initSqlJs();return fixture(()=> "2026-10");};')(createRequire(__filename),'2026-10-07');
async function check(fn){const f=await setup();try{await f.api('/api/payroll-month-settings/2026-10','PUT',{staff_group:'store',scheduled_days:25,version:0},2);await fn(f)}finally{await f.close()}}
const read=async(api,user=1,week='2026-10-12',scope='store:1')=>(await api(`/api/staff-roster/week?scope=${scope}&week_start=${week}`,'GET',undefined,user)).data.week;
const payload=week=>({scope:week.scope,week_start:week.week_start,version:week.version,employees:structuredClone(week.employees),publish:false});
test('店长只见本店员工；支援员工不进入排班名单，库存跨店访问拒绝',()=>check(async({api,db})=>{
 db.run("INSERT INTO employee_store_dispatches VALUES(1,'有效',2,2,1,'B店','selected','[\"2026-10-12\"]','','')");
 const week=await read(api);assert.deepEqual(week.employees.map(p=>p.employee_id),[1]);
 assert.equal((await api('/api/staff-roster/week?scope=store:2&week_start=2026-10-12')).status,403);
 assert.equal((await api('/api/staff-roster/employees/2/balance')).status,404);
 assert.equal((await api('/api/staff-roster/employees/1/balance')).status,200);
 const body=payload(week);body.employees[0].employee_id=2;assert.equal((await api('/api/staff-roster/week','PUT',body)).status,403);
 assert.equal(db.queryOne('SELECT COUNT(*) n FROM staff_roster_weeks').n,0);
}));
test('审核人与普通制表员无排班权限；人事可看办公室及各门店',()=>check(async({api})=>{
 for(const user of [3,7])assert.equal((await api('/api/staff-roster/context','GET',undefined,user)).status,403);
 const ctx=(await api('/api/staff-roster/context','GET',undefined,2)).data;assert.equal(ctx.scopes.length,3);assert.equal(ctx.can_confirm,true);
 const office=await read(api,2,'2026-10-12','office');assert.deepEqual(office.employees.map(p=>p.employee_id),[3]);
}));
test('提交正式员工周排班后固定；人事未来修改须有原因，版本冲突拒绝',()=>check(async({api,db})=>{
 let week=await read(api),body=payload(week);body.employees[0].days[0].type='rest';body.publish=true;
 let result=await api('/api/staff-roster/week','PUT',body);assert.equal(result.status,200);week=result.data.week;assert.equal(week.status,'published');assert.equal(week.employees[0].days[0].can_edit,false);
 body=payload(week);body.employees[0].days[0].type='work';assert.equal((await api('/api/staff-roster/week','PUT',body)).status,403);
 assert.equal((await api('/api/staff-roster/week','PUT',body,2)).status,400);body.reason='门店活动调班';result=await api('/api/staff-roster/week','PUT',body,2);assert.equal(result.status,200);
 assert.equal((await api('/api/staff-roster/week','PUT',body,2)).status,409);assert.equal(db.queryOne('SELECT COUNT(*) n FROM staff_roster_audit').n,2);
}));
test('兼职沿用默认班次无需填写时间，提交后仍可调整未来安排',()=>check(async({api,db})=>{
 db.run("UPDATE employees SET hire_type='兼职' WHERE id=1");let week=await read(api),body=payload(week);body.publish=true;
 for(const day of body.employees[0].days)day.type='work';
 week=(await api('/api/staff-roster/week','PUT',body)).data.week;assert.equal(week.employees[0].days[0].can_edit,true);
 body=payload(week);body.employees[0].days[0].start_time='10:00';body.employees[0].days[0].end_time='08:00';assert.equal((await api('/api/staff-roster/week','PUT',body)).status,400);body.employees[0].days[0].next_day=true;assert.equal((await api('/api/staff-roster/week','PUT',body)).status,200);
}));
test('历史周与已过去日期不可改，异常修订走人事独立接口',()=>check(async({api})=>{
 const old=await read(api,1,'2026-09-21');assert.equal(old.can_submit,false);assert.equal((await api('/api/staff-roster/week','PUT',payload(old))).status,403);
 const week=await read(api,1,'2026-10-05'),body=payload(week);body.employees[0].days[0].type='rest';const filled=await api('/api/staff-roster/week','PUT',body);assert.equal(filled.status,200);const changed=payload(filled.data.week);changed.employees[0].days[0].type='work';assert.equal((await api('/api/staff-roster/week','PUT',changed)).status,403);
 assert.equal((await api('/api/staff-roster/week?week_start=2026-10-06')).status,400);
}));
test('请假必填原因，店长只能申请，人事才可批准、认定旷工及修订工时',()=>check(async({api,db})=>{
 const week=await read(api),body=payload(week);body.employees[0].days[0].type='leave';assert.equal((await api('/api/staff-roster/week','PUT',body)).status,400);
 const path='/api/staff-roster/employees/1/exceptions/2026-10-06';
 assert.equal((await api(path,'PUT',{version:0,decision:'leave',reason:'事假'})).status,403);
 assert.equal((await api(path,'PUT',{version:0,decision:'pending',reason:'事假',hours:7})).status,403);
 assert.equal((await api(path,'PUT',{version:0,decision:'pending',reason:'事假'})).status,200);
 assert.equal((await api(path,'PUT',{version:1,decision:'leave',reason:'已核实请假',hours:7},2)).status,200);
 assert.equal((await api(path,'PUT',{version:1,decision:'absent',reason:'未到岗'},2)).status,409);
 assert.equal((await api(path,'PUT',{version:2,decision:'pending',reason:'覆盖批准'})).status,403);
 assert.equal(db.queryOne('SELECT decision FROM staff_roster_exceptions').decision,'leave');
 assert.equal((await api('/api/staff-roster/employees/2/exceptions/2026-10-06','PUT',{version:0,reason:'事假'})).status,404);
}));
test('库存重复查询幂等；批量核算单次保存，无变化不写库',()=>check(async({api,db})=>{
 await api('/api/staff-roster/employees/1/balance');const first=db.queryOne('SELECT version FROM staff_leave_accounts WHERE employee_id=1').version;
 await api('/api/staff-roster/employees/1/balance');assert.equal(db.queryOne('SELECT version FROM staff_leave_accounts WHERE employee_id=1').version,first);
 let saves=0;db.save=()=>saves++;const engine=roster.service(db,()=> '2026-10-07');assert.equal(engine.runAll(),2);assert.equal(saves,1);assert.equal(engine.runAll(),0);assert.equal(saves,1);
}));
test('调岗后库存随员工，旧店不可查看，已发布原周数据不被抹去',()=>check(async({api,db})=>{
 const week=await read(api),body=payload(week);body.publish=true;assert.equal((await api('/api/staff-roster/week','PUT',body)).status,200);
 db.run("UPDATE employees SET store_id=2,store_name='B店' WHERE id=1");assert.equal((await api('/api/staff-roster/employees/1/balance')).status,404);assert.equal((await api('/api/staff-roster/employees/1/balance','GET',undefined,4)).status,200);
 const next=await read(api);assert.equal(next.employees.length,0);assert.equal((await api('/api/staff-roster/week','PUT',payload(next))).status,200);
 assert.equal(JSON.parse(db.queryOne('SELECT rows_json FROM staff_roster_weeks').rows_json).length,1);
}));

test('已核实完整月份可预览带入草稿，存假不重复付加班工资；来源变化拒绝',async()=>{
 const setupMonth=new Function('require','rosterToday',prefix+';return async()=>{SQL=await initSqlJs();return fixture(()=> "2026-10");};')(createRequire(__filename),'2026-11-01');
 const f=await setupMonth();try{
  f.db.run("UPDATE staff_roster_meta SET value='2026-10-01' WHERE key='active_from'");
  await f.api('/api/payroll-month-settings/2026-10','PUT',{staff_group:'store',scheduled_days:25,version:0},2);
  const days=Array.from({length:31},(_,i)=>({date:`2026-10-${String(i+1).padStart(2,'0')}`,type:i<26?'work':'rest',reason:'',start_time:'',end_time:'',next_day:false}));
  for(let i=0;i<26;i++){const date=days[i].date;f.db.run("INSERT INTO dingtalk_attendance_records VALUES(?,?,?,?,'OnDuty','Normal'),(?,?,?,?,'OffDuty','Normal')",[i*2,1,date,date+' 08:00:00',i*2+1,1,date,date+' 16:00:00'])}
  f.db.run("INSERT INTO staff_roster_weeks(scope,week_start,status,rows_json) VALUES('store:1','2026-09-28','published',?)",[JSON.stringify([{employee_id:1,days}])]);
  let sheet=(await f.api('/api/payroll-sheets/prepare','POST',{store_name:'A店',period:'2026-10'})).data.sheet;
  let preview=(await f.api(`/api/staff-roster/payroll/${sheet.id}/preview`)).data;assert.equal(preview.rows[0].eligible,true);assert.equal(preview.rows[0].banked,1);assert.equal(preview.rows[0].paid_days,25);
  assert.equal((await f.api(`/api/staff-roster/payroll/${sheet.id}/apply`,'POST',{version:sheet.version,source_token:'stale'})).status,409);
  assert.equal((await f.api(`/api/staff-roster/payroll/${sheet.id}/apply`,'POST',{version:sheet.version,source_token:preview.source_token})).status,200);
  sheet=(await f.api(`/api/payroll-sheets/${sheet.id}`)).data.sheet;assert.equal(sheet.items[0].actual_days,25);assert.equal(sheet.items[0].gross_salary,6500);assert.equal(sheet.items[0].weekday_overtime_pay,0);
  await f.api(`/api/payroll-sheets/${sheet.id}/submit`,'POST',{version:sheet.version});assert.equal((await f.api(`/api/staff-roster/payroll/${sheet.id}/preview`)).status,403);
 }finally{await f.close()}
});

test('未安排默认为待排班；请假必填，休息不需备注，余额不足不许调休',()=>check(async({api})=>{
 const week=await read(api);assert.ok(week.employees[0].days.every(day=>day.type==='unassigned'));
 let body=payload(week);body.employees[0].days[0].type='leave';assert.equal((await api('/api/staff-roster/week','PUT',body)).status,400);
 body.employees[0].days[0].reason='就医';let result=await api('/api/staff-roster/week','PUT',body);assert.equal(result.status,200);
 body=payload(result.data.week);body.employees[0].days[1].type='rest';assert.equal((await api('/api/staff-roster/week','PUT',body)).status,200);
 body=payload(await read(api));body.employees[0].days[2].type='comp';result=await api('/api/staff-roster/week','PUT',body);assert.equal(result.status,400);assert.match(result.data.error,/余额不足/);
}));
test('已赚取存假可调休，但跨周预留及到期日均不得重复使用',()=>check(async({api,db})=>{
 await api('/api/payroll-month-settings/2026-10','PUT',{staff_group:'store',scheduled_days:0,version:1},2);
 const date='2026-10-06';db.run("UPDATE staff_roster_meta SET value='2026-10-01'");
 db.run("INSERT INTO dingtalk_attendance_records VALUES(1,1,?,?,'OnDuty','Normal'),(2,1,?,?,'OffDuty','Normal')",[date,date+' 08:00:00',date,date+' 16:00:00']);
 let body=payload(await read(api));body.employees[0].days[0].type='comp';body.publish=true;assert.equal((await api('/api/staff-roster/week','PUT',body)).status,200);
 body=payload(await read(api,1,'2026-10-19'));body.employees[0].days[0].type='comp';assert.equal((await api('/api/staff-roster/week','PUT',body)).status,400);
 body=payload(await read(api,1,'2027-01-04'));body.employees[0].days[0].type='comp';assert.equal((await api('/api/staff-roster/week','PUT',body)).status,400);
}));

test('本月空白日期允许店长补排，已有过去安排只能人事修改，历史月份均只读',()=>check(async({api,db})=>{
 let week=await read(api,1,'2026-10-05');assert.equal(week.employees[0].days[0].can_edit,true);
 let body=payload(week);body.employees[0].days[0].type='work';let saved=await api('/api/staff-roster/week','PUT',body);assert.equal(saved.status,200);assert.equal(saved.data.week.employees[0].days[0].can_edit,false);assert.match(saved.data.week.employees[0].days[0].readonly_reason,/联系人事/);
 week=await read(api,2,'2026-10-05');assert.equal(week.employees[0].days[0].can_edit,true);body=payload(week);body.employees[0].days[0].type='leave';body.employees[0].days[0].reason='补登记事假';assert.equal((await api('/api/staff-roster/week','PUT',body,2)).status,200);
 week=await read(api,2,'2026-09-21');assert.equal(week.can_submit,false);assert.equal(week.employees[0].days[0].can_edit,false);assert.match(week.employees[0].days[0].readonly_reason,/历史月份/);assert.equal((await api('/api/staff-roster/week','PUT',payload(week),2)).status,403);
 assert.equal(db.queryOne('SELECT COUNT(*) n FROM staff_roster_audit').n,2);
}));
test('补排已过去调休仍检查当日库存，不用未来或启用前的虚构余额',()=>check(async({api})=>{
 const week=await read(api,2,'2026-10-05'),body=payload(week);body.employees[0].days[0].type='comp';const result=await api('/api/staff-roster/week','PUT',body,2);assert.equal(result.status,400);assert.match(result.data.error,/不能补排调休/);
}));
