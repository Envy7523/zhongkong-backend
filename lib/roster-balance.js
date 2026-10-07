const {workTime}=require('./attendance-calendar');
function dateAdd(date,days){const value=new Date(date+'T00:00:00Z');value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10)}
function expiry(date){const value=new Date(date+'T00:00:00Z'),day=value.getUTCDate();value.setUTCDate(1);value.setUTCMonth(value.getUTCMonth()+3);const last=new Date(Date.UTC(value.getUTCFullYear(),value.getUTCMonth()+1,0)).getUTCDate();value.setUTCDate(Math.min(day,last));return [value.toISOString().slice(0,10),`${Number(date.slice(0,4))+1}-01-01`].sort()[0]}
function units(hours){return hours<2?0:hours<6?0.5:1}
const round=n=>Math.round(n*100)/100;
// Replay confirmed dates in chronological order. Lots retain their own expiry;
// planned shifts alone never generate credits, and missing punches never imply absence.
function settle({days,settings,today,activeFrom,partTime=false}){
  const lots=[],events=[],results=[],months=new Map();
  const expireAt=date=>{for(const lot of lots)if(lot.remaining>0 && lot.expires_on<=date){events.push({key:`expire:${lot.date}`,date:lot.expires_on,type:lot.expires_on.endsWith('-01-01')?'year_clear':'expire',amount:lot.remaining,source_date:lot.date});lot.remaining=0}};
  for(const day of [...days].sort((a,b)=>a.date.localeCompare(b.date))){
    const period=day.date.slice(0,7),setting=settings[period],time=workTime(day.records || []),plan=day.plan,exception=day.exception || {};
    let month=months.get(period);if(!month){month={period,normal_days:Number(setting?.scheduled_days || 0),rest_allowance:Math.max(0,new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5)),0)).getUTCDate()-Number(setting?.scheduled_days || 0)),normal_rest_used:0,work_days:0,actual_work_days:0,credited:0,used:0,leave_days:0,absent_days:0,paid_days:0,pending_days:0,hours:0};months.set(period,month)}
    expireAt(day.date);
    const result={date:day.date,plan:plan?.type || '',hours:time.hours,work_days:0,leave_days:0,absent_days:0,banked:0,used:0,paid_days:0,status:'pending',note:exception.reason || plan?.reason || ''};
    const closed=day.date<today && day.date>=activeFrom;
    const hasHours=exception.hours!==null && exception.hours!==undefined;
    const hours=hasHours?Number(exception.hours):time.hours;
    const complete=hasHours || (time.hours!==null && !time.incomplete);
    const approvedLeave=exception.decision==='leave' || plan?.type==='leave' && !['absent','work'].includes(exception.decision);
    if(day.date>=today){result.status='planned';results.push(result);continue}
    if(complete && hours>0){
      // Formal staff receive a full day from six hours; short approved leave is
      // tracked separately, while part-time wages remain based on actual hours.
      const worked=partTime?Math.min(1,hours/8):units(hours);
      result.hours=hours;result.work_days=worked;month.hours=round(month.hours+hours);
      const missing=partTime?0:1-worked;
      if(missing && !approvedLeave && exception.decision!=='absent'){
        result.status='pending';result.note=result.note || '出勤不足，待人事确认请假或旷工';month.pending_days++;results.push(result);continue;
      }
      result.leave_days=approvedLeave?missing:0;result.absent_days=exception.decision==='absent'?missing:0;
      month.actual_work_days=round(month.actual_work_days+worked);
      let credit=0;
      if(!partTime && setting?.published_at){
        const officeExtra=day.office && ['rest','holiday'].includes(plan?.type);
        credit=officeExtra?worked:Math.max(0,month.work_days+worked-month.normal_days)-Math.max(0,month.work_days-month.normal_days);
        // Office rest-day credits do not use up normal working-day quota.
        if(!officeExtra)month.work_days=round(month.work_days+worked);
      }else month.work_days=round(month.work_days+worked);
      if(closed && credit>0){
        const lot={date:day.date,amount:round(credit),remaining:round(credit),expires_on:expiry(day.date)};lots.push(lot);
        events.push({key:`earn:${day.date}`,date:day.date,type:'earn',amount:lot.amount,source_date:day.date});result.banked=lot.amount;month.credited=round(month.credited+lot.amount);
      }
      result.paid_days=round(worked-(closed?credit:0));
      result.status=credit>0?'overtime':missing>0?'leave':'work';
      if(!partTime && hours>=6 && hours<8 && approvedLeave)result.note=(result.note?result.note+'；':'')+'请假早退，不扣计薪出勤';
    }else if(exception.decision==='absent'){
      result.absent_days=1;result.status='absent';
    }else if(approvedLeave){result.leave_days=1;result.status='leave'}
    else if(plan && ['rest','holiday','comp'].includes(plan.type) && !time.punch_count){
      const normal=plan.type==='comp'?0:Math.min(1,Math.max(0,month.rest_allowance-month.normal_rest_used));month.normal_rest_used=round(month.normal_rest_used+normal);
      let needed=round(1-normal);
      const available=lots.reduce((sum,lot)=>sum+lot.remaining,0);
      if(partTime || !closed){result.status='rest'}
      else if(needed>available || !setting?.published_at || plan.type!=='comp' && needed>0){result.status='pending';result.note='休息额度或存假不足，须确认请假或旷工';month.pending_days++}
      else{
        for(const lot of lots.filter(lot=>lot.remaining>0).sort((a,b)=>a.expires_on.localeCompare(b.expires_on) || a.date.localeCompare(b.date))){if(!needed)break;const used=Math.min(needed,lot.remaining);lot.remaining=round(lot.remaining-used);needed=round(needed-used);result.used=round(result.used+used);events.push({key:`use:${day.date}:${lot.date}`,date:day.date,type:'use',amount:used,source_date:lot.date})}
        result.status=plan.type==='comp'?'comp':'rest';result.paid_days=result.used;month.used=round(month.used+result.used);
      }
    }else {if(closed){month.pending_days++;result.note=result.note || '缺少排班或完整打卡，待核'}}
    month.leave_days=round(month.leave_days+result.leave_days);month.absent_days=round(month.absent_days+result.absent_days);month.paid_days=round(month.paid_days+result.paid_days);
    results.push(result);
  }
  expireAt(today);
  return {days:results,months:[...months.values()],lots,events,balance:round(lots.reduce((sum,lot)=>sum+lot.remaining,0)),as_of:today};
}
module.exports={settle,expiry,dateAdd,units};
