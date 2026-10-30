'use strict';
const contract = require('./operating-contract');
const { plainDate, parseOperatingFile } = require('./operating-file');
const visible = locator => locator.filter({ visible: true });
const exact = value => new RegExp('^' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');

async function selectOperatingDate(page, date) {
  if (plainDate(date) !== date) throw Error('operating_date_range_invalid');
  const inputs = visible(page.locator('input[type="text"]'));
  if (await inputs.count() !== 2) throw Error('operating_date_inputs_ambiguous');
  await page.page?.().bringToFront();
  await inputs.nth(0).click();
  const panel = visible(page.locator('.roo-datepicker-days')).first();
  await panel.waitFor({ state: 'visible', timeout: 15000 });
  const months = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
  const targetYear = Number(date.slice(0,4)), targetMonth = Number(date.slice(5,7));
  for (let attempt=0;attempt<13;attempt++) {
    const headings = await panel.locator('.action-select a').allTextContents();
    const year = Number(headings[0]), month = months.indexOf(headings[1]?.trim())+1;
    if (!Number.isInteger(year) || !month) throw Error('operating_calendar_header_invalid');
    const delta = (targetYear-year)*12+targetMonth-month;
    if (!delta) break;
    if (attempt===12 || Math.abs(delta)>12) throw Error('operating_calendar_range_unsupported');
    const next = new Date(Date.UTC(year,month-1+(delta>0?1:-1),1));
    await panel.locator(delta>0?'.action-next .roo-icon-chevron-right-new':'.action-pre .roo-icon-chevron-left-new').click();
    await panel.locator('.action-select a').filter({hasText:exact(months[next.getUTCMonth()])}).waitFor({state:'visible',timeout:10000});
  }
  const day = panel.locator('td:not(.old):not(.disabled)').filter({hasText:exact(String(Number(date.slice(8,10))))});
  if (await day.count()!==1) throw Error('operating_calendar_date_unavailable');
  // Roo commits a range only after both the start and end calendar clicks.
  await day.click(); await day.click();
  const selected = await inputs.evaluateAll(elements=>elements.map(el=>el.value));
  if (selected[0]!==date || selected[1]!==date) throw Error('operating_ui_date_mismatch');
}

// 接收已登录的报表 page/iframe；登录、验证码和日期控件由调用方处理。
// 仅使用实际界面控件，不持久化站内 token，也不猜测下载接口。
async function selectOperatingStores(page, storeIds) {
  if (!Array.isArray(storeIds)||!storeIds.length||new Set(storeIds).size!==storeIds.length||storeIds.some(id=>typeof id!=='string'||!/^\d+$/.test(id))) throw Error('operating_download_scope_required');
  await visible(page.getByRole('button',{name:'自定义门店',exact:true})).click();
  await visible(page.getByRole('button',{name:'批量导入门店',exact:false})).click();
  await visible(page.getByText('替换已选门店',{exact:true})).click();
  const editor=visible(page.locator('textarea'));
  await editor.fill(storeIds.join('\n'));
  await visible(page.getByRole('button',{name:'一键导入',exact:true,disabled:false})).press('Enter');
  await editor.waitFor({state:'hidden',timeout:20000});
  await visible(page.getByText(`已选门店（${storeIds.length}）`,{exact:true})).waitFor({state:'visible',timeout:20000});
  const confirm=visible(page.getByRole('button',{name:'确认',exact:true,disabled:false}));
  // Keyboard confirmation avoids the platform's floating customer-service iframe.
  await confirm.press('Enter');
  await confirm.waitFor({state:'hidden',timeout:15000});
  if(!await visible(page.getByRole('button',{name:'自定义门店',exact:true})).evaluate(el=>el.classList.contains('roo-btn-primary')))throw Error('operating_ui_scope_mismatch');
}

async function prepareOperatingReportImpl(page, { from, to = from, storeIds }, progress) {
  if (plainDate(from) !== from || plainDate(to) !== to || from > to) throw Error('operating_date_range_invalid');
  const inputs = visible(page.locator('input[type="text"]'));
  const dates = await inputs.evaluateAll(elements => elements.map(el => el.value));
  if (dates.length !== 2 || dates[0] !== from || dates[1] !== to) throw Error('operating_ui_date_mismatch');
  for (const name of ['全部门店', '全部']) {
    progress.step=name==='全部门店'?'scope_stores':'scope_business';
    const button = visible(page.getByRole('button', { name, exact: true }));
    if (!await button.evaluate(el => el.classList.contains('roo-btn-primary'))) await button.click();
    if (!await button.evaluate(el => el.classList.contains('roo-btn-primary'))) throw Error('operating_ui_scope_mismatch');
  }
  progress.step='grain';
  const daily = visible(page.getByText('按天', { exact: true }));
  if (!await daily.evaluate(el => [...el.classList].some(name => name.startsWith('active_')))) await daily.click();
  if (!await daily.evaluate(el => [...el.classList].some(name => name.startsWith('active_')))) throw Error('operating_ui_grain_mismatch');
  progress.step='store_selection';if(storeIds)await selectOperatingStores(page,storeIds);
  const labels = visible(page.locator('label.roo-checkbox'));
  for (const metric of contract.metrics) await labels.filter({hasText:exact(metric)}).waitFor({state:'visible',timeout:30000});
  const available = await labels.evaluateAll(elements => elements.map(el => ({
    name: el.textContent.trim(), checked: !!el.querySelector('input')?.checked,
    disabled: !!el.querySelector('input')?.disabled,
    key: el.querySelector('input')?.value || '',
    group: !el.querySelector('input')?.value && !el.querySelector('input')?.disabled,
  })));
  for (const metric of contract.metrics) {
    if (available.filter(item => item.name === metric).length !== 1) throw Error('operating_ui_metric_missing:' + metric);
  }
  for (const item of available) {
    if (item.disabled || item.group) continue;
    const wanted = contract.metrics.includes(item.name) || contract.identityFields.includes(item.name);
    progress.step='metric_'+contract.metrics.indexOf(item.name);
    const label=labels.filter({has:page.locator('input[value="'+item.key.replace(/["\\]/g,'\\$&')+'"]')});
    if (await label.evaluate(el=>!!el.querySelector('input')?.checked) !== wanted) await label.click();
  }
  // 日期由报表固定输出，界面仅有其余五个不可取消的基础字段复选框。
  const selected = ['日期', ...await labels.evaluateAll(elements => elements.filter(el => {const input=el.querySelector('input');return input?.checked&&(input.value||input.disabled);}).map(el => el.textContent.trim()))];
  if (selected.length !== contract.fields.length || contract.fields.some(name => !selected.includes(name))) {
    const error=Error('operating_ui_selection_mismatch');
    // Only public report field labels are recorded. Never capture input values,
    // page text, account identifiers, or browser credentials in diagnostics.
    const missing=contract.fields.map((name,index)=>selected.includes(name)?null:index).filter(index=>index!==null);
    const duplicates=contract.fields.map((name,index)=>selected.filter(value=>value===name).length>1?index:null).filter(index=>index!==null);
    error.trace=['fields_count_'+selected.length,'fields_missing_'+(missing.join('_')||'none'),'fields_duplicate_'+(duplicates.join('_')||'none'),
      ...selected.filter(name=>!contract.fields.includes(name)).slice(0,4).map(name=>'fields_extra_'+Buffer.from(name,'utf8').toString('hex').slice(0,100))];
    throw error;
  }
  if(storeIds&&!await visible(page.getByRole('button',{name:'自定义门店',exact:true})).evaluate(el=>el.classList.contains('roo-btn-primary')))throw Error('operating_ui_scope_mismatch');
  return { from, to, fields: [...selected], scope: storeIds?'custom_stores':'all_stores', ...(storeIds?{expected_store_ids:[...storeIds]}:{}), grain: 'day' };
}

async function prepareOperatingReport(page, options) {
  const progress={step:'dates'};
  try{return await prepareOperatingReportImpl(page,options,progress);}catch(error){
    if(progress.step==='dates')throw error;
    const trace=['operating_fields_'+progress.step.replace(/-/g,'n')];
    for(const [code,lookup] of [['all_stores',()=>page.getByRole('button',{name:'全部门店',exact:true})],['all_business',()=>page.getByRole('button',{name:'全部',exact:true})],['daily',()=>page.getByText('按天',{exact:true})]]){
      try{trace.push('fields_'+code+'_'+Math.min(99,await visible(lookup()).count()));}catch{}
    }
    error.trace=[...(error.trace||[]),...trace];throw error;
  }
}

function validateJobFilename(filename, { from, to = from, account, scope = 'all_stores' }) {
  if (plainDate(from) !== from || plainDate(to) !== to || from > to || !/^[A-Za-z0-9_-]+$/.test(account || '')) throw Error('operating_job_scope_invalid');
  if (!['all_stores','custom_stores'].includes(scope)) throw Error('operating_job_scope_invalid');
  const prefix = `门店_${scope==='custom_stores'?'自定义门店':'全部门店'}_${from.replaceAll('-', '')}_${to.replaceAll('-', '')}_${account}_`;
  if (!filename.startsWith(prefix) || !/^\d{4}-\d{2}-\d{2} \d{2}_\d{2}_\d{2}$/.test(filename.slice(prefix.length))) throw Error('operating_job_name_mismatch');
  return filename;
}

// 调用方保存准确任务名称，失败时恢复同一任务；这里从不重新点击“下载数据”。
async function downloadOperatingJob(page, { filename, from, to = from, account, scope='all_stores', expectedStoreIds, targetPath, timeoutMs = 20000, downloadPage = page }) {
  validateJobFilename(filename, { from, to, account, scope });
  if (!targetPath || !expectedStoreIds?.length) throw Error('operating_download_scope_required');
  const task = visible(page.locator('tr')).filter({ has: page.getByText(filename, { exact: true }) });
  if (await task.count() !== 1) throw Error('operating_job_missing_or_ambiguous');
  const control = task.getByText('下载', { exact: true });
  if (await control.count() !== 1 || !await control.isVisible()) throw Error('operating_job_not_ready');
  const [download] = await Promise.all([
    downloadPage.waitForEvent('download', { timeout: timeoutMs }), control.click(),
  ]);
  await download.saveAs(targetPath);
  const validation = parseOperatingFile(targetPath, { from, to, expectedStoreIds });
  return { filename, target_path: targetPath, validation };
}
module.exports = { prepareOperatingReport, selectOperatingStores, selectOperatingDate, validateJobFilename, downloadOperatingJob };
