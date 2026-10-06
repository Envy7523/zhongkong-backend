'use strict';
/** 报表A 共享查询流程 · 命令序列契约测试（离线，无网络） */
const QF = require('./report-a-query-flow');
const out = [];
const ck = (n, ok, d) => out.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });
const BD = '2026-09-17';
const CTX = { reportType: 'cashier_composite', platform: 'meituan', taskId: 'seq-test', businessDate: BD };
const RULES = {
  navigation: { home_url: 'h', report_center_url: 'r', entry_url: 'e' },
  saved_query: { display_name: 'done' },
  overlay_dismissal: { allow_click_texts: ['知道了'] },
  report: { expected_store_count: 22 },
  filter_value_checks: { items: [
    { no: 1, key: 'city', group: '门店区域', expect_selected: ['城市'], type: 'checkbox_group' },
    { no: 2, key: 'name', group: '门店区域', expect_selected: ['门店名称'], type: 'checkbox_group' },
    { no: 5, key: 'meal', group: '餐时段统计方式', expect_selected: ['下单时间'], verify_source: 'export_file_row2_query_params' },
    { no: 11, key: 'week', control_text: '星期', expect_value: '全部', type: 'value_control' },
  ] },
};
const S = (k) => ({ 'nav.report_center': '#rc', 'nav.business_report': '#br', 'nav.target_report': '#tr', 'filter.date_start': '#s', 'filter.date_end': '#e', 'action.query': '#q' }[k] || null);

/** 记录**有序**命令序列的 fake */
function harness(omit = {}) {
  const seq = [];
  const rec = (c, a) => { seq.push({ cmd: c, args: a }); };
  const hostCmd = async (c, a) => {
    if (omit[c]) { seq.push({ cmd: c, omitted: true }); return omit[c]; }
    rec(c, a);
    if (c === 'dateRow') return { best: { inputs: [{ placeholder: '开始日期', value: BD.replace(/-/g, '/'), rect: { x: 324, y: 506, w: 90, h: 20 } }, { placeholder: '结束日期', value: BD.replace(/-/g, '/'), rect: { x: 446, y: 506, w: 90, h: 20 } }], block: { form_items: [{ text: '星期 全部', cls: 'W' }, { text: '门店 全部', cls: 'P' }] } } };
    if (c === 'filterState') return { best: { groups: [{ group: '门店区域', checked_texts: ['城市', '门店名称'], determinate: true }] } };
    if (c === 'tableSummary') return { pagination: { declared_count: 22, declared_text: '共 22 条记录' }, total_row: { cells: ['合计', '--', '--', '--', '--', '--', '22', '22', '1'] } };
    return {};
  };
  const client = {
    call: async (c, a) => hostCmd(c, a),
    mouse: async (a) => { if (!omit.mouse) rec('mouse', a); return { ok: true }; },
    picker: async () => (omit.picker ? { best: null } : { best: { distinct_dates: 1, cells: [{ date: BD, rect: { x: 400, y: 600, w: 36, h: 30 }, selector: '#cell' }] } }),
    press: async () => ({ ok: true }),
  };
  const flow = {
    calls: [],
    gotoAndAssert: async (a) => { flow.calls.push('gotoAndAssert'); rec('goto', a); return { ok: true, url: a.url }; },
    dismissOverlays: async (a) => { flow.calls.push('dismissOverlays'); rec('dismissOverlays', a); return { ok: true }; },
    clickSelectorAndVerify: async (a) => { flow.calls.push({ sel: a.selector, purpose: a.purpose }); rec('click:' + a.purpose, { selector: a.selector }); return { ok: true }; },
    clickTextAndVerify: async () => { rec('clickText', {}); return { ok: true }; },
    waitForContent: async () => { rec('waitForContent', {}); return { ok: true }; },
    selectSavedScheme: async () => { rec('selectSavedScheme', {}); return { ok: true, step: 'selected', after: { current_value_title: 'done' } }; },
    screenshot: async () => ({ file: '/x.png' }),
  };
  return { hostCmd, client, flow, seq };
}

