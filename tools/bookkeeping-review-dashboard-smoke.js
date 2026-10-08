'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { dashboard } = require('../lib/bookkeeping-review-dashboard');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-review-board-'));
let rows = [], enabled = 1;
const db = { queryOne: () => ({ enabled, run_time: '02:00' }), queryAll: (_, [key, from, to]) => rows.filter(r => r.key === key && r.business_date >= from && r.business_date <= to) };
function manifest(key, value) {
  const dir = path.join(root, key, 'meituan/pos_bookkeeping_daily'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review-manifest.json'), JSON.stringify({ run_key: key, ...value }));
}
try {
  let result = dashboard(db, { root, now: new Date('2026-10-08T00:00:00+08:00') });
  assert.equal(result.daily.status, 'pending'); assert.equal(result.daily.from, '2026-10-01'); assert.equal(result.daily.to, '2026-10-07');
  assert.equal(result.monthly.from, '2026-09-01'); assert.equal(result.monthly.to, '2026-09-30');
  result = dashboard(db, { root, now: new Date('2026-10-08T08:00:00+08:00') });
  assert.equal(result.daily.status, 'missing'); assert.equal(result.monthly.status, 'missing');
  rows = result.daily.details.map((r, i) => ({ key: 'daily-2026-10-08', business_date: r.date, status: i ? 'unchanged' : 'changed', differences_json: i ? '[]' : '[{}]', row_count: 3, checked_at: '2026-10-07T18:10:00Z' }));
  manifest('daily-2026-10-08', { status: 'success', results: [], failed: [] });
  result = dashboard(db, { root, now: new Date('2026-10-08T08:00:00+08:00') });
  assert.equal(result.daily.completed, 7); assert.equal(result.daily.status, 'success'); assert.equal(result.daily.differences, 1);
  rows.pop();
  result = dashboard(db, { root, now: new Date('2026-10-08T08:00:00+08:00') });
  assert.equal(result.daily.status, 'partial'); assert.ok(result.daily.warning);
  manifest('daily-2026-10-08', { status: 'partial', failed: [{ business_date: '2026-10-07', reason: '/secret/path token=private' }] });
  result = dashboard(db, { root, now: new Date('2026-10-08T08:00:00+08:00') });
  assert.equal(result.daily.failed, 1); assert.ok(!JSON.stringify(result).includes('private'));
  rows = []; enabled = 0;
  assert.equal(dashboard(db, { root, now: new Date('2026-11-01T00:00:00+08:00') }).monthly.expected, 31);
  assert.equal(dashboard(db, { root, now: new Date('2026-11-01T00:00:00+08:00') }).daily.status, 'disabled');
  assert.equal(dashboard(db, { root, now: new Date('2028-03-01T00:00:00+08:00') }).monthly.expected, 29);
  console.log('PASS: Beijing dates, seven-day/monthly scopes, confirmed execution, incomplete success warning, failures redacted, disabled plan and leap year');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
