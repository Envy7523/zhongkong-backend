const {test,before}=require('node:test'),assert=require('node:assert/strict'),init=require('sql.js');
const S=require('../lib/finance-approval-summaries'),L=require('../lib/business-ledger');
const P=require('../lib/finance-approval-proofs'),M=require('../lib/finance-approval-stores'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),sharp=require('sharp');
let SQL;before(async()=>SQL=await init());
function fixture(){
 const raw=new SQL.Database(),db={exec:s=>raw.exec(s),run:(s,p=[])=>{raw.run(s,p);return raw.getRowsModified();},queryAll:(s,p=[])=>{const q=raw.prepare(s);q.bind(p);const rows=[];while(q.step())rows.push(q.getAsObject());q.free();return rows;},save(){}};
 db.queryOne=(s,p)=>db.queryAll(s,p)[0]||null;db.insert=(s,p)=>{db.run(s,p);return db.queryOne('SELECT last_insert_rowid() id').id;};L.initialize(db);
 const actor={id:1,username:'fixture-finance',admin:true,can:()=>true};
 const item={platform:'dingtalk',tenant_key:'a'.repeat(64),instance_id:'fixture-001',template_id:'finance-template',template_name:'报销测试模板',business_no:'202610001',applicant_external_id:'fixture-employee',applicant_name:'测试员工',department:'测试部门',title:'测试报销',reason:'维修费',amount_cents:12345,amount_note:'',source_status:'COMPLETED',source_result:'agree',source_created_at:'2026-10-01T10:00Z',source_finished_at:'2026-10-02T11:00Z'};
 const job={format:'finance-approval-summary-v1',platform:'dingtalk',tenant_key:item.tenant_key,date_from:'2026-10-01',date_to:'2026-10-28',fetched_at:'2026-10-28T08:00:00Z',complete:true,errors:[],coverage:[{template_id:item.template_id,list_complete:true,listed:1}],items:[item]};
 return {raw,db,actor,item,job};
}
function proofService(f,t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'finance-approval-proof-test-'));t.after(()=>{for(const n of fs.readdirSync(root))fs.unlinkSync(path.join(root,n));fs.rmdirSync(root);});f.proofs=P.create(f.db,root);f.proofRoot=root;return f.proofs;}
async function receipt(f,t,row=f.db.queryOne('SELECT * FROM finance_approval_summaries')){if(!f.proofs)proofService(f,t);const image=await sharp({create:{width:2,height:2,channels:3,background:'white'}}).png().toBuffer();return f.proofs.upload(f.actor,row,row.version,'隔离样本付款凭证.png',image);}
test('四种主要状态依据原审批组合判定，进行中的agree不提前通过，撤销不等同驳回',()=>{
 assert.equal(S.sourceStage('RUNNING','agree'),'in_progress');assert.equal(S.sourceStage('RUNNING','refuse'),'in_progress');
 assert.equal(S.sourceStage('COMPLETED','refuse'),'rejected');assert.equal(S.sourceStage('COMPLETED','agree'),'approved');
 assert.equal(S.sourceStage('TERMINATED','agree'),'withdrawn');assert.equal(S.sourceStage('COMPLETED',''),'unknown');
 assert.equal(S.stage({source_status:'COMPLETED',source_result:'agree',completed_at:null}), 'approved');
});
test('完整摘要原子导入、白名单字段与精度正确，重复导入更新而不复制或推断付款',()=>{
 const f=fixture();f.item.account='should-not-store';f.item.attachments=['should-not-store'];f.item.approvalOpinions='should-not-store';
 assert.equal(S.importBatch(f.db,f.job,f.actor).created,1);assert.equal(S.importBatch(f.db,f.job,f.actor).unchanged,1);
 const rows=f.db.queryAll('SELECT * FROM finance_approval_summaries');assert.equal(rows.length,1);assert.equal(rows[0].amount_cents,12345);assert.equal(rows[0].completed_at,null);assert.equal(S.stage(rows[0]),'approved');
 assert(!JSON.stringify(rows).includes('should-not-store'));const dto=S.list(f.db,f.actor,{period:'2026-10'}).items[0];for(const k of ['tenant_key','instance_id','applicant_external_id','template_id'])assert(!Object.hasOwn(dto,k));
 assert.equal(S.list(f.db,f.actor,{period:'2026-10',state:'completed'}).total,0);
});
test('读取不完整、错误记录、重复ID、计数冲突或非法金额均不写入部分业务',()=>{
 for(const mutate of [j=>j.complete=false,j=>j.errors=[{error:'fixture'}],j=>j.coverage[0].listed=2,j=>{j.items.push({...j.items[0]});j.coverage[0].listed=2;},j=>j.items[0].amount_cents=1.5,j=>j.items[0].tenant_key='b'.repeat(64),j=>j.items[0].source_department_id=90071992547409930]){
  const f=fixture(),job=structuredClone(f.job);mutate(job);assert.throws(()=>S.importBatch(f.db,job,f.actor));assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM finance_approval_summaries').n,0);
 }
});

