'use strict';
const fs = require('fs');
const path = require('path');
const api = require('./api');
const { plainDate, parseOperatingFile } = require('./operating-file');
const { prepareOperatingReport, downloadOperatingJob, validateJobFilename } = require('./operating-download');
const contract = require('./operating-contract');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function write(file, data) { const temp = file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); }
async function reportFrame(page) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const frame = page.frames().find(item => {
      try { const url = new URL(item.url()); return url.origin === 'https://waimaieapp.meituan.com' && url.pathname === '/bizdata_pc/report/download'; } catch { return false; }
    });
    if (frame) return frame;
    await pause(1000);
  }
  throw Error('operating_report_frame_missing');
}
async function listJobs(frame) {
  await frame.getByText(/正在加载/).filter({ visible: true }).waitFor({ state: 'hidden', timeout: 30000 });
  return frame.locator('tr').filter({ visible: true }).evaluateAll(elements => elements.map(el => {
    const cells = el.querySelectorAll('td'); return { name: cells[0]?.textContent.trim() || '', time: cells[1]?.textContent.trim() || '', operation: cells[2]?.textContent.trim() || '' };
  }).filter(row => row.name.startsWith('门店_')));
}
async function findJob(frame, state, persist) {
  await frame.getByText('下载列表', { exact: true }).click();
  await frame.getByText('文件名称', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const rows = await listJobs(frame);
    const jobs = rows.filter(row => {
      try { validateJobFilename(row.name, { from: state.date, account: state.account }); }
      catch { return false; }
      return state.job_name ? row.name === state.job_name : !state.baseline.includes(row.name);
    });
    if (jobs.length > 1) throw Error('operating_export_job_ambiguous');
    if (jobs.length === 1) {
      if (!state.job_name) { state.job_name = jobs[0].name; state.phase = 'job_created'; persist(); }
      if (jobs[0].operation === '下载') return state.job_name;
      if (/失败/.test(jobs[0].operation)) throw Error('operating_export_failed');
    }
    await pause(5000); await frame.getByText('刷新', { exact: true }).click();
  }
  throw Error('operating_export_pending');
}
async function runOperating({ page, context, root, date, account = process.env.MEITUAN_DELIVERY_ACCOUNT, downloadOnly = false }) {
  if (plainDate(date) !== date || typeof account !== 'string' || !/^[A-Za-z0-9_-]+$/.test(account)) throw Error('operating_run_parameters_invalid');
  const directory = path.join(root, 'downloads/meituan_delivery/meituan_delivery_operating', date);
  const stateDir = path.join(root, 'state/tasks/meituan_delivery/meituan_delivery_operating');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(stateDir, date + '.json');
  let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { date, account, phase: 'new', started_at: new Date().toISOString() };
  if (state.date !== date || state.account !== account) throw Error('operating_prior_state_mismatch');
  const persist = () => write(stateFile, state);
  try {
    const scope = await api.call(root, '/api/internal/syncbot/meituan-delivery/scope');
    const expectedStoreIds = scope.bindings.map(row => row.platform_id);
    if (!state.file) {
      if (await page.locator('input[type="password"]').isVisible().catch(() => false)) throw Error('operating_human_login_required');
      await page.setViewportSize({ width: 1440, height: 1000 });
      // 品牌首页只有一个账号标识，避免错误账号下载。
      if (await page.getByText(account, { exact: true }).count() !== 1) throw Error('operating_account_mismatch');
      if (!page.frames().some(frame => frame.url().includes('/bizdata_pc/report/download'))) {
        await page.getByText('经营罗盘', { exact: false }).click();
        await page.getByText('报表下载', { exact: true }).click();
      }
      const frame = await reportFrame(page);
      if (state.phase === 'new') {
        await frame.getByText('下载列表', { exact: true }).click();
        await frame.getByText('文件名称', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
        state.baseline = (await listJobs(frame)).map(job => job.name);
        await frame.getByText('报表下载', { exact: true }).click();
        const inputs = frame.locator('input[type="text"]').filter({ visible: true });
        await inputs.nth(0).waitFor({ state: 'visible', timeout: 30000 });
        if (await inputs.count() !== 2) throw Error('operating_date_inputs_ambiguous');
        for (let index = 0; index < 2; index++) { await inputs.nth(index).fill(date); await inputs.nth(index).press('Tab'); }
        state.configuration = await prepareOperatingReport(frame, { from: date });
        state.expected_store_ids = expectedStoreIds; state.phase = 'export_pending'; state.export_started_at = new Date().toISOString(); persist();
        await frame.getByRole('button', { name: '下载数据', exact: true }).filter({ visible: true }).click();
        await frame.getByRole('button', { name: '前往下载', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
        await frame.getByRole('button', { name: '前往下载', exact: true }).click();
      }
      await findJob(frame, state, persist);
      await page.screenshot({ path: path.join(directory, 'download-list.png'), fullPage: true });
      const file = path.join(directory, 'operating.csv');
      const result = await downloadOperatingJob(frame, { downloadPage: page, filename: state.job_name, from: date, account,
        expectedStoreIds, targetPath: file, timeoutMs: 60000 });
      state.file = path.relative(root, file); state.sha256 = result.validation.sha256; state.phase = 'downloaded'; persist();
    }
    const file = path.resolve(root, state.file);
    if (!file.startsWith(path.resolve(directory) + path.sep) || fs.realpathSync(file) !== file) throw Error('operating_archive_path_invalid');
    const report = parseOperatingFile(file, { from: date, expectedStoreIds });
    if (report.sha256 !== state.sha256) throw Error('operating_archive_hash_changed');
    if (downloadOnly === true || downloadOnly === 'true') return { ok: true, phase: 'downloaded', date, row_count: report.row_count };
    state.phase = 'import_pending'; persist();
    const result = await api.call(root, '/api/internal/syncbot/meituan-delivery/import', { business_date: date,
      file_name: state.job_name.replaceAll(' ', '+') + '.csv', sha256: report.sha256, data: fs.readFileSync(file).toString('base64') });
    if (result.verification?.all_fields_verified !== true || result.verification.row_count !== report.row_count
      || result.verification.income_cents !== report.income_cents || result.verification.gross_cents !== report.gross_cents
      || result.verification.order_count !== report.order_count) throw Error('operating_server_verification_mismatch');
    state.phase = 'completed'; state.batch_id = result.batch_id; state.verification = result.verification;
    state.completed_at = new Date().toISOString(); delete state.error; persist();
    return { ok: true, report_type: contract.reportType, date, phase: state.phase, batch_id: result.batch_id, reused: result.reused, verification: result.verification };
  } catch (error) {
    state.error = /^[a-z][a-z0-9_:.-]{0,150}$/.test(error.message) ? error.message : 'operating_browser_failed'; persist();
    await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
    throw Error(state.error);
  }
}
module.exports = { runOperating, listJobs, reportFrame };
