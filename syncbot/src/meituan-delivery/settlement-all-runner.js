'use strict';
const fs=require('node:fs'),path=require('node:path');
const {plainDate}=require('./operating-file');
const {inspectSettlementAll}=require('./settlement-all-file');
const {jobs,receive}=require('./settlement-runner');
const visible=l=>l.filter({visible:true}),pause=ms=>new Promise(r=>setTimeout(r,ms));
async function selectAllStores(frame,input){
 if(await input.inputValue()==='全部')return;
 await input.click();
 const option=visible(frame.locator('[class*="dropdown"] li,[role="option"]')).filter({hasText:/^\s*全部\s*$/});
 if(await option.count()!==1)throw Error('settlement_store_all_option_ambiguous');
 await option.click();
}
async function latestJobs(frame){
 const pagination=visible(frame.locator('ul.roo-pagination'));await visible(pagination.locator('li.active')).waitFor({state:'visible',timeout:30000});const active=await visible(pagination.locator('li.active')).allTextContents();
 if(active.length!==1)throw Error('settlement_pagination_ambiguous');
 if(active[0].trim()!=='1'){await visible(pagination.getByText('1',{exact:true})).click();let ready=false;for(let i=0;i<30;i++){const current=await visible(pagination.locator('li.active')).allTextContents();if(current.length===1&&current[0].trim()==='1'){ready=true;break;}await pause(100);}if(!ready)throw Error('settlement_pagination_stalled');}
 await visible(frame.getByText('加载中',{exact:true})).waitFor({state:'hidden',timeout:30000});
 return visible(frame.locator('tr')).evaluateAll(es=>es.map(e=>{const c=e.querySelectorAll('td');return {id:c[0]?.textContent.trim(),content:c[1]?.textContent.trim(),operation:c[3]?.textContent.trim()};}).filter(r=>/^\d+$/.test(r.id)));
}
async function refreshJobs(frame,read=latestJobs){
 await visible(frame.getByText('刷新',{exact:true})).click();
 return read(frame);
}
async function financeFrame(page){
 const candidates=page.frames().filter(f=>{try{const u=new URL(f.url());return u.origin==='https://waimaieapp.meituan.com'&&['/finance/static/html_pc/billReconciliation.html','/finance/pc/download'].includes(u.pathname);}catch{return false;}}),ready=[];
 for(const frame of candidates){try{if(await frame.getByText('选择账单',{exact:true}).isVisible())ready.push(frame);}catch(error){if(!['extension_page_changed','extension_origin_denied'].includes(error.message))throw error;}}
 if(ready.length>1)throw Error('settlement_frames_ambiguous');return ready[0];
}
async function execute({page,root,date,account,scopeKey='',downloadOnly,apiClient,onProgress=()=>{},sourceDirectory,waitMs=600000,checkAccess=()=>{}}){
 if(downloadOnly!==true)throw Error('settlement_cloud_upload_not_configured');
 if(plainDate(date)!==date||!/^[A-Za-z0-9_-]+$/.test(account||'')||(scopeKey&&!/^[a-f0-9]{12}$/.test(scopeKey)))throw Error('settlement_parameters_invalid');
 const scope=await apiClient.call(root,'/api/internal/syncbot/meituan-delivery/scope'),ids=scope.bindings.map(r=>r.platform_id),key=date+'_custom'+(scopeKey?'_'+scopeKey:'');
 const directory=path.join(root,'downloads/meituan_delivery/meituan_delivery_settlement',key),stateDirectory=path.join(root,'state/tasks/meituan_delivery/meituan_delivery_settlement');
 fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(stateDirectory,{recursive:true});
 const stateFile=path.join(stateDirectory,key+'.json'),state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{date,account,storeIds:ids,source_mode:'all_stores',phase:'new'};
 if(state.source_mode!=='all_stores'||state.date!==date||state.account!==account||JSON.stringify([...state.storeIds].sort())!==JSON.stringify([...ids].sort()))throw Error('settlement_prior_scope_mismatch');
 const save=()=>{const tmp=stateFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state,null,2));fs.renameSync(tmp,stateFile);onProgress({phase:state.phase});};
 const validateFile=file=>inspectSettlementAll(fs.readFileSync(file),{from:date,expectedStoreIds:ids}).receipt;
 if(!state.file){
  if(!page)throw Error('settlement_browser_required');
  if(await page.getByText(account,{exact:true}).count()!==1)throw Error('operating_account_mismatch');
  // Report/finance iframes remain cached when another menu is active. Activate
  // the fixed finance menu even if the old URL is still present in frame listings.
  if(page.openFinanceDownload)await page.openFinanceDownload();
  else {const nav=visible(page.getByText('下载专区',{exact:false}));if(!await nav.count())await visible(page.getByText('财务管理',{exact:true})).click();await nav.click();}
  let frame;
  for(let i=0;!frame&&i<60;i++){frame=await financeFrame(page);if(!frame)await pause(500);}if(!frame){const error=Error('settlement_frame_missing');error.trace=page.frames().map(f=>{try{const u=new URL(f.url());return ('frame_'+u.hostname.replace(/[^a-z0-9]/g,'_')+'_'+u.pathname.replace(/[^a-z0-9]/g,'_')).slice(0,130);}catch{return 'frame_unavailable'}}).slice(0,12);throw error;}
  await frame.getByText('选择账单',{exact:true}).waitFor({state:'visible',timeout:30000});
  for(let i=0;;i++){checkAccess();if(await frame.getByText('明细类型',{exact:true}).locator('..').getByRole('link',{name:'全部',exact:true}).count()===1)break;if(i>=100)throw Error('settlement_controls_not_ready');await pause(200);}
  if(!state.job){
   if(state.phase==='export_pending'&&!state.export_started_at)throw Error('settlement_legacy_export_requires_review');
   if(state.phase!=='export_pending'){
    await frame.getByRole('link',{name:'门店账单',exact:true}).click();await frame.getByRole('link',{name:'日',exact:true}).click();await frame.getByText('明细类型',{exact:true}).locator('..').getByRole('link',{name:'全部',exact:true}).click();
    const inputs=visible(frame.locator('input[type=text]'));if(await inputs.count()!==4)throw Error('settlement_controls_changed');
    await inputs.nth(0).fill(date);await inputs.nth(0).press('Tab');await inputs.nth(1).fill(date);await inputs.nth(1).press('Tab');await frame.getByText('选择账单',{exact:true}).click();
    if(await inputs.nth(2).inputValue()!=='全部')throw Error('settlement_account_scope_changed');
    await selectAllStores(frame,inputs.nth(3));
    let ready=false;for(let i=0;i<20;i++){ready=await inputs.nth(3).inputValue()==='全部'&&await inputs.nth(0).inputValue()===date&&await inputs.nth(1).inputValue()===date;if(ready)break;await pause(100);}if(!ready)throw Error('settlement_selection_mismatch');
    state.previousJobIds=(await refreshJobs(frame)).map(j=>j.id);state.export_started_at=new Date().toISOString();state.phase='export_pending';save();await frame.getByRole('button',{name:'下载账单',exact:true}).click();
   }
   for(let i=0;i<20;i++){checkAccess();const fresh=(await refreshJobs(frame)).filter(j=>!state.previousJobIds.includes(j.id)&&j.content.includes(date+'~'+date));if(fresh.length>1)throw Error('settlement_job_ambiguous');if(fresh.length===1){state.job=fresh[0];state.phase='job_created';save();break;}await pause(1000);}if(!state.job)throw Error('settlement_export_uncertain');
  }
  const deadline=Date.now()+waitMs;
  for(;;){checkAccess();let candidates=await latestJobs(frame);if(!candidates.some(r=>r.id===state.job.id))candidates=await jobs(frame,state.job.id);const row=candidates.find(j=>j.id===state.job.id&&j.content===state.job.content);if(!row)throw Error('settlement_job_missing');if(/失败/.test(row.operation))throw Error('settlement_export_failed');if(/下载/.test(row.operation))break;if(Date.now()>deadline)throw Error('settlement_export_pending');await pause(5000);await frame.getByText('刷新',{exact:true}).click();}
  const links=visible(frame.locator('tr')).filter({has:frame.getByText(state.job.id,{exact:true})}).getByText('下载',{exact:true});if(await links.count()!==1)throw Error('settlement_multiple_parts_requires_review');
  const file=path.join(directory,'all-stores.xlsx'),receipt=await receive(frame,state.job,file,{from:date,sourceDirectory,validateFile});state.file=path.relative(root,file);state.sha256=receipt.sha256;state.phase='downloaded';save();
 }
 const file=path.resolve(root,state.file);if(!file.startsWith(path.resolve(directory)+path.sep)||fs.realpathSync(file)!==file)throw Error('settlement_archive_path_invalid');const receipt=validateFile(file);if(receipt.sha256!==state.sha256)throw Error('settlement_archive_hash_changed');
 return {...receipt,ok:true,phase:'downloaded',date,file:state.file,receipts:[{...receipt,file:state.file}],uploaded:false,split_files_verified:false};
}
async function runSettlementAll(options){
 if(!options.page)return execute(options);
 const guard=require('./platform-access').watchFinanceAccess(options.page);
 try{return await execute({...options,checkAccess:()=>guard.assertAllowed()});}catch(error){guard.assertAllowed();throw error;}finally{guard.dispose();}
}
module.exports={runSettlementAll,selectAllStores,refreshJobs,latestJobs,financeFrame};