test('部门ID补齐后不被较新缺失字段批次清空，旧批次仍只跳过',()=>{
 const f=fixture();f.item.source_department_id='90071992547409931';S.importBatch(f.db,f.job,f.actor);const old=structuredClone(f.job);old.fetched_at='2026-10-28T07:00:00Z';delete old.items[0].source_department_id;assert.equal(S.importBatch(f.db,old,f.actor).stale,1);
 const bad=structuredClone(f.job);bad.fetched_at='2026-10-28T10:00:00Z';delete bad.items[0].source_department_id;assert.throws(()=>S.importBatch(f.db,bad,f.actor),/不能被缺少部门ID/);assert.equal(f.db.queryOne('SELECT source_department_id FROM finance_approval_summaries').source_department_id,'90071992547409931');
});
test('完成必须由有权财务主动核实且上传凭证，版本冲突及未通过审批均不能修改',async(t)=>{
 const f=fixture();S.importBatch(f.db,f.job,f.actor);let row=f.db.queryOne('SELECT * FROM finance_approval_summaries');
 const limited={id:4,admin:false,store_id:1,can:c=>c==='finance.payments.manage'};
 assert.throws(()=>S.list(f.db,limited,{}),e=>e.status===403);assert.throws(()=>S.action(f.db,limited,row.id,{action:'complete',version:1,confirm:true,note:'测试'}),e=>e.status===403);
 assert.throws(()=>S.action(f.db,f.actor,row.id,{action:'complete',version:1,note:'测试'}),/主动核实/);
 assert.throws(()=>S.action(f.db,f.actor,row.id,{action:'complete',version:0,confirm:true,note:'测试'}),e=>e.status===409);
 assert.throws(()=>S.action(f.db,f.actor,row.id,{action:'complete',version:1,confirm:true,note:'只有文本没有原件'}),/必须上传/);
 const p=await receipt(f,t);
 row=S.action(f.db,f.actor,row.id,{action:'complete',version:1,confirm:true,note:'fixture流水已核实付清',proof_ids:[p.id]},f.proofs);assert.equal(row.state,'completed');assert(row.completed_at);
 assert.throws(()=>f.proofs.remove(f.actor,row,p.id),/必须保留/);
 const completed=row.completed_at;row=S.action(f.db,f.actor,row.id,{action:'reopen',version:row.version,note:'fixture纠正标记，未改变银行付款'});assert.equal(row.state,'approved');assert.equal(row.completed_at,null);
 assert(f.db.queryAll('SELECT before_json FROM operation_audit').some(r=>r.before_json.includes(completed)));
 f.item.source_status='RUNNING';f.job.fetched_at='2026-10-28T08:01:00Z';S.importBatch(f.db,f.job,f.actor);row=f.db.queryOne('SELECT * FROM finance_approval_summaries');assert.throws(()=>S.action(f.db,f.actor,row.id,{action:'complete',version:row.version,confirm:true,note:'不能提前完成'}),/原审批有效通过/);
});
test('再次同步保留人工完成；源变更转待核对，旧源快照不能覆盖新状态',async(t)=>{
 const f=fixture();S.importBatch(f.db,f.job,f.actor);const p=await receipt(f,t);let row=S.action(f.db,f.actor,1,{action:'complete',version:1,confirm:true,note:'fixture已付清',proof_ids:[p.id]},f.proofs);
 S.importBatch(f.db,f.job,f.actor);assert.equal(S.list(f.db,f.actor,{}).items[0].state,'completed');
 const oldJob=structuredClone(f.job);f.item.amount_cents=15000;f.job.fetched_at='2026-10-28T08:02:00Z';assert.equal(S.importBatch(f.db,f.job,f.actor).updated,1);
 row=S.list(f.db,f.actor,{}).items[0];assert.equal(row.state,'review');assert(row.completed_at);assert.equal(row.amount_cents,15000);
 assert.throws(()=>S.action(f.db,f.actor,1,{action:'complete',version:row.version,confirm:true,note:'不能复用旧凭证',proof_ids:[p.id]},f.proofs),/本次经办人/);
 assert.equal(f.proofs.list(row,f.actor).length,1);
 assert.equal(S.importBatch(f.db,oldJob,f.actor).stale,1);assert.equal(S.list(f.db,f.actor,{}).items[0].amount_cents,15000);
});

