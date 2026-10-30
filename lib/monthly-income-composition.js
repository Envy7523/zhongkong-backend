'use strict';

const CHANNELS = [
  { key: 'store_sales', label: '堂食外带', note: '收银机' },
  { key: 'pickup', label: '自提销售', note: '收银机' },
  { key: 'meituan_group', label: '美团团购' },
  { key: 'douyin_group', label: '抖音团购' },
  { key: 'meituan_delivery', label: '美团外卖' },
  { key: 'taobao_flash', label: '淘宝闪购' },
  { key: 'jd_delivery', label: '京东秒送' },
];
const GROUPS = new Set(['meituan_group', 'douyin_group']);
const cents = amount => Math.round(Number(amount || 0) * 100);
const storeDay = row => `${row.store_id}|${row.biz_date}`;
const sourceLabel = source => source === 'platform' ? '第三方数据' : source === 'mixed' ? '混合来源' : '收银机数据';

function buildSalesComposition(rows, cutoff, options = {}) {
  const amounts = new Map(CHANNELS.map(meta => [meta.key, { daily: 0, cumulative: 0, sources: new Set() }]));
  const instoreDays = new Set(rows.filter(row => row.channel === 'store_sales' && !row.exclude_from_sales).map(storeDay));
  const fees = { daily: 0, cumulative: 0 };
  const add = (channel, amount, date, source) => {
    const target = amounts.get(channel);
    if (!target) return;
    target.cumulative += amount;
    if (date === cutoff) target.daily += amount;
    if (source) target.sources.add(source);
  };
  for (const row of rows) {
    if (GROUPS.has(row.channel)) {
      const embedded = row.exclude_from_sales && instoreDays.has(storeDay(row));
      // Manual fee mode has already switched the parent to settled income.
      // Deduct and display its embedded groups on that same basis.
      const field = embedded && options.embeddedGroupField === 'settled' ? 'settled' : 'income';
      const amount = cents(row[field]);
      add(row.channel, amount, row.biz_date, row.source_used || 'pos');
      // The resolver replaced POS group payments inside the parent. Remove the
      // replacement itself, not the original POS payment, when making a separate
      // group row. Meituan already includes the one-click subset exactly once.
      if (embedded) add('store_sales', -amount, row.biz_date);
    } else if (!row.exclude_from_sales) {
      add(row.channel, cents(row.income), row.biz_date, row.source_used || 'pos');
      // The resolver has already deducted this fee. Move that deduction to its
      // own real-view row, restoring the payment channel without charging twice.
      if (options.showOfflineFee && ['store_sales', 'pickup'].includes(row.channel)) {
        const fee = cents(row.offline_payment_fee);
        add(row.channel, fee, row.biz_date);
        fees.cumulative += fee;
        if (row.biz_date === cutoff) fees.daily += fee;
      }
    }
  }
  const children = CHANNELS.map(meta => {
    const amount = amounts.get(meta.key);
    const source = amount.sources.size > 1 ? 'mixed' : amount.sources.values().next().value || options.sourceFor?.(meta.key) || 'pos';
    return {
      category: '销售收入', subcategory: meta.label,
      daily_amount: amount.daily / 100, cumulative_amount: amount.cumulative / 100,
      source_label: meta.note || sourceLabel(source), source_used: source,
      is_group: false, virtual: true,
    };
  });
  const member=options.memberPolicy;
  if(member?.available){
    const daily=require('./member-consumption-policy').summarize(member.days,cutoff,cutoff);
    const dine=children.find(r=>r.subcategory==='堂食外带');
    dine.daily_amount=(cents(dine.daily_amount)-cents(daily.principal))/100;
    dine.cumulative_amount=(cents(dine.cumulative_amount)-cents(member.principal))/100;
    children.splice(1,0,{category:'销售收入',subcategory:'会员卡消费本金',daily_amount:daily.principal,cumulative_amount:member.principal,source_label:'会员交易流水',is_group:false,virtual:true});
  }
  if (fees.daily || fees.cumulative) children.push({
    category: '销售收入', subcategory: '堂食收款手续费扣减',
    daily_amount: -fees.daily / 100, cumulative_amount: -fees.cumulative / 100,
    source_label: '已在收入扣减', is_group: false, virtual: true,
  });
  return [{
    category: '销售收入', subcategory: '',
    daily_amount: ([...amounts.values()].reduce((sum, row) => sum + row.daily, 0) - fees.daily) / 100,
    cumulative_amount: ([...amounts.values()].reduce((sum, row) => sum + row.cumulative, 0) - fees.cumulative) / 100,
    is_group: true, virtual: true,
  }, ...children];
}

module.exports = { buildSalesComposition };
