'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),core=require('./core.cjs');
const canonical=name=>name.replace(/ \(\d+\)(?=\.[^.]+$)/,'').replaceAll('+',' ');
const pause=ms=>new Promise(r=>setTimeout(r,ms)),inspectAction=p=>p==='jd_delivery'?'inspectJdReport':'inspectFlashReport';
const inspect=frame=>frame.broker.call(frame.descriptor,{action:inspectAction(new URL(frame.url()).hostname.includes('jddj.com')?'jd_delivery':'taobao_flash')});
async function waitFor(read,accept,{timeout=180000,error='platform_export_pending'}={}){const end=Date.now()+timeout;while(Date.now()<end){const value=await read();const result=accept(value);if(result)return result;await pause(2500);}throw Error(error);}
async function navigation(action){try{return await action();}catch(e){if(e.message!=='extension_page_changed')throw e;}}
function journalPath(root,platform,date,type){return path.join(root,platform==='jd_delivery'?'jd-export-tests':'flash-export-tests',date+'-'+(platform==='jd_delivery'&&type==='settlement'?'orders':type)+'.json');}
async function readFileArrival({directory,match,since,target,parse,filename:expectedFilename,trace=[],timeout=120000}){
 const end=Date.now()+timeout;let previous;
 while(Date.now()<end){const candidates=fs.readdirSync(directory).filter(match).map(name=>path.join(directory,name)).filter(file=>{const st=fs.lstatSync(file);return st.isFile()&&!st.isSymbolicLink()&&st.mtimeMs>=since-2000&&!fs.existsSync(file+'.crdownload');});
  if(candidates.length>1&&new Set(candidates.map(f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'))).size!==1)throw Error('client_download_source_conflict');
  if(candidates.length>=1){const file=candidates.sort()[0],st=fs.statSync(file),fingerprint=file+':'+st.size+':'+st.mtimeMs;if(st.size>0&&fingerprint===previous){let bytes=fs.readFileSync(file);if(bytes.length>30*1024*1024)throw Error('client_source_too_large');if(file.endsWith('.zip')){const cfb=require('xlsx').CFB.read(bytes,{type:'buffer'}),entries=cfb.FileIndex.filter(e=>e.name.endsWith('.xlsx'));if(entries.length!==1)throw Error('platform_download_parts_incomplete');bytes=Buffer.from(entries[0].content);}const receipt=parse(bytes);fs.mkdirSync(path.dirname(target),{recursive:true});if(fs.existsSync(target)&&crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')!==receipt.sha256)throw Error('client_download_source_conflict');fs.writeFileSync(target,bytes,{mode:0o600});return receipt;}previous=fingerprint;
  }await pause(500);
 }const names=fs.readdirSync(directory),recent=names.filter(name=>{try{return fs.statSync(path.join(directory,name)).mtimeMs>=since-2000;}catch{return false;}});const error=Error('platform_download_pending');error.trace=[...trace,'download_exact_'+names.filter(match).length,'download_recent_'+recent.length,'download_partial_'+recent.filter(n=>n.endsWith('.crdownload')).length,'download_xlsx_'+recent.filter(n=>n.endsWith('.xlsx')).length,'download_zip_'+recent.filter(n=>n.endsWith('.zip')).length,'download_csv_'+recent.filter(n=>n.endsWith('.csv')).length,'download_prefix_'+recent.filter(n=>expectedFilename&&n.startsWith(expectedFilename.split('_').slice(0,4).join('_')+'_')).length];throw error;
}
async function frameFor(extension,platform,origin,pathname){return waitFor(async()=>{
 const main=extension.attach({platform}).page;let frames=main.frames().filter(f=>new URL(f.url()).origin===origin&&(!pathname||new URL(f.url()).pathname===pathname));const active=[];
 for(const frame of frames){try{if((await frame.broker.call(frame.descriptor,{action:'documentHealth'})).visibility!=='visible')continue;
  if(!pathname&&platform==='taobao_flash'&&await frame.getByText(/^(报表下载|门店下载|商品下载|下载管理)$/).filter({visible:true}).count()===0)continue;active.push(frame);
 }catch(e){if(e.message!=='extension_page_changed')throw e;}}
 if(active.length>1&&platform==='taobao_flash'){const layout=await inspect(main),paths=new Set((layout.embeddedPages||[]).filter(f=>f.origin===origin&&f.visible).map(f=>f.path));if(paths.size===1)return active.filter(f=>paths.has(new URL(f.url()).pathname));}return active;
 },frames=>{if(frames.length>1)throw Error('platform_frames_ambiguous');return frames.length===1?frames[0]:false;},{timeout:45000,error:'platform_report_frame_missing'});}

async function report({root,platform,type,date,scope,extension,downloadDirectory}){
 const flash=platform==='taobao_flash',page=()=>extension.attach({platform}).page;
 await page().bringToFront();let main=page();
 const rootStep=(step)=>navigation(()=>flash?require('../src/taobao-flash/browser-probe').runFlashStep(main,{step}):require('../src/jd-delivery/browser-probe').runJdStep(main,{step,root}));
 if(flash){if(!/\/downloadCenter$/.test(new URL(main.url()).pathname)){const visible=main.locator('li.cook-menu-item').filter({visible:true,hasText:/^(资料下载|数据下载)$/});if(!await visible.count())await rootStep('data-menu');main=page();await rootStep('report-menu');}}
 else{const control=main.locator('.jd-menu-item').filter({visible:true,has:main.getByText('报表下载',{exact:true})});if(!await control.count())await rootStep('open-operating-menu');main=page();await rootStep('open-operating-report');}
 const frame=await frameFor(extension,platform,flash?'https://melody-stats-next.ele.me':'https://kunce-store.jddj.com');
 const step=(name,extra={})=>(flash?require('../src/taobao-flash/report-probe').runFlashReportStep:require('../src/jd-delivery/report-probe').runJdReportStep)(frame,{step:name,date,type,root,...extra});
 const journal=journalPath(root,platform,date,type);let prior=core.read(journal,null);
 if(!prior){
  const dataTab=frame.getByText(flash?'报表下载':'数据下载',{exact:true}).filter({visible:true});if(await dataTab.count()===1)await step(flash?'report-tab':'data-tab');
  if(type==='product')await step('product-tab');else await step('operating-tab');
  if(!flash){const all=frame.locator('label.ant-checkbox-wrapper').filter({visible:true,hasText:/^$/});await all.waitFor({state:'visible'});if(await all.count()!==1)throw Error('jd_columns_selector_ambiguous');if(!await all.locator('input').isChecked())await all.click();}
  else await step(type==='product'?'product-columns':'operating-columns');
  const ready=await inspect(frame),dates=ready.inputs.filter(e=>['开始日期','结束日期'].includes(e.placeholder));
  if(dates.length!==2||dates.some(e=>e.value!==date)){
   await step('open-date');try{await step('select-day');}catch(error){if(error.message!=='client_extension_command_timeout')throw error;const calendar=flash?await frame.broker.call(frame.descriptor,{action:'inspectFlashCalendar'}):null;if(!calendar||calendar.dates.length)throw error;const check=await inspect(frame),range=check.inputs.filter(e=>['开始日期','结束日期'].includes(e.placeholder));if(range.length!==2||range.some(e=>e.value!==date))throw error;}
  }
  await step(flash?'export-'+type:'export');prior=core.read(journal,null);
 }
 // Submission journals survive timeouts; the export click is never replayed.
 if(!flash){const confirm=frame.getByRole('button',{name:'前往下载列表',exact:true}).filter({visible:true});if(await confirm.count()===1)await step('confirm-list');else await step('download-list');}else await step('download-management');
 const prefix=flash?(type==='operating'?'门店':'商品')+'下载_'+date.replaceAll('-','')+'至'+date.replaceAll('-','')+'_全部门店_'+scope.account+'_':(type==='operating'?'门店':'商品')+'_'+date.replaceAll('-','')+'_'+date.replaceAll('-','')+'_'+scope.account+'_';
 let polls=0;
 const row=await waitFor(async()=>{if(!flash)await step('refresh-list');else if(polls++%3===2){await step('report-tab');await step('download-management');}return inspect(frame);},state=>{const rows=state.tableRows.filter(r=>{if(!r[0]?.startsWith(prefix)||!(flash?r[1]==='成功':r[2]==='下载'))return false;let at;if(flash){const m=r[0].match(/_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})\.xlsx$/);if(!m)return false;at=Date.parse(m[1]+'-'+m[2]+'-'+m[3]+'T'+m[4]+':'+m[5]+':'+m[6]+'.'+m[7]+'+08:00');}else at=Date.parse(r[1].replace(' ','T')+'+08:00');return at>=Date.parse(prior.at)-2000;});if(rows.length>1)throw Error('platform_export_ambiguous');return rows[0];});
 if(prior.filename&&prior.filename!==row[0])throw Error('client_download_task_mismatch');
 const directory=require('./download-directory.cjs').resolveDownloadDirectory({downloadDirectory}),received=fs.readdirSync(directory).filter(name=>canonical(name)===canonical(row[0])).some(name=>{const st=fs.lstatSync(path.join(directory,name));return st.isFile()&&!st.isSymbolicLink()&&st.mtimeMs>=Date.parse(prior.at)-2000;});const permissions=require('./download-diagnostics.cjs').downloadDiagnostics(platform,directory),permissionRetry=!!prior.downloadRetryAt&&!prior.downloadPermissionRetryAt&&(permissions.includes('download_multiple_top_allow')||permissions.includes('download_multiple_default_allow'));if(!received&&(!prior.downloadRequestedAt||(!prior.downloadRetryAt||permissionRetry)&&Date.now()-Date.parse(prior.downloadRequestedAt)>120000))await step('download-file',{filename:row[0],retry:!!prior.downloadRequestedAt,permissionRetry});
 return {filename:row[0],match:name=>canonical(name)===canonical(row[0]),since:Date.parse(prior.at),trace:['download_requested_'+Number(!!core.read(journal,null)?.downloadRequestedAt),'download_retried_'+Number(!!core.read(journal,null)?.downloadRetryAt)]};
}
async function settlement({root,platform,date,extension}){
 const flash=platform==='taobao_flash',page=()=>extension.attach({platform}).page;await page().bringToFront();let main=page();
 if(flash){const menu=main.locator('li.cook-menu-item').filter({visible:true,hasText:/^财务下载$/});if(!await menu.count())await navigation(()=>require('../src/taobao-flash/browser-probe').runFlashStep(main,{step:'finance-menu'}));main=page();await navigation(()=>require('../src/taobao-flash/browser-probe').runFlashStep(main,{step:'finance-download'}));}
 else{await main.broker.call(main.descriptor,{action:'openJdStatement'});await waitFor(async()=>page(),p=>new URL(p.url()).pathname==='/v3/financial/statement/newDownload'?p:false,{timeout:45000,error:'jd_statement_navigation_failed'});main=page();}
 const frame=flash?await frameFor(extension,platform,'https://napos-bill-pc.faas.ele.me','/napos-bill-pc/v2/bill-download'):main;
 const step=(name,extra={})=>(flash?require('../src/taobao-flash/frame-probe').runFlashFrameStep:require('../src/jd-delivery/browser-probe').runJdStep)(frame,{step:name,date,root,...extra});
 const journal=journalPath(root,platform,date,'settlement');let prior=core.read(journal,null);
 if(!prior){if(!flash){await step('dismiss-guide');await step('completion-date');}await step('custom-date');if(flash)await step('summary');await step('open-date');await step(flash?'select-day':'calendar-day');if(!flash)await step('confirm-date');await step(flash?'export-summary':'export-orders');prior=core.read(journal,null);}
 if(flash){await waitFor(()=>inspect(frame),state=>{const found=state.tableRows.filter(r=>r[1]==='汇总'&&r[2]===date+' - '+date+' 账单汇总'&&r[4]==='导出成功'&&Date.parse(r[0].replace(' ','T')+'+08:00')>=Date.parse(prior.at)-2000);if(found.length>1)throw Error('platform_export_ambiguous');return found[0];});if(!prior.downloadRequestedAt||!prior.downloadRetryAt&&Date.now()-Date.parse(prior.downloadRequestedAt)>120000)await step('download-summary',{retry:!!prior.downloadRequestedAt});return {match:name=>name.endsWith('.xlsx')&&name.includes(date.replaceAll('-','.')+'-'+date.replaceAll('-','.'))&&name.includes('账单汇总'),since:Date.parse(prior.at)};}
 const record=await waitFor(async()=>{await step('refresh-records');return inspect(frame);},state=>{const rows=state.tableRows.filter(r=>/^\d+$/.test(r[0]||'')&&new RegExp('^\\d+_对账单下载_'+date.replaceAll('-','')+'_全部_').test(r[1]||'')&&r[3]==='下载'&&Date.parse(r[2].replace(' ','T')+'+08:00')>=Date.parse(prior.at)-2000);if(rows.length>1)throw Error('platform_export_ambiguous');return rows[0];});
 const jobId=record[0];if(!prior.downloadRequestedAt)await step('download-orders',{jobId});
 const state=await inspect(frame),parts=state.tableRows.filter(r=>new RegExp('^\\d+_对账单下载_'+date.replaceAll('-','')+'_全部_'+jobId+'_\\d+$').test(r[0]||''));if(parts.length!==1)throw Error('platform_download_parts_incomplete');const partId=parts[0][0].split('_').at(-1);if(!core.read(journal,null).partRequestedAt)await step('download-part',{jobId,partId});return {match:name=>name===parts[0][0]+'.zip'||name===parts[0][0]+'_0.xlsx',since:Date.parse(prior.at)};
}
async function runPlatform(options){const {root,platform,type,date,scope}=options;if(!['jd_delivery','taobao_flash'].includes(platform)||!['operating','product','settlement'].includes(type))throw Error('client_platform_invalid');
 const target=path.join(root,'downloads',platform,date,type+'.xlsx'),manifest=target+'.json',parser=platform==='jd_delivery'?require('../src/jd-delivery/source-file').inspectJdBuffer:require('../src/taobao-flash/source-file').inspectFlashBuffer,parse=buffer=>parser(buffer,{type,date,expectedStoreIds:scope.bindings.map(r=>r.platform_id),allowUnmatched:true});
 let parsed;const saved=core.read(manifest,null);if(saved){const buffer=fs.readFileSync(target);if(crypto.createHash('sha256').update(buffer).digest('hex')!==saved.sha256)throw Error('operating_archive_hash_changed');parsed=parse(buffer);}else{
 if(options.extension.ensurePlatform)await options.extension.ensurePlatform(platform);if(options.extension.refreshPlatform)await options.extension.refreshPlatform(platform);options.onProgress?.({phase:'exporting'});const download=await(type==='settlement'?settlement:report)(options);options.onProgress?.({phase:'downloading'});parsed=await readFileArrival({...download,directory:require('./download-directory.cjs').resolveDownloadDirectory({downloadDirectory:options.downloadDirectory}),target,parse});core.atomic(manifest,{sha256:parsed.sha256,date,type,platform});
 }
 const {rows,...summary}=parsed;return {...summary,file:path.relative(root,target),phase:'downloaded',uploaded:false,source_mode:'all_stores'};
}
module.exports={runPlatform,readFileArrival,waitFor,journalPath,frameFor};
