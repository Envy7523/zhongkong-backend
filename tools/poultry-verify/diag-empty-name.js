/** 只读：查空名菜品与绑定指向 */
const fs = require('fs');
const path = require('path');
const ROOT = 'F:\\NewDeom';
(async () => {
  const initSqlJs = require(path.join(ROOT, 'node_modules', 'sql.js'));
  const SQL = await initSqlJs();
  const mem = new SQL.Database(fs.readFileSync(path.join(ROOT, 'data', 'database.sqlite')));
  const q = (s, p = []) => { const st = mem.prepare(s); st.bind(p); const o = []; while (st.step()) o.push(st.getAsObject()); st.free(); return o; };
  console.log('menu_items 名称为空/NULL 的数量 = ' + q("SELECT COUNT(*) n FROM menu_items WHERE name IS NULL OR TRIM(name)=''")[0].n);
  q("SELECT id, name, spec, category, status FROM menu_items WHERE name IS NULL OR TRIM(name)='' LIMIT 20").forEach(r => console.log('  #' + r.id + " name=" + JSON.stringify(r.name) + " spec=" + JSON.stringify(r.spec) + " cat=" + r.category));
  console.log('--- 绑定表指向空名菜品的条数 ---');
  console.log(JSON.stringify(q(`SELECT COUNT(*) n FROM dish_sales_mappings m JOIN menu_items mi ON mi.id=m.menu_item_id
    WHERE mi.name IS NULL OR TRIM(mi.name)=''`)[0]));
  console.log('--- dish_sales 中产品名为空的行 ---');
  console.log(JSON.stringify(q("SELECT COUNT(*) n, ROUND(SUM(quantity),2) qty FROM dish_sales WHERE product_name IS NULL OR TRIM(product_name)=''")[0]));
  console.log('--- 这些空名报表行能否被 binding 解析 ---');
  q(`SELECT DISTINCT d.product_code, d.product_name, d.spec, m.menu_item_id
     FROM dish_sales d JOIN dish_sales_mappings m
       ON m.product_code=d.product_code AND m.product_name=d.product_name
      AND m.spec=CASE WHEN d.spec IN ('','--') THEN '' ELSE d.spec END
     WHERE (d.product_name IS NULL OR TRIM(d.product_name)='') LIMIT 10`).forEach(r => console.log('  ' + JSON.stringify(r)));
  console.log('--- 含空名菜品的耗用配置 ---');
  console.log(JSON.stringify(q(`SELECT COUNT(*) n FROM poultry_dish_usage u JOIN menu_items mi ON mi.id=u.menu_item_id WHERE mi.name IS NULL OR TRIM(mi.name)=''`)[0]));
  mem.close();
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
