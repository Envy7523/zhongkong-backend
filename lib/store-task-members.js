'use strict';
const S=()=>require('./store-tasks'),now=()=>new Date().toISOString();
function initialize(db){
 db.run('CREATE TABLE IF NOT EXISTS store_task_memberships(template_id INTEGER,store_id INTEGER,removed_at TEXT,removed_by INTEGER,PRIMARY KEY(template_id,store_id))');
 db.run('CREATE TABLE IF NOT EXISTS store_task_membership_meta(key TEXT PRIMARY KEY)');
 if(db.queryOne("SELECT key FROM store_task_membership_meta WHERE key='legacy-v1'"))return;
 db.run(`INSERT OR IGNORE INTO store_task_memberships(template_id,store_id,removed_at)
 SELECT x.template_id,x.store_id,CASE WHEN NOT EXISTS(SELECT 1 FROM store_task_schedules p WHERE p.template_id=x.template_id AND p.store_id=x.store_id AND p.active=1)
 AND (SELECT MAX(stopped_at) FROM store_task_schedules p WHERE p.template_id=x.template_id AND p.store_id=x.store_id)>=COALESCE((SELECT MAX(created_at) FROM store_task_instances i WHERE i.template_id=x.template_id AND i.store_id=x.store_id),'')
 THEN (SELECT MAX(stopped_at) FROM store_task_schedules p WHERE p.template_id=x.template_id AND p.store_id=x.store_id) ELSE NULL END
 FROM (SELECT template_id,store_id FROM store_task_instances UNION SELECT template_id,store_id FROM store_task_schedules) x`);
 db.run("INSERT INTO store_task_membership_meta VALUES('legacy-v1')");
}
function register(db,template,stores){for(const id of stores)db.run('INSERT INTO store_task_memberships(template_id,store_id) VALUES(?,?) ON CONFLICT(template_id,store_id) DO UPDATE SET removed_at=NULL,removed_by=NULL',[template,id]);}
function summary(db,user,scope){S().requirePermission(user,'store-tasks.manage');const f=require('./personnel-access').sqlScope(scope,'m.store_id');return db.queryAll(`SELECT m.template_id,COUNT(*) count FROM store_task_memberships m JOIN stores s ON s.id=m.store_id WHERE m.removed_at IS NULL AND ${f.sql} GROUP BY m.template_id`,f.params);}
function nextRun(plan){for(let i=0;i<=31;i++){const day=S().shift(plan.next_date,i),d=new Date(day+'T00:00:00Z'),last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();if(plan.frequency==='daily'||plan.frequency==='weekly'&&(plan.weekday==null?(d-new Date(plan.start_date+'T00:00:00Z'))/86400000%7===0:d.getUTCDay()===plan.weekday)||plan.frequency==='monthly'&&d.getUTCDate()===Math.min(Number(plan.start_date.slice(8)),last))return day}return null;}
function list(db,template,user,scope){
 S().requirePermission(user,'store-tasks.manage');template=Number(template);
 if(!db.queryOne('SELECT id FROM store_task_templates WHERE id=?',[template]))throw Object.assign(new Error('任务表单不存在'),{status:404});
 const f=require('./personnel-access').sqlScope(scope,'m.store_id');
 return db.queryAll(`SELECT m.store_id,s.store_name FROM store_task_memberships m JOIN stores s ON s.id=m.store_id WHERE m.template_id=? AND m.removed_at IS NULL AND ${f.sql} ORDER BY s.store_name`,[template,...f.params]).map(row=>{
  const plan=db.queryOne('SELECT id,frequency,start_date,next_date,due_time,opens_time,weekday FROM store_task_schedules WHERE template_id=? AND store_id=? AND active=1 ORDER BY id DESC LIMIT 1',[template,row.store_id]);
  if(plan)plan.next_date=nextRun(plan);
  const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  const task=db.queryOne('SELECT * FROM store_task_instances WHERE template_id=? AND store_id=? ORDER BY CASE WHEN business_date<=? THEN 0 ELSE 1 END,CASE WHEN business_date<=? THEN business_date END DESC,business_date ASC,id DESC LIMIT 1',[template,row.store_id,today,today]);
  const execution=task?S().executionState(db,task):null;
  return {...row,plan,task_id:task?.id||null,business_date:task?.business_date||null,task_kind:task?.task_kind||'routine',status:task?(['missed','forfeited','blocked','not_started'].includes(execution.phase)?execution.phase:task.status):'scheduled',execution_reason:execution?.reason||'',due_at:task?.due_at||null};
 });
}
function remove(db,template,store,user,scope){
 S().requirePermission(user,'store-tasks.manage');template=Number(template);store=Number(store);S().scopeCheck(scope,store);
 const member=db.queryOne('SELECT * FROM store_task_memberships WHERE template_id=? AND store_id=?',[template,store]);
 if(!member)throw Object.assign(new Error('该门店未参与此任务'),{status:404});
 db.run('BEGIN');try{const at=now();db.run('UPDATE store_task_memberships SET removed_at=COALESCE(removed_at,?),removed_by=COALESCE(removed_by,?) WHERE template_id=? AND store_id=?',[at,user.id,template,store]);db.run('UPDATE store_task_schedules SET active=0,stopped_at=? WHERE template_id=? AND store_id=? AND active=1',[at,template,store]);db.run('COMMIT')}catch(e){db.run('ROLLBACK');throw e}db.save();return {template_id:template,store_id:store};
}
module.exports={initialize,register,summary,list,remove,nextRun};
