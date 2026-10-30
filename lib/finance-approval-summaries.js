'use strict';
const crypto=require('node:crypto');
const L=require('./business-ledger');
const Stores=require('./finance-approval-stores'),Proofs=require('./finance-approval-proofs');
const PLATFORMS={dingtalk:'钉钉',wecom:'企业微信'};
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const text=(v,max=240)=>String(v??'').trim().slice(0,max);
const caption=v=>String(v??'').replace(/\d{12,}/g,'[长号码省略]').trim().slice(0,240);
const LABELS={in_progress:'进行中',rejected:'已驳回',approved:'已通过',completed:'已完成',withdrawn:'已撤销',unknown:'状态待核',review:'变更待核对'};
function sourceStage(status,result){
  const s=text(status,40).toUpperCase(),r=text(result,40).toLowerCase();
  if(['RUNNING','NEW','PENDING'].includes(s))return 'in_progress';
  if(s==='COMPLETED')return r==='agree'?'approved':r==='refuse'?'rejected':'unknown';
  if(['TERMINATED','CANCELED','CANCELLED'].includes(s))return 'withdrawn';
  return 'unknown';
}
function stage(row){return row.needs_review?'review':sourceStage(row.source_status,row.source_result)==='approved'&&row.completed_at?'completed':sourceStage(row.source_status,row.source_result);}
function initialize(db){
  db.exec(`CREATE TABLE IF NOT EXISTS finance_approval_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,platform TEXT NOT NULL,tenant_key TEXT NOT NULL,
    instance_id TEXT NOT NULL,template_id TEXT NOT NULL,template_name TEXT NOT NULL,business_no TEXT NOT NULL,
    applicant_external_id TEXT NOT NULL,applicant_name TEXT NOT NULL,department TEXT NOT NULL,
    title TEXT NOT NULL,reason TEXT NOT NULL,amount_cents INTEGER,amount_note TEXT NOT NULL,
    source_status TEXT NOT NULL,source_result TEXT NOT NULL,source_created_at TEXT NOT NULL,source_finished_at TEXT NOT NULL,
    period TEXT NOT NULL,source_hash TEXT NOT NULL,first_imported_at TEXT NOT NULL,last_fetched_at TEXT NOT NULL,
    completed_at TEXT,completed_by INTEGER,completed_note TEXT,needs_review INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,UNIQUE(platform,tenant_key,instance_id));
  CREATE INDEX IF NOT EXISTS idx_finance_approval_period ON finance_approval_summaries(period,id);
  CREATE TABLE IF NOT EXISTS finance_approval_import_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,platform TEXT NOT NULL,tenant_key TEXT NOT NULL,date_from TEXT NOT NULL,date_to TEXT NOT NULL,
    fetched_at TEXT NOT NULL,imported_at TEXT NOT NULL,source_count INTEGER NOT NULL,created_count INTEGER NOT NULL,
    updated_count INTEGER NOT NULL,unchanged_count INTEGER NOT NULL,stale_count INTEGER NOT NULL,manifest_hash TEXT NOT NULL);`);
  const columns=db.queryAll('PRAGMA table_info(finance_approval_summaries)').map(c=>c.name);
  if(!columns.includes('source_department_id'))db.run("ALTER TABLE finance_approval_summaries ADD COLUMN source_department_id TEXT NOT NULL DEFAULT ''");
  Stores.initialize(db);Proofs.initialize(db);
}
function assertManager(db,actor){
  L.assertRight(actor,'finance.payments.manage');
  if(L.scopeFor(db,actor,'finance.payments.manage')!==null)fail('审批摘要尚未核准历史门店归属，仅开放完整财务范围',403);
}
const FIELDS=['platform','tenant_key','instance_id','template_id','template_name','business_no','applicant_external_id','applicant_name','department','title','reason','amount_cents','amount_note','source_status','source_result','source_created_at','source_finished_at','source_department_id'];
function clean(item,job){
  if(item.platform!==job.platform||item.tenant_key!==job.tenant_key)fail('审批来源与导入任务不一致');
  if(item.source_department_id!==undefined&&typeof item.source_department_id!=='string')fail('源部门ID须保留为字符串');
  if(String(item.source_department_id||'').length>200)fail('源部门ID过长');
  if(!text(item.instance_id,200)||String(item.instance_id).length>200||!job.coverage.some(t=>t.template_id===item.template_id))fail('审批编号或模板不在本次完整清单内');
  if(item.amount_cents!==null&&(!Number.isSafeInteger(item.amount_cents)||item.amount_cents<0||item.amount_cents>99999999999))fail('源金额须为整数分或明确缺失');
  const row=Object.fromEntries(FIELDS.map(k=>[k,k==='amount_cents'?item[k]:text(item[k],['instance_id','applicant_external_id','business_no','template_id'].includes(k)?200:240)]));
  for(const k of ['title','reason','department'])row[k]=caption(item[k]);
  if(!row.template_name||!row.source_status)fail('缺少原审批模板或状态');
  return row;
}
function importBatch(db,job,actor){
  if(!actor?.admin)fail('仅管理员或受控导入任务可导入源审批清单',403);
  if(job.format!=='finance-approval-summary-v1'||!Object.hasOwn(PLATFORMS,job.platform)||job.complete!==true||job.errors?.length||!Array.isArray(job.items)||!Array.isArray(job.coverage)||!job.coverage.length||job.coverage.some(c=>!c.list_complete))fail('源审批清单未完整读取，未导入');
  if(!/^[a-f0-9]{64}$/.test(job.tenant_key)||!/^\d{4}-\d{2}-\d{2}$/.test(job.date_from)||!/^\d{4}-\d{2}-\d{2}$/.test(job.date_to)||job.date_from>job.date_to||job.date_from.slice(0,7)!==job.date_to.slice(0,7)||!Number.isFinite(Date.parse(job.fetched_at)))fail('导入范围或来源元信息无效');
  const rows=job.items.map(item=>clean(item,job)),keys=new Set(rows.map(r=>r.instance_id));
  if(keys.size!==rows.length||job.coverage.reduce((s,c)=>s+c.listed,0)!==rows.length)fail('源清单重复或数量不一致，未导入');
  for(const c of job.coverage)if(!Number.isSafeInteger(c.listed)||c.listed<0||rows.filter(r=>r.template_id===c.template_id).length!==c.listed)fail('模板覆盖计数不一致');
  const at=L.stamp(),fetched=new Date(job.fetched_at).toISOString(),period=job.date_from.slice(0,7),counts={created:0,updated:0,unchanged:0,stale:0,total:rows.length};
  const manifest_hash=crypto.createHash('sha256').update(JSON.stringify({date_from:job.date_from,date_to:job.date_to,fetched_at:fetched,rows})).digest('hex');
  return L.transaction(db,()=>{
    for(const row of rows){
      const old=db.queryOne('SELECT * FROM finance_approval_summaries WHERE platform=? AND tenant_key=? AND instance_id=?',[row.platform,row.tenant_key,row.instance_id]);
      if(old?.source_department_id&&!row.source_department_id&&old.last_fetched_at<=fetched)fail('已有源部门ID的记录不能被缺少部门ID的新批次覆盖');
      const hash=crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
      if(old&&old.last_fetched_at>fetched){counts.stale++;continue;}
      if(old&&old.source_hash===hash){db.run('UPDATE finance_approval_summaries SET last_fetched_at=? WHERE id=?',[fetched,old.id]);counts.unchanged++;continue;}
      if(old){
        db.run(`UPDATE finance_approval_summaries SET ${FIELDS.slice(3).map(k=>k+'=?').join(',')},source_hash=?,last_fetched_at=?,needs_review=?,version=version+1 WHERE id=?`,[...FIELDS.slice(3).map(k=>row[k]),hash,fetched,old.completed_at?1:old.needs_review,old.id]);
        L.audit(db,actor,'finance.approval-source-update','approval:'+old.id,{source_status:old.source_status,source_result:old.source_result,amount_cents:old.amount_cents},{source_status:row.source_status,source_result:row.source_result,amount_cents:row.amount_cents,needs_review:!!old.completed_at});counts.updated++;
      }else{
        db.insert(`INSERT INTO finance_approval_summaries(${FIELDS.join(',')},period,source_hash,first_imported_at,last_fetched_at) VALUES(${[...FIELDS,'period','source_hash','first_imported_at','last_fetched_at'].map(()=>'?').join(',')})`,[...FIELDS.map(k=>row[k]),period,hash,at,fetched]);counts.created++;
      }
    }
    const id=db.insert('INSERT INTO finance_approval_import_runs(platform,tenant_key,date_from,date_to,fetched_at,imported_at,source_count,created_count,updated_count,unchanged_count,stale_count,manifest_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[job.platform,job.tenant_key,job.date_from,job.date_to,fetched,at,counts.total,counts.created,counts.updated,counts.unchanged,counts.stale,manifest_hash]);
    L.audit(db,actor,'finance.approval-import','approval-import:'+id,null,{date_from:job.date_from,date_to:job.date_to,...counts,manifest_hash});
    return {run_id:id,...counts,manifest_hash};
  });
}
function list(db,actor,query={},snapshot={}){
  assertManager(db,actor);const period=text(query.period,7);if(period&&!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))fail('请选择正确月份');
  if(query.platform&&!Object.hasOwn(PLATFORMS,query.platform))fail('来源平台无效');
  const ctx=Stores.context(db),all=db.queryAll('SELECT * FROM finance_approval_summaries'+(period?' WHERE period=?':'')+' ORDER BY source_created_at DESC,id DESC',period?[period]:[]).filter(r=>!snapshot.sources||snapshot.sources.some(s=>s.platform===r.platform&&s.tenant_key===r.tenant_key&&s.instance_ids.has(r.instance_id)));
  const rows=all.map(r=>({...r,store_match:Stores.resolve(r,ctx)})).filter(r=>(!query.platform||r.platform===query.platform)&&(!query.store_id||String(r.store_match.store_id)===String(query.store_id))&&(!query.store_match||r.store_match.status===query.store_match));
  const counts=Object.fromEntries(Object.keys(LABELS).map(k=>[k,rows.filter(r=>stage(r)===k).length]));
  const q=text(query.q).toLowerCase(),filtered=rows.filter(r=>(!query.state||stage(r)===query.state)&&(!q||[r.business_no,r.applicant_name,r.department,r.title,r.reason,r.store_match.store_name].join(' ').toLowerCase().includes(q)));
  const page=Math.max(1,Math.floor(Number(query.page)||1));
  const where=[],params=[];if(snapshot.runId){where.push('id=?');params.push(snapshot.runId);}if(query.platform){where.push('platform=?');params.push(query.platform);}if(period){where.push('substr(date_from,1,7)=?');params.push(period);}
  return {queried_at:L.stamp(),items:filtered.slice((page-1)*50,page*50).map(dto),total:filtered.length,page,counts,stores:ctx.stores,can_map:actor.admin,platforms:Object.entries(PLATFORMS).map(([value,label])=>({value,label,imported:all.some(r=>r.platform===value)})),latest:db.queryOne('SELECT platform,date_from,date_to,fetched_at,imported_at,source_count FROM finance_approval_import_runs'+(where.length?' WHERE '+where.join(' AND '):'')+' ORDER BY id DESC LIMIT 1',params)};
}
function dto(r){
  const {tenant_key,instance_id,template_id,applicant_external_id,source_department_id,source_hash,...row}=r;
  return {...row,platform_label:PLATFORMS[r.platform]||'未知来源',state:stage(r),state_label:LABELS[stage(r)]};
}
function record(db,actor,id){assertManager(db,actor);const row=db.queryOne('SELECT * FROM finance_approval_summaries WHERE id=?',[Number(id)]);if(!row)fail('审批记录不存在',404);return row;}
function action(db,actor,id,body={},proofs=Proofs.create(db)){
  const row=record(db,actor,id);
  if(Number(body.version)!==row.version)fail('记录已更新，请刷新后重试',409);
  const note=text(body.note,300);if(!note)fail('请填写实际付款核实说明或更正原因');
  if(!['complete','reopen'].includes(body.action))fail('未知状态操作');
  if(body.action==='complete'&&(sourceStage(row.source_status,row.source_result)!=='approved'||body.confirm!==true))fail('仅可在原审批有效通过且主动核实付款后标记完成');
  if(body.action==='reopen'&&!row.completed_at)fail('该记录尚未确认完成');
  return L.transaction(db,()=>{
    const selected=body.action==='complete'?proofs.required(actor,row,body.proof_ids):[];
    const at=L.stamp();const changed=db.run('UPDATE finance_approval_summaries SET completed_at=?,completed_by=?,completed_note=?,needs_review=0,version=version+1 WHERE id=? AND version=?',[body.action==='complete'?at:null,body.action==='complete'?actor.id:null,body.action==='complete'?note:null,row.id,row.version]);
    if(changed!==1)fail('记录已更新，请刷新后重试',409);
    for(const p of selected)db.run('UPDATE finance_approval_proofs SET confirmed_at=?,confirmation_version=? WHERE id=?',[at,row.version+1,p.id]);
    L.audit(db,actor,'finance.approval-'+body.action,'approval:'+row.id,{completed_at:row.completed_at,source_status:row.source_status,needs_review:row.needs_review},{note,completed_at:body.action==='complete'?at:null,proof_ids:selected.map(p=>p.id),bank_transfer:false});
    return dto(db.queryOne('SELECT * FROM finance_approval_summaries WHERE id=?',[row.id]));
  });
}
module.exports={initialize,sourceStage,stage,importBatch,list,action,record,assertManager,LABELS,PLATFORMS};
