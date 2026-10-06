'use strict';
/**
 * 报表A「导航 → 方案 → 设日期 → 筛选校验 → 点击查询 → 等待结果 → 读取声明数/合计」
 * **单一共享流程**：dryrun / precheck / production adapter 全部调用本函数，禁止各自复制步骤。
 *
 * 返回 {ok, reason, declared_count, declared_dynamic, total_store_count, total_row_parse, steps}；steps 用于**命令序列契约测试**。
 *
 * 期望值来源（动态化）：
 *  - expectStores 显式给定（数字）⇒ **保留原固定值严格比较**（向后兼容既有离线套件）；
 *  - expectStores 为 null/undefined/'' ⇒ **动态模式**：跳过固定值比较，改为
 *    「declared >= 1」且「declared == 合计行解析出的门店数」的**自洽校验**；
 *    合计行不可解析 ⇒ 只记录不拒绝（total_row_parse='unavailable'）。
 *    动态模式下返回 declared_dynamic = 本次声明的有效门店数，供文件校验/导入验收使用。
 * 任一步缺失或返回空值即失败，且本流程**绝不触碰导出按钮 / 下载清单**。
 */
const FC = require('./filter-check');
const DR = require('./date-range');

/**
 * 合计行门店数解析（**纯函数，供各 CLI/流程共用；绝不猜**）。
 * 实测口径：门店数量在合计行中**成对出现**（「营业门店数量 / 门店营业天数」两列同为同一数值），
 * 因此优先取「出现 >= 2 次的同一正整数」；无候选或存在多个不同候选 ⇒ unavailable（只记录不拒绝）。
 * @param {{cells?:Array<string>}|null} tr 合计行对象
 * @param {number|null} declaredNum 本次分页声明总数（可为 null）
 */
function parseTotalRowStoreCount(tr, declaredNum = null) {
  if (!tr) return { value: null, method: 'no_total_row' };
  const cells = (Array.isArray(tr.cells) ? tr.cells : []).map((c) => String(c === undefined || c === null ? '' : c).trim());
  const freq = new Map();
  for (const c of cells) {
    if (!/^\d+$/.test(c)) continue;
    const n = Number(c);
    if (Number.isFinite(n) && n >= 1) freq.set(n, (freq.get(n) || 0) + 1);
  }
  if (!freq.size) return { value: null, method: 'unavailable' };
  const paired = [...freq.entries()].filter(([, c]) => c >= 2).map(([n]) => n);
  const d = (typeof declaredNum === 'number' && Number.isFinite(declaredNum)) ? declaredNum : null;
  if (d !== null && paired.includes(d)) return { value: d, method: 'declared_present_paired' };
  if (paired.length === 1) return { value: paired[0], method: 'paired_numeric_cells' };
  if (paired.length === 0 && freq.size === 1) return { value: [...freq.keys()][0], method: 'single_numeric_cell' };
  return { value: null, method: 'unavailable' };
}

/** 关键阶段顺序（契约测试依据） */
const REQUIRED_SEQUENCE = [
  'entry',            // 入口页
  'dismiss_overlays', // 入口公告弹窗必须先清除（否则拦截导航点击）
  'nav_report_center',
  'nav_business_report',
  'nav_target_report',
  'content_ready',
  'select_scheme',    // 选择 done（须读回验证）
  'set_date_range',   // 完整日期区间（起止均为目标）
  'filter_state',     // 11 项筛选读取 + 校验
  'query_click',      // **必须点击查询**
  'wait_results',     // 等待结果刷新
  'table_summary',    // 读取声明数 / 合计
];
/** 断言 steps 覆盖全部关键阶段且顺序正确；缺失或乱序即抛错 */
function assertSequence(steps) {
  const names = (steps || []).map((s) => s.name);
  const missing = REQUIRED_SEQUENCE.filter((n) => !names.includes(n));
  if (missing.length) throw new Error(`命令序列缺失关键阶段：${missing.join(', ')}`);
  const idx = REQUIRED_SEQUENCE.map((n) => names.indexOf(n));
  for (let i = 1; i < idx.length; i += 1) {
    if (idx[i] <= idx[i - 1]) throw new Error(`命令序列顺序错误：${REQUIRED_SEQUENCE[i - 1]} 必须早于 ${REQUIRED_SEQUENCE[i]}`);
  }
  return true;
}

