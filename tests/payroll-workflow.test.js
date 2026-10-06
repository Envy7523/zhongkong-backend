const {test,before,after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const express = require('express');
const initSqlJs = require('sql.js');
const XLSX = require('xlsx');
const workflow = require('../lib/payroll-workflow');
const storeStaff = require('../lib/store-staff');
const {isGroupAffiliation} = require('../lib/staff-affiliation');
let SQL;
before(async()=> { SQL=await initSqlJs(); });
async function fixture(monthNow=()=> '2026-09') {
  const raw=new SQL.Database();
  const db={run:(sql,params=[])=>{raw.run(sql,params);return raw.getRowsModified();},queryAll:(sql,params=[])=>{const stmt=raw.prepare(sql);stmt.bind(params);const rows=[];while(stmt.step())rows.push(stmt.getAsObject());stmt.free();return rows;},save:()=>{}};
  db.queryOne=(sql,params)=>db.queryAll(sql,params)[0] || null;
  db.insert=(sql,params)=>{db.run(sql,params);return db.queryOne('SELECT last_insert_rowid() id').id;};
  raw.exec(`CREATE TABLE stores(id INTEGER PRIMARY KEY,store_name TEXT,status TEXT);INSERT INTO stores VALUES(1,'A店','营业中'),(2,'B店','营业中');
    CREATE TABLE position_settings(id INTEGER PRIMARY KEY,permissions_json TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,store_id INTEGER,position_id INTEGER);
    INSERT INTO users VALUES(1,'manager-a','A店长',1,1),(2,'hr','人事',NULL,2),(3,'reviewer','审核人',NULL,3),(4,'manager-b','B店长',2,1),(5,'unbound','未绑定',NULL,1),(6,'admin','管理员',NULL,4),(7,'preparer','制表人',NULL,5);
    CREATE TABLE employees(id INTEGER PRIMARY KEY,store_id INTEGER,store_name TEXT,status TEXT DEFAULT '在职',salary REAL DEFAULT 0,leave_date TEXT,updated_at TEXT DEFAULT '');
    CREATE TABLE employee_salary_profiles(employee_id INTEGER,base_salary REAL,position_allowance REAL,performance_salary REAL,attendance_bonus REAL,housing_allowance REAL,weekday_overtime_rate REAL,restday_overtime_rate REAL,part_time_hourly_rate REAL);
    CREATE TABLE employee_store_dispatches(id INTEGER, status TEXT,employee_id INTEGER,origin_store_id INTEGER,support_store_id INTEGER,origin_store_name TEXT,dispatch_mode TEXT,dispatch_dates_json TEXT,start_date TEXT,end_date TEXT);
    CREATE TABLE employee_lifecycle_events(id INTEGER PRIMARY KEY,employee_id INTEGER,event_type TEXT,event_date TEXT,note TEXT,source TEXT,details_json TEXT);
    CREATE TABLE payroll_sheets(id INTEGER PRIMARY KEY,store_name TEXT NOT NULL,period TEXT,scheduled_days REAL DEFAULT 26,status TEXT DEFAULT '草稿',created_at TEXT,updated_at TEXT,UNIQUE(store_name,period));
    CREATE TABLE payroll_sheet_items(id INTEGER PRIMARY KEY,sheet_id INTEGER,employee_id INTEGER,sort_order INTEGER,data TEXT,updated_at TEXT,UNIQUE(sheet_id,employee_id));
    CREATE TABLE payroll_month_settings(period TEXT PRIMARY KEY,scheduled_days REAL,updated_by TEXT,updated_at TEXT);
    INSERT INTO payroll_month_settings VALUES('2026-09',25,'旧设置','2026-10-06');`);
  for (const field of storeStaff.FIELDS) db.run(`ALTER TABLE employees ADD COLUMN ${field} TEXT DEFAULT ''`);
  for (const [id,permissions] of [[1,['staff.store.edit','payroll.view','payroll.prepare']],[2,['staff.view','payroll.view','payroll.prepare','payroll.attendance']],[3,['payroll.view','payroll.review']],[4,['*']],[5,['payroll.prepare']]]) db.insert('INSERT INTO position_settings VALUES(?,?)',[id,JSON.stringify(permissions)]);
  db.run("INSERT INTO employees(id,store_id,store_name,name,salary,hire_type) VALUES(1,1,'A店','A员工',6500,'全职'),(2,2,'B店','B员工',6000,'全职'),(3,NULL,'永文总公司','集团员工',8000,'全职')");
  const source=fs.readFileSync(require.resolve('../server.js'),'utf8');
  const dispatchSource=source.slice(source.indexOf('function localDateString'),source.indexOf('function lifecycleDate'))+source.slice(source.indexOf('function normalizeAttendanceDate'),source.indexOf('function splitIntoChunks'))+source.slice(source.indexOf('function dispatchDates'),source.indexOf('// 跨店支援不变更'));
  const dispatchPresentation=new Function(dispatchSource+';return dispatchPresentation;')();
  const helpers=new Function('db','XLSX','isGroupAffiliation','dispatchPresentation',source.slice(source.indexOf('const PAYROLL_EDITABLE_NUMBERS'),source.indexOf('payrollWorkflow.mount({'))+';return {readPayrollSheet,payrollTemplateRows,formatPayrollRow,payrollWorkbook};')(db,XLSX,isGroupAffiliation,dispatchPresentation);
  workflow.initialize(db);
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={id:Number(req.headers['x-fixture-user'] || ({'Bearer qa-hr':2,'Bearer qa-reviewer':3}[req.headers.authorization]) || 1)};next();});app.use(workflow.scopeGuard(db));
  workflow.mount({app,db,XLSX,monthNow,...helpers});storeStaff.mount({app,db,validateStaffFields:()=>null});
  app.get('/api/staff',(req,res)=>res.json({secret:'all staff'}));app.get('/api/db/stores',(req,res)=>res.json({secret:'all stores'}));app.get('/api/auth/me',(req,res)=>res.json({ok:true}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const api=async(path,method='GET',body,user=1)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'x-fixture-user':String(user),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:response.headers.get('content-type')?.includes('json')?await response.json():Buffer.from(await response.arrayBuffer())};};
  return {db,api,helpers,server,close:()=>new Promise(resolve=>{server.close(()=>{raw.close();resolve();});server.closeAllConnections();})};
}
async function check(fn){const f=await fixture();try{await fn(f);}finally{await f.close();}}
const prepare=(api,name='A店',user=1,period='2026-09')=>api('/api/payroll-sheets/prepare','POST',{store_name:name,period},user);

