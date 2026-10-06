'use strict';
/**
 * 报表 B 导出前最后一次只读复核。只产出按钮证据，不点击导出。
 * 调用方必须在同一受控任务内持久化不可逆状态并通过宿主 export 授权闸门。
 */
const { RULES, selectedFilters } = require('./report-b-query-flow');

async function checkReportBExportReadiness({ client, businessDate }) {
  const fail = reason => ({ ok: false, reason, report_type: RULES.report_type, business_date: businessDate });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate || ''))) return fail('business_date_invalid');
  const target = businessDate.replace(/-/g, '/');
  const url = await client.url();
  if (!url || url.url !== RULES.page_url) return fail('report_b_url_mismatch');
  const dates = (await client.dateInputs()).filter(x => x.visible && /^(开始日期|结束日期)$/.test(x.placeholder || ''));
  if (dates.length !== 2 || dates.some(x => x.value !== target)) return fail('date_readback_mismatch');
  const filters = selectedFilters(await client.filterDetail({
    labels: ['品项类型', '菜品类型', '门店', '销售方式'], maxDepth: 10, maxNodes: 160,
  }));
  if (!filters.ok) return fail(filters.reason);
  const summary = await client.tableSummary({});
  const count = summary && summary.pagination && summary.pagination.declared_count;
  const first = (summary && summary.tables || []).find(t => Array.isArray(t.firstRow) && t.firstRow.length > 4);
  const firstDate = first && String(first.firstRow[4] || '').trim();
  if (!Number.isInteger(count) || count <= 0 || firstDate !== target) return fail('query_result_or_date_mismatch');

  const found = await client.probe([RULES.export_button], { maxPerText: 6 });
  const candidates = (found && found.merged && found.merged[RULES.export_button]
    && found.merged[RULES.export_button].exact || [])
    .filter(x => x.tag === 'button' && x.text === RULES.export_button && x.unique === true
      && x.visible === true && x.clickable === true && Number.isInteger(x.frameIndex));
  if (candidates.length !== 1) return fail('export_button_unavailable_or_ambiguous');
  const button = candidates[0];
  const inspected = await client.inspect(button.selector);
  if (!inspected || inspected.exists !== true || inspected.visible !== true || inspected.enabled !== true
    || String(inspected.text || '').trim() !== RULES.export_button || inspected.frameIndex !== button.frameIndex)
    return fail('export_button_readback_mismatch');
  return { ok: true, report_type: RULES.report_type, business_date: businessDate,
    declared_count: count, first_row_date: firstDate, button: {
      selector: button.selector, label: RULES.export_button, frame_index: button.frameIndex,
    }, filters };
}

module.exports = { checkReportBExportReadiness };
