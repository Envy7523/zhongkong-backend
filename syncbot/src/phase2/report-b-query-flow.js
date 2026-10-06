'use strict';
/** 报表 B 只负责定位、筛选和查询；绝不触发导出/下载/导入。 */
const DR = require('./date-range');
const RULES = require('../../config/report-b-rules.json');

function selectedFilters(detail) {
  const results = detail && detail.best && detail.best.results;
  if (!Array.isArray(results)) return { ok: false, reason: 'filter_detail_unavailable' };
  const find = label => results.find(r => r.label === label && r.found === true);
  const value = label => {
    const r = find(label);
    const full = r && r.outline && r.outline[0] && r.outline[0].full_text;
    return typeof full === 'string' ? full.replace(/\s+/g, '').replace(label.replace(/\s+/g, ''), '') : null;
  };
  if (value('品项类型') !== RULES.item_type) return { ok: false, reason: 'item_type_mismatch' };
  if (value('菜品类型') !== RULES.dish_type) return { ok: false, reason: 'dish_type_mismatch' };
  if (value('门店') !== '全部高级') return { ok: false, reason: 'store_selection_mismatch' };
  const sales = find('销售方式');
  if (!sales || !Array.isArray(sales.outline)) return { ok: false, reason: 'sales_mode_unavailable' };
  const labels = sales.outline.filter(n => n.tag === 'label' && /saas-checkbox-wrapper-checked/.test(n.cls || ''))
    .map(n => String(n.full_text || '').trim()).sort();
  const checked = sales.outline.filter(n => n.tag === 'input' && n.checked === true).length;
  if (checked !== 2 || JSON.stringify(labels) !== JSON.stringify([...RULES.sales_modes].sort()))
    return { ok: false, reason: 'sales_mode_mismatch' };
  return { ok: true, item_type: RULES.item_type, dish_type: RULES.dish_type,
    store_selection: '全部', sales_modes: [...RULES.sales_modes] };
}

async function navigateAndQueryReportB({ client, businessDate }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate || '')))
    return { ok: false, reason: 'business_date_invalid' };
  const steps = [];
  const fail = reason => ({ ok: false, reason, steps });
  const go = await client.goto(RULES.page_url, { settleMs: 1800 });
  const url = await client.url();
  if (!go || !url || url.url !== RULES.page_url) return fail('report_b_url_mismatch');
  steps.push('page_url');
  // 报表 iframe 在 goto 完成后仍可能短暂显示空壳；只读等待标题，不二次导航。
  let titleSeen = false;
  for (let i = 0; i < 12; i += 1) {
    const page = await client.pageText({ maxChars: 3000 });
    if (page && String(page.text || '').includes(RULES.page_title)) { titleSeen = true; break; }
    if (i < 11) await new Promise(resolve => setTimeout(resolve, 1500));
  }
  if (!titleSeen) return fail('report_b_title_missing');
  steps.push('page_title');

  const target = businessDate.replace(/-/g, '/');
  const readDates = async () => {
    const inputs = (await client.dateInputs()).filter(x => x.visible && /^(开始日期|结束日期)$/.test(x.placeholder || ''));
    return { inputs, values: inputs.map(x => x.value) };
  };
  let dates = await readDates();
  if (dates.inputs.length !== 2) return fail('date_inputs_unavailable');
  if (dates.values[0] !== target || dates.values[1] !== target) {
    const selected = await DR.setDateRangeExact({ client, readDates,
      startSelector: dates.inputs[0].selector, targetInput: target, iso: businessDate });
    if (!selected.ok) return fail('date_selection_failed:' + selected.reason);
    dates = await readDates();
  }
  if (dates.values[0] !== target || dates.values[1] !== target) return fail('date_readback_mismatch');
  steps.push('date_exact');

  const detail = await client.filterDetail({ labels: ['品项类型', '菜品类型', '门店', '销售方式'], maxDepth: 10, maxNodes: 160 });
  const filters = selectedFilters(detail);
  if (!filters.ok) return fail(filters.reason);
  steps.push('filters_checked');

  const found = await client.probe([RULES.query_button], { maxPerText: 5 });
  const buttons = (found && found.merged && found.merged[RULES.query_button]
    && found.merged[RULES.query_button].exact || [])
    .filter(x => x.tag === 'button' && x.visible && x.clickable && x.unique && Number.isInteger(x.frameIndex));
  if (buttons.length !== 1) return fail('query_button_unavailable_or_ambiguous');
  const button = buttons[0];
  const inspected = await client.inspect(button.selector);
  if (!inspected || inspected.exists !== true || inspected.visible !== true || inspected.enabled !== true
    || String(inspected.text || '').trim() !== RULES.query_button || inspected.frameIndex !== button.frameIndex)
    return fail('query_button_readback_mismatch');
  // 页面 iframe 内 Playwright 普通/force 均超时（2026-09-26 现场）；宿主既有 DOM 回退
  // 仅用于「查询」这一可逆动作。按钮必须唯一且点击后以分页和首行营业日期双重核对。
  // 导出/下载绝不复用这里的 DOM 回退授权。
  const click = await client.click(button.selector, 'query', { settleMs: 1500, timeoutMs: 6000,
    forceRetry: true, domClickFallback: true });
  if (!click || !['input_click', 'forced_input_click', 'dom_click'].includes(click.via))
    return fail('query_click_unconfirmed');
  steps.push('query_clicked');
  let count = null;
  let firstDate = null;
  for (let i = 0; i < 8; i += 1) {
    const summary = await client.tableSummary({});
    const n = summary && summary.pagination && summary.pagination.declared_count;
    const firstRow = (summary && summary.tables || []).find(t => Array.isArray(t.firstRow) && t.firstRow.length > 4);
    const rowDate = firstRow && String(firstRow.firstRow[4] || '').trim();
    if (Number.isInteger(n) && n > 0 && rowDate === target) { count = n; firstDate = rowDate; break; }
    if (i < 7) await new Promise(resolve => setTimeout(resolve, 1500));
  }
  if (count === null) return fail('query_result_or_date_unavailable');
  dates = await readDates();
  if (dates.values[0] !== target || dates.values[1] !== target) return fail('date_changed_after_query');
  steps.push('query_result_count');
  return { ok: true, report_type: RULES.report_type, business_date: businessDate,
    declared_dynamic: count, first_row_date: firstDate, query_click_via: click.via, filters, steps };
}

module.exports = { RULES, selectedFilters, navigateAndQueryReportB };
