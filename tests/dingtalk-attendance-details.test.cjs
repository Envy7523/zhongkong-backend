'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),moduleUnderTest=require('../lib/dingtalk-attendance-details');
function fixture(){const raw=new DatabaseSync(':memory:'),db={run:(q,p=[])=>raw.prepare(q).run(...p),queryAll:(q,p=[])=>raw.prepare(q).all(...p),queryOne:(q,p=[])=>raw.prepare(q).get(...p)||null,save(){},close:()=>raw.close()};db.run('CREATE TABLE employees(id INTEGER,dingtalk_user_id TEXT)');db.run("INSERT INTO employees VALUES(1,'u1')");moduleUnderTest.initialize(db);return db;}
const row={record_key:'key',dingtalk_user_id:'u1',work_date:'2026-11-01',check_type:'OnDuty',time_result:'Late',plan_check_time:'2026-11-01 09:00:00',user_check_time:'2026-11-01 09:10:00',source_data:'{}'};
function source(p){return {complete:true,from:p.from,to:p.to,employee_count:p.mapped.length,results:[row],approvals:[{instance_id:'leave',process_code:'p',template_name:'请假申请',detail:{originatorUserId:'u1',status:'COMPLETED',result:'agree',formComponentValues:[{componentType:'DDHolidayField',value:'["2026-11-01 09:00","2026-11-01 12:00",3,"hour","病假"]'}]}}],coverage:p.templates.map(t=>({template_name:t.template_name,complete:true,listed:0})),api_calls:1};}
test('full snapshot replaces results in its exact window, updates approval state and is idempotent',async()=>{
 const db=fixture();try{const service=moduleUnderTest.service(db,{read:async p=>source(p),clock:()=>new Date('2026-11-02T02:00:00Z')});for(let i=0;i<2;i++)assert.equal((await service.sync({from:'2026-11-01',to:'2026-11-01'})).result_count,1);assert.equal(db.queryOne('SELECT COUNT(*) n FROM dingtalk_attendance_results').n,1);assert.equal(db.queryOne('SELECT employee_id FROM dingtalk_attendance_results').employee_id,1);assert.equal(db.queryOne('SELECT result FROM dingtalk_approval_instances').result,'agree');assert.equal(db.queryOne("SELECT COUNT(*) n FROM dingtalk_detail_sync_runs WHERE status='success'").n,2);}finally{db.close();}
});
test('incomplete or out-of-scope source cannot remove previous results or create a success receipt',async()=>{
 const db=fixture();try{let invalid=false;const service=moduleUnderTest.service(db,{read:async p=>{const s=source(p);if(invalid)s.results=[{...row,dingtalk_user_id:'other'}];return s;},clock:()=>new Date('2026-11-02T02:00:00Z')});await service.sync({from:'2026-11-01',to:'2026-11-01'});invalid=true;await assert.rejects(service.sync({from:'2026-11-01',to:'2026-11-01'}),/scope_invalid/);assert.equal(db.queryOne('SELECT COUNT(*) n FROM dingtalk_attendance_results').n,1);assert.equal(db.queryOne("SELECT COUNT(*) n FROM dingtalk_detail_sync_runs WHERE status='failed'").n,1);}finally{db.close();}
});
test('reader rejects a truncated pagination response before any approval calls',async()=>{
 const reader=moduleUnderTest.reader({getToken:async()=> 'test-token',sleep:async()=>{},fetchImpl:async()=>({ok:true,status:200,text:async()=>JSON.stringify({errcode:0,recordresult:[]})})});await assert.rejects(reader({from:'2026-11-01',to:'2026-11-01',mapped:[{dingtalk_user_id:'u1'}],operator:'u1',templates:[]}),/incomplete_response/);
});
test('internal import refuses anonymous and proxied callers before reading or syncing',async()=>{
 let handler,calls=0;moduleUnderTest.mountInternal({app:{post(p,raw,h){handler=h;}},express:{raw:()=>()=>{}},db:{},audit:{},details:{sync:async()=>calls++}});const res={status(n){assert.equal(n,401);return this;},json(){}};await handler({get:()=>'',socket:{remoteAddress:'10.0.0.1'}},res);await handler({get:k=>k==='x-forwarded-for'?'1.2.3.4':'',socket:{remoteAddress:'127.0.0.1'}},res);assert.equal(calls,0);
});
test('manual requests return pending promptly; scheduled requests wait for completion and propagate failure',async()=>{
 let resolve,calls=0;const details={status:()=>({busy:false}),sync:()=>{calls++;return new Promise(r=>resolve=r);}};
 const manual=await moduleUnderTest.forRequest(details,{from:'2026-11-01',to:'2026-11-01'},{wait:false});assert.equal(manual.pending,true);assert.equal(calls,1);resolve({complete:true});
 let done=false;const automatic=moduleUnderTest.forRequest(details,{}).then(r=>{done=true;return r;});await Promise.resolve();assert.equal(done,false);resolve({complete:true});assert.equal((await automatic).complete,true);
 let reported=false;await moduleUnderTest.forRequest({status:()=>({busy:false}),sync:async()=>{throw Error('test_failure')}},{},{wait:false,onError:()=>{reported=true}});await Promise.resolve();assert.equal(reported,true);
 await assert.rejects(moduleUnderTest.forRequest({sync:async()=>{throw Error('test_failure')}},{}),/test_failure/);
 const skipped=await moduleUnderTest.forRequest({status:()=>({busy:true}),sync(){throw Error('duplicate_request')}},{},{wait:false});assert.equal(skipped.already_running,true);
});
