'use strict';

// 只读预览模型；不含 webhook、发送、写库或菜品/平台结算数据。
const CHANNELS = Object.freeze([
  ['store_sales', '店内销售'],
  ['pickup', '自提销售'],
  ['meituan_delivery', '美团外卖（收银记录）'],
  ['taobao_flash', '淘宝闪购（收银记录）'],
  ['jd_delivery', '京东外卖（收银记录）'],
]);
const COMPOSITIONS = Object.freeze([
  ['现金', '现金'],
  ['扫码支付', '扫码支付'],
  ['会员卡', '储值消费'],
  ['一键买单（尾款）', '美团一键买单'],
  ['美团/大众点评团购', '美团团购'],
  ['抖音团购', '抖音团购'],
  ['自定义记账', '自定义记账'],
]);

const roundMoney = value => Math.round((value + Number.EPSILON) * 100) / 100;
const sum = (rows, key) => roundMoney(rows.reduce((total, row) => total + row[key], 0));
const validDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

function numeric(value, label, problems) {
  const n = value === null || value === undefined || value === '' ? NaN : Number(value);
  if (!Number.isFinite(n)) { problems.push(`数值缺失或非法：${label}`); return 0; }
  return n;
}

function buildPosDailyPreview(db, businessDate, options = {}) {
  if (!validDate(businessDate)) throw new Error('business_date_invalid');
  if (!db || typeof db.queryAll !== 'function') throw new Error('read_only_db_required');
  const problems = [];
  const active = db.queryAll("SELECT id,store_name FROM stores WHERE status='正常营业' ORDER BY id", []);
  const excludedStores = options.excludedStores || {};
  const excluded = active.filter(row => Object.hasOwn(excludedStores, Number(row.id)))
    .map(row => ({ store_id: Number(row.id), store_name: row.store_name, reason: String(excludedStores[row.id]) }));
  const included = active.filter(row => !Object.hasOwn(excludedStores, Number(row.id)));
  const source = db.queryAll("SELECT store_id,store_name,channel,channel_group,gross_amount,recorded_amount,order_count FROM business_revenue_records WHERE source_type='pos' AND biz_date=? ORDER BY store_id,channel", [businessDate]);
  const compositions = db.queryAll('SELECT store_id,category,amount FROM business_revenue_compositions WHERE biz_date=? ORDER BY store_id,category', [businessDate]);
  if (!Array.isArray(active) || !Array.isArray(source) || !Array.isArray(compositions)) throw new Error('db_response_invalid');
  if (!included.length) problems.push('没有纳入日报的门店，无法核对覆盖范围');
  const activeIds = new Set(included.map(row => Number(row.id)));
  const byStore = new Map(included.map(row => [Number(row.id), {
    store_id: Number(row.id), store_name: String(row.store_name || ''),
    gross_amount: 0, recorded_amount: 0, order_count: 0, channels: {}, compositions: {},
  }]));
  const seen = new Set();
  for (const row of source) {
    const id = Number(row.store_id);
    if (!activeIds.has(id)) {
      if (!Object.hasOwn(excludedStores, id)) problems.push(`非正常营业门店出现在收银记录：${id}`);
      continue;
    }
    const key = `${id}:${row.channel}`;
    if (seen.has(key)) { problems.push(`同一门店渠道重复：${key}`); continue; }
    seen.add(key);
    const store = byStore.get(id);
    // 综合营业统计的团购行由收入构成镜像生成，与店内销售存在重叠，不能再次计入总额。
    if (row.channel_group === 'group_buy') continue;
    const gross = numeric(row.gross_amount, `${key}.gross`, problems);
    const recorded = numeric(row.recorded_amount, `${key}.recorded`, problems);
    const orders = numeric(row.order_count, `${key}.orders`, problems);
    store.gross_amount = roundMoney(store.gross_amount + gross);
    store.recorded_amount = roundMoney(store.recorded_amount + recorded);
    store.order_count += orders;
    store.channels[row.channel] = roundMoney((store.channels[row.channel] || 0) + recorded);
  }
  for (const row of compositions) {
    const id = Number(row.store_id);
    if (!activeIds.has(id)) continue;
    const store = byStore.get(id);
    const key = String(row.category || '');
    if (Object.hasOwn(store.compositions, key)) problems.push(`同一门店收入构成重复：${id}:${key}`);
    store.compositions[key] = roundMoney(numeric(row.amount, `${id}:${key}.amount`, problems));
  }
  const rows = [...byStore.values()];
  for (const row of rows) {
    if (!seen.has(`${row.store_id}:store_sales`)) problems.push(`门店缺少店内销售记录：${row.store_name}`);
    if (!Object.keys(row.compositions).length) problems.push(`门店缺少收入构成记录：${row.store_name}`);
    const channelTotal = roundMoney(Object.values(row.channels).reduce((n, value) => n + value, 0));
    // 收入构成是原报表另一套付款维度，并非店内/自提渠道拆分；不可强行要求两者相等。
    if (Math.abs(channelTotal - row.recorded_amount) > 0.02)
      problems.push(`渠道收入与营业收入不平：${row.store_name}`);
    row.discount_amount = roundMoney(row.gross_amount - row.recorded_amount);
    row.discount_rate = row.gross_amount > 0 ? row.discount_amount / row.gross_amount : 0;
    if (row.discount_amount < -0.01) problems.push(`营业收入高于营业额：${row.store_name}`);
  }
  rows.sort((a, b) => b.gross_amount - a.gross_amount || a.store_id - b.store_id);
  rows.forEach((row, index) => { row.rank = index + 1; });
  const middle = Math.floor((rows.length - 3) / 2);
  const focus = new Set([0, 1, 2, middle, middle + 1, middle + 2, rows.length - 3, rows.length - 2, rows.length - 1]);
  const focusRows = rows.filter((_, index) => focus.has(index));
  const totals = {
    gross_amount: sum(rows, 'gross_amount'), recorded_amount: sum(rows, 'recorded_amount'),
    discount_amount: sum(rows, 'discount_amount'), order_count: rows.reduce((n, row) => n + row.order_count, 0),
    channels: Object.fromEntries(CHANNELS.map(([key]) => [key, roundMoney(rows.reduce((n, row) => n + (row.channels[key] || 0), 0))])),
    compositions: Object.fromEntries(COMPOSITIONS.map(([key]) => [key, roundMoney(rows.reduce((n, row) => n + (row.compositions[key] || 0), 0))])),
  };
  totals.discount_rate = totals.gross_amount > 0 ? totals.discount_amount / totals.gross_amount : 0;
  return {
    title: '收银系统每日高低位数据', business_date: businessDate,
    data_scope: '收银系统记录视角；外卖/团购渠道金额不是第三方平台结算实收',
    excluded: ['菜品销量', '第三方平台结算实收'],
    ready: problems.length === 0, problems,
    store_count: rows.length, excluded_stores: excluded, rows, focus_rows: focusRows, totals,
    channel_labels: CHANNELS, composition_labels: COMPOSITIONS,
  };
}

module.exports = { buildPosDailyPreview, CHANNELS, COMPOSITIONS };
