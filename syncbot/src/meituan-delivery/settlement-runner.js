'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {plainDate,parseOperatingFile}=require('./operating-file');
const {parseSettlementFile}=require('./settlement-file');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function save(file,value){const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2));fs.renameSync(temp,file);}
const visible=locator=>locator.filter({visible:true});
async function pageRows(frame){await visible(frame.getByText('加载中',{exact:true})).waitFor({state:'hidden',timeout:30000});return visible(frame.locator('tr')).evaluateAll(es=>es.map(e=>{const c=e.querySelectorAll('td');return {id:c[0]?.textContent.trim(),content:c[1]?.textContent.trim(),operation:c[3]?.textContent.trim()};}).filter(r=>/^\d+$/.test(r.id)));}
async function turn(frame,direction){const item=visible(visible(frame.locator('ul.roo-pagination')).locator(direction==='prev'?'li:first-child':'li:last-child'));if(await item.evaluate(e=>e.classList.contains('disabled')))return false;const before=JSON.stringify(await pageRows(frame));await item.locator('a').click();for(let i=0;i<30;i++){if(JSON.stringify(await pageRows(frame))!==before)return true;await pause(100);}throw Error('settlement_pagination_stalled');}
async function jobs(frame,targetId){for(let i=0;await turn(frame,'prev');i++)if(i>=50)throw Error('settlement_page_limit');const all=[];for(let i=0;i<51;i++){const rows=await pageRows(frame);all.push(...rows);if(targetId&&rows.some(r=>r.id===targetId))return all;if(!await turn(frame,'next'))return all;}throw Error('settlement_page_limit');}
async function receive(frame,job,targetPath,options){
 const sourceDirectory=fs.realpathSync(options.sourceDirectory||path.join(os.homedir(),'Downloads'));
 const matches=()=>fs.readdirSync(sourceDirectory).filter(n=>n.startsWith(job.content+'-')&&n.endsWith('-'+job.id+'.xlsx'));
 let found=matches();if(found.length>1)throw Error('settlement_source_ambiguous');
 if(!found.length){await jobs(frame,job.id);const row=visible(frame.locator('tr')).filter({has:frame.getByText(job.id,{exact:true})});if(await row.count()!==1)throw Error('settlement_job_missing');await row.getByText('下载',{exact:true}).click();}
 let previous,source;const deadline=Date.now()+60000;
 while(Date.now()<deadline){found=matches();if(found.length>1)throw Error('settlement_source_ambiguous');if(found.length===1){source=path.join(sourceDirectory,found[0]);const stat=fs.lstatSync(source);if(!stat.isFile()||stat.isSymbolicLink()||fs.realpathSync(source)!==source)throw Error('settlement_source_invalid');const stamp=stat.size+':'+stat.mtimeMs;if(stat.size&&stamp===previous&&!fs.existsSync(source+'.crdownload')){fs.copyFileSync(source,targetPath);return (options.validateFile||parseSettlementFile)(targetPath,options);}previous=stamp;}await pause(500);}
 throw Error('settlement_download_pending');
}
async function runSettlement({page,root,date,account,downloadOnly,apiClient,onProgress=()=>{},sourceDirectory,waitMs=600000,scopeKey=''}){
 if(downloadOnly!==true)throw Error('settlement_cloud_upload_not_configured');
 if(plainDate(date)!==date||!/^[A-Za-z0-9_-]+$/.test(account||''))throw Error('settlement_parameters_invalid');
 const scope=await apiClient.call(root,'/api/internal/syncbot/meituan-delivery/scope'),ids=scope.bindings.map(r=>r.platform_id);
 const operatingFile=path.join(root,'downloads/meituan_delivery/meituan_delivery_operating',date+'_custom'+(scopeKey?'_'+scopeKey:''),'operating.csv');
 const operating=fs.existsSync(operatingFile)?parseOperatingFile(operatingFile,{from:date,expectedStoreIds:ids}):null;
 if(scopeKey&&!/^[a-f0-9]{12}$/.test(scopeKey))throw Error('settlement_scope_key_invalid');const runKey=date+'_custom'+(scopeKey?'_'+scopeKey:'');
 const directory=path.join(root,'downloads/meituan_delivery/meituan_delivery_settlement',runKey),stateDirectory=path.join(root,'state/tasks/meituan_delivery/meituan_delivery_settlement');
 fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(stateDirectory,{recursive:true});const stateFile=path.join(stateDirectory,runKey+'.json');
 const state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{date,account,storeIds:ids,jobs:{},phase:'new'};
 if(state.date!==date||state.account!==account||JSON.stringify([...state.storeIds].sort())!==JSON.stringify([...ids].sort()))throw Error('settlement_prior_scope_mismatch');
 const persist=()=>{save(stateFile,state);onProgress({date,phase:state.phase});};
 const receipts=[];const unfinished=ids.filter(id=>!state.jobs[id]?.file);
 let frame;
 if(unfinished.length){
  if(!operating)throw Error('settlement_operating_source_required');
  if(await page.getByText(account,{exact:true}).count()!==1)throw Error('operating_account_mismatch');
  const nav=visible(page.getByText('下载专区',{exact:false}));if(!await nav.count())await visible(page.getByText('财务管理',{exact:true})).click();await nav.click();
  for(let i=0;i<30;i++){frame=page.frames().find(f=>{try{const u=new URL(f.url());return u.origin==='https://waimaieapp.meituan.com'&&u.pathname==='/finance/static/html_pc/billReconciliation.html';}catch{return false;}});if(frame)break;await pause(500);}if(!frame)throw Error('settlement_frame_missing');
  await frame.getByText('选择账单',{exact:true}).waitFor({state:'visible',timeout:30000});
  for(const id of unfinished){
   const source=operating.rows.find(r=>r.门店id===id),name=String(source.门店名称).trim();
   const content=name+date+'~'+date+'订单';let job=state.jobs[id];
   if(!job){const existing=(await jobs(frame)).filter(j=>j.content===content);if(existing.length>1)throw Error('settlement_job_ambiguous');job=state.jobs[id]=existing[0]?{...existing[0],storeId:id}:{storeId:id,content,phase:'new'};persist();}
   if(!job.id&&job.phase==='export_pending'){const existing=(await jobs(frame)).filter(j=>j.content===content);if(existing.length>1)throw Error('settlement_job_ambiguous');if(existing.length===1){Object.assign(job,existing[0],{phase:'job_created'});persist();}}
   if(job.id)continue;
   if(job.phase==='export_pending')throw Error('settlement_export_uncertain');
   await frame.getByRole('link',{name:'门店账单',exact:true}).click();
   await frame.getByRole('link',{name:'日',exact:true}).click();
   await frame.getByText('明细类型',{exact:true}).locator('..').getByRole('link',{name:'全部',exact:true}).click();
   const inputs=visible(frame.locator('input[type=text]'));if(await inputs.count()!==4)throw Error('settlement_controls_changed');
   await inputs.nth(0).fill(date);await inputs.nth(0).press('Tab');await inputs.nth(1).fill(date);await inputs.nth(1).press('Tab');await frame.getByText('选择账单',{exact:true}).click();
   if(await inputs.nth(2).inputValue()!=='全部')throw Error('settlement_account_scope_changed');
   await inputs.nth(3).click();await visible(frame.getByText(name,{exact:true})).click();
   let selectionMatches=false;for(let attempt=0;attempt<20;attempt++){selectionMatches=await inputs.nth(3).inputValue()===name&&await inputs.nth(0).inputValue()===date&&await inputs.nth(1).inputValue()===date;if(selectionMatches)break;await pause(100);}if(!selectionMatches)throw Error('settlement_selection_mismatch');
   job.phase='export_pending';state.phase='export_pending';persist();await frame.getByRole('button',{name:'下载账单',exact:true}).click();
   for(let attempt=0;attempt<20;attempt++){const match=(await jobs(frame)).filter(j=>j.content===content);if(match.length>1)throw Error('settlement_job_ambiguous');if(match.length===1){Object.assign(job,match[0],{phase:'job_created'});persist();break;}await pause(1000);}
   if(!job.id)throw Error('settlement_export_uncertain');
  }
  const deadline=Date.now()+waitMs;
  while(ids.some(id=>!state.jobs[id]?.file)){
   const list=await jobs(frame);
   for(const id of ids){const job=state.jobs[id];if(job.file)continue;const found=list.find(j=>j.id===job.id&&j.content===job.content);if(!found)throw Error('settlement_job_missing');if(/失败/.test(found.operation))throw Error('settlement_export_failed');if(!/下载/.test(found.operation))continue;
    const target=path.join(directory,id+'.xlsx');const receipt=await receive(frame,job,target,{from:date,expectedStoreIds:[id],sourceDirectory});Object.assign(job,{file:path.relative(root,target),sha256:receipt.sha256,phase:'downloaded'});persist();
   }
   if(ids.every(id=>state.jobs[id]?.file))break;if(Date.now()>=deadline){state.phase='export_pending';persist();throw Error('settlement_export_pending');}await pause(5000);await frame.getByText('刷新',{exact:true}).click();
  }
 }
 for(const id of ids){const job=state.jobs[id],file=path.resolve(root,job.file);if(!file.startsWith(path.resolve(directory)+path.sep)||fs.realpathSync(file)!==file)throw Error('settlement_archive_path_invalid');const receipt=parseSettlementFile(file,{from:date,expectedStoreIds:[id]});if(receipt.sha256!==job.sha256)throw Error('settlement_archive_hash_changed');receipts.push({...receipt,file:job.file});}
 state.phase='downloaded';persist();const receivable=receipts.reduce((s,r)=>s+r.receivable_cents,0);if(!Number.isSafeInteger(receivable))throw Error('settlement_money_overflow');
 return {ok:true,report_type:'meituan_delivery_settlement',phase:'downloaded',date,row_count:receipts.reduce((s,r)=>s+r.row_count,0),store_count:receipts.reduce((s,r)=>s+r.store_count,0),receivable_cents:receivable,totals_complete:true,bank_received_verified:false,receipts,uploaded:false};
}
module.exports={runSettlement,pageRows,jobs,receive};
