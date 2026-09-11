/** 验证风控对账字段与内部一致性（只读） */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
// 密钥不硬编码，见 auth.js
const { signProbeToken } = require('./auth');
const H = { Authorization: 'Bearer ' + signProbeToken({ username: 'riskchk', display_name: '风控校验' }, '15m', ROOT) };
const api = async (p) => { const r = await fetch('http://127.0.0.1:3456' + p, { headers: H }); const j = await r.json(); if (j.ok === false) throw new Error(JSON.stringify(j).slice(0, 200)); return j; };
const r2 = (v) => Math.round(v * 100) / 100;
let pass = 0, fail = 0;
const check = (label, ok, detail) => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label} :: ${detail}`); ok ? pass++ : fail++; };

(async () => {
  const d = await api('/api/poultry/accounting?date_from=2026-05-01&date_to=2026-09-10&channel=all');
  check('返回风控字段', (d.summary.birds || []).every(b => b.risk), `${(d.summary.birds || []).length} 种禽`);
  check('返回未覆盖份数（风控可信度用）', typeof d.summary.uncovered_quantity === 'number',
    `uncovered=${d.summary.uncovered_quantity} = 总 ${d.summary.total_quantity} − 覆盖 ${d.summary.covered_quantity}`);
  check('未覆盖份数 = 总 − 覆盖', Math.abs(d.summary.uncovered_quantity - (d.summary.total_quantity - d.summary.covered_quantity)) < 0.02, 'ok');

  for (const b of d.summary.birds) {
    const rk = b.risk;
    check(`【${b.breed_name}】加工只数 = 模型只数`, rk.processed_birds === b.birds_count, `${rk.processed_birds} vs ${b.birds_count}`);
    check(`【${b.breed_name}】身体差额 = 只数 − 身体已记录`, Math.abs(rk.body_gap - r2(b.birds_count - b.body_birds)) < 0.02,
      `${rk.body_gap} = ${b.birds_count} − ${b.body_birds}`);
    for (const p of rk.byproducts) {
      check(`【${b.breed_name}】${p.part_name} 应有 = 只数 × 一只出`, Math.abs(p.expected - r2(b.birds_count * p.parts_per_bird)) < 0.02,
        `${p.expected} = ${b.birds_count} × ${p.parts_per_bird}`);
      check(`【${b.breed_name}】${p.part_name} 差额 = 应有 − 实际`, Math.abs(p.gap - r2(p.expected - p.demand)) < 0.02,
        `${p.gap} = ${p.expected} − ${p.demand}`);
    }
    // 副产品冲突判定
    const implied = rk.byproducts.map(p => p.implied_birds);
    if (implied.length > 1) {
      const spread = r2(Math.max(...implied) - Math.min(...implied));
      check(`【${b.breed_name}】冲突判定阈值自洽`, Math.abs(spread - rk.byproduct_spread) < 0.02,
        `spread=${rk.byproduct_spread} conflict=${rk.byproduct_conflict}`);
    }
  }

  // 单店案例
  const stores = (await api('/api/db/stores?page=1&page_size=500')).stores;
  const st = stores.find(s => s.store_name.includes('欧景'));
  const d2 = await api(`/api/poultry/accounting?store_id=${st.id}&date_from=2026-09-01&date_to=2026-09-10&channel=all`);
  const b2 = d2.summary.birds[0];
  check('欧景店只数 ≈ 门店记录的 80', Math.abs(b2.birds_count - 80) / 80 < 0.1, `${b2.birds_count} 只（门店记录 80，差 ${r2(Math.abs(b2.birds_count - 80))}）`);
  check('欧景店风控报出头颈缺口', b2.risk.byproducts.some(p => p.part_name.includes('颈') && p.gap > 1),
    b2.risk.byproducts.map(p => `${p.part_name} 差${p.gap}`).join(' | '));

  console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
