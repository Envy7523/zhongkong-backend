'use strict';
const {workTime}=require('./attendance-calendar');
const {units,dateAdd}=require('./roster-balance');
const {employeeApprovals}=require('./dingtalk-approvals');
const round=n=>Math.round(n*100)/100;
function stamp(value,end=false){
  let text=String(value||'').trim();
  if(/上午|下午/.test(text)){const afternoon=text.includes('下午');text=text.slice(0,10)+(end?(afternoon?' 24:00':' 12:00'):(afternoon?' 12:00':' 00:00'));}
  else if(/^\d{4}-\d{2}-\d{2}$/.test(text))text+=end?' 24:00':' 00:00';
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(text)?text:text.replace(' ','T')+'+08:00');
}
function unionHours(intervals){
  const sorted=intervals.filter(([s,e])=>Number.isFinite(s)&&e>s).sort((a,b)=>a[0]-b[0]);
  let total=0,start=null,end=null;
  for(const [s,e] of sorted){if(start===null){start=s;end=e;}else if(s<=end)end=Math.max(end,e);else{total+=end-start;start=s;end=e;}}
  if(start!==null)total+=end-start;
  return round(total/3600000);
}
const kindOf=leave=>/病假/.test(leave.leave_type||'')?'sick':/事假/.test(leave.leave_type||'')?'personal':null;
function summarize({period,today,employee,records=[],plans=new Map(),approvals=[],results=[]}){
  const first=`${period}-01`,monthEnd=`${period}-${String(new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5)),0)).getUTCDate()).padStart(2,'0')}`;
  const last=[monthEnd,dateAdd(today,-1)].sort()[0];
  const approved=[...new Map(approvals.filter(a=>a.effective&&kindOf(a)).map(a=>[a.instance_id,a])).values()];
  const relevant=approved.filter(a=>stamp(a.start_time)<stamp(dateAdd(last,1))&&stamp(a.end_time,true)>stamp(first));
  const details=[],unknown=new Set(),fallback=new Set();
  let attended=0,punchDays=0,incomplete=0,missing=0,hours=0;
  const leaveHours={personal:0,sick:0};
  for(let date=first;date<=last;date=dateAdd(date,1)){
    if(employee.entry_date&&date<employee.entry_date||employee.leave_date&&date>employee.leave_date)continue;
    const plan=plans.get(date),dayRecords=records.filter(r=>r.work_date===date),time=workTime(dayRecords),dayResults=results.filter(r=>r.work_date===date);
    const planned=(plan?.segments||[]).map(s=>[stamp(s.start_time),stamp(s.end_time)]).filter(([s,e])=>Number.isFinite(s)&&e>s);
    const dayLeaves=relevant.filter(a=>stamp(a.start_time)<stamp(dateAdd(date,1))&&stamp(a.end_time,true)>stamp(date));
    const rawIntervals=dayLeaves.map(a=>[stamp(a.start_time),stamp(a.end_time,true)]);
    const notSigned=dayResults.some(r=>r.time_result==='NotSigned'&&!rawIntervals.some(([s,e])=>stamp(r.plan_check_time)>=s&&stamp(r.plan_check_time)<=e));
    const isIncomplete=!!time.incomplete||notSigned;
    const worked=time.hours!==null&&!isIncomplete?(employee.hire_type==='兼职'?Math.min(1,time.hours/8):units(time.hours)):0;
    if(time.punch_count)punchDays++;
    if(isIncomplete)incomplete++;
    if(!time.punch_count&&!dayLeaves.length&&(!plan||plan.type==='work'))missing++;
    attended+=worked;hours+=time.hours||0;
    const dayHours={personal:0,sick:0};
    for(const kind of ['personal','sick']){
      const leaves=dayLeaves.filter(a=>kindOf(a)===kind),intervals=[];
      for(const a of leaves){
        const s=stamp(a.start_time),e=stamp(a.end_time,true);
        if(planned.length)for(const [p,q] of planned)intervals.push([Math.max(s,p),Math.min(e,q)]);
        else if(plan?.type!=='rest'&&plan?.type!=='holiday'){
          // Use the platform's approved duration only for an entirely included
          // one-day request. Never invent an hours-per-day rate or split a
          // multi-day duration without a schedule.
          const duration=Number(a.duration),key=a.instance_id;
          if(a.duration_unit==='hour'&&Number.isFinite(duration)&&duration>=0&&a.start_time.slice(0,10)===date&&a.end_time.slice(0,10)===date&&s>=stamp(first)&&e<=stamp(dateAdd(last,1))&&leaves.length===1){
            if(!fallback.has(key)){dayHours[kind]+=duration;fallback.add(key);}
          }else unknown.add(kind);
        }
      }
      dayHours[kind]=round(dayHours[kind]+unionHours(intervals));leaveHours[kind]+=dayHours[kind];
    }
    details.push({date,attended_days:round(worked),hours:time.hours,incomplete:isIncomplete,personal_leave_hours:dayHours.personal,sick_leave_hours:dayHours.sick,approval_ids:dayLeaves.map(a=>a.instance_id)});
  }
  const available=details.some(day=>plans.has(day.date)||records.some(r=>r.work_date===day.date)||day.approval_ids.length);
  return {available,period,as_of:last>=first?last:null,partial:period>=today.slice(0,7),attendance_days:available?round(attended):null,punch_days:punchDays,actual_hours:available?round(hours):null,incomplete_days:incomplete,unobtained_days:missing,
    personal_leave_hours:unknown.has('personal')?null:round(leaveHours.personal),sick_leave_hours:unknown.has('sick')?null:round(leaveHours.sick),
    note:!available?'未获取该月考勤':unknown.size?'部分请假缺少排班或跨日时长，须人工核对':incomplete?'存在缺卡，出勤天数仅含完整记录':missing?`有 ${missing} 天未获取完整考勤，须核对`:period>=today.slice(0,7)?'截至昨日的考勤汇总，整月计薪待结算':'已读取月度考勤',details};
}
function readSummary(db,item,period,today){
  if(item.supervisor_display_only||item.is_dispatch_support)return {available:false,note:item.supervisor_display_only?'集团发薪展示行':'跨店支援需人工核对分摊'};
  const employee=db.queryOne('SELECT id,dingtalk_user_id,entry_date,leave_date,hire_type FROM employees WHERE id=?',[item.employee_id]);
  if(!employee?.dingtalk_user_id)return {available:false,note:'员工尚未绑定钉钉 ID'};
  if(Number(db.queryOne('SELECT COUNT(*) n FROM employees WHERE dingtalk_user_id=?',[employee.dingtalk_user_id])?.n)!==1)return {available:false,note:'钉钉 ID 重复绑定，须核对'};
  const first=period+'-01',last=period+'-31';
  const records=db.queryAll('SELECT * FROM dingtalk_attendance_records WHERE employee_id=? AND work_date BETWEEN ? AND ? ORDER BY check_time',[employee.id,first,last]).filter(r=>!r.dingtalk_user_id||r.dingtalk_user_id===employee.dingtalk_user_id);
  const hasSchedule=!!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='dingtalk_schedule_days'");
  const sources=hasSchedule?db.queryAll('SELECT work_date,plan_json,synced_at FROM dingtalk_schedule_days WHERE employee_id=? AND dingtalk_user_id=? AND work_date BETWEEN ? AND ?',[employee.id,employee.dingtalk_user_id,first,last]):[];
  const plans=new Map(sources.map(r=>[r.work_date,JSON.parse(r.plan_json)]));
  const approvals=employeeApprovals(db,employee.dingtalk_user_id,first,last),results=db.queryAll('SELECT * FROM dingtalk_attendance_results WHERE employee_id=? AND dingtalk_user_id=? AND work_date BETWEEN ? AND ?',[employee.id,employee.dingtalk_user_id,first,last]);
  const summary=summarize({period,today,employee,records,plans,approvals,results});
  summary.source_updated_at=[...records,...sources,...approvals,...results].map(r=>r.synced_at||'').sort().at(-1)||null;
  return summary;
}
function splitLedgerLeave(days,summary){
  let personal=0,sick=0;
  for(const day of days){
    const leave=Number(day.leave_days)||0;if(!leave)continue;
    const source=summary.details?.find(s=>s.date===day.date);
    if(source?.sick_leave_hours>0&&source?.personal_leave_hours>0)return null;
    if(source?.sick_leave_hours>0||/病假/.test(day.note||''))sick+=leave;else personal+=leave;
  }
  return {personal_leave:round(personal),sick_leave:round(sick)};
}
module.exports={summarize,readSummary,splitLedgerLeave,unionHours};
