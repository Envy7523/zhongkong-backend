/**
 * 营业数据映射：把真实后台 businessAnalytics.getOverview() 的返回，
 * 映射成小程序营业数据页的视图模型（hero + metrics + sections）。
 *
 * 【为什么必须走这个映射，而不是自己写 SQL 求和】
 *   后台的营业额/实收走的是「渠道对账口径」（离线按确认收入、外卖只认平台侧结算、
 *   美团外卖无营业日报时置 0 并标记待补）。自行 SUM(gross_amount) 会与后台对不上
 *   （实测：方洲店 2026-09-09 后台 4,453.64 / 自行求和 6,388.13）。
 *   所以这里只做「搬运 + 换字段名」，一个数字都不重新计算。
 *
 * 本文件是纯函数，不依赖数据库，便于离线用真实接口返回做回归。
 */

const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const money = n => Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 });
const y = n => '¥' + money(n);

/**
 * @param {object} ov         getOverview() 的返回（单门店单日）
 * @param {object} ctx        { store, date, dates, compareOv, prevDate, nextDate }
 * @returns {object}          移动端 DTO
 */
function mapOverviewToMobile(ov, ctx) {
  const t = (ov && ov.totals) || {};
  const revenue = r2(t.gross_amount);
  const actual = r2(t.confirmed);
  const orders = Number(t.order_count) || 0;
  const discount = r2(t.discount_amount);

  const summary = {
    revenue,
    actual_revenue: actual,
    order_count: orders,
    avg_order_value: orders > 0 ? r2(actual / orders) : 0,
    discount_amount: discount,
    discount_rate: revenue > 0 ? r2((discount / revenue) * 100) : 0,
    platform_fee: r2(t.fees),
    platform_income: r2(t.platform_income_amount),
    offline: r2(t.offline),
    group_buy: r2(t.group_buy),
    delivery: r2(t.delivery),
    gross_pending: !!t.gross_pending,
    verified_channels: Number(t.verified) || 0,
    online_pairs: Number(t.online_pairs) || 0,
    online_difference: r2(t.online_difference),
    verification_rate: Number(t.verification_rate) || 0,
  };

  const metrics = [
    { key: 'actual', label: '实收（确认收入）', value: summary.actual_revenue, type: 'money' },
    { key: 'orders', label: '订单数', value: orders, type: 'int', unit: '单' },
    { key: 'avg', label: '客单价', value: summary.avg_order_value, type: 'money' },
    {
      key: 'discount', label: '客户优惠', value: discount, type: 'money',
      sub: revenue > 0 ? `优惠占比 ${summary.discount_rate}%` : '',
    },
    {
      key: 'fee', label: '平台费用', value: summary.platform_fee, type: 'money',
      sub: feeSub(t.fee_breakdown),
    },
    { key: 'platform_income', label: '平台入账', value: summary.platform_income, type: 'money' },
  ];

  const sections = [];

  // 1) 渠道构成（后台对账后的"确认收入"）
  const channels = (ov.channel_breakdown || [])
    .filter(c => Number(c.amount) > 0)
    .map(c => ({
      key: c.channel || c.label,
      label: c.label || c.channel,
      value: r2(c.amount),
      sub: buildChannelSub(c),
    }))
    .sort((a, b) => b.value - a.value);
  if (channels.length) {
    sections.push({ key: 'channel', title: '渠道构成（确认收入）', total: sum(channels), items: channels });
  }

  // 2) 渠道分组（线下 / 外卖 / 团购）
  const groups = [
    { key: 'offline', label: '线下（堂食+自提）', value: summary.offline },
    { key: 'delivery', label: '外卖', value: summary.delivery },
    { key: 'group_buy', label: '团购', value: summary.group_buy },
  ].filter(x => x.value > 0);
  if (groups.length) {
    sections.push({ key: 'group', title: '渠道分组', total: sum(groups), items: groups });
  }

  // 3) 营收构成（收款/来源）
  const comp = (ov.revenue_composition || [])
    .filter(c => Number(c.amount) > 0)
    .map(c => ({ key: c.category, label: c.category, value: r2(c.amount), sub: c.source || '' }))
    .sort((a, b) => b.value - a.value);
  if (comp.length) {
    sections.push({ key: 'composition', title: '营收构成（收款/来源）', total: sum(comp), items: comp });
  }

  // 4) 平台费用明细
  const fees = (ov.fee_detail_breakdown || [])
    .filter(f => Number(f.amount) > 0)
    .map(f => ({ key: f.key || f.label, label: f.label || f.key, value: r2(f.amount), sub: f.platform || '' }))
    .sort((a, b) => b.value - a.value);
  if (fees.length) {
    sections.push({ key: 'fee', title: '平台费用明细', total: sum(fees), items: fees });
  }

  // 5) 热销菜品
  const top = (ov.top_products || [])
    .filter(p => Number(p.sales_amount) > 0)
    .map(p => ({ key: p.product_name, label: p.product_name, value: r2(p.sales_amount), sub: qtySub(p.quantity) }))
    .sort((a, b) => b.value - a.value);
  if (top.length) {
    sections.push({ key: 'top_products', title: '热销菜品', total: sum(top), items: top, top: 10 });
  }

  // 环比：用上一个有数据日期的 getOverview 结果算，口径与主数字完全一致
  let compare = null;
  if (ctx && ctx.compareOv && ctx.compareOv.totals) {
    const p = ctx.compareOv.totals;
    const pRev = r2(p.gross_amount);
    const pAct = r2(p.confirmed);
    compare = {
      date: ctx.prevDate,
      revenue: pRev,
      actual_revenue: pAct,
      revenue_diff: r2(revenue - pRev),
      actual_diff: r2(actual - pAct),
      revenue_pct: pRev > 0 ? r2(((revenue - pRev) / pRev) * 100) : null,
      actual_pct: pAct > 0 ? r2(((actual - pAct) / pAct) * 100) : null,
    };
  }

  return {
    ok: true,
    found: true,
    source: 'business_analytics.getOverview',
    data_source: (ov.data_source || {}).view || '',
    store: ctx.store,
    date: ctx.date,
    latest: (ctx.dates && ctx.dates[0]) || ctx.date,
    available_dates: (ctx.dates || []).slice(0, 60),
    prev_date: ctx.prevDate || null,
    next_date: ctx.nextDate || null,
    summary,
    metrics,
    sections,
    // 兼容旧字段名（避免页面之外的地方引用不到）
    channels,
    channel_total: sum(channels),
    compare,
  };
}

