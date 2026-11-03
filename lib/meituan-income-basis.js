'use strict';
// User confirmed on 2026-11-03 that Meituan renamed 营业收入 to 订单收入.
// Retain original labels as provenance; never rewrite historical workbooks.
const FIELDS = Object.freeze(['营业收入', '订单收入', '收入']);
function incomeField(row) {
  const fields = FIELDS.filter(field => Object.hasOwn(row, field));
  if (fields.length !== 1) throw Error('operating_income_field_missing_or_ambiguous');
  return fields[0];
}
function summarizeIncomeBasis(records) {
  const byField = new Map();
  for (const record of records) {
    let field = '未标明';
    try { field = incomeField(JSON.parse(record.raw_json || '{}')); } catch {}
    const item = byField.get(field) || { field, row_count: 0, amount: 0 };
    item.row_count++;
    item.amount += Number(record.income_amount) || 0;
    byField.set(field, item);
  }
  const fields = [...byField.values()].map(item => ({ ...item, amount: Math.round(item.amount * 100) / 100 }));
  const renamed = fields.length > 0 && fields.every(item => ['营业收入', '订单收入'].includes(item.field));
  const mixed = !renamed && fields.length > 1;
  const label = renamed ? '订单收入' : mixed ? '来源收入（多口径）' : fields[0]?.field || '订单收入';
  return { label, fields, mixed, mixed_source_labels: fields.length > 1,
    equivalence_confirmed: renamed, rename_confirmed_on: renamed ? '2026-11-03' : null,
    note: renamed
      ? '美团外卖已将“营业收入”更名为“订单收入”，新旧报表均按原值汇总，保留原始字段；订单收入不代表结算或银行到账。'
      : '保留原表收入字段与金额；未标明或其他收入字段不能视为已确认更名，不代表结算或银行到账。' };
}
module.exports = { incomeField, summarizeIncomeBasis };
