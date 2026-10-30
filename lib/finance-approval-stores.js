'use strict';
const L=require('./business-ledger');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
function initialize(db){db.exec(`CREATE TABLE IF NOT EXISTS finance_approval_store_mappings(
 platform TEXT NOT NULL,tenant_key TEXT NOT NULL,department_key TEXT NOT NULL,department TEXT NOT NULL,
 kind TEXT NOT NULL,store_id INTEGER,note TEXT NOT NULL,updated_at TEXT NOT NULL,updated_by INTEGER,
 version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(platform,tenant_key,department_key));`);}
const key=r=>r.source_department_id?'id:'+r.source_department_id:'name:'+r.department;
const bindingId=r=>require('node:crypto').createHash('sha256').update(JSON.stringify([r.platform,r.tenant_key,key(r)])).digest('hex');
function assertAdmin(actor){if(!actor?.admin)fail('仅管理员可维护审批门店绑定',403);}
// Only the known brand wrapper is removed. Short names, regions and reasons are never fuzzy matched.
const name=v=>String(v||'').trim().replace(/^鹅太公烧鹅[（(](.+)[）)]$/,'$1');
function context(db){
 let stores=[];try{stores=db.queryAll('SELECT id,store_name FROM stores ORDER BY store_name,id');}catch(e){if(!/no such table/.test(e.message))throw e;}
 return {stores,mappings:db.queryAll('SELECT * FROM finance_approval_store_mappings')};
}
function resolve(row,ctx){
 const mapping=ctx.mappings.find(m=>m.platform===row.platform&&m.tenant_key===row.tenant_key&&m.department_key===key(row));
 const base={status:'unmatched',store_id:null,store_name:'待核对',method:'',version:mapping?.version||0};
 if(mapping){
  if(mapping.kind==='non_store')return {...base,status:'non_store',store_name:'总部／非门店部门',method:'confirmed'};
  if(mapping.kind==='unmatched')return base;
  const store=ctx.stores.find(s=>s.id===mapping.store_id);
  return store?{...base,status:'matched',store_id:store.id,store_name:store.store_name,method:'confirmed'}:{...base,status:'missing_store'};
 }
 const leaf=String(row.department||'').split('-').at(-1).trim();
 if(!leaf)return base;
 const matches=ctx.stores.filter(s=>name(s.store_name)===name(leaf));
 if(matches.length!==1)return {...base,status:matches.length?'ambiguous':'unmatched'};
 return {...base,status:'matched',store_id:matches[0].id,store_name:matches[0].store_name,method:'exact'};
}
function save(db,actor,row,body){
 if(!actor.admin)fail('仅管理员可维护平台部门与后台门店的对应关系',403);
 if(Number(body.version)!==row.version)fail('审批记录已更新，请刷新后核对门店',409);
 const kind=body.kind,note=String(body.note||'').trim().slice(0,300);
 if(!['store','non_store','unmatched'].includes(kind)||!note||!row.department&&!row.source_department_id)fail('请选择对应方式并填写核对依据');
 const store=kind==='store'?db.queryOne('SELECT id,store_name FROM stores WHERE id=?',[Number(body.store_id)]):null;
 if(kind==='store'&&!store)fail('请选择后台已有门店');
 return L.transaction(db,()=>{
  if(db.queryOne('SELECT version FROM finance_approval_summaries WHERE id=?',[row.id])?.version!==row.version)fail('审批记录已更新，请刷新后核对门店',409);
  const params=[row.platform,row.tenant_key,key(row)],old=db.queryOne('SELECT * FROM finance_approval_store_mappings WHERE platform=? AND tenant_key=? AND department_key=?',params);
  if(Number(body.mapping_version)!==(old?.version||0))fail('门店关系已更新，请刷新后核对',409);
  db.run(`INSERT INTO finance_approval_store_mappings(platform,tenant_key,department_key,department,kind,store_id,note,updated_at,updated_by)
   VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(platform,tenant_key,department_key) DO UPDATE SET department=excluded.department,kind=excluded.kind,store_id=excluded.store_id,note=excluded.note,updated_at=excluded.updated_at,updated_by=excluded.updated_by,version=finance_approval_store_mappings.version+1`,[...params,row.department,kind,store?.id||null,note,L.stamp(),actor.id]);
  L.audit(db,actor,'finance.approval-store-mapping','approval:'+row.id,old?{kind:old.kind,store_id:old.store_id,version:old.version}:null,{platform:row.platform,department:row.department,kind,store_id:store?.id||null,note});
  return resolve(row,context(db));
 });
}
function groups(db){
 const result=new Map();
 for(const row of db.queryAll('SELECT * FROM finance_approval_summaries ORDER BY source_created_at DESC,id DESC')){
  const id=bindingId(row);if(!result.has(id))result.set(id,{id,row,count:0,names:new Set()});
  const group=result.get(id);group.count++;if(row.department)group.names.add(row.department);
 }
 return [...result.values()];
}
function listBindings(db,actor,query={}){
 assertAdmin(actor);const ctx=context(db),platforms=require('./finance-approval-summaries').PLATFORMS;
 if(query.platform&&!Object.hasOwn(platforms,query.platform))fail('来源平台无效');
 const all=groups(db).map(g=>{const m=ctx.mappings.find(m=>m.platform===g.row.platform&&m.tenant_key===g.row.tenant_key&&m.department_key===key(g.row));return {id:g.id,platform:g.row.platform,platform_label:platforms[g.row.platform]||'未知平台',department:g.row.department,source_department_id:g.row.source_department_id,observed_names:[...g.names],record_count:g.count,store_match:resolve(g.row,ctx),note:m?.note||'',updated_at:m?.updated_at||null};});
 const q=String(query.q||'').trim().toLowerCase(),rows=all.filter(g=>(!query.platform||g.platform===query.platform)&&(!query.status||g.store_match.status===query.status)&&(!q||[g.department,g.source_department_id,g.store_match.store_name,...g.observed_names].join(' ').toLowerCase().includes(q)));
 const page=Math.max(1,Math.floor(Number(query.page)||1));
 return {items:rows.slice((page-1)*50,page*50),total:rows.length,page,stores:ctx.stores,summary:{departments:all.length,matched:all.filter(g=>g.store_match.status==='matched').length,non_store:all.filter(g=>g.store_match.status==='non_store').length,pending:all.filter(g=>!['matched','non_store'].includes(g.store_match.status)).length}};
}
function saveBinding(db,actor,id,body){
 assertAdmin(actor);const group=groups(db).find(g=>g.id===id);if(!group)fail('源部门不存在，请刷新绑定清单',404);
 return save(db,actor,group.row,{...body,version:group.row.version});
}
module.exports={initialize,key,context,resolve,save,bindingId,listBindings,saveBinding};
