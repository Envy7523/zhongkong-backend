'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const health=require('../lib/daily-update-health');
test('历史待核对仅包含未通过且启用的任务，当日通过仍计入总数，已读规则保留',()=>{
 const now=new Date('2026-10-30T01:30:00Z');let failedDay='';
 const db={queryOne(sql,p=[]){
   if(sql.includes('sqlite_master'))return p[0]==='staff_daily_task_runs'||sql.includes("name='staff_daily_task_runs'")?{name:'staff_daily_task_runs'}:null;
   if(sql.includes('FROM staff_daily_task_runs')){const day=p[1];return {task_key:'dingtalk_attendance',business_date:day,status:day===failedDay?'failed':'success',window_start:day,window_end:day,message:'需要重试',result_json:JSON.stringify({date_from:day,date_to:day,employee_count:12,record_count:24})}}
   return null;
 },queryAll(){return []}};
 const opts={now,attendance:{enabled:true,configured:true,planned_time:'01:00'}};
 let r=health.report(db,{id:1},opts);assert.equal(r.rows.filter(row=>row.type==='dingtalk_attendance').length,1);assert.equal(r.passed,1);assert.equal(r.should_popup,true);
 failedDay='2026-10-27';r=health.report(db,{id:1},opts);const rows=r.rows.filter(row=>row.type==='dingtalk_attendance');assert.equal(rows.length,2);assert.equal(rows.find(row=>row.business_date===failedDay).status,'failed');assert.equal(r.failures,1);
 r=health.report(db,{id:1},{...opts,attendance:{...opts.attendance,enabled:false}});assert.equal(r.rows.filter(row=>row.type==='dingtalk_attendance').length,1);assert.equal(r.failures,0);
});
