/** 只读体检：用户真实配置（部位表 + 绑定的菜品），找下拉可能选不到的项 */
const fs = require('fs');
const path = require('path');
const ROOT = 'F:\\NewDeom';
(async () => {
  const initSqlJs = require(path.join(ROOT, 'node_modules', 'sql.js'));
  const SQL = await initSqlJs();
  const mem = new SQL.Database(fs.readFileSync(path.join(ROOT, 'data', 'database.sqlite')));
  const q = (s, p = []) => { const st = mem.prepare(s); st.bind(p); const o = []; while (st.step()) o.push(st.getAsObject()); st.free(); return o; };

  console.log('=== 禽类档案 ===');
  q('SELECT id, animal, breed_name, net_weight_kg, unit_cost, status FROM poultry_birds').forEach(r =>
    console.log(`  #${r.id} ${r.animal}/${r.breed_name} 净重=${r.net_weight_kg}kg 成本=${r.unit_cost} 状态=${r.status}`));

  console.log('\n=== 出成部位（下拉数据源，按品种） ===');
  q(`SELECT y.id, y.part_name, y.parts_per_bird, y.part_weight_g, b.animal, b.breed_name,
       (SELECT COUNT(*) FROM poultry_dish_usage u WHERE u.yield_id=y.id) AS used
     FROM poultry_yields y JOIN poultry_birds b ON b.id=y.bird_id
     ORDER BY b.id, y.sort_order, y.id`).forEach(r =>
    console.log(`  #${r.id} ${r.animal}/${r.breed_name} · ${r.part_name}  一只出=${r.parts_per_bird}  克重=${r.part_weight_g || '-'}  被${r.used}个菜引用`));

  console.log('\n=== 已绑定的菜品耗用 ===');
  q(`SELECT m.name, m.spec, m.category, y.part_name, y.parts_per_bird, u.usage_qty, b.animal
     FROM poultry_dish_usage u
     JOIN menu_items m ON m.id=u.menu_item_id
     JOIN poultry_yields y ON y.id=u.yield_id
     JOIN poultry_birds b ON b.id=y.bird_id
     ORDER BY m.category, m.name, u.sort_order`).forEach(r =>
    console.log(`  ${r.name}${r.spec ? ' · ' + r.spec : ''}  [${r.category || '未分类'}]  <- ${r.animal}·${r.part_name} ×${r.usage_qty}  每份折合 ${Math.round((r.usage_qty / r.parts_per_bird) * 10000) / 10000} 只`));

  console.log('\n=== 体检结论 ===');
  const badYield = q('SELECT id, part_name, parts_per_bird FROM poultry_yields WHERE parts_per_bird <= 0');
  console.log('  出成<=0 的部位（会被下拉过滤掉）: ' + (badYield.length ? JSON.stringify(badYield) : '无 ✅'));
  const y = q('SELECT COUNT(*) n FROM poultry_yields')[0].n;
  console.log('  部位总数 = ' + y);
  const usageNoYield = q(`SELECT COUNT(*) n FROM poultry_dish_usage u
     LEFT JOIN poultry_yields y ON y.id=u.yield_id WHERE y.id IS NULL`)[0].n;
  console.log('  绑定指向已删部位（下拉会显示空白）: ' + usageNoYield + (usageNoYield ? ' ⚠️' : ' ✅'));
  const dishCount = q('SELECT COUNT(DISTINCT menu_item_id) n FROM poultry_dish_usage')[0].n;
  const dishAll = q('SELECT COUNT(*) n FROM menu_items')[0].n;
  console.log(`  已配置菜品 = ${dishCount} / ${dishAll}`);
  const perPortion = q(`SELECT m.name, u.usage_qty / y.parts_per_bird AS per
     FROM poultry_dish_usage u JOIN menu_items m ON m.id=u.menu_item_id
     JOIN poultry_yields y ON y.id=u.yield_id WHERE u.usage_qty / y.parts_per_bird > 1`);
  console.log('  每份折合 > 1 只（页面会提示复核）: ' + (perPortion.length ? perPortion.map(r => `${r.name}(${Math.round(r.per * 100) / 100}只)`).join(', ') : '无 ✅'));
  mem.close();
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
