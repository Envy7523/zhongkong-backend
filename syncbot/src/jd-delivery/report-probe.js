'use strict';
async function runJdReportStepImpl(frame,{step,date,type,filename,root,retry=false,permissionRetry=false}){
 if(new URL(frame.url()).origin!=='https://kunce-store.jddj.com'||new URL(frame.url()).pathname!=='/waimai/report-download')throw Error('jd_report_origin_invalid');
 const health=await frame.broker.call(frame.descriptor,{action:'documentHealth'});if(health.visibility!=='visible')throw Error('client_browser_not_visible');
 if(step==='open-date')await frame.locator('input[placeholder="开始日期"]').filter({visible:true}).click();
 else if(step==='select-day'){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw Error('jd_date_invalid');
  const day=frame.locator('.ant-picker-dropdown td.ant-picker-cell-in-view:not(.ant-picker-cell-disabled)[title="'+date+'"]') .filter({visible:true});
  await day.waitFor({state:'visible',timeout:10000});
  if(await day.count()!==1)throw Error('jd_report_day_missing');await day.click();await day.click();
 }
 else if(step==='download-list')await frame.getByText('下载列表',{exact:true}).filter({visible:true}).click();
 else if(step==='confirm-list'){
  const confirm=frame.getByRole('button',{name:'前往下载列表',exact:true}).filter({visible:true});
  try{if(await confirm.count()===1)await confirm.click();else await frame.getByText('下载列表',{exact:true}).filter({visible:true}).click();}
  catch(error){if(error.message!=='extension_element_timeout')throw error;
   // This success toast/dialog can disappear between inspection and click. Only
   // navigate to the existing list; never replay the export submission.
   if(await confirm.count()!==0)throw error;
   await frame.getByText('下载列表',{exact:true}).filter({visible:true}).click();
  }
 }
 else if(step==='refresh-list')await frame.getByRole('button',{name:'刷新',exact:true}).filter({visible:true}).click();
 else if(step==='data-tab')await frame.getByText('数据下载',{exact:true}).filter({visible:true}).click();
 else if(step==='operating-tab')await frame.locator('[role="tab"]').filter({visible:true,hasText:/^门店$/}).click();
 else if(step==='product-tab')await frame.locator('[role="tab"]').filter({visible:true,hasText:/^商品$/}).click();
 else if(step==='download-file'){
  if(!['operating','product'].includes(type)||!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw Error('jd_report_parameters_invalid');
  const prefix=(type==='operating'?'门店':'商品')+'_'+date.replaceAll('-','')+'_'+date.replaceAll('-','')+'_';
  if(typeof filename!=='string'||!filename.startsWith(prefix)||!filename.endsWith('.xlsx')||/[\\/]/.test(filename))throw Error('jd_report_filename_invalid');
  const fs=require('node:fs'),path=require('node:path'),journal=path.join(root||path.join(process.env.LOCALAPPDATA,'EtaigongDeliveryCollector'),'jd-export-tests',date+'-'+type+'.json'),prior=JSON.parse(fs.readFileSync(journal,'utf8'));
  if(prior.downloadRequestedAt&&(!retry||prior.downloadRetryAt&&(!permissionRetry||prior.downloadPermissionRetryAt)))throw Error('jd_download_already_requested');
  const state=await frame.broker.call(frame.descriptor,{action:'inspectJdReport'}),matches=state.tableRows.filter(row=>row[0]===filename&&row[2]==='下载');
  if(matches.length!==1||Date.parse(matches[0][1].replace(' ','T')+'+08:00')<Date.parse(prior.at)-2000)throw Error('jd_download_record_mismatch');
  fs.writeFileSync(journal,JSON.stringify({...prior,filename,...(permissionRetry?{downloadPermissionRetryAt:new Date().toISOString()}:retry?{downloadRetryAt:new Date().toISOString()}:{downloadRequestedAt:new Date().toISOString()})},null,2));
  await frame.locator('tr').filter({visible:true,has:frame.getByText(filename,{exact:true})}).getByText('下载',{exact:true}).click();
 }
 else if(step==='export'){
  if(!['operating','product'].includes(type)||!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw Error('jd_report_parameters_invalid');
  const state=await frame.broker.call(frame.descriptor,{action:'inspectJdReport'});
  const range=state.inputs.filter(e=>['开始日期','结束日期'].includes(e.placeholder));
  if(range.length!==2||range.some(e=>e.value!==date))throw Error('jd_export_date_mismatch');
  if(!state.reportControls.some(e=>e.text===(type==='operating'?'门店':'商品')&&e.selected==='true'))throw Error('jd_export_type_mismatch');
  if(state.inputs.some(e=>e.type==='checkbox'&&!e.checked))throw Error('jd_export_columns_incomplete');
  const fs=require('node:fs'),path=require('node:path'),dir=path.join(root||path.join(process.env.LOCALAPPDATA,'EtaigongDeliveryCollector'),'jd-export-tests');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,date+'-'+type+'.json'),JSON.stringify({status:'submission_pending',at:new Date().toISOString(),date,type,baseline:state.tableRows},null,2),{flag:'wx'});
  await frame.getByRole('button',{name:'下载数据',exact:true}).filter({visible:true}).click();
 }
 else throw Error('jd_report_step_invalid');
 return frame.broker.call(frame.descriptor,{action:'inspectJdReport'});
}
async function runJdReportStep(frame,options){try{return await runJdReportStepImpl(frame,options);}catch(e){e.operation='jd_'+options.step.replaceAll('-','_');throw e;}}
module.exports={runJdReportStep};
