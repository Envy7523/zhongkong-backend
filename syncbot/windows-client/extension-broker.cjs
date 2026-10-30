'use strict';
const crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const reads=require('./chrome-extension/reads.js');
const normalize=fn=>fn.toString().replace(/\s/g,'');
const readers=new Map(Object.entries(reads).map(([key,fn])=>[normalize(fn),key]));
const pattern=(value,exact=false)=>value instanceof RegExp?{regex:value.source,flags:value.flags}:{text:String(value),exact};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const PLATFORM_ORIGINS={meituan_delivery:'https://waimaie.meituan.com',taobao_flash:'https://melody.shop.ele.me',jd_delivery:'https://store.jddj.com'};
function safeFrame(frame){try{const u=new URL(frame.url);return Number.isInteger(frame.tabId)&&Number.isInteger(frame.frameId)&&['https://waimaie.meituan.com','https://waimaieapp.meituan.com','https://melody.shop.ele.me','https://store.jddj.com','https://kunce-store.jddj.com','https://melody-stats-next.ele.me','https://napos-bill-pc.faas.ele.me'].includes(u.origin)&&!u.search&&!u.username&&!u.password&&(!u.hash||u.hash==='#/downloads/downloadBill');}catch{return false;}}
class ExtensionBroker{
 constructor({timeout=45000,clock=Date.now}={}){this.timeout=timeout;this.clock=clock;this.frames=[];this.seen=0;this.pending=new Map();this.diagnostics=[];}
 poll(input){if(!Array.isArray(input.frames)||input.frames.length>100||input.frames.some(frame=>!safeFrame(frame)))throw Error('extension_frames_invalid');this.extensionVersion=/^\d+\.\d+\.\d+$/.test(input.extensionVersion||'')?input.extensionVersion:null;this.frames=input.frames;this.seen=this.clock();const task=[...this.pending.values()].find(task=>!task.sent);if(!task)return {ok:true};task.sent=true;return {ok:true,command:task.command};}
 result(input){const task=this.pending.get(input.id);if(!task||!task.sent)throw Error('extension_result_unexpected');if(typeof input.ok!=='boolean')throw Error('extension_result_invalid');this.pending.delete(input.id);clearTimeout(task.timer);if(input.ok)task.resolve(input.value);else task.reject(Error(/^[a-z][a-z0-9_]+$/.test(input.error||'')?input.error:'extension_operation_failed'));return {ok:true};}
 available(){return this.clock()-this.seen<12000&&this.frames.some(f=>f.frameId===0);}
 status(){const platforms=Object.fromEntries(Object.entries(PLATFORM_ORIGINS).map(([name,origin])=>[name,{tabs:new Set(this.frames.filter(f=>f.frameId===0&&new URL(f.url).origin===origin).map(f=>f.tabId)).size}]));return {extensionVersion:this.extensionVersion,bridgeConnected:this.seen>0&&this.clock()-this.seen<12000,brandTabs:platforms.meituan_delivery.tabs,platforms,frameCount:this.frames.length};}
 async failureCodes(platform){const last=this.diagnostics.at(-1),diagnostic=last?['last_'+last.action+'_'+(last.error||String(last.result??'unknown')).replace(/[^a-z0-9_]/g,'').slice(0,80),'locator_'+crypto.createHash('sha256').update(JSON.stringify(last.steps||[])).digest('hex').slice(0,16)]:[];try{const page=this.attach({platform}).page,front=this.lastFront,codes=[...diagnostic,...(front?.tabId===page.descriptor.tabId?['front_active_'+Number(front.active===true),'front_focused_'+Number(front.focused===true),'front_state_'+(['normal','minimized','maximized','fullscreen'].includes(front.state)?front.state:'unknown')]:[])];const frame=page.frames().find(f=>f.descriptor.frameId===last?.frameId)||page;for(const target of (frame.descriptor.frameId===0?[page]:[frame,page])){await this.call(target.descriptor,{action:'refreshControls'});const values=await this.call(target.descriptor,{action:'collectorLayout'});codes.push(...values.map(v=>(target.descriptor.frameId===0?'main_':'report_')+v));}return codes;}catch{return [...diagnostic,'layout_unavailable'];}}
 main(platform='meituan_delivery'){if(!Object.hasOwn(PLATFORM_ORIGINS,platform))throw Error('client_platform_invalid');if(!this.available())throw Error('client_extension_not_connected');const mains=this.frames.filter(f=>f.frameId===0&&new URL(f.url).origin===PLATFORM_ORIGINS[platform]);if(mains.length!==1)throw Error(mains.length?'client_multiple_platform_tabs':'client_existing_platform_tab_missing');return mains[0];}
 call(frame,command){if(!this.available())return Promise.reject(Error('client_extension_not_connected'));const id=crypto.randomBytes(16).toString('hex');return new Promise((resolve,reject)=>{const task={command:{id,tabId:frame.tabId,frameId:frame.frameId,url:frame.url,command},resolve,reject,sent:false};task.timer=setTimeout(()=>{this.pending.delete(id);reject(Error('client_extension_command_timeout'));},this.timeout);this.pending.set(id,task);});}
 async reloadExtension(){if(!this.status().bridgeConnected)throw Error('client_extension_not_connected');const id=crypto.randomBytes(16).toString('hex');return new Promise((resolve,reject)=>{const task={command:{id,command:{action:'reloadExtension'}},resolve,reject,sent:false};task.timer=setTimeout(()=>{this.pending.delete(id);reject(Error('client_extension_command_timeout'));},this.timeout);this.pending.set(id,task);});}
 async refreshPlatform(platform){
  const day=new Date(this.clock()+28800000).toISOString().slice(0,10);this.refreshedDays||=new Map();
  if(this.refreshedDays.get(platform)===day)return;
  const main=await this.ensurePlatform(platform);await this.attach({platform}).page.bringToFront();
  await this.call(main,{action:'reloadPlatform',platform});
  const end=this.clock()+45000;let ready=false;
  while(this.clock()<end){try{const page=this.attach({platform}).page;await page.bringToFront();if((await this.call(page.descriptor,{action:'documentHealth'})).visibility==='visible'){ready=true;break;}}catch(e){if(!['extension_page_changed','client_existing_platform_tab_missing'].includes(e.message))throw e;}await pause(300);}
  if(!ready)throw Error('platform_reload_pending');this.refreshedDays.set(platform,day);
 }
 async ensurePlatform(platform){
  if(!Object.hasOwn(PLATFORM_ORIGINS,platform))throw Error('client_platform_invalid');
  if(this.frames.some(f=>f.frameId===0&&new URL(f.url).origin===PLATFORM_ORIGINS[platform]))return this.main(platform);
  if(!this.status().bridgeConnected)throw Error('client_extension_not_connected');
  const id=crypto.randomBytes(16).toString('hex');await new Promise((resolve,reject)=>{const task={command:{id,command:{action:'ensurePlatform',platform}},resolve,reject,sent:false};task.timer=setTimeout(()=>{this.pending.delete(id);reject(Error('client_extension_command_timeout'));},this.timeout);this.pending.set(id,task);});
  const end=this.clock()+45000;while(this.clock()<end){const found=this.frames.filter(f=>f.frameId===0&&new URL(f.url).origin===PLATFORM_ORIGINS[platform]);if(found.length>1)throw Error('client_multiple_platform_tabs');if(found.length===1)return found[0];await pause(500);}throw Error('client_existing_platform_tab_missing');
 }
 attach({platform='meituan_delivery'}={}){const broker=this,main=this.main(platform),page=new RemotePage(this,main),browser=new EventEmitter();return {mode:'extension',browser,page,context:{},async withActivePage(action){await page.bringToFront();return action();},async disconnect(){browser.emit('disconnected');}};}
}
class RemoteLocator{
 constructor(frame,steps=[]){this.frame=frame;this.steps=steps;}
 append(step){return new RemoteLocator(this.frame,[...this.steps,step]);}
 locator(css){return this.append({kind:'css',value:css});}
 getByText(text,options={}){return this.append({kind:'text',match:pattern(text,options.exact)});}
 getByRole(role,options={}){return this.append({kind:'role',role,match:pattern(options.name,options.exact),...(options.disabled===undefined?{}:{disabled:options.disabled})});}
 filter(options){return this.append({kind:'filter',...(options.visible===undefined?{}:{visible:options.visible}),...(options.hasText===undefined?{}:{text:pattern(options.hasText)}),...(options.has?{has:options.has.steps}:{})});}
 nth(index){return this.append({kind:'nth',index});}first(){return this.nth(0);}
 async call(action,extra={}){
  const readOnly=['count','visible','read','readAll','texts','value','checked'].includes(action);
  for(let attempt=0;;attempt++)try{
   const value=await this.frame.broker.call(this.frame.descriptor,{action,steps:this.steps,...extra});
   this.frame.broker.diagnostics.push({frameId:this.frame.descriptor.frameId,action,steps:this.steps,...(['count','visible'].includes(action)?{result:value}:{})});this.frame.broker.diagnostics=this.frame.broker.diagnostics.slice(-16);return value;
  }catch(error){
   this.frame.broker.diagnostics.push({frameId:this.frame.descriptor.frameId,action,steps:this.steps,error:error.message});
   if(!readOnly||!['extension_page_changed','extension_element_ambiguous'].includes(error.message)||attempt>=2)throw error;
   await pause(200*(attempt+1));
   const matches=this.frame.broker.frames.filter(f=>f.tabId===this.frame.descriptor.tabId&&f.url===this.frame.descriptor.url);
   if(matches.length!==1)throw error;
   this.frame.descriptor=matches[0];
  }
 }
 count(){return this.call('count');}isVisible(){return this.call('visible');}inputValue(){return this.call('value');}isChecked(){return this.call('checked');}allTextContents(){return this.call('texts');}
 async click(){await this.waitFor({state:'visible'});return this.call('click');}async hover(){await this.waitFor({state:'visible'});return this.call('hover');}fill(value){return this.call('fill',{value});}press(value){return this.call('press',{value});}
 read(fn,all,arg){const reader=readers.get(normalize(fn));if(!reader)throw Error('extension_reader_not_registered');return this.call(all?'readAll':'read',{reader,...(arg===undefined?{}:{arg})});}
 evaluate(fn){return this.read(fn,false);}evaluateAll(fn,arg){return this.read(fn,true,arg);}
 async waitFor({state='visible',timeout=30000}={}){const end=Date.now()+timeout;for(;;){const count=await this.count();if(state==='hidden'?(count===0||count===1&&!await this.isVisible()):count===1&&await this.isVisible())return;if(Date.now()>=end)throw Error('extension_element_timeout');await pause(200);}}
}
class RemoteFrame extends RemoteLocator{
 constructor(broker,descriptor,page){super(null);this.frame=this;this.broker=broker;this.descriptor=descriptor;this.owner=page;}
 url(){return this.descriptor.url;}page(){return this.owner;}
}
class RemotePage extends RemoteFrame{
 constructor(broker,descriptor){super(broker,descriptor);this.owner=this;this.captureSupported=false;}
 isClosed(){return !this.broker.available();}frames(){return this.broker.frames.filter(f=>f.tabId===this.descriptor.tabId).map(f=>new RemoteFrame(this.broker,f,this));}
 async bringToFront(){const front=await this.broker.call(this.descriptor,{action:'front'});this.broker.lastFront={tabId:this.descriptor.tabId,...(front&&typeof front==='object'?front:{})};const end=Date.now()+5000;do{if((await this.broker.call(this.descriptor,{action:'documentHealth'})).visibility==='visible')return;await pause(200);}while(Date.now()<end);throw Error('client_browser_not_visible');}
 async openFinanceDownload(){await this.broker.call(this.descriptor,{action:'refreshControls'});return this.broker.call(this.descriptor,{action:'openFinanceDownload'});}
 openOperatingReport(){return this.broker.call(this.descriptor,{action:'openOperatingReport'});}
 on(){}off(){} // This transport does not expose HTTP response bodies or headers.
 async screenshot(){throw Error('extension_capture_not_supported');}
}
module.exports={ExtensionBroker,RemoteLocator,safeFrame,readers,normalize};
