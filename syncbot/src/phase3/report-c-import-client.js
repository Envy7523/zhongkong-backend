'use strict';
/** C 仅消费已归档/已验证原件，走记账本专用接口；不碰 A/B 业务导入接口。 */
const fs = require('fs');
const path = require('path');
const P = require('../paths');
const IC = require('./import-client');
const V = require('../phase2/report-c-file-validate');
const G = require('./report-c-coverage-gates');

const PREVIEW = '/api/bookkeeping/pos-daily-import/preview';
const COMMIT = '/api/bookkeeping/pos-daily-import/commit';

function createReportCImportClient({ coverageClient, request = IC.defaultRequest,
  secretsFile, timeoutMs = 30000 } = {}) {
  if (!coverageClient || typeof coverageClient.bookkeepingCoverage !== 'function'
    || typeof request !== 'function') throw new Error('report_c_import_dependencies_incomplete');
  const calls = { login: 0, preview: 0, commit: 0 };
  const fail = (reason, extra = {}) => ({ ok: false, reason, requests: { ...calls }, ...extra });

  async function token() {
    const secrets = IC.loadImporterSecrets({ file: secretsFile });
    if (!secrets.ok) return { ok: false, reason: secrets.reason };
    const base = secrets.baseUrl || IC.DEFAULT_BASE_URL;
    const safe = IC.assertLoopback(base);
    if (!safe.ok) return { ok: false, reason: safe.reason };
    if (secrets.token) return { ok: true, value: secrets.token, base };
    calls.login += 1;
    let response;
    try { response = await request({ url: base + IC.LOGIN_PATH, method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: secrets.username, password: secrets.password }), timeoutMs }); }
    catch { return { ok: false, reason: 'login_unavailable' }; }
    if (response?.error || response?.status !== 200) return { ok: false, reason: 'login_unavailable' };
    let payload;
    try { payload = JSON.parse(response.text || '{}'); } catch { return { ok: false, reason: 'login_response_invalid' }; }
    const value = payload?.token || payload?.data?.token;
    return value ? { ok: true, value: String(value), base } : { ok: false, reason: 'login_response_invalid' };
  }

  async function post(url, bearer, body) {
    let response;
    try { response = await request({ url, method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body), timeoutMs }); }
    catch { return { ok: false, reason: 'request_outcome_unknown', unknown: true }; }
    if (response?.error) return { ok: false, reason: 'request_outcome_unknown', unknown: true };
    let data;
    try { data = JSON.parse(response.text || '{}'); } catch { return { ok: false, reason: 'response_invalid' }; }
    return { ok: response.status >= 200 && response.status < 300 && data?.ok === true,
      status: response.status, data };
  }

  async function importArchived({ file, businessDate, validation, archiveSha256, confirm = false } = {}) {
    if (confirm !== true) return fail('explicit_confirm_required');
    if (P.REPORT_TYPES.pos_bookkeeping_daily.authorized !== true) return fail('report_c_locked');
    let dayDir;
    try { dayDir = P.dayDownloads('meituan', 'pos_bookkeeping_daily', businessDate); }
    catch { return fail('archive_identity_invalid'); }
    if (path.dirname(path.resolve(String(file || ''))) !== dayDir) return fail('file_outside_archive');
    let actualFile;
    try {
      actualFile = fs.realpathSync(file);
      if (path.dirname(actualFile) !== fs.realpathSync(dayDir)
        || !fs.statSync(actualFile).isFile()) return fail('file_outside_archive');
    } catch { return fail('archive_unreadable'); }
    const fresh = V.validateReportCFile(actualFile, businessDate);
    if (!fresh.ok || validation?.ok !== true || validation.report_type !== fresh.report_type
      || validation.business_date !== businessDate || validation.sha256 !== fresh.sha256
      || archiveSha256 !== fresh.sha256) return fail('archived_file_validation_mismatch');
    let beforeRaw;
    try { beforeRaw = await coverageClient.bookkeepingCoverage({ business_date: businessDate }); }
    catch { return fail('coverage_unavailable'); }
    const before = G.beforeExport(beforeRaw, businessDate);
    if (!before.ok) return fail(before.reason);
    const auth = await token();
    if (!auth.ok) return fail(auth.reason);
    let bytes;
    try { bytes = fs.readFileSync(actualFile); }
    catch { return fail('archive_unreadable'); }
    if (IC.sha256OfBuffer(bytes) !== fresh.sha256) return fail('file_changed_before_request');
    const data = bytes.toString('base64');
    calls.preview += 1;
    const preview = await post(auth.base + PREVIEW, auth.value, { business_date: businessDate, data });
    if (!preview.ok || preview.data?.status !== 'ready' || preview.data?.row_count !== fresh.row_count
      || preview.data?.store_count !== fresh.store_count || preview.data?.total_cents !== fresh.total_cents
      || preview.data?.sha256_prefix !== fresh.sha256.slice(0, 12))
      return fail('preview_not_ready');
    let secondRaw;
    try { secondRaw = await coverageClient.bookkeepingCoverage({ business_date: businessDate }); }
    catch { return fail('coverage_unavailable'); }
    if (!G.beforeExport(secondRaw, businessDate).ok) return fail('coverage_changed_before_commit');
    calls.commit += 1;
    const committed = await post(auth.base + COMMIT, auth.value,
      { business_date: businessDate, data, expected_sha256: fresh.sha256, confirm: true });
    if (!committed.ok || committed.status !== 201 || !Number.isInteger(committed.data?.batch_id))
      return fail('commit_outcome_requires_manual_review', { import_submitted: true });
    let afterRaw;
    try { afterRaw = await coverageClient.bookkeepingCoverage({ business_date: businessDate }); }
    catch { return fail('post_import_reconciliation_failed', { import_submitted: true, batch_id: committed.data.batch_id }); }
    const after = G.afterImport(afterRaw, fresh);
    if (!after.ok || after.batch_id !== committed.data.batch_id)
      return fail('post_import_reconciliation_failed', { import_submitted: true, batch_id: committed.data.batch_id });
    return { ok: true, business_date: businessDate, batch_id: after.batch_id,
      row_count: fresh.row_count, store_count: fresh.store_count, total_cents: fresh.total_cents,
      sha256_prefix: fresh.sha256.slice(0, 12), requests: { ...calls } };
  }
  return { importArchived, calls };
}

module.exports = { PREVIEW, COMMIT, createReportCImportClient };