test('源部门仅唯一精确名称对应，不按简称、事由或申请人当前门店猜测',()=>{
 const f=fixture();f.db.exec("CREATE TABLE stores(id INTEGER PRIMARY KEY,store_name TEXT);INSERT INTO stores VALUES(28,'鹅太公烧鹅（布吉信义店）'),(12,'鹅太公烧鹅（欧景花园店）')");
 f.item.department='鹅太公-深圳区-布吉信义店';f.item.source_department_id='9999999999999999999';S.importBatch(f.db,f.job,f.actor);
 let r=S.list(f.db,f.actor,{}).items[0];assert.equal(r.store_match.store_id,28);assert.equal(r.store_match.method,'exact');
 assert.equal(M.resolve({...f.item,department:'鹅太公-深圳区-欧景店',reason:'布吉信义店维修'},M.context(f.db)).store_id,null);
 f.db.run("INSERT INTO stores VALUES(99,'布吉信义店')");assert.equal(S.list(f.db,f.actor,{}).items[0].store_match.status,'ambiguous');
});

test('管理员确认源部门映射按企业/平台/部门ID隔离，重命名保持关系，冲突不覆盖',()=>{
 const f=fixture();f.db.exec("CREATE TABLE stores(id INTEGER PRIMARY KEY,store_name TEXT);INSERT INTO stores VALUES(12,'鹅太公烧鹅（欧景花园店）')");f.item.department='鹅太公-深圳区-欧景店';f.item.source_department_id='90071992547409931';S.importBatch(f.db,f.job,f.actor);
 let row=f.db.queryOne('SELECT * FROM finance_approval_summaries');const b={version:row.version,mapping_version:0,kind:'store',store_id:12,note:'隔离测试：核对档案和部门'};
 assert.throws(()=>M.save(f.db,{...f.actor,admin:false},row,b),e=>e.status===403);
 assert.equal(M.save(f.db,f.actor,row,b).store_id,12);assert.throws(()=>M.save(f.db,f.actor,row,b),e=>e.status===409);
 f.item.department='源部门改名';f.job.fetched_at='2026-10-28T09:00:00Z';S.importBatch(f.db,f.job,f.actor);row=f.db.queryOne('SELECT * FROM finance_approval_summaries');
 assert.equal(M.resolve(row,M.context(f.db)).store_id,12);
 assert.equal(M.resolve({...row,platform:'wecom'},M.context(f.db)).store_id,null);assert.equal(M.resolve({...row,tenant_key:'b'.repeat(64)},M.context(f.db)).store_id,null);
 const r=S.list(f.db,f.actor,{store_id:12});assert.equal(r.total,1);assert.equal(r.items[0].store_match.method,'confirmed');
 assert.equal(M.save(f.db,f.actor,row,{...b,version:row.version,mapping_version:1,kind:'non_store'}).status,'non_store');
});

test('多平台使用独立业务键及筛选，暂无企微导入不冒充已接通',()=>{
 const f=fixture();S.importBatch(f.db,f.job,f.actor);assert.equal(S.list(f.db,f.actor,{}).platforms.find(p=>p.value==='wecom').imported,false);
 const job=structuredClone(f.job);job.platform=job.items[0].platform='wecom';S.importBatch(f.db,job,f.actor);
 assert.equal(S.list(f.db,f.actor,{}).total,2);const r=S.list(f.db,f.actor,{platform:'wecom'});assert.equal(r.total,1);assert.equal(r.items[0].platform_label,'企业微信');assert.equal(r.latest.platform,'wecom');
 assert.throws(()=>S.list(f.db,f.actor,{platform:'invalid'}));assert.equal(S.list(f.db,f.actor,{period:'2026-09'}).latest,null);
});

test('独立绑定清单按平台企业与部门ID汇总，维护一次应用多张审批且无申请人明细',()=>{
 const f=fixture();f.db.exec("CREATE TABLE stores(id INTEGER PRIMARY KEY,store_name TEXT);INSERT INTO stores VALUES(12,'鹅太公烧鹅（欧景花园店）')");f.item.department='鹅太公-深圳区-欧景店';f.item.source_department_id='90071992547409931';f.job.items.push({...f.item,instance_id:'fixture-002'});f.job.coverage[0].listed=2;S.importBatch(f.db,f.job,f.actor);
 assert.throws(()=>M.listBindings(f.db,{...f.actor,admin:false}),e=>e.status===403);
 const list=M.listBindings(f.db,f.actor);assert.equal(list.total,1);assert.equal(list.items[0].record_count,2);assert.equal(list.summary.pending,1);assert(!JSON.stringify(list.items).includes('测试员工'));
 M.saveBinding(f.db,f.actor,list.items[0].id,{mapping_version:0,kind:'store',store_id:12,note:'独立页面确认'});
 assert.equal(S.list(f.db,f.actor,{store_id:12}).total,2);assert.equal(M.listBindings(f.db,f.actor,{status:'matched'}).total,1);
 assert.throws(()=>M.saveBinding(f.db,f.actor,list.items[0].id,{mapping_version:0,kind:'non_store',note:'旧版本'}),e=>e.status===409);
});

