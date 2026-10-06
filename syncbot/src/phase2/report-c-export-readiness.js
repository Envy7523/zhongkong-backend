'use strict';
/** C 导出前最后一次只读核验；绝不点击导出。 */
const Q = require('./report-c-query-flow');
function amountCents(value) {
  const text = String(value || '').replace(/,/g, '');
  if (!/^[+-]?\d+\.\d{2}$/.test(text)) return null;
  const n = Math.round(Number(text) * 100);
  return Number.isSafeInteger(n) ? n : null;
}
async function checkReportCExportReadiness({ client, businessDate, queryResult } = {}) {
  const fail = reason => ({ ok: false, reason });
  if (!client || queryResult?.ok !== true || queryResult.report_type !== Q.RULES.report_type
    || queryResult.business_date !== businessDate || !Number.isInteger(queryResult.declared_count)
    || queryResult.declared_count <= 0 || amountCents(queryResult.displayed_total) === null)
    return fail('query_evidence_invalid');
  if ((await client.url())?.url !== Q.RULES.page_url) return fail('page_changed');
  const target = businessDate.replace(/-/g, '/');
  const dates = (await client.dateInputs()).filter(x => x.visible && /^(开始日期|结束日期)$/.test(x.placeholder || ''));
  if (dates.length !== 2 || dates[0].value !== target || dates[1].value !== target)
    return fail('date_readback_mismatch');
  const filters = await client.filterDetail({ labels: ['门店', '大类', '小类'], maxDepth: 9, maxNodes: 100 });
  if (!Q.allFiltersSelected(filters)) return fail('all_filters_not_confirmed');
  const summary = await client.tableSummary({});
  const currentCount = summary?.pagination?.declared_count;
  const first = (summary?.tables || []).find(t => Array.isArray(t.firstRow)
    && t.firstRow.length === 5 && /^\d+$/.test(String(t.firstRow[0] || '')))?.firstRow;
  const text = await client.pageText({ maxChars: 4000 });
  const total = String(text?.text || '').match(/合计\s+--\s+--\s+--\s+([+-]?[\d,]+\.\d{2})/);
  if (currentCount !== queryResult.declared_count || !first
    || JSON.stringify(first) !== JSON.stringify(queryResult.first_row)
    || !total || amountCents(total[1]) !== amountCents(queryResult.displayed_total))
    return fail('query_result_changed');
  const exportButton = await Q.uniqueButton(client, Q.RULES.export_button);
  if (!exportButton || exportButton.frameIndex !== 1 || !/saas-card-head/.test(exportButton.selector))
    return fail('export_button_unavailable_or_ambiguous');
  return { ok: true, report_type: Q.RULES.report_type, business_date: businessDate,
    declared_count: currentCount, displayed_total_cents: amountCents(total[1]),
    button: { label: Q.RULES.export_button, selector: exportButton.selector,
      frameIndex: exportButton.frameIndex } };
}
function reconcileExportFile(readiness, validation) {
  if (readiness?.ok !== true || validation?.ok !== true
    || readiness.report_type !== validation.report_type
    || readiness.business_date !== validation.business_date
    || readiness.declared_count !== validation.row_count
    || readiness.displayed_total_cents !== validation.total_cents)
    return { ok: false, reason: 'export_file_query_mismatch' };
  return { ok: true, business_date: readiness.business_date,
    row_count: validation.row_count, total_cents: validation.total_cents };
}
module.exports = { amountCents, checkReportCExportReadiness, reconcileExportFile };