(async () => {
  // R1 完整链路 → ok 且序列契约满足
  {
    const h = harness();
    const r = await QF.navigateAndQueryReportA({ client: h.client, flow: h.flow, hostCmd: h.hostCmd, rules: RULES, S, ctx: CTX, expectStores: 22 });
    ck('R1 完整流程 ok=true 且 declared=22 / 合计含22', r.ok === true && r.declared_count === 22 && r.total_store_count === 22, `ok=${r.ok} reason=${r.reason || ''}`);
    ck('R1b 返回 steps 覆盖 12 个关键阶段', (r.steps || []).length === QF.REQUIRED_SEQUENCE.length, JSON.stringify((r.steps || []).map((s) => s.name)));
    let seqOk = true; let seqErr = '';
    try { QF.assertSequence(r.steps); } catch (e) { seqOk = false; seqErr = e.message; }
    ck('R1c 序列契约自校验通过', seqOk, seqErr);
    ck('R1d 阶段顺序与约定一致', JSON.stringify((r.steps || []).map((s) => s.name)) === JSON.stringify(QF.REQUIRED_SEQUENCE), JSON.stringify((r.steps || []).map((s) => s.name)));
    const names = (r.steps || []).map((s) => s.name);
    ck('R1e query_click 早于 table_summary', names.indexOf('query_click') < names.indexOf('table_summary'), `query=${names.indexOf('query_click')} summary=${names.indexOf('table_summary')}`);
    ck('R1f 真实下发了 click(query)', h.seq.some((x) => x.cmd === 'click:query'), JSON.stringify(h.seq.filter((x) => String(x.cmd).startsWith('click')).map((x) => x.cmd)));
  }
  // R2 逐一删除关键动作 → 契约必须失败
  const removals = ['entry', 'nav_report_center', 'nav_target_report', 'select_scheme', 'set_date_range', 'filter_state', 'query_click', 'wait_results', 'table_summary'];
  let allDetected = true; const bad = [];
  for (const name of removals) {
    const full = QF.REQUIRED_SEQUENCE.slice();
    const mutated = full.filter((n) => n !== name).map((n) => ({ name: n }));
    let threw = false;
    try { QF.assertSequence(mutated); } catch (_) { threw = true; }
    if (!threw) { allDetected = false; bad.push(name); }
  }
  ck('R2 删除任一关键动作 → 契约失败', allDetected, bad.length ? `未被发现：${bad.join(',')}` : `已逐一验证 ${removals.length} 项`);

  // R3 顺序错乱 → 契约失败
  {
    const swapped = QF.REQUIRED_SEQUENCE.map((n) => ({ name: n }));
    const i1 = swapped.findIndex((s) => s.name === 'query_click'); const i2 = swapped.findIndex((s) => s.name === 'table_summary');
    const t = swapped[i1]; swapped[i1] = swapped[i2]; swapped[i2] = t;
    let threw = false;
    try { QF.assertSequence(swapped); } catch (_) { threw = true; }
    ck('R3 query_click 与 table_summary 顺序颠倒 → 契约失败', threw, '');
  }
  // R4 缺日期设置 → 流程失败（面板不可用）
  {
    const h = harness({ picker: true });
    const r = await QF.navigateAndQueryReportA({ client: h.client, flow: h.flow, hostCmd: h.hostCmd, rules: RULES, S, ctx: CTX, expectStores: 22 });
    ck('R4 日期面板不可用 → 流程失败且未点查询', r.ok === false && !h.seq.some((x) => x.cmd === 'click:query'), r.reason);
  }
  // R5 **动态模式**：expectStores 为 null ⇒ 跳过固定值比较，改为「自洽校验」
  // 声明总数 20 与合计行门店数 20 自洽 → **通过**（不再与任何固定门店数比较）
  {
    const h = harness({ tableSummary: { pagination: { declared_count: 20 }, total_row: { cells: ['合计', '--', '--', '--', '--', '--', '20', '20'] } } });
    const r = await QF.navigateAndQueryReportA({ client: h.client, flow: h.flow, hostCmd: h.hostCmd, rules: RULES, S, ctx: CTX, expectStores: null });
    ck('R5 动态模式：声明总数=20 且合计行=20 → 自洽通过（declared_dynamic=20）',
      r.ok === true && r.declared_dynamic === 20 && r.total_store_count === 20, `ok=${r.ok} reason=${r.reason || ''} declared_dynamic=${r.declared_dynamic}`);
  }
  // R5b **自洽失败才失败**：声明 22 / 合计行 21 → 失败，且绝不接近导出
  {
    const h = harness({ tableSummary: { pagination: { declared_count: 22 }, total_row: { cells: ['合计', '--', '--', '--', '--', '--', '21', '21'] } } });
    const r = await QF.navigateAndQueryReportA({ client: h.client, flow: h.flow, hostCmd: h.hostCmd, rules: RULES, S, ctx: CTX, expectStores: null });
    ck('R5b 动态模式：声明 22 与合计行门店数 21 不一致 → 失败且不接近导出',
      r.ok === false && /不一致/.test(r.reason) && !h.seq.some((x) => x.cmd === 'click'),
      `ok=${r.ok} reason=${r.reason}`);
  }
  // R5c 合计行不可解析（缺失）⇒ 只记录不拒绝（total_row_parse='unavailable'）
  {
    const h = harness({ tableSummary: { pagination: { declared_count: 21 }, total_row: null } });
    const r = await QF.navigateAndQueryReportA({ client: h.client, flow: h.flow, hostCmd: h.hostCmd, rules: RULES, S, ctx: CTX, expectStores: null });
    ck('R5c 动态模式：合计行不可解析 → 只记录不拒绝（total_row_parse=unavailable）',
      r.ok === true && r.total_row_parse === 'unavailable' && r.declared_dynamic === 21,
      `ok=${r.ok} parse=${r.total_row_parse} reason=${r.reason || ''}`);
  }
  // R5d 动态模式：声明数不可解析（null）⇒ 必须失败（declared >= 1 是硬条件）
  {
    const h = harness({ tableSummary: { pagination: { declared_count: null }, total_row: { cells: ['合计', '--', '1'] } } });
    const r = await QF.navigateAndQueryReportA({ client: h.client, flow: h.flow, hostCmd: h.hostCmd, rules: RULES, S, ctx: CTX, expectStores: null });
    ck('R5d 动态模式：声明总数不可解析 → 失败', r.ok === false && /声明总数/.test(r.reason), r.reason);
  }
  // R6 缺合计行 → 失败
  {
    const h = harness({ tableSummary: { pagination: { declared_count: 22 }, total_row: null } });
    const r = await QF.navigateAndQueryReportA({ client: h.client, flow: h.flow, hostCmd: h.hostCmd, rules: RULES, S, ctx: CTX, expectStores: 22 });
    ck('R6 无合计行 → 失败', r.ok === false && /合计行/.test(r.reason), r.reason);
  }
  // R7 共享性：适配器与 dryrun/precheck 均引用同一共享流程
  {
    const fs = require('fs'); const path = require('path');
    const src = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
    ck('R7 生产适配器引用共享流程', /require\('\.\/report-a-query-flow'\)/.test(src('real-download-adapters.js')) && /navigateAndQueryReportA/.test(src('real-download-adapters.js')), '');
    ck('R7b 适配器不再自带逐步导航/查询实现', !/clickSelectorAndVerify/.test(src('real-download-adapters.js')), '');
    ck('R7c 预检脚本引用共享流程', /report-a-query-flow/.test(src('precheck-set-date.js')), '');
  }

  const ok = out.every((r) => r.ok);
  console.log(JSON.stringify({ ok, total: out.length, failed: out.filter((x) => !x.ok).length, results: out }, null, 2));
  process.exit(ok ? 0 : 1);
})();
