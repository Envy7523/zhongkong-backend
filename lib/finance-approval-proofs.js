'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const L=require('./business-ledger');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const MAX_BYTES=8*1024*1024;
function initialize(db){db.exec(`CREATE TABLE IF NOT EXISTS finance_approval_proofs(
 id TEXT PRIMARY KEY,approval_id INTEGER NOT NULL REFERENCES finance_approval_summaries(id),
 source_hash TEXT NOT NULL,uploaded_version INTEGER NOT NULL,original_name TEXT NOT NULL,mime TEXT NOT NULL,
 bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,uploaded_by INTEGER NOT NULL,uploaded_at TEXT NOT NULL,
 confirmed_at TEXT,confirmation_version INTEGER,deleted_at TEXT);
 CREATE INDEX IF NOT EXISTS idx_finance_approval_proofs ON finance_approval_proofs(approval_id,id);`);
 if(!db.queryAll('PRAGMA table_info(finance_approval_proofs)').some(c=>c.name==='upload_key'))db.run("ALTER TABLE finance_approval_proofs ADD COLUMN upload_key TEXT NOT NULL DEFAULT ''");
 db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_proof_upload_key ON finance_approval_proofs(approval_id,uploaded_by,upload_key) WHERE upload_key<>''");
}
const dto=(p,row)=>({id:p.id,name:p.original_name,mime:p.mime,bytes:p.bytes,uploaded_at:p.uploaded_at,uploaded_by:p.uploaded_by,confirmed_at:p.confirmed_at,current:p.source_hash===row.source_hash&&p.uploaded_version===row.version});
function create(db,root=path.resolve(__dirname,'../data/finance-payment-proofs',process.env.LOCAL_WEB_PREVIEW==='1'?'local-preview':'live')){
 root=path.resolve(root);
 const target=id=>{if(!/^[a-f0-9]{48}$/.test(id))fail('凭证不存在',404);return path.join(root,id);};
 function read(row,id){const p=db.queryOne('SELECT * FROM finance_approval_proofs WHERE id=? AND approval_id=? AND deleted_at IS NULL',[String(id),row.id]);if(!p)fail('凭证不存在',404);return p;}
 function content(p){const file=target(p.id);if(!fs.existsSync(file))fail('凭证原件缺失，请重新上传',409);const b=fs.readFileSync(file);if(b.length!==p.bytes||crypto.createHash('sha256').update(b).digest('hex')!==p.sha256)fail('凭证校验失败，请联系管理员',409);return b;}
 function list(row,actor){return db.queryAll('SELECT * FROM finance_approval_proofs WHERE approval_id=? AND deleted_at IS NULL ORDER BY uploaded_at,id',[row.id]).map(p=>({...dto(p,row),upload_key:p.uploaded_by===actor?.id?p.upload_key:undefined,can_select:!!actor&&p.uploaded_by===actor.id&&!p.confirmed_at&&p.source_hash===row.source_hash&&p.uploaded_version===row.version,can_remove:!p.confirmed_at&&(p.uploaded_by===actor?.id||actor?.admin)}));}
 async function upload(actor,row,version,filename,buffer,{uploadKey=''}={}){
  if(Number(version)!==row.version)fail('记录已更新，请刷新后上传',409);
  if(typeof uploadKey!=='string'||uploadKey&&!/^[a-zA-Z0-9_-]{16,80}$/.test(uploadKey))fail('上传标识无效');
  if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>MAX_BYTES)fail('凭证须为不超过8MB的文件');
  const ext=path.extname(String(filename||'')).toLowerCase();let mime;
  if(ext==='.pdf'&&/^%PDF-(?:1\.[0-7]|2\.0)/.test(buffer.toString('ascii',0,8))&&buffer.subarray(-2048).includes(Buffer.from('%%EOF')))mime='application/pdf';
  else if(['.jpg','.jpeg','.png','.webp'].includes(ext)){
   try{const image=sharp(buffer,{limitInputPixels:30000000}),info=await image.metadata(),expected={'.jpg':'jpeg','.jpeg':'jpeg','.png':'png','.webp':'webp'}[ext];if(info.format!==expected||(info.pages||1)>1)fail('图片格式不符');await image.stats();mime='image/'+info.format;}catch{fail('凭证图片损坏、格式不符或尺寸过大');}
  }else fail('付款凭证仅支持JPG、PNG、WebP图片或PDF');
  // Decoding is asynchronous: re-read the approval before any durable write.
  const fresh=db.queryOne('SELECT * FROM finance_approval_summaries WHERE id=?',[row.id]);
  if(!fresh||fresh.version!==row.version||fresh.source_hash!==row.source_hash)fail('记录已更新，请刷新后上传',409);
  if(require('./finance-approval-summaries').sourceStage(fresh.source_status,fresh.source_result)!=='approved'||fresh.completed_at&&!fresh.needs_review)fail('仅有效通过、待确认的审批可上传付款凭证');
  const sha=crypto.createHash('sha256').update(buffer).digest('hex');
  const previous=uploadKey?db.queryOne('SELECT * FROM finance_approval_proofs WHERE approval_id=? AND uploaded_by=? AND upload_key=?',[row.id,actor.id,uploadKey]):null;
  if(previous){
   if(previous.deleted_at||previous.sha256!==sha||previous.source_hash!==row.source_hash||previous.uploaded_version!==row.version)fail('上传重试与原文件或单据版本不一致，请重新选择文件',409);
   content(previous);return dto(previous,row);
  }
  if(db.queryOne('SELECT COUNT(*) n FROM finance_approval_proofs WHERE approval_id=? AND deleted_at IS NULL AND confirmed_at IS NULL',[row.id]).n>=5)fail('待确认凭证最多5份，请先移除不用的文件');
  const id=crypto.randomBytes(24).toString('hex'),at=L.stamp(),name=path.basename(String(filename).replace(/\\/g,'/')).replace(/[\x00-\x1f\x7f]/g,'').slice(0,160);
  fs.mkdirSync(root,{recursive:true});fs.writeFileSync(target(id),buffer,{flag:'wx',mode:0o600});
  try{return L.transaction(db,()=>{
   db.run('INSERT INTO finance_approval_proofs(id,approval_id,source_hash,uploaded_version,original_name,mime,bytes,sha256,uploaded_by,uploaded_at,upload_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[id,row.id,row.source_hash,row.version,name,mime,buffer.length,sha,actor.id,at,uploadKey]);
   L.audit(db,actor,'finance.approval-proof-upload','approval:'+row.id,null,{proof_id:id,bytes:buffer.length,sha256:sha});
   return dto(read(row,id),row);
  });}catch(e){try{if(!db.queryOne('SELECT id FROM finance_approval_proofs WHERE id=?',[id]))fs.unlinkSync(target(id));}catch{}throw e;}
 }
 function required(actor,row,ids){
  if(!Array.isArray(ids)||ids.length<1||ids.length>5||new Set(ids).size!==ids.length)fail('确认完成前必须上传并选用付款凭证（1至5份）');
  return ids.map(id=>{const p=read(row,id);if(p.uploaded_by!==actor.id||p.source_hash!==row.source_hash||p.uploaded_version!==row.version||p.confirmed_at)fail('凭证须由本次经办人针对当前单据上传');content(p);return p;});
 }
 function remove(actor,row,id){const p=read(row,id);if(p.confirmed_at)fail('已确认的付款凭证必须保留，不能删除');if(p.uploaded_by!==actor.id&&!actor.admin)fail('只能移除本人尚未确认的凭证',403);return L.transaction(db,()=>{db.run('UPDATE finance_approval_proofs SET deleted_at=? WHERE id=?',[L.stamp(),p.id]);L.audit(db,actor,'finance.approval-proof-remove','approval:'+row.id,{proof_id:p.id},null);return {};});}
 return {list,upload,required,remove,download:(row,id)=>{const p=read(row,id);return {proof:p,buffer:content(p)};}};
}
module.exports={initialize,create,MAX_BYTES};