test('旧月份基线保留到两组，迁移可重复执行',()=>check(async({db,api})=>{workflow.initialize(db);const {data}=await api('/api/payroll-month-settings/2026-09');assert.equal(data.settings.group.scheduled_days,25);assert.equal(data.settings.store.scheduled_days,25);assert.equal(db.queryOne('SELECT COUNT(*) n FROM payroll_attendance_settings').n,2);}));
test('集团和门店基线独立，修复旧明细26天与月度25天不一致',()=>check(async({api,db})=>{let {data}=await prepare(api);assert.equal(data.sheet.items[0].actual_days,25);let result=await api('/api/payroll-month-settings/2026-09','PUT',{staff_group:'group',scheduled_days:22,version:1},2);assert.equal(result.status,200);result=await prepare(api,'永文总公司',2);assert.equal(result.data.sheet.scheduled_days,22);assert.equal(result.data.sheet.items[0].actual_days,22);assert.equal((await api('/api/payroll-month-settings/2026-09')).data.settings.store.scheduled_days,25);assert.equal(db.queryOne('SELECT store_id FROM employees WHERE id=3').store_id,null);}));
test('发布只更新对应草稿且增加版本',()=>check(async({api})=>{const {data}=await prepare(api);const result=await api('/api/payroll-month-settings/2026-09','PUT',{staff_group:'store',scheduled_days:26,version:1},2);assert.equal(result.status,200);const sheet=(await api(`/api/payroll-sheets/${data.sheet.id}`)).data.sheet;assert.equal(sheet.items[0].actual_days,26);assert.ok(sheet.version>data.sheet.version);}));
test('店长无法修改月度基线',()=>check(async({api})=>assert.equal((await api('/api/payroll-month-settings/2026-09','PUT',{staff_group:'store',scheduled_days:20,version:1})).status,403)));
test('月份、数值和并发版本必须有效',()=>check(async({api})=>{for(const body of [{staff_group:'store',scheduled_days:'abc',version:1},{staff_group:'store',scheduled_days:0,version:1},{staff_group:'unknown',scheduled_days:25,version:1}])assert.equal((await api('/api/payroll-month-settings/2026-09','PUT',body,2)).status,400);assert.equal((await api('/api/payroll-month-settings/2026-13','GET',undefined,2)).status,400);assert.equal((await api('/api/payroll-month-settings/2026-09','PUT',{staff_group:'store',scheduled_days:23,version:0},2)).status,409);}));
test('未发布月份不能制作工资表',()=>check(async({api})=>assert.equal((await prepare(api,'A店',1,'2026-10')).status,400)));
test('店长创建、列表、明细及导出均隔离门店',()=>check(async({api})=>{const b=(await prepare(api,'B店',4)).data.sheet;assert.equal((await prepare(api,'B店')).status,403);assert.equal((await api('/api/payroll-sheets')).data.sheets.length,0);for(const suffix of ['', '/export?draft=1'])assert.equal((await api(`/api/payroll-sheets/${b.id}${suffix}`)).status,404);assert.equal((await api(`/api/payroll-sheets/${b.id}`,'PUT',{version:b.version,items:b.items})).status,404);}));
test('店长无法绕过权限访问旧接口或通用数据库',()=>check(async({api})=>{for(const path of ['/api/staff','/api/db/stores','/api/stores/2/employees','/api/employees/2','/api/staff/photos/secret.png','/api/config','/api/business-analytics/overview'])assert.equal((await api(path)).status,403);assert.equal((await api('/api/auth/me')).status,200);}));
test('未绑定门店或权限撤销即时失效',()=>check(async({api,db})=>{assert.equal((await api('/api/store-staff','GET',undefined,5)).status,403);db.run("UPDATE users SET store_id=2 WHERE id=1");assert.equal((await api('/api/store-staff')).data.employees[0].name,'B员工');db.run("UPDATE position_settings SET permissions_json='[]' WHERE id=1");assert.equal((await api('/api/payroll-sheets')).status,403);}));
test('基本工资只读、身份与计算基线不能由请求覆盖',()=>check(async({api})=>{const sheet=(await prepare(api)).data.sheet;let items=structuredClone(sheet.items);items[0].base_salary=1;assert.equal((await api(`/api/payroll-sheets/${sheet.id}`,'PUT',{version:sheet.version,items})).status,403);items=structuredClone(sheet.items);items[0].name='篡改';items[0].scheduled_days=31;items[0].personal_leave='2';let result=await api(`/api/payroll-sheets/${sheet.id}`,'PUT',{version:sheet.version,items});assert.equal(result.status,200);assert.equal(result.data.sheet.items[0].name,'A员工');assert.equal(result.data.sheet.items[0].actual_days,23);assert.equal(result.data.sheet.items[0].gross_salary,5980);}));
test('非法明细不得写入部分数据、不能替换员工、旧版本拒绝',()=>check(async({api,db})=>{const sheet=(await prepare(api)).data.sheet;const before=db.queryOne('SELECT data FROM payroll_sheet_items').data;for(const transform of [row=>row.employee_id=2,row=>row.personal_leave='bad',row=>row.personal_leave=-1,row=>row.personal_leave=null]){const items=structuredClone(sheet.items);transform(items[0]);const result=await api(`/api/payroll-sheets/${sheet.id}`,'PUT',{version:sheet.version,items});assert.ok(result.status>=400);assert.equal(db.queryOne('SELECT data FROM payroll_sheet_items').data,before);}assert.equal((await api(`/api/payroll-sheets/${sheet.id}`,'PUT',{version:0,items:sheet.items})).status,409);}));
test('完整提交审核、退回再提交、通过后锁定且审计可追溯',()=>check(async({api})=>{let sheet=(await prepare(api)).data.sheet;sheet=(await api(`/api/payroll-sheets/${sheet.id}/submit`,'POST',{version:sheet.version})).data.sheet;assert.equal(sheet.status,'待审核');assert.equal((await api(`/api/payroll-sheets/${sheet.id}`,'PUT',{version:sheet.version,items:sheet.items})).status,409);assert.equal((await api(`/api/payroll-sheets/${sheet.id}/review`,'POST',{action:'approve',version:sheet.version})).status,403);assert.equal((await api(`/api/payroll-sheets/${sheet.id}/review`,'POST',{action:'return',version:sheet.version},3)).status,400);sheet=(await api(`/api/payroll-sheets/${sheet.id}/review`,'POST',{action:'return',note:'检查出勤',version:sheet.version},3)).data.sheet;assert.equal(sheet.status,'退回');assert.equal((await api('/api/payroll-sheets/'+sheet.id)).data.sheet.can_edit,true);sheet=(await api(`/api/payroll-sheets/${sheet.id}/submit`,'POST',{version:sheet.version})).data.sheet;sheet=(await api(`/api/payroll-sheets/${sheet.id}/review`,'POST',{action:'approve',version:sheet.version},3)).data.sheet;assert.equal(sheet.status,'已审核');assert.equal(sheet.can_edit,false);assert.equal(sheet.events.at(-1).action,'审核通过');assert.equal((await api(`/api/payroll-sheets/${sheet.id}`,'PUT',{version:sheet.version,items:sheet.items},6)).status,409);assert.equal((await api(`/api/payroll-sheets/${sheet.id}/export`)).status,200);}));
test('审核权限高也不能审核本人提交',()=>check(async({api})=>{let sheet=(await prepare(api,'A店',6)).data.sheet;sheet=(await api(`/api/payroll-sheets/${sheet.id}/submit`,'POST',{version:sheet.version},6)).data.sheet;assert.equal((await api(`/api/payroll-sheets/${sheet.id}/review`,'POST',{action:'approve',version:sheet.version},6)).status,403);}));
test('提交后与已审核工资表不会受后续应出勤修改影响',()=>check(async({api})=>{let sheet=(await prepare(api)).data.sheet;sheet=(await api(`/api/payroll-sheets/${sheet.id}/submit`,'POST',{version:sheet.version})).data.sheet;await api('/api/payroll-month-settings/2026-09','PUT',{staff_group:'store',scheduled_days:22,version:1},2);assert.equal((await api(`/api/payroll-sheets/${sheet.id}`)).data.sheet.items[0].actual_days,25);sheet=(await api(`/api/payroll-sheets/${sheet.id}/review`,'POST',{action:'approve',version:sheet.version},3)).data.sheet;assert.equal(sheet.scheduled_days,25);assert.equal((await prepare(api)).data.sheet.items[0].actual_days,25);}));
test('草稿导出须显式预览并带未审核标题',()=>check(async({api})=>{const sheet=(await prepare(api)).data.sheet;assert.equal((await api(`/api/payroll-sheets/${sheet.id}/export`)).status,400);const result=await api(`/api/payroll-sheets/${sheet.id}/export?draft=1`);assert.equal(result.status,200);const book=XLSX.read(result.data,{type:'buffer'});assert.match(book.Sheets['工资表'].A1.v,/草稿 · 未审核/);}));
test('店长员工录入归属强制为本店，无法改薪酬与其他店员工',()=>check(async({api,db})=>{assert.equal((await api('/api/store-staff')).data.employees.length,1);assert.equal((await api('/api/store-staff/2','PUT',{name:'改名',hire_type:'全职'})).status,404);assert.equal((await api('/api/store-staff','POST',{name:'新人',hire_type:'全职',store_id:2})).status,400);const result=await api('/api/store-staff','POST',{name:'新人',hire_type:'全职',phone:''});assert.equal(result.status,200);assert.equal(result.data.employee.store_id,1);assert.equal(result.data.employee.salary,0);assert.equal(db.queryOne('SELECT COUNT(*) n FROM employee_lifecycle_events').n,1);assert.equal((await api(`/api/store-staff/${result.data.employee.id}`,'PUT',{name:'新人2',hire_type:'全职',salary:999,updated_at:result.data.employee.updated_at})).status,400);}));
test('支援员工与历史归属异常工资表不向店长泄漏',()=>check(async({db,api})=>{const sheet=(await prepare(api)).data.sheet;db.insert('INSERT INTO payroll_sheet_items(sheet_id,employee_id,sort_order,data) VALUES(?,?,?,?)',[sheet.id,2,1,JSON.stringify({name:'其他店',is_dispatch_support:true,scheduled_days:0,support_days:2})]);assert.equal((await api(`/api/payroll-sheets/${sheet.id}`)).status,403);assert.equal((await api(`/api/payroll-sheets/${sheet.id}/export?draft=1`)).status,403);assert.equal((await api(`/api/payroll-sheets/${sheet.id}`,'GET',undefined,2)).status,200);}));
test('账号岗位绑定要求有效门店，管理员可不绑定',()=>check(async({db})=>{assert.throws(()=>workflow.userStoreBinding(db,1,null),/必须绑定/);assert.throws(()=>workflow.userStoreBinding(db,1,999),/有效门店/);assert.equal(workflow.userStoreBinding(db,1,2),2);assert.equal(workflow.userStoreBinding(db,4,null),null);}));
test('月末入职员工纳入本月工资，不因UTC日期换算漏人',()=>check(async({db,api})=>{db.insert("INSERT INTO employees(store_id,store_name,name,hire_type,entry_date,salary) VALUES(1,'A店','月末新人','全职','2026-09-30',5000)");assert.equal((await prepare(api)).data.sheet.items.length,2);}));

