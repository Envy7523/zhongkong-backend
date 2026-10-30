'use strict';
const core=require('./core.cjs'),path=require('path');
const key=j=>(j.platform||'meituan_delivery')+':'+j.reportType+':'+j.date;
function quarantineRejected(c){
 const blocked=(c.uploadQueue||[]).filter(e=>e.job?.status==='failed'&&e.job.code&&e.job.code!=='client_cloud_unreachable');
 if(!blocked.length)return 0;
 const file=path.join(c.root,'blocked-uploads.json'),saved=core.read(file,[]),all=new Map(saved.map(e=>[key(e.job),e]));
 for(const e of blocked)all.set(key(e.job),{...e,blockedAt:c.clock().toISOString(),reason:e.job.code});
 // Persist the rejection and original receipt before removing it from the active queue.
 // The downloaded file and submission journal remain unchanged.
 core.atomic(file,[...all.values()].slice(-100));
 c.uploadQueue=c.uploadQueue.filter(e=>!blocked.includes(e));core.atomic(path.join(c.root,'pending-uploads.json'),c.uploadQueue);return blocked.length;
}
function remember(c,job){c.uploadQueue||=[];const index=c.uploadQueue.findIndex(e=>key(e.job)===key(job));if(['completed','unverified'].includes(job.status)){if(index>=0)c.uploadQueue.splice(index,1);}else if(job.result&&job.code==='client_cloud_unreachable'){const record={job:{...job},attempts:0,nextAt:new Date(c.clock().getTime()+60000).toISOString()};if(index<0)c.uploadQueue.push(record);else c.uploadQueue[index].job={...job};}core.atomic(path.join(c.root,'pending-uploads.json'),c.uploadQueue);}
async function drain(c){c.uploadQueue||=[];quarantineRejected(c);const entry=c.uploadQueue.find(e=>e.nextAt<=c.clock().toISOString());if(!entry)return false;await c.resumeUpload(entry);return true;}
module.exports={key,remember,drain,quarantineRejected};
