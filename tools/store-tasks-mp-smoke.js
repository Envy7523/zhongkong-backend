'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm'),express=require('express');
(async()=>{
  const {db,raw}=await require('./store-tasks-fixture')();
  for(const column of ['status','store_type','province','city','district'])db.run(`ALTER TABLE stores ADD COLUMN ${column} TEXT`);
  db.run('CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,phone TEXT,store_id INTEGER)');
  db.run("INSERT INTO users VALUES(1,'manager','店长','',1),(2,'staff','店员','',1),(3,'outsider','外店','',2)");
  const permissions={1:['analysis.view','store-tasks.execute','store-tasks.manage','store-tasks.review'],2:['store-tasks.execute'],3:['store-tasks.execute']};
  const auth={verify:token=>{if(!/^test-\d$/.test(token))throw new Error('bad token');return {id:Number(token.slice(-1))}},loadUser:id=>{const user=db.queryOne('SELECT * FROM users WHERE id=?',[id]);return user?{...user,position_permissions:permissions[id]}:null},storeScope:user=>user.store_id};
  let calls=0;const analytics={getOverview(_db,params){calls++;assert.equal(params.store_id,1);assert.equal(params.date_from,'2026-10-01');assert.equal(params.date_to,'2026-10-08');return {totals:{gross_amount:5073.70,confirmed:4281.28,order_count:103}}}};
  const overrides={'../db':db,'./auth':auth,'../business-analytics':analytics,'../collab-service':{addReply(){}},'./upload':{}};
  const filename=path.resolve('lib/mp/router.js'),mod={exports:{}};
  const req=name=>Object.hasOwn(overrides,name)?overrides[name]:require(name.startsWith('.')?path.resolve(path.dirname(filename),name):name);
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{require:req,module:mod,exports:mod.exports,console,process,__dirname:path.dirname(filename),Buffer,URLSearchParams,AbortSignal},{filename});
  const app=express();app.use(express.json());app.use('/api/mp',mod.exports);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port+'/api/mp';
  async function request(id,endpoint,body,method){const r=await fetch(base+endpoint,{headers:{Authorization:'Bearer test-'+id,'Content-Type':'application/json'},method:method||(body?'POST':'GET'),body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()}}
  try{
    const range='/revenue/range?store_id=1&date_from=2026-10-01&date_to=2026-10-08';
    const result=await request(1,range);assert.equal(result.status,200);assert.equal(result.data.date_from,'2026-10-01');assert.equal(result.data.summary.revenue,5073.70);assert.equal(result.data.summary.actual_revenue,4281.28);assert.equal(calls,1);
    assert.equal((await request(2,range)).status,403);assert.equal((await request(1,range.replace('store_id=1','store_id=2'))).status,403);assert.equal(calls,1);
    assert.equal((await request(1,range.replace('2026-10-01','2026-02-30'))).status,400);
    const own=await request(2,'/profile',{display_name:'新姓名',phone:'12345',store_id:2,position_permissions:['*']},'PUT');assert.equal(own.status,200);assert.equal(own.data.user.display_name,'新姓名');assert.equal(own.data.user.store_id,1);assert.deepEqual(own.data.user.position_permissions,['store-tasks.execute']);assert.equal(db.queryOne('SELECT display_name FROM users WHERE id=1').display_name,'店长');
    assert.equal((await request(2,'/profile',{display_name:''},'PUT')).status,400);
    const service=require('../lib/store-tasks'),admin=auth.loadUser(1),tid=service.saveTemplate(db,service.seed,admin).id;
    service.dispatch(db,{template_id:tid,store_ids:[1],from:'2026-10-08',to:'2026-10-08',frequency:'once',due_time:'10:00'},admin,1);
    const list=await request(2,'/store-tasks/instances?from=2026-10-08&to=2026-10-08&store_id=1');assert.equal(list.status,200);assert.equal(list.data.rows.length,1);
    const taskId=list.data.rows[0].id;assert.equal((await request(3,'/store-tasks/instances/'+taskId)).status,403);
    assert.equal((await request(2,'/store-tasks/instances/'+taskId+'/answer',{question_id:'opening-7',revision:0,value:'已完成'})).status,200);
    const receiptTemplate=service.saveTemplate(db,{title:'回执测试',questions:[{id:'receipt-check',title:'检查',type:'text',required:true}]},admin).id;
    service.dispatch(db,{template_id:receiptTemplate,store_ids:[1],from:'2026-10-08',to:'2026-10-08',frequency:'once',due_time:'10:00'},admin,1);
    const receiptTask=service.list(db,{from:'2026-10-08',to:'2026-10-08'},1).find(r=>r.title==='回执测试').id;
    assert.equal((await request(2,'/store-tasks/instances/'+receiptTask+'/answer',{question_id:'receipt-check',revision:0,value:'完成'})).status,200);
    assert.equal((await request(2,'/store-tasks/instances/'+receiptTask+'/submit',{revision:1})).status,200);
    assert.equal((await request(2,'/store-tasks/instances/'+receiptTask+'/review',{status:'approved',version:1})).status,403);
    assert.equal((await request(1,'/store-tasks/instances/'+receiptTask+'/review',{status:'rejected',version:1,note:''})).status,400);
    assert.equal((await request(1,'/store-tasks/instances/'+receiptTask+'/review',{status:'approved',version:1,note:'检查通过'})).status,200);
    const mobileReceipt=(await request(2,'/store-tasks/instances/'+receiptTask)).data.task.submissions[0];
    assert.equal(mobileReceipt.status,'approved');assert.equal(mobileReceipt.review_note,'检查通过');assert.equal(mobileReceipt.reviewed_name,'店长');assert(mobileReceipt.reviewed_at);
    permissions[2]=[];assert.equal((await request(2,'/store-tasks/instances/'+taskId)).status,403);
    console.log('PASS: MP nested task authentication/scope, fresh permission revocation, shared submission endpoint, range dates and cross-store denial, self profile update excludes role/store and other users');
  }finally{await new Promise(r=>server.close(r));raw.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
