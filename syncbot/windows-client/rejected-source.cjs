'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
async function upload(collector,job,scope,error){
 if(!collector.cloud.enabled||!scope||!['settlement_bill_reconciliation_failed','collector_no_active_source_rows'].includes(error.message))return [];
 const platform=job.platform||'meituan_delivery';let relative=job.result?.file;
 if(platform==='meituan_delivery'&&job.reportType==='settlement')relative=path.join('downloads',platform,'meituan_delivery_settlement',job.date+'_custom_'+scope.version.slice(0,12),'all-stores.xlsx');
 if(!relative)return ['rejected_source_unavailable'];
 try{const file=path.resolve(collector.root,relative);if(!file.startsWith(path.resolve(collector.root,'downloads')+path.sep)||fs.realpathSync(file)!==file||!fs.statSync(file).isFile())return ['rejected_source_invalid'];
 const bytes=fs.readFileSync(file),sha256=crypto.createHash('sha256').update(bytes).digest('hex');if(bytes.length>30*1024*1024)return ['rejected_source_too_large'];
 const got=await collector.cloud.call('/diagnostic-source',{platform,type:job.reportType,date:job.date,scope_version:scope.version,error:error.message,sha256,data:bytes.toString('base64')});
 if(got.accepted_for_import===false&&got.sha256===sha256)job.rejectedSource={sha256,file:relative,scopeVersion:scope.version,refreshAllowed:got.refresh_allowed===true,at:new Date().toISOString()};
 return got.accepted_for_import===false&&got.sha256===sha256?['rejected_source_archived']:['rejected_source_receipt_invalid'];
 }catch(error){return ['rejected_source_upload_failed',...(/^[a-z][a-z0-9_]{0,100}$/.test(error.message)?['rejected_source_'+error.message]:[])];}
}
function refresh(collector,job,scope){
 const platform=job.platform||'meituan_delivery',prior=[...collector.history].reverse().find(j=>j.id!==job.id&&(j.platform||'meituan_delivery')===platform&&j.reportType===job.reportType&&j.date===job.date);
 const rejected=prior?.rejectedSource;
 if(prior?.status!=='failed'||!rejected?.refreshAllowed||rejected.consumedAt||rejected.scopeVersion!==scope.version||!['collector_no_active_source_rows','settlement_bill_reconciliation_failed'].includes(prior.code))return false;
 const root=path.resolve(collector.root),file=path.resolve(root,rejected.file);
 const inside=f=>{const absolute=path.resolve(f);if(!absolute.startsWith(root+path.sep)||fs.realpathSync(absolute)!==absolute||!fs.lstatSync(absolute).isFile())throw Error('client_rejected_archive_invalid');return absolute;};
 inside(file);if(!file.startsWith(path.join(root,'downloads')+path.sep)||crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==rejected.sha256)throw Error('client_rejected_archive_changed');
 const paths=[file];
 if(platform==='meituan_delivery'){
  if(job.reportType!=='settlement')return false;
  paths.push(path.join(root,'state/tasks/meituan_delivery/meituan_delivery_settlement',job.date+'_custom_'+scope.version.slice(0,12)+'.json'));
 }else{
  paths.push(file+'.json',require('./platform-runner.cjs').journalPath(root,platform,job.date,job.reportType));
 }
 const present=paths.filter(f=>fs.existsSync(f)).map(inside),archive=path.join(root,'downloads','rejected-sources',platform,job.date,job.reportType,job.id);
 if(!/^[a-f0-9-]{36}$/.test(job.id)||!archive.startsWith(root+path.sep))throw Error('client_rejected_archive_invalid');
 fs.mkdirSync(archive,{recursive:true,mode:0o700});
 for(let i=0;i<present.length;i++){const dest=path.join(archive,i+'-'+path.basename(present[i]));if(fs.existsSync(dest))throw Error('client_rejected_archive_conflict');fs.renameSync(present[i],dest);}
 rejected.consumedAt=new Date().toISOString();job.reexportedRejectedSource=rejected.sha256;collector.saveHistory();return true;
}
async function prepare(collector,job,scope){
 const prior=[...collector.history].reverse().find(j=>j.id!==job.id&&(j.platform||'meituan_delivery')===(job.platform||'meituan_delivery')&&j.reportType===job.reportType&&j.date===job.date);
 if((job.platform||'meituan_delivery')==='meituan_delivery'&&job.reportType==='settlement'&&prior?.code==='settlement_bill_reconciliation_failed'){
  const original=path.join(collector.root,'downloads/meituan_delivery/meituan_delivery_settlement',job.date+'_custom_'+scope.version.slice(0,12),'all-stores.xlsx');
  try{require('../src/meituan-delivery/settlement-all-file').inspectSettlementAll(fs.readFileSync(original),{from:job.date,expectedStoreIds:scope.bindings.map(r=>r.platform_id)});return false;}catch{}
 }
 if(prior?.status==='failed'&&['collector_no_active_source_rows','settlement_bill_reconciliation_failed'].includes(prior.code)&&!prior.rejectedSource){await upload(collector,prior,scope,Error(prior.code));collector.saveHistory();}
 return refresh(collector,job,scope);
}
module.exports={upload,refresh,prepare};
