'use strict';
const {punchSummary}=require('./attendance-calendar');
const round=n=>Math.round(n*100)/100;
function stamp(v){const s=String(v||'');return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(s)?s:s.replace(' ','T')+'+08:00');}
function merge(intervals){const result=[];for(const [s,e]of intervals.sort((a,b)=>a[0]-b[0])){const last=result.at(-1);if(last&&s<=last[1])last[1]=Math.max(last[1],e);else result.push([s,e]);}return result;}
function calculate(records,plan,date){
 const actual=punchSummary(records);
 if(!plan||plan.pending||plan.type==='unassigned')return {hours:null,complete:false,reason:'缺少已确认排班',actual_hours:actual.hours};
 if(['rest','holiday','leave','comp'].includes(plan.type))return {hours:0,complete:true,reason:'无计薪班次',actual_hours:actual.hours};
 const raw=plan.segments||[{start_time:date+' '+plan.start_time,end_time:(plan.next_day?new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10):date)+' '+plan.end_time}];
 const planned=raw.map(s=>[stamp(s.start_time),stamp(s.end_time)]);
 if(!planned.length||planned.some(([s,e])=>!Number.isFinite(s)||!Number.isFinite(e)||e<=s||e-s>86400000))return {hours:null,complete:false,reason:'排班时间不完整',actual_hours:actual.hours};
 if(actual.incomplete||actual.hours===null)return {hours:null,complete:false,reason:'上下班打卡不完整',actual_hours:actual.hours};
 const punches=[...new Map(records.filter(r=>r.time_result!=='NotSigned').map(r=>[r.check_time+'#'+r.check_type,r])).values()].sort((a,b)=>stamp(a.check_time)-stamp(b.check_time));
 const intervals=[];let open=null;
 for(const r of punches){if(r.check_type==='OnDuty'&&open===null)open=stamp(r.check_time);else if(r.check_type==='OffDuty'&&open!==null){intervals.push([open,stamp(r.check_time)]);open=null;}}
 const scheduled=merge(planned),pairs=merge(intervals.filter(([s,e])=>Number.isFinite(s)&&e>s));
 let covered=0,total=0;
 for(const [s,e]of scheduled){total+=e-s;for(const [a,b]of pairs)covered+=Math.max(0,Math.min(e,b)-Math.max(s,a));}
 return {hours:round(covered/3600000),planned_hours:round(total/3600000),actual_hours:actual.hours,complete:true,covered:covered===total,reason:covered===total?'打卡完整覆盖排班，按计划时长计薪':'迟到或早退，仅计排班内打卡覆盖时长'};
}
function plans(db,from,to){
 const result=new Map();
 const exists=t=>!!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name=?",[t]);
 if(exists('staff_roster_weeks'))for(const week of db.queryAll("SELECT rows_json FROM staff_roster_weeks WHERE status='published' AND week_start<=? ORDER BY updated_at",[to]))for(const person of JSON.parse(week.rows_json||'[]'))for(const day of person.days||[])if(day.date>=from&&day.date<=to)result.set(`${person.employee_id}:${day.date}`,day);
 // The active roster screen displays imported DingTalk schedules when available.
 if(exists('dingtalk_schedule_days'))for(const day of db.queryAll('SELECT d.employee_id,d.work_date,d.plan_json FROM dingtalk_schedule_days d JOIN employees e ON e.id=d.employee_id AND e.dingtalk_user_id=d.dingtalk_user_id WHERE d.work_date BETWEEN ? AND ?',[from,to]))result.set(`${day.employee_id}:${day.work_date}`,JSON.parse(day.plan_json));
 return result;
}
function statistics(records,plan,date){
 const hasPunch=records.some(r=>r.time_result!=='NotSigned'&&Number.isFinite(stamp(r.check_time)));
 if(!hasPunch)return {hours:0,complete:true,reason:'无实际打卡，不计出勤工资'};
 // 日报/经营看板只统计出勤成本，不执行迟到、早退、部分小时请假的工资扣减。
 if(plan&&!plan.pending&&plan.type!=='unassigned'&&!['rest','holiday','leave','comp'].includes(plan.type)){
  const next=new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  const raw=plan.segments||[{start_time:date+' '+plan.start_time,end_time:(plan.next_day?next:date)+' '+plan.end_time}];
  const intervals=raw.map(r=>[stamp(r.start_time),stamp(r.end_time)]);
  if(intervals.length&&intervals.every(([s,e])=>Number.isFinite(s)&&Number.isFinite(e)&&e>s&&e-s<=86400000))return {hours:round(merge(intervals).reduce((n,[s,e])=>n+e-s,0)/3600000),complete:true,reason:'有打卡，按完整排班时长计出勤工资，不扣迟到早退或部分小时请假'};
 }
 return {hours:null,complete:false,reason:'已出勤，缺少当日排班计薪时长'};
}
module.exports={calculate,statistics,plans};
