'use strict';
function initialize(db) {
  db.run(`CREATE TABLE IF NOT EXISTS dingtalk_approval_instances (
    instance_id TEXT PRIMARY KEY, process_code TEXT NOT NULL, template_name TEXT NOT NULL,
    originator_user_id TEXT NOT NULL DEFAULT '', subject_user_ids TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '', leave_type TEXT NOT NULL DEFAULT '',
    start_time TEXT NOT NULL DEFAULT '', end_time TEXT NOT NULL DEFAULT '', duration TEXT NOT NULL DEFAULT '',
    duration_unit TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', finished_at TEXT NOT NULL DEFAULT '',
    source_data TEXT NOT NULL, synced_at TEXT NOT NULL)`);
  db.run('CREATE INDEX IF NOT EXISTS idx_dingtalk_approval_dates ON dingtalk_approval_instances(start_time,end_time)');
  db.run(`CREATE TABLE IF NOT EXISTS dingtalk_approval_sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,date_from TEXT,date_to TEXT,status TEXT,record_count INTEGER,
    message TEXT,created_at TEXT DEFAULT(datetime('now','localtime')))`);
  db.run('CREATE TABLE IF NOT EXISTS dingtalk_attendance_results (record_key TEXT PRIMARY KEY,employee_id INTEGER,dingtalk_user_id TEXT,work_date TEXT,check_type TEXT,time_result TEXT,plan_check_time TEXT,user_check_time TEXT,source_data TEXT,synced_at TEXT)');
  db.run('CREATE INDEX IF NOT EXISTS idx_dingtalk_results_employee_date ON dingtalk_attendance_results(employee_id,work_date)');
}
function parse(value) { if(typeof value!=='string')return value;try{return JSON.parse(value)}catch{return value} }
function local(value) {
  if(value===undefined || value===null || value==='')return '';
  if(typeof value==='number' || /^\d{13}$/.test(String(value)))return new Date(Number(value)+28800000).toISOString().slice(0,19).replace('T',' ');
  const text=String(value);
  if(/(Z|[+-]\d{2}:\d{2})$/.test(text) && Number.isFinite(Date.parse(text)))return new Date(Date.parse(text)+28800000).toISOString().slice(0,19).replace('T',' ');
  return text.replace('T',' ').slice(0,19);
}
function normalize(item,stamp) {
  const d=item.detail,fields=d.formComponentValues || [],byName=new Map(fields.map(f=>[f.name,f.value]));
  const holiday=fields.find(f=>f.componentType==='DDHolidayField');const values=holiday?parse(holiday.value):null;
  let start=byName.get('开始时间') || byName.get('补卡时间') || byName.get('repairCheckTime'),end=byName.get('结束时间'),type='',duration=byName.get('时长') || '',unit='';
  if(Array.isArray(values)){[start,end,duration,unit,type]=values;}
  const origin=String(d.originatorUserId || '');let subjects=[origin].filter(Boolean);
  const workers=parse(byName.get('加班人'));
  if(Array.isArray(workers)) {
    const ids=workers.map(x=>typeof x==='string'?x:x.userId || x.userid || x.emplId || '').filter(Boolean);
    if(ids.length)subjects=ids;
  }
  return {instance_id:item.instance_id,process_code:item.process_code,template_name:item.template_name,
    originator_user_id:origin,subject_user_ids:JSON.stringify([...new Set(subjects)]),status:d.status || '',result:d.result || '',
    leave_type:String(type || ''),start_time:local(start),end_time:local(end || start),duration:typeof duration==='object'?JSON.stringify(duration):String(duration || ''),duration_unit:String(unit || ''),
    created_at:local(d.createTime),finished_at:local(d.finishTime),source_data:JSON.stringify(d),synced_at:stamp};
}
function employeeApprovals(db,userId,from,to) {
  if(!userId)return [];
  return db.queryAll(`SELECT instance_id,template_name,subject_user_ids,status,result,leave_type,start_time,end_time,duration,duration_unit,created_at,finished_at,synced_at FROM dingtalk_approval_instances WHERE (substr(start_time,1,10)<=? AND substr(end_time,1,10)>=?) OR (start_time='' AND created_at>=? AND created_at<=?) ORDER BY start_time DESC`,[to,from,from+' 00:00:00',to+' 23:59:59'])
    .filter(x=>parse(x.subject_user_ids).includes(userId)).map(x=>{const {subject_user_ids,...row}=x;return {...row,effective:row.status==='COMPLETED' && row.result==='agree'}});
}
function dayMarkers({date,results=[],approvals=[],now=Date.now()}) {
  const markers=[];
  for(const r of results) {
    const label=({Late:'迟到',SeriousLate:'严重迟到',Early:'早退',NotSigned:'缺卡',Absenteeism:'旷工（钉钉）'})[r.time_result];
    if(!label)continue;
    const pending=r.time_result==='NotSigned' && Date.parse(String(r.plan_check_time).replace(' ','T')+'+08:00')>now;
    markers.push({label:pending?'待打卡':label,tone:pending?'neutral':'warning',source:'attendance'});
  }
  const items=approvals.filter(a=>a.start_time && a.start_time.slice(0,10)<=date && a.end_time.slice(0,10)>=date && !(a.start_time.slice(0,10)!==date && /^\d{4}-\d{2}-\d{2} 00:00(?::00)?$/.test(a.end_time) && a.end_time.slice(0,10)===date));
  for(const a of items) {
    const type=a.leave_type || a.template_name.replace(/申请$/,'');
    const state=a.status==='TERMINATED'?'已撤销':a.result==='refuse'?'已拒绝':a.effective?'已同意':'审批中';
    markers.push({label:type+' · '+state,tone:a.effective?(a.leave_type?'leave':'approved'):'neutral',source:'approval'});
  }
  return {markers:[...new Map(markers.map(x=>[x.label,x])).values()],approvals:items,results};
}
module.exports={initialize,normalize,employeeApprovals,dayMarkers};
