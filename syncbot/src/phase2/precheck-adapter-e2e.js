'use strict';
/**
 * 只读端到端预检：**直接调用 production adapter 的 navigateAndQuery**
 *   node src/phase2/precheck-adapter-e2e.js --date=2026-09-17
 * 要求返回 ok=true 且 declared_count >= 1、total_store_count == 本次声明数（动态口径，**不比对任何固定门店数**）；
 * 不导出、不进下载清单、不改 approvals。
 */
const fs = require('fs');
const path = require('path');
const P = require('../paths');
const TC = require('../task-context');
const client = require('./client');
const flow = require('./meituan-flow');
const selectors = require('./selectors');
const config = require('../config');
const { createProductionAdapters } = require('./real-download-adapters');
const { createTaskLogger } = require('../logger');

const args = {};
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); if (m) args[m[1]] = m[2] === undefined ? true : m[2]; }
const BD = String(args.date || '');
if (!/^\d{4}-\d{2}-\d{2}$/.test(BD)) { console.error('用法: node src/phase2/precheck-adapter-e2e.js --date=YYYY-MM-DD'); process.exit(2); }
const TASK_ID = `e2e-${Date.now().toString(36)}`;
const CTX = TC.createContext('cashier_composite', { platform: 'meituan', taskId: TASK_ID, businessDate: BD });
const logger = createTaskLogger('phase2-precheck-adapter-e2e', { reportType: CTX.reportType, platform: CTX.platform, taskId: TASK_ID, businessDate: BD });
const selReg = selectors.load();

(async () => {
  const out = { task_id: TASK_ID, report_type: CTX.reportType, business_date: BD, mode: 'adapter-e2e-readonly', clicked_export: false, visited_download_list: false, downloaded: false, approvals_untouched: true };
  const approvals = { read: async () => ({ export_submit: false, download_list: false, download_file: false }), write: async () => { out.approvals_write_attempted = true; } };
  try {
    const adapters = createProductionAdapters({
      client, flow, approvals, rules: config.load('meituan-rules'),
      selectors: { get: (k) => selectors.get(selReg, k) },
      validateFileFn: async () => ({ ok: true }), archiveFn: async () => ({ file: 'x' }),
      waitForDownloadFile: async () => ({ ok: true, file: 'x' }), incomingDir: P.incoming('meituan', CTX.reportType),
      audit: () => {}, now: () => new Date().toISOString(),
    });
    const r = await adapters.navigateAndQuery({ ctx: CTX });
    out.result = { ok: r.ok, reason: r.reason || null, declared_count: r.declared_count === undefined ? null : r.declared_count, total_store_count: r.total_store_count === undefined ? null : r.total_store_count, total_row_head: r.total_row_head || null };
    out.sequence = (r.steps || []).map((s) => s.name);
    out.step_detail = (r.steps || []).map((s) => ({ name: s.name, at: s.at, extra: Object.fromEntries(Object.entries(s).filter(([k]) => !['name', 'at'].includes(k))) }));
    try { await flow.screenshot(CTX, '90', 'e2e-ok'); out.screenshot = 'captured'; } catch (e) { out.screenshot = `failed: ${e.message}`; }
    const dd = r.declared_dynamic === undefined ? null : r.declared_dynamic;
    const declaredNum = Number.isFinite(Number(r.declared_count)) ? Number(r.declared_count) : null;
    out.ok = r.ok === true && declaredNum !== null && declaredNum >= 1 &&
      (dd === null ? r.total_store_count === r.declared_count : r.total_store_count === dd);
    if (!out.ok) out.fail_reason = r.reason;
  } catch (e) {
    out.ok = false; out.error = e.message;
    try { await flow.screenshot(CTX, '99', 'e2e-failed'); out.screenshot = 'captured-on-failure'; } catch (_) {}
  }
  const dir = path.join(P.state, 'selectors-dump');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `precheck-adapter-e2e-${TASK_ID}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  logger.info('precheck_adapter_e2e.end', { ok: out.ok, declared: out.result && out.result.declared_count, sequence_len: (out.sequence || []).length });
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
})().catch((e) => { console.error('E2E_FATAL', e.message); process.exit(2); });
