const path = require('path');
const XLSX = require('xlsx');
const db = require('../lib/db');

const sourceFile = process.argv[2];
if (!sourceFile) throw new Error('请提供记账本 xlsx 文件路径');

const IMPORT_KEY = 'bookkeeping_import_2026_08_26';

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeStoreName(value) {
  return clean(value)
    .replace(/[（(]订货[）)]/g, '')
    .replace(/\s+/g, '');
}

function parseDate(value) {
  const match = clean(value).match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!match) return '';
  const month = Number(match[1]);
  const day = Number(match[2]);
  const rawYear = Number(match[3]);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  if (!month || month > 12 || !day || day > 31) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseAmount(value) {
  const result = Number(clean(value).replace(/,/g, ''));
  return Number.isFinite(result) ? result : null;
}

async function main() {
  await db.init();
  if (db.queryOne('SELECT value FROM config WHERE key=?', [IMPORT_KEY])) {
    throw new Error('该记账本已导入过，为避免重复记录已终止。');
  }

  const workbook = XLSX.readFile(path.resolve(sourceFile), { cellDates: true });
  const sheet = workbook.Sheets.Sheet1 || workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('未找到可读取的工作表');
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  const stores = db.queryAll('SELECT id,store_name FROM stores');
  const storesByName = new Map(stores.map(store => [normalizeStoreName(store.store_name), store]));
  const admin = db.queryOne("SELECT id,display_name,username FROM users WHERE role='管理员' ORDER BY id LIMIT 1");
  if (!admin) throw new Error('未找到可用于导入的管理员账号');

  const existingCategories = db.queryAll('SELECT * FROM bookkeeping_categories ORDER BY id');
  const categoryByName = new Map(existingCategories.map(category => [clean(category.name), category]));
  const subcategoryByKey = new Map(
    db.queryAll('SELECT * FROM bookkeeping_subcategories ORDER BY id')
      .map(subcategory => [`${subcategory.category_id}|${clean(subcategory.name)}`, subcategory])
  );
  let nextCategoryOrder = Math.max(0, ...existingCategories.map(category => Number(category.sort_order) || 0)) + 1;
  const nextSubcategoryOrder = new Map();
  const categoryOrder = new Map();
  const validRows = [];
  const skipped = [];

  rows.slice(1).forEach((row, index) => {
    const date = parseDate(row[0]);
    const sequence = clean(row[1]);
    const sourceStore = clean(row[2]);
    const categoryName = clean(row[3]);
    const subcategoryName = clean(row[4]);
    const amount = parseAmount(row[5]);
    if (!date && sourceStore === '门店名称' && categoryName === '大类') return;
    if (!date && !sourceStore && !categoryName && !subcategoryName && clean(row[5]) === '') return;
    if (!date || !sourceStore || !categoryName || !subcategoryName || amount === null) {
      skipped.push({ row: index + 2, reason: '字段不完整或日期/金额无法识别' });
      return;
    }
    const store = storesByName.get(normalizeStoreName(sourceStore));
    if (!store) {
      skipped.push({ row: index + 2, reason: `未匹配门店：${sourceStore}` });
      return;
    }
    validRows.push({ date, sequence, store, categoryName, subcategoryName, amount });
  });

  if (!validRows.length) throw new Error('没有可导入的有效记账记录');
  const categoryFor = (name) => {
    if (categoryByName.has(name)) return categoryByName.get(name);
    const category = { id: db.insert('INSERT INTO bookkeeping_categories (name,sort_order) VALUES (?,?)', [name, nextCategoryOrder++]), name };
    categoryByName.set(name, category);
    return category;
  };
  const subcategoryFor = (category, name) => {
    const key = `${category.id}|${name}`;
    if (subcategoryByKey.has(key)) return subcategoryByKey.get(key);
    const currentOrder = nextSubcategoryOrder.get(category.id) ?? 1;
    nextSubcategoryOrder.set(category.id, currentOrder + 1);
    const subcategory = { id: db.insert('INSERT INTO bookkeeping_subcategories (category_id,name,sort_order) VALUES (?,?,?)', [category.id, name, currentOrder]), name };
    subcategoryByKey.set(key, subcategory);
    return subcategory;
  };

  validRows.forEach(record => {
    const category = categoryFor(record.categoryName);
    const subcategory = subcategoryFor(category, record.subcategoryName);
    db.insert(
      'INSERT INTO bookkeeping_entries (store_id,store_name,user_id,user_name,date,category_id,category_name,subcategory_id,subcategory_name,amount,images,remark) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [record.store.id, record.store.store_name, admin.id, admin.display_name || admin.username, record.date,
        category.id, category.name, subcategory.id, subcategory.name, record.amount, '[]', `导入自记账本.xlsx · 原序号 ${record.sequence || '—'}`]
    );
  });

  db.run(
    "INSERT INTO config (key,value,updated_at) VALUES (?,?,datetime('now','localtime')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    [IMPORT_KEY, JSON.stringify({ source: path.basename(sourceFile), imported_at: new Date().toISOString(), count: validRows.length })]
  );
  db.save();
  console.log(JSON.stringify({
    imported_entries: validRows.length,
    category_count: new Set(validRows.map(row => row.categoryName)).size,
    subcategory_count: new Set(validRows.map(row => `${row.categoryName}|${row.subcategoryName}`)).size,
    store_count: new Set(validRows.map(row => row.store.id)).size,
    skipped_count: skipped.length,
    skipped: skipped.slice(0, 20),
  }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