/**
 * @param {object} deps
 *  client   —— call/mouse/picker/press/... （经 host socket）
 *  flow     —— gotoAndAssert / clickSelectorAndVerify / clickTextAndVerify / dismissOverlays / selectSavedScheme / waitForContent / screenshot
 *  hostCmd  —— (cmd,args) => client.call(cmd,args)（白名单校验在适配器层）
 *  rules, S(key), ctx, expectStores（null/undefined ⇒ 动态模式）
 */
async function navigateAndQueryReportA({ client, flow, hostCmd, rules, S, ctx, expectStores }) {
  const steps = [];
  const step = (name, extra = {}) => steps.push(Object.assign({ name, at: new Date().toISOString() }, extra));
  const fail = (reason) => ({ ok: false, reason, steps });

  const nav = rules.navigation;
  const a1 = await flow.gotoAndAssert({ url: nav.home_url, expectFullUrl: nav.home_url, businessDate: ctx.businessDate, taskId: ctx.taskId, reportType: ctx.reportType, platform: ctx.platform });
  if (!a1 || !a1.ok) return fail('入口页 URL 断言失败');
  step('entry', { url: a1.url });

  await flow.dismissOverlays({ allowTexts: (rules.overlay_dismissal || {}).allow_click_texts || [], maxRounds: 3 });
  step('dismiss_overlays');

  const navSteps = [
    ['nav.report_center', 'nav_report_center', nav.report_center_url, []],
    ['nav.business_report', 'nav_business_report', null, ['营业统计']],
    ['nav.target_report', 'nav_target_report', nav.entry_url, []],
  ];
  for (const [key, nm, url, texts] of navSteps) {
    const sel = S(key);
    if (!sel) return fail(`缺少必需选择器：${key}`);
    const r = await flow.clickSelectorAndVerify({ selector: sel, purpose: 'nav', expectedUrls: url ? [url] : [], expectedTexts: texts, businessDate: ctx.businessDate, taskId: ctx.taskId, reportType: ctx.reportType, platform: ctx.platform });
    if (!r || !r.ok) return fail(`导航失败：${key}`);
    step(nm, { selector: sel });
  }

  const ready = await flow.waitForContent({ texts: ['营业日期', '统计周期'], timeoutMs: 45000, label: 'naq_ready' });
  if (!ready || !ready.ok) return fail('报表页内容未就绪');
  step('content_ready');
  await flow.dismissOverlays({ allowTexts: (rules.overlay_dismissal || {}).allow_click_texts || [], maxRounds: 3 });

  const scheme = await flow.selectSavedScheme(String(rules.saved_query.display_name));
  if (!scheme || !scheme.ok) return fail(`未选择查询方案：${(scheme && (scheme.reason || scheme.step)) || '未知'}`);
  step('select_scheme', { value: (scheme.after && scheme.after.current_value_title) || scheme.scheme });

  // 日期区间（共享受测动作：同一面板连点起止两次）
  const readDates = async () => {
    const dr = await hostCmd('dateRow', { maxLeaf: 40 });
    const ins = (dr && dr.best && dr.best.inputs) || [];
    return { values: ins.map((x) => x.value), inputs: ins, formItems: (dr && dr.best && dr.best.block && dr.best.block.form_items) || [] };
  };
  const targetInput = ctx.businessDate.replace(/-/g, '/');
  const dres = await DR.setDateRangeExact({ client, readDates, startSelector: S('filter.date_start'), targetInput, iso: ctx.businessDate });
  if (!dres.ok) return fail(`营业日期设置失败：${dres.reason}`);
  step('set_date_range', { values: dres.values_after, clicks: dres.clicks.length });

  // 11 项筛选（共享校验模块）
  const fstate = await hostCmd('filterState', { maxGroups: 30 });
  const drow = await readDates();
  const fc = FC.checkFilterItems((rules.filter_value_checks && rules.filter_value_checks.items) || [], {
    groups: (fstate && fstate.best && fstate.best.groups) || [],
    dateRowItems: drow.formItems || [],
  });
  if (!fc.ok) return fail(`页面筛选校验失败：不一致 ${JSON.stringify(fc.mismatches)}；无法读取 ${JSON.stringify(fc.unreadable)}`);
  step('filter_state', { page_checked: fc.page_checked_count, matched: fc.matched });

  // 点击查询（必须）
  const q = S('action.query');
  if (!q) return fail('缺少「查询」按钮选择器');
  let clicked = null;
  try { clicked = await flow.clickSelectorAndVerify({ selector: q, purpose: 'query', businessDate: ctx.businessDate, taskId: ctx.taskId, reportType: ctx.reportType, platform: ctx.platform }); }
  catch (e) { clicked = await flow.clickTextAndVerify({ text: '查询', purpose: 'query', soft: true, businessDate: ctx.businessDate, taskId: ctx.taskId, reportType: ctx.reportType, platform: ctx.platform }); }
  if (!clicked || !clicked.ok) return fail('点击「查询」失败');
  step('query_click', { selector: q });

  // 等待结果刷新（轮询直到出现分页声明数）
  let sum = null; let declaredWait = null;
  for (let i = 0; i < 12; i += 1) {
    await new Promise((r) => setTimeout(r, i === 0 ? 3000 : 2500));
    sum = await hostCmd('tableSummary', {});
    declaredWait = sum && sum.pagination ? sum.pagination.declared_count : null;
    if (declaredWait !== null && declaredWait !== undefined) break;
  }
  step('wait_results', { declared_seen: declaredWait });

  const pag = sum && sum.pagination;
  const tr = sum && sum.total_row;
  const declared = pag ? pag.declared_count : null;
  const declaredNum = (typeof declared === 'number' && Number.isFinite(declared)) ? declared : null;
  // 期望值来源（口径冻结 R2）：expectStores 显式给定 ⇒ 保留原「固定值严格比较」（向后兼容既有套件）；
  // expectStores 为 null/undefined/'' ⇒ 动态模式：跳过固定值比较，改「自洽校验」
  //   declared >= 1 且 declared == 合计行解析出的门店数（合计行不可解析 ⇒ 只记录不拒绝）。
  const dynamicMode = (expectStores === null || expectStores === undefined || expectStores === '');

  const cells = (tr && Array.isArray(tr.cells)) ? tr.cells.map((c) => String(c === undefined || c === null ? '' : c).trim()) : [];
  const parsed = parseTotalRowStoreCount(tr, declaredNum);
  const totalRowParse = parsed.value === null ? 'unavailable' : parsed.method;
  const legacyCells = dynamicMode ? null : cells.filter((c) => c === String(expectStores));
  step('table_summary', {
    declared,
    total_store_count_cells: legacyCells === null ? 0 : legacyCells.length,
    total_row_parse: totalRowParse,
    total_row_parse_detail: parsed.method,
    mode: dynamicMode ? 'dynamic' : 'fixed',
  });

  if (dynamicMode) {
    if (declaredNum === null || declaredNum < 1) {
      return { ok: false, reason: `查询声明总数不可解析或小于 1（declared=${declared}）`, declared_count: declared, declared_dynamic: null, total_row_parse: totalRowParse, steps };
    }
    if (parsed.value !== null && parsed.value !== declaredNum) {
      return { ok: false, reason: `查询声明总数 ${declaredNum} 与合计行解析出的门店数 ${parsed.value} 不一致`, declared_count: declared, declared_dynamic: null, total_row_parse: totalRowParse, steps };
    }
    try { assertSequence(steps); } catch (e) { return { ok: false, reason: `命令序列契约不满足：${e.message}`, declared_count: declared, declared_dynamic: null, steps }; }
    // 本次运行实际声明的有效门店数：**不以任何固定值比较**，作为下游（文件校验/导入验收）的唯一期望值来源。
    // 注：ctx 由 TC.createContext 冻结（Object.freeze），因此只能经返回的运行结果透传。
    return {
      ok: true, declared_count: declared, declared_dynamic: declaredNum,
      total_store_count: declaredNum, total_row_parse: totalRowParse, total_row_parse_detail: parsed.method,
      total_row_head: (tr ? (tr.cells || []) : []).slice(0, 9), steps,
    };
  }

  if (declared !== expectStores) return { ok: false, reason: `查询声明总数 ${declared} ≠ ${expectStores}`, declared_count: declared, declared_dynamic: null, steps };
  if (!tr) return { ok: false, reason: '未找到合计行', declared_count: declared, declared_dynamic: null, steps };
  if (legacyCells.length < 1) return { ok: false, reason: `合计行门店数不含 ${expectStores}`, declared_count: declared, declared_dynamic: null, total_row_head: (tr.cells || []).slice(0, 9), steps };
  try { assertSequence(steps); } catch (e) { return { ok: false, reason: `命令序列契约不满足：${e.message}`, declared_count: declared, declared_dynamic: null, steps }; }

  return { ok: true, declared_count: declared, declared_dynamic: null, total_store_count: expectStores, total_row_head: (tr.cells || []).slice(0, 9), steps };
}

module.exports = { navigateAndQueryReportA, assertSequence, parseTotalRowStoreCount, REQUIRED_SEQUENCE };
