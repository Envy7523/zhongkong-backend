'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const review = require('../lib/bookkeeping-review');
const plan = require('../syncbot/src/schedule/bookkeeping-review-plan');
const parse = require('../lib/pos-bookkeeping-daily').parsePosBookkeepingDaily;
const XLSX = require('xlsx');
let SQL;
test.before(async () => { SQL = await require('sql.js')(); });
function fixture() {
  const db = new SQL.Database();
  db.run(`CREATE TABLE stores(id INTEGER PRIMARY KEY,store_name TEXT,pos_store_code TEXT);
    INSERT INTO stores VALUES(1,'测试店','MD1');
    CREATE TABLE bookkeeping_categories(id INTEGER PRIMARY KEY,name TEXT,sort_order INTEGER);
    CREATE TABLE bookkeeping_subcategories(id INTEGER PRIMARY KEY,category_id INTEGER,name TEXT,sort_order INTEGER);
    CREATE TABLE bookkeeping_entries(id INTEGER PRIMARY KEY,store_id INTEGER,store_name TEXT,user_id INTEGER,user_name TEXT,date TEXT,
      category_id INTEGER,category_name TEXT,subcategory_id INTEGER,subcategory_name TEXT,amount REAL,images TEXT,remark TEXT);
    CREATE TABLE pos_bookkeeping_daily_imports(id INTEGER PRIMARY KEY,business_date TEXT UNIQUE,file_sha256 TEXT,row_count INTEGER,
      store_count INTEGER,total_cents INTEGER,imported_by INTEGER);
    CREATE TABLE pos_bookkeeping_daily_import_rows(batch_id INTEGER,entry_id INTEGER UNIQUE,source_line INTEGER,PRIMARY KEY(batch_id,source_line));`);
  const a = { queryAll(sql, args = []) { const q = db.prepare(sql); try { q.bind(args); const rows = []; while (q.step()) rows.push(q.getAsObject()); return rows; } finally { q.free(); } },
    queryOne(sql, args) { return this.queryAll(sql, args)[0] || null; }, run(sql, args = []) { db.run(sql, args); return db.getRowsModified(); },
    insert(sql, args = []) { db.run(sql, args); return this.queryOne('select last_insert_rowid() id').id; }, save() {} };
  review.ensureSchema(a); return a;
}
function source(items) {
  const w = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(w, XLSX.utils.aoa_to_sheet([
    ['门店收支统计'], ['门店【全部】；大类【全部】；小类【全部】；日期【2026/09/01-2026/09/01】'],
    ['门店名称','大类','小类','金额'], ...items.map(([sub, amount]) => ['测试店','费用',sub,amount]),
    ['合计','','',items.reduce((a, r) => a + r[1], 0)]
  ]), '门店收支统计');
  return parse(XLSX.write(w, { type: 'buffer', bookType: 'xlsx' }), '2026-09-01', { allowEmpty: true });
}
function commit(db, s, key, options = {}) {
  return review.commit(db, s, { id: 1, username: 'test' }, { reviewKey: key,
    expectedState: review.inspect(db, s, options).expected_state, ...options });
}
test('source additions, modifications, removals preserve independent manual records and history', () => {
  const db = fixture();
  db.insert(`INSERT INTO bookkeeping_entries(store_id,store_name,date,category_name,subcategory_name,amount,images,remark)
    VALUES(1,'测试店','2026-09-01','费用','手工',123,'[]','独立手工')`);
  const first = commit(db, source([['水费',10],['电费',20]]), 'review-one');
  assert.equal(first.manual_preserved, 1);
  const old = db.queryOne("select * from bookkeeping_entries where remark='独立手工'");
  const second = commit(db, source([['水费',15],['房租',30]]), 'review-two');
  assert.deepEqual(new Set(second.differences.map(r => r.change)), new Set(['added','modified','removed']));
  assert.deepEqual(db.queryOne("select * from bookkeeping_entries where remark='独立手工'"), old);
  assert.equal(db.queryOne('select count(*) n from pos_bookkeeping_daily_reviews').n, 2);
  assert.equal(JSON.parse(db.queryOne('select before_json from pos_bookkeeping_daily_reviews where id=2').before_json).length, 2);
});
test('same total does not hide category changes; unchanged sources are versioned without duplicate ledger entries', () => {
  const db = fixture(); commit(db, source([['水',10],['电',20]]), 'run-one');
  const s = source([['水',15],['电',15]]), changed = commit(db, s, 'run-two');
  assert.equal(changed.differences.length, 2);
  assert.equal(changed.total_cents, 3000);
  assert.equal(commit(db, s, 'run-three').status, 'unchanged');
  assert.equal(db.queryOne('select count(*) n from bookkeeping_entries').n, 2);
  assert.equal(commit(db, s, 'run-three').already_reviewed, true);
});
test('preview state protects concurrent manual edits and empty reports require explicit confirmation', () => {
  const db = fixture(), s = source([['水',10]]);
  const expected = review.inspect(db, s).expected_state;
  db.run("insert into bookkeeping_entries(date,category_name,subcategory_name,amount,remark) values('2026-09-01','费用','手工',5,'手工')");
  assert.throws(() => review.commit(db, s, { id:1 }, { reviewKey:'race-one', expectedState:expected }), /review_state_changed/);
  commit(db, s, 'real-one');
  const empty = source([]);
  assert.throws(() => commit(db, empty, 'empty-one'), /empty_report_requires_confirmation/);
  commit(db, empty, 'empty-one', { allowEmpty: true });
  assert.equal(db.queryOne('select count(*) n from bookkeeping_entries').n, 1);
});
test('legacy records require explicit source adoption; linked source edits are protected', () => {
  const db = fixture(), s = source([['水',10]]);
  db.run("insert into bookkeeping_entries(store_id,date,category_name,subcategory_name,amount,images,remark) values(1,'2026-09-01','费用','水',8,'[]','快捷录入')");
  assert.equal(review.inspect(db,s).manual.length,1);
  assert.equal(commit(db,s,'legacy-one',{adoptLegacy:true}).adopted_legacy,1);
  assert.equal(db.queryOne('select count(*) n from bookkeeping_entries').n,1);
  db.run('update bookkeeping_entries set amount=11');
  assert.throws(() => review.inspect(db,s), /verified_source_modified_locally/);
});
test('legacy ownership cannot absorb independent hand-entered records', () => {
  const db=fixture();db.run("insert into bookkeeping_entries(date,amount,remark) values('2026-09-01',5,'独立手工')");
  assert.throws(() => review.inspect(db,source([['水',10]]),{adoptLegacy:true}),/legacy_provenance_ambiguous/);
});
test('legacy pasted duplicates are compared by category sum and consolidated with their old rows archived', () => {
  const db=fixture();
  for(const amount of [3,7]) db.run("insert into bookkeeping_entries(store_id,date,category_name,subcategory_name,amount,images,remark) values(1,'2026-09-01','费用','水',?,'[]','快捷录入')",[amount]);
  const result=commit(db,source([['水',10]]),'duplicate-one',{adoptLegacy:true});
  assert.equal(result.status,'unchanged');assert.equal(result.adopted_legacy,2);
  assert.equal(db.queryOne('select count(*) n from bookkeeping_entries').n,1);
  assert.equal(JSON.parse(db.queryOne('select before_json from pos_bookkeeping_daily_reviews').before_json).length,2);
});
test('daily and month-first plans handle timezone, month length and duplicate dates', () => {
  const daily=plan.reviewPlan(new Date('2026-10-06T18:00:00Z'));
  assert.equal(daily.today,'2026-10-07');assert.deepEqual(daily.dates,['2026-09-30','2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06']);
  const month=plan.reviewPlan(new Date('2026-09-30T18:00:00Z'));
  assert.equal(month.dates.length,30);assert.equal(month.dates[0],'2026-09-01');assert.equal(month.dates.at(-1),'2026-09-30');
  assert.equal(plan.reviewPlan(new Date('2024-03-01T00:00:00Z')).dates.length,29);
});
