'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {validateJobFilename}=require('../src/meituan-delivery/operating-download');
const {parseOperatingFile}=require('../src/meituan-delivery/operating-file');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Existing Chrome keeps its own download settings. Never change Browser.setDownloadBehavior.
async function receiveLocalJob(frame,{filename,from,to=from,account,scope='all_stores',expectedStoreIds,targetPath,timeoutMs=60000,sourceDirectory=path.join(os.homedir(),'Downloads'),validateJob=validateJobFilename,parseFile=parseOperatingFile,prefixName='门店'}){
 validateJob(filename,{from,to,account,scope});
 if(!targetPath||!expectedStoreIds?.length)throw Error('operating_download_scope_required');
 const directory=fs.realpathSync(sourceDirectory);
 // Chrome's observed export filename encodes the timestamp space as '+'.
 const canonical=name=>name.replace(/ \(\d+\)(?=\.csv$)/,'').replaceAll('+',' ');
 const expected=canonical(filename+'.csv');
 const prefix=`${prefixName}_${scope==='custom_stores'?'自定义门店':'全部门店'}_${from.replaceAll('-','')}_${to.replaceAll('-','')}_${account}_`;
 const matching=()=>fs.readdirSync(directory).filter(name=>name.startsWith(prefix)&&name.endsWith('.csv'));
 const baseline=new Set(matching());let clicked=false;
 const ready=()=>{
  const files=matching().filter(name=>canonical(name)===expected).map(name=>path.join(directory,name)).filter(file=>{const stat=fs.lstatSync(file);return stat.isFile()&&!stat.isSymbolicLink()&&fs.realpathSync(file)===file&&stat.size>0&&!fs.existsSync(file+'.crdownload');});
  if(!files.length)return null;
  if(files.length>1){const hashes=files.map(file=>require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'));if(new Set(hashes).size!==1)throw Error('client_download_source_conflict');}
  const source=files.sort()[0],stat=fs.statSync(source);return {source,size:stat.size,mtime:stat.mtimeMs};
 };
 if(!ready()){
  const row=frame.locator('tr').filter({visible:true}).filter({has:frame.getByText(filename,{exact:true})});
  if(await row.count()!==1)throw Error('operating_job_missing_or_ambiguous');
  const control=row.getByText('下载',{exact:true});
  if(await control.count()!==1||!await control.isVisible())throw Error('operating_job_not_ready');
  await frame.page?.().bringToFront();
  await control.click();
  clicked=true;
 }
 const deadline=Date.now()+timeoutMs;let previous;
 while(Date.now()<deadline){const current=ready();if(current&&previous&&current.source===previous.source&&current.size===previous.size&&current.mtime===previous.mtime){
   fs.copyFileSync(current.source,targetPath);
   const validation=parseFile(targetPath,{from,to,expectedStoreIds});
   return {filename,target_path:targetPath,validation};
  }
  if(clicked&&matching().some(name=>!baseline.has(name)&&canonical(name)!==expected))throw Error('client_download_task_mismatch');
  previous=current;await pause(500);
 }
 const error=Error('client_local_download_not_found');error.trace=['download_exact_'+(ready()?1:0),'download_matching_'+matching().length,'download_new_'+matching().filter(n=>!baseline.has(n)).length];throw error;
}
async function downloadLocalOperatingJob(frame,options){return receiveLocalJob(frame,options);}
async function downloadLocalProductJob(frame,options){const {validateProductJob}=require('../src/meituan-delivery/product-download');const {parseProductFile}=require('../src/meituan-delivery/product-file');return receiveLocalJob(frame,{...options,validateJob:validateProductJob,parseFile:parseProductFile,prefixName:'商品'});}
module.exports={downloadLocalOperatingJob,downloadLocalProductJob,receiveLocalJob};
