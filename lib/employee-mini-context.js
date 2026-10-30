'use strict';
const access=require('./personnel-access');
const today=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
function optional(fn,fallback){try{return fn()}catch(e){if(/no such table/.test(e.message))return fallback;throw e}}
function employee(db,user){if(!user)return null;const id=optional(()=>access.config(db,user.id)?.employee_id,null)||user.employee_id;return id?optional(()=>db.queryOne('SELECT * FROM employees WHERE id=?',[Number(id)]),null):null}
function active(e,day=today()){return !!e&&e.status==='在职'&&!/未入职|待入职|取消/.test(e.onboarding_status||'')&&(!e.leave_date||e.leave_date>day)}
function departed(e){return !!e&&(e.status==='离职'||e.onboarding_status==='离职'||!!e.leave_date&&e.leave_date<=today())}
function assertAccount(db,user){if(departed(employee(db,user)))throw Object.assign(new Error('员工已离职，登录已停用；历史档案保留'),{status:403})}
function dispatches(db,e,day=today()){
 if(!active(e)||!active(e,day))return [];
 return optional(()=>db.queryAll("SELECT * FROM employee_store_dispatches WHERE employee_id=? AND status='有效'",[e.id]),[]).filter(d=>{
  if(d.dispatch_mode==='selected'){try{return JSON.parse(d.dispatch_dates_json||'[]').includes(day)}catch{return false}}
  return !!d.start_date&&!!d.end_date&&d.start_date<=day&&d.end_date>=day;
 });
}
function supportIds(db,user,day=today()){return [...new Set(dispatches(db,employee(db,user),day).map(d=>Number(d.support_store_id)))]}
// Temporary scope never grants a new function or financial/management authority.
function extend(db,user,base,permission,day=today()){
 if(!['store-tasks.execute','learning.view',null,undefined].includes(permission))return base;
 if(user.access_configured&&!user.access_channels?.includes('mini'))return base;
 const rights=user.position_permissions||[];
 if(!rights.includes('*')&&!rights.includes(permission||'store-tasks.execute')&&!(permission==null&&rights.includes('learning.view')))return base;
 const training=require('./staff-training').at(db,employee(db,user)?.id,day),ids=[...supportIds(db,user,day),...(training?[training.training_store_id]:[])];return ids.length?access.union([base===null?null:Array.isArray(base)?base:base>0?[base]:[],ids]):base;
}
module.exports={today,employee,active,departed,assertAccount,dispatches,supportIds,extend};
