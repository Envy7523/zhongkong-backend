'use strict';
const core=require('./core.cjs'),path=require('path');
const platforms=['meituan_delivery','jd_delivery','taobao_flash'];
const transient=new Set(['client_cloud_unreachable','client_extension_not_connected','client_extension_command_timeout','extension_page_changed','extension_element_timeout','extension_content_not_ready','platform_reload_pending','platform_report_frame_missing','platform_export_pending','platform_download_pending','settlement_frame_missing','settlement_controls_not_ready','settlement_export_pending','settlement_export_uncertain','operating_export_pending']);
const delays=[60000,300000,900000,1800000,3600000,5400000,7200000];
function retryable(job){return job.status==='interrupted'||job.status==='waiting_human'&&job.code==='client_browser_not_visible'||job.status==='failed'&&(transient.has(job.code)||job.code==='extension_element_ambiguous'&&job.diagnostics?.operation==='configure_report_fields'||job.code==='collector_no_active_source_rows'&&job.rejectedSource?.refreshAllowed===true);}
function retryDelay(job,count){return job.code==='collector_no_active_source_rows'?Math.max(1800000,delays[Math.min(count-1,delays.length-1)]):delays[Math.min(Math.max(0,count-1),delays.length-1)];}
async function visibleAgain(c,platform,work,now){
 if(now<(work.nextProbeAt||0))return false;work.nextProbeAt=now+300000;
 try{if(!c.extension?.available())return false;await c.extension.attach({platform}).page.bringToFront();return true;}catch{return false;}
}
function due(config,platform,day){return ['operating','product','settlement'].filter(type=>{const plan=config.plans.find(p=>p.report_type===platform+'_'+type);return Number(plan?.enabled)===1&&/^\d{2}:\d{2}$/.test(plan.run_time||'')&&day.time>=plan.run_time;});}
function attemptDay(work,last,legacy){
 if(work.attemptDay)return work.attemptDay;
 const stamp=work.lastAttemptAt||last?.startedAt||last?.finishedAt;
 return Number.isFinite(Date.parse(stamp))?core.chinaClock(stamp).day:legacy?.day;
}
function needsProof(job){return job?.status==='unverified'||job?.code==='collector_store_coverage_incomplete'&&job.result;}
async function refreshProof(c,last,config,work){
 if(!needsProof(last)||typeof c.cloud.call!=='function')return false;
 const platform=last.platform||'meituan_delivery',others=['operating','product','settlement'].filter(type=>type!==last.reportType);
 const dependencies=others.map(type=>{const job=[...c.history].reverse().find(j=>(j.platform||'meituan_delivery')===platform&&j.date===last.date&&j.reportType===type&&j.cloudReceipt?.verification?.storage_verified===true);return job?[type,job.result?.sha256||job.result?.receipts?.map(r=>r.sha256),job.cloudReceipt.verification.batch_id,job.cloudReceipt.verification.scope_version]:[type,null];});
 const key=JSON.stringify([config.version,dependencies]);if(work.proofKey===key)return false;
 if(c.busy||c.updating)return false;c.busy=true;const oldPhase=c.phase;c.phase='verification_pending';
 try{
  const proof=await c.cloud.call('/finish',{platform,type:last.reportType,date:last.date,scope_version:config.version});
  if(!['success','unverified'].includes(proof.status)||proof.verification?.storage_verified!==true)throw Error('client_cloud_receipt_invalid');
  const stamp=c.clock().toISOString(),job={...last,id:require('node:crypto').randomUUID(),source:'verification-refresh',previousJobId:last.id,status:proof.status==='success'?'completed':'unverified',startedAt:stamp,finishedAt:stamp,cloudReceipt:proof,message:proof.status==='success'?'相关报表到达后，既有原件及入库数据复核通过；未重复导出。':'既有原件已复核，来源或门店范围仍待核对；未重复导出。'};
  delete job.code;c.history.push(job);c.saveHistory?.();work.proofKey=key;work.status=job.status;return true;
 }catch(error){
  // A definitive source/range rejection remains reviewable. Network failures can
  // retry after backoff, but never cause an export from this readback path.
  if(error.message==='client_cloud_unreachable')work.nextProofAt=c.clock().getTime()+300000;
  else work.proofKey=key;
  c.event(platform+' '+last.date+' 既有原件复核未通过：'+core.publicError(error).code);return false;
 }finally{c.busy=false;c.phase=oldPhase;}
}
async function tick(c){if(c.scheduling)return false;c.scheduling=true;try{
 if(c.busy){await c.cloud.call('/heartbeat',{}).catch(()=>{});return false;}
 if(await require('./upload-queue.cjs').drain(c))return true;
 const day=core.chinaClock(c.clock());if(c.cloud.credentials?.scheduleStartDay&&day.day<c.cloud.credentials.scheduleStartDay)return false;let attempted=false;c.schedule.attempts||={};c.schedule.work||={};
 const oldest=new Date(Date.parse(day.yesterday+'T00:00:00Z')-2*86400000).toISOString().slice(0,10),first=c.cloud.credentials?.scheduleStartDay?new Date(Date.parse(c.cloud.credentials.scheduleStartDay+'T00:00:00Z')-86400000).toISOString().slice(0,10):oldest;
 const recent=date=>/^\d{4}-\d{2}-\d{2}$/.test(date)&&date>=oldest&&date>=first&&date<=day.yesterday;
 const reserved=Object.entries(c.schedule.work).filter(([key,work])=>work.status==='running'&&recent(key.slice(0,10))).map(([key])=>key.slice(0,10));
 const dates=[...new Set([day.yesterday,...reserved,...c.history.filter(j=>recent(j.date)&&(retryable(j)||needsProof(j))).map(j=>j.date)])].sort().reverse();
 for(const date of dates)for(const platform of platforms){let config;try{config=await c.cloud.config(date,platform);}catch{c.event(platform+'：无法同步云端范围，停止使用旧清单。');continue;}
  for(const type of due(config,platform,day)){
   if(c.uploadQueue?.some(e=>(e.job.platform||'meituan_delivery')===platform&&e.job.reportType===type&&e.job.date===date))continue;
   const key=platform+':'+type,workKey=date+':'+key,legacy=c.schedule.attempts[key],work=c.schedule.work[workKey]||={count:legacy?.day===day.day&&date===day.yesterday?legacy.count:0};
   let last=[...c.history].reverse().find(j=>(j.platform||'meituan_delivery')===platform&&j.date===date&&j.reportType===type);
   if(last?.status==='completed'){work.status='completed';continue;}
   if(needsProof(last)){if(c.clock().getTime()>=(work.nextProofAt||0)&&await refreshProof(c,last,config,work))attempted=true;continue;}
   if(!last&&work.count&&work.status==='running'&&Number.isFinite(Date.parse(work.lastAttemptAt))){
    // The previous process may have stopped after reserving work but before
    // persisting history. Check server originals before resuming local journals.
    c.recoveredState=true;work.recoveryReason='schedule_history_missing';
    last={status:'interrupted',startedAt:work.lastAttemptAt};
   }
   const previousDay=attemptDay(work,last,legacy);
   if(previousDay&&previousDay<day.day){work.previousAttemptDay=previousDay;work.previousAttemptCount=work.count;work.count=0;}
   work.attemptDay=day.day;
   if(work.count||last){
    if(!last||!retryable(last)||work.count>=8)continue;
    const stamp=Date.parse(last.finishedAt||last.startedAt);if(!Number.isFinite(stamp)||stamp+retryDelay(last,Math.max(1,work.count))>c.clock().getTime())continue;
    if(last.code==='client_browser_not_visible'&&!await visibleAgain(c,platform,work,c.clock().getTime()))continue;
    // Refresh the authorized page before a read/navigation retry. Submission journals
    // are preserved; no uncertain export is submitted a second time.
    if(transient.has(last.code)&&c.extension?.refreshedDays)c.extension.refreshedDays.delete(platform);
   }
   if(c.busy||c.updating)return attempted;
   work.count++;work.lastAttemptAt=c.clock().toISOString();work.status='running';
   c.schedule.attempts[key]={day:day.day,count:work.count};core.atomic(path.join(c.root,'schedule-state.json'),c.schedule);
   const started=c.start(date,date===day.yesterday?'schedule':'schedule-recovery',type,platform);await started.completion;
   const result=[...c.history].reverse().find(j=>j.date===date&&(j.platform||'meituan_delivery')===platform&&j.reportType===type);work.status=result?.status||'interrupted';work.code=result?.code||'';core.atomic(path.join(c.root,'schedule-state.json'),c.schedule);attempted=true;
  }
 }
 for(const key of Object.keys(c.schedule.work))if(key.slice(0,10)<oldest)delete c.schedule.work[key];
 core.atomic(path.join(c.root,'schedule-state.json'),c.schedule);
 return attempted;
}finally{c.scheduling=false;}}
module.exports={tick,due,platforms,retryable,retryDelay};
