'use strict';
const assert=require('node:assert/strict'),A=require('../lib/personnel-access'),P=require('../lib/personnel-directory');
(async()=>{const f=await require('./personnel-management-fixture')(),{db,raw}=f;
 const assignment=(position_id,stores,is_primary=true)=>({position_id,is_primary,mode:'stores',store_ids:stores,region_ids:[]});
 const body={display_name:'新增隔离人员',username:'new-test',channels:['mini'],employee_id:106,reason:'新增验证',assignments:[assignment(4,[2])]};
 const directory=P.directory(db),json=JSON.stringify(directory);
 for(const key of ['password_hash','id_card_number','salary','TEST-SECRET-SHOULD-NOT-LEAK'])assert(!json.includes(key),key);
 assert.equal(directory.users.length,5);assert.equal(directory.employees.find(e=>e.id===105).linked_user_id,5);
 const before=db.queryOne('SELECT COUNT(*) n FROM users').n,saves=f.saves();
 const preview=P.preview(db,body);assert.deepEqual(preview.preview.mini.assignments[0].stores.map(s=>s.id),[2]);assert.equal(preview.preview.web.permissions.length,0);
 assert.equal(db.queryOne('SELECT COUNT(*) n FROM users').n,before);assert.equal(f.saves(),saves);
 const roleBefore=db.queryOne('SELECT config_json FROM access_position_config WHERE position_id=4').config_json;
 const changedRole=JSON.parse(roleBefore);changedRole.mode='stores';changedRole.store_ids=[2];db.run('UPDATE access_position_config SET config_json=? WHERE position_id=4',[JSON.stringify(changedRole)]);
 assert.throws(()=>P.create(db,{...body,review_fingerprint:preview.review_fingerprint},1),e=>e.status===409);
 assert.equal(db.queryOne('SELECT COUNT(*) n FROM users').n,before);db.run('UPDATE access_position_config SET config_json=? WHERE position_id=4',[roleBefore]);
 assert.throws(()=>P.create(db,{...body,employee_id:105},1),/已关联其他账号/);
 assert.throws(()=>P.create(db,{...body,channels:['web']},1),/没有可用岗位/);
 const oldInsert=db.insert;db.insert=function(sql,args){if(sql.startsWith('INSERT INTO access_change_logs'))throw Error('模拟审计写入失败');return oldInsert.call(db,sql,args)};
 assert.throws(()=>P.create(db,body,1),/模拟审计/);db.insert=oldInsert;
 assert.equal(db.queryOne('SELECT COUNT(*) n FROM users').n,before);assert.equal(db.queryOne("SELECT id FROM users WHERE username='new-test'"),null);
 const created=P.create(db,{...body,review_fingerprint:preview.review_fingerprint},1);assert.deepEqual(A.report(db,created.id,'mini').permissions,preview.preview.mini.permissions);
 const u=P.directory(db).users.find(u=>u.id===created.id),accessBefore=JSON.stringify(A.config(db,u.id));
 for(const phone of ['weixin_123','123456789','1380013800','12800138000','138001380000','1380013a000']){
  assert.throws(()=>P.saveProfile(db,u.id,{username:u.username,display_name:u.display_name,phone,profile_version:u.profile_version},1),/11位中国大陆手机号/);
 }
 assert.equal(db.queryOne('SELECT phone FROM users WHERE id=?',[u.id]).phone||'','');
 const profile=P.saveProfile(db,u.id,{username:u.username,display_name:'改名后',phone:' 13800138000 ',profile_version:u.profile_version},1).profile;
 assert.equal(profile.phone,'13800138000');
 assert.equal(profile.display_name,'改名后');assert.equal(JSON.stringify(A.config(db,u.id)),accessBefore);
 assert.throws(()=>P.saveProfile(db,u.id,{...profile,display_name:'过期写入',profile_version:u.profile_version},1),e=>e.status===409);
 assert.throws(()=>P.saveProfile(db,u.id,{...profile,assignments:[]},1),/不能修改岗位/);
 const noPhone=P.saveProfile(db,u.id,{...profile,phone:''},1).profile;assert.equal(noPhone.phone,'');
 db.run('UPDATE users SET avatar_url=? WHERE id=?',['/fixture-avatar.png',u.id]);
 assert.throws(()=>P.saveProfile(db,u.id,{...noPhone,display_name:'头像变动后的旧版本'},1),e=>e.status===409);
 const combined={user_id:2,channels:['web','mini'],employee_id:102,reason:'逐岗位隔离',assignments:[assignment(2,[1,2]),assignment(3,[2],false)]};
 const pr=P.preview(db,combined).preview;
 assert.deepEqual(pr.web.permissions.find(p=>p.code==='analysis.view').stores.map(s=>s.id),[1,2]);
 assert.deepEqual(pr.web.permissions.find(p=>p.code==='payroll.prepare').stores.map(s=>s.id),[2]);
 assert.deepEqual(pr.web.permissions.find(p=>p.code==='payroll.prepare').sources.map(p=>p.position_id),[3]);
 A.savePerson(db,2,{...combined,version:A.config(db,2).version},1);assert.deepEqual(A.report(db,2,'web').permissions,pr.web.permissions);
 const allBefore=JSON.stringify(A.config(db,2));f.wechat.review(2,{action:'approve',user_id:2},1);assert.equal(JSON.stringify(A.config(db,2)),allBefore);assert.equal(P.directory(db).users.find(u=>u.id===2).wechat_bound,true);f.wechat.review(2,{action:'revoke'},1);assert.equal(P.directory(db).users.find(u=>u.id===2).wechat_bound,false);
 const express=require('express'),app=express();app.use(express.json());app.use((req,res,next)=>{req.user={id:Number(req.get('x-user')||1)};next()});A.mount(app,db,id=>f.user(id));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const base='http://127.0.0.1:'+server.address().port;
  for(const [url,method,payload] of [['/config','GET'],['/preview','POST',body],['/users/'+u.id+'/profile','PUT',profile]]){
   const r=await fetch(base+'/api/access'+url,{method,headers:{'Content-Type':'application/json','x-user':'4'},body:payload?JSON.stringify(payload):undefined});assert.equal(r.status,403);
  }
  const r=await fetch(base+'/api/access/config');assert.equal(r.status,200);assert.equal((await r.json()).users.length,6);
  const unknown=await fetch(base+'/api/access/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,user_id:9999})});assert.equal(unknown.status,404);
 }finally{await new Promise(r=>server.close(r));raw.close()}
 console.log('PASS personnel directory: safe projection, legacy links, read-only preview, per-role/channel scopes and sources, atomic create rollback, duplicate employee rejection, mobile validation, profile isolation/versioning including avatars, binding isolation and HTTP authorization');
})().catch(e=>{console.error(e);process.exitCode=1});
