// Read-only presentation of actual punches; office schedules never fabricate attendance.
function workTime(records) {
  const punches=[...new Map(records.filter(row=>row.time_result!=='NotSigned').map(row=>[`${row.check_time}#${row.check_type}`,row])).values()].sort((a,b)=>String(a.check_time).localeCompare(String(b.check_time)));
  let open=null,hours=0,pairs=0,incomplete=false;
  for(const row of punches){
    const text=String(row.check_time || ''),timestamp=Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(text)?text:text.replace(' ','T')+'+08:00');
    if(!Number.isFinite(timestamp)){incomplete=true;continue}
    if(row.check_type==='OnDuty'){if(open!==null)incomplete=true;else open=timestamp}
    else if(row.check_type==='OffDuty'){if(open===null){incomplete=true;continue}const duration=(timestamp-open)/3600000;if(duration>0 && duration<=24){hours+=duration;pairs++}else incomplete=true;open=null}
  }
  if(open!==null)incomplete=true;
  return {hours:pairs?Math.round(hours*100)/100:null,incomplete,punch_count:punches.length};
}
function employeeCalendar({period,records,officeCalendar=[],today}) {
  const count=new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5)),0)).getUTCDate();
  const schedule=new Map(officeCalendar.map(day=>[day.date,day]));
  const grouped=new Map();for(const row of records){if(!grouped.has(row.work_date))grouped.set(row.work_date,[]);grouped.get(row.work_date).push(row)}
  const days=Array.from({length:count},(_,i)=>{
    const date=`${period}-${String(i+1).padStart(2,'0')}`,raw=grouped.get(date) || [],planned=schedule.get(date),time=workTime(raw);
    const status=time.punch_count?'attended':planned && ['rest','holiday'].includes(planned.type)?planned.type:date>today?'future':planned?.type==='work'?'missing':'unknown';
    return {date,status,planned_type:planned?.type || '',note:planned?.note || '',...time,records:raw};
  });
  return {days,summary:{attended_days:days.filter(day=>day.status==='attended').length,rest_days:days.filter(day=>['rest','holiday'].includes(day.status)).length,hours:Math.round(days.reduce((sum,day)=>sum+(day.hours || 0),0)*100)/100,incomplete_days:days.filter(day=>day.incomplete).length}};
}
// Display actual first clock-in / last clock-out, with paired duration excluding breaks.
function punchSummary(records){
  const time=workTime(records),valid=[...new Map(records.filter(row=>row.time_result!=='NotSigned').map(row=>[`${row.check_time}#${row.check_type}`,row])).values()].map(row=>{
    const text=String(row.check_time || ''),timestamp=Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(text)?text:text.replace(' ','T')+'+08:00');
    return {...row,timestamp};
  }).filter(row=>Number.isFinite(row.timestamp)).sort((a,b)=>a.timestamp-b.timestamp);
  const local=row=>row?new Date(row.timestamp+8*3600000).toISOString().slice(0,16).replace('T',' '):null;
  const segments=[];let open=null;
  for(const row of valid){
    if(row.check_type==='OnDuty'){if(!open)open=row;}
    else if(row.check_type==='OffDuty'){
      const duration=open?(row.timestamp-open.timestamp)/3600000:null;
      segments.push({start_time:local(open),end_time:local(row),hours:duration>0 && duration<=24?Math.round(duration*100)/100:null});open=null;
    }
  }
  if(open)segments.push({start_time:local(open),end_time:null,hours:null});
  return {...time,segments,start_time:local(valid.find(row=>row.check_type==='OnDuty')),end_time:local([...valid].reverse().find(row=>row.check_type==='OffDuty'))};
}
module.exports={employeeCalendar,workTime,punchSummary};
