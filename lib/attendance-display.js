'use strict';
// Presentation only: does not change payroll, stored punches or approval decisions.
function stamp(value,end=false){
  let text=String(value||'').trim();
  if(!text)return NaN;
  if(/上午|下午/.test(text)){const afternoon=text.includes('下午');text=text.slice(0,10)+(end?(afternoon?' 24:00':' 12:00'):(afternoon?' 12:00':' 00:00'));}
  else if(/^\d{4}-\d{2}-\d{2}$/.test(text))text+=end?' 24:00':' 00:00';
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(text)?text:text.replace(' ','T')+'+08:00');
}
function subtract(start,end,intervals){
  let pieces=[[start,end]];
  for(const [a,b] of intervals)pieces=pieces.flatMap(([s,e])=>b<=s||a>=e?[[s,e]]:[[s,Math.min(e,a)],[Math.max(s,b),e]].filter(([x,y])=>y>x));
  return pieces;
}
function attendanceDisplay(day,now=Date.now()){
  const planned=(day.segments||[]).map(s=>[stamp(s.start_time),stamp(s.end_time)]).filter(([s,e])=>Number.isFinite(s)&&e>s);
  const leave=(day.approvals||[]).filter(a=>a.effective&&(a.leave_type||/请假/.test(a.template_name||''))).map(a=>{
    const start=stamp(a.start_time),end=stamp(a.end_time,true),kind=a.leave_type||'请假';
    const overlaps=planned.length?planned.flatMap(([s,e])=>[[Math.max(s,start),Math.min(e,end)]]).filter(([s,e])=>e>s):[[Math.max(stamp(day.date),start),Math.min(stamp(day.date,true),end)]].filter(([s,e])=>e>s);
    const full=planned.length?planned.every(([s,e])=>subtract(s,e,[[start,end]]).length===0):(start<=stamp(day.date)&&end>=stamp(day.date,true))||(/^day$/i.test(a.duration_unit)&&Number(a.duration)>=1);
    return {...a,kind,scope:full?'full':'partial',hours:Math.round(overlaps.reduce((sum,[s,e])=>sum+(e-s)/3600000,0)*100)/100,start,end};
  }).filter(a=>a.hours>0);
  const intervals=leave.map(a=>[a.start,a.end]);
  const required=planned.flatMap(([s,e])=>subtract(s,e,intervals));
  const results=day.attendance_results||[],actual=(day.attendance?.segments||[]).map(s=>[stamp(s.start_time),stamp(s.end_time)]);
  const issues=[];let missingShift=false;
  for(const [s,e] of required){
    // A leave interval can split a shift: the same punch pair can cover both pieces.
    const pair=actual.find(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&a<e&&b>s);
    if(pair){if(pair[0]>s)issues.push('迟到');if(pair[1]<e&&now>=e)issues.push('早退');}
    else{
      if(now>=e)missingShift=true;
      for(const r of results){const p=stamp(r.plan_check_time);if(p<s||p>e)continue;const t=stamp(r.user_check_time);
        if(r.check_type==='OnDuty'&&Number.isFinite(t)&&t>s&&t<e)issues.push('迟到');
        if(r.check_type==='OffDuty'&&Number.isFinite(t)&&t<e&&t>s&&now>=e)issues.push('早退');
      }
    }
  }
  if(!planned.length){for(const r of results)if(['Late','SeriousLate','Early'].includes(r.time_result)&&!intervals.some(([s,e])=>stamp(r.plan_check_time)>=s&&stamp(r.plan_check_time)<e))issues.push(r.time_result==='Early'?'早退':'迟到');}
  const fullLeave=leave.length&&(planned.length?required.length===0:leave.some(a=>a.scope==='full'));
  const absent=day.exception?.decision==='absent'||results.some(r=>r.time_result==='Absenteeism'&&!intervals.some(([s,e])=>stamp(r.plan_check_time)>=s&&stamp(r.plan_check_time)<e));
  let state=day.type==='rest'||day.type==='holiday'?'rest':day.attendance?.punch_count&&planned.length?'normal':'unassigned';
  if(issues.length)state=issues.includes('迟到')?'late':'early';
  if((day.attendance?.incomplete||missingShift&&day.attendance?.punch_count)&&!issues.length)state='incomplete';
  if(absent&&!fullLeave)state='absent';
  if(absent&&!fullLeave&&leave.length)issues.push('旷工');
  if(leave.length)state=leave.some(a=>/病假/.test(a.kind))?'sick':leave.some(a=>/年假/.test(a.kind))?'annual':'personal';
  const labels={normal:'正常',late:'迟到',early:'早退',incomplete:'缺卡',rest:'休息',unassigned:'未获取',absent:'旷工',personal:'事假',sick:'病假',annual:'年假'};
  const kinds=[...new Set(leave.map(a=>a.kind))];
  const subtitle=leave.length?(fullLeave?'整天请假':`临时请假 · ${Math.round(leave.reduce((n,a)=>n+a.hours,0)*100)/100}小时`):'';
  return {state,label:leave.length?kinds.join(' / '):labels[state],subtitle,issues:[...new Set(issues)],leaves:leave.map(({start,end,...a})=>a),full_leave:!!fullLeave};
}
module.exports={attendanceDisplay};
