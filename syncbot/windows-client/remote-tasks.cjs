'use strict';
const path=require('node:path'),core=require('./core.cjs');
async function tick(c){if(c.remoteRunning||c.busy||c.updating||c.scheduling||!c.cloud.enabled||c.uploadQueue.length)return false;c.remoteRunning=true;c.scheduling=true;const file=path.join(c.root,'remote-task.json');try{
 let saved=core.read(file,null);if(saved?.result){await c.cloud.call('/tasks/result',saved.result);core.atomic(file,null);return true;}
 const response=await c.cloud.call('/tasks/next',{}),t=response.task;if(!t)return false;
 if(!/^[a-f0-9-]{36}$/.test(t.id)||!['meituan_delivery','jd_delivery','taobao_flash'].includes(t.platform)||!['operating','product','settlement'].includes(t.type))throw Error('remote_task_invalid');core.validBusinessDate(t.date,c.clock());
 let job=saved?.id===t.id&&saved.jobId?c.history.find(j=>j.id===saved.jobId):null;
 if(!job){const started=c.start(t.date,'remote-test',t.type,t.platform);core.atomic(file,{id:t.id,jobId:started.job.id});job=await started.completion;}
 const result={id:t.id,status:['completed','unverified','failed','waiting_human'].includes(job.status)?job.status:'interrupted',code:job.code||'',trace:job.diagnostics?.trace||[],operation:job.diagnostics?.operation||'',system_error:job.diagnostics?.system_error||'',storage_verified:job.cloudReceipt?.verification?.storage_verified===true,count:job.cloudReceipt?.verification?.storage_count};core.atomic(file,{id:t.id,result});await c.cloud.call('/tasks/result',result);core.atomic(file,null);return true;
 }catch(e){c.event('中控验收任务：'+(/^[a-z_]+$/.test(e.message)?e.message:'remote_task_failed'));return false;}finally{c.remoteRunning=false;c.scheduling=false;}}
module.exports={tick};
