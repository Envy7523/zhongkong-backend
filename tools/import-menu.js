/**
 * 从 demo/菜品.xlsx 导入菜品到 menu_items 表
 * Excel 列：序号, 菜品名, 分类, 做法, 规格, 价格
 * - 有序号的行 = 主菜品（价格 = 堂食价）
 * - 无序号 + 规格="会员价" = 前一行的会员价子行
 * 用法: node tools/import-menu.js
 */
const XLSX = require('xlsx');
const path = require('path');
const db = require('../lib/db');

(async () => {
  await db.init();

  // 清空现有菜品
  db.run('DELETE FROM menu_items');

  const filePath = path.join(__dirname, '..', 'demo', '菜品.xlsx');
  const wb = XLSX.readFile(filePath);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

  let inserted = 0;
  let lastItemId = null;

  for (const row of rows) {
    const specVal = String(row['规格'] || '').trim();

    // 会员价子行：关联到上一个菜品
    if (row['序号'] == null && specVal === '会员价' && lastItemId) {
      const memberPrice = parseFloat(row['价格']) || 0;
      db.run('UPDATE menu_items SET member_price=? WHERE id=?', [memberPrice, lastItemId]);
      continue;
    }

    // 主菜品行（有序号）
    if (row['序号'] == null) continue;
    if (!row['菜品名']) continue;

    const name = String(row['菜品名']).trim();
    const category = String(row['分类'] || '').trim();
    const method = String(row['做法'] || '').trim().replace(/^\/$/, '');
    const spec = specVal.replace(/^\/$/, '');
    const dineInPrice = parseFloat(row['价格']) || 0;
    // 规格单位统一为"份"，克重默认空（需要时手动填）
    const spec_unit = '份';
    const spec_weight = '';

    lastItemId = db.insert(
      'INSERT INTO menu_items (store_id, name, category, method, spec, dine_in_price, spec_unit, spec_weight, status) VALUES (?,?,?,?,?,?,?,?,?)',
      [1, name, category, method, spec, dineInPrice, spec_unit, spec_weight, '在售']
    );
    inserted++;
  }

  db.save();
  db.close();

  console.log(`✅ 导入完成，共 ${inserted} 条菜品`);
})();
