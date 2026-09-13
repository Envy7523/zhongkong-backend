/**
 * 端到端验收：小程序接口（/api/mp）vs PC 后台接口
 *
 * 核心断言：/api/mp/revenue 的每一个数字都必须等于 /api/business-analytics/overview，
 *          一个都不许漂移（这是这次搬迁的唯一目的）。
 *
 * 用法：node tools/mp-e2e-smoke.js [baseUrl]      默认 http://localhost:3456
 */
const BASE = process.argv[2] || 'http://localhost:3456';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + ' ' + extra); }
}
const near = (a, b, tol = 0.02) => Math.abs(Number(a || 0) - Number(b || 0)) <= tol;
const money = n => Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 });

(async () => {
  console.log('\n=== 端到端验收：小程序接口 ↔ PC 后台接口 → ' + BASE + ' ===\n');

  // ---------- 鉴权 ----------
  console.log('[1] 鉴权');
  check('小程序接口无 token → 401', (await fetch(BASE + '/api/mp/revenue?store_id=9')).status === 401);

  const pcLogin = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json();
  check('PC 后台登录成功', !!pcLogin.token);

  const mpLogin = await (await fetch(BASE + '/api/mp/auth/login/password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json();
  check('小程序登录成功（同一个 users 表）', !!mpLogin.token);
  if (!mpLogin.token || !pcLogin.token) { console.log('\n登录失败，终止\n'); process.exit(1); }

  const MH = { Authorization: 'Bearer ' + mpLogin.token };
  const PH = { Authorization: 'Bearer ' + pcLogin.token };
  const mget = async (p) => (await fetch(BASE + p, { headers: MH })).json();
  const pget = async (p) => (await fetch(BASE + p, { headers: PH })).json();

  check('mp token 不能调 PC 接口（两套 token 隔离）', (await fetch(BASE + '/api/db/stores/stats', { headers: MH })).status === 401);

  // ---------- 门店列表 ----------
  console.log('\n[2] 门店列表');
  const stores = await mget('/api/mp/stores');
  check('返回门店数组', Array.isArray(stores.stores) && stores.stores.length > 0, '数量 ' + stores.stores?.length);
  const fz = stores.stores.find(s => s.store_name.includes('方洲'));
  check('含方洲店且带 id', !!fz && !!fz.id);

  // ---------- 逐项比对 ----------
  console.log('\n[3] 营业额等指标：小程序接口 == 后台接口');
  const CASES = [
    { sid: fz ? fz.id : 9, name: '方洲店', date: '2026-09-09', expect: 4453.64 },
    { sid: 25, name: '麦地店', date: '2026-09-09', expect: null },
    { sid: 10, name: '普宁店', date: '2026-09-08', expect: null },
  ];
  for (const c of CASES) {
    const mp = await mget('/api/mp/revenue?store_id=' + c.sid + '&date=' + c.date);
    const pc = await pget('/api/business-analytics/overview?date_from=' + c.date + '&date_to=' + c.date + '&store_id=' + c.sid);
    const label = c.name + ' ' + c.date;

    check(label + ' found=true', mp.found === true, JSON.stringify(mp).slice(0, 120));
    check(label + ' 营业额 == 后台 gross_amount', near(mp.summary.revenue, pc.totals.gross_amount),
      '小程序 ' + mp.summary.revenue + ' vs 后台 ' + pc.totals.gross_amount);
    check(label + ' 实收 == 后台 confirmed', near(mp.summary.actual_revenue, pc.totals.confirmed),
      mp.summary.actual_revenue + ' vs ' + pc.totals.confirmed);
    check(label + ' 订单数 == 后台 order_count', Number(mp.summary.order_count) === Number(pc.totals.order_count));
    check(label + ' 客户优惠 == 后台 discount_amount', near(mp.summary.discount_amount, pc.totals.discount_amount));
    check(label + ' 平台费用 == 后台 fees', near(mp.summary.platform_fee, pc.totals.fees));
    check(label + ' 平台入账 == 后台 platform_income_amount', near(mp.summary.platform_income, pc.totals.platform_income_amount));
    check(label + ' 数据源标记为 getOverview', mp.source === 'business_analytics.getOverview', mp.source);
    if (c.expect !== null) {
      check(label + ' 与后台已知基准 ¥' + money(c.expect) + ' 一致', near(mp.summary.revenue, c.expect), '实际 ' + mp.summary.revenue);
    }
    console.log('      ℹ️  ¥' + money(mp.summary.revenue) + ' / 实收 ¥' + money(mp.summary.actual_revenue)
      + ' / 订单 ' + mp.summary.order_count + ' / 分组 ' + mp.sections.map(s => s.title).join('、'));
  }

  // ---------- 环比 ----------
  console.log('\n[4] 环比（同样以后台为准）');
  const mpA = await mget('/api/mp/revenue?store_id=' + (fz ? fz.id : 9) + '&date=2026-09-09');
  const pcPrev = await pget('/api/business-analytics/overview?date_from=' + mpA.prev_date + '&date_to=' + mpA.prev_date + '&store_id=' + (fz ? fz.id : 9));
  check('prev_date 有值', !!mpA.prev_date, String(mpA.prev_date));
  check('环比基准 == 前一日后台 gross_amount', near(mpA.compare.revenue, pcPrev.totals.gross_amount),
    mpA.compare.revenue + ' vs ' + pcPrev.totals.gross_amount);

  // ---------- 空状态 ----------
  console.log('\n[5] 空状态与容错');
  const empty = await mget('/api/mp/revenue?store_id=' + (fz ? fz.id : 9) + '&date=2020-01-01');
  check('无数据日期 → found=false 且有提示', empty.found === false && !!empty.message);
  check('缺 store_id → 400', (await fetch(BASE + '/api/mp/revenue', { headers: MH })).status === 400);
  check('不存在的门店 → 404', (await fetch(BASE + '/api/mp/revenue?store_id=999999', { headers: MH })).status === 404);

  // ---------- 协同事项（只读，验证与 F 版 service 签名兼容）----------
  console.log('\n[6] 协同事项（服务签名兼容性，只读）');
  const issues = await mget('/api/mp/collab/issues?pageSize=5');
  check('列表可读（listIssues 适配 user 参数）', Array.isArray(issues.rows), JSON.stringify(issues).slice(0, 150));
  check('返回 total', typeof issues.total === 'number', 'total=' + issues.total);
  if (issues.rows && issues.rows.length) {
    const one = await mget('/api/mp/collab/issues/' + issues.rows[0].id);
    check('详情可读（getIssueDetail 适配 user 参数）', !!one.issue && Array.isArray(one.replies));
    check('详情下发 next_status 供前端渲染按钮', Array.isArray(one.issue.next_status));
  }
  const stats = await mget('/api/mp/collab/stats');
  check('状态统计可读', !!stats.stats && typeof stats.stats.total === 'number');

  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('验收异常:', e.message); process.exit(1); });
