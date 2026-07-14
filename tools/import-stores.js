/**
 * 门店信息导入脚本 — 从 demo/门店信息.xlsx 导入到 SQLite
 * 用法：node tools/import-stores.js
 */
const XLSX = require('xlsx');
const path = require('path');
const db = require('../lib/db');

/** Excel 序列号 → YYYY-MM-DD */
function excelDateToStr(serial) {
  if (!serial || isNaN(serial)) return '';
  // Excel 日期从 1899-12-30 开始计数
  const d = new Date((serial - 25569) * 86400 * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function main() {
  await db.init();

  // 清空旧数据
  db.run('DELETE FROM store_platforms');
  db.run('DELETE FROM employees');
  db.run('DELETE FROM store_fixed_costs');
  db.run('DELETE FROM store_operating_costs');
  db.run('DELETE FROM store_supplies');
  db.run('DELETE FROM menu_items');
  db.run('DELETE FROM daily_reports');
  db.run('DELETE FROM cost_accounting');
  db.run('DELETE FROM stores');
  db.run('DELETE FROM push_logs');

  const fp = path.join(__dirname, '..', 'demo', '门店信息.xlsx');
  console.log('读取:', fp);
  const wb = XLSX.readFile(fp);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  // 跳过表头（第0行）
  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const store_name = String(r[2] || '').trim();
    if (!store_name) continue;

    const store_type = String(r[1] || '').trim();   // 经营店型
    const legal_person = String(r[3] || '').trim();  // 门店法人
    const payment_type = String(r[4] || '').trim();  // 收款性质
    const status = String(r[5] || '').trim();        // 门店状态
    const opening_date = excelDateToStr(Number(r[6])); // 开业时间
    const phone = String(r[7] || '').trim();         // 门店手机号
    const province = String(r[8] || '').trim();      // 省
    const city = String(r[9] || '').trim();          // 市
    const district = String(r[10] || '').trim();     // 区
    const address = String(r[11] || '').trim();      // 详细地址
    const business_hours = String(r[12] || '').trim(); // 门店营业时间

    db.insert(
      `INSERT INTO stores (store_name,status,store_type,legal_person,payment_type,
        province,city,district,address,phone,opening_date,business_hours)
       VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?)`,
      [store_name, status, store_type, legal_person, payment_type,
       province, city, district, address, phone, opening_date, business_hours]
    );
    count++;
  }

  db.save();
  console.log(`✅ 导入完成：${count} 家门店`);
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
