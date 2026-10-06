'use strict';
/**
 * 日期设置预检（**禁止导出/下载/下载清单**）
 *   node src/phase2/precheck-set-date.js --date=2026-09-17
 * 流程：导航 → done → 11 项筛选 → 真实日期控件设置 起止均为 2026/09/17 → 读回校验 → 查询 → 读声明/合计 → 停止
 * 硬约束：不点导出、不触发导出弹窗、不进下载清单、不下载、不改 approvals。
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
const DR = require('./date-range');
const QF = require('./report-a-query-flow');
const { createTaskLogger } = require('../logger');

const args = {};
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); if (m) args[m[1]] = m[2] === undefined ? true : m[2]; }
const BD = String(args.date || '');
if (!/^\d{4}-\d{2}-\d{2}$/.test(BD)) { console.error('用法: node src/phase2/precheck-set-date.js --date=YYYY-MM-DD'); process.exit(2); }
const TARGET = BD.replace(/-/g, '/');
const ISO = BD;
const TASK_ID = `preset-${Date.now().toString(36)}`;
const CTX = TC.createContext('cashier_composite', { platform: 'meituan', taskId: TASK_ID, businessDate: BD });
const logger = createTaskLogger('phase2-precheck-set-date', { reportType: CTX.reportType, platform: CTX.platform, taskId: TASK_ID, businessDate: BD });
const selReg = selectors.load();
const S = (k) => selectors.get(selReg, k);
const rules = config.load('meituan-rules');

(async () => {
  const out = { task_id: TASK_ID, report_type: CTX.reportType, business_date: BD, target_input: TARGET, read_only_except_date: true, clicked_export: false, export_dialog_touched: false, visited_download_list: false, downloaded: false, approvals_untouched: true, screenshots: [] };
  const snap = async (nn, step) => { const rec = await DR.captureScreenshot({ flow, ctx: CTX, nn, step, sink: out.screenshots }); if (!rec.ok) out.screenshot_errors = (out.screenshot_errors || []).concat([rec]); return rec; };
  try {
    // 由共享流程执行「导航→方案→设日期→筛选→点击查询→等待→读取声明数/合计」（与生产适配器同一实现）
    const hostCmd = (cmd, args) => client.call(cmd, args);
    const flowRes = await QF.navigateAndQueryReportA({ client, flow, hostCmd, rules, S, ctx: CTX, expectStores: rules.report.expected_store_count });
    out.flow = flowRes;
    out.declared_count = flowRes.declared_count;
    out.total_store_count = flowRes.total_store_count;
    out.sequence = (flowRes.steps || []).map((s) => s.name);
    if (!flowRes.ok) throw new Error(`共享流程失败：${flowRes.reason}`);
    await snap('07', 'queried-2026-09-17');
    out.ok = true;
    const nav = rules.navigation;
    const a1 = await flow.gotoAndAssert({ url: nav.home_url, expectFullUrl: nav.home_url, businessDate: BD, taskId: TASK_ID, reportType: CTX.reportType, platform: 'meituan', nn: '01', step: 'entry' });
    out.A1 = a1.ok;
    await flow.dismissOverlays({ allowTexts: (rules.overlay_dismissal || {}).allow_click_texts || [], maxRounds: 3 });
    for (const [k, url, texts, nm] of [['nav.report_center', nav.report_center_url, [], '02'], ['nav.business_report', null, ['营业统计'], '03'], ['nav.target_report', nav.entry_url, [], '04']]) {
      const sel = S(k);
      if (!sel) throw new Error(`缺少必需选择器：${k}`);
      const r = await flow.clickSelectorAndVerify({ selector: sel, purpose: 'nav', expectedUrls: url ? [url] : [], expectedTexts: texts, businessDate: BD, taskId: TASK_ID, reportType: CTX.reportType, platform: 'meituan', nn: nm, step: 'nav' });
      if (!r.ok) throw new Error(`导航失败：${k}`);
    }
    const ready = await flow.waitForContent({ texts: ['营业日期', '统计周期'], timeoutMs: 45000, label: 'psd_ready' });
    if (!ready.ok) throw new Error('报表页内容未就绪');
    await flow.dismissOverlays({ allowTexts: (rules.overlay_dismissal || {}).allow_click_texts || [], maxRounds: 3 });
    const scheme = await flow.selectSavedScheme(String(rules.saved_query.display_name));
    out.scheme = { ok: scheme.ok, step: scheme.step, value: scheme.after && scheme.after.current_value_title };
    if (!scheme.ok) throw new Error(`未选择 done：${scheme.reason || scheme.step}`);

    // 以下旧实现已由共享流程取代，保留为死代码（不执行）
    if (false) {
    const readDates = async () => {
      const dr = await client.dateRow({ maxLeaf: 40 }, { timeoutMs: 60000 });
      const ins = (dr && dr.best && dr.best.inputs) || [];
      return { values: ins.map((x) => x.value), inputs: ins, formItems: (dr && dr.best && dr.best.block && dr.best.block.form_items) || [] };
    };
    out.dates_before = (await readDates()).values;
    await snap('05', 'before-date-set');

    const startSel = S('filter.date_start');
    // 单一受测动作：只开面板一次 + 同一面板内连点两次（不得中途再点开始日期输入框）
    const dres = await DR.setDateRangeExact({ client, readDates, startSelector: startSel, targetInput: TARGET, iso: ISO });
    out.date_action = dres;
    out.dates_after = dres.values_after;
    out.date_verified = dres.ok === true;
    const after = await readDates();
    out.formItems_after = after.formItems;
    await snap('06', 'date-set');

    // 11 项筛选复核（共享模块）
    const fstate = await client.filterState({ maxGroups: 30 }, { timeoutMs: 90000 });
    const fc = FC.checkFilterItems((rules.filter_value_checks && rules.filter_value_checks.items) || [], { groups: (fstate && fstate.best && fstate.best.groups) || [], dateRowItems: out.formItems_after || [] });
    out.filter_check = { ok: fc.ok, page_checked: fc.page_checked_count, matched: fc.matched, mismatches: fc.mismatches, unreadable: fc.unreadable, items: fc.results.map((r) => ({ no: r.no, key: r.key, expect: r.expect, actual: r.actual, status: r.status })) };

    // 查询（不含任何导出动作）
    const q = S('action.query');
    if (q) { await client.click(q, 'query', { settleMs: 2500 }, { timeoutMs: 60000 }); }
    await flow.sleep(3000);
    const sum = await client.tableSummary({}, { timeoutMs: 60000 });
    const pag = sum && sum.pagination; const tr = sum && sum.total_row;
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
    await snap('07', 'queried-2026-09-17');
    // 自洽判定：声明数 >= 1；合计行可解析时须与声明数一致（不可解析只记录不拒绝）
    out.ok = !!(out.date_verified && fc.ok && declaredNum !== null && declaredNum >= 1 && out.result.total_row_present &&
      (parsed.value === null || parsed.value === declaredNum));
    }
  } catch (e) {
    out.error = e.message; out.ok = false;
    await snap('99', 'failed');
    logger.error('precheck_set_date.failed', { error: e.message });
  }
  const dir = path.join(P.state, 'selectors-dump');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `precheck-set-date-${TASK_ID}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  logger.info('precheck_set_date.end', { ok: out.ok, dates: out.dates_after, filter_ok: out.filter_check && out.filter_check.ok, declared: out.result && out.result.declared_count });
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
})().catch((e) => { console.error('PRECHECK_SET_DATE_FATAL', e.message); process.exit(2); });
