/** 只读：按「副产品反推加工只数」做食材去向对账，看看会报出什么 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
// 密钥不硬编码，见 auth.js
const { signProbeToken } = require('./auth');
const H = { Authorization: 'Bearer ' + signProbeToken({ username: 'risk', display_name: '风控模拟' }, '15m', ROOT) };
const api = async (p) => { const r = await fetch('http://127.0.0.1:3456' + p, { headers: H }); const j = await r.json(); if (j.ok === false) throw new Error(JSON.stringify(j).slice(0, 200)); return j; };

(async () => {
  const stores = (await api('/api/db/stores?page=1&page_size=500')).stores;
  const cases = [
    ['全部门店 2026-05-01 ~ 09-10', '/api/poultry/accounting?date_from=2026-05-01&date_to=2026-09-10&channel=all'],
  ];
  const oujing = stores.find(s => s.store_name.includes('欧景'));
  cases.push([`欧景花园店 2026-09-01 ~ 09-10`, `/api/poultry/accounting?store_id=${oujing.id}&date_from=2026-09-01&date_to=2026-09-10&channel=all`]);

  for (const [label, q] of cases) {
    const d = await api(q);
    console.log('════════ ' + label + ' ════════');
    console.log(`销量覆盖率 = ${Math.round(d.summary.covered_rate * 1000) / 10}%（已覆盖 ${d.summary.covered_quantity} / ${d.summary.total_quantity} 份）`);
    console.log('');
    for (const b of d.summary.birds) {
      const parts = (d.parts || []).filter(p => p.bird_id === b.bird_id);
      const byp = parts.filter(p => p.part_kind === '副产品');
      const body = parts.filter(p => p.part_kind !== '副产品');
      const N = b.birds_count;
      console.log(`【${b.animal}·${b.breed_name}】模型只数 N = ${N} 只  （身体 ${b.body_birds} / 副产品瓶颈 ${b.byproduct_birds}）`);
      console.log('');
      console.log('  ① 身体：应有 N 只份量的肉 → 实际记录到 ' + b.body_birds + ' 只份量');
      const bodyGap = Math.round((N - b.body_birds) * 100) / 100;
      console.log(`     差额 = ${bodyGap} 只份量（${Math.round((bodyGap / N) * 1000) / 10}%）`);
      console.log('');
      console.log('  ② 副产品互相校验（都来自同一批鹅，推算只数应基本一致）：');
      byp.forEach(p => {
        const expected = Math.round(N * p.parts_per_bird * 100) / 100;
        const gap = Math.round((expected - p.demand) * 100) / 100;
        console.log(`     ${String(p.part_name).padEnd(10)} 一只出${String(p.parts_per_bird).padStart(5)}  实际记录=${String(p.demand).padStart(9)}  应有=${String(expected).padStart(10)}  差=${String(gap).padStart(10)}  → 反推只数 ${p.birds}`);
      });
      const implied = byp.map(p => p.birds);
      if (implied.length > 1) {
        const spread = Math.round((Math.max(...implied) - Math.min(...implied)) * 100) / 100;
        console.log(`     副产品之间推算只数差 = ${spread} 只 ${spread > Math.max(2, Math.max(...implied) * 0.1) ? '  ← 明显不一致' : '  ← 基本一致'}`);
      }
      console.log('');
      console.log('  ③ 身体各部位明细（看是谁贡献的份量）：');
      body.sort((x, y) => y.demand - x.demand).slice(0, 12).forEach(p =>
        console.log(`     ${String(p.part_name).padEnd(12)} 需求=${String(p.demand).padStart(9)} 份  一只出${String(p.parts_per_bird).padStart(6)}  折 ${String(p.birds).padStart(9)} 只`));
      console.log('');
    }
  }
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
