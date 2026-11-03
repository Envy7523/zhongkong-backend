'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),X=require('xlsx');
const {Collector}=require('../syncbot/windows-client/collector.cjs'),sync=require('../lib/delivery-client-sync'),analytics=require('../lib/business-analytics');
const date='2026-11-01',now=new Date('2026-11-03T08:00:00Z');

async function fixture(t,{platform='meituan_delivery',income=12.34,accepted=true}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'etg-server-first-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const SQL=await require('sql.js')(),sql=new SQL.Database();t.after(()=>sql.close());
 const schema=fs.readFileSync(require.resolve('../lib/db'),'utf8');
 for(const name of ['business_import_batches','meituan_delivery_operation_records','meituan_delivery_product_records','meituan_delivery_bills','business_product_sales','business_revenue_records','delivery_operation_records','jd_delivery_product_records','taobao_flash_daily_reports','taobao_flash_bills','jd_delivery_bills']){
  const start=schema.indexOf('CREATE TABLE IF NOT EXISTS '+name+' (');assert(start>=0);sql.run(schema.slice(start,schema.indexOf('\n    )',start)+6));
 }
 sql.run("CREATE TABLE stores(id INTEGER PRIMARY KEY,store_name TEXT,status TEXT,opening_date TEXT,closed_date TEXT); INSERT INTO stores VALUES(1,'测试店','正常营业','2026-01-01',''); CREATE TABLE store_platforms(store_id INTEGER,platform_name TEXT,platform_id TEXT,online_date TEXT); INSERT INTO store_platforms VALUES(1,'美团外卖','123','2026-01-01'),(1,'京东外卖','200','2026-01-01'),(1,'淘宝闪购','100','2026-01-01')");
 const db={run(q,p=[]){sql.run(q,p);},queryAll(q,p=[]){const s=sql.prepare(q);try{s.bind(p);const rows=[];while(s.step())rows.push(s.getAsObject());return rows;}finally{s.free();}},queryOne(q,p){return this.queryAll(q,p)[0]||null;},insert(q,p){this.run(q,p);return this.queryOne('SELECT last_insert_rowid() id').id;},save(){}};
 sync.ready(db);const device={id:'fixture-device',name:'隔离核验'};
 const scope=()=>({...sync.scope(db,date,platform),account:'test_account',capabilities:{settlement_all_stores:true}});
 let bytes;
 if(platform==='meituan_delivery'){
  const fields=require('../syncbot/src/meituan-delivery/operating-contract').fields.map(f=>f==='营业收入'?'订单收入':f);
  bytes=Buffer.from(fields.join(',')+'\n'+[date,'测试店','123','广东','深圳','龙岗',income,20,1,10,2,'20%','10%',1,'4.8'].join(',')+'\n');
 }else{
  const book=X.utils.book_new(),id=platform==='jd_delivery'?'200':'100';
  X.utils.book_append_sheet(book,X.utils.json_to_sheet([{[platform==='jd_delivery'?'门店id':'门店编号']:id,门店名称:'测试店',日期:date,收入:income,营业额:20,有效订单:1,曝光人数:10,进店转化率:.2}]),'data');bytes=X.write(book,{type:'buffer',bookType:'xlsx'});
 }
 if(accepted)sync.importFile(db,analytics,device,{platform,type:'operating',date,scope_version:scope().version,data:bytes.toString('base64'),sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
 const trace=[],c=new Collector(root,{clock:()=>now,runners:{[platform+':operating']:async()=>{trace.push('export');throw Error('unexpected_export');}}});
 c.cloud={enabled:true,config:async()=>{trace.push('scope');return scope();},call:async(route,body)=>{trace.push(route);assert.equal(route,'/finish');assert.equal(body.dryRun,false);return sync.finish(db,device,body);},event:async body=>{trace.push('event:'+body.status);},upload:async()=>{trace.push('upload');throw Error('unexpected_upload');}};
 c.browser=async()=>{trace.push('browser');throw Error('unexpected_browser');};c.extension.failureCodes=async()=>[];c.downloadDiagnostics=()=>[];
 return {c,db,trace,scope,device,bytes};
}

for(const platform of ['meituan_delivery','jd_delivery','taobao_flash'])test(platform+' ordinary recovery with no local history reuses independently verified server originals',async t=>{
 const f=await fixture(t,{platform});assert.equal(f.c.recoveredState,false);assert.equal(f.c.history.length,0);
 const before=f.db.queryOne('SELECT COUNT(*) n FROM business_import_batches').n;
 const job=await f.c.start(date,'schedule-recovery','operating',platform).completion;
 assert.deepEqual(f.trace,['scope','/finish']);assert.equal(job.status,'completed');assert.equal(job.reusedServerProof,true);assert.equal(job.cloudReceipt.verification.storage_verified,true);
 assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM business_import_batches').n,before);assert.equal(f.c.busy,false);
});

test('accepted blank source remains unverified on a manual retry without replacing it or opening Chrome',async t=>{
 const f=await fixture(t,{income:''}),original=f.db.queryOne('SELECT sha256 FROM delivery_collector_files').sha256;
 const job=await f.c.start(date,'manual','operating').completion;
 assert.equal(job.status,'unverified');assert.equal(job.reusedServerProof,true);assert.deepEqual(f.trace,['scope','/finish']);
 assert.equal(f.db.queryOne('SELECT sha256 FROM delivery_collector_files').sha256,original);
});

test('missing server originals permit the original collection flow once, after the server check',async t=>{
 const f=await fixture(t,{platform:'jd_delivery',accepted:false});
 const job=await f.c.start(date,'remote-test','operating','jd_delivery').completion;
 assert.deepEqual(f.trace.slice(0,4),['scope','/finish','event:running','export']);assert.equal(job.code,'unexpected_export');assert.equal(f.trace.filter(x=>x==='export').length,1);
});

for(const mode of ['hash','metric','scope'])test('existing server '+mode+' mismatch stops before exporting a replacement',async t=>{
 const f=await fixture(t);
 if(mode==='hash')f.db.run("UPDATE delivery_collector_files SET sha256=?",['0'.repeat(64)]);
 if(mode==='metric')f.db.run('UPDATE meituan_delivery_operation_records SET income_amount=999');
 if(mode==='scope'){f.db.run("INSERT INTO stores VALUES(2,'新增店','正常营业','2026-01-01','')");f.db.run("INSERT INTO store_platforms VALUES(2,'美团外卖','456','2026-01-01')");}
 const job=await f.c.start(date,'remote-test','operating').completion;
 assert.equal(job.status,'failed');assert.ok(!f.trace.includes('browser'));assert.ok(!f.trace.includes('export'));assert.ok(!f.trace.includes('upload'));assert.ok(f.trace.includes('/finish'));
 assert.match(job.code,mode==='hash'?/source_hash_changed/:mode==='metric'?/metric_mismatch/:/coverage_incomplete/);
});

test('a server network or authorization failure cannot be treated as absent source files',async t=>{
 for(const code of ['client_cloud_unreachable','collector_auth_required','client_cloud_receipt_invalid']){
  const f=await fixture(t);f.c.cloud.call=async()=>{f.trace.push('/finish');if(code==='client_cloud_receipt_invalid')return {status:'failed',verification:{storage_verified:true}};throw Error(code);};
  const job=await f.c.start(date,'schedule-recovery','operating').completion;
  assert.equal(job.status,'failed');assert.equal(job.code,code);assert.ok(!f.trace.includes('browser'));
 }
});
