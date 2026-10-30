const {test,before}=require('node:test'),assert=require('node:assert/strict'),init=require('sql.js');
const R=require('../lib/finance-approval-refresh'),S=require('../lib/finance-approval-summaries'),L=require('../lib/business-ledger');
let SQL;before(async()=>SQL=await init());
function fixture(){const raw=new SQL.Database(),db={exec:s=>raw.exec(s),run:(s,p=[])=>{raw.run(s,p);return raw.getRowsModified()},queryAll:(s,p=[])=>{const q=raw.prepare(s);q.bind(p);const out=[];while(q.step())out.push(q.getAsObject());q.free();return out},save(){}};db.queryOne=(s,p)=>db.queryAll(s,p)[0]||null;db.insert=(s,p)=>{db.run(s,p);return db.queryOne('SELECT last_insert_rowid() n').n};L.initialize(db);return {raw,db,actor:{id:1,admin:true,username:'fixture-finance',can:()=>true}};}
const fixed=Date.parse('2026-10-28T10:00:00Z');
function source(db,{failDetail=false,stalled=false}={}){
 const calls=[];const reader=R.createDingtalkReader({db,now:()=>fixed,spacing:0,sleep:async()=>{},getToken:async()=>'test-token',env:{DINGTALK_APP_KEY:'test-key',DINGTALK_APP_SECRET:'test-secret',DINGTALK_CORP_ID:'test-corp',DINGTALK_SCHEDULE_OPERATOR_ID:'test-operator'},fetchImpl:async(url,options)=>{
  calls.push({url,body:options.body&&JSON.parse(options.body)});let data;
  if(url.includes('/templates?'))data={result:{processList:[{name:'鹅太公费用报销单',processCode:'expense'},{name:'批量付款',processCode:'bulk'}]}};
  else if(url.includes('/instanceIds/query')){const b=JSON.parse(options.body);data={result:{list:b.processCode==='bulk'?[]:b.nextToken===0?['one']:['two'],nextToken:b.processCode==='bulk'?null:b.nextToken===0?1:stalled?1:null}};}
  else {if(failDetail)return new Response('{"code":"Forbidden"}',{status:403});const id=new URL(url).searchParams.get('processInstanceId');data={result:{title:'测试员工提交的鹅太公费用报销单',originatorUserId:'external-person',originatorDeptId:'LONG_ID',originatorDeptName:'测试部门',businessId:'2026100000000000001',status:id==='one'?'RUNNING':'COMPLETED',result:'agree',createTime:'2026-10-02T10:00Z',formComponentValues:[{componentType:'TableField',name:'费用明细',extValue:'{"statValue":[{"label":"总报销金额(元)","num":0.29}]}'},{name:'申请事由',value:'维修费'},{componentType:'RecipientAccountField',name:'收款账户',value:'never-store-account'}]}};}
  return new Response(JSON.stringify(data).replace('"LONG_ID"','90071992547409931'),{status:200});
 }});return {reader,calls};
}
async function completed(service,a,id){for(let n=0;n<50;n++){const j=service.status(a,id);if(j.status!=='running')return j;await new Promise(setImmediate)}throw new Error('fixture job did not settle');}
test('无损源JSON与金额转换保留长ID和分精度，字符串内数字不改变',()=>{
 const parsed=R.losslessJson('{"id":90071992547409931,"v":0.29,"text":"a\\\"123\\\\b","ok":true,"nil":null}');assert.equal(parsed.id,'90071992547409931');assert.equal(parsed.v,'0.29');assert.equal(parsed.text,'a"123\\b');assert.equal(parsed.ok,true);assert.equal(parsed.nil,null);
 for(const [v,want] of [['0.29',29],['1.2300',123],['1e2',10000],['1.2e-1',12],['1.001',null],['-1',null],['NaN',null],['1000000000',null]])assert.equal(R.cents(v),want,v);
 assert.equal(R.amount([{componentType:'TableField',extValue:'{"statValue":[{"label":"总报销金额(元)","num":1.001}]}'}]).amount_cents,null);
});
test('月查询范围使用北京时间，历史整月和当月截至点击时间，未来月份不发请求',()=>{
 const r=R.range('2026-10',fixed);assert.equal(r.start,Date.parse('2026-10-01T00:00:00+08:00'));assert.equal(r.end,fixed);assert.equal(r.date_to,'2026-10-28');
 assert.equal(R.range('2026-09',fixed).end,Date.parse('2026-10-01T00:00:00+08:00')-1);assert.throws(()=>R.range('2026-11',fixed));assert.throws(()=>R.range('2026-13',fixed));
});
test('完整读取多页及详情，只保留摘要，进行中agree不误判通过',async()=>{
 const f=fixture(),s=source(f.db),progress=[],batch=await s.reader('2026-10',p=>progress.push(p));assert.equal(batch.items.length,2);assert.equal(batch.coverage.length,2);assert.equal(batch.coverage[0].listed,2);assert.equal(batch.coverage[1].listed,0);
 assert.equal(batch.items[0].source_department_id,'90071992547409931');assert.equal(batch.items[0].amount_cents,29);assert.equal(batch.items[0].applicant_name,'测试员工');assert.equal(S.sourceStage(batch.items[0].source_status,batch.items[0].source_result),'in_progress');assert(!JSON.stringify(batch).includes('never-store-account'));assert.equal(batch.source_writes,0);assert.equal(progress.at(-1).done,2);
});
test('分页停滞和详情权限失败拒绝整批，不导入残缺源数据',async()=>{
 for(const options of [{stalled:true},{failDetail:true}]){const f=fixture(),s=source(f.db,options);await assert.rejects(s.reader('2026-10'));assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM finance_approval_import_runs').n,0);}
});
test('仅明确start才访问平台；先同步后返回查询，隔离其他人任务及重复同步',async()=>{
 const f=fixture(),s=source(f.db);let calls=0,release;const gate=new Promise(r=>release=r),service=R.create({db:f.db,now:()=>fixed,reader:async(...args)=>{calls++;await gate;return s.reader(...args)}});
 assert.equal(calls,0);assert.throws(()=>service.start({...f.actor,admin:false,store_id:1},{period:'2026-10'}),e=>e.status===403);assert.equal(calls,0);
 const job=service.start(f.actor,{period:'2026-10',state:'approved'});assert.equal(calls,1);assert.equal(service.status(f.actor,job.id).result,undefined);
 assert.throws(()=>service.start(f.actor,{period:'2026-10'}),e=>e.status===409);assert.throws(()=>service.status({...f.actor,id:9},job.id),e=>e.status===404);
 release();const done=await completed(service,f.actor,job.id);assert.equal(done.status,'succeeded');assert.equal(done.result.total,1);assert.equal(done.result.items[0].state,'approved');assert.equal(done.result.latest.source_count,2);assert(done.result.queried_at);assert(done.result.sync.notice.includes('未纳入'));
 assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM finance_approval_summaries').n,2);assert(f.db.queryOne("SELECT actor_id FROM operation_audit WHERE action='finance.approval-refresh'").actor_id===1);
});
test('失败不回退旧记录；未接通企微不伪装最新，旧源缺行不混入本次结果',async()=>{
 const f=fixture(),s=source(f.db),batch=await s.reader('2026-10');S.importBatch(f.db,batch,f.actor);
 const failed=R.create({db:f.db,now:()=>fixed,reader:async()=>{throw Object.assign(new Error('源读取失败'),{status:502})}}),j=failed.start(f.actor,{period:'2026-10'}),done=await completed(failed,f.actor,j.id);
 assert.equal(done.status,'failed');assert.equal(done.result,undefined);assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM finance_approval_summaries').n,2);assert.throws(()=>failed.start(f.actor,{period:'2026-10',platform:'wecom'}),e=>e.status===503);
 const newer=structuredClone(batch);newer.items=newer.items.slice(0,1);newer.coverage[0].listed=1;newer.fetched_at='2026-10-28T10:01:00Z';const service=R.create({db:f.db,now:()=>fixed,reader:async()=>newer}),job=service.start(f.actor,{period:'2026-10'}),result=await completed(service,f.actor,job.id);
 assert.equal(result.result.total,1);assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM finance_approval_summaries').n,2,'保留原件历史但不混入最新清单');
});

test('月份不一致的源批次拒绝保存及展示',async()=>{
 const f=fixture(),batch=await source(f.db).reader('2026-10');batch.date_from='2026-09-01';
 const service=R.create({db:f.db,now:()=>fixed,reader:async()=>batch}),job=service.start(f.actor,{period:'2026-10'}),done=await completed(service,f.actor,job.id);
 assert.equal(done.status,'failed');assert.equal(done.result,undefined);assert.match(done.error,/月份不一致/);assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM finance_approval_import_runs').n,0);
});
