'use strict';
const assert=require('node:assert/strict'),express=require('express'),fs=require('fs'),os=require('os'),path=require('path');
(async()=>{
 const {db,raw}=await require('./store-tasks-fixture')(),service=require('../lib/store-tasks');
 const admin={id:1,username:'admin',position_permissions:['*']},staff={id:2,username:'staff',store_id:1,position_permissions:['store-tasks.execute']},other={...staff,id:3,store_id:2};
 const uploadDir=fs.mkdtempSync(path.join(os.tmpdir(),'task-guides-'));
 const app=express();app.use(express.json({limit:'6mb'}));app.use(require('../lib/store-task-router').createRouter({db,uploadDir,authenticate(req,res,next){req.taskUser=({1:admin,2:staff,3:other})[req.headers['x-user']];if(!req.taskUser)return res.status(401).json({error:'unauthorized'});next()},scopeFor:u=>u.store_id??null}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0V8AAAAASUVORK5CYII=';
 async function call(user,url,body){const r=await fetch('http://127.0.0.1:'+server.address().port+url,{headers:{'x-user':String(user),'Content-Type':'application/json'},method:body?'POST':'GET',body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()}}
 try{
  assert.equal((await call(2,'/guide-images',{data:png})).status,403);
  assert.equal((await call(1,'/guide-images',{data:'data:image/png;base64,YmFk'})).status,400);
  const uploaded=await call(1,'/guide-images',{data:png});assert.equal(uploaded.status,200);const image=uploaded.data.path;
  const q={id:'oven',execution_mode:'shared',title:'检查烤箱',type:'photo',required:true,min:1,max:1,description:'按照示例检查',guide_images:[image]};
  const mapped=await import('../frontend/src/utils/store-task-form-schema.mjs');assert.deepEqual(mapped.fromDesignerRules([mapped.toDesignerRule(q)])[0],q);
  assert.throws(()=>service.saveTemplate(db,{title:'bad',questions:[{...q,guide_images:[image,image]}]},admin));
  assert.throws(()=>service.saveTemplate(db,{title:'bad',questions:[{...q,guide_images:['https://example.com/x.png']}]},admin));
  assert.throws(()=>service.saveTemplate(db,{title:'bad',questions:[{...q,guide_images:[image.replace(/.$/,'x')]}]},admin));
  const tid=service.saveTemplate(db,{title:'说明图片检查',questions:[q]},admin).id;
  service.dispatch(db,{template_id:tid,store_ids:[1],from:'2026-10-08',to:'2026-10-08',frequency:'once',due_time:'10:00'},admin,null);
  const task=service.list(db,{from:'2026-10-08',to:'2026-10-08'},1)[0].id,url='/photo?path='+encodeURIComponent(image);
  assert.equal((await call(0,url)).status,401);assert.equal((await call(3,url)).status,403);assert.equal((await call(2,url)).data.data,png);
  assert.equal(service.detail(db,task,1).completed,0);
  assert.throws(()=>service.writeAnswer(db,task,{question_id:q.id,revision:0,images:[image]},staff,1));
  const actual=await call(2,'/instances/'+task+'/photo',{data:png});assert.equal(actual.status,200);
  service.writeAnswer(db,task,{question_id:q.id,revision:0,images:[actual.data.path]},staff,1);service.submit(db,task,{revision:1},staff,1);
  service.saveTemplate(db,{id:tid,version:1,title:'说明图片检查',questions:[{...q,description:'新标准',guide_images:[]}]},admin);
  assert.deepEqual(service.detail(db,task,1).submissions[0].snapshot[0].guide_images,[image]);assert.equal((await call(2,url)).status,200);
  console.log('PASS: guide upload permission/content validation; schema round trip; store isolation; guide images excluded from evidence count; historical instructions retained');
 }finally{await new Promise(r=>server.close(r));raw.close();fs.rmSync(uploadDir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
