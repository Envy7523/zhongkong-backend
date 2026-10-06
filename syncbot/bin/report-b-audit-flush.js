#!/usr/bin/env node
'use strict';
/** 仅补送已有 B outbox 事件，绝不生成新事件或触发业务流程。 */
process.env.SYNCBOT_REPORT_B_MANUAL_CATCHUP = '1';
const OUTBOX = require('../src/phase3/audit-outbox');

async function main(argv = process.argv.slice(2)) {
  const dateArg = argv.find((x) => /^--date=/.test(x));
  const confirm = argv.includes('--confirm-flush-only');
  if (!dateArg || argv.length !== (confirm ? 2 : 1)
    || argv.some((x) => x !== dateArg && x !== '--confirm-flush-only'))
    return { ok: false, reason: 'usage: --date=YYYY-MM-DD [--confirm-flush-only]' };
  const date = dateArg.slice(7);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, reason: 'business_date_invalid' };
  const ctx = { platform: 'meituan', reportType: 'item_sales_detail', businessDate: date };
  if (!confirm) return { ok: true, dry_run: true, business_date: date, pending: OUTBOX.pendingCount(ctx) };
  const result = await OUTBOX.flush({ ctx });
  return { ok: result.ok, business_date: date, attempted: result.attempted,
    delivered: result.delivered, failed: result.failed,
    reasons: result.details.filter((d) => !d.ok).map((d) => d.reason).slice(0, 5) };
}

if (require.main === module) main().then((r) => {
  console.log(JSON.stringify(r));
  if (!r.ok) process.exitCode = 1;
}).catch(() => { console.error(JSON.stringify({ ok: false, reason: 'audit_flush_exception' })); process.exitCode = 1; });

module.exports = { main };
