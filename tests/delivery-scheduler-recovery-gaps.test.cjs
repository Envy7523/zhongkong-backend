'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {tick}=require('../syncbot/windows-client/platform-schedule.cjs'),{Cloud}=require('../syncbot/windows-client/cloud.cjs'),core=require('../syncbot/windows-client/core.cjs');

function directory(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'etg-recovery-gaps-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function scheduler(t,stamp='2026-11-03T07:00:00Z'){
 const calls=[],c={root:directory(t),schedule:{},history:[],clock:()=>new Date(stamp),event(){},cloud:{credentials:{scheduleStartDay:'2026-10-24'},config:async(_date,platform)=>({plans:[{report_type:platform+'_operating',enabled:Number(platform==='jd_delivery'),run_time:'02:00'}]})},start(date,source,reportType,platform){calls.push({date,source});const job={date,source,reportType,platform,status:'completed',startedAt:this.clock().toISOString(),finishedAt:this.clock().toISOString()};this.history.push(job);return {job,completion:Promise.resolve(job)};}};
 return {c,calls};
}
function failed(date='2026-11-02',stamp='2026-11-02T18:00:00Z'){return {date,platform:'jd_delivery',reportType:'operating',source:'schedule',status:'failed',code:'client_extension_not_connected',finishedAt:stamp};}

test('recoverable collection resumes after noon without reopening completed work or retrying login',async t=>{
 const {c,calls}=scheduler(t);c.history.push(failed());
 assert.equal(await tick(c),true);assert.equal(calls.length,1);
 assert.equal(await tick(c),false);assert.equal(calls.length,1);
 c.history.at(-1).status='waiting_human';c.history.at(-1).code='client_platform_login_expired';
 assert.equal(await tick(c),false);assert.equal(calls.length,1);
});

test('a prior execution day budget does not permanently strand a recent interrupted business date',async t=>{
 const {c,calls}=scheduler(t,'2026-11-03T01:00:00Z'),date='2026-11-01',key=date+':jd_delivery:operating';
 c.history.push(failed(date,'2026-11-02T03:00:00Z'));
 c.schedule.work={[key]:{count:8,lastAttemptAt:'2026-11-02T03:00:00Z',status:'failed'}};
 await tick(c);assert.deepEqual(calls.map(x=>x.date),['2026-11-02','2026-11-01']);
 assert.equal(c.schedule.work[key].count,1);assert.equal(c.schedule.work[key].attemptDay,'2026-11-03');
 c.history.at(-1).status='failed';c.history.at(-1).code='client_extension_not_connected';c.schedule.work[key].count=8;
 assert.equal(await tick(c),false);assert.equal(calls.length,2);
});

test('a crash between schedule reservation and history write recovers from server proof first',async t=>{
 const {c,calls}=scheduler(t,'2026-11-03T01:00:00Z'),date='2026-11-01',key=date+':jd_delivery:operating';
 c.schedule.work={[key]:{count:1,lastAttemptAt:'2026-11-02T02:00:00Z',status:'running'}};
 await tick(c);assert.deepEqual(calls.map(x=>x.date),['2026-11-02','2026-11-01']);
 assert.equal(c.recoveredState,true);assert.equal(c.schedule.work[key].recoveryReason,'schedule_history_missing');
});

test('late operating proof resolves an earlier unverified product using originals only and preserves first-run history',async t=>{
 const {c,calls}=scheduler(t),original={id:'first-product',date:'2026-11-02',platform:'jd_delivery',reportType:'product',source:'schedule',status:'unverified',result:{sha256:'source-product'},cloudReceipt:{status:'unverified',verification:{storage_verified:true,batch_id:10}}};
 c.history=[original];c.cloud.config=async(_date,platform)=>({version:'scope-one',plans:[{report_type:platform+'_product',enabled:Number(platform==='jd_delivery'),run_time:'02:00'}]});
 let checks=0;c.cloud.call=async(route,body)=>{assert.equal(route,'/finish');assert.equal(body.type,'product');checks++;const ready=c.history.some(j=>j.reportType==='operating');return {status:ready?'success':'unverified',verification:{storage_verified:true,batch_id:10}};};
 assert.equal(await tick(c),true);assert.equal(c.history.at(-1).status,'unverified');
 assert.equal(await tick(c),false);assert.equal(checks,1);
 c.history.push({id:'later-operating',date:original.date,platform:'jd_delivery',reportType:'operating',status:'completed',result:{sha256:'source-operating'},cloudReceipt:{verification:{storage_verified:true,batch_id:11}}});
 assert.equal(await tick(c),true);assert.equal(checks,2);assert.equal(c.history.at(-1).status,'completed');assert.equal(c.history.at(-1).source,'verification-refresh');
 assert.equal(original.status,'unverified');assert.equal(calls.length,0);assert.equal(await tick(c),false);assert.equal(checks,2);
});

test('source mismatch during dependency readback stays unverified and cannot trigger an export or loop',async t=>{
 const {c,calls}=scheduler(t),date='2026-11-02';c.history=[{id:'one',date,platform:'jd_delivery',reportType:'operating',status:'unverified',result:{sha256:'original'}}];
 let checks=0;c.cloud.call=async()=>{checks++;throw Error('collector_source_hash_changed');};
 assert.equal(await tick(c),false);assert.equal(await tick(c),false);assert.equal(checks,1);assert.equal(calls.length,0);assert.equal(c.history[0].status,'unverified');
});

