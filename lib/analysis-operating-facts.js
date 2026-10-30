'use strict';
const round = v => Math.round((Number(v) || 0) * 100) / 100;
const sum = (rows, field) => round(rows.reduce((s, r) => s + Number(r[field] || 0), 0));
function previousPeriod(from, to) {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const date = t => new Date(t).toISOString().slice(0, 10);
  return { from: date(Date.parse(from) - days * 86400000), to: date(Date.parse(from) - 86400000), days };
}
function comparison(current, previous, comparable) {
  const delta = round(current - previous);
  return { current: round(current), previous: round(previous), delta, change_pct: comparable && previous > 0 ? round(delta / previous * 100) : null, comparable };
}
function products(db, id, from, to) {
  return db.queryAll(`SELECT product_name,ROUND(SUM(quantity),2) quantity,
    ROUND(SUM(sales_amount),2) sales_amount,ROUND(SUM(discount_amount),2) discount_amount,
    ROUND(SUM(income_amount),2) income_amount FROM pos_product_sale_details
    WHERE store_id=? AND biz_date BETWEEN ? AND ? GROUP BY product_name ORDER BY income_amount DESC`, [id, from, to]);
}
function enrichDishes(current, previous, all, before, period) {
  const comparable = Number(current.totals?.days) === period.days && Number(previous.totals?.days) === period.days;
  const prior = new Map(before.map(r => [r.product_name, r]));
  const totalIncome = Number(current.totals?.income_amount || 0);
  const rows = all.map(r => {
    const p = prior.get(r.product_name);
    return { ...r, income_share_pct: totalIncome > 0 ? round(Number(r.income_amount) / totalIncome * 100) : 0,
      discount_rate_pct: Number(r.sales_amount) > 0 ? round(Number(r.discount_amount) / Number(r.sales_amount) * 100) : null,
      average_income: Number(r.quantity) > 0 ? round(Number(r.income_amount) / Number(r.quantity)) : null,
      previous_quantity: Number(p?.quantity || 0), previous_income: Number(p?.income_amount || 0),
      income_delta: round(Number(r.income_amount) - Number(p?.income_amount || 0)),
      income_change_pct: comparable && Number(p?.income_amount) > 0 ? round((Number(r.income_amount) / Number(p.income_amount) - 1) * 100) : null,
      quantity_change_pct: comparable && Number(p?.quantity) > 0 ? round((Number(r.quantity) / Number(p.quantity) - 1) * 100) : null,
      daily_quantity: comparable ? round(Number(r.quantity) / period.days) : null,
      previous_daily_quantity: comparable ? round(Number(p?.quantity || 0) / period.days) : null,
      daily_income: comparable ? round(Number(r.income_amount) / period.days) : null,
      previous_daily_income: comparable ? round(Number(p?.income_amount || 0) / period.days) : null,
      is_new: comparable && !p };
  });
  const positive = rows.filter(r => r.quantity > 0 && r.income_amount > 0);
  const bestseller = [...positive].sort((a, b) => b.quantity - a.quantity).slice(0, 5);
  const revenueLeaders = [...positive].sort((a, b) => b.income_amount - a.income_amount).slice(0, 5);
  const declining = comparable ? rows.filter(r => r.previous_income > 0 && r.income_delta < 0).sort((a, b) => a.income_delta - b.income_delta).slice(0, 5) : [];
  const growing = comparable ? rows.filter(r => r.previous_income > 0 && r.income_delta > 0).sort((a, b) => b.income_delta - a.income_delta).slice(0, 5) : [];
  const disappeared = comparable ? before.filter(r => r.income_amount > 0 && !rows.some(x => x.product_name === r.product_name)).sort((a, b) => b.income_amount - a.income_amount).slice(0, 5) : [];
  const overallDiscount = Number(current.totals?.sales_amount) > 0 ? Number(current.totals.discount_amount) / Number(current.totals.sales_amount) * 100 : 0;
  const discountPressure = positive.filter(r => r.discount_rate_pct > overallDiscount && Number(r.discount_amount) > 0).sort((a, b) => b.discount_amount - a.discount_amount).slice(0, 5);
  const adjustments = [];
  for (const r of declining.slice(0, 3)) adjustments.push({ product_name: r.product_name, kind: '收入下滑', evidence: `收入较前期减少 ¥${Math.abs(r.income_delta).toFixed(2)}（${r.income_change_pct}%），数量 ${r.quantity}／前期 ${r.previous_quantity}`, action: '核对缺货、曝光位置和推荐执行；先恢复供应与展示，7天后复查销量，不直接判定应降价。' });
  for (const r of discountPressure.slice(0, 3)) adjustments.push({ product_name: r.product_name, kind: '折扣压力', evidence: `折扣 ¥${round(r.discount_amount).toFixed(2)}，折扣率 ${r.discount_rate_pct}%，全店品项 ${round(overallDiscount)}%`, action: '核查该品促销规则与让利来源，测算促销后的单位贡献；成本未核实前不直接加码优惠。' });
  for (const r of disappeared.slice(0, 2)) adjustments.push({ product_name: r.product_name, kind: '本期无销售记录', evidence: `前期收入 ¥${round(r.income_amount).toFixed(2)}，本期未出现`, action: '确认是否下架、改名或缺货；不能直接把无记录判为滞销。' });
  const observations = [];
  if (bestseller.length) observations.push(`销量领先：${bestseller.slice(0, 3).map(r => `「${r.product_name}」销量 ${r.quantity}、收入 ¥${round(r.income_amount).toFixed(2)}`).join('；')}。优先保证备货与出品。`);
  if (revenueLeaders.length) observations.push(`收入主力：${revenueLeaders.slice(0, 3).map(r => `「${r.product_name}」¥${round(r.income_amount).toFixed(2)}、占比 ${r.income_share_pct}%`).join('；')}。销量与收入领先不等于利润领先。`);
  if (growing.length) observations.push(`增长贡献最大：「${growing[0].product_name}」较前期增加 ¥${growing[0].income_delta.toFixed(2)}（${growing[0].income_change_pct}%）。`);
  if (declining.length) observations.push(`下滑影响最大：「${declining[0].product_name}」较前期减少 ¥${Math.abs(declining[0].income_delta).toFixed(2)}（${declining[0].income_change_pct}%）。`);
  if (!comparable) observations.push(`前期同长度区间 ${period.from} 至 ${period.to}，本期有品项记录 ${current.totals?.days || 0}/${period.days} 天、前期 ${previous.totals?.days || 0}/${period.days} 天；仅展示已导入金额，不宣称完整期间增长。`);
  return { ...current, all_products: rows, bestseller, revenue_leaders: revenueLeaders, growing, declining, disappeared, discount_pressure: discountPressure, adjustments, observations,
    quantity_note: '数量沿用每个品项的原报表计量。未提供统一计量单位，不将不同菜品的数量合计解释为总份数、订单量或客单价，只比较同一菜品的前后数量。',
    source_partition_note: 'sources是同一菜品报表内互斥的order_source分组，POS与扫码点餐的品项收入可以汇总为本期品项总收入，但该总收入不能再与综合营业统计收入相加。',
    comparison: { period, comparable, current_days: Number(current.totals?.days || 0), previous_days: Number(previous.totals?.days || 0), income: comparison(totalIncome, Number(previous.totals?.income_amount || 0), comparable) } };
}
function channelSummary(channel) {
  const base = channel.pos.filter(r => ['offline', 'delivery'].includes(r.channel_group));
  return { income: sum(base, 'actual_amount'), gross: sum(base, 'gross_amount') };
}
function enrichChannels(current, previous, period) {
  const comparable = current.pos_days === period.days && previous.pos_days === period.days;
  const match = (rows, keys, item) => rows.find(r => keys.every(k => r[k] === item[k]));
  const changes = current.pos.filter(r => ['offline', 'delivery'].includes(r.channel_group)).map(r => ({ ...r,
    ...comparison(Number(r.actual_amount), Number(match(previous.pos, ['channel'], r)?.actual_amount || 0), comparable) }));
  const platformChanges = current.platform.map(r => { const p = match(previous.platform, ['platform', 'channel'], r);return { ...r,
    ...comparison(Number(r.actual_amount), Number(p?.actual_amount || 0), Number(r.days) === period.days && Number(p?.days) === period.days) }; });
  const labels = { store_sales: '店内销售', pickup: '外带', meituan_delivery: '美团外卖', taobao_flash: '淘宝闪购', jd_delivery: '京东外卖' };
  const ranked = [...changes].sort((a, b) => b.current - a.current);
  const observations = ranked.slice(0, 4).map(r => `${labels[r.channel] || r.channel}：收银收入 ¥${r.current.toFixed(2)}${r.change_pct !== null ? `，较前期 ${r.change_pct}%（差额 ¥${r.delta.toFixed(2)}）` : '，前期缺失或不可比，暂不判定增减'}。`);
  if (platformChanges.length) observations.push(`平台真实实收单独核对：${platformChanges.slice(0, 4).map(r => `${r.platform} ¥${r.current.toFixed(2)}、${r.days}/${period.days}天有记录`).join('；')}，不与收银渠道再次相加。`);
  return { ...current, previous, changes, platform_changes: platformChanges, observations, comparison_period: period };
}
function enrichLedger(current, previous, period) {
  const expenses = current.categories.filter(r => Number(r.amount) < 0).map(r => {
    const prior = previous.categories.find(p => p.category_name === r.category_name && p.subcategory_name === r.subcategory_name);
    const amount = Math.abs(round(r.amount)), before = Math.abs(Math.min(0, Number(prior?.amount || 0)));
    return { ...r, expense_amount: amount, previous_amount: before, delta: round(amount - before), share_pct: Number(current.totals?.outflow) > 0 ? round(amount / Number(current.totals.outflow) * 100) : 0 };
  });
  const observations = [`本期账本流出 ¥${round(current.totals?.outflow).toFixed(2)}；前期 ${period.from} 至 ${period.to} 登记流出 ¥${round(previous.totals?.outflow).toFixed(2)}。这是登记付款比较，集中付款时间会影响金额，不等于经营成本增长。`, ...expenses.slice(0, 3).map(r => `「${r.category_name}／${r.subcategory_name}」净支出 ¥${r.expense_amount.toFixed(2)}，占账本总流出 ${r.share_pct}%，较前期登记差额 ¥${r.delta.toFixed(2)}。`)];
  return { ...current, previous, expense_changes: expenses, observations, comparison_period: period };
}
function managementReport(facts, period) {
  const { channels: c, dishes: d, ledger: l } = facts;
  const previous = c.previous;
  const current = channelSummary(c), before = channelSummary(previous);
  const income = comparison(current.income, before.income, c.pos_days === period.days && previous.pos_days === period.days);
  const findings = [`收银营业收入 ¥${current.income.toFixed(2)}，营业额 ¥${current.gross.toFixed(2)}；团购嵌入核对记录、支付方式和平台结算没有重复加到收入。`, ...d.observations];
  if (income.comparable && income.previous > 0) findings.splice(1, 0, `较前一个同长度区间，收银营业收入${income.delta >= 0 ? '增加' : '减少'} ¥${Math.abs(income.delta).toFixed(2)}（${income.change_pct}%）；前期 ¥${income.previous.toFixed(2)}。`);
  const expenses = l.categories.filter(r => Number(r.amount) < 0).slice(0, 3);
  if (expenses.length) findings.push(`账本支出重点：${expenses.map(r => `「${r.category_name}／${r.subcategory_name}」¥${Math.abs(round(r.amount)).toFixed(2)}`).join('；')}。按实际登记解释现金支出，不把净现金流当利润。`);
  const actions = d.adjustments.map(r => ({ priority: r.kind === '收入下滑' ? 'P1' : 'P2', owner: '店长／运营', action: `${r.product_name}：${r.action}`, evidence: r.evidence, review: '7天后对比日均销量、收入和折扣率' }));
  if (d.bestseller.length) actions.unshift({ priority: 'P1', owner: '店长／厨房', action: `保证${d.bestseller.slice(0, 3).map(r => `「${r.product_name}」`).join('、')}的高峰供应与出品稳定；用现有销量作备货基线。`, evidence: d.bestseller.slice(0, 3).map(r => `${r.product_name} 销量 ${r.quantity}`).join('；'), review: '每周检查售罄、退菜及日均销量' });
  for (const r of (l.expense_changes || []).slice(0, 2)) actions.push({ priority: 'P2', owner: '财务／店长', action: `核实「${r.category_name}／${r.subcategory_name}」付款所对应的期间、数量与单价，分清集中付款和实际消耗变化后再决定压缩预算。`, evidence: `本期净登记 ¥${r.expense_amount.toFixed(2)}，前期 ¥${r.previous_amount.toFixed(2)}，差额 ¥${r.delta.toFixed(2)}`, review: '按同一费用所属期间复核，避免把付款时间变化当成本增长' });
  const warnings = [];
  if (!income.comparable) warnings.push(`收银本期 ${c.pos_days}/${period.days} 天、前期 ${previous.pos_days}/${period.days} 天有记录；期间变化暂不认定为完整增长。`);
  if (!d.comparison.comparable) warnings.push('菜品前后期记录天数不完整，增长／下滑分类暂不判定。');
  if (!c.platform.length) warnings.push('没有第三方平台实收数据，平台真实收入占比不可判断。');
  if (warnings.length) actions.push({ priority: 'P0', owner: '数据／财务', action: warnings.join(' '), evidence: '仅补齐或确认缺失记录，不把缺失补为0', review: '补齐后重跑分析' });
  return { version: 2, execution: 'parallel', current_period: c.current_period, comparison_period: period, business: { ...current, income_comparison: income }, product_analysis: { bestseller: d.bestseller, revenue_leaders: d.revenue_leaders, growing: d.growing, declining: d.declining, adjustments: d.adjustments, comparison: d.comparison },
    quantity_note: d.quantity_note, source_partition_note: d.source_partition_note,
    coverage: { expected_days: period.days, pos_days: c.pos_days, dish_days: Number(d.totals?.days || 0), ledger_days: Number(l.totals?.days || 0) },
    metrics: { pos_store_sales: c.pos_store_sales, dish_income: round(d.totals?.income_amount), ledger_inflow: round(l.totals?.inflow), ledger_outflow: round(l.totals?.outflow), top_four_dish_income: sum(d.revenue_leaders.slice(0, 4), 'income_amount'), discount_rate_pct: Number(d.totals?.sales_amount) > 0 ? round(Number(d.totals.discount_amount) / Number(d.totals.sales_amount) * 100) : 0 },
    channel_changes: c.changes, expense_changes: l.expense_changes,
    findings, actions, warnings, boundary: '经营结论基于已导入数据；调整由负责人决定。未修改经营数据、价格或发送群消息。' };
}
module.exports = { previousPeriod, comparison, products, enrichDishes, enrichChannels, enrichLedger, managementReport };
