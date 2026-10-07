'use strict';
const {punchSummary}=require('./attendance-calendar');
const {dateAdd}=require('./roster-balance');
const ding=require('./dingtalk-attendance');
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
function initialize(db){
  db.run(`CREATE TABLE IF NOT EXISTS dingtalk_schedule_days(employee_id INTEGER NOT NULL,work_date TEXT NOT NULL,dingtalk_user_id TEXT NOT NULL,plan_json TEXT NOT NULL,synced_at TEXT NOT NULL,PRIMARY KEY(employee_id,work_date))`);
  db.run(`CREATE TABLE IF NOT EXISTS dingtalk_schedule_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,date_from TEXT,date_to TEXT,status TEXT,employee_count INTEGER,record_count INTEGER,message TEXT,created_at TEXT DEFAULT(datetime('now','localtime')))`);
}
function local(value){if(typeof value==='number')return new Date(value+28800000).toISOString().slice(0,19).replace('T',' ');return String(value || '').trim()}
function normalize(rows,date){
  const rest=rows.some(r=>r.is_rest==='Y'),work=rows.some(r=>r.is_rest==='N');
  const unknown=rows.some(r=>!['Y','N'].includes(r.is_rest));
  const approved=rows.some(r=>r.approve_id);
  const punches=rows.filter(r=>r.is_rest==='N' && r.plan_check_time).map(r=>({check_time:local(r.plan_check_time),check_type:r.check_type}));
  const segments=punchSummary(punches).segments;
  const type=unknown || rest&&work?'unassigned':work?'work':rest?'rest':'unassigned';
  const pending=type==='unassigned' || approved || type==='work' && (!segments.length || segments.some(s=>!s.start_time || !s.end_time));
  return {date,type,source:'dingtalk',pending,segments,reason:rest&&work?'钉钉同时返回休息和出勤节点，待核':approved?'含审批关联，请假或调休待核':unknown?'排班状态待核':!rows.length?'未获取排班':pending?'班次不完整，待核':'',raw:rows};
}
function plans(db,id,from,to){return new Map(db.queryAll('SELECT d.work_date,d.plan_json FROM dingtalk_schedule_days d JOIN employees e ON e.id=d.employee_id AND e.dingtalk_user_id=d.dingtalk_user_id WHERE d.employee_id=? AND d.work_date>=? AND d.work_date<=?',[id,from,to]).map(r=>[r.work_date,JSON.parse(r.plan_json)]))}
function service(db,{fetchSchedules=ding.fetchSchedules,clock=today}={}){
  let running=null;
  async function execute(from,to,employeeIds){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || from>to || dateAdd(from,62)<to)throw Error('排班同步范围须在 63 天以内');
    const mapped=db.queryAll("SELECT id,dingtalk_user_id FROM employees WHERE TRIM(COALESCE(dingtalk_user_id,''))<>''").filter(r=>!employeeIds || employeeIds.includes(r.id));
    if(!mapped.length)throw Error('暂无已绑定钉钉 ID 的员工');
    if(new Set(mapped.map(r=>r.dingtalk_user_id)).size!==mapped.length)throw Error('钉钉员工 ID 重复绑定，请先修正员工档案');
    const operator=process.env.DINGTALK_SCHEDULE_OPERATOR_ID || mapped[0].dingtalk_user_id;
    const result=[],stamp=new Date().toISOString();let count=0;
    for(let day=from;day<=to;day=dateAdd(day,1))for(let start=0;start<mapped.length;start+=50){
      const chunk=mapped.slice(start,start+50),ids=chunk.map(r=>r.dingtalk_user_id);
      const rows=await fetchSchedules({userIds:ids,dateFrom:day,dateTo:day,operatorId:operator});
      if(!Array.isArray(rows) || rows.some(r=>!ids.includes(String(r.userid)) || local(r.work_date).slice(0,10)!==day))throw Error('钉钉返回了范围外排班，保留原数据');
      count+=rows.length;
      for(const person of chunk)result.push({id:person.id,userid:person.dingtalk_user_id,day,plan:normalize(rows.filter(r=>r.userid===person.dingtalk_user_id),day)});
    }
    db.run('BEGIN');try{
      for(const item of result)db.run(`INSERT INTO dingtalk_schedule_days VALUES(?,?,?,?,?) ON CONFLICT(employee_id,work_date) DO UPDATE SET dingtalk_user_id=excluded.dingtalk_user_id,plan_json=excluded.plan_json,synced_at=excluded.synced_at`,[item.id,item.day,item.userid,JSON.stringify(item.plan),stamp]);
      db.run("INSERT INTO dingtalk_schedule_runs(date_from,date_to,status,employee_count,record_count,message) VALUES(?,?,'success',?,?,?)",[from,to,mapped.length,count,'钉钉排班已同步']);db.run('COMMIT');db.save();
    }catch(error){db.run('ROLLBACK');throw error}
    return {date_from:from,date_to:to,employee_count:mapped.length,record_count:count,synced_at:stamp};
  }
  function sync({from,to,employeeIds}={}){
    if(running)throw Error('排班正在同步，请稍后刷新');
    running=execute(from,to,employeeIds).catch(error=>{db.run("INSERT INTO dingtalk_schedule_runs(date_from,date_to,status,message) VALUES(?,?,'failed',?)",[from,to,String(error.message).replace(/https?:\/\/\S+/g,'').slice(0,500)]);db.save();throw error}).finally(()=>{running=null});return running;
  }
  const status=()=>({running:!!running,latest:db.queryOne('SELECT * FROM dingtalk_schedule_runs ORDER BY id DESC LIMIT 1'),configured:ding.getDingTalkConfig().configured});
  async function automatic(){
    if(running || !ding.getDingTalkConfig().configured)return;
    const total=db.queryOne("SELECT COUNT(*) n FROM employees WHERE TRIM(COALESCE(dingtalk_user_id,''))<>''").n;
    const last=db.queryOne("SELECT * FROM dingtalk_schedule_runs WHERE status='success' AND employee_count=? AND date_to>=? AND date_from<=? ORDER BY id DESC LIMIT 1",[total,clock(),dateAdd(clock(),-7)]);
    if(last && Date.now()-Date.parse(last.created_at.replace(' ','T')+'+08:00')<6*3600000)return;
    const now=clock(),first=last?dateAdd(now,-7):dateAdd(now.slice(0,7)+'-01',-1).slice(0,7)+'-01';
    await sync({from:first,to:dateAdd(now,14)});
  }
  function start(){const tick=()=>automatic().catch(e=>console.warn('[dingtalk-schedule] '+String(e.message).replace(/https?:\/\/\S+/g,'')));setTimeout(tick,15000).unref?.();const timer=setInterval(tick,6*3600000);timer.unref?.();return timer}
  return {sync,status,start};
}
module.exports={initialize,normalize,plans,service};
