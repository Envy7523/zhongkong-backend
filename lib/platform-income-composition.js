'use strict';

const platforms = [
  ['meituan_group', '美团团购', '销售金额', '平台优惠', '顾客实付'],
  ['douyin_group', '抖音团购', '结算前金额', '优惠金额', '结算前收入'],
  ['meituan_delivery', '美团外卖', '营业额', '优惠金额', '营业日报收入'],
  ['taobao_flash', '淘宝闪购', '营业额', '优惠金额', '订单收入'],
  ['jd_delivery', '京东外卖', '营业额', '优惠金额', '结算前收入'],
];
const cents = value => Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) : 0;
const feeFields = [['resolved_service_fee','服务费'],['resolved_insurance_fee','保险费'],['resolved_promotion_fee','推广费'],['resolved_refund_amount','退款及调整']];

// Reuse the resolved store/day source and amounts. This is a disclosure, never
// another revenue calculation; group rows still belong here when excluded from
// the channel total to avoid counting their POS mirror twice.
function build(rows = [], missingDays = [], rawFees = [], meituanBreakdown = null) {
  return platforms.map(([channel, name, grossLabel, discountLabel, incomeLabel]) => {
    const selected = rows.filter(row => row.channel === channel && row.source_used === 'platform');
    const imported = selected.filter(row => row.has_platform);
    const missing = missingDays.filter(row => row.channel === channel).map(row => ({ ...row, reason: row.source_part === 'oneclick' ? '一键买单尾款未导入' : '平台收益／账单待补齐' }));
    for (const row of selected.filter(row => row.gross_pending)) missing.push({store_id:row.store_id,store_name:row.store_name,biz_date:row.biz_date,channel,reason:'营业日报待补齐'});
    const unique = [...new Map(missing.map(row => [[row.store_id,row.biz_date,row.reason].join('|'),row])).values()];
    const available = imported.length > 0 || selected.some(row => row.source_status === 'platform_no_activity');
    const sum = field => available ? imported.reduce((n,row) => n + cents(row[field]),0) / 100 : null;
    const income = sum('income'), fees = sum('resolved_fees'), net = sum('confirmed');
    const details = rawFees.filter(item => item.platform === name).map(item => ({label:item.label,amount:cents(item.amount)/100}));
    return {channel,name,gross_label:grossLabel,discount_label:discountLabel,income_label:incomeLabel,
      ...(channel==='meituan_group'&&meituanBreakdown?.length?{breakdown:meituanBreakdown}:{}),
      available,ready:available && !unique.length,missing_days:unique,
      gross:sum('gross'),discount:sum('discount'),income,fees,net,
      gross_pending:selected.some(row=>row.gross_pending),
      adjustment:available?(cents(net)-cents(income)+cents(fees))/100:null,
      fee_details:details.length?details:feeFields.map(([field,label])=>({label,amount:sum(field)})).filter(item=>item.amount!==null&&item.amount!==0),
      source_overridden:rows.some(row=>row.channel===channel&&row.source_used!=='platform'),
    };
  });
}
module.exports = {build};
