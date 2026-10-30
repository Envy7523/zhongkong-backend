'use strict';
// Visible launcher: reports startup failures instead of hiding the Node process behind VBS.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),core=require('./core.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function current(root,{fetchImpl=fetch}={}){const i=core.read(path.join(root,'client-instance.json'),null);if(!i||!Number.isInteger(i.port)||!/^[a-f0-9]{64}$/.test(i.token||''))return null;try{const r=await fetchImpl('http://127.0.0.1:'+i.port+'/api/status',{headers:{'X-Client-Token':i.token},signal:AbortSignal.timeout(2000)});return r.ok?{url:'http://127.0.0.1:'+i.port+'/#'+i.token,state:await r.json()}:null;}catch{return null;}}
async function open({root=core.dataRoot(),directory=__dirname,fetchImpl=fetch,spawnImpl=spawn,timeout=30000}={}){
 fs.mkdirSync(root,{recursive:true});let active=await current(root,{fetchImpl});
 if(!active){const log=fs.openSync(path.join(root,'startup-diagnostic.log'),'a');try{const child=spawnImpl(process.execPath,[path.join(directory,'bootstrap.cjs'),'--serve-only'],{cwd:path.resolve(directory,'..'),env:{...process.env,ETG_COLLECTOR_HOME:root},detached:true,windowsHide:true,stdio:['ignore',log,log]});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();}finally{fs.closeSync(log);}const end=Date.now()+timeout;while(!active&&Date.now()<end){await pause(500);active=await current(root,{fetchImpl});}}
 if(!active){const state=core.read(path.join(root,'update-state.json'),{}),journal=core.read(path.join(root,'updates/journal.json'),{});console.log('启动未完成。更新状态：'+(state.status||'无')+'；恢复阶段：'+(journal.phase||'无'));const log=path.join(root,'startup-diagnostic.log');if(fs.existsSync(log))console.log(fs.readFileSync(log,'utf8').split(/\r?\n/).slice(-8).join('\n'));throw Error('client_startup_not_ready');}
 const chrome=core.discoverChrome(active.state.config);const browser=spawnImpl(chrome,['--new-window',active.url],{detached:true,windowsHide:false,stdio:'ignore'});await new Promise((resolve,reject)=>{browser.once('spawn',resolve);browser.once('error',reject);});browser.unref();console.log('客户端已联通，控制页面已交给原Chrome打开。');console.log('当前运行状态：'+active.state.phase+'；云端授权：'+(active.state.cloudUpload?'已配置':'未配置'));return {ok:true};
}
if(require.main===module)open().catch(e=>{console.error('启动诊断：'+(/^[a-z_]+$/.test(e.message)?e.message:'launcher_failed'));process.exitCode=1;});
module.exports={current,open};