function buildChannelSub(c) {
  const parts = [];
  if (Number(c.gross_amount) > 0) parts.push('营业额 ' + y(c.gross_amount));
  if (Number(c.order_count) > 0) parts.push(c.order_count + ' 单');
  if (c.gross_pending) parts.push('待补营业日报');
  if (c.source_used === 'platform') parts.push('平台结算');
  return parts.join(' · ');
}

function feeSub(fb) {
  if (!fb) return '服务费/推广费/保险/退款';
  const parts = [];
  if (Number(fb.service_fee) > 0) parts.push('服务费 ' + y(fb.service_fee));
  if (Number(fb.promotion_fee) > 0) parts.push('推广费 ' + y(fb.promotion_fee));
  if (Number(fb.insurance_fee) > 0) parts.push('保险 ' + y(fb.insurance_fee));
  if (Number(fb.refund_amount) > 0) parts.push('退款 ' + y(fb.refund_amount));
  return parts.length ? parts.join(' · ') : '服务费/推广费/保险/退款';
}

function qtySub(q) {
  const n = Number(q) || 0;
  return n > 0 ? n + ' 份' : '';
}

function sum(items) {
  return r2((items || []).reduce((a, b) => a + (Number(b.value) || 0), 0));
}

module.exports = { mapOverviewToMobile, r2, money };
