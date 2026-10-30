'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),worker=require('./update-worker.cjs');
class UpdateManager{
 constructor(collector,{stop,installRoot=path.resolve(__dirname,'..')}={}){this.c=collector;this.stop=stop;this.installRoot=installRoot;this.next=0;this.running=false;this.healthChecks=0;}
 async tick(){const c=this.c;if(this.running||!c.cloud.enabled)return;this.running=true;try{
  const root=c.root,state=worker.read(path.join(root,'update-state.json'),{}),version=JSON.parse(fs.readFileSync(path.join(__dirname,'version.json'))).version;
  const journal=worker.read(path.join(root,'updates/journal.json'),null);if(journal&&['applying','checking'].includes(journal.phase)){c.updating=true;const ext=JSON.parse(fs.readFileSync(path.join(__dirname,'chrome-extension/manifest.json'))).version;if(c.extension.status().bridgeConnected&&!this.reloadRequested){this.reloadRequested=true;this.reloadAt=Date.now();await c.extension.reloadExtension();}if(this.reloadRequested&&c.extension.status().extensionVersion===ext&&c.extension.seen>this.reloadAt+1000)c.updateReady=true;return;}c.updating=false;
  const status={version,sequence:state.sequence||0,channel:state.channel||'stable',status:state.status||'current',error:state.error||'',extensionVersion:c.extension.status().extensionVersion||'',busy:c.busy};await c.cloud.call('/updates/status',status);
  if(!c.busy&&!c.scheduling)require('./upload-queue.cjs').quarantineRejected(c);
  if(c.busy||c.scheduling||c.uploadQueue.length||c.extension.pending.size||Date.now()<this.next)return;this.next=Date.now()+60000;
  const offer=await c.cloud.call('/updates/check',{version,sequence:state.sequence||0});if(!offer.release)return;
  
  const m=worker.verify(offer.release.envelope,fs.readFileSync(path.join(__dirname,'update-public-key.pem')),{sequence:state.sequence||0,channel:offer.channel,installRoot:this.installRoot});
  // Recheck after network I/O; a manual/scheduled task may have started while downloading.
  if(m.sequence===state.failedSequence)return;if(c.busy||c.scheduling||c.uploadQueue.length||c.extension.pending.size)return;c.updating=true;
  worker.atomic(path.join(root,'update-state.json'),{...state,channel:offer.channel});worker.atomic(path.join(root,'updates/staged.json'),offer.release.envelope);
  c.event('更新 '+m.version+' 已验证，空闲升级；失败将恢复旧版本。');
  await c.cloud.call('/updates/status',{...status,status:'installing',targetVersion:m.version});
  const child=spawn(process.execPath,[path.join(__dirname,'update-worker.cjs'),root,this.installRoot,String(process.pid)],{detached:true,windowsHide:true,stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();await this.stop();
 }catch(e){this.c.updating=['applying','checking'].includes(worker.read(path.join(this.c.root,'updates/journal.json'),{})?.phase);this.c.event('软件更新未完成：'+(/^[a-z_]+$/.test(e.message)?e.message:'update_check_failed'));this.next=Date.now()+60000;}finally{this.running=false;}}
}
module.exports={UpdateManager};
