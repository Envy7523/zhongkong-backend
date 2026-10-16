'use strict';
const assert = require('node:assert/strict');
const fs = require('fs'), vm = require('vm'), {createRequire} = require('module'), path = require('path');
const A = require('../lib/personnel-access'), U = require('../lib/store-manager-uniqueness');
const UP = require('../lib/user-positions'), policy = require('../lib/channel-permissions');
(async () => {
  const {db, raw} = await require('./store-tasks-fixture')();
  A.initialize(db);
  db.run('CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT UNIQUE,display_name TEXT,role TEXT,store_id INTEGER,position_id INTEGER,password_hash TEXT,phone TEXT)');
  db.run('CREATE TABLE employees(id INTEGER PRIMARY KEY,status TEXT,leave_date TEXT)');
  db.run('CREATE TABLE position_settings(id INTEGER PRIMARY KEY,name TEXT,description TEXT,permissions_json TEXT,is_system INTEGER,updated_at TEXT)');
  db.run('CREATE TABLE store_regions(id INTEGER PRIMARY KEY,name TEXT,parent_id INTEGER,code TEXT,sort_order INTEGER,updated_at TEXT)');
  db.run('CREATE TABLE store_region_members(region_id INTEGER,store_id INTEGER,UNIQUE(region_id,store_id))');
  for (const [id,name,codes] of [[1,'管理员',['*']],[2,'门店店长',['store-manager.identity']],[3,'店员',['learning.view']],[4,'储备店长',['learning.view']],[5,'正式负责人',['store-manager.identity']]]) {
    db.run('INSERT INTO position_settings VALUES(?,?,?,?,?,NULL)',[id,name,'',JSON.stringify(codes),id===1?1:0]);
    db.run('INSERT INTO access_position_config VALUES(?,?)',[id,JSON.stringify({category:id===1?'group':'store',channels:['web','mini'],enabled:true,mode:'all',store_ids:[],region_ids:[]})]);
  }
  for (let id=1;id<=8;id++) db.run('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)',[id,'u'+id,'人员'+id,'',null,id===1?1:3,'','']);
  UP.initialize(db);
  const assignment=(id,stores=[1])=>({position_id:id,is_primary:true,mode:'stores',store_ids:stores,region_ids:[]});
  const body=(id,stores=[1],extra={})=>({version:0,reason:'隔离测试',channels:['web','mini'],assignments:[assignment(id,stores)],...extra});
  const save=(uid,b)=>A.savePerson(db,uid,{...b,version:A.config(db,uid)?.version||0},1);
  const conflict=fn=>assert.throws(fn,e=>e.status===409&&/只能有一名正式店长/.test(e.message));
  save(2,body(2));
  const before=JSON.stringify(db.queryAll('SELECT * FROM users'));
  const logs=db.queryOne('SELECT COUNT(*) n FROM access_change_logs').n;
  conflict(()=>save(3,body(2))); // Same role, same store.
  conflict(()=>save(3,body(5))); // Different formal manager role.
  conflict(()=>save(3,body(2,[1],{channels:['web']}))); // Cross-channel.
  conflict(()=>save(3,body(2,[1],{assignments:[assignment(3),{...assignment(2),is_primary:false}]})));
  assert.equal(JSON.stringify(db.queryAll('SELECT * FROM users')),before);
  assert.equal(A.config(db,3),null);
  assert.equal(db.queryOne('SELECT COUNT(*) n FROM access_change_logs').n,logs);
  save(2,body(2,[1,2])); // Editing oneself, managing several stores.
  save(3,body(3));save(4,body(3));save(5,body(4));save(6,body(4)); // Non-exclusive roles.
  assert.equal(U.conflicts(db).length,0);
  db.run("INSERT INTO store_regions VALUES(10,'父区',NULL,NULL,0,NULL),(11,'子区',10,NULL,0,NULL)");
  db.run('INSERT INTO store_region_members VALUES(11,1)');
  conflict(()=>save(3,body(5,[1],{assignments:[{...assignment(5),mode:'regions',region_ids:[10],store_ids:[]}]})));
  conflict(()=>save(3,body(5,[1],{assignments:[{...assignment(5),mode:'all',store_ids:[]}]})));
  // Legacy assignments occupy the store, even without new per-role config.
  save(2,body(2,[1]));
  db.run('UPDATE users SET store_id=2,position_id=5 WHERE id=7');UP.assign(db,7,[{id:5}]);
  conflict(()=>save(3,body(2,[2])));
  db.run('UPDATE users SET store_id=1 WHERE id=8');
  conflict(()=>UP.assign(db,8,[{id:2}]));
  assert.deepEqual(db.queryAll('SELECT position_id FROM user_positions WHERE user_id=8').map(r=>r.position_id),[3]);
  // A departed employee no longer occupies an active manager seat.
  db.run("INSERT INTO employees VALUES(107,'离职',NULL)");
  save(7,body(5,[2],{employee_id:107}));save(3,body(5,[2]));
  // Changing a role's scope or grants must not turn several staff into managers.
  A.savePosition(db,2,{...A.positions(db).find(p=>p.id===2),mode:'stores',store_ids:[1]},1);
  save(2,body(2,[1],{assignments:[{...assignment(2),mode:'all',store_ids:[]}]}));
  conflict(()=>A.savePosition(db,2,{...A.positions(db).find(p=>p.id===2),mode:'all',store_ids:[]},1));
  assert.deepEqual(A.positions(db).find(p=>p.id===2).store_ids,[1]);
  const policyBody={name:'正式负责人新模板',description:'',category:'store',channels:['web','mini'],mode:'all',store_ids:[],region_ids:[],enabled:true,policy_version:0,channel_permissions:{web:['store-manager.identity'],mini:['store-manager.identity']}};
  conflict(()=>policy.save(db,3,policyBody,1));
  assert.equal(A.positions(db).find(p=>p.id===3).name,'店员');
  assert.equal(A.positions(db).find(p=>p.id===3).policy_version,undefined);
  // Inherited scope changes are atomic and include parent/child regions.
  save(2,body(2));
  A.savePosition(db,2,{...A.positions(db).find(p=>p.id===2),mode:'all',store_ids:[]},1);
  save(2,body(2,[1],{assignments:[{...assignment(2),mode:'regions',store_ids:[],region_ids:[10]}]}));
  conflict(()=>U.protect(db,()=>db.run('INSERT INTO store_region_members VALUES(11,2)')));
  assert.equal(db.queryOne('SELECT * FROM store_region_members WHERE store_id=2'),null);
  db.run("INSERT INTO store_regions VALUES(20,'另一区',NULL,NULL,0,NULL)");db.run('INSERT INTO store_region_members VALUES(20,2)');
  conflict(()=>U.protect(db,()=>db.run('UPDATE store_regions SET parent_id=10 WHERE id=20')));
  assert.equal(db.queryOne('SELECT parent_id FROM store_regions WHERE id=20').parent_id,null);
  // An existing conflict is reported, never silently resolved or spread.
  db.run('INSERT INTO access_person_config VALUES(8,1,?)',[JSON.stringify({channels:['mini'],assignments:[assignment(5)]})]);
  assert.equal(U.conflicts(db).length,1);
  U.protect(db,()=>db.run("UPDATE position_settings SET description='维护说明' WHERE id=3"));
  conflict(()=>U.protect(db,()=>db.run('UPDATE access_person_config SET config_json=? WHERE user_id=6',[JSON.stringify({channels:['web'],assignments:[assignment(5)]})])));
  assert.equal(A.config(db,6).assignments[0].position_id,4);
  save(8,body(3));assert.equal(U.conflicts(db).length,0);
  // Exercise the real access and legacy HTTP handlers in an isolated database.
  const express=require('express'),app=express();app.use(express.json());
  app.use((req,res,next)=>{req.user={id:1};next()});
  A.mount(app,db,()=>({position_permissions:['*']}));
  const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  const ctx={app,db,require:createRequire(path.join(__dirname,'../server.js')),crypto:require('crypto'),
    userPositions:UP,personnelAccess:A,payrollWorkflow:require('../lib/payroll-workflow'),
    parsePositionPermissions:require('../lib/permissions').normalizePermissions,
    requireAdmin:()=>true,normalizePositionPayload:b=>b,storeLifecycle:{CLOSED_REGION_CODE:'_closed'},
    normalizeStoreIds:ids=>ids||[],listStoreRegions:()=>[]};
  for(const [start,end] of [["app.post('/api/users',","app.put('/api/users/:id/password'"],["app.put('/api/positions/:id'","app.delete('/api/positions/:id'"],["app.post('/api/store-regions'","// 统计卡片"]]) {
    const from=source.indexOf(start),to=source.indexOf(end,from);assert(from>=0&&to>from);
    vm.runInNewContext(source.slice(from,to),ctx);
  }
  db.run("INSERT INTO users VALUES(9,'legacy9','旧账号9','',2,3,'','')");UP.assign(db,9,[{id:3}]);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port;
  const request=async(url,method,b)=>{const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});return {status:r.status,body:await r.json()}};
  try {
    const counts=()=>db.queryOne('SELECT COUNT(*) n FROM users').n,n=counts();
    let r=await request('/api/access/users','POST',{...body(2),display_name:'重复店长',username:'new-manager',password:'test-only'});
    assert.equal(r.status,409);assert.match(r.body.error,/人员2/);assert.equal(counts(),n);
    r=await request('/api/access/users/4','PUT',{...body(2),version:A.config(db,4).version});assert.equal(r.status,409);
    r=await request('/api/users','POST',{username:'legacy-duplicate',password:'test-only',position_ids:[5],store_id:1});
    assert.equal(r.status,409);assert.equal(counts(),n);
    r=await request('/api/users/9','PUT',{username:'must-not-write',position_ids:[2],store_id:1});assert.equal(r.status,409);
    assert.equal(db.queryOne('SELECT username FROM users WHERE id=9').username,'legacy9');
    assert.equal(db.queryOne('SELECT store_id FROM users WHERE id=9').store_id,2);
    r=await request('/api/positions/3','PUT',{name:'店员变正式店长',description:'',permissions:['store-manager.identity']});
    assert.equal(r.status,409);assert.equal(A.positions(db).find(p=>p.id===3).name,'店员');
    r=await request('/api/stores/2/region-membership','PUT',{region_id:11});assert.equal(r.status,409);
    assert.equal(db.queryOne('SELECT region_id FROM store_region_members WHERE store_id=2').region_id,20);
    r=await request('/api/store-regions/20','PUT',{name:'不得残留的区域名',parent_id:10});assert.equal(r.status,409);
    assert.equal(db.queryOne('SELECT name FROM store_regions WHERE id=20').name,'另一区');
    r=await request('/api/store-regions','POST',{name:'不得新增',parent_id:10,store_ids:[2]});assert.equal(r.status,409);
    assert.equal(db.queryOne("SELECT id FROM store_regions WHERE name='不得新增'"),null);
    r=await request('/api/access/users','POST',{...body(4),display_name:'新增储备',username:'allowed-reserve',password:'test-only'});assert.equal(r.status,200,JSON.stringify(r.body));
    assert.equal(U.conflicts(db).length,0);
    db.run("INSERT INTO stores VALUES(3,'并发测试门店')");
    const concurrent=await Promise.all([5,6].map(id=>request('/api/access/users/'+id,'PUT',{...body(5,[3]),version:A.config(db,id).version})));
    assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
    assert.equal(U.conflicts(db).length,0);
  } finally {await new Promise(r=>server.close(r));raw.close()}
  console.log('PASS: one formal manager per store across roles/channels/scopes, unlimited staff/reserve, legacy/new HTTP guards, conflict rollback, region inheritance, policy changes, existing conflict audit and departed staff');
})().catch(e=>{console.error(e);process.exitCode=1});
