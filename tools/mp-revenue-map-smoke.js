/**
 * 营业数据「口径映射」回归测试
 *
 * 思路：直接调用真实后台的 /api/business-analytics/overview 取数，
 *      喂给 lib/mp/revenue-map.js 做映射，再逐项校验映射后的数字
 *      == 后台接口原始数字（一个都不许重算、不许漂移）。
 *
 * 用法：node tools/mp-revenue-map-smoke.js [baseUrl]
 */
const path = require('path');
const { mapOverviewToMobile, r2 } = require(path.join(__dirname, '..', 'lib', 'mp', 'revenue-map'));

const BASE = process.argv[2] || 'http://localhost:3456';
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + ' ' + extra); }
}
const near = (a, b, tol = 0.02) => Math.abs(Number(a || 0) - Number(b || 0)) <= tol;
const money = n => Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 });

(async () => {
  console.log('\n=== 营业数据口径映射回归 → ' + BASE + ' ===\n');

  const lr = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const lj = await lr.json();
  if (!lj.token) { console.log('❌ 登录失败（后台是否在运行？）'); process.exit(1); }
  const H = { Authorization: 'Bearer ' + lj.token };
  const getOv = async (sid, d) => {
    const r = await fetch(BASE + '/api/business-analytics/overview?date_from=' + d + '&date_to=' + d + '&store_id=' + sid, { headers: H });
    if (r.status !== 200) throw new Error('overview HTTP ' + r.status);
    return r.json();
  };

  const CASES = [
    { sid: 9, name: '方洲店', date: '2026-09-09', expectRevenue: 4453.64 },
    { sid: 25, name: '麦地店', date: '2026-09-09', expectRevenue: null },
    { sid: 10, name: '普宁店', date: '2026-09-08', expectRevenue: null },
  ];

  for (const c of CASES) {
    console.log('[' + c.name + ' ' + c.date + ']');
    const ov = await getOv(c.sid, c.date);
    const dto = mapOverviewToMobile(ov, {
      store: { id: c.sid, store_name: c.name }, date: c.date,
      dates: [c.date], prevDate: null, nextDate: null, compareOv: null,
    });

    check('营业额 == 后台 totals.gross_amount', near(dto.summary.revenue, ov.totals.gross_amount),
      'DTO ' + dto.summary.revenue + ' vs 后台 ' + ov.totals.gross_amount);
    check('实收 == 后台 totals.confirmed', near(dto.summary.actual_revenue, ov.totals.confirmed));
    check('订单数 == 后台 totals.order_count', Number(dto.summary.order_count) === Number(ov.totals.order_count));
    check('客户优惠 == 后台 totals.discount_amount', near(dto.summary.discount_amount, ov.totals.discount_amount));
    check('平台费用 == 后台 totals.fees', near(dto.summary.platform_fee, ov.totals.fees));
    check('平台入账 == 后台 totals.platform_income_amount', near(dto.summary.platform_income, ov.totals.platform_income_amount));
    check('客单价 == 实收 / 订单数', Number(ov.totals.order_count) > 0
      ? near(dto.summary.avg_order_value, ov.totals.confirmed / ov.totals.order_count) : true);

    const chSec = dto.sections.find(s => s.key === 'channel');
    check('渠道构成合计 == 各渠道确认收入之和', chSec
      ? near(chSec.total, (ov.channel_breakdown || []).filter(x => Number(x.amount) > 0).reduce((a, b) => a + b.amount, 0)) : true);
    check('渠道分组合计 == offline + delivery + group_buy',
      near((dto.sections.find(s => s.key === 'group') || {}).total || 0, (ov.totals.offline || 0) + (ov.totals.delivery || 0) + (ov.totals.group_buy || 0)));
    check('metrics 下发 6 项且无空值', dto.metrics.length === 6 && dto.metrics.every(m => m.value !== undefined && m.value !== null));
    check('sections 至少含渠道构成', dto.sections.length >= 1 && !!chSec);

    if (c.expectRevenue !== null) {
      check('已知基准值 ¥' + money(c.expectRevenue) + ' 命中（方洲店 09-09）', near(dto.summary.revenue, c.expectRevenue),
        '实际 ' + dto.summary.revenue);
    }

    console.log('      ℹ️  营业额 ¥' + money(dto.summary.revenue) + ' / 实收 ¥' + money(dto.summary.actual_revenue)
      + ' / 订单 ' + dto.summary.order_count + ' / 客单价 ¥' + money(dto.summary.avg_order_value));
    if (dto.summary.gross_pending) console.log('      ⚠️  后台标记 gross_pending：营业额暂缺美团外卖营业日报');
    console.log('      ℹ️  ' + dto.sections.map(s => s.title + '(' + s.items.length + ')').join(' / '));
  }

  // 环比：用前一日的 overview 计算
  console.log('\n[环比一致性]');
  const d1 = '2026-09-09', d0 = '2026-09-08';
  const ov1 = await getOv(9, d1);
  const ov0 = await getOv(9, d0);
  const dto = mapOverviewToMobile(ov1, {
    store: { id: 9, store_name: '方洲店' }, date: d1, dates: [d1, d0],
    prevDate: d0, nextDate: null, compareOv: ov0,
  });
  check('环比基准 == 前一日的 gross_amount', near(dto.compare.revenue, ov0.totals.gross_amount),
    dto.compare.revenue + ' vs ' + ov0.totals.gross_amount);
  check('环比差额 == 本日 - 前一日', near(dto.compare.revenue_diff, ov1.totals.gross_amount - ov0.totals.gross_amount));
  console.log('      ℹ️  ' + d1 + ' ¥' + money(dto.summary.revenue) + ' ← ' + d0 + ' ¥' + money(dto.compare.revenue)
    + '（' + dto.compare.revenue_pct + '%）');

  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