function cloud(t,fetchImpl){const root=directory(t);core.atomic(path.join(root,'cloud-device.json'),{origin:'http://127.0.0.1',token:'a'.repeat(64)});return new Cloud(root,{fetchImpl});}
const response=(status,data)=>({status,ok:status>=200&&status<300,json:async()=>data});
const scope={ok:true,date:'2026-11-02',account:'test',bindings:[],missing:[],version:'b'.repeat(64)};
test('an explicitly rejected old telemetry event is archived and cannot block the fresh authoritative scope',async t=>{
 const routes=[],c=cloud(t,async(url,options)=>{routes.push(url.split('/delivery-client')[1]);if(url.endsWith('/event'))return response(409,{error:'collector_event_invalid'});return response(200,scope);});
 c.outbox=[{type:'invalid-old-type',date:'2026-11-01',status:'failed'}];
 assert.equal((await c.config(scope.date)).version,scope.version);
 assert.equal(c.outbox.length,0);assert.equal(core.read(path.join(c.root,'blocked-cloud-events.json'),[])[0].reason,'collector_event_invalid');
 assert.equal(routes.length,2);
});

test('overlapping telemetry flushes send each queued event once and keep later failures durable',async t=>{
 const sent=[];let release;const pending=new Promise(resolve=>{release=resolve;});
 const c=cloud(t,async(_url,options)=>{const body=JSON.parse(options.body);sent.push(body.date);if(sent.length===1)await pending;if(body.date==='2026-11-02')return response(503,{});return response(200,{ok:true});});
 c.outbox=[{date:'2026-11-01'},{date:'2026-11-02'}];
 const first=c.flush(),second=c.flush();release();await Promise.allSettled([first,second]);
 assert.deepEqual(sent,['2026-11-01','2026-11-02']);assert.deepEqual(c.outbox,[{date:'2026-11-02'}]);
 assert.deepEqual(core.read(c.outboxFile,[]),c.outbox);
});

test('telemetry authentication failures are never discarded or treated as a fresh authorized scope',async t=>{
 let calls=0;const c=cloud(t,async()=>{calls++;return response(401,{error:'collector_auth_required'});});c.outbox=[{date:'2026-11-02',status:'running'}];
 await assert.rejects(c.config(scope.date),/collector_auth_required/);assert.equal(calls,1);assert.equal(c.outbox.length,1);assert.equal(fs.existsSync(path.join(c.root,'blocked-cloud-events.json')),false);
});

test('finishing after a network recovery drains old run events before success so the next scope read cannot regress it',async t=>{
 let online=false,serverStatus='idle';const calls=[],c=cloud(t,async(url,options)=>{
  const route=url.split('/delivery-client')[1];calls.push(route);
  if(route==='/event'){if(!online)throw Error('network down');serverStatus=JSON.parse(options.body).status;return response(200,{ok:true});}
  if(route==='/finish'){serverStatus='success';return response(200,{ok:true,status:'success',verification:{storage_verified:true}});}
  return response(200,scope);
 });
 await c.event({type:'operating',date:scope.date,status:'running'});assert.equal(c.outbox.length,1);
 online=true;await c.call('/finish',{type:'operating',date:scope.date,scope_version:scope.version});
 assert.equal(serverStatus,'success');assert.equal(c.outbox.length,0);
 await c.config(scope.date);assert.equal(serverStatus,'success');assert.deepEqual(calls.slice(1,3),['/event','/finish']);
});

test('dependency readback also drains queued failures before recording its successful verification',async t=>{
 const {c}=scheduler(t);let online=false,serverStatus='unverified';const remote=cloud(t,async(url,options)=>{
  if(url.endsWith('/event')){if(!online)throw Error('offline');serverStatus=JSON.parse(options.body).status;return response(200,{ok:true});}
  if(url.endsWith('/finish')){serverStatus='success';return response(200,{ok:true,status:'success',verification:{storage_verified:true}});}
  return response(200,scope);
 });
 await remote.event({platform:'jd_delivery',type:'operating',date:scope.date,status:'failed',error:'client_cloud_unreachable'});
 remote.config=c.cloud.config;c.cloud=remote;c.history=[{id:'old',platform:'jd_delivery',reportType:'operating',date:scope.date,status:'unverified',result:{sha256:'source'}}];
 online=true;assert.equal(await tick(c),true);assert.equal(c.history.at(-1).source,'verification-refresh');assert.equal(serverStatus,'success');assert.equal(remote.outbox.length,0);
 await remote.flush();assert.equal(serverStatus,'success');
});

test('finish cannot bypass a pending event authorization failure',async t=>{
 const routes=[],c=cloud(t,async url=>{routes.push(url.split('/delivery-client')[1]);return response(401,{error:'collector_auth_required'});});
 c.outbox=[{type:'operating',date:scope.date,status:'running'}];
 await assert.rejects(c.call('/finish',{type:'operating',date:scope.date,scope_version:scope.version}),/collector_auth_required/);
 assert.deepEqual(routes,['/event']);assert.equal(c.outbox.length,1);
});
