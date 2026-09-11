/** 只读：查残留的耗用行指向哪里 */
const fs = require('fs');
const path = require('path');
const ROOT = 'F:\\NewDeom';
(async () => {
  const initSqlJs = require(path.join(ROOT, 'node_modules', 'sql.js'));
  const SQL = await initSqlJs();
  const mem = new SQL.Database(fs.readFileSync(path.join(ROOT, 'data', 'database.sqlite')));
  const q = (s, p = []) => { const st = mem.prepare(s); st.bind(p); const o = []; while (st.step()) o.push(st.getAsObject()); st.free(); return o; };
  console.log('poultry_dish_usage 全部行:');
  q(`SELECT u.id, u.menu_item_id, u.yield_id, u.usage_qty,
            (SELECT name FROM menu_items m WHERE m.id=u.menu_item_id) AS menu_name,
            (SELECT part_name FROM poultry_yields y WHERE y.id=u.yield_id) AS part_name
     FROM poultry_dish_usage u ORDER BY u.id`).forEach(r => console.log(
    `  #${r.id} menu=#${r.menu_item_id}(${r.menu_name || '【菜品已删·孤儿行】'}) yield=#${r.yield_id}(${r.part_name}) qty=${r.usage_qty}`));
  console.log('');
  console.log('孤儿耗用行（指向已删菜品）数 = ' + q(`SELECT COUNT(*) n FROM poultry_dish_usage u
    LEFT JOIN menu_items m ON m.id=u.menu_item_id WHERE m.id IS NULL`)[0].n);
  console.log('外键开关状态: ' + JSON.stringify(q('PRAGMA foreign_keys')));
  console.log('menu_items 是否存在 id=462/463: ' + JSON.stringify(q('SELECT id, name FROM menu_items WHERE id IN (462,463)')));
  mem.close();
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
