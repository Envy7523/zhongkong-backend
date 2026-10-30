'use strict';
// Stable recovery/trust boundary. This file and bootstrap.cjs cannot be replaced by remote releases.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const MAX=16*1024*1024, VERSION=/^\d+\.\d+\.\d+$/;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=(p,fallback)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
function atomic(p,v){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p+'.tmp',JSON.stringify(v));fs.renameSync(p+'.tmp',p);}
function target(root,relative){
 if(typeof relative!=='string'||! /^(windows-client|src\/(meituan-delivery|jd-delivery|taobao-flash))\/[A-Za-z0-9_./-]+$/.test(relative)||relative.split('/').some(x=>!x||x==='.'||x==='..'||/[. ]$/.test(x)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(x))||! /\.(cjs|js|json|html|css|md)$/.test(relative)||/^(windows-client\/(bootstrap\.cjs|update-worker\.cjs|update-public-key\.pem|setup-defaults\.json|native-host-manifest\.json))$/.test(relative.toLowerCase()))throw Error('update_path_denied');
 const base=fs.realpathSync(root),file=path.resolve(base,...relative.split('/'));if(!file.startsWith(base+path.sep))throw Error('update_path_denied');
 for(let p=file;p!==base;p=path.dirname(p))if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('update_symlink_denied');return file;
}
function verify(envelope,publicKey,{sequence=0,channel,installRoot}={}){
 if(!envelope||typeof envelope.payload!=='string'||envelope.payload.length>MAX*1.4||typeof envelope.signature!=='string')throw Error('update_envelope_invalid');
 const bytes=Buffer.from(envelope.payload,'base64');if(!crypto.verify(null,bytes,publicKey,Buffer.from(envelope.signature,'base64')))throw Error('update_signature_invalid');
 const m=JSON.parse(bytes);const installed=JSON.parse(fs.readFileSync(path.join(installRoot,'windows-client/version.json'))).version;const compare=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;};if(!VERSION.test(m.version)||compare(m.version,installed)<=0||!Number.isSafeInteger(m.sequence)||m.sequence<=sequence||!['test','stable'].includes(m.channel)||channel&&m.channel!==channel||!Array.isArray(m.files)||!m.files.length||m.files.length>300)throw Error('update_manifest_invalid');
 let size=0;const names=new Set();for(const f of m.files){if(names.has(String(f.path).toLowerCase()))throw Error('update_duplicate_path');names.add(f.path.toLowerCase());const file=target(installRoot,f.path),b=Buffer.from(f.data||'','base64');size+=b.length;if(size>MAX||b.length!==f.size||sha(b)!==f.sha256)throw Error('update_hash_invalid');if(f.path.toLowerCase()==='windows-client/chrome-extension/manifest.json'){
  const old=JSON.parse(fs.readFileSync(file,'utf8')),next=JSON.parse(b);for(const key of ['key','permissions','host_permissions','optional_permissions','optional_host_permissions','content_scripts','externally_connectable','background'])if(JSON.stringify(old[key])!==JSON.stringify(next[key]))throw Error('update_extension_permission_change_requires_manual_install');
 }}
 const version=m.files.find(f=>f.path==='windows-client/version.json');if(!version||JSON.parse(Buffer.from(version.data,'base64')).version!==m.version)throw Error('update_version_file_required');return m;
}
function rollback(root,installRoot,journal){for(const f of [...journal.files].reverse()){const file=target(installRoot,f.path);if(f.existed){const backup=path.join(root,'updates','backup',f.path);const b=fs.readFileSync(backup);if(sha(b)!==f.sha256)throw Error('update_backup_corrupt');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,b);}else if(fs.existsSync(file))fs.unlinkSync(file);}
 atomic(path.join(root,'update-state.json'),{...journal.before,status:'rolled_back',failedSequence:journal.sequence,error:'update_health_failed',at:new Date().toISOString()});atomic(path.join(root,'updates/journal.json'),{...journal,phase:'rolled_back'});
}
function recover(root,installRoot){const j=read(path.join(root,'updates/journal.json'),null);if(j&&['applying','checking'].includes(j.phase)){if(j.workerPid){try{process.kill(j.workerPid,0);return false;}catch{}}rollback(root,installRoot,j);return true;}return false;}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function healthy(root,version,timeout=60000){const until=Date.now()+timeout;while(Date.now()<until){try{const i=read(path.join(root,'client-instance.json'),{});if(Number.isInteger(i.port)&&/^[a-f0-9]{64}$/.test(i.token||'')){const r=await fetch('http://127.0.0.1:'+i.port+'/api/update-health',{headers:{'X-Client-Token':i.token},signal:AbortSignal.timeout(1000)}),v=await r.json();if(r.ok&&v.ok&&v.version===version)return true;}}catch{}await pause(500);}return false;}
function launch(root,installRoot){return spawn(process.execPath,[path.join(installRoot,'windows-client/bootstrap.cjs'),'--serve-only','--update-probe'],{cwd:installRoot,env:{...process.env,ETG_COLLECTOR_HOME:root},detached:true,windowsHide:true,stdio:'ignore'});}
async function apply(root,installRoot,{health=healthy,start=launch,parentPid=0}={}){
 const key=fs.readFileSync(path.join(installRoot,'windows-client/update-public-key.pem')),before=read(path.join(root,'update-state.json'),{}),envelope=read(path.join(root,'updates/staged.json'),null),m=verify(envelope,key,{sequence:before.sequence||0,channel:before.channel||'stable',installRoot});
 if(parentPid){let gone=false;for(let n=0;n<100;n++){try{process.kill(parentPid,0);}catch{gone=true;break;}await pause(100);}if(!gone)throw Error('update_parent_still_running');}
 const files=m.files.map(f=>{const file=target(installRoot,f.path),existed=fs.existsSync(file),old=existed?fs.readFileSync(file):null;if(existed){const backup=path.join(root,'updates/backup',f.path);fs.mkdirSync(path.dirname(backup),{recursive:true});fs.writeFileSync(backup,old);}return {path:f.path,existed,sha256:old?sha(old):null};});
 const journal={phase:'applying',workerPid:process.pid,before,sequence:m.sequence,files};atomic(path.join(root,'updates/journal.json'),journal);let child;
 try{for(const f of m.files){const file=target(installRoot,f.path);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,Buffer.from(f.data,'base64'));}journal.phase='checking';atomic(path.join(root,'updates/journal.json'),journal);child=start(root,installRoot);child?.on?.('error',()=>{});if(!await health(root,m.version))throw Error('update_health_failed');
  atomic(path.join(root,'update-state.json'),{version:m.version,sequence:m.sequence,channel:m.channel,status:'applied',at:new Date().toISOString()});atomic(path.join(root,'updates/journal.json'),{...journal,phase:'complete'});child?.unref?.();return {ok:true,version:m.version};
 }catch(e){if(child?.pid){try{child.kill();}catch{}await pause(1000);}rollback(root,installRoot,journal);const old=start(root,installRoot);old?.on?.('error',()=>{});old?.unref?.();return {ok:false,status:'rolled_back'};}
}
if(require.main===module)apply(path.resolve(process.argv[2]),path.resolve(process.argv[3]),{parentPid:Number(process.argv[4])||0}).then(()=>process.exit()).catch(async e=>{console.error(e.message);await pause(1200);const child=launch(path.resolve(process.argv[2]),path.resolve(process.argv[3]));child.on('error',()=>{});child.unref();process.exitCode=1;});
module.exports={verify,target,apply,recover,rollback,atomic,read,sha};
