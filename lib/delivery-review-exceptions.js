'use strict';

// Business-approved exceptions affect completeness only. Originals and database
// readback must still pass before finish() consults this policy.
const rules = [{
  store_id: 25,
  platform_id: '29547426',
  from: '2026-10-23',
  types: ['operating', 'product'],
  approved_on: '2026-10-24',
  reason: '用户确认：麦地店同店重新开业，美团外卖资质待恢复，营业及商品完整性临时豁免',
}];
const fields = ['营业收入', '优惠前总额', '有效订单'];
const isBlank = value => ['', '--', '—', '-'].includes(String(value ?? '').trim());

function active(db, type, date, bindings) {
  return rules.filter(rule => {
    if (!rule.types.includes(type) || date < rule.from || !bindings.some(b => Number(b.store_id) === rule.store_id && b.platform_id === rule.platform_id)) return false;
    if (db.queryOne('SELECT 1 found FROM meituan_delivery_product_records WHERE meituan_store_id=? AND biz_date>=? AND biz_date<=? AND (quantity>0 OR sales_amount<>0) LIMIT 1', [rule.platform_id, rule.from, date])) return false;
    const rows = db.queryAll('SELECT biz_date,raw_json FROM meituan_delivery_operation_records WHERE meituan_store_id=? AND biz_date>=? AND biz_date<=?', [rule.platform_id, rule.from, date]);
    // A populated money/order metric ends the exception automatically. Do not
    // waive missing files, absent operating rows, or partially populated data.
    return rows.some(r => r.biz_date === date) && rows.every(r => {
      const raw = JSON.parse(r.raw_json || '{}');
      return fields.every(field => isBlank(raw[field]));
    });
  }).map(rule => ({ ...rule, temporary: true, auto_resume: '首次恢复营业收入、优惠前总额或有效订单数据时，恢复正常核验' }));
}

module.exports = { active, fields, isBlank };
