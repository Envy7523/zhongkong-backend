'use strict';
// Only existing POS daily amounts are used. These aggregates cannot recover payment-level rounding.
const money = n => Math.round(Number(n || 0) * 100);
const roundedFee = amountCents => Math.sign(amountCents) * Math.floor((Math.abs(amountCents) * 38 + 5000) / 10000);
function resolveDay(db,id,day,dineCents,composition) {
  const qrRows=composition.filter(r=>r.biz_date===day&&String(r.category).trim()==='扫码支付');
  const exact=require('./pos-order-detail').dayPolicy(db,id,day,qrRows.length?qrRows.reduce((n,r)=>n+money(r.amount),0):undefined);
  if (exact?.usable) return exact;
  const fallback=forDay({day,dineCents,composition});
  if (exact?.warning) fallback.warning+='；'+exact.warning;
  return fallback;
}
function forDay({ day, dineCents, composition = [] }) {
  const rows = composition.filter(r => r.biz_date === day);
  const cashRows = rows.filter(r => /^(现金|现金支付|现金收入)$/.test(String(r.category).trim()));
  const cash = cashRows.reduce((n,r)=>n+money(r.amount),0);
  const member = rows.filter(r => /^(会员卡|会员储值消费|储值卡)$/.test(String(r.category).trim())).reduce((n,r)=>n+money(r.amount),0);
  const qrRows = rows.filter(r=>String(r.category).trim()==='扫码支付');
  const qr = qrRows.reduce((n,r)=>n+money(r.amount),0);
  // Dine-in classification does not establish this payment gateway's fee rate.
  const separatePayment = rows.filter(r=>require('./pos-group-payments').isDinePayment(r.category)).reduce((n,r)=>n+money(r.amount),0);
  const base = qrRows.length ? qr : cashRows.length ? dineCents-cash-member-separatePayment : dineCents-member-separatePayment;
  return {date:day,fee_cents:roundedFee(base),actual:false,cash_cents:cash,deferred_member_cents:member,noncash_cents:base,
    source:'收银日汇总×3.8‰（理论估算，现金免收、会员卡结算暂缓）',
    warning:'现有日汇总缺少逐笔付款及退款退费，手续费为估算，无法保证与实际到账分位一致'+(cashRows.length?'':'；现金构成未完整提供')};
}
function applyResolved(rows, policies) {
  const applied = new Set();
  for (const row of rows) {
    const key = `${row.store_id}|${row.biz_date}`;
    const fee = policies.get(key);
    if (!fee || applied.has(key) || row.exclude_from_sales || !['store_sales', 'pickup'].includes(row.channel)) continue;
    row.income = (money(row.income) - fee.fee_cents) / 100;
    row.settled = (money(row.settled) - fee.fee_cents) / 100;
    row.offline_payment_fee = fee.fee_cents / 100;
    applied.add(key);
  }
  return applied;
}
function build(db, ids, from, to) {
  const policies = new Map(), byDate = new Map(), details = [], warnings = [];
  const member=require('./member-consumption-policy').build(db,ids,from,to);
  const memberDays=new Map(member.days.map(r=>[r.store_id+'|'+r.biz_date,r]));
  for (const id of ids) {
    const pos = db.queryAll("SELECT biz_date,channel,recorded_amount FROM business_revenue_records WHERE store_id=? AND source_type='pos' AND biz_date BETWEEN ? AND ?", [id, from, to]);
    const comp = db.queryAll('SELECT biz_date,category,amount FROM business_revenue_compositions WHERE store_id=? AND biz_date BETWEEN ? AND ?', [id, from, to]);
    for (const day of new Set(pos.filter(r => ['store_sales', 'pickup'].includes(r.channel)).map(r => r.biz_date))) {
      const dine = pos.filter(r => r.biz_date === day && ['store_sales', 'pickup'].includes(r.channel)).reduce((n, r) => n + money(r.recorded_amount), 0)
        - comp.filter(r => r.biz_date === day && require('./pos-group-payments').isGroup(r.category)).reduce((n, r) => n + money(r.amount), 0);
      const policy = { store_id: id, ...resolveDay(db,id,day,dine,comp) };
      const m=memberDays.get(`${id}|${day}`);
      if(m){policy.scan_fee_cents=policy.fee_cents;policy.member_fee_cents=m.ready?m.fee_cents:0;policy.fee_cents+=policy.member_fee_cents;policy.member_principal_cents=m.ready?m.principal_cents:0;policy.member_ready=m.ready;
        policy.actual=false;policy.source=policy.source.replace('、会员卡结算暂缓','')+'；会员本金逐笔×3.8‰测算，赠金不收费，非实际提现扣费';
        if(!m.ready)policy.warning=[policy.warning,m.reason].filter(Boolean).join('；');}
      policies.set(`${id}|${day}`, policy); details.push(policy);
      byDate.set(day, (money(byDate.get(day)) + policy.fee_cents) / 100);
      if (policy.warning) warnings.push(`${id}号门店：${policy.warning}`);
    }
  }
  return { policies, byDate, details, warnings, member_card_consumption:member, ready: !member.available||member.ready, actual_days: details.filter(r => r.actual).length, order_days:details.filter(r=>r.order_based).length, estimated_days: details.filter(r => !r.actual&&!r.order_based).length };
}
function isLedgerFee(row) {
  return /^(收款服务费|收款手续费|堂食手续费|扫码支付手续|扫码支付手续费)$/.test(String(row.subcategory_name || row.category_name || '').trim());
}
function adjustLedgerIncome(rows, dailyFee, totalFee) {
  if (!rows.some(r => r.is_group && r.category === '销售收入')) return false;
  const group = rows.find(r => r.is_group && r.category === '销售收入');
  group.daily_amount = (money(group.daily_amount) - money(dailyFee)) / 100;
  group.cumulative_amount = (money(group.cumulative_amount) - money(totalFee)) / 100;
  rows.push({ category: '销售收入', subcategory: '堂食收款手续费扣减', source_label: '按收银付款来源计算；已在收入扣减，支出不重复扣', daily_amount: -dailyFee, cumulative_amount: -totalFee, is_group: false, virtual: true });
  return true;
}
module.exports = {forDay,resolveDay,roundedFee,applyResolved,build,isLedgerFee,adjustLedgerIncome};
