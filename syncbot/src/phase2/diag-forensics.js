'use strict';
/** 纯只读取证：本次真实导出文件 + 审计 + 目录归属 + 状态/截图缺失定位（不改任何东西） */
const fs = require('fs');
const path = require('path');
const P = require('../paths');
const V = require('./report-a-file-validate');
const config = require('../config');

const FILE = '/opt/zhongkong-sync-bot/downloads/meituan/_incoming/鹅太公_综合营业统计_20260919_0003_1789747388617.xlsx';
const AUDIT = '/opt/zhongkong-sync-bot/state/downloads-meituan.jsonl';
const out = {};

// ---------- 1. 原始文件只读分析 ----------
const st = fs.statSync(FILE);
out.file = { path: FILE, size: st.size, mtime: st.mtime.toISOString(), sha256: V.archiveNameNoOverwrite ? null : null };
out.file.sha256 = (() => { const c = require('crypto'); return c.createHash('sha256').update(fs.readFileSync(FILE)).digest('hex'); })();

const XLSX = require('xlsx');
const wb = XLSX.readFile(FILE, { cellDates: false });
const names = wb.SheetNames;
const ws = wb.Sheets[names.includes('综合营业统计') ? '综合营业统计' : names[0]];
const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
out.sheets = names;
out.row1 = (grid[0] || []).map(String).join(' ').slice(0, 200);
out.row2_raw = (grid[1] || []).map((x) => String(x === undefined || x === null ? '' : x)).filter(Boolean).join(' | ');
out.row3_identity_header = (grid[2] || []).map((x) => String(x)).slice(0, 14);
// 业务日期列：在 row3 找「营业日期」列索引
const hdr = (grid[2] || []).map((x) => String(x).replace(/\s+/g, ''));
const bdCol = hdr.findIndex((x) => x === '营业日期');
const nameCol = hdr.findIndex((x) => x === '门店名称');
out.business_date_column = { col_index: bdCol, header: bdCol >= 0 ? '营业日期' : null };
const storeRows = [];
let totalRow = null;
for (let i = 3; i < grid.length; i += 1) {
  const cells = (grid[i] || []).map((x) => String(x === undefined || x === null ? '' : x).replace(/\s+/g, ' ').trim());
  if (cells.some((c) => /^合计|^总计|^汇总/.test(c))) { totalRow = cells; break; }
  if (!cells.some((c) => c)) continue;
  if (!String(cells[nameCol] || '').trim()) continue;
  storeRows.push(cells);
}
out.store_count = storeRows.length;
out.store_names = storeRows.map((r) => (nameCol >= 0 ? r[nameCol] : '')).filter(Boolean);
out.business_dates_in_rows = Array.from(new Set(storeRows.map((r) => (bdCol >= 0 ? r[bdCol] : '')).filter(Boolean)));
out.total_row = totalRow ? { head: totalRow.slice(0, 12), has_heji: /^合计/.test(totalRow[0] || '') } : null;
out.business_date_rows_matching_target = out.business_dates_in_rows.includes('2026/09/17');

// 映射同源性
try {
  const m = JSON.parse(fs.readFileSync('/opt/zhongkong-sync-bot/config/store-mapping.json', 'utf8')).mappings || {};
  const expected = Object.keys(m).filter((k) => m[k] && m[k].confirmed === true);
  out.mapping = { expected_count: expected.length, missing: expected.filter((x) => !out.store_names.includes(x)), extra: out.store_names.filter((x) => !expected.includes(x)) };
} catch (e) { out.mapping = { error: e.message }; }

