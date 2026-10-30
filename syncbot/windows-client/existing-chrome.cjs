'use strict';
const fs=require('node:fs'),path=require('node:path');
const PLATFORM_HOSTS=new Set(['waimaie.meituan.com']);
function existingEndpoint({env=process.env,readFile=fs.readFileSync}={}){
 if(!env.LOCALAPPDATA)return 'chrome';
 let contents;try{contents=readFile(path.join(env.LOCALAPPDATA,'Google/Chrome/User Data/DevToolsActivePort'),'utf8');}catch{return 'chrome';}
 const lines=String(contents).trim().split(/\r?\n/),port=Number(lines[0]);
 if(!Number.isInteger(port)||port<1||port>65535||!/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(lines[1]||''))throw Error('client_existing_chrome_endpoint_invalid');
 // Chrome's own per-session endpoint; remains subject to Chrome's consent.
 // Keep the target loopback-only and never use a file-supplied host or URL.
 return 'ws://127.0.0.1:'+port+lines[1];
}
function platformPage(page){try{const url=new URL(page.url());return !page.isClosed()&&url.protocol==='https:'&&PLATFORM_HOSTS.has(url.hostname);}catch{return false;}}
async function attachExistingChrome(browserType,{endpoint=existingEndpoint,timeout=90000}={}){
 let browser;
 try{
  // Chrome 144+ consent-gated discovery. No browser/profile/tab creation fallback.
  browser=await browserType.connectOverCDP(endpoint(),{noDefaults:true,timeout});
  const pages=browser.contexts().flatMap(context=>context.pages().filter(platformPage).map(page=>({context,page})));
  if(pages.length!==1)throw Error(pages.length?'client_multiple_platform_tabs':'client_existing_platform_tab_missing');
  return {browser,...pages[0],async withActivePage(action){
   return require('./visible-page.cjs').withVisiblePage(pages[0].context,pages[0].page,action);
  },async disconnect(){
   // CDP Browser.close disconnects the transport. Never close the user's context.
   await browser.close();
  }};
 }catch(error){
  if(browser)await browser.close().catch(()=>{});
  if(['client_multiple_platform_tabs','client_existing_platform_tab_missing'].includes(error.message))throw error;
  const detail=String(error.message||'');
  const code=/DevToolsActivePort.*not found|not allowed|denied|unauthorized/i.test(detail)?'client_existing_chrome_authorization_required':/ECONNREFUSED|ECONNRESET|closed/i.test(detail)?'client_existing_chrome_connection_lost':/timeout/i.test(detail)?'client_existing_chrome_connection_timeout':'client_existing_chrome_connection_failed';
  throw Object.assign(Error(code),{cause:error});
 }
}
module.exports={attachExistingChrome,platformPage,existingEndpoint};
