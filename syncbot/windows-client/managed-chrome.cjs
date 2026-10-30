'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {platformPage}=require('./existing-chrome.cjs');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function launchManagedChrome(browserType,{root,executablePath,onError=()=>{},initialUrl='https://waimaie.meituan.com/'}={}){
 const initial=new URL(initialUrl);if(initial.username||initial.password||!((initial.origin==='https://waimaie.meituan.com')||(initial.protocol==='http:'&&initial.hostname==='127.0.0.1')))throw Error('client_managed_start_url_invalid');
 const base=fs.realpathSync(root),profile=path.join(base,'profiles','meituan-managed'),sourceDirectory=path.join(base,'browser-downloads');
 for(const folder of [path.dirname(profile),profile,sourceDirectory]){fs.mkdirSync(folder,{recursive:true,mode:0o700});if(fs.lstatSync(folder).isSymbolicLink()||fs.realpathSync(folder)!==folder)throw Error('client_managed_profile_invalid');}
 const context=await browserType.launchPersistentContext(profile,{executablePath,headless:false,viewport:null,acceptDownloads:true});
 const pending=new Set(),errors=[];let contextClosed=false;
 function watch(page){page.on('download',download=>{
  const task=(async()=>{
   const name=download.suggestedFilename();if(!name||name!==path.basename(name)||/[\\/:\x00-\x1f]/.test(name))throw Error('client_download_filename_invalid');
   const savedName=name.endsWith('.csv')?name.replaceAll(' ','+'):name;
   const target=path.join(sourceDirectory,savedName),temp=path.join(sourceDirectory,'.'+crypto.randomBytes(16).toString('hex')+'.part');
   try{await download.saveAs(temp);if(fs.existsSync(target)){if(hash(target)!==hash(temp))throw Error('client_download_source_conflict');}else fs.renameSync(temp,target);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  })().catch(error=>{errors.push(error);onError(error);});pending.add(task);task.finally(()=>pending.delete(task));
 });}
 context.pages().forEach(watch);context.on('page',watch);context.on('close',()=>{contextClosed=true;});
 try{
  const targets=context.pages().filter(platformPage);if(targets.length>1)throw Error('client_multiple_platform_tabs');
  const page=targets[0]||context.pages()[0]||await context.newPage();
  if(!platformPage(page))await page.goto(initialUrl,{waitUntil:'domcontentloaded',timeout:60000});
  return {context,page,browser:context.browser(),sourceDirectory,mode:'managed',async withActivePage(action){
   if(contextClosed||page.isClosed())throw Error('client_browser_unavailable');
   errors.length=0;
   return require('./visible-page.cjs').withVisiblePage(context,page,async()=>{const result=await action();await Promise.all([...pending]);if(errors.length)throw errors[0];return result;});
  },async disconnect(){if(!contextClosed)await context.close();await Promise.all([...pending]);}};
 }catch(error){await context.close().catch(()=>{});throw error;}
}
module.exports={launchManagedChrome};