test('付款凭证网络重试幂等，同标识不同原件、旧版本或已移除原件不得覆盖',async(t)=>{
 const f=fixture();S.importBatch(f.db,f.job,f.actor);proofService(f,t);const row=f.db.queryOne('SELECT * FROM finance_approval_summaries'),image=await sharp({create:{width:2,height:2,channels:3,background:'white'}}).png().toBuffer(),options={uploadKey:'fixture-idempotency-001'};
 const [a,b]=await Promise.all([f.proofs.upload(f.actor,row,1,'same.png',image,options),f.proofs.upload(f.actor,row,1,'same.png',image,options)]);assert.equal(a.id,b.id);assert.equal(f.db.queryOne('SELECT COUNT(*) n FROM finance_approval_proofs').n,1);
 const other=await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer();await assert.rejects(f.proofs.upload(f.actor,row,1,'same.png',other,options),e=>e.status===409);
 f.proofs.remove(f.actor,row,a.id);await assert.rejects(f.proofs.upload(f.actor,row,1,'same.png',image,options),e=>e.status===409);
});

test('凭证校验原件格式/大小，跨单、跨人、伪造ID与篡改原件不能确认',async(t)=>{
 const f=fixture();S.importBatch(f.db,f.job,f.actor);const p=await receipt(f,t),row=f.db.queryOne('SELECT * FROM finance_approval_summaries'),body={action:'complete',version:row.version,confirm:true,note:'隔离样本',proof_ids:[p.id]};
 await assert.rejects(f.proofs.upload(f.actor,row,1,'fake.png',Buffer.from('<html>not a receipt</html>')),/图片/);
 await assert.rejects(f.proofs.upload(f.actor,row,1,'fake.pdf',Buffer.from('%PDF-1.7 truncated')),/仅支持/);
 await assert.rejects(f.proofs.upload(f.actor,row,1,'large.png',Buffer.alloc(P.MAX_BYTES+1)),/8MB/);
 await assert.rejects(f.proofs.upload(f.actor,row,0,'old.png',Buffer.from('old')),e=>e.status===409);
 assert.throws(()=>S.action(f.db,{...f.actor,id:2},row.id,body,f.proofs),/本次经办人/);
 assert.throws(()=>S.action(f.db,f.actor,row.id,{...body,proof_ids:['../bad']},f.proofs),/不存在/);
 assert.throws(()=>f.proofs.download({...row,id:900},p.id),e=>e.status===404);
 fs.writeFileSync(path.join(f.proofRoot,p.id),'tampered');assert.throws(()=>S.action(f.db,f.actor,row.id,body,f.proofs),/校验失败/);
 assert.equal(f.db.queryOne('SELECT completed_at FROM finance_approval_summaries').completed_at,null);
});

test('凭证下载原件保真、待确认可移除；源变化后旧待确认凭证不可复用',async(t)=>{
 const f=fixture();S.importBatch(f.db,f.job,f.actor);const p=await receipt(f,t),row=f.db.queryOne('SELECT * FROM finance_approval_summaries');
 assert(f.proofs.download(row,p.id).buffer.length>0);assert(!JSON.stringify(f.proofs.list(row,f.actor)).includes(f.proofRoot));
 f.item.amount_cents++;f.job.fetched_at='2026-10-28T10:00:00Z';S.importBatch(f.db,f.job,f.actor);const changed=f.db.queryOne('SELECT * FROM finance_approval_summaries');assert.equal(f.proofs.list(changed,f.actor)[0].can_select,false);
 assert.throws(()=>S.action(f.db,f.actor,changed.id,{action:'complete',version:changed.version,confirm:true,note:'隔离测试',proof_ids:[p.id]},f.proofs),/当前单据/);
 f.proofs.remove(f.actor,changed,p.id);assert.equal(f.proofs.list(changed,f.actor).length,0);assert.throws(()=>f.proofs.download(changed,p.id),e=>e.status===404);
});
test('金额缺失保留未知；关键文字中的长账号不复制为摘要内容',()=>{
 const f=fixture();f.item.amount_cents=null;f.item.amount_note='统计缺失';f.item.reason='核对卡号1234567890123456789的费用';S.importBatch(f.db,f.job,f.actor);
 const row=S.list(f.db,f.actor,{}).items[0];assert.equal(row.amount_cents,null);assert(row.reason.includes('长号码省略'));assert(!row.reason.includes('1234567890123456789'));
});
