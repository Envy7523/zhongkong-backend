'use strict';
// Isolated, disposable test data. Never opens the business database or starts jobs.
const A=require('../lib/personnel-access'),UP=require('../lib/user-positions');
module.exports=async function fixture(){
  const {db,raw}=await require('./store-tasks-fixture')();
  let saves=0;db.save=()=>saves++;db.exec=sql=>db.run(sql);
  A.initialize(db);
  db.run('ALTER TABLE stores ADD COLUMN status TEXT');
  db.run("UPDATE stores SET store_name='示例欧景店',status='正常营业' WHERE id=1");db.run("UPDATE stores SET store_name='示例方洲店',status='正常营业' WHERE id=2");
  db.run('CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT UNIQUE,display_name TEXT,phone TEXT,avatar_url TEXT,role TEXT,store_id INTEGER,position_id INTEGER,password_hash TEXT,employee_id INTEGER)');
  db.run('CREATE TABLE employees(id INTEGER PRIMARY KEY,name TEXT,position TEXT,store_id INTEGER,store_name TEXT,status TEXT,onboarding_status TEXT,leave_date TEXT,salary REAL,id_card_number TEXT)');
  db.run('CREATE TABLE position_settings(id INTEGER PRIMARY KEY,name TEXT,description TEXT,permissions_json TEXT,is_system INTEGER)');
  db.run('CREATE TABLE store_regions(id INTEGER PRIMARY KEY,name TEXT,parent_id INTEGER)');
  db.run('CREATE TABLE store_region_members(region_id INTEGER,store_id INTEGER)');
  db.run("INSERT INTO store_regions VALUES(1,'示例深圳',NULL)");db.run('INSERT INTO store_region_members VALUES(1,1),(1,2)');
  for(const [id,name,category,web,mini] of [[1,'系统管理员','group',['*'],['*']],[2,'区域督导','group',['analysis.view'],['analysis.view','learning.view']],[3,'正式店长','store',['payroll.prepare','store-manager.identity'],['store-manager.identity','store-tasks.execute']],[4,'门店店员','store',[],['learning.view','store-tasks.execute']],[5,'储备店长','store',[],['learning.view','store-tasks.execute']]]){
    db.run('INSERT INTO position_settings VALUES(?,?,?,?,?)',[id,name,'隔离示例',JSON.stringify([...new Set([...web,...mini])]),id===1?1:0]);
    db.run('INSERT INTO access_position_config VALUES(?,?)',[id,JSON.stringify({category,channels:web.length?['web','mini']:['mini'],mode:'all',store_ids:[],region_ids:[],enabled:true,policy_version:1,channel_permissions:{web,mini}})]);
  }
  for(const [id,name,p,store,eid] of [[1,'示例管理员',1,null,null],[2,'示例督导',2,null,102],[3,'示例店长',3,1,103],[4,'示例店员',4,1,104],[5,'示例旧账号',4,2,105]])db.run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)',[id,'fixture'+id,name,'','','',store,p,'fixture-password-never-used',eid]);
  for(const [id,name,position,store] of [[102,'示例督导','督导',null],[103,'示例店长','店长',1],[104,'示例店员','店员',1],[105,'示例旧账号','店员',2],[106,'示例待开通员工','储备店长',2]])db.run('INSERT INTO employees VALUES(?,?,?,?,?,?,?,?,?,?)',[id,name,position,store,store===1?'示例欧景店':store===2?'示例方洲店':'总部','在职','已入职',null,9000,'TEST-SECRET-SHOULD-NOT-LEAK']);
  UP.initialize(db);
  for(const [uid,p,stores] of [[1,1,[]],[2,2,[1,2]],[3,3,[1]],[4,4,[1]]])A.savePerson(db,uid,{version:0,reason:'隔离初始化',channels:uid===4?['mini']:['web','mini'],employee_id:uid===1?null:100+uid,assignments:[{position_id:p,is_primary:true,mode:uid===1?'all':'stores',store_ids:stores,region_ids:[]}]},999);
  require('../lib/mp/wechat-binding').initialize(db);
  db.run('CREATE TABLE mp_identities(id INTEGER PRIMARY KEY,identity_type TEXT,identity_id TEXT,user_id INTEGER,status TEXT,store_id INTEGER,auth_version INTEGER NOT NULL DEFAULT 0,UNIQUE(identity_type,identity_id))');
  db.run('CREATE TABLE mp_audit_logs(user_id INTEGER,identity_type TEXT,action TEXT,target TEXT,detail TEXT)');
  db.run("INSERT INTO mp_wechat_requests(identity_id,name,contact,verification,status,user_id) VALUES('fixture-bound','示例店长','','DEMO-BOUND','approved',3),('fixture-pending','待核实示例员工','','DEMO-001','pending',NULL)");
  db.run("INSERT INTO mp_identities(identity_type,identity_id,user_id,status) VALUES('openid','fixture-bound',3,'active')");
  const wechat=require('../lib/mp/wechat-binding').createService({db,secret:'fixture-not-a-production-secret',readConfig:()=>({mp:{}})});
  return {db,raw,wechat,saves:()=>saves,user:id=>UP.enrich(db,db.queryOne('SELECT * FROM users WHERE id=?',[id]))};
};
if(require.main===module)(async()=>{
 const express=require('express'),path=require('path'),{pathToFileURL}=require('url');const f=await module.exports(),{db,wechat}=f;
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={id:1};next()});
 const wrap=fn=>(req,res)=>{try{res.json(fn(req))}catch(e){res.status(e.status||400).json({error:e.message})}};
 A.mount(app,db,id=>f.user(id));
 app.get('/api/users/wechat-bindings',wrap(()=>({requests:wechat.list()})));
 app.post('/api/users/wechat-bindings/:id/review',wrap(req=>wechat.review(req.params.id,req.body,1)));
 app.get('/api/users',wrap(()=>({users:db.queryAll('SELECT * FROM users').map(u=>f.user(u.id))})));
 app.get('/api/auth/me',wrap(()=>({user:f.user(1)})));
 app.get('/api/store-regions',wrap(()=>({regions:db.queryAll('SELECT * FROM store_regions').map(r=>({...r,store_ids:A.scopeIds(db,{mode:'regions',region_ids:[r.id]}),stores:db.queryAll('SELECT id,store_name FROM stores')}))})));
 app.use('/api',(req,res)=>res.status(404).json({error:'隔离验收未开放此操作'}));
 app.listen(3495,'127.0.0.1');
 const {createServer}=await import(pathToFileURL(path.resolve('frontend/node_modules/vite/dist/node/index.js')).href);
 const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>人员管理 · 隔离验收</title></head><body style="margin:0;padding:24px;background:#f5f7fa"><div id="app"></div><script type="module">import {createApp} from 'vue';import {createPinia} from 'pinia';import {createRouter,createMemoryHistory} from 'vue-router';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import People from '/src/views/UserManagementView.vue';import {useAuthStore} from '/src/stores/auth.js';const pinia=createPinia();localStorage.setItem('etaigong_token','fixture-1');useAuthStore(pinia).user={id:1,position_permissions:['*']};const app=createApp(People);app.use(pinia);app.use(createRouter({history:createMemoryHistory(),routes:[{path:'/:pathMatch(.*)*',component:{render:()=>null}}]}));app.use(ElementPlus);app.mount('#app');</script></body></html>`;
 const vite=await createServer({root:path.resolve('frontend'),configFile:path.resolve('frontend/vite.config.js'),plugins:[{name:'personnel-fixture-page',configureServer(server){server.middlewares.use('/people-check.html',async(req,res,next)=>{try{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await server.transformIndexHtml('/people-check.html',html))}catch(e){next(e)}})}}],server:{host:'127.0.0.1',port:3494,strictPort:true,proxy:{'/api':{target:'http://127.0.0.1:3495'}}}});await vite.listen();
 console.log('Isolated personnel management: http://127.0.0.1:3494/people-check.html');
})().catch(e=>{console.error(e);process.exitCode=1});
