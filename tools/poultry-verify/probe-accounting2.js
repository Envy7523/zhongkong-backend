/** 只读：门店匹配 / 采购侧数据是否存在 */
const fs = require('fs');
const path = require('path');
const ROOT = process.argv[2] || 'F:\\NewDeom';
const DB_PATH = path.join(ROOT, 'data', 'database.sqlite');
(async () => {
  const initSqlJs = require(path.join(ROOT, 'node_modules', 'sql.js'));
  const SQL = await initSqlJs();
  const mem = new SQL.Database(fs.readFileSync(DB_PATH));
  const q = (s, p = []) => { const st = mem.prepare(s); st.bind(p); const o = []; while (st.step()) o.push(st.getAsObject()); st.free(); return o; };
  const one = (s, p = []) => q(s, p)[0] || {};

  console.log('stores=' + one('SELECT COUNT(*) n FROM stores').n);
  const names = q('SELECT DISTINCT store_name FROM dish_sales');
  let ok = [], bad = [];
  for (const r of names) (one('SELECT id FROM stores WHERE store_name=?', [r.store_name]).id ? ok : bad).push(r.store_name);
  console.log('dish_sales 门店 ' + names.length + ' 个，匹配 stores 的 ' + ok.length + '，未匹配 ' + bad.length);
  if (bad.length) console.log(' 未匹配: ' + JSON.stringify(bad));

  console.log('\n=== 表格清单（找采购/进货侧） ===');
  q("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").forEach(r => console.log('  ' + r.name));

  console.log('\n=== store_supplies 结构 ===');
  q('PRAGMA table_info(store_supplies)').forEach(r => console.log('  ' + r.name + ' ' + r.type));
  console.log('  行数=' + one('SELECT COUNT(*) n FROM store_supplies').n);

  console.log('\n=== bookkeeping 里禽类相关 ===');
  try {
    console.log('  entries 行数=' + one('SELECT COUNT(*) n FROM bookkeeping_entries').n);
    q("SELECT * FROM bookkeeping_entries LIMIT 1").forEach(r => console.log('  样例=' + JSON.stringify(r)));
    console.log('  含鹅/鸭/鸡的条目数=' + one("SELECT COUNT(*) n FROM bookkeeping_entries WHERE item LIKE '%鹅%' OR item LIKE '%鸭%' OR item LIKE '%鸡%' OR remark LIKE '%鹅%'").n);
  } catch (e) { console.log('  ' + e.message); }

  console.log('\n=== cost_accounting 结构 ===');
  try { q('PRAGMA table_info(cost_accounting)').forEach(r => console.log('  ' + r.name + ' ' + r.type)); } catch (e) { console.log(e.message); }
  console.log('  行数=' + one('SELECT COUNT(*) n FROM cost_accounting').n);

  console.log('\n=== menu_items 分类与规格分布 ===');
  q("SELECT category, COUNT(*) n FROM menu_items GROUP BY category ORDER BY n DESC LIMIT 20").forEach(r => console.log('  ' + (r.category || '(空)') + ' = ' + r.n));
  console.log('  item_type: ' + JSON.stringify(q('SELECT item_type, COUNT(*) n FROM menu_items GROUP BY item_type')));
  console.log('  含鹅/鸭/鸡的菜品:');
  q("SELECT id,name,spec,status,cost FROM menu_items WHERE name LIKE '%鹅%' OR name LIKE '%鸭%' OR name LIKE '%鸡%' ORDER BY id LIMIT 40")
    .forEach(r => console.log('    #' + r.id + ' ' + r.name + ' [' + (r.spec || '') + '] ' + r.status + ' cost=' + r.cost));

  console.log('\n=== 未绑定菜品（按销量，前30） ===');
  q(`SELECT d.product_name, d.spec, ROUND(SUM(d.quantity),0) qty, COUNT(DISTINCT d.store_name) stores
      FROM dish_sales d
      LEFT JOIN dish_sales_mappings m ON m.product_code=d.product_code AND m.product_name=d.product_name AND m.spec=CASE WHEN d.spec IN ('','--') THEN '' ELSE d.spec END
      WHERE m.id IS NULL
      GROUP BY d.product_name, d.spec ORDER BY qty DESC LIMIT 30`)
    .forEach(r => console.log('  ' + r.product_name + ' [' + (r.spec || '') + '] qty=' + r.qty + ' 门店数=' + r.stores));

  mem.close();
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
