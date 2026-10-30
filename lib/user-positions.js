const {normalizePermissions}=require('./permissions');
function initialize(db){
 db.run('CREATE TABLE IF NOT EXISTS user_positions (user_id INTEGER NOT NULL,position_id INTEGER NOT NULL,PRIMARY KEY(user_id,position_id))');
 db.run('INSERT OR IGNORE INTO user_positions SELECT id,position_id FROM users WHERE position_id IS NOT NULL');
}
function enrich(db,user,channel='web'){
 if(!user)return user;
 let roles=[];
 try{roles=db.queryAll('SELECT p.id,p.name,p.permissions_json FROM position_settings p JOIN user_positions up ON up.position_id=p.id WHERE up.user_id=? ORDER BY p.id',[user.id]);}catch(e){if(!/no such table/.test(e.message))throw e;}
 if(!roles.length && user.position_id)roles=[{id:user.position_id,name:user.position_name || user.role,permissions_json:user.permissions_json}];
 const access=require('./personnel-access');
 let configured;try{configured=access.config(db,user.id)}catch(e){if(!/no such table/.test(e.message))throw e}
 if(configured)roles.sort((a,b)=>Number(configured.assignments.find(p=>p.position_id===b.id)?.is_primary)-Number(configured.assignments.find(p=>p.position_id===a.id)?.is_primary));
 const channelPolicy=require('./channel-permissions');let ps;try{ps=access.positions(db).filter(p=>roles.some(r=>r.id===p.id))}catch(e){if(!/no such table|no such column: is_system/.test(e.message))throw e;ps=roles.map(p=>({...p,permissions:normalizePermissions(p.permissions_json),enabled:true,channels:['web','mini']}))}const legacyPermissions=ps.filter(p=>!p.channel_permissions).flatMap(p=>channelPolicy.forPosition(p,channel));
 const permissions=configured?access.permissions(db,user.id,channel):[...new Set(roles.length?ps.flatMap(p=>channelPolicy.forPosition(p,channel)):normalizePermissions(user.permissions_json))];
 return {...user,legacy_position_permissions:[...new Set(legacyPermissions)],permission_channel:channel,access_configured:!!configured,access_channels:configured?.channels,primary_position_id:configured?.assignments.find(a=>a.is_primary)?.position_id||user.position_id,position_ids:roles.map(p=>p.id),position_names:roles.map(p=>p.name),role:roles.map(p=>p.name).join('、') || user.role,position_name:roles.map(p=>p.name).join('、') || user.position_name,permissions_json:JSON.stringify([...new Set([...permissions,...require('./common-capabilities').forUser(user,permissions)])]),position_permissions:[...new Set([...permissions,...require('./common-capabilities').forUser(user,permissions)])]};
}
function selected(db,value){
 if(!Array.isArray(value) || !value.length || value.length>10)throw Error('请选择1至10个岗位');
 const ids=[...new Set(value.map(Number))];if(ids.some(id=>!Number.isInteger(id)||id<=0))throw Error('岗位无效');
 return ids.map(id=>{const role=db.queryOne('SELECT id,name,permissions_json FROM position_settings WHERE id=?',[id]);if(!role)throw Error('所选岗位不存在');return role;});
}
function assign(db,userId,roles){const user=db.queryOne('SELECT * FROM users WHERE id=?',[userId]);require('./store-manager-uniqueness').assertPerson(db,user,require('./personnel-access').config(db,userId)||require('./store-manager-uniqueness').legacyConfig(db,user,roles));db.run('DELETE FROM user_positions WHERE user_id=?',[userId]);for(const role of roles)db.run('INSERT INTO user_positions VALUES(?,?)',[userId,role.id]);}
function ownOnly(permissions){return permissions.includes('staff.store.edit') && !permissions.some(p=>['*','staff.view','payroll.attendance','payroll.review'].includes(p));}
module.exports={initialize,enrich,selected,assign,ownOnly};
