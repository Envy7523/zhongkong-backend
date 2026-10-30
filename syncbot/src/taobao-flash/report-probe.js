'use strict';
const operatingLabels=['有效订单','收入','营业额及明细','支出及明细','曝光人数','进店人数','下单人数','进店转化率','下单转化率','曝光次数','店铺评分'];
async function runFlashReportStepImpl(frame,{step,date,type,filename,root,retry=false,permissionRetry=false}){
 if(new URL(frame.url()).origin!=='https://melody-stats-next.ele.me')throw Error('flash_report_origin_invalid');
 if(step==='calendar-state')return frame.broker.call(frame.descriptor,{action:'inspectFlashCalendar'});
 const health=await frame.broker.call(frame.descriptor,{action:'documentHealth'});if(health.visibility!=='visible')throw Error('client_browser_not_visible');
 if(step==='open-date'){await frame.locator('input[placeholder="开始日期"]').filter({visible:true}).click();return frame.broker.call(frame.descriptor,{action:'inspectFlashCalendar'});}
 else if(step==='select-day'){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw Error('flash_date_invalid');
  const day=frame.locator('.ant-picker-dropdown td.ant-picker-cell-in-view:not(.ant-picker-cell-disabled)[title="'+date+'"]') .filter({visible:true});
  if(await day.count()!==1)throw Error('flash_calendar_day_missing');await day.click();await day.click();return frame.broker.call(frame.descriptor,{action:'inspectFlashCalendar'});
 }
 else if(step==='operating-columns'){
  for(const label of operatingLabels){const field=frame.locator('label.ant-checkbox-wrapper').filter({visible:true,hasText:new RegExp('^'+label+'$')});
   await field.waitFor({state:'visible'});if(!await field.locator('input').isChecked())await field.click();
  }
 }
 else if(step==='product-columns'){
  for(const label of ['城市','销售额','销量','下单人数','带来订单数','订单交易额']){const field=frame.locator('label.ant-checkbox-wrapper').filter({visible:true,hasText:new RegExp('^'+label+'$')});if(!await field.locator('input').isChecked())await field.click();}
 }
 else if(step==='download-management')await frame.getByText('下载管理',{exact:true}).filter({visible:true}).click();
 else if(step==='operating-tab')await frame.getByText('门店下载',{exact:true}).filter({visible:true}).click();
 else if(step==='product-tab')await frame.getByText('商品下载',{exact:true}).filter({visible:true}).click();
 else if(step==='report-tab')await frame.getByText('报表下载',{exact:true}).filter({visible:true}).click();
 else if(step==='download-file'){
  if(!['operating','product'].includes(type)||!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw Error('flash_download_parameters_invalid');
  const prefix=(type==='operating'?'门店':'商品')+'下载_'+date.replaceAll('-','')+'至'+date.replaceAll('-','')+'_全部门店_';
  if(typeof filename!=='string'||!filename.startsWith(prefix)||! /^(\d+)(?:_\1)?_\d{17}\.xlsx$/.test(filename.slice(prefix.length))){const error=Error('flash_download_filename_invalid'),encoded=Buffer.from(String(filename),'utf8').toString('hex');error.trace=[];for(let offset=0;offset<encoded.length&&offset<600;offset+=100)error.trace.push('file_0_'+(offset/100)+'_'+encoded.slice(offset,offset+100));throw error;}
  const fs=require('node:fs'),path=require('node:path'),journal=path.join(root||path.join(process.env.LOCALAPPDATA,'EtaigongDeliveryCollector'),'flash-export-tests',date+'-'+type+'.json'),prior=JSON.parse(fs.readFileSync(journal,'utf8'));
  if(prior.downloadRequestedAt&&(!retry||prior.downloadRetryAt&&(!permissionRetry||prior.downloadPermissionRetryAt)))throw Error('flash_download_already_requested');
  const stamp=filename.match(/_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})\.xlsx$/);
  const created=Date.parse(`${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}.${stamp[7]}+08:00`);
  if(!Number.isFinite(created)||created<Date.parse(prior.at)-2000)throw Error('flash_download_record_mismatch');
  const state=await frame.broker.call(frame.descriptor,{action:'inspectFlashReport'}),rows=state.tableRows.filter(r=>r[0]===filename&&r[1]==='成功');if(rows.length!==1)throw Error('flash_download_record_mismatch');
  fs.writeFileSync(journal,JSON.stringify({...prior,filename,...(permissionRetry?{downloadPermissionRetryAt:new Date().toISOString()}:retry?{downloadRetryAt:new Date().toISOString()}:{downloadRequestedAt:new Date().toISOString()})},null,2));
  await frame.locator('tr').filter({visible:true,has:frame.getByText(filename,{exact:true})}).getByText('下载',{exact:true}).click();
 }
 else if(['export-operating','export-product'].includes(step)){
  const reportType=step==='export-operating'?'operating':'product';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw Error('flash_date_invalid');
  const state=await frame.broker.call(frame.descriptor,{action:'inspectFlashReport'}),dates=state.inputs.filter(e=>['开始日期','结束日期'].includes(e.placeholder));
  if(dates.length!==2||dates.some(e=>e.value!==date))throw Error('flash_export_date_mismatch');
  for(const name of (reportType==='operating'?['按天','店铺','全部门店']:['按天','全部门店','全部商品']))if(!state.reportSelections.some(e=>e.selected.includes(name)))throw Error('flash_export_filter_mismatch');
  const columns=state.selectedColumns.flatMap(c=>c.split(','));for(const name of (reportType==='operating'?['shop_id','shop_name','valid_order_cnt','income_amt','trade_amt','shop_food_amt','payout_amt','shop_rating']:['shop_id','shop_name','item_name','sell_amt','sell_cnt']))if(!columns.includes(name))throw Error('flash_export_columns_incomplete');
  if(await frame.locator('.shop-data-wrapper').filter({visible:true}).count()!==1)throw Error('flash_export_type_mismatch');
  const fs=require('node:fs'),path=require('node:path'),journalRoot=path.join(root||path.join(process.env.LOCALAPPDATA,'EtaigongDeliveryCollector'),'flash-export-tests');fs.mkdirSync(journalRoot,{recursive:true});
  fs.writeFileSync(path.join(journalRoot,date+'-'+reportType+'.json'),JSON.stringify({status:'submission_pending',at:new Date().toISOString(),date,columns:state.selectedColumns,baseline:state.tableRows},null,2),{flag:'wx'});
  await frame.getByRole('button',{name:'下载数据',exact:true}).filter({visible:true}).click();
 }
 else throw Error('flash_report_step_invalid');
 return frame.broker.call(frame.descriptor,{action:'inspectFlashReport'});
}
async function runFlashReportStep(page,options){try{return await runFlashReportStepImpl(page,options);}catch(e){e.operation='flash_'+options.step.replaceAll('-','_');throw e;}}
module.exports={runFlashReportStep,operatingLabels};