// 按「目标业务日期 2026-09-17」与「文件实际日期」分别跑校验
out.validation_by_target_date = (() => { const r = V.validateReportAFile(FILE, { businessDate: '2026-09-17', expectedStores: 22, expectedStoreNames: out.store_names }); return { ok: r.ok, errors: r.errors, checks: Object.fromEntries(Object.entries(r.checks).map(([k, v]) => [k, { ok: v.ok, detail: v.detail }])) }; })();
out.validation_by_file_date = (() => { const d = (out.business_dates_in_rows[0] || '').replace(/\//g, '-'); const r = V.validateReportAFile(FILE, { businessDate: d || '2026-09-17', expectedStores: out.store_count, expectedStoreNames: out.store_names }); return { businessDate_used: d, ok: r.ok, errors: r.errors }; })();

// ---------- 2. 审计只读分析 ----------
const lines = fs.readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
out.audit_count = lines.length;
const last = lines[lines.length - 1];
out.audit_last = { at: last.at, event: last.event, file: last.archived_filename, size: last.size, sha256: last.sha256, dir: last.archive_dir, received_from: last.received_from || null, note: last.note };
out.audit_dirs_used = Array.from(new Set(lines.map((l) => l.archive_dir)));

// 编排层是否有 download click：查 host 审计中本次 task 的 click purpose
const hostAudit = fs.readFileSync('/opt/zhongkong-sync-bot/state/host-audit-meituan.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const t0 = Date.parse('2026-09-18T16:00:00Z'), t1 = Date.parse('2026-09-18T16:05:00Z');
out.clicks_in_window = hostAudit.filter((a) => a.cmd === 'click' && a.at >= '2026-09-18T16:00:00Z' && a.at <= '2026-09-18T16:05:00Z').map((a) => ({ at: a.at, purpose: a.args && a.args.purpose }));
out.download_click_count = out.clicks_in_window.filter((c) => ['download', 'export'].includes(c.purpose)).map((c) => c.purpose);
out.all_purposes_in_window = Array.from(new Set(out.clicks_in_window.map((c) => c.purpose)));
out.audit_line4_at = last.at;
out.export_click_at = (out.clicks_in_window.find((c) => c.purpose === 'export') || {}).at || null;
out.ordering = { export_click_at: out.export_click_at, download_saved_at: out.audit_line4_at, download_saved_before_export_click: !!(out.export_click_at && out.audit_line4_at < out.export_click_at) };

// ---------- 3. 目录归属优先级链 ----------
out.dir_chain = {
  browser_config_downloadDir: (() => { try { return config.load('browser.config').downloadDir; } catch (e) { return `ERR ${e.message}`; } })(),
  paths_incoming_meituan_shared: P.platformDownloads('meituan') + '/_incoming',
  paths_incoming_per_report: P.incoming('meituan', 'cashier_composite'),
  platformDownloads: P.platformDownloads('meituan'),
};
out.systemd_exec = fs.readFileSync('/etc/systemd/system/syncbot-browser.service', 'utf8').split('\n').filter((l) => l.startsWith('ExecStart=') || l.startsWith('Environment')).join(' || ');
try { out.runtime_browser_state = JSON.parse(fs.readFileSync(path.join(P.runtime, 'browser-meituan.json'), 'utf8')); } catch (e) { out.runtime_browser_state = { error: e.message }; }
try { const cfg = JSON.parse(fs.readFileSync('/opt/zhongkong-sync-bot/config/browser.config.json', 'utf8')); out.browser_config_raw = { downloadDir: cfg.downloadDir, keys: Object.keys(cfg) }; } catch (e) { out.browser_config_raw = { error: e.message }; }

// ---------- 4. task state / 截图 缺失定位 ----------
const tf = '/opt/zhongkong-sync-bot/state/tasks/meituan/cashier_composite/2026-09-17.json';
out.task_state = { path: tf, exists: fs.existsSync(tf) };
if (out.task_state.exists) { const o = JSON.parse(fs.readFileSync(tf, 'utf8')); out.task_state.keys = Object.keys(o); out.task_state.has_real_download = !!o.real_download; out.task_state.download_section = o.download || null; }
out.screenshot_dir = { path: '/opt/zhongkong-sync-bot/screenshots/meituan/cashier_composite/2026-09-17', exists: fs.existsSync('/opt/zhongkong-sync-bot/screenshots/meituan/cashier_composite/2026-09-17') };
if (out.screenshot_dir.exists) out.screenshot_dir.files = fs.readdirSync('/opt/zhongkong-sync-bot/screenshots/meituan/cashier_composite/2026-09-17').filter((f) => f.includes('real-mu75auzr'));
out.screenshot_dir.any_for_real_task_runs = out.screenshot_dir.files || [];
// 入口 store 绑定证据：源码中 store2 定义位置 vs 使用位置
const runSrc = fs.readFileSync('/opt/zhongkong-sync-bot/app/src/phase2/real-download-run.js', 'utf8');
out.entrypoint_store = {
  defines_orch_with_empty_store: /store: \{ load: \(\) => null, save: \(\) => \{\} \}/.test(runSrc),
  defines_store2: /const store2 = \{/.test(runSrc),
  uses_orch2: /orch2\.run\(/.test(runSrc),
  orch_run_calls: (runSrc.match(/\.run\(\{ applicant/g) || []).length,
};

console.log(JSON.stringify(out, null, 2));
