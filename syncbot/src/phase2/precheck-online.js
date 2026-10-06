'use strict';
/**
 * 只读线上预检（**不点击导出、不进入下载清单、不下载、不改 approvals**）
 *   node src/phase2/precheck-online.js --date=2026-09-17
 * 仅：导航至综合营业统计 → 选择 done → 读 11 项筛选 → 读日期 → 查询 → 读声明总数/合计
 * 失败仅留截图与状态，绝不接近导出按钮。
 */
const fs = require('fs');
const path = require('path');
const P = require('../paths');
const TC = require('../task-context');
const client = require('./client');
const flow = require('./meituan-flow');
const selectors = require('./selectors');
const config = require('../config');
const FC = require('./filter-check');
const QF = require('./report-a-query-flow');
const { createTaskLogger } = require('../logger');

const args = {};
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); if (m) args[m[1]] = m[2] === undefined ? true : m[2]; }
const BD = String(args.date || '');
if (!/^\d{4}-\d{2}-\d{2}$/.test(BD)) { console.error('用法: node src/phase2/precheck-online.js --date=YYYY-MM-DD'); process.exit(2); }
const TASK_ID = `pre-${Date.now().toString(36)}`;
const CTX = TC.createContext('cashier_composite', { platform: 'meituan', taskId: TASK_ID, businessDate: BD });
const logger = createTaskLogger('phase2-precheck-online', { reportType: CTX.reportType, platform: CTX.platform, taskId: TASK_ID, businessDate: BD });
const selReg = selectors.load();
const S = (k) => selectors.get(selReg, k);
const rules = config.load('meituan-rules');

(async () => {
  const out = { task_id: TASK_ID, report_type: CTX.reportType, business_date: BD, read_only: true, clicked_export: false, visited_download_list: false, downloaded: false, approvals_untouched: true };
  const snap = async (nn, step) => { try { const s = await flow.screenshot(CTX, nn, step); out.screenshots = out.screenshots || []; out.screenshots.push(s.file); } catch (_) {} };
  try {
    const nav = rules.navigation;
    const a1 = await flow.gotoAndAssert({ url: nav.home_url, expectFullUrl: nav.home_url, businessDate: BD, taskId: TASK_ID, reportType: CTX.reportType, platform: 'meituan', nn: '01', step: 'entry' });
    out.A1 = { ok: a1.ok, url: a1.url };
    await flow.dismissOverlays({ allowTexts: (rules.overlay_dismissal || {}).allow_click_texts || [], maxRounds: 3 });
    for (const [sel, url, texts, nm] of [[S('nav.report_center'), nav.report_center_url, [], '02'], [S('nav.business_report'), null, ['营业统计'], '03'], [S('nav.target_report'), nav.entry_url, [], '04']]) {
      if (!sel) { out.fail = `缺少必需选择器（${nm}）`; throw new Error(out.fail); }
      const r = await flow.clickSelectorAndVerify({ selector: sel, purpose: 'nav', expectedUrls: url ? [url] : [], expectedTexts: texts, businessDate: BD, taskId: TASK_ID, reportType: CTX.reportType, platform: 'meituan', nn: nm, step: 'nav' });
      if (!r.ok) { out.fail = `导航失败 ${nm}`; throw new Error(out.fail); }
    }
    const ready = await flow.waitForContent({ texts: ['营业日期', '统计周期'], timeoutMs: 45000, label: 'pre_ready' });
    out.content_ready = ready.ok;
    if (!ready.ok) throw new Error('报表页内容未就绪');
    await flow.dismissOverlays({ allowTexts: (rules.overlay_dismissal || {}).allow_click_texts || [], maxRounds: 3 });

    const scheme = await flow.selectSavedScheme(String(rules.saved_query.display_name));
    out.scheme = { ok: scheme.ok, step: scheme.step, after: scheme.after || null };
    if (!scheme.ok) throw new Error(`未选择 done 方案：${scheme.reason || scheme.step}`);

    // 11 项筛选（共享校验模块）
    const fstate = await client.filterState({ maxGroups: 30 }, { timeoutMs: 90000 });
    const drow = await client.dateRow({ maxLeaf: 40 }, { timeoutMs: 60000 });
    const fc = FC.checkFilterItems((rules.filter_value_checks && rules.filter_value_checks.items) || [], {
      groups: (fstate && fstate.best && fstate.best.groups) || [],
      dateRowItems: (drow && drow.best && drow.best.block && drow.best.block.form_items) || [],
    });
    out.filter_check = { ok: fc.ok, page_checked: fc.page_checked_count, matched: fc.matched, mismatches: fc.mismatches, unreadable: fc.unreadable, deferred: fc.deferred, items: fc.results.map((r) => ({ no: r.no, key: r.key, expect: r.expect, actual: r.actual, status: r.status })) };
    await snap('05', 'filters');

    // 日期（只读：读当前控件值；不做写入——本预检不设日期）
    const dates = ((drow && drow.best && drow.best.inputs) || []).map((x) => x.value);
    out.date_values = dates;
    out.date_ok = dates.filter((v) => v === '2026/09/17').length >= 2;

    // 查询（不含导出）
    const q = S('action.query');
    const qc = q ? await client.click(q, 'query', { settleMs: 2500 }, { timeoutMs: 60000 }) : null;
    out.query_click = { ok: !!qc };
    await flow.sleep(3000);
    const sum = await client.tableSummary({}, { timeoutMs: 60000 });
    const pag = sum && sum.pagination;
    const tr = sum && sum.total_row;
    // 动态化（口径冻结）：**不再**把固定 22 当期望值；合计行门店数由本次声明数自洽解析（纯函数共用）
    const declaredNum = (typeof (pag ? pag.declared_count : null) === 'number' && Number.isFinite(pag.declared_count)) ? pag.declared_count : null;
    const parsed = QF.parseTotalRowStoreCount(tr, declaredNum);
    out.result = {
      declared_count: pag ? pag.declared_count : null,
      declared_count_text: pag ? pag.declared_text : null,
      total_row_present: !!tr,
      total_row_store_count_parse: parsed.method,
      total_row_store_count_value: parsed.value,
      total_row_store_count_cells: (parsed.value === null || !tr) ? null : (tr.cells || []).filter((c) => c === String(parsed.value)),
      total_row_head: tr ? (tr.cells || []).slice(0, 9) : null,
    };
    await snap('06', 'queried');

    out.ok = !!(fc.ok && out.date_ok && declaredNum !== null && declaredNum >= 1 && out.result.total_row_present &&
      (parsed.value === null || parsed.value === declaredNum));
  } catch (e) {
    out.error = e.message;
    out.ok = false;
    await snap('99', 'precheck-online-failed');
    logger.error('precheck_online.failed', { error: e.message });
  }
  const dir = path.join(P.state, 'selectors-dump');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `precheck-online-${TASK_ID}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  logger.info('precheck_online.end', { ok: out.ok, filter_ok: out.filter_check && out.filter_check.ok, declared: out.result && out.result.declared_count });
  console.log(JSON.stringify(out, null, 2));
  console.log('DUMP=' + file);
  process.exit(out.ok ? 0 : 1);
})().catch((e) => { console.error('PRECHECK_ONLINE_FATAL', e.message); process.exit(2); });
