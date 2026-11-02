'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {call}=require('./meituan-group-api.cjs');
const directory=root=>path.join(root,'state/audit/group-events');
async function flush(root,api=call){
 const dir=directory(root);if(!fs.existsSync(dir))return {pending:0};
 const entries=fs.readdirSync(dir).filter(x=>x.endsWith('.json')).map(file=>{try{return {file,event:JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'))}}catch(e){if(e.code==='ENOENT')return null;throw e}}).filter(Boolean).sort((a,b)=>a.event.at.localeCompare(b.event.at)||a.event.seq-b.event.seq);
 for(let i=0;i<entries.length;i+=50){const batch=entries.slice(i,i+50);await api(root,'/api/internal/syncbot/events',{events:batch.map(x=>x.event)});for(const {file} of batch){try{fs.unlinkSync(path.join(dir,file));}catch(e){if(e.code!=='ENOENT')throw e;}}}return {pending:0,delivered:entries.length};
}
async function record(root,event){
 const dir=directory(root);fs.mkdirSync(dir,{recursive:true,mode:0o700});if(process.getuid?.()===0){const owner=fs.statSync(path.join(root,'state/tasks'));fs.chownSync(dir,owner.uid,owner.gid);}
 const file=path.join(dir,event.event_id+'.json');fs.writeFileSync(file+'.tmp',JSON.stringify(event),{mode:0o600});fs.renameSync(file+'.tmp',file);
 try{await flush(root);}catch{console.error('group_audit_delivery_pending');}
}
function event(type,target,task,stage,seq,metrics={}){return {event_id:'group-'+crypto.randomUUID(),task_id:task,report_type:type,business_date:target,platform:type.startsWith('douyin')?'douyin_group':'meituan_group',stage,at:new Date().toISOString(),seq,metrics};}
function receipt(root,type,from,to){
 const dir=path.join(root,'state/tasks',type.replaceAll('_','-'),from+'_'+to),state=JSON.parse(fs.readFileSync(path.join(dir,'status.json'),'utf8')),result=JSON.parse(fs.readFileSync(path.join(dir,'import-result.json'),'utf8'));
 if(result.verified!==true)throw Error('group_import_receipt_unverified');
 return {from,to,verified:true,imported:true,original_filename:path.basename(state.filename),file_size:fs.statSync(path.join(dir,state.filename)).size,sha256_prefix:String(result.sha256||state.sha256||state.result?.sha256||'').slice(0,12),import_batch_id:result.batch_id,raw_store_count:state.result?.storeIds?.length||result.matched_stores,matched_store_count:result.matched_stores};
}
async function progress(root,publish=record){
 const stateFile=path.join(root,'state/tasks/meituan-group-schedule.json');if(!fs.existsSync(stateFile))return;
 const states=JSON.parse(fs.readFileSync(stateFile,'utf8')),map={export_submitting:'EXPORT_SUBMITTED',generating:'WAITING_EXPORT',downloaded:'DOWNLOADED',validated:'FILE_VALIDATED'};
 for(const [type,state] of Object.entries(states)){
  if(state.status!=='running'||!state.audit_task_id||!/^\d{4}-\d{2}-\d{2}$/.test(state.business_date||'')||!/^(meituan|douyin)_group_report[12]$/.test(type))continue;
  const base=path.join(root,'state/tasks',type.replaceAll('_','-'));if(!fs.existsSync(base))continue;
  const candidates=fs.readdirSync(base).filter(n=>/^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/.test(n)).map(n=>path.join(base,n,'status.json')).filter(p=>fs.existsSync(p)&&fs.statSync(p).mtimeMs>=Date.parse(state.started_at)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
  if(!candidates.length)continue;const file=candidates[0],child=JSON.parse(fs.readFileSync(file,'utf8')),stage=map[child.status];if(!stage||child.to>state.business_date)continue;
  const markers=path.join(root,'state/audit/group-progress');fs.mkdirSync(markers,{recursive:true,mode:0o700});const marker=path.join(markers,crypto.createHash('sha256').update(state.audit_task_id+stage).digest('hex')+'.json');if(fs.existsSync(marker))continue;
  const e=event(type,state.business_date,state.audit_task_id,stage,2,{note:'采集服务正在处理报表'});e.at=new Date(fs.statSync(file).mtimeMs).toISOString();await publish(root,e);fs.writeFileSync(marker,JSON.stringify({at:e.at}),{mode:0o600});
 }
}
async function maintenance(root){await progress(root);return flush(root);}
module.exports={flush,record,event,receipt,progress,maintenance};
