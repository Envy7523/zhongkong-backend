'use strict';
const fs = require('fs');
const crypto = require('crypto');
const P = require('../paths');
const IC = require('./import-client');
const V = require('../phase2/report-c-file-validate');
function createReviewClient({ request = IC.defaultRequest, secretsFile, timeoutMs = 30000 } = {}) {
  let auth;
  async function token() {
    if (auth) return auth;
    const s = IC.loadImporterSecrets({ file: secretsFile });
    if (!s.ok) throw new Error(s.reason);
    const base = s.baseUrl || IC.DEFAULT_BASE_URL;
    if (!IC.assertLoopback(base).ok) throw new Error('loopback_required');
    if (s.token) return (auth = { base, token: s.token });
    const r = await request({ url: base + IC.LOGIN_PATH, method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: s.username, password: s.password }), timeoutMs });
    const body = JSON.parse(r.text || '{}');
    if (r.status !== 200 || !(body.token || body.data?.token)) throw new Error('review_login_failed');
    return (auth = { base, token: body.token || body.data.token });
  }
  async function post(action, body) {
    const a = await token();
    const r = await request({ url: a.base + '/api/bookkeeping/pos-daily-import/review/' + action,
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.token}` },
      body: JSON.stringify(body), timeoutMs });
    let data; try { data = JSON.parse(r.text || '{}'); } catch { throw new Error('review_response_invalid'); }
    if (r.status !== 200 || data.ok !== true) throw new Error(data.error || 'review_request_failed');
    return data;
  }
  async function review({ file, businessDate, reviewKey, adoptLegacy = false } = {}) {
    const dir = fs.realpathSync(P.dayDownloads('meituan', 'pos_bookkeeping_daily', businessDate));
    if (require('path').dirname(fs.realpathSync(file)) !== dir) throw new Error('review_file_outside_archive');
    const v = V.validateReportCFile(file, businessDate);
    if (!v.ok) throw new Error('review_archive_invalid');
    const bytes = fs.readFileSync(file), sha = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sha !== v.sha256) throw new Error('review_archive_changed');
    const body = { business_date: businessDate, data: bytes.toString('base64'), adopt_legacy: adoptLegacy };
    const preview = await post('preview', body);
    if (preview.business_date !== businessDate || preview.file_sha256 !== sha
      || preview.row_count !== v.row_count || preview.total_cents !== v.total_cents
      || !/^[0-9a-f]{64}$/.test(preview.expected_state || '')) throw new Error('review_preview_mismatch');
    const result = await post('commit', { ...body, review_key: reviewKey, expected_state: preview.expected_state,
      expected_sha256: sha, confirm: true, confirm_empty: v.row_count === 0 });
    if (result.row_count !== v.row_count || result.total_cents !== v.total_cents) throw new Error('review_commit_mismatch');
    return { ...result, file_sha256: sha, row_count: v.row_count, business_date: businessDate };
  }
  return { review };
}
module.exports = { createReviewClient };
