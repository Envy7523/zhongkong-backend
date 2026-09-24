#!/usr/bin/env node
'use strict';
// 纯离线：不启动 HTTP、不读生产库、不写任何文件或数据库。
const crypto = require('crypto');
const C = require('../lib/syncbot-coverage');

const secret = 'fixture-secret-at-least-16-chars';
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: String(detail || '') });
const audit = {
  loadSecret: () => secret,
  timestampAcceptable: (ts) => /^\d+$/.test(String(ts)) ? { ok: true } : { ok: false, reason: 'timestamp_missing_or_invalid' },
  verifySignature: ({ secret: s, timestamp, signature, rawBody }) => {
    const expected = crypto.createHmac('sha256', s).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
    const given = Buffer.from(String(signature || ''));
    return { ok: given.length === Buffer.byteLength(expected) && crypto.timingSafeEqual(Buffer.from(expected), given) };
  },
};
function signedReq({ date = '2026-09-21', body = {}, remote = '127.0.0.1', proxy = null, signature = null } = {}) {
  const ts = '1770000000000';
  const raw = Buffer.isBuffer(body) ? body.toString('utf8') : (body && Object.keys(body).length ? JSON.stringify(body) : '');
  const sig = signature === null ? crypto.createHmac('sha256', secret).update(`${ts}.${raw}`, 'utf8').digest('hex') : signature;
  return { query: { business_date: date }, body, socket: { remoteAddress: remote }, get: (name) => {
    const key = String(name).toLowerCase();
    if (key === 'x-syncbot-timestamp') return ts;
    if (key === 'x-syncbot-signature') return sig;
    if (key === 'x-forwarded-for') return proxy || '';
    return '';
  } };
}
function response() { return { code: null, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; }
let reads = 0;
let activeReads = 0;
const db = {
  queryOne(sql, params = []) {
    reads += 1;
    if (/FROM stores/.test(sql)) return { n: 2 };
    return { n: params[0] === '2026-09-20' ? 3 : 0 };
  },
  queryAll(sql) {
    activeReads += 1;
    if (!/status='正常营业'/.test(sql)) throw new Error('unexpected active store query');
    return [{ id: 2, name: '测试店' }, { id: 17, name: '鹅太公烧鹅（湖南宜章店）' }];
  },
};
const handler = C.createCoverageHandler({ db, audit });

let r = response(); handler(signedReq(), r);
check('valid signed empty-body GET returns 200', r.code === 200 && r.body.ok === true, JSON.stringify(r.body));
check('no records never implies safe skip or report eligibility', r.body.has_records === false && r.body.safe_to_skip_sync === false && r.body.report_eligible === false && r.body.provenance === 'none', JSON.stringify(r.body));
check('confirmed stores.status provider returns the exact approved basis', r.body.active_stores.length === 2 && r.body.total_active === 2 && r.body.truncated === false && r.body.active_stores_basis === 'stores.status=正常营业' && r.body.active_stores_basis_confirmed === true && r.body.reason === null, JSON.stringify(r.body));

r = response(); handler(signedReq({ date: '2026-09-20' }), r);
check('existing records remain partially verifiable and never safe to skip', r.code === 200 && r.body.has_records === true && r.body.provenance === 'partially_verifiable' && r.body.safe_to_skip_sync === false && r.body.report_eligible === false, JSON.stringify(r.body));

r = response(); handler(signedReq({ date: '2026-02-30' }), r);
check('invalid calendar date is rejected before database read', r.code === 400 && r.body.reason === 'business_date_invalid' && reads === 4 && activeReads === 2, JSON.stringify(r));

r = response(); handler(signedReq({ proxy: '1.2.3.4' }), r);
check('proxy header is rejected', r.code === 401 && r.body.reason === 'via_proxy_denied', JSON.stringify(r));

r = response(); handler(signedReq({ remote: '10.0.0.1' }), r);
check('non-loopback is rejected', r.code === 401 && r.body.reason === 'not_loopback', JSON.stringify(r));

r = response(); handler(signedReq({ signature: '00' }), r);
check('bad HMAC is rejected', r.code === 401 && r.body.reason === 'signature_mismatch', JSON.stringify(r));

const trustedHandler = C.createCoverageHandler({ db, audit, activeStoresProvider: () => ({ ok: true, active_stores: [{ id: 2, name: '测试店' }], total_active: 1, truncated: false, active_stores_basis: 'approved-fixture-policy', active_stores_basis_confirmed: true }) });
r = response(); trustedHandler(signedReq(), r);
check('explicit confirmed provider is reflected without changing skip semantics', r.code === 200 && r.body.active_stores.length === 1 && r.body.active_stores_basis_confirmed === true && r.body.safe_to_skip_sync === false, JSON.stringify(r.body));

const emptyHandler = C.createCoverageHandler({ db, audit, activeStoresProvider: () => ({ ok: true, active_stores: [], total_active: 0, truncated: false, active_stores_basis: C.ACTIVE_STORES_BASIS, active_stores_basis_confirmed: true }) });
r = response(); emptyHandler(signedReq(), r);
check('legal empty active-store set is preserved and distinct from a query failure', r.code === 200 && Array.isArray(r.body.active_stores) && r.body.active_stores.length === 0 && r.body.total_active === 0 && r.body.active_stores_basis_confirmed === true && r.body.reason === null, JSON.stringify(r.body));

const brokenHandler = C.createCoverageHandler({ db, audit, activeStoresProvider: () => { throw new Error('fixture active-stores failure'); } });
r = response(); brokenHandler(signedReq(), r);
check('active-store query failure returns null rather than pretending the set is empty', r.code === 200 && r.body.active_stores === null && r.body.active_stores_basis_confirmed === false && r.body.reason === 'active_stores_query_failed', JSON.stringify(r.body));

const truncatedHandler = C.createCoverageHandler({ db, audit, activeStoresProvider: () => ({ ok: true, active_stores: [{ id: 2, name: '测试店' }], total_active: 201, truncated: true, active_stores_basis: C.ACTIVE_STORES_BASIS, active_stores_basis_confirmed: true }) });
r = response(); truncatedHandler(signedReq(), r);
check('truncated active-store response remains explicit for syncbot fail-closed handling', r.code === 200 && r.body.truncated === true && r.body.total_active === 201 && r.body.active_stores_basis_confirmed === true, JSON.stringify(r.body));

const missingBasisHandler = C.createCoverageHandler({ db, audit, activeStoresProvider: () => ({ ok: true, active_stores: [{ id: 2, name: '测试店' }], total_active: 1, truncated: false, active_stores_basis: '', active_stores_basis_confirmed: true }) });
r = response(); missingBasisHandler(signedReq(), r);
check('missing active-store basis is returned as unconfirmed rather than trusted', r.code === 200 && r.body.active_stores === null && r.body.active_stores_basis_confirmed === false && r.body.reason === 'active_stores_basis_unconfirmed', JSON.stringify(r.body));

const fakeApp = { uses: [], gets: [], use(...x) { this.uses.push(x); }, get(...x) { this.gets.push(x); } };
const fakeExpress = { raw: (x) => ({ kind: 'raw', x }) };
C.mountCoverage({ app: fakeApp, express: fakeExpress, db, audit });
check('mount registers only one raw parser and one GET route', fakeApp.uses.length === 1 && fakeApp.gets.length === 1 && fakeApp.gets[0][0] === C.PATH, JSON.stringify({ uses: fakeApp.uses.length, gets: fakeApp.gets.length }));

const failed = checks.filter((x) => !x.ok).length;
console.log(JSON.stringify({ suite: 'syncbot-coverage-offline', ok: failed === 0, total: checks.length, failed, fixture: true, db_writes: 0 }));
if (failed) { console.log(JSON.stringify(checks.filter((x) => !x.ok), null, 2)); process.exit(1); }
