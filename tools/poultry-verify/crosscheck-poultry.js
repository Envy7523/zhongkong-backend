/** 独立交叉核对：直接用 sql.js 复算，与接口结果比对 */
const fs = require('fs');
const path = require('path');
const ROOT = 'F:\\NewDeom';
(async () => {
  const initSqlJs = require(path.join(ROOT, 'node_modules', 'sql.js'));
  const SQL = await initSqlJs();
  const mem = new SQL.Database(fs.readFileSync(path.join(ROOT, 'data', 'database.sqlite')));
  const q = (s, p = []) => { const st = mem.prepare(s); st.bind(p); const o = []; while (st.step()) o.push(st.getAsObject()); st.free(); return o; };

  const store = q("SELECT id, store_name FROM stores WHERE store_name LIKE '%博罗店%'")[0];
  console.log('门店: ' + store.store_name + ' (id=' + store.id + ')');

  // 口径：招牌烧鹅饭 在 博罗店 2026-05-01~2026-09-10，排除部分退
  const rows = q(`SELECT ROUND(SUM(quantity),2) qty, COUNT(*) n FROM dish_sales
    WHERE store_name=? AND order_time>=? AND order_time<=?
      AND COALESCE(refunded,'') NOT IN ('部分退','是','1')
      AND product_name='招牌烧鹅饭'`, [store.store_name, '2026-05-01', '2026-09-10 23:59:59']);
  console.log('招牌烧鹅饭 @博罗店 销量 = ' + JSON.stringify(rows[0]) + '  → 出成 16 时应有 ' + Math.round((rows[0].qty / 16) * 100) / 100 + ' 只');

  // 各门店该菜品销量，确认门店筛选不是异常值
  console.log('--- 招牌烧鹅饭 各门店销量 ---');
  q(`SELECT store_name, ROUND(SUM(quantity),0) qty FROM dish_sales
     WHERE product_name='招牌烧鹅饭' AND COALESCE(refunded,'') NOT IN ('部分退','是','1')
       AND order_time>='2026-05-01' AND order_time<='2026-09-10 23:59:59'
     GROUP BY store_name ORDER BY qty DESC`).forEach(r => console.log('  ' + r.store_name + ' = ' + r.qty));

  // 全渠道总销量（排除部分退）
  console.log('--- 全部门店 全部菜品 总销量（排除部分退） ---');
  console.log(JSON.stringify(q(`SELECT ROUND(SUM(quantity),2) qty, COUNT(*) n FROM dish_sales
    WHERE COALESCE(refunded,'') NOT IN ('部分退','是','1')
      AND order_time>='2026-05-01' AND order_time<='2026-09-10 23:59:59'`)[0]));

  console.log('--- 渠道口径 SQL 复算 ---');
  const CH = `CASE
    WHEN COALESCE(payment_detail,'') LIKE '%团购%' THEN 'group'
    WHEN COALESCE(payment_detail,'') LIKE '%淘宝闪购%' OR COALESCE(payment_detail,'') LIKE '%京东%' OR COALESCE(payment_detail,'') LIKE '%外卖%' THEN 'delivery'
    WHEN COALESCE(payment_detail,'') LIKE '%店内销售%' OR COALESCE(payment_detail,'') LIKE '%收银POS%' OR COALESCE(payment_detail,'') LIKE '%扫码点餐%' OR COALESCE(payment_detail,'') LIKE '%小程序%' OR COALESCE(payment_detail,'') LIKE '%堂食%' THEN 'dine_in'
    ELSE 'other' END`;
  q(`SELECT ${CH} ch, ROUND(SUM(quantity),2) qty FROM dish_sales
     WHERE COALESCE(refunded,'') NOT IN ('部分退','是','1')
       AND order_time>='2026-05-01' AND order_time<='2026-09-10 23:59:59'
     GROUP BY ch ORDER BY qty DESC`).forEach(r => console.log('  ' + r.ch + ' = ' + r.qty));
  mem.close();
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
