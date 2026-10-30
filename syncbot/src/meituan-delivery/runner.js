'use strict';
const fs = require('fs');
const path = require('path');
const api = require('./api');
const { plainDate, parseOperatingFile } = require('./operating-file');
const { prepareOperatingReport, selectOperatingDate, downloadOperatingJob, validateJobFilename } = require('./operating-download');
const contract = require('./operating-contract');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function write(file, data) { const temp = file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); }
async function reportFrame(page) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const candidates = page.frames().filter(item => {
      try { const url = new URL(item.url()); return url.origin === 'https://waimaieapp.meituan.com' && url.pathname === '/bizdata_pc/report/download'; } catch { return false; }
    });
    const ready=[];
    for(const frame of candidates){try{const list=frame.getByText('下载列表',{exact:true}).filter({visible:true});if(await list.count()===1&&await list.isVisible())ready.push(frame);}catch(error){if(!['extension_origin_denied','extension_page_changed'].includes(error.message))throw error;}}
    if(ready.length>1)throw Error('operating_report_frame_ambiguous');
    if(ready.length===1)return ready[0];
    await pause(1000);
  }
  throw Error('operating_report_frame_missing');
}
async function listJobs(frame, prefix = '门店') {
  const loading=frame.getByText(/正在加载/).filter({ visible: true }),deadline=Date.now()+30000;
  while(await loading.count()){if(Date.now()>=deadline)throw Error('operating_report_loading_timeout');await pause(200);}
  return frame.locator('tr').filter({ visible: true }).evaluateAll((elements,prefix) => elements.map(el => {
    const cells = el.querySelectorAll('td'); return { name: cells[0]?.textContent.trim() || '', time: cells[1]?.textContent.trim() || '', operation: cells[2]?.textContent.trim() || '' };
  }).filter(row => row.name.startsWith(prefix+'_')),prefix);
}
async function findJob(frame, state, persist, prefix='门店', validate=validateJobFilename) {
  await frame.page?.().bringToFront();
  await frame.getByText('下载列表', { exact: true }).filter({visible:true}).click();
  await frame.getByText('文件名称', { exact: true }).filter({visible:true}).waitFor({ state: 'visible', timeout: 30000 });
  const deadline = Date.now() + 5 * 60 * 1000;
  let lastRows=[];
  while (Date.now() < deadline) {
    const rows = lastRows = await listJobs(frame, prefix);
    const jobs = rows.filter(row => {
      try { validate(row.name, { from: state.date, account: state.account, scope:state.scope||'all_stores' }); }
      catch { return false; }
      return state.job_name ? row.name === state.job_name : !state.baseline.includes(row.name);
    });
    if (jobs.length > 1) throw Error('operating_export_job_ambiguous');
    if (jobs.length === 1) {
      if (!state.job_name) { state.job_name = jobs[0].name; state.phase = 'job_created'; persist(); }
      if (jobs[0].operation === '下载') return state.job_name;
      if (/失败/.test(jobs[0].operation)) throw Error('operating_export_failed');
    }
    await pause(5000); await frame.page?.().bringToFront(); await frame.getByText('刷新', { exact: true }).filter({visible:true}).click();
  }
  const error=Error('operating_export_pending');
  error.trace=['export_list_rows_'+lastRows.length,'export_baseline_'+state.baseline.length];
  for(const [index,row] of lastRows.slice(0,2).entries()){
    const encoded=Buffer.from(row.name,'utf8').toString('hex');
    for(let offset=0;offset<encoded.length&&offset<600;offset+=100)error.trace.push('job_'+index+'_'+(offset/100)+'_'+encoded.slice(offset,offset+100));
  }
  throw error;
}
async function runOperating({ page, context, root, date, account = process.env.MEITUAN_DELIVERY_ACCOUNT, downloadOnly = false, explicitStoreSelection = false, preserveViewport = false, apiClient = api, downloadFile = downloadOperatingJob, onProgress = () => {}, report = null, scopeKey = '' }) {
  if (plainDate(date) !== date || typeof account !== 'string' || !/^[A-Za-z0-9_-]+$/.test(account)) throw Error('operating_run_parameters_invalid');
  const currentContract=report?.contract||contract, parseFile=report?.parseFile||parseOperatingFile, prepare=report?.prepare||prepareOperatingReport, prefix=currentContract.prefix||'门店';
  if(report&&!explicitStoreSelection)throw Error('product_explicit_scope_required');
  const scopeName=explicitStoreSelection?'custom_stores':'all_stores';
  if(scopeKey&&!/^[a-f0-9]{12}$/.test(scopeKey))throw Error('operating_scope_key_invalid');
  const runKey=date+(explicitStoreSelection?'_custom':'')+(scopeKey?'_'+scopeKey:'');
  const directory = path.join(root, 'downloads/meituan_delivery/'+currentContract.reportType, runKey);
  const stateDir = path.join(root, 'state/tasks/meituan_delivery/'+currentContract.reportType);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(stateDir, runKey + '.json');
  let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { date, account, scope:scopeName, phase: 'new', started_at: new Date().toISOString() };
  if (state.date !== date || state.account !== account || (state.scope||'all_stores')!==scopeName) throw Error('operating_prior_state_mismatch');
  const persist = () => { write(stateFile, state); onProgress({ phase: state.phase, date, error: state.error || null }); };
  try {
    delete state.error;
    const scope = await apiClient.call(root, '/api/internal/syncbot/meituan-delivery/scope');
    const expectedStoreIds = scope.bindings.map(row => row.platform_id);
    if (!state.file) {
      state.operation = 'check_login'; persist();
      await page.bringToFront();
      if (await page.locator('input[type="password"]').isVisible().catch(() => false)) throw Error('operating_human_login_required');
      if (!preserveViewport) await page.setViewportSize({ width: 1440, height: 1000 });
      // 品牌首页只有一个账号标识，避免错误账号下载。
      if (await page.getByText(account, { exact: true }).count() !== 1) throw Error('operating_account_mismatch');
      // The platform keeps report iframes mounted after opening finance pages.
      // Their URL and document.visibilityState do not prove the report is active.
      if (page.openOperatingReport || !page.frames().some(frame => frame.url().includes('/bizdata_pc/report/download'))) {
        state.operation = 'open_report_navigation'; persist();
        if(page.openOperatingReport){await page.bringToFront();await page.openOperatingReport();}
        else {
        const entry = page.getByText('报表下载', { exact: true }).filter({ visible: true });
        // The navigation is a toggle: clicking an already-open group hides its children.
        if (!await entry.count()) {
          const menu=page.getByText('经营罗盘', { exact: false }).filter({ visible: true });
          await menu.hover();
          // Hover menus need an animation/render turn before deciding whether a click is needed.
          for(let attempt=0;attempt<10&&!await entry.count();attempt++)await pause(100);
          if(!await entry.count())await menu.click();
        }
        await entry.waitFor({ state: 'visible', timeout: 15000 });
        await entry.click();
        }
      }
      const frame = await reportFrame(page);
      if (state.phase === 'new') {
        state.operation = 'read_export_baseline'; persist();
        await frame.getByText('下载列表', { exact: true }).filter({visible:true}).click();
        state.operation = 'wait_download_heading'; persist();
        await frame.getByText('文件名称', { exact: true }).filter({visible:true}).waitFor({ state: 'visible', timeout: 30000 });
        state.operation = 'read_download_rows'; persist();
        state.baseline = (await listJobs(frame,prefix)).map(job => job.name);
        state.operation = 'open_report_tab'; persist();
        await frame.getByText('报表下载', { exact: true }).filter({visible:true}).click();
        state.operation = 'select_report_type'; persist();
        await frame.locator('span.tab-text').filter({visible:true,hasText:report?/^商品$/:/^门店$/}).click();
        state.operation = 'wait_date_inputs'; persist();
        const inputs = frame.locator('input[type="text"]').filter({ visible: true });
        await inputs.nth(0).waitFor({ state: 'visible', timeout: 30000 });
        if (await inputs.count() !== 2) throw Error('operating_date_inputs_ambiguous');
        state.operation = 'select_initial_date'; persist();await selectOperatingDate(frame, date);
        state.operation = 'configure_report_fields'; persist();
        state.configuration = await prepare(frame, { from: date, ...(explicitStoreSelection?{storeIds:expectedStoreIds}:{}) });
        // Changing the platform scope/metrics resets Roo's date range to yesterday.
        // Commit the requested date last, after all other report settings.
        state.operation = 'select_final_date'; persist();await selectOperatingDate(frame, date);
        state.expected_store_ids = expectedStoreIds; state.phase = 'export_pending'; state.export_started_at = new Date().toISOString(); persist();
        state.operation = 'submit_export';persist();await frame.getByRole('button', { name: '下载数据', exact: true }).filter({ visible: true }).click();
        state.operation = 'confirm_export';persist();
        await frame.getByRole('button', { name: '前往下载', exact: true }).filter({visible:true}).waitFor({ state: 'visible', timeout: 30000 });
        await frame.getByRole('button', { name: '前往下载', exact: true }).filter({visible:true}).click();
      }
      state.operation = 'find_export_job'; persist();
      await findJob(frame, state, persist, prefix, report?.validateJob||validateJobFilename);
      if(page.captureSupported!==false)await page.screenshot({ path: path.join(directory, 'download-list.png'), fullPage: true });
      const file = path.join(directory, report?'product.csv':'operating.csv');
      state.operation = 'receive_download'; persist();
      await page.bringToFront();
      const result = await downloadFile(frame, { downloadPage: page, filename: state.job_name, from: date, account, scope:scopeName,
        expectedStoreIds, targetPath: file, timeoutMs: 60000 });
      state.file = path.relative(root, file); state.sha256 = result.validation.sha256; state.phase = 'downloaded'; persist();
    }
    const file = path.resolve(root, state.file);
    if (!file.startsWith(path.resolve(directory) + path.sep) || fs.realpathSync(file) !== file) throw Error('operating_archive_path_invalid');
    const parsed = parseFile(file, { from: date, expectedStoreIds });
    if (parsed.sha256 !== state.sha256) throw Error('operating_archive_hash_changed');
    if (report && downloadOnly !== true && downloadOnly !== 'true')throw Error('product_cloud_upload_not_configured');
    if (report) { const {rows,...receipt}=parsed; return {...receipt,phase:'downloaded',date,file:state.file,uploaded:false}; }
    if (downloadOnly === true || downloadOnly === 'true') return { ok: true, phase: 'downloaded', date,
      row_count: parsed.row_count, store_count: parsed.store_count, income_cents: parsed.income_cents,
      gross_cents: parsed.gross_cents, order_count: parsed.order_count, totals_complete: parsed.totals_complete,
      blank_metric_counts: parsed.blank_metric_counts, sha256: parsed.sha256, file: state.file, uploaded: false };
    state.phase = 'import_pending'; persist();
    const result = await apiClient.call(root, '/api/internal/syncbot/meituan-delivery/import', { business_date: date,
      file_name: state.job_name.replaceAll(' ', '+') + '.csv', sha256: parsed.sha256, data: fs.readFileSync(file).toString('base64') });
    if (result.verification?.all_fields_verified !== true || result.verification.row_count !== parsed.row_count
      || result.verification.income_cents !== parsed.income_cents || result.verification.gross_cents !== parsed.gross_cents
      || result.verification.order_count !== parsed.order_count) throw Error('operating_server_verification_mismatch');
    state.phase = 'completed'; state.batch_id = result.batch_id; state.verification = result.verification;
    state.completed_at = new Date().toISOString(); delete state.error; persist();
    return { ok: true, report_type: contract.reportType, date, phase: state.phase, batch_id: result.batch_id, reused: result.reused, verification: result.verification };
  } catch (error) {
    state.error = /^[a-z][a-z0-9_:.-]{0,150}$/.test(error.message) ? error.message : 'operating_browser_failed'; persist();
    if(page)await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
    throw Object.assign(Error(state.error), { cause: error,operation:state.operation,trace:error.trace||[] });
  }
}
module.exports = { runOperating, listJobs, reportFrame };
