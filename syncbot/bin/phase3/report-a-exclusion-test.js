#!/usr/bin/env node
'use strict';
// 仅离线：验证“正常营业但未使用公司收银系统”的报表 A 专属排除规则。
const fs = require('fs');
const path = require('path');
const BOT = process.env.SYNCBOT_BOT || path.resolve(__dirname, '../../..');
const SMC = require(BOT + '/app/src/phase2/store-mapping-coverage.js');
const cfg = JSON.parse(fs.readFileSync(path.join(BOT, 'config', 'store-mapping.json'), 'utf8'));
const checks = [];
function check(name, ok, detail) { checks.push({ name, ok: !!ok, detail: String(detail || '') }); }

try {
  const ledger = SMC.buildLedger(cfg);
  const excluded = ledger.excluded_ids instanceof Set && ledger.excluded_ids.has(17);
  check('id17 is a confirmed cashier_composite-only exclusion', excluded, JSON.stringify([...ledger.excluded_ids || []]));

  const active = ledger.confirmed.map((x) => ({ id: x.id, name: x.source }));
  active.push({ id: 17, name: '鹅太公烧鹅（湖南宜章店）' });
  // 中控如实返回 stores.status='正常营业'；id=17 的报表 A 专属排除只在 syncbot 台账层发生。
  const coverage = { ok: true, active_stores: active, truncated: false, active_stores_basis: 'stores.status=正常营业', active_stores_basis_confirmed: true };
  const trust = SMC.assessActiveStores(coverage);
  check('confirmed master-store basis is trusted before report-A exclusions are applied', trust.trust === 'trusted' && trust.basis === 'stores.status=正常营业' && trust.basis_confirmed === true, JSON.stringify(trust));
  const cov = SMC.checkCoverage({ ledger, coverage });
  check('id17 does not fail mapping coverage for report A', cov.ok === true && cov.uncovered.length === 0 && cov.excluded_active_stores.some((x) => x.id === 17), JSON.stringify(cov));

  const absent = SMC.computeAbsent({ coverage, fileMappedIds: ledger.confirmed.map((x) => x.id), excludedStoreIds: ledger.excluded_ids });
  check('id17 is not recorded as absent', absent.status === 'known' && !absent.absent.some((x) => x.id === 17), JSON.stringify(absent));

  const seenUnexpectedly = SMC.matchStoreName('鹅太公烧鹅（湖南宜章店）', ledger);
  check('unexpected id17 file row remains unmapped and fail-closed', seenUnexpectedly.ok === false && seenUnexpectedly.reason === 'unknown', JSON.stringify(seenUnexpectedly));
} catch (e) {
  check('suite fatal', false, String((e && e.stack) || e));
}
const failed = checks.filter((x) => !x.ok).length;
console.log(JSON.stringify({ suite: 'report-a-exclusion-offline', ok: failed === 0, total: checks.length, failed, fixture: true, real_task_run: false }));
if (failed) process.exit(1);
