'use strict';
/** 收银系统 C：定位页面、展开筛选、同日查询并读回；绝不点击导出。 */
const D = require('./date-range');
const RULES = require('../../config/report-c-rules.json');

function allFiltersSelected(detail) {
  const rows = detail?.best?.results;
  if (!Array.isArray(rows)) return false;
  return ['门店', '大类', '小类'].every(label => {
    const row = rows.find(item => item.label === label && item.found === true);
    return row && (row.outline || []).some(node => node.tag === 'span'
      && /saas-select-selection-placeholder/.test(node.cls || '')
      && String(node.full_text || '').trim() === '全部');
  });
}

async function uniqueButton(client, label) {
  const found = await client.probe([label], { maxPerText: 5 });
  const buttons = (found?.merged?.[label]?.exact || []).filter(item => item.tag === 'button'
    && item.visible && item.clickable && item.unique && Number.isInteger(item.frameIndex));
  if (buttons.length !== 1) return null;
  const checked = await client.inspect(buttons[0].selector);
  return checked?.exists === true && checked.visible === true && checked.enabled === true
    && checked.frameIndex === buttons[0].frameIndex && String(checked.text || '').trim() === label
    ? buttons[0] : null;
}

async function navigateAndQueryReportC({ client, businessDate, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!client || !/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate || '')))
    return { ok: false, reason: 'context_invalid' };
  const fail = reason => ({ ok: false, reason, report_type: RULES.report_type, business_date: businessDate });
  const page = await client.goto(RULES.page_url, { settleMs: 1800 });
  const url = await client.url();
  if (!page || url?.url !== RULES.page_url) return fail('report_c_url_mismatch');
  let title = false;
  for (let i = 0; i < 12; i++) {
    const text = await client.pageText({ maxChars: 1500 });
    if (String(text?.text || '').includes('[frame1] ' + RULES.report_name)) { title = true; break; }
    if (i < 11) await sleep(1500);
  }
  if (!title) return fail('report_c_title_missing');
  const readDates = async () => {
    const inputs = (await client.dateInputs()).filter(x => /^(开始日期|结束日期)$/.test(x.placeholder || ''));
    return { inputs, values: inputs.map(x => x.value) };
  };
  let dates = await readDates();
  if (dates.inputs.length !== 2) return fail('date_inputs_unavailable');
  if (!dates.inputs.every(x => x.visible)) {
    const expand = await uniqueButton(client, '展开筛选');
    if (!expand) return fail('expand_button_unavailable');
    const clicked = await client.click(expand.selector, 'nav', { settleMs: 500, timeoutMs: 6000 });
    if (!clicked) return fail('expand_click_failed');
    dates = await readDates();
  }
  if (dates.inputs.length !== 2 || !dates.inputs.every(x => x.visible)) return fail('date_inputs_hidden');
  const target = businessDate.replace(/-/g, '/');
  if (dates.values[0] !== target || dates.values[1] !== target) {
    const selected = await D.setDateRangeExact({ client, readDates,
      startSelector: dates.inputs[0].selector, targetInput: target, iso: businessDate });
    if (!selected.ok) return fail('date_selection_failed');
  }
  dates = await readDates();
  if (dates.values[0] !== target || dates.values[1] !== target) return fail('date_readback_mismatch');
  const detail = await client.filterDetail({ labels: ['门店', '大类', '小类'], maxDepth: 9, maxNodes: 100 });
  if (!allFiltersSelected(detail)) return fail('all_filters_not_confirmed');
  const query = await uniqueButton(client, RULES.query_button);
  if (!query) return fail('query_button_unavailable');
  const clicked = await client.click(query.selector, 'query', { settleMs: 1500, timeoutMs: 6000,
    forceRetry: true, domClickFallback: true });
  if (!clicked || !['input_click', 'forced_input_click', 'dom_click'].includes(clicked.via))
    return fail('query_click_unconfirmed');
  let count = null;
  let firstRow = null;
  let totalText = null;
  for (let i = 0; i < 12; i++) {
    const summary = await client.tableSummary({});
    const n = summary?.pagination?.declared_count;
    const row = (summary?.tables || []).find(t => Array.isArray(t.firstRow) && t.firstRow.length === 5
      && /^\d+$/.test(String(t.firstRow[0] || '')));
    const pageText = await client.pageText({ maxChars: 4000 });
    const total = String(pageText?.text || '').match(/合计\s+--\s+--\s+--\s+([+-]?[\d,]+\.\d{2})/);
    if (Number.isInteger(n) && n > 0 && row && total) {
      count = n; firstRow = row.firstRow; totalText = total[1]; break;
    }
    if (i < 11) await sleep(1500);
  }
  if (count === null) return fail('query_result_unverified');
  dates = await readDates();
  if (dates.values[0] !== target || dates.values[1] !== target) return fail('date_changed_after_query');
  return { ok: true, report_type: RULES.report_type, business_date: businessDate,
    declared_count: count, first_row: firstRow, displayed_total: totalText,
    query_click_via: clicked.via, filters: { store: '全部', category: '全部', subcategory: '全部' } };
}

module.exports = { RULES, allFiltersSelected, uniqueButton, navigateAndQueryReportC };
