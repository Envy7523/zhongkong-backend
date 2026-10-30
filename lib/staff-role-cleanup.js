'use strict';
const A=require('./personnel-access'),R=require('./staff-role-presets'),crypto=require('crypto');
// Only known retired aliases are merged; interface and custom roles are excluded.
function protectedState(db){const u=db.queryOne("SELECT * FROM users WHERE username='syncbot_importer'");if(!u)return null;return crypto.createHash('sha256').update(JSON.stringify({user:u,role:db.queryOne('SELECT * FROM position_settings WHERE id=?',[u.position_id]),user_positions:db.queryAll('SELECT * FROM user_positions WHERE user_id=?',[u.id]),person:A.config(db,u.id),role_config:db.queryOne('SELECT * FROM access_position_config WHERE position_id=?',[u.position_id])})).digest('hex')}
function mergeLegacy(db,actor=null){
 if(!R.managed(db))throw Error('请先建立统一岗位');
 const before=protectedState(db),ps=A.positions(db),pairs=ps.filter(p=>!p.template_key&&!p.merged_into).flatMap(p=>{const spec=R.specs.find(s=>s.name!==p.name&&s.aliases.includes(p.name));return spec?[{p,target:ps.find(t=>t.template_key===spec.key)}]:[]});
 if(pairs.some(x=>!x.target?.enabled))throw Error('统一岗位缺失或未启用');
 const mapping=new Map(pairs.map(x=>[x.p.id,x.target.id])),changed=[];
 db.run('BEGIN');try{
  for(const u of db.queryAll('SELECT * FROM users')){
   const cfg=A.config(db,u.id),links=db.queryAll('SELECT position_id FROM user_positions WHERE user_id=?',[u.id]);
   if(!mapping.has(u.position_id)&&!links.some(a=>mapping.has(a.position_id))&&!cfg?.assignments.some(a=>mapping.has(a.position_id)))continue;
   if(u.username==='syncbot_importer')throw Error('禁止修改AI导入账号');
   const old=cfg||require('./store-manager-uniqueness').legacyConfig(db,u,links.map(a=>ps.find(p=>p.id===a.position_id))),assignments=old.assignments.map(a=>({...a,position_id:mapping.get(a.position_id)||a.position_id}));
   if(new Set(assignments.map(a=>a.position_id)).size!==assignments.length)throw Error(u.display_name+'归并后岗位重复，请先核对范围');
   const prepared=A.preparePerson(db,u.id,{...old,assignments});A.writePerson(db,u.id,prepared.next,prepared.ps,cfg,actor,'旧岗位归并，保留账号负责范围与登录端，按统一岗位权限执行');changed.push({user_id:u.id,name:u.display_name});
  }
  for(const {p,target}of pairs){const row=db.queryOne('SELECT config_json FROM access_position_config WHERE position_id=?',[p.id]),cfg=row?JSON.parse(row.config_json):{category:p.category,channels:p.channels,mode:p.mode,store_ids:p.store_ids,region_ids:p.region_ids};const next={...cfg,enabled:false,merged_into:target.id,policy_version:(cfg.policy_version||0)+1};db.run('INSERT INTO access_position_config VALUES(?,?) ON CONFLICT(position_id) DO UPDATE SET config_json=excluded.config_json',[p.id,JSON.stringify(next)]);A.log(db,null,actor,'role.merge-legacy','统一岗位，历史记录保留',p,{position_id:p.id,...next});}
  if(db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='staff_onboarding_meta'")){const staff=ps.find(p=>p.template_key==='staff');db.run("INSERT INTO staff_onboarding_meta VALUES('base-position',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[String(staff.id)]);}
  if(protectedState(db)!==before)throw Error('AI导入账号保护校验失败');
  db.run('COMMIT');db.save();return {merged:pairs.map(({p,target})=>({id:p.id,name:p.name,target_id:target.id,target_name:target.name})),users:changed,protected_fingerprint:before};
 }catch(e){db.run('ROLLBACK');throw e}
}
module.exports={mergeLegacy,protectedState};
