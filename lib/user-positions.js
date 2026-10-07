const {normalizePermissions}=require('./permissions');
function initialize(db){
 db.run('CREATE TABLE IF NOT EXISTS user_positions (user_id INTEGER NOT NULL,position_id INTEGER NOT NULL,PRIMARY KEY(user_id,position_id))');
 db.run('INSERT OR IGNORE INTO user_positions SELECT id,position_id FROM users WHERE position_id IS NOT NULL');
}
function enrich(db,user){
 if(!user)return user;
 let roles=[];
 try{roles=db.queryAll('SELECT p.id,p.name,p.permissions_json FROM position_settings p JOIN user_positions up ON up.position_id=p.id WHERE up.user_id=? ORDER BY p.id',[user.id]);}catch(e){if(!/no such table/.test(e.message))throw e;}
 if(!roles.length && user.position_id)roles=[{id:user.position_id,name:user.position_name || user.role,permissions_json:user.permissions_json}];
 const permissions=[...new Set(roles.length?roles.flatMap(p=>normalizePermissions(p.permissions_json)):normalizePermissions(user.permissions_json))];
 return {...user,position_ids:roles.map(p=>p.id),position_names:roles.map(p=>p.name),role:roles.map(p=>p.name).join('、') || user.role,position_name:roles.map(p=>p.name).join('、') || user.position_name,permissions_json:JSON.stringify(permissions),position_permissions:permissions};
}
function selected(db,value){
 if(!Array.isArray(value) || !value.length || value.length>10)throw Error('请选择1至10个岗位');
 const ids=[...new Set(value.map(Number))];if(ids.some(id=>!Number.isInteger(id)||id<=0))throw Error('岗位无效');
 return ids.map(id=>{const role=db.queryOne('SELECT id,name,permissions_json FROM position_settings WHERE id=?',[id]);if(!role)throw Error('所选岗位不存在');return role;});
}
function assign(db,userId,roles){db.run('DELETE FROM user_positions WHERE user_id=?',[userId]);for(const role of roles)db.run('INSERT INTO user_positions VALUES(?,?)',[userId,role.id]);}
function ownOnly(permissions){return permissions.includes('staff.store.edit') && !permissions.some(p=>['*','staff.view','payroll.attendance','payroll.review'].includes(p));}
module.exports={initialize,enrich,selected,assign,ownOnly};
