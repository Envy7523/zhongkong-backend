'use strict';
const TYPES=['meituan_group_report1','meituan_group_report2','meituan_group_reviews','douyin_group_report1','douyin_group_report2','douyin_group_reviews'];
function local(now){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(p=>[p.type,p.value]));
 return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`};
}
function due(plan,state,now=new Date()){
 if(!TYPES.includes(plan?.report_type)||plan.enabled!==true)return false;
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(plan.run_time||''))throw Error('group_schedule_invalid');
 const at=local(now);if(at.time<plan.run_time)return false;
 // A newly saved plan takes effect at its next future occurrence, not retroactively.
 if(plan.updated_at){const changed=local(plan.updated_at);if(changed.date===at.date&&changed.time>=plan.run_time)return false;}
 if(state?.date!==at.date)return true;
 if(state.status==='complete')return false;
 if(state.status==='waiting_export')return Date.parse(now)>=Date.parse(state.next_check_at);
 if(state.status==='cancelled')return true;
 if((state.attempts||0)>=16)return false;
 return state.status==='failed'&&Date.parse(now)-Date.parse(state.finished_at)>=30*60*1000;
}
module.exports={TYPES,local,due};
