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
function readRoute(employee,setting){
 const source=fs.readFileSync(require.resolve('../server.js'),'utf8');let handler;
 const queries=[];const db={queryOne(sql){queries.push(sql);return sql.includes('FROM employees')?employee:setting},queryAll(){return [punch('2026-10-02','09:00','OnDuty'),punch('2026-10-02','17:00','OffDuty')]}};
 const snippet=source.slice(source.indexOf("app.get('/api/staff/:id/dingtalk-attendance'"),source.indexOf('// POST /api/staff/seed'));
 new Function('app','db','normalizeAttendanceDate','employeeCalendar','isGroupAffiliation',snippet)({get(path,fn){handler=fn}},db,v=>v,employeeCalendar,isGroupAffiliation);
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
