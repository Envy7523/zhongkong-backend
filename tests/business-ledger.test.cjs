const {test,before}=require('node:test');
const assert=require('node:assert/strict');
const init=require('sql.js');
const express=require('express');
const L=require('../lib/business-ledger');
let SQL;before(async()=>{SQL=await init();});
function fixture(snapshot={employee_id:1,name:'甲',complete:true,all_approved:true,totals:{net_salary:5000},contributions:[]}) {
 const raw=new SQL.Database();raw.run('PRAGMA foreign_keys=ON');
 const db={exec:s=>raw.run(s),run:(s,p=[])=>{raw.run(s,p);return raw.getRowsModified();},queryAll:(s,p=[])=>{const q=raw.prepare(s);q.bind(p);const rows=[];while(q.step())rows.push(q.getAsObject());q.free();return rows;},save:()=>{}};
 db.queryOne=(s,p)=>db.queryAll(s,p)[0]||null;db.insert=(s,p)=>{db.run(s,p);return db.queryOne('SELECT last_insert_rowid() id').id;};
 db.exec(`CREATE TABLE stores(id INTEGER PRIMARY KEY,store_name TEXT);INSERT INTO stores VALUES(1,'A'),(2,'B');
 CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,store_id INTEGER,position_id INTEGER,employee_id INTEGER);
 CREATE TABLE employees(id INTEGER PRIMARY KEY,name TEXT,status TEXT,leave_date TEXT,onboarding_status TEXT);
 INSERT INTO employees VALUES(1,'甲','在职','',''),(2,'甲','在职','','');
 CREATE TABLE position_settings(id INTEGER PRIMARY KEY,name TEXT,permissions_json TEXT,is_system INTEGER DEFAULT 0);
 INSERT INTO position_settings VALUES(1,'管理员','["*"]',1),(2,'员工','[]',0),(3,'财务','["finance.payments.manage"]',0);
 INSERT INTO users VALUES(1,'admin','管理员',NULL,1,NULL),(2,'person-a','甲',1,2,1),(3,'person-b','甲',2,2,2),(4,'finance-a','财务',1,3,NULL);
 CREATE TABLE user_positions(user_id INTEGER,position_id INTEGER);
 INSERT INTO user_positions VALUES(1,1),(2,2),(3,2),(4,3);`);
 require('../lib/personnel-access').initialize(db);L.initialize(db);
 const actor=id=>L.actorFor(db,{id}),service=L.create(db,{buildPayslip:()=>snapshot});
 const body={source:'wecom',entity:'主体A',source_no:'sp-001',title:'维修费',amount:'100.00',beneficiary:'收款人',account:'1234567890',store_id:1};
 return {db,raw,actor,service,body,snapshot};
}
test('请款归属、重复审批和本人/财务门店隔离',()=>{
 const f=fixture(),a=f.actor(2),b=f.actor(3),finance=f.actor(4),r=f.service.addRequest(a,f.body);
 assert.equal(r.state,'unverified');assert.equal(r.account,'****7890');
 assert.throws(()=>f.service.addRequest(a,f.body),e=>e.status===409);
 assert.throws(()=>f.service.request(r.id,b),e=>e.status===403);
 assert.throws(()=>f.service.addRequest(a,{...f.body,source_no:'other',store_id:2}),e=>e.status===403);
 assert.equal(f.service.present(f.service.request(r.id,finance),finance).account,'1234567890');
 const second=f.service.addRequest(b,{...f.body,source_no:'b',store_id:2});assert.throws(()=>f.service.request(second.id,finance,true),e=>e.status===403);
 assert.throws(()=>f.service.action(a,r.id,{version:1,action:'verify',note:'自批'}),e=>e.status===403);
});
test('付款必须先核验，部分付款/幂等/超付/撤销/冲销分别处理',()=>{
 const f=fixture(),admin=f.actor(1),r=f.service.addRequest(f.actor(2),f.body);
 const p={version:r.version,amount:'40',paid_on:'2026-10-01',reference:'银行流水A',idempotency_key:'payment-001'};
 assert.throws(()=>f.service.payment(admin,r.id,p),/未核实/);
 const checked=f.service.action(admin,r.id,{version:1,action:'verify',note:'核验原单与历史付款，无历史支出'});
 const partial=f.service.payment(admin,r.id,{...p,version:checked.version});assert.equal(partial.state,'partial');assert.equal(partial.remaining_cents,6000);
 assert.equal(f.service.payment(admin,r.id,p).payments.length,1,'网络重试不重复付款');
 assert.throws(()=>f.service.payment(admin,r.id,{...p,amount:'41'}),e=>e.status===409);
 assert.throws(()=>f.service.payment(admin,r.id,{...p,version:partial.version,amount:'61',idempotency_key:'payment-002'}),/不超过/);
 const paid=f.service.payment(admin,r.id,{...p,version:partial.version,amount:'60',idempotency_key:'payment-002'});assert.equal(paid.state,'paid');
 const reversed=f.service.reverse(admin,r.id,paid.payments[1].id,{version:paid.version,note:'银行退回，更正记账'});assert.equal(reversed.state,'partial');assert(reversed.payments[1].reversed_at);
 const revoked=f.service.action(admin,r.id,{version:reversed.version,action:'revoke',note:'源审批撤销'});assert.equal(revoked.paid_cents,4000);assert.equal(revoked.state,'revoked');
 assert.throws(()=>f.service.payment(admin,r.id,{...p,version:revoked.version,idempotency_key:'payment-003'}),/未核实/);
});
test('历史缺少付款记录不判未付，核验和版本冲突均有审计',()=>{
 const f=fixture(),r=f.service.addRequest(f.actor(2),{...f.body,historical:true});assert.equal(r.state,'history_unverified');
 assert.throws(()=>f.service.action(f.actor(1),r.id,{version:0,action:'verify',note:'核验'}),e=>e.status===409);
 const v=f.service.action(f.actor(1),r.id,{version:1,action:'verify',note:'已核查全部历史流水，没有付款'});assert.equal(v.state,'unpaid');
 const audit=f.db.queryAll('SELECT * FROM operation_audit');assert.equal(audit.length,2);assert(!audit.some(r=>(r.before_json+r.after_json).includes('1234567890')));
 assert.throws(()=>L.money('1.001'));assert.throws(()=>L.money('-1'));assert.equal(L.money('0.01'),1);
});
test('工资条只发布已审核完整快照，同名不能串看或代签',()=>{
 const f=fixture(),a=f.actor(2),b=f.actor(3),admin=f.actor(1);
 assert.throws(()=>f.service.publish(a,{employee_id:1,period:'2026-10'}),e=>e.status===403);
 f.snapshot.all_approved=false;assert.throws(()=>f.service.publish(admin,{employee_id:1,period:'2026-10'}),/全部审核/);f.snapshot.all_approved=true;
 const slip=f.service.publish(admin,{employee_id:1,period:'2026-10'});assert.equal(slip.revision,1);
 assert.equal(f.service.publish(admin,{employee_id:1,period:'2026-10'}).id,slip.id);
 assert.throws(()=>f.service.payslip(slip.id,b),e=>e.status===403);
 assert.throws(()=>f.service.receipt(a,slip.id,{action:'confirm',content_hash:slip.content_hash,confirmation_name:'甲',accept:false}),/主动确认/);
 assert.throws(()=>f.service.receipt(a,slip.id,{action:'confirm',content_hash:'old',confirmation_name:'甲',accept:true}),e=>e.status===409);
 const confirmed=f.service.receipt(a,slip.id,{action:'confirm',content_hash:slip.content_hash,confirmation_name:'甲',accept:true});assert(confirmed.confirmed_at);
 assert.equal(f.service.receipt(a,slip.id,{action:'confirm',content_hash:slip.content_hash,confirmation_name:'甲',accept:true}).confirmed_at,confirmed.confirmed_at);
 f.service.receipt(a,slip.id,{action:'objection',content_hash:slip.content_hash,note:'金额未到账，需核对'});assert(f.db.queryOne('SELECT objection_at FROM payslip_receipts').objection_at);
 f.snapshot.totals.net_salary=5100;assert.throws(()=>f.service.publish(admin,{employee_id:1,period:'2026-10'}),/填写原因/);
 const corrected=f.service.publish(admin,{employee_id:1,period:'2026-10',reason:'绩效更正'});assert.equal(corrected.revision,2);
 assert(f.db.queryOne('SELECT withdrawn_at FROM published_payslips WHERE id=?',[slip.id]).withdrawn_at);
 assert.throws(()=>f.service.receipt(a,slip.id,{action:'confirm',content_hash:slip.content_hash,confirmation_name:'甲',accept:true}),e=>e.status===409);
 assert.equal(f.db.queryOne('SELECT * FROM payslip_receipts WHERE payslip_id=?',[corrected.id]),null);
});
test('真实HTTP：未登录、未同意、越权、mini管理入口和日志查询均受控',async()=>{
 const f=fixture(),app=express();app.use(express.json());app.use((req,res,next)=>{const id=Number(req.headers['x-fixture-user']);if(!id)return res.status(401).json({error:'未登录'});req.user={id};next();});
 let sourceReads=0;const approvalRefresh=require('../lib/finance-approval-refresh').create({db:f.db,reader:async()=>{sourceReads++;throw Object.assign(new Error('隔离样本源平台不可用'),{status:502})}});
 app.use('/api/business-ledger',require('../lib/business-ledger-router').createRouter({db:f.db,approvalRefresh,buildPayslip:()=>f.snapshot}));
 app.use('/api/mp/business-ledger',require('../lib/business-ledger-router').createRouter({db:f.db,channel:'mini'}));require('../lib/operation-audit').mount(app,f.db);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const call=async(path,user=2,body)=>{const res=await fetch(base+path,{method:body?'POST':'GET',headers:{'x-fixture-user':String(user),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await res.text();return {status:res.status,cache:res.headers.get('cache-control'),body:res.headers.get('content-type')?.includes('application/json')?JSON.parse(value):value};};
 try{
  assert.equal((await call('/api/business-ledger/context',0)).status,401);
  assert.equal((await call('/api/business-ledger/payslips/mine')).status,403);
  assert.equal((await call('/api/business-ledger/payslips/consent',2,{accept:false,version:L.PAYSLIP_PRIVACY_VERSION})).status,400);
  assert.equal((await call('/api/business-ledger/payslips/consent',2,{accept:true,version:'old'})).status,400);
  assert.equal((await call('/api/business-ledger/payslips/consent',2,{accept:true,version:L.PAYSLIP_PRIVACY_VERSION})).status,200);
  assert.equal((await call('/api/business-ledger/payslips/mine')).status,200);
  assert.equal((await call('/api/business-ledger/payslips?period=2026-10',2)).status,403);
  assert.equal((await call('/api/business-ledger/integrations',2)).status,403);
  assert.equal((await call('/api/business-ledger/approvals?period=2026-10',2)).status,403);
  assert.equal((await call('/api/business-ledger/approvals?period=2026-10',4)).status,403);
  assert.equal((await call('/api/business-ledger/approvals?period=2026-10',1)).status,200);
  const snapshot=await call('/api/business-ledger/approvals?period=2026-10',1);assert.match(snapshot.cache,/no-store/);assert(snapshot.body.queried_at);assert.equal(sourceReads,0);
  for(const user of [2,4])assert.equal((await call('/api/business-ledger/approvals/query',user,{period:'2026-10'})).status,403);
  const query=await call('/api/business-ledger/approvals/query',1,{period:'2026-10'});assert.equal(query.status,200);assert.equal(sourceReads,1);
  const queryResult=await call('/api/business-ledger/approvals/query/'+query.body.job.id,1);assert.match(queryResult.cache,/no-store/);assert.equal(queryResult.body.job.status,'failed');assert.equal(queryResult.body.job.result,undefined);
  assert.equal((await call('/api/mp/business-ledger/approvals/query',1,{period:'2026-10'})).status,404);
  for(const channel of ['/api/business-ledger','/api/mp/business-ledger'])for(const user of [1,2,4])for(const path of ['/requests','/requests/1/action','/requests/1/payments','/requests/1/payments/1/reverse']){
   const retired=await call(channel+path,user,{source:'dingtalk',trustedSource:true,confirm:true,action:'verify'});assert.equal(retired.status,410);assert.equal(retired.body.code,'MANUAL_FINANCE_RETIRED');
  }
  assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM finance_requests').n,0);
  assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM finance_payments').n,0);
  assert.equal((await call('/api/operation-audit',2)).status,403);
  assert.equal((await call('/api/operation-audit',1)).status,200);
  assert.equal((await call('/api/mp/business-ledger/payslips?period=2026-10',1)).status,404);
  const slip=f.service.publish(f.actor(1),{employee_id:1,period:'2026-10'});
  assert.equal((await call('/api/business-ledger/payslips/mine/'+slip.id,2)).status,200);
  assert.equal((await call('/api/business-ledger/payslips/consent',3,{accept:true,version:L.PAYSLIP_PRIVACY_VERSION})).status,200);
  assert.equal((await call('/api/business-ledger/payslips/mine/'+slip.id,3)).status,403);
 }finally{await new Promise(r=>server.close(r));f.raw.close();}
});

test('真实HTTP：付款凭证上传、下载、完成及源门店对应权限闭环',async(t)=>{
 const f=fixture(),S=require('../lib/finance-approval-summaries'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'finance-approval-http-'));t.after(()=>{for(const n of fs.readdirSync(root))fs.unlinkSync(path.join(root,n));fs.rmdirSync(root);});
 f.db.run("INSERT INTO users VALUES(5,'full-finance','完整财务',NULL,3,NULL)");f.db.run('INSERT INTO user_positions VALUES(5,3)');
 const item={platform:'dingtalk',tenant_key:'a'.repeat(64),instance_id:'http-fixture',template_id:'fixture-template',template_name:'隔离模板',business_no:'fixture-001',applicant_external_id:'fixture-person',applicant_name:'隔离样本',department:'source-dept',source_department_id:'90071992547409999',title:'隔离测试',reason:'维修费',amount_cents:100,amount_note:'',source_status:'COMPLETED',source_result:'agree',source_created_at:'2026-10-01',source_finished_at:'2026-10-02'};
 S.importBatch(f.db,{format:'finance-approval-summary-v1',platform:item.platform,tenant_key:item.tenant_key,date_from:'2026-10-01',date_to:'2026-10-28',fetched_at:'2026-10-28T08:00Z',complete:true,errors:[],coverage:[{template_id:item.template_id,list_complete:true,listed:1}],items:[item]},f.actor(1));
 const app=express();app.use(express.json());app.use((req,res,next)=>{const id=Number(req.headers['x-fixture-user']);if(!id)return res.status(401).json({error:'未登录'});req.user={id};next();});
 app.use('/api/business-ledger',require('../lib/business-ledger-router').createRouter({db:f.db,proofRoot:root}));app.use('/api/mp/business-ledger',require('../lib/business-ledger-router').createRouter({db:f.db,channel:'mini',proofRoot:root}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port,prefix='/api/business-ledger/approvals/1';
 const call=(url,user=1,method='GET',data,binary=false)=>fetch(base+url,{method,headers:{'x-fixture-user':String(user),'Content-Type':binary?'application/octet-stream':'application/json'},body:data===undefined?undefined:binary?data:JSON.stringify(data)});
 try{
  const image=await require('sharp')({create:{width:2,height:2,channels:3,background:'white'}}).png().toBuffer();
  for(const user of [0,2,4]){assert.equal((await call(prefix+'/proofs',user)).status,user===0?401:403);assert.equal((await call(prefix+'/proofs?version=1&name=test.png',user,'POST',image,true)).status,user===0?401:403);}
  assert.equal((await call('/api/mp/business-ledger/approvals/1/proofs',1)).status,404);
  const bindingsUrl='/api/business-ledger/approval-store-bindings';
  for(const user of [2,4,5])assert.equal((await call(bindingsUrl,user)).status,403);
  assert.equal((await call('/api/mp/business-ledger/approval-store-bindings',1)).status,404);
  const bindings=await(await call(bindingsUrl,1)).json(),binding=bindings.items[0];assert.equal(binding.record_count,1);
  assert.equal((await call(bindingsUrl+'/'+binding.id,5,'POST',{mapping_version:0,kind:'store',store_id:1,note:'不能让财务改配置'})).status,403);
  assert.equal((await call(bindingsUrl+'/'+binding.id,1,'POST',{mapping_version:0,kind:'store',store_id:1,note:'隔离核对'})).status,200);
  const absent=await call(prefix+'/action',5,'POST',{action:'complete',version:1,confirm:true,note:'未上传'});assert.equal(absent.status,400);assert.match((await absent.json()).error,/必须上传/);
  assert.equal((await call(prefix+'/proofs?version=1&name=fake.png',5,'POST',Buffer.from('bad image'),true)).status,400);
  assert.equal((await call(prefix+'/proofs?version=1&name=large.png',5,'POST',Buffer.alloc(8*1024*1024+1),true)).status,413);
  const uploadUrl=prefix+'/proofs?version=1&name=fixture.png&upload_key=fixture-upload-key-001';
  const upload=await call(uploadUrl,5,'POST',image,true);assert.equal(upload.status,200);const p=(await upload.json()).proof;
  const retry=await call(uploadUrl,5,'POST',image,true);assert.equal(retry.status,200);assert.equal((await retry.json()).proof.id,p.id);assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM finance_approval_proofs').n,1);
  const ownFiles=await(await call(prefix+'/proofs',5)).json(),adminFiles=await(await call(prefix+'/proofs',1)).json();assert.equal(ownFiles.items[0].upload_key,'fixture-upload-key-001');assert(!Object.hasOwn(adminFiles.items[0],'upload_key'));
  for(const user of [0,2,4])assert.equal((await call(prefix+'/proofs/'+p.id,user)).status,user===0?401:403);
  const download=await call(prefix+'/proofs/'+p.id,5);assert.equal(download.status,200);assert.match(download.headers.get('cache-control'),/no-store/);assert.match(download.headers.get('content-disposition'),/^attachment;/);assert.deepEqual(Buffer.from(await download.arrayBuffer()),image);
  assert.equal((await call('/api/business-ledger/approvals/999/proofs/'+p.id,5)).status,404);
  const complete=await call(prefix+'/action',5,'POST',{action:'complete',version:1,confirm:true,note:'隔离核对完成',proof_ids:[p.id]});assert.equal(complete.status,200);assert.equal((await complete.json()).item.state,'completed');
  assert.equal((await call(prefix+'/proofs/'+p.id,5,'DELETE')).status,400);
  const list=await(await call(prefix+'/proofs',5)).json();assert(list.items[0].confirmed_at);assert.equal(list.items[0].can_remove,false);
 }finally{await new Promise(r=>server.close(r));f.raw.close();}
});
test('业务错误回滚并保留原异常；提交后保存失败不伪装回滚',()=>{
 const f=fixture();assert.throws(()=>L.transaction(f.db,()=>{f.db.run("INSERT INTO operation_audit(actor_name,channel,action,resource,created_at) VALUES('x','web','x','x','now')");throw new Error('original')}),/original/);assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM operation_audit').n,0);
 f.db.save=()=>{throw new Error('disk-full')};assert.throws(()=>L.transaction(f.db,()=>f.db.run("INSERT INTO operation_audit(actor_name,channel,action,resource,created_at) VALUES('x','web','x','x','now')")),/disk-full/);
});
test('财务有限门店权限不被另一全门店角色扩大，导入服务身份不新增人员能力',()=>{
 const f=fixture();
 f.db.run("INSERT INTO position_settings VALUES(4,'分析','[\"analysis.view\"]',0)");
 f.db.run('INSERT INTO user_positions VALUES(4,4)');
 f.db.run('INSERT INTO access_person_config VALUES(4,1,?)',[JSON.stringify({channels:['web'],assignments:[{position_id:3,mode:'stores',store_ids:[1],region_ids:[]},{position_id:4,mode:'all',store_ids:[],region_ids:[]}]})]);
 const a=f.actor(4);assert.equal(L.inScope(f.db,a,'finance.payments.manage',1),true);assert.equal(L.inScope(f.db,a,'finance.payments.manage',2),false);
 const caps=require('../lib/common-capabilities');assert.deepEqual(caps.forUser({username:'syncbot_importer'},['business_analytics.import']),[]);assert(caps.forUser({username:'employee'},[]).includes('collab.manage'));
});
test('企微单据读取、重复核验、已付款冲突和原件留痕使用隔离适配器',async()=>{
 const f=fixture(),admin=f.actor(1);let amount='100',state=2,calls=0;
 const env={WECOM_APPROVAL_CORP_ID:'fixture-corp',WECOM_APPROVAL_SECRET:'fixture-secret',FINANCE_APPROVAL_TEMPLATES:JSON.stringify([{key:'finance',platform:'wecom',entity:'主体A',template_id:'finance-template',amount_field:'amount',account_field:'account',beneficiary_field:'beneficiary',store_id:1}])};
 const adapter=require('../lib/finance-integrations').create({db:f.db,env,fetchImpl:async url=>{calls++;return {ok:true,json:async()=>url.includes('/gettoken?')?{access_token:'fixture-token'}:{errcode:0,info:{sp_status:state,template_id:'finance-template',applyer:{userid:'source-employee'},apply_data:{contents:[{id:'amount',value:{new_money:amount}},{id:'account',value:{text:'1234567890'}},{id:'beneficiary',value:{text:'收款人'}}]}}}};}});
 const input={template_key:'finance',source_no:'external001',requester_id:2,historical:true};
 const r=await adapter.importApproval(admin,input,f.service);assert.equal(r.item.state,'history_unverified');assert.equal(r.item.requester_id,2);assert(!JSON.stringify(adapter.status()).includes('fixture-secret'));
 let row=f.service.action(admin,r.item.id,{version:r.item.version,action:'verify',note:'核查原审批及全部历史付款'});
 row=f.service.payment(admin,row.id,{version:row.version,amount:'20',paid_on:'2026-10-01',reference:'流水',idempotency_key:'external-payment'});
 amount='200';const refresh=await adapter.importApproval(admin,input,f.service);assert.equal(refresh.item.state,'conflict');assert.equal(refresh.item.amount_cents,10000);assert.equal(refresh.item.payments[0].account,'1234567890');
 assert.throws(()=>f.service.action(admin,row.id,{version:refresh.item.version,action:'verify',note:'试图忽略冲突'}),/来源冲突/);
 assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM finance_requests').n,1);assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM finance_source_observations').n,2);
 state=4;const revoke=await adapter.importApproval(admin,input,f.service);assert.equal(revoke.item.approval_state,'revoked');assert.equal(revoke.item.paid_cents,2000);assert.equal(calls,6);
});
test('钉钉详情未带模板号时校验实例列表归属，分页失败不写单',async()=>{
 const f=fixture();let listed='ding001';const env={FINANCE_APPROVAL_TEMPLATES:JSON.stringify([{key:'ding',platform:'dingtalk',entity:'主体A',template_id:'process-finance',amount_field:'金额',account_field:'账户',beneficiary_field:'户名',store_id:1}])};
 const adapter=require('../lib/finance-integrations').create({db:f.db,env,getDingToken:async()=>'fixture-token',fetchImpl:async(url,options)=>({ok:true,json:async()=>url.includes('/instanceIds/query')?{result:{list:[listed],nextToken:null}}:{result:{createTime:'2026-10-01T10:00:00+08:00',status:'COMPLETED',result:'agree',originatorUserId:'source',formComponentValues:[{name:'金额',value:'100'},{name:'账户',value:'1234567890'},{name:'户名',value:'收款人'}]}}})});
 const result=await adapter.importApproval(f.actor(1),{template_key:'ding',source_no:'ding001',requester_id:2},f.service);assert.equal(result.item.source,'dingtalk');
 listed='unrelated';await assert.rejects(adapter.importApproval(f.actor(1),{template_key:'ding',source_no:'ding002',requester_id:2},f.service),/未确认/);assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM finance_requests').n,1);
});
test('工资提醒只发唯一绑定个人，接受消息不等于签收，未知结果禁止重复发',async()=>{
 const f=fixture(),a=f.actor(1);f.db.exec("CREATE TABLE mp_identities(id INTEGER PRIMARY KEY,user_id INTEGER,identity_type TEXT,identity_id TEXT,status TEXT);INSERT INTO mp_identities VALUES(1,2,'wxwork','fixture-member','active')");
 let calls=0,loseResponse=false,lastMessage;
 const env={WECOM_PAYSLIP_CORP_ID:'fixture-corp',WECOM_PAYSLIP_SECRET:'fixture-secret',WECOM_PAYSLIP_AGENT_ID:'123',PAYSLIP_PORTAL_URL:'https://example.test/'};
 const adapter=require('../lib/finance-integrations').create({db:f.db,env,fetchImpl:async(url,options)=>{calls++;if(url.includes('/message/send')){lastMessage=JSON.parse(options.body);if(loseResponse)throw new Error('fixture-timeout');}return {ok:true,json:async()=>url.includes('/gettoken?')?{access_token:'fixture-token'}:{errcode:0,msgid:'fixture-message'}};}});
 const slip=f.service.publish(a,{employee_id:1,period:'2026-10'});await adapter.remind(a,slip);assert.equal(lastMessage.touser,'fixture-member');assert(lastMessage.text.content.includes('https://example.test/my/payslips'));assert(!JSON.stringify(lastMessage).includes('5000'));
 assert.equal(f.db.queryOne('SELECT * FROM payslip_receipts'),null);await adapter.remind(a,slip);assert.equal(calls,2);
 f.snapshot.totals.net_salary=5100;const corrected=f.service.publish(a,{employee_id:1,period:'2026-10',reason:'更正'});loseResponse=true;await assert.rejects(adapter.remind(a,corrected),/fixture-timeout/);assert.equal(f.db.queryOne('SELECT state FROM payslip_deliveries WHERE payslip_id=?',[corrected.id]).state,'unknown');await assert.rejects(adapter.remind(a,corrected),/待核实/);assert.equal(calls,4);
});
