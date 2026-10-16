'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const permissions=require('../lib/permissions'),access=require('../lib/personnel-access'),up=require('../lib/user-positions'),profile=require('../lib/staff-profile-policy'),rules=require('../lib/delivery-fee-rules');
(async()=>{
 const f=await require('./personnel-management-fixture')(),{db,raw}=f;
 db.run('CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT)');
 db.run('CREATE TABLE bookkeeping_entries(category_name TEXT,subcategory_name TEXT,amount REAL)');
 db.run('CREATE TABLE delivery_external_expenses(platform TEXT,expense_type TEXT)');
 for(const t of ['meituan_delivery_bills','taobao_flash_bills','jd_delivery_bills'])db.run('CREATE TABLE '+t+'(bill_type TEXT,match_status TEXT)');
 db.run("INSERT INTO meituan_delivery_bills VALUES('测试服务费','matched')");
 // Operator: analysis only, without enterprise settings, users, roles or ledger access.
 db.run("UPDATE position_settings SET permissions_json='[\"analysis.view\"]' WHERE id=2");
 db.run('DELETE FROM access_position_config WHERE position_id=2');
 db.run('DELETE FROM access_person_config WHERE user_id=2');
 const user=id=>up.enrich(db,db.queryOne('SELECT * FROM users WHERE id=?',[id]));
 const express=require('express'),app=express();app.use(express.json());
 app.use((req,res,next)=>{if(req.get('x-user'))req.user={id:Number(req.get('x-user'))};next()});
 app.use(profile.middleware(db));app.use(access.webGuard(db));
 app.use(permissions.createGuard({getUserById:user,hasFullAccess:u=>permissions.can(u.permissions_json,'*')}));
 app.use('/api/enterprise-settings/delivery-fee-rules',rules.router(db));
 for(const p of ['/api/enterprise-settings','/api/enterprise-settings/delivery-fee-rules-backup','/api/users','/api/positions','/api/bookkeeping/expense-tags'])app.all(p,(req,res)=>res.json({ok:true}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const request=(url,method='GET',id=2,body)=>fetch(base+url,{method,headers:{...(id?{'x-user':String(id)}:{}),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 try{
  const endpoint='/api/enterprise-settings/delivery-fee-rules';
  let r=await request(endpoint);assert.equal(r.status,200);let data=await r.json();
  const row=data.rows.find(r=>r.name==='测试服务费');r=await request(endpoint,'PUT',2,{revision:data.revision,rows:[{key:row.key,category:'third_party'}]});assert.equal(r.status,200);assert.equal(rules.classify(rules.read(db),'美团外卖','bill','测试服务费'),'third_party');
  for(const p of ['/api/enterprise-settings','/api/enterprise-settings/delivery-fee-rules-backup','/api/users','/api/positions','/api/bookkeeping/expense-tags'])for(const method of ['GET','PUT'])assert.equal((await request(p,method,2,method==='PUT'?{}:undefined)).status,403,p);
  for(const method of ['GET','PUT']){assert.equal((await request(endpoint,method,0,method==='PUT'?{}:undefined)).status,401);assert.equal((await request(endpoint,method,4,method==='PUT'?{}:undefined)).status,403)}
  // Scoped, channel-specific roles must honor the same permission and its own scope.
  const policy={category:'group',channels:['web','mini'],enabled:true,mode:'all',store_ids:[],region_ids:[],channel_permissions:{web:['analysis.view'],mini:[]}};
  db.run('INSERT INTO access_position_config VALUES(?,?)',[2,JSON.stringify(policy)]);
  const person=mode=>({channels:['web','mini'],assignments:[{position_id:2,is_primary:true,mode,store_ids:mode==='stores'?[1]:[],region_ids:[]}]});
  db.run('INSERT INTO access_person_config VALUES(?,1,?)',[2,JSON.stringify(person('all'))]);
  r=await request(endpoint);assert.equal(r.status,200);data=await r.json();assert.equal((await request(endpoint,'PUT',2,{revision:data.revision,rows:[{key:row.key,category:'promotion'}]})).status,200);
  db.run('UPDATE access_person_config SET config_json=? WHERE user_id=2',[JSON.stringify(person('stores'))]);assert.equal((await request(endpoint)).status,403);assert.equal((await request(endpoint,'PUT',2,{})).status,403);
  db.run('UPDATE access_person_config SET config_json=? WHERE user_id=2',[JSON.stringify(person('all'))]);policy.channel_permissions={web:[],mini:['analysis.view']};db.run('UPDATE access_position_config SET config_json=? WHERE position_id=2',[JSON.stringify(policy)]);assert.equal((await request(endpoint)).status,403);assert.equal((await request(endpoint,'PUT',2,{})).status,403);
  assert.equal((await request(endpoint,'GET',1)).status,200);
  // Menu and backend gates resolve the same existing "data analysis" grant.
  const source=fs.readFileSync(path.resolve(__dirname,'../frontend/src/permissions.js'),'utf8');const front=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  for(const method of ['GET','PUT'])assert.equal(permissions.requiredPermission(endpoint,method),front.NAV_ITEM_PERMISSIONS['analysis-delivery-fees']);
  assert(front.permits(['analysis.view'],front.NAV_ITEM_PERMISSIONS['analysis-delivery-fees']));assert(!front.permits(['enterprise-settings.manage'],front.NAV_ITEM_PERMISSIONS['analysis-delivery-fees']));
 }finally{await new Promise(r=>server.close(r));raw.close()}
 console.log('PASS delivery classification: analysis-only operator GET/PUT, adjacent admin/ledger denial, anonymous/revoked/channel/scope denial, admin access and menu/API parity');
})().catch(e=>{console.error(e);process.exitCode=1});
