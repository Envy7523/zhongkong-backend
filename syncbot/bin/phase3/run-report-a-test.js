#!/usr/bin/env node
'use strict';

/** 薄 CLI 离线套件：只注入 fake runner，不读凭据、不访问网络、不写业务目录。 */
const CLI = require('../run-report-a.js');

const out = { suite: 'run-report-a-cli-offline', fixture: true, offline: true, checks: [] };
function ck(name, ok, detail) { out.checks.push({ name, ok: !!ok, detail: detail || '' }); }

async function invoke(args, result) {
  const lines = [];
  let factoryCalls = 0;
  let runCalls = 0;
  const r = await CLI.runCli(args, {
    out: (line) => lines.push(String(line)),
    runnerFactory: () => {
      factoryCalls += 1;
      return {
        report_type: 'cashier_composite', data_only: true, source: 'app/src/phase3/production-sync-runner.js',
        runOnce: async (input) => { runCalls += 1; return Object.assign({ ok: true, action: 'COMPLETED', reason: 'fixture_ok', side_effects: false, stage_calls: { download: 0, import: 0 }, push_calls: 0, input }, result || {}); },
      };
    },
  });
  return { r, lines, factoryCalls, runCalls };
}

(async () => {
  ck('c1 validDate 只接受真实 YYYY-MM-DD', CLI.validDate('2026-09-21') && !CLI.validDate('2026-02-30') && !CLI.validDate('2026-9-21'));
  for (const [name, args, reason] of [
    ['c2 缺 confirm', ['--date=2026-09-21'], 'confirm_required'],
    ['c3 报表 B', ['--date=2026-09-21', '--report-type=item_sales_detail', '--confirm'], 'report_b_locked'],
    ['c4 无效日期', ['--date=2026-02-30', '--confirm'], 'business_date_invalid'],
    ['c5 未知参数', ['--date=2026-09-21', '--confirm', '--extra=1'], 'unknown_flag:extra'],
  ]) {
    const got = await invoke(args);
    ck(name, got.r.exitCode === 2 && got.factoryCalls === 0 && got.runCalls === 0 && got.r.payload.reason === reason, JSON.stringify(got.r.payload));
  }
  const ok = await invoke(['--date=2026-09-21', '--confirm']);
  const plan = JSON.parse(ok.lines[0]);
  ck('c6 合法调用只经同一 runner factory 与 runOnce', ok.r.exitCode === 0 && ok.factoryCalls === 1 && ok.runCalls === 1 && plan.trigger === 'manual-cli' && plan.stages.join(',') === 'download,archive,validate,g1_g3,import,audit', JSON.stringify({ exit: ok.r.exitCode, calls: [ok.factoryCalls, ok.runCalls], plan }));
  ck('c7 薄 CLI 输出不包含推送或绝对路径', !/webhook|push_calls":(?!0)|[A-Za-z]:\\|\/home\//i.test(ok.lines.join('\n')), ok.lines.join('\n').slice(0, 300));
  const refused = await invoke(['--date=2026-09-21', '--confirm'], { ok: false, action: 'WAITING_HUMAN', reason: 'coverage_integrity_unverified', side_effects: false });
  ck('c8 runner fail-closed 透传为 exit 3，不继续调用', refused.r.exitCode === 3 && refused.runCalls === 1 && refused.r.payload.reason === 'coverage_integrity_unverified' && refused.r.payload.push_calls === 0, JSON.stringify(refused.r.payload));
  out.total = out.checks.length;
  out.failed = out.checks.filter((x) => !x.ok).length;
  out.ok = out.failed === 0;
  console.log(JSON.stringify({ suite: out.suite, ok: out.ok, total: out.total, failed: out.failed }));
  if (!out.ok) console.log(JSON.stringify(out.checks.filter((x) => !x.ok)));
  process.exit(out.ok ? 0 : 1);
})().catch((e) => { console.log(JSON.stringify({ suite: out.suite, ok: false, fatal: String(e && e.message) })); process.exit(9); });
