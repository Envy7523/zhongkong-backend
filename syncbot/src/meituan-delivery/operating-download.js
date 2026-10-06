'use strict';
const contract = require('./operating-contract');
const { plainDate, parseOperatingFile } = require('./operating-file');
const visible = locator => locator.filter({ visible: true });
const exact = value => new RegExp('^' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');

// 接收已登录的报表 page/iframe；登录、验证码和日期控件由调用方处理。
// 仅使用实际界面控件，不持久化站内 token，也不猜测下载接口。
async function prepareOperatingReport(page, { from, to = from }) {
  if (plainDate(from) !== from || plainDate(to) !== to || from > to) throw Error('operating_date_range_invalid');
  const inputs = visible(page.locator('input[type="text"]'));
  const dates = await inputs.evaluateAll(elements => elements.map(el => el.value));
  if (dates.length !== 2 || dates[0] !== from || dates[1] !== to) throw Error('operating_ui_date_mismatch');
  for (const name of ['全部门店', '全部']) {
    const button = visible(page.getByRole('button', { name, exact: true }));
    await button.click();
    if (!await button.evaluate(el => el.classList.contains('roo-btn-primary'))) throw Error('operating_ui_scope_mismatch');
  }
  const daily = visible(page.getByText('按天', { exact: true }));
  await daily.click();
  if (!await daily.evaluate(el => [...el.classList].some(name => name.startsWith('active_')))) throw Error('operating_ui_grain_mismatch');
  const labels = visible(page.locator('label.roo-checkbox'));
  const available = await labels.evaluateAll(elements => elements.map(el => ({
    name: el.textContent.trim(), checked: !!el.querySelector('input')?.checked,
    disabled: !!el.querySelector('input')?.disabled,
  })));
  for (const metric of contract.metrics) {
    if (available.filter(item => item.name === metric).length !== 1) throw Error('operating_ui_metric_missing:' + metric);
  }
  for (const item of available) {
    if (item.disabled) continue;
    const wanted = contract.metrics.includes(item.name) || contract.identityFields.includes(item.name);
    if (item.checked !== wanted) await labels.filter({ hasText: exact(item.name) }).click();
  }
  // 日期由报表固定输出，界面仅有其余五个不可取消的基础字段复选框。
  const selected = ['日期', ...await labels.evaluateAll(elements => elements.filter(el => el.querySelector('input')?.checked).map(el => el.textContent.trim()))];
  if (selected.length !== contract.fields.length || contract.fields.some(name => !selected.includes(name))) throw Error('operating_ui_selection_mismatch');
  return { from, to, fields: [...selected], scope: 'all_stores', grain: 'day' };
}

function validateJobFilename(filename, { from, to = from, account }) {
  if (plainDate(from) !== from || plainDate(to) !== to || from > to || !/^[A-Za-z0-9_-]+$/.test(account || '')) throw Error('operating_job_scope_invalid');
  const prefix = `门店_全部门店_${from.replaceAll('-', '')}_${to.replaceAll('-', '')}_${account}_`;
  if (!filename.startsWith(prefix) || !/^\d{4}-\d{2}-\d{2} \d{2}_\d{2}_\d{2}$/.test(filename.slice(prefix.length))) throw Error('operating_job_name_mismatch');
  return filename;
}

// 调用方保存准确任务名称，失败时恢复同一任务；这里从不重新点击“下载数据”。
async function downloadOperatingJob(page, { filename, from, to = from, account, expectedStoreIds, targetPath, timeoutMs = 20000, downloadPage = page }) {
  validateJobFilename(filename, { from, to, account });
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
module.exports = { prepareOperatingReport, validateJobFilename, downloadOperatingJob };
