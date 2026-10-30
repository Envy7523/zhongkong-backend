'use strict';
async function runFlashStepImpl(page,{step}){
 if(new URL(page.url()).origin!=='https://melody.shop.ele.me')throw Error('flash_origin_invalid');
 const health=await page.broker.call(page.descriptor,{action:'documentHealth'});if(health.visibility!=='visible')throw Error('client_browser_not_visible');
 if(step==='data-menu')await page.locator('li.cook-menu-item').filter({visible:true,hasText:/^数据中心$/}).click();
 else if(step==='finance-menu')await page.locator('li.cook-menu-item').filter({visible:true,hasText:/^财务管理$/}).click();
 else if(step==='report-menu')await page.locator('li.cook-menu-item').filter({visible:true,hasText:/^(资料下载|数据下载)$/}).click();
 else if(step==='finance-download')await page.locator('li.cook-menu-item').filter({visible:true,hasText:/^财务下载$/}).click();
 else if(step==='reload-download-page')return page.broker.call(page.descriptor,{action:'reloadFlashDownloadPage'});
 else throw Error('flash_step_invalid');
 return page.broker.call(page.descriptor,{action:'inspectFlashReport'});
}
async function runFlashStep(page,options){try{return await runFlashStepImpl(page,options);}catch(e){e.operation='flash_'+options.step.replaceAll('-','_');throw e;}}
module.exports={runFlashStep};
