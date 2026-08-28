const fs = require('fs');
const path = require('path');
const db = require('../lib/db');

const sourceFile = process.argv[2];
const apply = process.argv.includes('--apply');
if (!sourceFile) throw new Error('请提供粘贴文本文件路径');

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeStoreName(value) {
  return clean(value)
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/\s+/g, '');
}

// 历史系统名称与当前后台门店名称的已知对应关系。
const STORE_ALIASES = new Map([
  [normalizeStoreName('鹅太公烧鹅（京基御景店）'), normalizeStoreName('景基御景店')],
]);

function parseAmount(value) {
  const amount = Number(clean(value).replace(/[¥￥,，\s]/g, ''));
  return Number.isFinite(amount) ? amount : null;
}

function normalizeCategory(categoryName, subcategoryName, amount) {
  // “--”是旧系统中被删除分类的有效归档标记，应按原样保留。
  if (categoryName === '--' || subcategoryName === '--') return { categoryName: '--', subcategoryName: '--', note: '旧系统已删除字段归档记录' };
  return { categoryName, subcategoryName, note: '' };
}

async function main() {
  await db.init();
  const rawRows = fs.readFileSync(path.resolve(sourceFile), 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, cells: line.split('\t').map(clean) }))
    .filter(({ cells }) => cells.some(Boolean));

  const errors = [];
  const inputRows = rawRows.slice(1).map(({ line, cells }) => {
    const [date, sequence, storeName, rawCategoryName, rawSubcategoryName, rawAmount] = cells;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      errors.push({ line, reason: '日期格式不正确' });
      return null;
    }
    const amount = parseAmount(rawAmount);
    if (!storeName || !rawCategoryName || !rawSubcategoryName || amount === null) {
      errors.push({ line, reason: '门店、大类、小类或金额不完整' });
      return null;
    }
    const normalized = normalizeCategory(rawCategoryName, rawSubcategoryName, amount);
    return { line, date, sequence, storeName, amount, ...normalized };
  }).filter(Boolean);

  const stores = db.queryAll('SELECT id, store_name FROM stores');
  const storeMap = new Map(stores.map(store => [normalizeStoreName(store.store_name), store]));
  inputRows.forEach(row => {
    const storeKey = normalizeStoreName(row.storeName);
    row.store = storeMap.get(STORE_ALIASES.get(storeKey) || storeKey);
    if (!row.store) errors.push({ line: row.line, reason: `未匹配门店：${row.storeName}` });
  });
  if (errors.length) throw new Error(`数据校验失败：${JSON.stringify(errors.slice(0, 30))}`);

  const start = inputRows.reduce((min, row) => !min || row.date < min ? row.date : min, '');
  const end = inputRows.reduce((max, row) => !max || row.date > max ? row.date : max, '');
  const existingRows = db.queryAll(
    'SELECT date,store_id,category_name,subcategory_name,amount FROM bookkeeping_entries WHERE date>=? AND date<=?',
    [start, end]
  );
  const entryKey = row => [row.date, row.store_id ?? row.store.id, row.category_name ?? row.categoryName, row.subcategory_name ?? row.subcategoryName, Number(row.amount).toFixed(2)].join('|');
  const existingKeys = new Set(existingRows.map(entryKey));
  const pendingRows = inputRows.filter(row => !existingKeys.has(entryKey(row)));
  const report = {
    source: path.basename(sourceFile),
    range: `${start} 至 ${end}`,
    input_count: inputRows.length,
    existing_exact_count: inputRows.length - pendingRows.length,
    pending_import_count: pendingRows.length,
    pending_amount: Number(pendingRows.reduce((sum, row) => sum + row.amount, 0).toFixed(2)),
    stores: [...new Set(inputRows.map(row => row.store.store_name))].length,
    uncategorized_pending_count: pendingRows.filter(row => row.note).length,
    mode: apply ? 'apply' : 'dry-run',
  };

  if (!apply) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const admin = db.queryOne("SELECT id,display_name,username FROM users WHERE role='管理员' ORDER BY id LIMIT 1");
  if (!admin) throw new Error('未找到可用于导入的管理员账号');
  const categories = db.queryAll('SELECT * FROM bookkeeping_categories');
  const categoryMap = new Map(categories.map(item => [clean(item.name), item]));
  const subcategoryMap = new Map(db.queryAll('SELECT * FROM bookkeeping_subcategories').map(item => [`${item.category_id}|${clean(item.name)}`, item]));
  let categoryOrder = Math.max(0, ...categories.map(item => Number(item.sort_order) || 0)) + 1;
  const subcategoryOrder = new Map();
  let createdCategories = 0;
  let createdSubcategories = 0;

  const categoryFor = (name) => {
    if (categoryMap.has(name)) return categoryMap.get(name);
    const category = { id: db.insert('INSERT INTO bookkeeping_categories (name,sort_order) VALUES (?,?)', [name, categoryOrder++]), name };
    categoryMap.set(name, category);
    createdCategories++;
    return category;
  };
  const subcategoryFor = (category, name) => {
    const key = `${category.id}|${name}`;
    if (subcategoryMap.has(key)) return subcategoryMap.get(key);
    const nextOrder = subcategoryOrder.get(category.id) ?? 1;
    subcategoryOrder.set(category.id, nextOrder + 1);
    const subcategory = { id: db.insert('INSERT INTO bookkeeping_subcategories (category_id,name,sort_order) VALUES (?,?,?)', [category.id, name, nextOrder]), name };
    subcategoryMap.set(key, subcategory);
    createdSubcategories++;
    return subcategory;
  };

  pendingRows.forEach(row => {
    const category = categoryFor(row.categoryName);
    const subcategory = subcategoryFor(category, row.subcategoryName);
    const remark = [`补录自旧/新系统对账数据 · 原序号 ${row.sequence || '—'}`, row.note].filter(Boolean).join('；');
    db.insert(
      'INSERT INTO bookkeeping_entries (store_id,store_name,user_id,user_name,date,category_id,category_name,subcategory_id,subcategory_name,amount,images,remark) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [row.store.id, row.store.store_name, admin.id, admin.display_name || admin.username, row.date, category.id, category.name, subcategory.id, subcategory.name, row.amount, '[]', remark]
    );
  });
  db.run(
    "INSERT INTO config (key,value,updated_at) VALUES (?,?,datetime('now','localtime')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    ['bookkeeping_reconcile_2026_08_28', JSON.stringify({ ...report, imported_at: new Date().toISOString() })]
  );
  db.save();
  console.log(JSON.stringify({ ...report, imported_count: pendingRows.length, created_categories: createdCategories, created_subcategories: createdSubcategories }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
