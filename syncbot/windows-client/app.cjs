'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const core=require('./core.cjs'),{Collector}=require('./collector.cjs'),{createServer}=require('./server.cjs');
function launchUI(url,root,config){
  const child=spawn(core.discoverChrome(config),['--new-window',url],{detached:true,stdio:'ignore',windowsHide:false});child.on('error',()=>{});child.unref();
}
async function existing(instance){
  if(!instance||!Number.isInteger(instance.port)||instance.port<1||instance.port>65535||!/^[a-f0-9]{64}$/.test(instance.token||''))return null;
  try{const origin='http://127.0.0.1:'+instance.port,r=await fetch(origin+'/api/status',{headers:{'X-Client-Token':instance.token},signal:AbortSignal.timeout(1500)});return r.ok?origin+'/#'+instance.token:null;}catch{return null;}
}
async function main(){
  if(process.platform!=='win32'&&!process.argv.includes('--serve-only'))throw Error('client_windows_required');
  const root=core.dataRoot();fs.mkdirSync(root,{recursive:true,mode:0o700});
  const pauseFile=path.join(root,'user-paused.json');
  if(process.argv.includes('--native-recovery')&&core.read(pauseFile,null)?.paused)return;
  if(!process.argv.includes('--native-recovery')&&fs.existsSync(pauseFile))fs.unlinkSync(pauseFile);
  const instanceFile=path.join(root,'client-instance.json'),savedInstance=core.read(instanceFile,null),prior=await existing(savedInstance);
  if(prior){if(!process.argv.includes('--serve-only'))launchUI(prior,root,core.normalizeConfig(core.read(path.join(root,'settings.json'),{})));console.log('客户端已经运行。');return;}
  // A disk lock prevents concurrent double-clicks from launching two export workers.
  const lockFile=path.join(root,'client.lock');let lock;
  try{lock=fs.openSync(lockFile,'wx',0o600);}catch(error){if(error.code!=='EEXIST')throw error;const pid=Number(fs.readFileSync(lockFile,'utf8'));let live=true;if(Number.isSafeInteger(pid)&&pid>0){try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')live=false;}}else if(Date.now()-fs.statSync(lockFile).mtimeMs>60000)live=false;if(live)throw Error('client_already_starting');fs.unlinkSync(lockFile);lock=fs.openSync(lockFile,'wx',0o600);}
  fs.writeFileSync(lock,String(process.pid));fs.closeSync(lock);
  const release=()=>{try{if(fs.readFileSync(lockFile,'utf8')===String(process.pid))fs.unlinkSync(lockFile);}catch{}};process.once('exit',release);
  const collector=new Collector(root);collector.updateProbe=process.argv.includes('--update-probe');if(collector.updateProbe){collector.updating=true;collector.updateReady=false;}
  const defaults=path.join(__dirname,'setup-defaults.json');if(!fs.existsSync(path.join(root,'settings.json'))&&fs.existsSync(defaults))collector.save(core.read(defaults,{}));
  let timer,updater;const app=await createServer(collector,{...(process.argv.includes('--update-probe')&&savedInstance&&Number.isInteger(savedInstance.port)&&/^[a-f0-9]{64}$/.test(savedInstance.token||'')?{port:savedInstance.port,token:savedInstance.token}:{}),onQuit:()=>{clearInterval(timer);release();}});
  core.atomic(instanceFile,{port:app.server.address().port,token:app.token,pid:process.pid});
  collector.event(collector.cloud.enabled?'客户端已启动；已连接设备授权，采集结果以中控入库回读为准。':'客户端已启动；仅下载校验，云端上传未启用。');
  updater=new (require('./update-manager.cjs').UpdateManager)(collector,{stop:async()=>{clearInterval(timer);await collector.close();app.server.close();release();setTimeout(()=>process.exit(0),300).unref();}});
  timer=setInterval(()=>(async()=>{if(updater)await updater.tick();if(!collector.updating){const ran=await require('./remote-tasks.cjs').tick(collector);if(!ran)await collector.tick();}})().catch(error=>collector.event(core.publicError(error).message)),30000);timer.unref();if(collector.updateProbe){const probeTimer=setInterval(()=>{if(collector.updateReady){clearInterval(probeTimer);return;}updater.tick().catch(()=>{});},1000);probeTimer.unref();}
  app.server.on('close',()=>clearInterval(timer));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{clearInterval(timer);await collector.close().catch(()=>{});app.server.close();release();});
  if(!process.argv.includes('--serve-only')){try{launchUI(app.url,root,collector.config);}catch(error){collector.event(core.publicError(error).message);console.error('未能打开 Chrome 界面，请检查本机 Google Chrome 安装。');}}
  // No token, password, cookie or full browser page content goes to console.
  console.log('鹅太公外卖采集客户端已启动。');
  return app;
}
if(require.main===module)main().catch(error=>{console.error(core.publicError(error).message);console.error('诊断编号：'+(error.code||core.publicError(error).code));process.exitCode=1;});
module.exports={main,existing};
