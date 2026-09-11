/**
 * 用生产核算接口的返回结果（已按 绑定→名称+规格→名称唯一 三级匹配）做口径对比
 *   A 当前实现：Σ(各菜品折鸟数)         —— 把同一只鸟的多个部位各算一只鸟
 *   B 全部取最大：max(各部位折鸟数)
 *   C 正确模型：max(身体部位折鸟数之和, 各副产品折鸟数)
 */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
// 密钥不硬编码，见 auth.js
const { signProbeToken } = require('./auth');
const TOKEN = signProbeToken({ username: 'analyze', display_name: '口径分析' }, '15m', ROOT);

// 部位分类：决定它是「抢同一块身体」还是「随鸟附带」
// 依据：一只鹅的身体（上庄/下庄/腿/腩/肉）只能卖一次；翅/头颈/掌/杂 是随鸟附带的副产品
const BYPRODUCT = ['战斧', '鹅头带颈', '鹅掌', '鹅杂', '鹅翅', '鹅肝', '鹅肠', '鹅汁'];
const classify = (part) => BYPRODUCT.some(k => String(part).includes(k)) ? '副产品' : '身体';

(async () => {
  const url = 'http://127.0.0.1:3456/api/poultry/accounting?date_from=2026-05-01&date_to=2026-09-10&channel=all';
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN } });
  const data = await res.json();
  if (!data.ok) throw new Error('接口返回异常: ' + JSON.stringify(data).slice(0, 200));

  console.log(`区间 ${data.period.date_from} ~ ${data.period.date_to}  总销量=${data.summary.total_quantity} 份`);
  console.log('');

  // 按部位汇总（口径A 的逐行只数由接口给出）
  const parts = new Map();
  for (const row of data.dishes) {
    const key = row.part_name;
    if (!parts.has(key)) parts.set(key, { part: key, kind: classify(key), per: row.parts_per_bird, demand: 0, birdsA: 0, dishes: [] });
    const b = parts.get(key);
    b.demand += row.quantity * row.usage_qty;
    b.birdsA += row.birds_count;
    b.dishes.push(row);
  }
  const list = [...parts.values()].map(p => ({ ...p, birds: p.per > 0 ? p.demand / p.per : 0 }))
    .sort((a, b) => b.birdsA - a.birdsA);

  console.log('════ 各部位（口径A 逐行相加的贡献） ════');
  console.log('部位'.padEnd(14) + '类别'.padEnd(8) + '一只出成'.padStart(10) + '总需求(份)'.padStart(12) + '按A折鸟'.padStart(10) + '按部位折鸟'.padStart(12));
  list.forEach(p => console.log(
    p.part.padEnd(14) + p.kind.padEnd(8) + String(p.per).padStart(10)
    + String(Math.round(p.demand * 100) / 100).padStart(12)
    + String(Math.round(p.birdsA * 100) / 100).padStart(10)
    + String(Math.round(p.birds * 100) / 100).padStart(12)));

  const totalA = list.reduce((s, p) => s + p.birdsA, 0);
  const totalB = list.length ? Math.max(...list.map(p => p.birds)) : 0;

  const body = list.filter(p => p.kind === '身体');
  const byp = list.filter(p => p.kind === '副产品');
  const bodySum = body.reduce((s, p) => s + p.birds, 0);
  const bypMax = byp.length ? Math.max(...byp.map(p => p.birds)) : 0;
  const totalC = Math.max(bodySum, bypMax);

  console.log('');
  console.log('════ 三种口径 ════');
  console.log(`  A 当前实现（逐行相加）        = ${Math.round(totalA * 100) / 100} 只`);
  console.log(`  B 全部取最大                  = ${Math.round(totalB * 100) / 100} 只`);
  console.log(`  C 身体求和 / 副产品取最大      = ${Math.round(totalC * 100) / 100} 只`);
  console.log(`      · 身体部位合计（相加）      = ${Math.round(bodySum * 100) / 100} 只   [${body.map(p => p.part).join('、')}]`);
  console.log(`      · 副产品瓶颈（取最大）      = ${Math.round(bypMax * 100) / 100} 只   [${byp.map(p => p.part + ':' + (Math.round(p.birds * 100) / 100)).join('、') || '无'}]`);
  console.log(`      · 结论：瓶颈是 ${bodySum >= bypMax ? '身体部位' : '副产品'}`);
  console.log('');
  console.log(`  A 比 C 多算 ${Math.round((totalA - totalC) * 100) / 100} 只（${totalC > 0 ? Math.round((totalA / totalC) * 100) / 100 : '-'} 倍）`);
  console.log(`  B 比 C 少算 ${Math.round((totalC - totalB) * 100) / 100} 只（B 把互斥的身体卖法当成了同一批鸟）`);

  console.log('');
  console.log('════ 每个部位被哪些菜品消耗 ════');
  list.forEach(p => {
    console.log(`  【${p.part}】${p.kind} 一只出${p.per} → 需求${Math.round(p.demand * 100) / 100}份，按部位折 ${Math.round(p.birds * 100) / 100} 只`);
    p.dishes.forEach(d => console.log(`      ${d.menu_name}${d.menu_spec ? ' · ' + d.menu_spec : ''}  销量${d.quantity} × ${d.usage_qty} = ${Math.round(d.quantity * d.usage_qty)} 份  → ${d.birds_count} 只`));
  });

  console.log('');
  console.log('════ 覆盖率 ════');
  console.log(`  覆盖销量 ${data.summary.covered_quantity} / ${data.summary.total_quantity} = ${Math.round(data.summary.covered_rate * 1000) / 10}%`);
  console.log(`  未绑定 ${data.coverage.unbound.length} 项 / ${data.coverage.unbound_quantity} 份`);
  console.log(`  已绑定但未配出成 ${data.coverage.no_usage.length} 项 / ${data.coverage.no_usage_quantity} 份`);
  console.log('  未绑定 top8:');
  data.coverage.unbound.slice(0, 8).forEach(u => console.log(`      ${u.product_name}${u.spec && u.spec !== '--' ? ' [' + u.spec + ']' : ''}  ${u.quantity} 份`));
  console.log('  未配出成 top8:');
  data.coverage.no_usage.slice(0, 8).forEach(u => console.log(`      ${u.menu_name}${u.menu_spec ? ' · ' + u.menu_spec : ''}  ${u.quantity} 份`));
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
