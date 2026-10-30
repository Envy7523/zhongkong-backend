'use strict';
const access=require('./personnel-access'),context=require('./employee-mini-context');
const ASSIGN='mini-duty.assign';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const today=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
const rights=user=>user?.position_permissions||[];
const can=(user,code)=>rights(user).some(p=>p==='*'||p===code);
function initialize(db){
 db.run('CREATE TABLE IF NOT EXISTS store_task_duties(store_id INTEGER,business_date TEXT,user_id INTEGER,user_name TEXT,version INTEGER NOT NULL,assigned_by INTEGER,assigned_name TEXT,assigned_at TEXT,confirmed_at TEXT,PRIMARY KEY(store_id,business_date))');
 db.run('CREATE TABLE IF NOT EXISTS store_task_duty_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,store_id INTEGER,business_date TEXT,actor_id INTEGER,actor_name TEXT,action TEXT,reason TEXT,before_json TEXT,after_json TEXT,created_at TEXT)');
 db.run('CREATE TABLE IF NOT EXISTS store_task_submission_duties(submission_id INTEGER PRIMARY KEY,duty_json TEXT NOT NULL)');
 db.run('CREATE TABLE IF NOT EXISTS store_task_duty_migrations(key TEXT PRIMARY KEY,created_at TEXT)');
}
function initialGrants(db){
 require('./store-manager-identity').initialize(db);
 if(db.queryOne("SELECT key FROM store_task_duty_migrations WHERE key='initial-permissions-v1'"))return;
 for(const p of access.positions(db).filter(p=>/店长|督导/.test(p.name)&&!/储备/.test(p.name))){
  if(!p.permissions.includes('*')&&!p.permissions.includes(ASSIGN)){
   db.run('UPDATE position_settings SET permissions_json=? WHERE id=?',[JSON.stringify([...p.permissions,ASSIGN]),p.id]);
   db.run('INSERT INTO access_change_logs(user_id,actor_id,action,reason,before_json,after_json,created_at) VALUES(NULL,NULL,?,?,?,?,?)',['duty.initial-grant','首次启用：管理员、店长、督导开放小程序指定当班人',JSON.stringify({position_id:p.id,permissions:p.permissions}),JSON.stringify({position_id:p.id,permissions:[...p.permissions,ASSIGN]}),new Date().toISOString()]);
  }
 }
 // A one-time grant: later manual revocation must survive service restarts.
 db.run('INSERT INTO store_task_duty_migrations VALUES(?,?)',['initial-permissions-v1',new Date().toISOString()]);
}
function date(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value||'')||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)fail('请选择有效日期');return value;}
function scope(db,user,code){
 let configured;try{configured=access.effective(db,user.id,'mini',code)}catch(e){if(!/no such table/.test(e.message))throw e;}if(configured!==undefined)return context.extend(db,user,configured,code);
 if(!can(user,code))return [];
 if(can(user,'*'))return null;
 return context.extend(db,user,user.store_id?[Number(user.store_id)]:[],code);
}
function managerScope(db,user){
 if(context.departed(context.employee(db,user)))return [];
 if(can(user,'*'))return null;
 try{return scopedManager(db,user);}catch(e){if(/no such table/.test(e.message))return [];throw e;}
}
function scopedManager(db,user){
 const configured=access.config(db,user.id),positions=access.positions(db);
 const assigned=configured?.assignments||db.queryAll('SELECT position_id FROM user_positions WHERE user_id=?',[user.id]).map(p=>({...p,mode:'stores',store_ids:user.store_id?[Number(user.store_id)]:[],region_ids:[]}));
 return access.union(assigned.flatMap(a=>{
  const p=positions.find(p=>p.id===a.position_id);
  if(!require('./store-manager-identity').formal(p)||!p.channels.includes('mini')||configured&&!configured.channels.includes('mini'))return [];
  return [access.intersect(access.scopeIds(db,a),access.scopeIds(db,p))];
 }));
}
function loadUser(db,id){const row=db.queryOne('SELECT * FROM users WHERE id=?',[id]);return row?require('./user-positions').enrich(db,row,'mini'):null;}
function row(db,storeId,day){return db.queryOne('SELECT * FROM store_task_duties WHERE store_id=? AND business_date=?',[Number(storeId),day]);}
function employeePositions(db,employee){try{return [...new Set([employee.position,...db.queryAll('SELECT position FROM employee_positions WHERE employee_id=?',[employee.id]).map(p=>p.position)].filter(Boolean))]}catch(e){if(/no such table/.test(e.message))return [employee.position].filter(Boolean);throw e;}}
function rosterMember(db,employee,storeId,day=today()){if(!context.active(employee)||!context.active(employee,day)||Number(employee.store_id)!==Number(storeId)&&!context.dispatches(db,employee,day).some(d=>Number(d.support_store_id)===Number(storeId))&&Number(require('./staff-training').at(db,employee?.id,day)?.training_store_id)!==Number(storeId))return false;const positions=employeePositions(db,employee);return require('./staff-training').trainee(employee)||positions.some(p=>/储备/.test(p))||(employee.role==='店员'&&!positions.some(p=>/店长|门店经理|督导/.test(p)));}
function linkedEmployee(db,user){if(!user)return null;try{const id=access.config(db,user.id)?.employee_id||user.employee_id;return id?db.queryOne('SELECT * FROM employees WHERE id=?',[Number(id)]):null}catch(e){if(/no such table/.test(e.message))return null;throw e;}}
function eligible(db,user,storeId,day=today()){return !!user&&rosterMember(db,linkedEmployee(db,user),storeId,day)&&((!user.access_configured||user.access_channels.includes('mini'))&&(access.allows(context.extend(db,user,scope(db,user,'store-tasks.execute'),'store-tasks.execute',day),storeId)||access.allows(managerScope(db,user),storeId)));}
function managers(db,storeId){try{return db.queryAll('SELECT id FROM users').map(r=>loadUser(db,r.id)).filter(u=>u&&!can(u,'*')&&access.allows(managerScope(db,u),storeId)).map(u=>({id:u.id,name:u.display_name||u.username}));}catch(e){if(/no such table/.test(e.message))return [];throw e;}}
function state(db,storeId,day,user){
 const duty=row(db,storeId,day),selected=duty?loadUser(db,duty.user_id):null,valid=eligible(db,selected,storeId,day);
 const isManager=access.allows(managerScope(db,user),storeId);
 const confirmed=!!duty?.confirmed_at&&valid;
 return {store_id:Number(storeId),business_date:day,version:duty?.version||0,managers:managers(db,storeId),assigned:duty?{id:duty.user_id,name:duty.user_name,status:!valid?'unavailable':confirmed?'confirmed':'pending',assigned_by:duty.assigned_name,assigned_at:duty.assigned_at,confirmed_at:duty.confirmed_at}:null,
  can_assign:can(user,ASSIGN)&&access.allows(scope(db,user,ASSIGN),storeId),
  can_confirm:!!duty&&duty.user_id===user.id&&!duty.confirmed_at&&valid&&day===today(),
  can_submit:isManager||confirmed&&day===today()&&duty.user_id===user.id};
}
function requireSubmit(db,task,user){const day=task.task_kind==='windowed'||task.execution?.reopened?today():task.business_date;const result=state(db,task.store_id,day,user);if(!result.can_submit)fail('请由店长或已确认的当班负责人提交整份任务',403);return result;}
function candidateRoster(db,storeId,user,day=today()){date(day);if(!can(user,ASSIGN)||!access.allows(scope(db,user,ASSIGN),storeId))fail('没有指定当班人权限',403);const users=db.queryAll('SELECT id FROM users').map(r=>loadUser(db,r.id));let employees=[];try{employees=db.queryAll('SELECT * FROM employees ORDER BY name,id').filter(e=>rosterMember(db,e,storeId,day))}catch(e){if(!/no such table/.test(e.message))throw e;}
 return employees.map(employee=>{const linked=users.filter(u=>Number(access.config(db,u.id)?.employee_id||u.employee_id)===employee.id),account=linked.length===1?linked[0]:null,ready=!!account&&eligible(db,account,storeId,day);const unavailable_reason=linked.length>1?'关联了多个账号，请管理员核查':!account?'尚未关联小程序账号':account.access_configured&&!account.access_channels.includes('mini')?'尚未开放小程序登录':'尚未开放本店任务权限';return {id:ready?account.id:null,employee_id:employee.id,name:employee.name,positions:employeePositions(db,employee),source:Number(employee.store_id)===Number(storeId)?'本店':require('./staff-training').at(db,employee.id,day)?'外派培训':'当日支援',home_store_id:employee.store_id,can_select:ready,...(!ready?{unavailable_reason}:{})};});
}
function candidates(db,storeId,user){return candidateRoster(db,storeId,user).filter(p=>p.can_select)}
function transact(db,fn){db.run('BEGIN');try{const result=fn();db.run('COMMIT');db.save();return result}catch(e){db.run('ROLLBACK');throw e;}}
function log(db,user,action,reason,before,after){db.insert('INSERT INTO store_task_duty_logs(store_id,business_date,actor_id,actor_name,action,reason,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',[after.store_id,after.business_date,user.id,user.display_name||user.username,action,reason,JSON.stringify(before),JSON.stringify(after),new Date().toISOString()]);}
function assign(db,body,user){
 const storeId=Number(body.store_id),day=date(body.business_date);
 if(!Number.isInteger(storeId)||!db.queryOne('SELECT id FROM stores WHERE id=?',[storeId]))fail('门店不存在');
 if(!can(user,ASSIGN)||!access.allows(scope(db,user,ASSIGN),storeId))fail('没有此门店指定当班人的权限',403);
 if(day<today())fail('不能改派过去日期的当班人');
 const before=row(db,storeId,day);
 if(Number(body.version)!==Number(before?.version||0))fail('当班安排已更新，请刷新后重试',409);
 const reason=String(body.reason||'').trim();if(reason.length>500||before&&!reason)fail('换人必须填写交接原因，最多500字');
 if(before?.user_id===Number(body.user_id))fail('此人员已是当班负责人');
 const person=loadUser(db,Number(body.user_id));if(!eligible(db,person,storeId,day))fail('请选择本店或当日有效支援的在职店员、储备干部，并先开通小程序任务权限');
 const next={store_id:storeId,business_date:day,user_id:person.id,user_name:person.display_name||person.username,version:(before?.version||0)+1,assigned_by:user.id,assigned_name:user.display_name||user.username,assigned_at:new Date().toISOString(),confirmed_at:null};
 return transact(db,()=>{db.run('INSERT INTO store_task_duties(store_id,business_date,user_id,user_name,version,assigned_by,assigned_name,assigned_at,confirmed_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(store_id,business_date) DO UPDATE SET user_id=excluded.user_id,user_name=excluded.user_name,version=excluded.version,assigned_by=excluded.assigned_by,assigned_name=excluded.assigned_name,assigned_at=excluded.assigned_at,confirmed_at=NULL',Object.values(next));log(db,user,before?'handoff':'assign',reason||'指定当班负责人',before,next);return state(db,storeId,day,user);});
}
function confirm(db,body,user){
 const day=date(body.business_date),storeId=Number(body.store_id),before=row(db,storeId,day);
 if(!before||before.user_id!==user.id)fail('只能本人确认接班',403);
 if(day!==today())fail('请在当班当天确认接班');
 if(Number(body.version)!==before.version)fail('当班安排已更新，请刷新后重试',409);
 if(!eligible(db,user,storeId,day))fail('已无本店任务权限，不能确认接班',403);
 if(before.confirmed_at)return state(db,storeId,day,user);
 const next={...before,confirmed_at:new Date().toISOString(),version:before.version+1};
 return transact(db,()=>{db.run('UPDATE store_task_duties SET confirmed_at=?,version=? WHERE store_id=? AND business_date=?',[next.confirmed_at,next.version,storeId,day]);log(db,user,'confirm','本人确认接班',before,next);return state(db,storeId,day,user);});
}
function history(db,storeId,day){return db.queryAll('SELECT actor_name,action,reason,created_at,after_json FROM store_task_duty_logs WHERE store_id=? AND business_date=? ORDER BY id DESC LIMIT 30',[storeId,day]).map(r=>({...r,person_name:JSON.parse(r.after_json).user_name,after_json:undefined}));}
module.exports={managers,ASSIGN,initialize,initialGrants,today,date,scope,managerScope,state,requireSubmit,candidates,candidateRoster,assign,confirm,history};
