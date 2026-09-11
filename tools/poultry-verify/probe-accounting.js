/** 只读：菜品核算可行性探针（BOM 覆盖 / 绑定覆盖 / 禽类用料） */
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

  console.log('=== 规模 ===');
  console.log('menu_items=' + one('SELECT COUNT(*) n FROM menu_items').n);
  console.log('menu_cost_components=' + one('SELECT COUNT(*) n FROM menu_cost_components').n);
  console.log('有BOM的菜品数=' + one('SELECT COUNT(DISTINCT menu_item_id) n FROM menu_cost_components').n);
  console.log('dish_sales=' + one('SELECT COUNT(*) n FROM dish_sales').n);
  console.log('dish_sales_mappings=' + one('SELECT COUNT(*) n FROM dish_sales_mappings').n);
  console.log('dish_sales 区间=' + JSON.stringify(one("SELECT MIN(substr(order_time,1,10)) d1, MAX(substr(order_time,1,10)) d2 FROM dish_sales")));

  console.log('\n=== dish_sales 绑定覆盖（按销量） ===');
  console.log(JSON.stringify(one(`
    SELECT SUM(d.quantity) total_qty,
      SUM(CASE WHEN m.id IS NOT NULL THEN d.quantity ELSE 0 END) bound_qty,
      SUM(CASE WHEN mb.id IS NOT NULL THEN d.quantity ELSE 0 END) bom_qty
    FROM dish_sales d
    LEFT JOIN dish_sales_mappings m ON m.product_code=d.product_code AND m.product_name=d.product_name AND m.spec=CASE WHEN d.spec IN ('','--') THEN '' ELSE d.spec END
    LEFT JOIN (SELECT DISTINCT menu_item_id AS id FROM menu_cost_components) mb ON mb.id=m.menu_item_id
  `)));

  console.log('\n=== 各门店销量 top15 ===');
  q("SELECT store_name, COUNT(*) rows, ROUND(SUM(quantity),0) qty FROM dish_sales GROUP BY store_name ORDER BY qty DESC LIMIT 15")
    .forEach(r => console.log('  ' + r.store_name + ' | rows=' + r.rows + ' | qty=' + r.qty));

  console.log('\n=== BOM 材料名 top40（看有无禽类） ===');
  q(`SELECT ingredient_name, unit, COUNT(*) n, ROUND(SUM(quantity),2) qty
     FROM menu_cost_components GROUP BY ingredient_name, unit ORDER BY n DESC LIMIT 40`)
    .forEach(r => console.log('  ' + r.ingredient_name + ' | 单位=' + r.unit + ' | 行数=' + r.n + ' | 用量合计=' + r.qty));

  console.log('\n=== BOM 中含 鸡/鸭/鹅 的材料 ===');
  const birds = q(`SELECT ingredient_name, unit, COUNT(*) n, MIN(quantity) qmin, MAX(quantity) qmax
     FROM menu_cost_components
     WHERE ingredient_name LIKE '%鸡%' OR ingredient_name LIKE '%鸭%' OR ingredient_name LIKE '%鹅%'
     GROUP BY ingredient_name, unit ORDER BY n DESC`);
  birds.forEach(r => console.log('  ' + r.ingredient_name + ' | 单位=' + r.unit + ' | 行数=' + r.n + ' | 用量 ' + r.qmin + '~' + r.qmax));

  console.log('\n=== 单位分布 ===');
  q('SELECT unit, COUNT(*) n FROM menu_cost_components GROUP BY unit ORDER BY n DESC').forEach(r => console.log('  ' + r.unit + ' = ' + r.n));

  console.log('\n=== 有BOM的菜品样例 ===');
  q(`SELECT m.id, m.name, m.spec, m.cost,
       (SELECT GROUP_CONCAT(c.ingredient_name || '×' || c.quantity || c.unit, ' + ') FROM menu_cost_components c WHERE c.menu_item_id=m.id) bom
     FROM menu_items m WHERE EXISTS (SELECT 1 FROM menu_cost_components c WHERE c.menu_item_id=m.id) LIMIT 15`)
    .forEach(r => console.log('  #' + r.id + ' ' + r.name + ' [' + (r.spec || '') + '] cost=' + r.cost + ' => ' + String(r.bom).slice(0, 160)));

  console.log('\n=== 销量 top20 菜品（是否已绑定/BOM） ===');
  q(`SELECT d.product_name, d.spec, ROUND(SUM(d.quantity),0) qty,
       MAX(CASE WHEN m.id IS NOT NULL THEN 1 ELSE 0 END) bound,
       MAX(CASE WHEN mb.id IS NOT NULL THEN 1 ELSE 0 END) has_bom
     FROM dish_sales d
     LEFT JOIN dish_sales_mappings m ON m.product_code=d.product_code AND m.product_name=d.product_name AND m.spec=CASE WHEN d.spec IN ('','--') THEN '' ELSE d.spec END
     LEFT JOIN (SELECT DISTINCT menu_item_id AS id FROM menu_cost_components) mb ON mb.id=m.menu_item_id
     GROUP BY d.product_name, d.spec ORDER BY qty DESC LIMIT 20`)
    .forEach(r => console.log('  ' + r.product_name + ' [' + (r.spec || '') + '] qty=' + r.qty + ' bound=' + r.bound + ' bom=' + r.has_bom));

  console.log('\n=== 退款口径 ===');
  console.log(JSON.stringify(q("SELECT refunded, COUNT(*) n, ROUND(SUM(quantity),0) qty FROM dish_sales GROUP BY refunded")));
  console.log('\n=== payment_detail 样例（渠道） ===');
  q('SELECT payment_detail, COUNT(*) n FROM dish_sales GROUP BY payment_detail ORDER BY n DESC LIMIT 10').forEach(r => console.log('  ' + JSON.stringify(r.payment_detail) + ' = ' + r.n));

  mem.close();
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
