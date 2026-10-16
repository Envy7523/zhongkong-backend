'use strict';
const crypto = require('crypto');
const A = require('./personnel-access');
const U = require('./store-manager-uniqueness');
const {mobile} = require('./personnel-profile-fields');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const profileFields = ['username', 'display_name', 'phone'];
const profile = user => Object.fromEntries(profileFields.map(k => [k, user[k] || '']));
const profileVersion = user => hash({...profile(user), avatar_url: user.avatar_url || ''});

function directory(db) {
  const raw = db.queryAll('SELECT * FROM users'), ps = A.positions(db);
  const identities = db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='mp_identities'")
    ? new Set(db.queryAll("SELECT DISTINCT user_id FROM mp_identities WHERE identity_type='openid' AND status='active'").map(r=>r.user_id)) : null;
  const employees = db.queryAll('SELECT * FROM employees').map(e => ({
    id:e.id, name:e.name, position:e.position, store_id:e.store_id, store_name:e.store_name, status:e.status,
    linked_user_id: raw.find(u => Number(A.config(db,u.id)?.employee_id || u.employee_id) === e.id)?.id || null,
  }));
  return {
    positions:ps,
    stores:db.queryAll('SELECT * FROM stores').map(s => ({id:s.id,store_name:s.store_name,status:s.status})),
    regions:db.queryAll('SELECT id,name,parent_id FROM store_regions').map(r => ({...r,store_ids:A.scopeIds(db,{mode:'regions',region_ids:[r.id]})})),
    employees,
    users:raw.map(u => {
      const access = A.config(db,u.id), employee_id = access?.employee_id || u.employee_id || null;
      return {id:u.id,...profile(u),avatar_url:u.avatar_url || '',store_id:u.store_id,position_id:u.position_id,
        position_ids:db.queryAll('SELECT position_id FROM user_positions WHERE user_id=?',[u.id]).map(r=>r.position_id),
        access,employee_id,employment_status:employees.find(e=>e.id===employee_id)?.status || '未关联档案',
        profile_version:profileVersion(u),manager_store_ids:U.storesFor(db,u,undefined,ps),...(identities?{wechat_bound:identities.has(u.id)}:{})};
    }),
  };
}

function evaluateDraft(db, next, ps) {
  const stores = db.queryAll('SELECT id,store_name FROM stores');
  return Object.fromEntries(['web','mini'].map(channel => {
    const assignments = next.assignments.map(a => {
      const p=ps.find(p=>p.id===a.position_id), active=p?.enabled&&next.channels.includes(channel)&&p.channels.includes(channel);
      return {...a,name:p?.name||'已移除岗位',stores:active?stores.filter(s=>A.allows(A.intersect(A.scopeIds(db,a),A.scopeIds(db,p)),s.id)):[],
        codes:active?require('./channel-permissions').forPosition(p,channel):[]};
    });
    const codes=[...new Set(assignments.flatMap(a=>a.codes))];
    return [channel,{assignments:assignments.map(({codes,...a})=>a),permissions:codes.map(code=>{
      const sources=assignments.filter(a=>a.codes.includes(code)||a.codes.includes('*')).map(a=>({position_id:a.position_id,name:a.name,stores:a.stores}));
      return {code,stores:stores.filter(s=>sources.some(a=>a.stores.some(t=>t.id===s.id))),sources};
    })}];
  }));
}
function preview(db, body) {
  const userId=Number(body.user_id)||0;
  const user=userId?db.queryOne('SELECT * FROM users WHERE id=?',[userId]):{id:0};
  if(!user)fail('账号不存在',404);
  const {next,ps,review_fingerprint}=A.preparePerson(db,userId,body);
  U.assertPerson(db,user,next);
  return {preview:evaluateDraft(db,next,ps),review_fingerprint};
}
function create(db, body, actor) {
  const username=String(body.username||'').trim(), name=String(body.display_name||'').trim();
  if(!username||username.length>50||!name||name.length>30)fail('请填写姓名（最多30字）和登录账号（最多50字）');
  if(!String(body.reason||'').trim())fail('请填写创建原因');
  const {next,ps}=A.preparePerson(db,0,body);
  const web=next.channels.includes('web');
  if(web&&(typeof body.password!=='string'||body.password.length<6))fail('网页账号请设置至少6位初始密码');
  U.assertPerson(db,{id:0},next);
  if(db.queryOne('SELECT id FROM users WHERE username=?',[username]))fail('登录账号已存在');
  const password=web?body.password:crypto.randomBytes(32).toString('hex');
  return A.transaction(db,()=>{
    const id=db.insert('INSERT INTO users(username,display_name,role,password_hash) VALUES(?,?,?,?)',[username,name,'待配置',crypto.createHash('md5').update(password).digest('hex')]);
    const access=A.writePerson(db,id,next,ps,null,actor,String(body.reason).trim());
    return {id,access};
  });
}
function saveProfile(db,id,body,actor) {
  if(Object.keys(body).some(k=>!profileFields.includes(k)&&k!=='profile_version'))fail('账号资料不能修改岗位、员工关联或登录端');
  const user=db.queryOne('SELECT * FROM users WHERE id=?',[id]);if(!user)fail('账号不存在',404);
  if(body.profile_version!==profileVersion(user))fail('账号资料已更新，请重新打开详情后修改',409);
  const next=Object.fromEntries(profileFields.map(k=>[k,String(body[k]??user[k]??'').trim()]));
  if(!next.username||next.username.length>50||!next.display_name||next.display_name.length>30)fail('请核对登录账号和显示名称长度');
  next.phone=mobile(next.phone);
  if(db.queryOne('SELECT id FROM users WHERE username=? AND id<>?',[next.username,id]))fail('登录账号已存在');
  return A.transaction(db,()=>{
    db.run('UPDATE users SET username=?,display_name=?,phone=? WHERE id=?',[next.username,next.display_name,next.phone,id]);
    A.log(db,id,actor,'account.profile','维护账号资料',profile(user),next);
    return {profile:{...next,profile_version:profileVersion({...user,...next})}};
  });
}
module.exports={directory,evaluateDraft,preview,create,saveProfile,profileVersion};
