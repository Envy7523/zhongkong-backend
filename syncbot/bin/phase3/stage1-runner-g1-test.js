#!/usr/bin/env node
'use strict';

/** Phase 1 G1 回归：仅测真实 production-sync-runner 的既有数据防覆盖分支。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage1-g1-'));
process.env.SYNCBOT_ROOT = root;
const BOT = process.env.SYNCBOT_BOT || path.resolve(__dirname, '../../..');
const RUNNER = require(BOT + '/app/src/phase3/production-sync-runner.js');

const out = { suite: 'stage1-runner-g1-offline', fixture: true, offline: true, checks: [] };
function ck(name, ok, detail) { out.checks.push({ name, ok: !!ok, detail: detail || '' }); }
function coverage(body) { return { coverage: async () => ({ ok: true, body }) }; }
function runner(client, calls) {
  return RUNNER.createRunner({
    env: { SYNCBOT_WORKFLOW_PROD_ADAPTERS: '1' },
    deps: {
      coverageClient: client,
      adapterFactories: {
        download: () => { calls.download += 1; return { run: async () => ({ ok: true }) }; },
        import: () => { calls.import += 1; return { runOnce: async () => ({ ok: true }) }; },
      },
    },
  });
}

(async () => {
  const calls = { download: 0, import: 0 };
  const hit = await runner(coverage({ business_date: '2026-09-21', covered: true, has_records: true }), calls)
    .runOnce({ businessDate: '2026-09-21' });
  ck('g1 covered 唯一路径是 WAITING_HUMAN', hit.action === 'WAITING_HUMAN' && hit.reason === 'coverage_integrity_unverified' && hit.requires_human === true, JSON.stringify(hit));
  ck('g1 covered 零下载、零导入、零推送', calls.download === 0 && calls.import === 0 && hit.push_calls === 0 && hit.stage_calls.download === 0 && hit.stage_calls.import === 0, JSON.stringify(calls));
  const denied = await runner(coverage({ business_date: '2026-09-21', covered: true, has_records: true, provenance: 'unverifiable', safe_to_skip_sync: false, report_eligible: false }), { download: 0, import: 0 })
    .runOnce({ businessDate: '2026-09-21' });
  ck('g1 否决信号也是同一人工分支', denied.action === 'WAITING_HUMAN' && denied.reason === 'coverage_integrity_unverified' && denied.push_calls === 0, JSON.stringify(denied));
  const unavailable = await runner({ coverage: async () => ({ ok: false, reason: 'fixture_down' }) }, { download: 0, import: 0 })
    .runOnce({ businessDate: '2026-09-21' });
  ck('g1 查询失败 fail-closed 且零业务动作', unavailable.ok === false && unavailable.reason.indexOf('g1_coverage_gate_failed') === 0 && unavailable.stage_calls.download === 0 && unavailable.push_calls === 0, JSON.stringify(unavailable));
  const source = fs.readFileSync(BOT + '/app/src/phase3/production-sync-runner.js', 'utf8');
  ck('production 运行时源码不包含已否决的成功原因码或开关', !/coverage_verified_existing|SYNCBOT_G1_VERIFY_EXISTING/.test(source), 'static');
  out.total = out.checks.length;
  out.failed = out.checks.filter((x) => !x.ok).length;
  out.ok = out.failed === 0;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  console.log(JSON.stringify({ suite: out.suite, ok: out.ok, total: out.total, failed: out.failed }));
  process.exit(out.ok ? 0 : 1);
})().catch((e) => { console.log(JSON.stringify({ suite: out.suite, ok: false, fatal: String(e && e.message) })); process.exit(9); });
