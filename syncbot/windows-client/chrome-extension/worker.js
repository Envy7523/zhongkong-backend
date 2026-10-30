'use strict';
const origins=new Set(['https://waimaie.meituan.com','https://waimaieapp.meituan.com','https://melody.shop.ele.me','https://store.jddj.com','https://kunce-store.jddj.com','https://melody-stats-next.ele.me','https://napos-bill-pc.faas.ele.me']);
let port,polling=false,timer;
const readyDocuments=new Set();
function executeDom(command){
 return Promise.resolve().then(()=>{if(!globalThis.ETG_DOM)throw Error('extension_content_not_ready');return globalThis.ETG_DOM.execute(document,command);}).then(value=>({ok:true,value}),error=>({ok:false,error:/^[a-z][a-z0-9_]+$/.test(error.message)?error.message:'extension_dom_failed'}));
}
function safeUrl(raw){try{const u=new URL(raw);if(!origins.has(u.origin))return null;return u.origin+u.pathname+(u.hash.startsWith('#/downloads/downloadBill')?'#/downloads/downloadBill':'');}catch{return null;}}
async function frames(){const tabs=await chrome.tabs.query({url:['https://waimaie.meituan.com/*','https://melody.shop.ele.me/*','https://store.jddj.com/*']});const result=[];for(const tab of tabs){for(const frame of await chrome.webNavigation.getAllFrames({tabId:tab.id})||[]){const url=safeUrl(frame.url);if(url)result.push({tabId:tab.id,frameId:frame.frameId,url});}}return result;}
async function poll(){if(polling||!port)return;polling=true;try{port.postMessage({type:'poll',frames:await frames(),extensionVersion:chrome.runtime.getManifest().version});}catch{}finally{polling=false;}}
async function command(message){
 const {id,tabId,frameId,command}=message;
 try{
  if(command.action==='reloadExtension'){port.postMessage({type:'result',id,ok:true,value:true});setTimeout(()=>chrome.runtime.reload(),100);return;}
  if(command.action==='ensurePlatform'){
   const sites={meituan_delivery:'https://waimaie.meituan.com/',taobao_flash:'https://melody.shop.ele.me/',jd_delivery:'https://store.jddj.com/v3/financial/statement/newDownload'},site=sites[command.platform];if(!site)throw Error('client_platform_invalid');
   const tabs=await chrome.tabs.query({url:new URL(site).origin+'/*'});if(tabs.length>1)throw Error('client_multiple_platform_tabs');
   const target=tabs.length===1?tabs[0]:await chrome.tabs.create({url:site,active:true});await chrome.windows.update(target.windowId,{focused:true,state:'normal'});await chrome.tabs.update(target.id,{active:true});port.postMessage({type:'result',id,ok:true,value:true});return;
  }
  const frame=await chrome.webNavigation.getFrame({tabId,frameId});if(!frame||!safeUrl(frame.url))throw Error('extension_origin_denied');
  if(safeUrl(frame.url)!==message.url)throw Error('extension_page_changed');
  if(command.action==='reloadPlatform'){
   const expected={meituan_delivery:'https://waimaie.meituan.com',jd_delivery:'https://store.jddj.com',taobao_flash:'https://melody.shop.ele.me'}[command.platform];
   if(frameId!==0||!expected||new URL(frame.url).origin!==expected)throw Error('extension_origin_denied');
   await chrome.tabs.reload(tabId);
   const deadline=Date.now()+30000;let ready=false;
   while(Date.now()<deadline){const tab=await chrome.tabs.get(tabId);if(tab.status==='complete'){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,200));}
   if(!ready)throw Error('platform_reload_pending');
   port.postMessage({type:'result',id,ok:true,value:true});return;
  }
  if(command.action==='front'){
   const tab=await chrome.tabs.get(tabId);await chrome.windows.update(tab.windowId,{focused:true,state:'normal'});await chrome.tabs.update(tabId,{active:true});
   const actualTab=await chrome.tabs.get(tabId),actualWindow=await chrome.windows.get(tab.windowId);
   port.postMessage({type:'result',id,ok:true,value:{active:actualTab.active===true,focused:actualWindow.focused===true,state:actualWindow.state}});return;
  }
  const target={tabId,...(frame.documentId?{documentIds:[frame.documentId]}:{frameIds:[frameId]})};
  const key=tabId+':'+frameId+':'+(frame.documentId||safeUrl(frame.url));
  if(command.action==='refreshControls')readyDocuments.delete(key);
  if(!readyDocuments.has(key)){await chrome.scripting.executeScript({target,world:'ISOLATED',files:['reads.js','dom.js']});readyDocuments.add(key);if(readyDocuments.size>200)readyDocuments.clear();}
  if(command.action==='refreshControls'){port.postMessage({type:'result',id,ok:true,value:true});return;}
  const results=await chrome.scripting.executeScript({target,world:'ISOLATED',func:executeDom,args:[command]});
  const result=results.find(value=>value.frameId===frameId)?.result;
  if(!result||typeof result.ok!=='boolean')throw Error('extension_script_result_invalid');
  port.postMessage({type:'result',id,...result});
 }catch(error){const message=String(error.message||'');const code=/^[a-z][a-z0-9_]+$/.test(message)?message:/Cannot access|permission|not allowed/i.test(message)?'extension_site_permission_denied':/No frame|No document|removed|navigat/i.test(message)?'extension_page_changed':'extension_script_execution_failed';port?.postMessage({type:'result',id,ok:false,error:code});}
}
function connect(){if(port)return;port=chrome.runtime.connectNative('com.etaigong.delivery');
 port.onMessage.addListener(message=>{if(message.type==='command')command(message);else if(message.type==='poll_again')poll();else if(message.type==='bridge_ready'){chrome.action.setBadgeText({text:''});chrome.action.setTitle({title:'采集扩展已连接本机程序'});}else if(message.type==='bridge_error'){chrome.action.setBadgeText({text:'!'});chrome.action.setBadgeBackgroundColor({color:'#b42318'});chrome.action.setTitle({title:'本机采集程序未联通，请启动客户端后重试'});}});
 port.onDisconnect.addListener(()=>{void chrome.runtime.lastError;port=null;clearInterval(timer);chrome.action.setBadgeText({text:'!'});chrome.action.setBadgeBackgroundColor({color:'#b42318'});chrome.action.setTitle({title:'采集通信组件未连接，请确认已安装并启动本机程序'});setTimeout(connect,15000);});
 clearInterval(timer);timer=setInterval(poll,2000);poll();
}
chrome.runtime.onStartup.addListener(connect);chrome.runtime.onInstalled.addListener(connect);
chrome.action.onClicked.addListener(()=>{connect();poll();});connect();
