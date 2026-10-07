const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const ledger = require('../lib/mp/bookkeeping');
(async () => {
  const SQL = await initSqlJs(); const raw = new SQL.Database();
  const db = {
    queryAll(sql, p = []) { const s = raw.prepare(sql); s.bind(p); const rows = []; while (s.step()) rows.push(s.getAsObject()); s.free(); return rows; },
    queryOne(sql, p = []) { return this.queryAll(sql, p)[0] || null; },
  };
  raw.run(`CREATE TABLE stores(id INTEGER,store_name TEXT,status TEXT);
    INSERT INTO stores VALUES(9,'方洲店','营业'),(10,'其他店','已闭店');
    CREATE TABLE bookkeeping_entries(id INTEGER,store_id INTEGER,store_name TEXT,date TEXT,category_name TEXT,subcategory_name TEXT,amount REAL,remark TEXT,user_name TEXT,created_at TEXT);
    INSERT INTO bookkeeping_entries VALUES
      (1,9,'方洲店','2026-10-06','费用','水电',10.25,'10%折扣','甲','2026-10-07'),
      (2,9,'方洲店','2026-10-06','费用','维修',-2.50,'退款','乙','2026-10-07'),
      (3,9,'方洲店','2026-10-05','收入','堂食',100.10,'补记','甲','2026-10-06'),
      (4,10,'其他店','2026-10-06','费用','租金',900.00,'其他门店','丙','2026-10-07');`);
  const day = { date_from: '2026-10-06', date_to: '2026-10-06', page_size: 1 };
  const a = ledger.list(db, 9, day);
  assert.equal(a.summary.amount, 7.75); assert.equal(a.total, 2); assert.equal(a.entries.length, 1);
  assert.equal(a.entries[0].id, 2); assert.equal(a.categories[0].amount, 7.75); assert.equal(a.stores.length, 1);
  assert.equal(ledger.list(db, 9, { ...day, page: 2 }).entries[0].id, 1);
  assert.throws(() => ledger.list(db, 9, { ...day, store_id: 10 }), /无权/);
  assert.throws(() => ledger.list(db, 9, { ...day, store_id: "9 OR 1=1" }), /参数无效/);
  assert.throws(() => ledger.list(db, null, { ...day, date_from: '2026-02-30' }), /有效/);
  assert.throws(() => ledger.list(db, null, { ...day, date_from: '2026-10-07' }), /不能晚于/);
  assert.throws(() => ledger.list(db, null, { ...day, date_from: '2024-01-01' }), /366天/);
  const range = ledger.list(db, null, { ...day, date_from: '2026-10-05' });
  assert.equal(range.summary.amount, 1007.85); assert.equal(range.summary.store_count, 2); assert.equal(range.summary.day_count, 2);
  assert.equal(ledger.list(db, null, { ...day, keyword: '%' }).total, 1);
  assert.equal(ledger.list(db, null, { ...day, category: "费用' OR 1=1 --" }).total, 0);
  assert.equal(ledger.list(db, null, { ...day, category: '费用', store_id: 9 }).summary.amount, 7.75);
  assert.equal(ledger.list(db, null, { ...day, date_from: '2026-10-01', date_to: '2026-10-01' }).summary.amount, 0);
  assert.deepEqual(ledger.options(db, 9).stores.map(s => s.id), [9]);
  assert.equal(ledger.options(db, -1).latest_date, null);
  assert.equal(ledger.options(db, 9).latest_date, '2026-10-06');
  raw.close();
  console.log('PASS: day/range totals, pagination-independent summaries, signed amounts, category/store aggregation, scoped stores, cross-store denial, date validation and literal keyword escaping');
})().catch(e => { console.error(e); process.exitCode = 1; });