const calendar=(period,work=22)=>Array.from({length:new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5)),0)).getUTCDate()},(_,index)=>({date:`${period}-${String(index+1).padStart(2,'0')}`,type:index<work?'work':index===work?'holiday':'rest',start_time:'09:00',end_time:'18:00',note:index===work?'放假':''}));
test('员工工资合并本店与支援份额，不重复相加标准工资且提示缺失门店',()=>check(async({api,db})=>{
  db.run("INSERT INTO employee_store_dispatches VALUES(1,'有效',1,1,2,'A店','selected','[\"2026-09-10\",\"2026-09-11\"]','','')");
  let a=(await prepare(api)).data.sheet;a=(await api(`/api/payroll-sheets/${a.id}/submit`,'POST',{version:a.version})).data.sheet;
  let result=(await api('/api/employee-payslips/2026-09','GET',undefined,2)).data;
  assert.equal(result.employees[0].totals.gross_salary,5980);assert.equal(result.employees[0].complete,false);assert.equal(result.employees[0].coverage.find(c=>c.store_name==='B店').status,'未生成员工明细');
  let b=(await prepare(api,'B店',2)).data.sheet;b=(await api(`/api/payroll-sheets/${b.id}/submit`,'POST',{version:b.version},2)).data.sheet;
  result=(await api('/api/employee-payslips/2026-09','GET',undefined,3)).data;
  let employee=result.employees.find(e=>e.employee_id===1);assert.equal(employee.contributions.length,2);assert.equal(employee.totals.gross_salary,6500);assert.equal(employee.totals.net_salary,6500);assert.equal(employee.totals.actual_days,25);assert.equal(employee.complete,true);assert.equal(employee.all_approved,false);assert.deepEqual(employee.contributions.find(c=>c.is_dispatch_support).dispatch_dates,['2026-09-10','2026-09-11']);assert.equal(employee.contributions[0].bank_card_number,undefined);
  assert.equal((await api('/api/employee-payslips/2026-09?view=approved','GET',undefined,3)).data.employees.length,0);
  for(const sheet of [a,b])assert.equal((await api(`/api/payroll-sheets/${sheet.id}/review`,'POST',{action:'approve',version:sheet.version},3)).status,200);
  employee=(await api('/api/employee-payslips/2026-09?view=approved','GET',undefined,3)).data.employees.find(e=>e.employee_id===1);assert.equal(employee.all_approved,true);
}));
test('员工跨店工资查询拒绝店长、审核人不能看未提交，按员工编号区分同名',()=>check(async({api,db})=>{
  db.run("UPDATE employees SET name='同名' WHERE id IN (1,2)");await prepare(api);await prepare(api,'B店',4);
  for(const user of [1,4,5])assert.equal((await api('/api/employee-payslips/2026-09?view=all','GET',undefined,user)).status,403);
  assert.equal((await api('/api/employee-payslips/2026-09?view=all','GET',undefined,3)).status,403);
  assert.equal((await api('/api/employee-payslips/2026-09','GET',undefined,3)).data.employees.length,0);
  const result=(await api('/api/employee-payslips/2026-09?view=all','GET',undefined,2)).data;assert.deepEqual(result.employees.map(e=>e.employee_id).sort(),[1,2]);assert.equal(result.employees.every(e=>!e.all_approved),true);
  assert.equal((await api('/api/employee-payslips/2026-13','GET',undefined,2)).status,400);assert.equal((await api('/api/employee-payslips/2026-09?view=bad','GET',undefined,2)).status,400);
}));
test('审批进度包含未制作及已保存门店，待审队列只收实际提交记录',()=>check(async({api,db})=>{
  let a=(await prepare(api)).data.sheet;
  const b=(await prepare(api,'B店',4)).data.sheet;
  await api(`/api/payroll-sheets/${b.id}`,'PUT',{version:b.version,items:b.items},4);
  a=(await api(`/api/payroll-sheets/${a.id}/submit`,'POST',{version:a.version})).data.sheet;
  const report=(await api('/api/payroll-review/2026-09','GET',undefined,3)).data;
  assert.equal(report.summary.required,3);assert.equal(report.summary.submitted,1);assert.equal(report.summary.unsubmitted,2);
  assert.deepEqual(report.pending.map(s=>s.id),[a.id]);assert.equal(report.approved.length,0);
  const missing=report.coverage.find(r=>r.store_name==='B店');assert.equal(missing.status,'未提交');assert.equal(missing.preparation_status,'已保存');assert.equal(missing.sheet_id,null);assert.equal(missing.submitted_at,null);
  assert.equal(report.coverage.find(r=>r.store_name==='永文总公司').preparation_status,'未制作');
  assert.deepEqual((await api('/api/payroll-sheets?view=work','GET',undefined,6)).data.sheets.map(s=>s.id),[b.id]);
  db.run("UPDATE payroll_sheets SET status='待审核' WHERE id=?",[b.id]);
  assert.deepEqual((await api('/api/payroll-review/2026-09','GET',undefined,3)).data.pending.map(s=>s.id),[a.id]);
}));
test('审核人不能打开草稿或预览导出，管理员审批入口也不接收草稿',()=>check(async({api})=>{
  const sheet=(await prepare(api)).data.sheet;
  assert.equal((await api('/api/payroll-sheets','GET',undefined,3)).data.sheets.length,0);
  for(const suffix of ['','/export?draft=1'])assert.equal((await api(`/api/payroll-sheets/${sheet.id}${suffix}`,'GET',undefined,3)).status,404);
  assert.equal((await api(`/api/payroll-review/2026-09/sheets/${sheet.id}`,'GET',undefined,6)).status,404);
  for(const user of [1,2,4])assert.equal((await api('/api/payroll-review/2026-09','GET',undefined,user)).status,403);
  assert.equal((await api('/api/payroll-review/2026-13','GET',undefined,3)).status,400);
}));
test('退回退出待审进入待重提，重提恢复队列，通过进入独立已审历史',()=>check(async({api})=>{
  let sheet=(await prepare(api)).data.sheet;
  sheet=(await api(`/api/payroll-sheets/${sheet.id}/submit`,'POST',{version:sheet.version})).data.sheet;
  assert.equal((await api(`/api/payroll-review/2026-08/sheets/${sheet.id}`,'GET',undefined,3)).status,404);
  const read=(await api(`/api/payroll-review/2026-09/sheets/${sheet.id}`,'GET',undefined,6)).data.sheet;assert.equal(read.can_edit,false);assert.equal(read.can_submit,false);
  sheet=(await api(`/api/payroll-sheets/${sheet.id}/review`,'POST',{action:'return',note:'请核对出勤',version:sheet.version},3)).data.sheet;
  let report=(await api('/api/payroll-review/2026-09','GET',undefined,3)).data;
  assert.equal(report.pending.length,0);assert.equal(report.summary.returned,1);assert.equal(report.summary.submitted,0);assert.equal(report.coverage.find(r=>r.store_name==='A店').status,'退回待重提');
  assert.equal((await api(`/api/payroll-review/2026-09/sheets/${sheet.id}`,'GET',undefined,6)).status,404);
  assert.equal((await api('/api/payroll-sheets?view=work')).data.sheets[0].status,'退回');
  sheet=(await api(`/api/payroll-sheets/${sheet.id}/submit`,'POST',{version:sheet.version})).data.sheet;
  assert.equal((await api('/api/payroll-review/2026-09','GET',undefined,3)).data.pending.length,1);
  sheet=(await api(`/api/payroll-sheets/${sheet.id}/review`,'POST',{action:'approve',version:sheet.version},3)).data.sheet;
  report=(await api('/api/payroll-review/2026-09','GET',undefined,3)).data;
  assert.equal(report.pending.length,0);assert.deepEqual(report.approved.map(s=>s.id),[sheet.id]);assert.equal(report.summary.approved,1);assert.equal(report.summary.submitted,1);
  assert.equal((await api('/api/payroll-sheets?view=work')).data.sheets.length,0);
}));
test('提交范围按所选月份员工纳入，空店不算漏交，历史离职人员仍纳入',()=>check(async({api,db})=>{
  db.run("INSERT INTO stores VALUES(3,'空店','正常营业'),(4,'下月开店','正常营业'),(5,'历史店','停业')");
  db.run("INSERT INTO employees(id,store_id,store_name,name,entry_date,status,leave_date,salary,hire_type) VALUES(4,4,'下月开店','下月员工','2026-10-01','在职','',5000,'全职'),(5,5,'历史店','历史员工','2026-01-01','离职','2026-09-20',5000,'全职')");
  const report=(await api('/api/payroll-review/2026-09','GET',undefined,3)).data;
  assert.equal(report.summary.required,4);assert.equal(report.summary.unsubmitted,4);
  for(const name of ['空店','下月开店']){const row=report.coverage.find(r=>r.store_name===name);assert.equal(row.required,false);assert.equal(row.status,'暂无需制薪员工');}
  assert.equal(report.coverage.find(r=>r.store_name==='历史店').required,true);
  const next=(await api('/api/payroll-review/2026-10','GET',undefined,3)).data;
  assert.equal(next.coverage.find(r=>r.store_name==='下月开店').required,true);assert.equal(next.coverage.some(r=>r.store_name==='历史店'),false);
}));
test('历史月锁定含管理员，历史仅天数不虚构日期；未来允许提前编辑',async()=>{
  const f=await fixture(()=> '2026-10');try{
    for(const user of [2,6])assert.equal((await f.api('/api/payroll-month-settings/2026-09','PUT',{staff_group:'store',scheduled_days:24,version:1},user)).status,403);
    const old=(await f.api('/api/payroll-month-settings/2026-09','GET',undefined,2)).data.settings.store;assert.equal(old.scheduled_days,25);assert.deepEqual(old.calendar,[]);assert.equal(old.can_edit,false);
    const result=await f.api('/api/payroll-month-settings/2026-11','PUT',{staff_group:'store',scheduled_days:22,calendar:calendar('2026-11'),version:0},2);assert.equal(result.status,200);assert.equal(result.data.setting.calendar.length,30);assert.equal(result.data.setting.calendar[22].start_time,'');assert.equal(result.data.setting.can_edit,true);
    const history=(await f.api('/api/payroll-attendance-settings','GET',undefined,2)).data.settings;assert.equal(history[0].period,'2026-11');assert.equal(history[0].calendar.length,30);assert.equal(history[0].can_edit,true);assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM payroll_attendance_events').n,1);
  }finally{await f.close()}
});
test('月出勤管理禁止店长和审核人，staff.view不能单独获得维护权限',()=>check(async({db,api})=>{
  for(const user of [1,3,4,7])assert.equal((await api('/api/payroll-attendance-settings','GET',undefined,user)).status,403);
  db.run("UPDATE position_settings SET permissions_json='[\"staff.view\"]' WHERE id=2");assert.equal((await api('/api/payroll-month-settings/2026-10','PUT',{staff_group:'store',scheduled_days:22,version:0},2)).status,403);
}));
test('日历完整性、工作天数与时间校验失败不留下记录',()=>check(async({api,db})=>{
  const good=calendar('2026-10');
  for(const transform of [days=>days.pop(),days=>days[1].date=days[0].date,days=>days[0].date='2026-11-01',days=>days[0].type='unknown',days=>days[0].start_time='25:00',days=>days[0].end_time='08:00']){
    const days=structuredClone(good);transform(days);assert.equal((await api('/api/payroll-month-settings/2026-10','PUT',{staff_group:'group',scheduled_days:22,version:0,calendar:days},2)).status,400);
  }
  assert.equal((await api('/api/payroll-month-settings/2026-10','PUT',{staff_group:'group',scheduled_days:21,version:0,calendar:good},2)).status,400);assert.equal(db.queryOne('SELECT COUNT(*) n FROM payroll_attendance_events').n,0);
  good[0].start_time='20:00';good[0].end_time='08:00';good[0].next_day=true;assert.equal((await api('/api/payroll-month-settings/2026-10','PUT',{staff_group:'group',scheduled_days:22,version:0,calendar:good},2)).status,200);
}));
test('人事与管理员工资表标准工资也只读，薪酬档案快照不变',()=>check(async({api,db})=>{
  const sheet=(await prepare(api,'A店',2)).data.sheet,before=db.queryOne('SELECT data FROM payroll_sheet_items').data;
  for(const user of [2,6]){const items=structuredClone(sheet.items);items[0].base_salary=8000;assert.equal((await api(`/api/payroll-sheets/${sheet.id}`,'PUT',{version:sheet.version,items},user)).status,403)}
  assert.equal(db.queryOne('SELECT data FROM payroll_sheet_items').data,before);
}));
test('原人事岗位明确获得出勤权限，其他岗位及账号不变，迁移重复不追加',()=>check(async({db})=>{
  db.run("ALTER TABLE position_settings ADD COLUMN name TEXT DEFAULT ''");db.run("UPDATE position_settings SET name='人事',permissions_json='[\"staff.view\",\"collab.manage\"]' WHERE id=2");
  const before=db.queryAll('SELECT * FROM users');workflow.initialize(db);workflow.initialize(db);
  assert.deepEqual(JSON.parse(db.queryOne('SELECT permissions_json FROM position_settings WHERE id=2').permissions_json),['staff.view','collab.manage','payroll.attendance']);
  assert.deepEqual(JSON.parse(db.queryOne('SELECT permissions_json FROM position_settings WHERE id=1').permissions_json),['staff.store.edit','payroll.view','payroll.prepare']);assert.deepEqual(db.queryAll('SELECT * FROM users'),before);
}));
test('工资制作可读取应出勤基线，店长与审核人不能从旧接口读取日历明细',()=>check(async({api})=>{
  assert.equal((await api('/api/payroll-month-settings/2026-10','PUT',{staff_group:'store',scheduled_days:22,version:0,calendar:calendar('2026-10')},2)).status,200);
  for(const user of [1,3]){const setting=(await api('/api/payroll-month-settings/2026-10','GET',undefined,user)).data.settings.store;assert.equal(setting.scheduled_days,22);assert.deepEqual(setting.calendar,[]);assert.equal(setting.calendar_json,undefined);assert.equal(setting.can_edit,false)}
  assert.equal((await api('/api/payroll-month-settings/2026-10','GET',undefined,2)).data.settings.store.calendar.length,31);
}));
