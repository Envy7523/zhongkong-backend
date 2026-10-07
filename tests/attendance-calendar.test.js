const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {employeeCalendar,workTime}=require('../lib/attendance-calendar');
const {isGroupAffiliation}=require('../lib/staff-affiliation');
const punch=(date,time,type,result='Normal')=>({work_date:date,check_time:`${date} ${time}:00`,check_type:type,time_result:result});
test('分段上下班合计工时，重复打卡不重复计入，午休不计',()=>{
 const rows=[punch('2026-10-01','09:00','OnDuty'),punch('2026-10-01','12:00','OffDuty'),punch('2026-10-01','14:00','OnDuty'),punch('2026-10-01','18:00','OffDuty')];
 assert.deepEqual(workTime([...rows,rows[0]]),{hours:7,incomplete:false,punch_count:4});
});
test('跨午夜班次按实际日期配对；过长及缺失打卡不猜工时',()=>{
 const on=punch('2026-10-01','22:00','OnDuty'),off={...punch('2026-10-02','06:00','OffDuty'),work_date:'2026-10-01'};
 assert.equal(workTime([off,on]).hours,8);
 assert.deepEqual(workTime([on]),{hours:null,incomplete:true,punch_count:1});
 assert.equal(workTime([on,punch('2026-10-03','06:00','OffDuty')]).hours,null);
});
test('部分配对只汇总已知工时，缺卡提示保留；未打卡占位不算出勤',()=>{
 const rows=[punch('2026-10-01','09:00','OnDuty'),punch('2026-10-01','12:00','OffDuty'),punch('2026-10-01','14:00','OnDuty'),punch('2026-10-01','18:00','OffDuty','NotSigned')];
 assert.deepEqual(workTime(rows),{hours:3,incomplete:true,punch_count:3});
 const result=employeeCalendar({period:'2026-10',records:[rows[3]],today:'2026-10-07'});assert.equal(result.days[0].status,'unknown');assert.equal(result.summary.attended_days,0);
});
test('办公室休息计划和真实出勤分开，休息日打卡优先显示出勤',()=>{
 const result=employeeCalendar({period:'2026-10',today:'2026-10-07',records:[punch('2026-10-02','09:00','OnDuty')],officeCalendar:[{date:'2026-10-01',type:'holiday'},{date:'2026-10-02',type:'rest'},{date:'2026-10-03',type:'work'}]});
 assert.equal(result.days.length,31);assert.equal(result.days[0].status,'holiday');assert.equal(result.days[1].status,'attended');assert.equal(result.days[2].status,'missing');assert.equal(result.days[3].status,'unknown');assert.equal(result.days[7].status,'future');assert.equal(result.summary.attended_days,1);assert.equal(result.summary.rest_days,1);
});
test('历史应出勤天数不能虚构休息日期；闰年日期完整',()=>{
 const result=employeeCalendar({period:'2024-02',records:[],today:'2026-10-07'});assert.equal(result.days.length,29);assert.ok(result.days.every(day=>day.status==='unknown'));
});
function readRoute(employee,setting,supervisor=null){
 const source=fs.readFileSync(require.resolve('../server.js'),'utf8');let handler;
 const queries=[];const db={queryOne(sql){queries.push(sql);return sql.includes('FROM employees')?employee:setting},queryAll(){return [punch('2026-10-02','09:00','OnDuty'),punch('2026-10-02','17:00','OffDuty')]}};
 const snippet=source.slice(source.indexOf("app.get('/api/staff/:id/dingtalk-attendance'"),source.indexOf('// POST /api/staff/seed'));
 new Function('app','db','normalizeAttendanceDate','employeeCalendar','isGroupAffiliation','staffSupervisor',snippet)({get(path,fn){handler=fn}},db,v=>v,employeeCalendar,isGroupAffiliation,{assignment:()=>supervisor});
 const request=query=>{let status=200,result;const res={status(value){status=value;return this},json(value){result=value}};handler({params:{id:1},query},res);return {status,result}};
 return {request,queries};
}
test('员工接口返回月历与工时；门店从不使用办公室或旧统一排休日历',()=>{
 const route=readRoute({id:1,name:'门店员工',store_name:'A店'},null),response=route.request({period:'2026-10'});
 assert.equal(response.status,200);assert.equal(response.result.days.length,31);assert.equal(response.result.summary.hours,8);assert.equal(response.result.days[0].status,'unknown');assert.equal(route.queries.length,1);
 assert.equal(route.request({period:'2026-13'}).status,400);
});
test('办公室员工接口读取对应月份安排，原始流水接口保持兼容',()=>{
 const route=readRoute({id:1,name:'办公室员工',store_name:'永文总公司'},{calendar_json:JSON.stringify([{date:'2026-10-01',type:'rest'}])});
 assert.equal(route.request({period:'2026-10'}).result.days[0].status,'rest');
 const result=route.request({date_from:'2026-10-01',date_to:'2026-10-31'}).result;assert.equal(result.records.length,2);assert.equal(result.days,undefined);
});

