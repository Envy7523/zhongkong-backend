const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {mountReportSyncPlans,INTERNAL}=require('../lib/report-sync-plans'),audit=require('../lib/sync-job-audit');
const times={meituan_delivery_operating:'03:00',meituan_delivery_product:'03:00',jd_delivery_operating:'05:00',jd_delivery_product:'06:30',taobao_flash_operating:'07:40',taobao_flash_product:'07:40',taobao_flash_settlement:'07:40'};
async function fixture(t){
 const SQL=await require('sql.js')(),sql=new SQL.Database();t.after(()=>sql.close());let fail=false;
 const db={run(q,p=[]){if(fail&&q.startsWith('UPDATE report_sync_plans')&&p.at(-1)==='jd_delivery_product')throw Error('injected_failure');sql.run(q,p);},queryOne(q,p=[]){const s=sql.prepare(q);try{s.bind(p);return s.step()?s.getAsObject():null;}finally{s.free();}},save(){}};
 sql.exec("CREATE TABLE schedule_config(id INTEGER,sync_enabled INTEGER,sync_time TEXT,updated_at TEXT,version INTEGER);INSERT INTO schedule_config VALUES(1,1,'01:05',NULL,1)");
 const routes={},secret='isolated-plan-window-secret',app={get:(p,h)=>routes['GET '+p]=h,post:(p,h)=>routes['POST '+p]=h};
 const api=mountReportSyncPlans({app,db,permissions:{},audit:{...audit,loadSecret:()=>secret}});api.ready();
 const types=['meituan_delivery','jd_delivery','taobao_flash'].flatMap(p=>['operating','product','settlement'].map(t=>p+'_'+t));
 for(const type of types)db.run('UPDATE report_sync_plans SET enabled=1 WHERE report_type=?',[type]);
 const body=()=>({plans:Object.entries(times).map(([report_type,run_time])=>({report_type,run_time,expected_version:api.plan(report_type).version}))});
 function request(body,headers={}){const timestamp=String(Date.now()),rawBody=JSON.stringify(body),h={'x-syncbot-timestamp':timestamp,'x-syncbot-signature':crypto.createHmac('sha256',secret).update(timestamp+'.'+rawBody).digest('hex'),...headers};const res={statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}};routes['POST '+INTERNAL+'/delivery-times']({body,socket:{remoteAddress:'127.0.0.1'},get:n=>h[n]},res);return res;}
 return {db,api,types,body,request,injectFailure:()=>{fail=true;}};
}
test('seven authorized changes are atomic and preserve settlement times, switches and other reports',async t=>{
 const f=await fixture(t),other=JSON.stringify(f.api.plan('item_sales_detail')),b=f.body();
 const r=f.request(b);assert.equal(r.statusCode,200);for(const [p,time]of Object.entries(times))assert.equal(f.api.plan(p).run_time,time);
 assert.equal(f.api.plan('meituan_delivery_settlement').run_time,'01:00');assert.equal(f.api.plan('jd_delivery_settlement').run_time,'02:00');
 assert(f.types.every(p=>f.api.plan(p).enabled));assert.equal(JSON.stringify(f.api.plan('item_sales_detail')),other);
 assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM report_sync_plan_audit').n,7);assert.equal(f.request(b).statusCode,409);
});
test('unsigned, forwarded, invalid or non-delivery changes cannot write plans',async t=>{
 const f=await fixture(t),b=f.body();assert.equal(f.request(b,{'x-syncbot-signature':''}).statusCode,401);assert.equal(f.request(b,{'x-forwarded-for':'127.0.0.1'}).statusCode,403);
 assert.equal(f.request({plans:[{report_type:'item_sales_detail',run_time:'05:00',expected_version:1}]}).statusCode,400);
 assert.equal(f.request({plans:[{...b.plans[0],run_time:'24:00'}]}).statusCode,400);assert.equal(f.request({plans:[b.plans[0],b.plans[0]]}).statusCode,400);
 assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM report_sync_plan_audit').n,0);
});
test('failed writes roll back the times, versions and audit rows together',async t=>{
 const f=await fixture(t),before=f.types.map(p=>f.api.plan(p));f.injectFailure();assert.equal(f.request(f.body()).statusCode,503);
 assert.deepEqual(f.types.map(p=>f.api.plan(p)),before);assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM report_sync_plan_audit').n,0);
});
test('cross-platform conflict validation uses the complete proposed schedule and keeps the sixty-minute rule',async t=>{
 const f=await fixture(t),b=f.body();b.plans.find(p=>p.report_type==='taobao_flash_product').run_time='06:59';assert.equal(f.request(b).statusCode,409);
 assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM report_sync_plan_audit').n,0);
});
