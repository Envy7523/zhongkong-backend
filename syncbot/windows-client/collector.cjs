'use strict';
const fs=require('node:fs'),path=require('node:path');
const core=require('./core.cjs');
const {attachExistingChrome,platformPage}=require('./existing-chrome.cjs');
const {runOperating}=require('../src/meituan-delivery/runner');
class Collector {
  constructor(root,{browserType,run=runOperating,runners={},clock=()=>new Date(),findChrome=core.discoverChrome}={}) {
    this.runners=runners;this.root=root;this.browserType=browserType;this.findChrome=findChrome;this.run=run;this.clock=clock;this.context=null;this.page=null;this.connection=null;this.busy=false;this.phase='idle';
    fs.mkdirSync(root,{recursive:true,mode:0o700});
    this.config=core.normalizeConfig(core.read(path.join(root,'settings.json'),{}));
    this.history=core.read(path.join(root,'history.json'),[]);
    if(!Array.isArray(this.history))throw Error('client_saved_data_invalid');
    this.history=this.history.slice(-100).map(job=>['running','queued'].includes(job.status)?{...job,status:'interrupted',message:'程序曾退出；可点击重新采集以恢复原下载任务。'}:job);
    this.extension=new (require('./extension-broker.cjs').ExtensionBroker)();
    this.cloud=new (require('./cloud.cjs').Cloud)(root);
    this.uploadQueue=core.read(path.join(root,'pending-uploads.json'),[]);if(!Array.isArray(this.uploadQueue))throw Error('client_saved_data_invalid');for(const job of this.history)if(this.cloud.enabled&&job.cloudEnabled===true&&job.result&&['interrupted','downloaded'].includes(job.status)&&!this.uploadQueue.some(e=>require('./upload-queue.cjs').key(e.job)===require('./upload-queue.cjs').key(job)))this.uploadQueue.push({job:{...job},attempts:0,nextAt:this.clock().toISOString()});core.atomic(path.join(root,'pending-uploads.json'),this.uploadQueue);
    this.schedule=core.read(path.join(root,'schedule-state.json'),{});this.events=[];
    this.recoveredState=core.read(path.join(root,'state-recovery.json'),null)?.server_recheck_required===true;
    require('./upload-queue.cjs').quarantineRejected(this);
  }
  downloadDiagnostics(platform){try{return require('./download-diagnostics.cjs').downloadDiagnostics(platform,require('./download-directory.cjs').resolveDownloadDirectory(this.config));}catch{return ['download_directory_unavailable'];}}
  event(message){const event={at:this.clock().toISOString(),message};this.events.push(event);this.events=this.events.slice(-100);fs.appendFileSync(path.join(this.root,'client-events.jsonl'),JSON.stringify(event)+'\n',{mode:0o600});}
  save(config){if(this.busy)throw Error('client_busy');this.config=core.normalizeConfig(config);core.atomic(path.join(this.root,'settings.json'),this.config);this.event('配置已保存；没有保存平台密码。');return this.config;}
  saveHistory(){core.atomic(path.join(this.root,'history.json'),this.history.slice(-100));}
  state(){return {config:this.config,busy:this.busy,phase:this.phase,browserOpen:!!this.context,browserMode:this.config.browserMode,root:this.root,now:this.clock().toISOString(),yesterday:core.chinaClock(this.clock()).yesterday,history:this.history.slice(-30).reverse(),events:this.events.slice(-30).reverse(),pendingUploads:this.uploadQueue.length,cloudUpload:this.cloud.enabled};}
  async browser({front=false}={}){
    if(this.connection&&this.page&&!this.page.isClosed()&&(this.connection.mode||'existing')===this.config.browserMode&&(this.config.browserMode==='managed'||platformPage(this.page))){if(front)await this.page.bringToFront();return;}
    if(this.connection)await this.close();
    if(this.config.browserMode==='extension'){
      if(this.extension.ensurePlatform)await this.extension.ensurePlatform('meituan_delivery');this.connection=this.extension.attach();this.context=this.connection.context;this.page=this.connection.page;
      this.event('已通过采集扩展连接原有Chrome；未使用远程调试连接。');
      if(front)await this.page.bringToFront();return;
    }
    const browserType=this.browserType||require('playwright').chromium;
    this.connection=this.config.browserMode==='managed'?await require('./managed-chrome.cjs').launchManagedChrome(browserType,{root:this.root,executablePath:this.findChrome(this.config),onError:error=>this.event(core.publicError(error).message)}):await attachExistingChrome(browserType);this.context=this.connection.context;this.page=this.connection.page;
    const current=this.connection;this.connection.browser.on('disconnected',()=>{if(this.connection===current){this.connection=null;this.context=null;this.page=null;}this.event('与现有 Chrome 的连接已断开，原浏览器及登录状态保留。');});
    this.event(this.config.browserMode==='managed'?'已启动程序管理的专用 Chrome，复用本机独立登录资料。':'已连接现有 Chrome 的美团标签页；没有重新登录、创建窗口或复制登录资料。');
    if(front)await this.page.bringToFront();
  }
  async openLogin(){if(this.busy)throw Error('client_busy');this.busy=true;try{await this.browser({front:true});return {ok:true};}finally{this.busy=false;}}
  start(date,source='manual',reportType='operating',platform='meituan_delivery'){
    if(!['meituan_delivery','taobao_flash','jd_delivery'].includes(platform))throw Error('client_platform_invalid');
    if(!['operating','product','settlement'].includes(reportType))throw Error('client_report_type_invalid');
    if(this.busy||this.updating)throw Error('client_busy');if(!this.cloud.enabled)core.configured(this.config);core.validBusinessDate(date,this.clock());
    this.busy=true;this.phase='starting';
    const job={platform,cloudEnabled:this.cloud.enabled,id:require('node:crypto').randomUUID(),date,source,reportType,status:'running',startedAt:this.clock().toISOString(),message:'正在启动采集；此版本不会上传云端。'};
    this.history.push(job);this.saveHistory();this.event('开始采集 '+date+'。');
    const completion=this.execute(job).finally(()=>{this.busy=false;this.phase='idle';});
    this.completion=completion;return {job,completion};
  }
  async execute(job){
    if(job.platform&&job.platform!=="meituan_delivery")return this.executePlatform(job);
    let cloudScope;
    try{
      if(this.cloud.enabled){cloudScope=await this.cloud.config(job.date);if(await this.reuseServerProof(job,cloudScope))return job;await this.cloud.event({type:job.reportType,date:job.date,status:'running'});if(!cloudScope.bindings.length)throw Error('collector_scope_unconfigured');this.config.account=cloudScope.account;this.config.storeIds=cloudScope.bindings.map(r=>r.platform_id);await require('./rejected-source.cjs').prepare(this,job,cloudScope);}
      const apiClient={call:async(_root,endpoint)=>{if(endpoint!=='/api/internal/syncbot/meituan-delivery/scope')throw Error('client_cloud_not_configured');return cloudScope||{ok:true,bindings:this.config.storeIds.map(platform_id=>({platform_id}))};}};
      const product=job.reportType==='product',settlement=job.reportType==='settlement';
      let runner=this.runners[job.reportType]||(settlement?require('../src/meituan-delivery/settlement-all-runner').runSettlementAll:product?require('../src/meituan-delivery/product-runner').runProduct:this.run);
      const scopeKey=cloudScope?.version.slice(0,12)||'',type=settlement?'meituan_delivery_settlement':product?'meituan_delivery_product':'meituan_delivery_operating';
      const saved=cloudScope?core.read(path.join(this.root,'state/tasks/meituan_delivery',type,job.date+'_custom_'+scopeKey+'.json'),null):null;
      const legacySettlement=settlement&&saved?.source_mode!=='all_stores'&&cloudScope?.bindings.every(r=>saved?.jobs?.[r.platform_id]?.file);
      if(legacySettlement&&!this.runners[job.reportType])runner=require('../src/meituan-delivery/settlement-runner').runSettlement;
      const archived=saved?.date===job.date&&saved.account===this.config.account&&(settlement?(saved.source_mode==='all_stores'?!!saved.file:legacySettlement):!!saved.file);
      if(!archived&&job.source==='schedule'&&this.config.browserMode==='existing'&&(!this.connection||!this.page||this.page.isClosed()))throw Error('client_existing_chrome_manual_connection_required');
      if(settlement&&!legacySettlement&&cloudScope&&!this.runners[job.reportType]&&!cloudScope.capabilities?.settlement_all_stores)throw Error('collector_all_stores_server_upgrade_required');
      const request={root:this.root,date:job.date,account:this.config.account,scopeKey,downloadOnly:true,explicitStoreSelection:true,preserveViewport:true,apiClient,downloadFile:require('./local-download.cjs')[product?'downloadLocalProductJob':'downloadLocalOperatingJob'],onProgress:update=>{this.phase=update.phase;}};
      let result;if(archived){job.reusedLocalArchive=true;result=await runner(request);}else{if(this.config.browserMode==='extension'){await this.extension.refreshPlatform('meituan_delivery');await this.close();}await this.browser();const sourceDirectory=this.connection.sourceDirectory||require('./download-directory.cjs').resolveDownloadDirectory(this.config);result=await this.connection.withActivePage(()=>runner({...request,page:this.page,context:this.context,...(sourceDirectory?{sourceDirectory,downloadFile:(frame,options)=>request.downloadFile(frame,{...options,sourceDirectory})}:{})}));}
      if(result.phase!=='downloaded'||result.uploaded!==false)throw Error('client_download_receipt_invalid');
      Object.assign(job,{status:'downloaded',result,message:settlement?'结算原件与各交易类型金额核对通过；应收不代表银行到账，无明细门店仍需核对，尚未上传云端。':product?'商品原件校验通过；无明细门店及日期口径差异需核对，尚未上传云端。':result.totals_complete?'下载与文件校验通过，尚未上传云端。':'文件结构和门店校验通过，但营业指标存在空值；尚未上传云端。'});
      this.saveHistory();
      if(this.cloud.enabled){const receipt=await this.cloud.upload(job,result,cloudScope);Object.assign(job,{status:receipt.status==='success'?'completed':'unverified',cloudReceipt:receipt,message:receipt.status==='success'?'云端入库及回读核验通过。':'已入库，部分门店配置或源指标仍需核对，请查看中控每日更新。'});}
      this.event(job.date+'：'+job.message);
    }catch(error){const failure=core.publicError(error);job.diagnostics={operation:error.operation||'',system_error:error.cause?.code||'',trace:[...await require('./rejected-source.cjs').upload(this,job,cloudScope,error),...(error.trace||[]),...this.downloadDiagnostics(job.platform||'meituan_delivery'),...await this.extension.failureCodes(job.platform||'meituan_delivery')]};Object.assign(job,{status:['operating_human_login_required','operating_account_mismatch','client_login_required','client_browser_not_visible','client_platform_access_denied','client_platform_login_expired','client_existing_chrome_manual_connection_required','client_existing_chrome_authorization_required','client_existing_platform_tab_missing','client_multiple_platform_tabs'].includes(failure.code)?'waiting_human':'failed',...failure});if(this.cloud.enabled)await this.cloud.event({type:job.reportType,date:job.date,status:job.status==='waiting_human'?'waiting_human':'failed',error:failure.code,diagnostics:job.diagnostics});this.event(job.date+'：'+failure.message);}
    finally{job.finishedAt=this.clock().toISOString();require('./upload-queue.cjs').remember(this,job);this.saveHistory();}
    return job;
  }
  async tick(){if(this.updating)return false;if(this.cloud.enabled&&this.cloud.credentials?.multiPlatform===true)return require("./platform-schedule.cjs").tick(this);if(this.cloud.enabled){if(this.busy){await this.cloud.call('/heartbeat',{}).catch(()=>{});return false;}const day=core.chinaClock(this.clock());let config;try{config=await this.cloud.config(day.yesterday);}catch{this.event('无法同步云端门店或计划；本次停止，不使用旧清单冒充同步成功。');return false;}this.config.account=config.account;this.config.storeIds=config.bindings.map(r=>r.platform_id);this.schedule.attempts||={};let attempted=false;for(const [type,report] of Object.entries({operating:'meituan_delivery_operating',product:'meituan_delivery_product',settlement:'meituan_delivery_settlement'})){const plan=config.plans.find(p=>p.report_type===report);if(!plan?.enabled||day.time<plan.run_time)continue;if(this.schedule.attempts[type]===day.day){const retry=this.recovery(type,day);if(!retry)continue;this.schedule.recoveries||={};this.schedule.recoveries[type]=retry;}this.schedule.attempts[type]=day.day;core.atomic(path.join(this.root,'schedule-state.json'),this.schedule);await this.start(day.yesterday,'schedule',type).completion;attempted=true;}return attempted;}const due=core.scheduleDue(this.config,this.schedule.lastAttemptDay,this.clock());if(!due||this.busy)return false;
    // One automatic attempt per Beijing calendar day. Human-required failures never loop on CAPTCHA/login.
    this.schedule={lastAttemptDay:due.day,date:due.yesterday,attemptedAt:this.clock().toISOString()};core.atomic(path.join(this.root,'schedule-state.json'),this.schedule);
    const task=this.start(due.yesterday,'schedule');await task.completion;return true;
  }
  async executePlatform(job){
    let scope;
    try{
      if(!this.cloud.enabled)throw Error('client_cloud_not_configured');
      scope=await this.cloud.config(job.date,job.platform);if(await this.reuseServerProof(job,scope))return job;if(!scope.bindings.length)throw Error('collector_scope_unconfigured');
      await this.cloud.event({platform:job.platform,type:job.reportType,date:job.date,status:'running'});
      await require('./rejected-source.cjs').prepare(this,job,scope);
      const runner=this.runners[job.platform+':'+job.reportType]||require('./platform-runner.cjs').runPlatform;
      const result=await runner({root:this.root,platform:job.platform,type:job.reportType,date:job.date,scope,downloadDirectory:this.config.downloadDirectory,extension:this.extension,onProgress:u=>{this.phase=u.phase;}});
      job.result=result;this.saveHistory();const receipt=await this.cloud.upload(job,result,scope);
      Object.assign(job,{status:receipt.status==='success'?'completed':'unverified',cloudReceipt:receipt,message:receipt.status==='success'?'服务器入库和逐项回读核验通过。':'已上传入库，但门店范围或来源尚需核对。'});
    }catch(error){const failure=core.publicError(error);job.diagnostics={operation:error.operation||'',trace:[...await require('./rejected-source.cjs').upload(this,job,scope,error),...(error.trace||[]),...this.downloadDiagnostics(job.platform||'meituan_delivery'),...await this.extension.failureCodes(job.platform)]};Object.assign(job,{status:/login|account_mismatch|access_denied|browser_not_visible/.test(failure.code)?'waiting_human':'failed',...failure});await this.cloud.event({platform:job.platform,type:job.reportType,date:job.date,status:job.status,error:failure.code,diagnostics:job.diagnostics});}
    finally{job.finishedAt=this.clock().toISOString();require('./upload-queue.cjs').remember(this,job);this.saveHistory();this.event(job.platform+' '+job.date+' '+job.reportType+'：'+job.message);}
    return job;
  }
  async resumeUpload(entry){
    if(this.busy)throw Error('client_busy');this.busy=true;this.phase='import_pending';
    const job={...entry.job,id:require('crypto').randomUUID(),source:'upload-retry',status:'running',startedAt:this.clock().toISOString()};delete job.finishedAt;this.history.push(job);this.saveHistory();
    try{const scope=await this.cloud.config(job.date,job.platform||'meituan_delivery');await this.cloud.event({platform:job.platform||'meituan_delivery',type:job.reportType,date:job.date,status:'running'});const receipt=await this.cloud.upload(job,job.result,scope);delete job.code;Object.assign(job,{status:receipt.status==='success'?'completed':'unverified',cloudReceipt:receipt,message:'本地原件已补传，结果以服务器回读核验为准。'});this.uploadQueue=this.uploadQueue.filter(e=>e!==entry);}
    catch(error){Object.assign(job,{status:'failed',...core.publicError(error)});entry.attempts++;entry.job={...job};entry.nextAt=new Date(this.clock().getTime()+Math.min(900000,60000*2**Math.min(entry.attempts,4))).toISOString();if(job.code!=='client_cloud_unreachable'){entry.nextAt='9999-12-31T00:00:00.000Z';await this.cloud.event({platform:job.platform||'meituan_delivery',type:job.reportType,date:job.date,status:'failed',error:job.code});}}
    finally{job.finishedAt=this.clock().toISOString();core.atomic(path.join(this.root,'pending-uploads.json'),this.uploadQueue);require('./upload-queue.cjs').quarantineRejected(this);this.saveHistory();this.busy=false;this.phase='idle';}return job;
  }
  async close(){const connection=this.connection;this.connection=null;this.context=null;this.page=null;if(connection)await connection.disconnect();}
  async reuseServerProof(job,scope){
    if(!this.recoveredState)return false;
    try{const proof=await this.cloud.call('/finish',{platform:job.platform||'meituan_delivery',type:job.reportType,date:job.date,scope_version:scope.version,dryRun:false});
      if(proof.verification?.storage_verified!==true)throw Error('client_cloud_receipt_invalid');
      Object.assign(job,{status:proof.status==='success'?'completed':'unverified',cloudReceipt:proof,reusedServerProof:true,message:'状态恢复后已独立核对云端既有原件及入库数据，未重新导出。'});return true;
    }catch(error){if(error.message==='collector_files_incomplete')return false;throw error;}
  }
  recovery(type,day){
    if(!['managed','extension'].includes(this.config.browserMode))return null;
    const last=[...this.history].reverse().find(j=>j.reportType===type&&j.date===day.yesterday);
    if(!last||last.source!=='schedule'||!last.startedAt||core.chinaClock(last.startedAt).day!==day.day)return null;
    const transient=new Set(['client_cloud_unreachable','client_browser_unavailable','operating_export_pending','settlement_export_pending']);
    if(this.config.browserMode==='extension'&&last.code==='client_extension_not_connected'){
      if(!this.extension.available())return null;
      transient.add('client_extension_not_connected');
    }
    if(last.status!=='interrupted'&&!(last.status==='failed'&&transient.has(last.code)))return null;
    const previous=this.schedule.recoveries?.[type],count=previous?.day===day.day?previous.count:0;if(count>=3)return null;
    const delay=[60000,300000,900000][count],stamp=Date.parse(last.finishedAt||last.startedAt);
    if(!Number.isFinite(stamp)||(last.status!=='interrupted'&&this.clock().getTime()-stamp<delay))return null;
    return {day:day.day,count:count+1};
  }
}
module.exports={Collector};
