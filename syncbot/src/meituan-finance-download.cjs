'use strict';
async function assertBuyScope(frame){
 if(await frame.getByPlaceholder('请选择门店').inputValue()!=='全部门店')throw Error('finance_store_scope_invalid');
 for(const label of ['全部项目','全部合同','账户汇总|管理所有授权子账户'])if(!await frame.getByText(label,{exact:true}).isVisible().catch(()=>false))throw Error('finance_buy_scope_invalid');
 const checks=frame.locator('input[type=checkbox]');if(await checks.count()!==3)throw Error('finance_buy_filter_changed');
 for(const check of await checks.all())if(await check.isChecked())throw Error('finance_buy_scope_invalid');
}
async function findFinanceTask(frame,{from,to,filename,business='团购'}){
 if(!['团购','买单'].includes(business))throw Error('finance_business_invalid');
 if(filename&&(!filename.includes('_'+business+'_')||!filename.includes(from+'~'+to)))throw Error('finance_task_scope_mismatch');
 const match=()=>filename?frame.locator('tr').filter({hasText:filename}):frame.locator('tr').filter({hasText:from+'~'+to}).filter({hasText:'_'+business+'_'}).first();
 if(await match().count())return match();
 const first=frame.locator('.mtd-pagination-item[title="1"]');
 if(await first.count()&&!await first.getAttribute('class').then(c=>c.includes('mtd-pagination-item-active'))){await first.click();await frame.page().waitForTimeout(800);}
 for(let page=0;page<100;page++){
  if(await match().count())return match();
  const next=frame.locator('.mtd-pagination-next:not(.mtd-pagination-item-disabled)');if(!await next.count())return null;
  const before=await frame.locator('.mtd-pagination-item-active').getAttribute('title');await next.click();
  await frame.waitForFunction(before=>document.querySelector('.mtd-pagination-item-active')?.getAttribute('title')!==before,before,{timeout:10000});await frame.page().waitForTimeout(800);
 }throw Error('finance_download_pagination_limit');
}
// Retry the same generated task only; never create a second export on download failure.
async function downloadGenerated(page,row,filename,target,{attempts=3,delayMs=10000}={}){
 for(let attempt=0;attempt<attempts;attempt++){
  const event=page.waitForEvent('download',{timeout:60000});
  await row.getByText('下载',{exact:true}).click();
  const download=await event;
  const failure=await download.failure();
  if(failure){if(attempt+1<attempts){await page.waitForTimeout(delayMs);continue;}throw Error('finance_download_failed');}
  if(download.suggestedFilename()!==filename)throw Error('finance_download_task_mismatch');
  await download.saveAs(target);return;
 }
}
module.exports={downloadGenerated,findFinanceTask,assertBuyScope};
