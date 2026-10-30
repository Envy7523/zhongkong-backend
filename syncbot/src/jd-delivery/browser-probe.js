'use strict';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function visiblePage(page){await page.bringToFront();for(let i=0;i<12;i++){const health=await page.broker.call(page.descriptor,{action:'documentHealth'});if(health.visibility==='visible')return;await pause(200);}throw Error('client_browser_not_visible');}
async function runJdStep(page,{step,date,jobId,partId,root}){
 if(new URL(page.url()).origin!=='https://store.jddj.com')throw Error('jd_origin_invalid');
 await visiblePage(page);
 if(step==='dismiss-guide'){
  const button=page.getByRole('button',{name:'知道了',exact:true}).filter({visible:true});if(await button.count()===1)await button.click();
 }else if(step==='completion-date')await page.getByText('订单完成时间',{exact:true}).filter({visible:true}).click();
 else if(step==='custom-date')await page.locator('.dj-form-item').filter({has:page.getByText('账单时间',{exact:true})}).getByText('自定义',{exact:true}).filter({visible:true}).click();
 else if(step==='open-date')await page.locator('form.dj-form input.el-range-input').nth(0).click();
 else if(step==='calendar-day'){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw Error('jd_date_invalid');
  const state=await page.broker.call(page.descriptor,{action:'inspectJdReport'});
  const panel=state.overlays.find(e=>e.className.includes('el-date-range-picker'));
  if(!panel||!panel.text.startsWith(`${date.slice(0,4)} 年 ${Number(date.slice(5,7))} 月 `))throw Error('jd_calendar_month_mismatch');
  const day=page.locator('.el-picker-panel td.available').filter({visible:true,hasText:new RegExp('^'+Number(date.slice(8))+'$')}).first();
  await day.click();await day.click();
 }
 else if(step==='confirm-date'){
  const panel=page.locator('.el-date-range-picker').filter({visible:true});
  const timeConfirm=panel.locator('button.el-time-panel__btn.confirm').filter({visible:true});
  if(await timeConfirm.count()===1)await timeConfirm.click();
  await panel.locator('button.el-picker-panel__link-btn').filter({visible:true,hasText:/^确定$/}).click();
 }
 else if(step==='select-stores')await page.getByRole('button',{name:'选择门店',exact:true}).filter({visible:true}).click();
 else if(step==='close-stores')await page.locator('.dj-modal .dj-modal-close').filter({visible:true}).filter({hasText:/^$/}).click();
 else if(step==='open-operating-menu'){
  const close=page.locator('.dj-modal .dj-modal-close').filter({visible:true,hasText:/^$/});if(await close.count()===1)await close.click();
  await page.locator('.jd-sub-menu__title').filter({visible:true,hasText:/^经营罗盘$/}).click();
 }
 else if(step==='open-operating-report')await page.locator('.jd-menu-item').filter({visible:true,has:page.getByText('报表下载',{exact:true})}).click();
 else if(step==='refresh-records')await page.locator('button.dj-button').filter({visible:true,hasText:/^刷新$/}).click();
 else if(step==='download-orders'){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||!/^\d+$/.test(jobId||''))throw Error('jd_download_parameters_invalid');
  const fs=require('node:fs'),path=require('node:path');
  const journal=path.join(root||path.join(process.env.LOCALAPPDATA,'EtaigongDeliveryCollector'),'jd-export-tests',date+'-orders.json');
  const prior=JSON.parse(fs.readFileSync(journal,'utf8'));
  const state=await page.broker.call(page.descriptor,{action:'inspectJdReport'});
  const records=state.tableRows.filter(r=>r[0]===jobId&&new RegExp('^\\d+_对账单下载_'+date.replaceAll('-','')+'_全部_').test(r[1])&&r[3]==='下载');
  if(records.length!==1||Date.parse(records[0][2].replace(' ','T')+'+08:00')<Date.parse(prior.at)-2000)throw Error('jd_download_record_mismatch');
  const merchantId=records[0][1].split('_')[0];
  const row=page.locator('tr').filter({visible:true,has:page.getByText(jobId,{exact:true})});
  if(await row.count()!==1)throw Error('jd_download_record_mismatch');
  if(prior.downloadRequestedAt)throw Error('jd_download_already_requested');
  fs.writeFileSync(journal,JSON.stringify({...prior,jobId,merchantId,downloadRequestedAt:new Date().toISOString()},null,2));
  await row.getByRole('link',{name:'下载',exact:true}).click();
 }
 else if(step==='download-part'){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||!/^\d+$/.test(jobId||'')||!/^\d+$/.test(partId||''))throw Error('jd_download_parameters_invalid');
  const fs=require('node:fs'),path=require('node:path'),journal=path.join(root||path.join(process.env.LOCALAPPDATA,'EtaigongDeliveryCollector'),'jd-export-tests',date+'-orders.json'),prior=JSON.parse(fs.readFileSync(journal,'utf8'));
  if(prior.jobId!==jobId||prior.partRequestedAt)throw Error('jd_download_record_mismatch');
  const modal=page.locator('.dj-modal').filter({visible:true,hasText:'任务'+jobId+'为多下载项：'});
  if(!/^\d+$/.test(prior.merchantId||''))throw Error('jd_download_merchant_missing');
  const row=modal.locator('tr').filter({hasText:prior.merchantId+'_对账单下载_'+date.replaceAll('-','')+'_全部_'+jobId+'_'+partId});
  if(await row.count()!==1)throw Error('jd_download_part_mismatch');
  fs.writeFileSync(journal,JSON.stringify({...prior,partId,partRequestedAt:new Date().toISOString()},null,2));
  await row.getByRole('link',{name:'下载',exact:true}).click();
 }
 else if(step==='export-orders'){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw Error('jd_date_invalid');
  const state=await page.broker.call(page.descriptor,{action:'inspectJdReport'});
  const range=state.inputs.filter(e=>e.className==='el-range-input').map(e=>e.value);
  if(range.length!==2||range[0]!==date+' 00:00:00'||range[1]!==date+' 23:59:59')throw Error('jd_export_date_mismatch');
  for(const text of ['订单明细','订单完成时间'])if(!state.choices.some(e=>e.text===text&&e.className.includes('is-checked')))throw Error('jd_export_filter_mismatch');
  const fs=require('node:fs'),path=require('node:path');
  const dir=path.join(root||path.join(process.env.LOCALAPPDATA,'EtaigongDeliveryCollector'),'jd-export-tests');fs.mkdirSync(dir,{recursive:true});
  const journal=path.join(dir,date+'-orders.json');
  fs.writeFileSync(journal,JSON.stringify({status:'submission_pending',at:new Date().toISOString(),date,baseline:state.rows,range},null,2),{flag:'wx'});
  await page.getByRole('button',{name:'账单导出',exact:true}).click();await pause(600);
 }
 else throw Error('jd_probe_step_invalid');
 return page.broker.call(page.descriptor,{action:'inspectJdReport'});
}
module.exports={runJdStep,visiblePage};
