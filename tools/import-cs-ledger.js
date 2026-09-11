const path = require('path');
const XLSX = require('xlsx');
const db = require('../lib/db');

const sourceFile = process.argv[2] || 'C:/Users/envy/Desktop/cs.xls';
const IMPORT_KEY = 'bookkeeping_import_cs_2026_08_01_09';
const RANGE_START = '2026-08-01';
const RANGE_END = '2026-08-09';

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeStoreName(value) {
  return clean(value).replace(/[（(]订货[）)]/g, '').replace(/\s+/g, '');
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
  const result = Number(clean(value).replace(/[,，¥￥\s]/g, ''));
  return Number.isFinite(result) ? result : null;
}

async function main() {
  await db.init();

  if (db.queryOne('SELECT value FROM config WHERE key=?', [IMPORT_KEY])) {
    throw new Error('cs.xls 已导入过，为避免重复记录已终止。');
  }

  const workbook = XLSX.readFile(path.resolve(sourceFile), { cellDates: true });
  const sheet = workbook.Sheets['Sheet1'] || workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('未找到可读取的工作表');
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });

  const stores = db.queryAll('SELECT id,store_name FROM stores');
  const storesByName = new Map(stores.map(s => [normalizeStoreName(s.store_name), s]));
  const admin = db.queryOne("SELECT id,display_name,username FROM users WHERE role='管理员' ORDER BY id LIMIT 1");
  if (!admin) throw new Error('未找到可用于导入的管理员账号');

  const categoryByName = new Map(db.queryAll('SELECT id,name FROM bookkeeping_categories').map(c => [clean(c.name), c]));
  const subcategoryByKey = new Map(
    db.queryAll('SELECT id,category_id,name FROM bookkeeping_subcategories')
      .map(s => [`${s.category_id}|${clean(s.name)}`, s])
  );

  const valid = [];
  const skipped = [];

  rows.slice(1).forEach((row, index) => {
    const date = parseDate(row[0]);
    const sequence = clean(row[1]);
    const sourceStore = clean(row[2]);
    const categoryName = clean(row[3]);
    const subcategoryName = clean(row[4]);
    const amount = parseAmount(row[5]);

    if (!date && !sourceStore && !categoryName && !subcategoryName && clean(row[5]) === '') return; // 空行

    if (!date || !sourceStore || !categoryName || !subcategoryName || amount === null) {
      skipped.push({ row: index + 2, reason: '字段不完整或日期/金额无法识别' });
      return;
    }
    if (date < RANGE_START || date > RANGE_END) {
      skipped.push({ row: index + 2, reason: `日期 ${date} 超出 8.1-8.9 范围` });
      return;
    }
    const store = storesByName.get(normalizeStoreName(sourceStore));
    if (!store) {
      skipped.push({ row: index + 2, reason: `未匹配门店：${sourceStore}` });
      return;
    }
    const category = categoryByName.get(categoryName);
    if (!category) {
      skipped.push({ row: index + 2, reason: `未匹配大类：${categoryName}` });
      return;
    }
    const subcategory = subcategoryByKey.get(`${category.id}|${subcategoryName}`);
    if (!subcategory) {
      skipped.push({ row: index + 2, reason: `未匹配小类：${categoryName}/${subcategoryName}` });
      return;
    }
    valid.push({ date, sequence, store, category, subcategory, amount });
  });

  if (!valid.length) throw new Error('没有可导入的有效记账记录');

  db.run('BEGIN');
  try {
    for (const r of valid) {
      db.insert(
        'INSERT INTO bookkeeping_entries (store_id,store_name,user_id,user_name,date,category_id,category_name,subcategory_id,subcategory_name,amount,images,remark) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [r.store.id, r.store.store_name, admin.id, admin.display_name || admin.username, r.date,
          r.category.id, r.category.name, r.subcategory.id, r.subcategory.name, r.amount, '[]',
          `导入自 cs.xls · 原序号 ${r.sequence || '—'}`]
      );
    }
    db.run(
      "INSERT INTO config (key,value,updated_at) VALUES (?,?,datetime('now','localtime')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      [IMPORT_KEY, JSON.stringify({ source: path.basename(sourceFile), imported_at: new Date().toISOString(), count: valid.length, range: `${RANGE_START}~${RANGE_END}` })]
    );
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch {}
    throw error;
  }
  db.save();

  const byCat = {};
  for (const r of valid) {
    if (!byCat[r.category.name]) byCat[r.category.name] = { count: 0, sum: 0 };
    byCat[r.category.name].count++;
    byCat[r.category.name].sum += r.amount;
  }

  console.log(JSON.stringify({
    imported_entries: valid.length,
    by_category: Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, { count: v.count, sum: Number(v.sum.toFixed(2)) }])),
    store_count: new Set(valid.map(r => r.store.id)).size,
    date_range: `${valid.map(r => r.date).sort()[0]} ~ ${valid.map(r => r.date).sort().at(-1)}`,
    skipped_count: skipped.length,
    skipped: skipped.slice(0, 20),
  }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
