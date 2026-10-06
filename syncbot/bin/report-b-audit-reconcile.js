#!/usr/bin/env node
'use strict';
/** 仅补 B 的审计记录：默认预览；显式 --confirm-audit-only 才发审计事件。 */
const { record } = require('../src/phase3/report-b-audit-bridge');
const { createZkClient } = require('../src/schedule/zk-client');

async function main(argv = process.argv.slice(2), deps = {}) {
  const dateArg = argv.find((x) => /^--date=/.test(x));
  const confirm = argv.includes('--confirm-audit-only');
  if (!dateArg || argv.length !== (confirm ? 2 : 1)
    || argv.some((x) => x !== dateArg && x !== '--confirm-audit-only'))
    return { ok: false, reason: 'usage: --date=YYYY-MM-DD [--confirm-audit-only]' };
  const date = dateArg.slice(7);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, reason: 'business_date_invalid' };
  const client = deps.coverageClient || createZkClient({});
  return record({ businessDate: date, coverageClient: client, dryRun: !confirm,
    ...(deps.readState ? { readState: deps.readState } : {}),
    ...(deps.outbox ? { outbox: deps.outbox } : {}) });
}

if (require.main === module) main().then((r) => {
  console.log(JSON.stringify(r));
  if (!r.ok) process.exitCode = 1;
}).catch(() => { console.error(JSON.stringify({ ok: false, reason: 'audit_reconcile_exception' })); process.exitCode = 1; });

module.exports = { main };
