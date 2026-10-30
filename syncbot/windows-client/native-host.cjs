'use strict';
// Only fixed polling/results. No arbitrary file, network or shell commands.
const fs=require('node:fs'),path=require('node:path');
const core=require('./core.cjs');
const MAX=1024*1024;
function diagnostic(phase,extra={}){try{const root=core.dataRoot();fs.mkdirSync(root,{recursive:true});core.atomic(path.join(root,'native-host-status.json'),{at:new Date().toISOString(),pid:process.pid,phase,...extra});}catch{}}
function encode(value){const data=Buffer.from(JSON.stringify(value));if(data.length>MAX)throw Error('native_message_too_large');const header=Buffer.alloc(4);header.writeUInt32LE(data.length);return Buffer.concat([header,data]);}
function decoder(onMessage){let pending=Buffer.alloc(0);return chunk=>{pending=Buffer.concat([pending,chunk]);while(pending.length>=4){const length=pending.readUInt32LE(0);if(!length||length>MAX)throw Error('native_message_too_large');if(pending.length<length+4)return;const message=JSON.parse(pending.subarray(4,length+4).toString('utf8'));pending=pending.subarray(length+4);onMessage(message);}};}
async function dispatch(message,{root=core.dataRoot(),fetchImpl=fetch}={}){
 const route=message?.type==='poll'?'/poll':message?.type==='result'?'/result':null;if(!route)throw Error('native_message_denied');
 const instance=core.read(path.join(root,'client-instance.json'),null);
 if(!instance||!Number.isInteger(instance.port)||instance.port<1||instance.port>65535||!/^[a-f0-9]{64}$/.test(instance.token))throw Error('client_extension_app_unavailable');
 const input=route==='/poll'?{frames:message.frames,extensionVersion:message.extensionVersion}:{id:message.id,ok:message.ok,...(message.ok?{value:message.value}:{error:message.error})};
 const response=await fetchImpl('http://127.0.0.1:'+instance.port+'/api/extension'+route,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','X-Client-Token':instance.token},body:JSON.stringify(input),signal:AbortSignal.timeout(5000)});
 const result=await response.json();if(!response.ok||result.ok!==true)throw Error('client_extension_app_rejected');return result;
}
function recoverApp(error,{root=core.dataRoot(),now=Date.now(),launch}={}){
 if(error.message!=='client_extension_app_unavailable'&&error.cause?.code!=='ECONNREFUSED')return false;
 if(core.read(path.join(root,'user-paused.json'),null)?.paused)return false;
 const journal=core.read(path.join(root,'updates/journal.json'),null);if(journal&&['applying','checking'].includes(journal.phase))return false;
 const file=path.join(root,'native-recovery.json'),state=core.read(file,{});if(now-(state.at||0)<60000)return false;
 core.atomic(file,{at:now});
 const start=launch||(()=>{const child=require('node:child_process').spawn(process.execPath,[path.join(__dirname,'bootstrap.cjs'),'--serve-only','--native-recovery'],{env:{...process.env,ETG_COLLECTOR_HOME:root},detached:true,windowsHide:true,stdio:'ignore'});child.on('error',()=>{});child.unref();});
 start();return true;
}
async function main(){
 diagnostic('starting',{customDataRoot:!!process.env.ETG_COLLECTOR_HOME});
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'chrome-extension/manifest.json'),'utf8'));
 const hash=require('node:crypto').createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32);
 const extensionId=[...hash].map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
 if(process.argv[2]!=='chrome-extension://'+extensionId+'/'){diagnostic('rejected',{error:'native_origin_denied'});throw Error('native_origin_denied');}
 diagnostic('origin_verified');
 let chain=Promise.resolve();const send=value=>process.stdout.write(encode(value));
 process.stdin.on('data',decoder(message=>{chain=chain.then(async()=>{
   try{const result=await dispatch(message);if(message.type==='poll')diagnostic('connected',{frameCount:message.frames.length,customDataRoot:!!process.env.ETG_COLLECTOR_HOME});if(result.command)send({type:'command',...result.command});else if(message.type==='poll')send({type:'bridge_ready'});else if(message.type==='result'){await new Promise(resolve=>setTimeout(resolve,20));send({type:'poll_again'});}}
   catch(error){if(message.type==='poll')try{recoverApp(error);}catch{}const code=/^[a-z][a-z0-9_]+$/.test(error.message)?error.message:'native_bridge_failed';diagnostic('failed',{error:code});send({type:'bridge_error',error:code});}
 }).catch(()=>{process.exitCode=1;});}));
 process.stdin.on('end',()=>{chain.finally(()=>process.exit());});
}
if(require.main===module)main().catch(()=>{process.exitCode=1;});
module.exports={encode,decoder,dispatch,recoverApp};
