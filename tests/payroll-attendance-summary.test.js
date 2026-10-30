const {test}=require('node:test'),assert=require('node:assert/strict');
const {summarize,splitLedgerLeave}=require('../lib/payroll-attendance-summary');
const employee={hire_type:'全职'},period='2026-09',today='2026-10-10';
const plan=date=>({type:'work',segments:[{start_time:date+' 09:00',end_time:date+' 14:00'},{start_time:date+' 17:00',end_time:date+' 21:00'}]});
const pair=(date,from='09:00',to='14:00')=>[{work_date:date,check_time:date+' '+from,check_type:'OnDuty',time_result:'Normal'},{work_date:date,check_time:date+' '+to,check_type:'OffDuty',time_result:'Normal'}];
const leave=(id,date,kind,from='13:00',to='18:00',extra={})=>({instance_id:id,effective:true,leave_type:kind,start_time:date+' '+from,end_time:date+' '+to,duration:'5',duration_unit:'hour',...extra});
test('事假病假分类、休息间隔排除、拒绝撤销与补钟不计请假',()=>{
 const date='2026-09-18',other='2026-09-19';
 const result=summarize({period,today,employee,records:pair(date),plans:new Map([[date,plan(date)],[other,plan(other)]]),approvals:[leave('p',date,'事假'),leave('s',other,'病假','09:00','21:00'),leave('repair',date,'补钟'),leave('refused',date,'病假','09:00','21:00',{effective:false}),leave('revoked',date,'事假','09:00','21:00',{effective:false})]});
 assert.equal(result.personal_leave_hours,2);assert.equal(result.sick_leave_hours,9);assert.equal(result.attendance_days,0.5);
 assert.deepEqual(splitLedgerLeave([{date,leave_days:0.5},{date:other,leave_days:1}],result),{personal_leave:0.5,sick_leave:1});
});
test('同一审批重复与重叠时间不重复累计，跨月按查询月份截取',()=>{
 const date='2026-09-30',a=leave('a',date,'事假','13:00','18:00'),b=leave('b',date,'事假','13:30','18:00');
 const result=summarize({period,today,employee,plans:new Map([[date,plan(date)]]),approvals:[a,a,b,leave('cross','2026-08-31','病假','09:00','21:00',{end_time:'2026-09-01 21:00'})]});
 assert.equal(result.personal_leave_hours,2);assert.equal(result.sick_leave_hours,null);
});
test('缺卡不冒充完整出勤，累计工时保留；今天和未来不提前计入',()=>{
 const date='2026-10-09',result=summarize({period:'2026-10',today:'2026-10-10',employee,records:[...pair(date,'08:48','21:01'),...pair('2026-10-10')],results:[{work_date:date,time_result:'NotSigned',plan_check_time:date+' 14:00'}],plans:new Map([[date,plan(date)]])});
 assert.equal(result.attendance_days,0);assert.equal(result.incomplete_days,1);assert.equal(result.actual_hours,12.22);assert.equal(result.as_of,date);assert.equal(result.partial,true);
});
test('兼职保留工时比例，缺少排班的单日小时申请使用批准时长，未来月份保持未获取',()=>{
 const date='2026-09-18',result=summarize({period,today,employee:{hire_type:'兼职'},records:pair(date,'09:00','12:00'),approvals:[leave('p',date,'事假','13:00','18:00')]});
 assert.equal(result.actual_hours,3);assert.equal(result.attendance_days,0.38);assert.equal(result.personal_leave_hours,5);
 assert.equal(summarize({period:'2026-11',today,employee,plans:new Map([['2026-11-01',plan('2026-11-01')]])}).available,false);
});
test('同日混合请假不能擅自分摊计薪扣减',()=>{
 assert.equal(splitLedgerLeave([{date:'2026-09-18',leave_days:1}],{details:[{date:'2026-09-18',sick_leave_hours:2,personal_leave_hours:3}]}),null);
});
