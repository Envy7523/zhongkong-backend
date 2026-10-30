'use strict';
async function runFlashFrameStep(frame,{step,date,root,retry=false}){
 const url=new URL(frame.url());if(url.origin!=='https://napos-bill-pc.faas.ele.me'||url.pathname!=='/napos-bill-pc/v2/bill-download')throw Error('flash_frame_origin_invalid');
 const health=await frame.broker.call(frame.descriptor,{action:'documentHealth'});if(health.visibility!=='visible')throw Error('client_browser_not_visible');
 if(step==='open-month')await frame.locator('input[placeholder="请选择月份"]').filter({visible:true}).click();
 else if(step==='custom-date')await frame.locator('.cook-form-item').filter({has:frame.getByText('时间',{exact:true})}).getByText('自定义',{exact:true}).filter({visible:true}).click();
 else if(step==='summary')await frame.locator('.cook-form-item').filter({has:frame.getByText('内容',{exact:true})}).getByText('汇总',{exact:true}).filter({visible:true}).click();
 else if(step==='open-date')await frame.locator('input[placeholder="开始日期"]').filter({visible:true}).click();
 else if(step==='select-day'){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw Error('flash_date_invalid');
  const day=frame.locator('.cook-picker-dropdown td.cook-picker-cell-in-view:not(.cook-picker-cell-disabled)[title="'+date+'"]');
  if(await day.count()!==1)throw Error('flash_calendar_day_missing');await day.click();await day.click();
 }
 else if(step==='export-summary'){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw Error('flash_date_invalid');
  const state=await frame.broker.call(frame.descriptor,{action:'inspectFlashReport'}),dates=state.inputs.filter(e=>['开始日期','结束日期'].includes(e.placeholder));
  if(dates.length!==2||dates.some(e=>e.value!==date))throw Error('flash_export_date_mismatch');
  for(const choice of ['账单','全部门店','汇总','自定义'])if(!state.activeChoices.includes(choice))throw Error('flash_export_filter_mismatch');
  const fs=require('node:fs'),path=require('node:path'),journalRoot=path.join(root||path.join(process.env.LOCALAPPDATA,'EtaigongDeliveryCollector'),'flash-export-tests');fs.mkdirSync(journalRoot,{recursive:true});
  fs.writeFileSync(path.join(journalRoot,date+'-settlement.json'),JSON.stringify({status:'submission_pending',at:new Date().toISOString(),date,baseline:state.tableRows},null,2),{flag:'wx'});
  await frame.getByRole('button',{name:'导出账单',exact:true}).filter({visible:true}).click();
 }
 else if(step==='download-summary'){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw Error('flash_date_invalid');
  const fs=require('node:fs'),path=require('node:path'),journal=path.join(root||path.join(process.env.LOCALAPPDATA,'EtaigongDeliveryCollector'),'flash-export-tests',date+'-settlement.json'),prior=JSON.parse(fs.readFileSync(journal,'utf8'));
  if(prior.downloadRequestedAt&&(!retry||prior.downloadRetryAt||Date.now()-Date.parse(prior.downloadRequestedAt)<120000))throw Error('flash_download_already_requested');
  const state=await frame.broker.call(frame.descriptor,{action:'inspectFlashReport'}),records=state.tableRows.filter(row=>row[1]==='汇总'&&row[2]===date+' - '+date+' 账单汇总'&&row[4]==='导出成功'&&Date.parse(row[0].replace(' ','T')+'+08:00')>=Date.parse(prior.at)-2000);
  if(records.length!==1)throw Error('flash_download_record_mismatch');
  fs.writeFileSync(journal,JSON.stringify({...prior,record:records[0],...(retry?{downloadRetryAt:new Date().toISOString()}:{downloadRequestedAt:new Date().toISOString()})},null,2));
  await frame.locator('tr').filter({visible:true,has:frame.getByText(records[0][0],{exact:true})}).getByRole('link',{name:'下载账单',exact:true}).click();
 }
 else throw Error('flash_frame_step_invalid');
 return frame.broker.call(frame.descriptor,{action:'inspectFlashReport'});
}
module.exports={runFlashFrameStep};
