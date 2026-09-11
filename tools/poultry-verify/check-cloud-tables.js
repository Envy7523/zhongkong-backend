/** 在云端跑：确认 poultry 四张表已建、结构正确（只读，不写库） */
const fs = require('fs');
const path = require('path');
const ROOT = '/home/ubuntu/app';
(async () => {
  const initSqlJs = require(path.join(ROOT, 'node_modules', 'sql.js'));
  const SQL = await initSqlJs();
  const DB = path.join(ROOT, 'data', 'database.sqlite');
  const mem = new SQL.Database(fs.readFileSync(DB));
  const q = (s) => { const st = mem.prepare(s); const o = []; while (st.step()) o.push(st.getAsObject()); st.free(); return o; };
  const one = (s) => q(s)[0] || {};

  const tables = q("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'poultry%' ORDER BY name").map(r => r.name);
  console.log('poultry 表: ' + (tables.length ? tables.join(', ') : '【缺失】'));
  if (tables.length) {
    console.log('  poultry_birds 行数      = ' + one('SELECT COUNT(*) n FROM poultry_birds').n);
    console.log('  poultry_yields 行数     = ' + one('SELECT COUNT(*) n FROM poultry_yields').n);
    console.log('  poultry_dish_usage 行数 = ' + one('SELECT COUNT(*) n FROM poultry_dish_usage').n);
    console.log('  poultry_purchases 行数  = ' + one('SELECT COUNT(*) n FROM poultry_purchases').n);
    const cols = (t) => q(`PRAGMA table_info(${t})`).map(c => c.name).join(',');
    console.log('  birds 列: ' + cols('poultry_birds'));
    console.log('  dish_usage 唯一键: ' + (q("SELECT sql FROM sqlite_master WHERE name='poultry_dish_usage'")[0].sql.match(/UNIQUE\([^)]*\)/g) || []).join(' '));
  }
  // 云端业务数据规模（确认没被动过）
  console.log('云端数据核对: stores=' + one('SELECT COUNT(*) n FROM stores').n
    + ' menu_items=' + one('SELECT COUNT(*) n FROM menu_items').n
    + ' dish_sales=' + one('SELECT COUNT(*) n FROM dish_sales').n
    + ' bookkeeping_entries=' + one('SELECT COUNT(*) n FROM bookkeeping_entries').n);
  console.log('dish_sales 区间: ' + JSON.stringify(one("SELECT MIN(substr(order_time,1,10)) d1, MAX(substr(order_time,1,10)) d2 FROM dish_sales")));
  console.log('pos_product_sale_details 列: ' + q('PRAGMA table_info(pos_product_sale_details)').map(c => c.name).join(','));
  mem.close();
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