test('打卡摘要保留分段起止、跨日时间、缺卡与真实工时，不把午休算成出勤',()=>{
 const {punchSummary}=require('../lib/attendance-calendar');
 const punch=(time,type,result='Normal')=>({check_time:time,check_type:type,time_result:result});
 const summary=punchSummary([punch('2026-10-05 08:00:00','OnDuty'),punch('2026-10-05 12:00:00','OffDuty'),punch('2026-10-05 13:00:00','OnDuty'),punch('2026-10-05 17:00:00','OffDuty')]);
 assert.equal(summary.start_time,'2026-10-05 08:00');assert.equal(summary.end_time,'2026-10-05 17:00');assert.equal(summary.hours,8);assert.equal(summary.incomplete,false);
 const cross=punchSummary([punch('2026-10-05T14:00:00Z','OnDuty'),punch('2026-10-06 06:00:00','OffDuty')]);assert.equal(cross.start_time,'2026-10-05 22:00');assert.equal(cross.end_time,'2026-10-06 06:00');assert.equal(cross.hours,8);
 const missing=punchSummary([punch('2026-10-05 08:00:00','OnDuty'),punch('2026-10-05 17:00:00','OffDuty','NotSigned')]);assert.equal(missing.end_time,null);assert.equal(missing.hours,null);assert.equal(missing.incomplete,true);assert.equal(punchSummary([]).punch_count,0);
});

test('分段摘要显示每段打卡；去重、缺卡、跨日和秒级合计保持原计算',()=>{
 const {punchSummary}=require('../lib/attendance-calendar');const p=(time,type)=>({check_time:time,check_type:type,time_result:'Normal'});
 const rows=[p('2026-10-05 11:34:14','OnDuty'),p('2026-10-05 14:00:15','OffDuty'),p('2026-10-05 17:30:58','OnDuty'),p('2026-10-05 21:00:08','OffDuty')];
 const result=punchSummary([...rows,rows[0],rows[1]]);assert.equal(result.hours,5.92);assert.equal(result.segments.length,2);assert.equal(result.segments[0].start_time,'2026-10-05 11:34');assert.equal(result.segments[0].end_time,'2026-10-05 14:00');assert.equal(result.segments[1].start_time,'2026-10-05 17:30');assert.equal(result.segments[1].end_time,'2026-10-05 21:00');
 const missing=punchSummary([...rows.slice(0,2),rows[2]]);assert.equal(missing.segments.length,2);assert.equal(missing.segments[1].end_time,null);assert.equal(missing.incomplete,true);
 const cross=punchSummary([p('2026-10-05 22:00:00','OnDuty'),p('2026-10-06 06:00:00','OffDuty')]);assert.equal(cross.segments[0].end_time,'2026-10-06 06:00');assert.equal(cross.hours,8);
});


test('集团督导个人考勤使用门店规则，不套用办公室休息日',()=>{
 const route=readRoute({id:1,name:'督导',store_name:'鹅太公品牌'},{calendar_json:JSON.stringify([{date:'2026-10-01',type:'rest'}])},{store_id:12});
 const response=route.request({period:'2026-10'});assert.equal(response.status,200);assert.equal(response.result.days[0].status,'unknown');assert.equal(route.queries.length,1);
});
