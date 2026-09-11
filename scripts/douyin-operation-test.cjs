// Runs against an isolated in-memory database; never writes production records.
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { detect, importReport, getReport } = require('../lib/douyin-operation');

async function main() {
  const SQL = await require('sql.js')();
  const database = new SQL.Database();
  const db = {
    run: (sql, args = []) => database.run(sql, args),
    queryAll(sql, args = []) {
      const stmt = database.prepare(sql);
      try { stmt.bind(args); const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); return rows; }
      finally { stmt.free(); }
    },
    queryOne(sql, args) { return this.queryAll(sql, args)[0]; },
    insert(sql, args) { this.run(sql, args); return this.queryOne('SELECT last_insert_rowid() AS id').id; },
    save() {},
  };
  database.exec(`CREATE TABLE stores(id INTEGER,store_name TEXT);
    CREATE TABLE store_platforms(store_id INTEGER,platform_name TEXT,platform_id TEXT);
    CREATE TABLE business_import_batches(id INTEGER PRIMARY KEY,source_type TEXT,platform TEXT,file_name TEXT,row_count INTEGER,imported_by INTEGER,imported_by_name TEXT,date_from TEXT,date_to TEXT);
    CREATE TABLE business_revenue_records(store_id INTEGER,store_name TEXT,biz_date TEXT,source_type TEXT,channel TEXT,gross_amount REAL,actual_amount REAL,order_count INTEGER);
    INSERT INTO business_revenue_records VALUES(1,'测试门店','2026-08-01','platform','douyin_group',1000,800,4),(2,'仅结算门店','2026-08-02','platform','douyin_group',500,400,2),(1,'其他平台','2026-08-01','platform','meituan_group',99999,88888,99);
    CREATE TABLE douyin_group_buy_operation_records(id INTEGER PRIMARY KEY,batch_id INTEGER,douyin_store_id TEXT,source_store_name TEXT,biz_date TEXT,visit_users REAL,ordering_users REAL,store_rating REAL,review_count REAL,store_id INTEGER,store_name TEXT,match_status TEXT);
    INSERT INTO stores VALUES(1,'测试门店');
    INSERT INTO store_platforms VALUES(1,'抖音团购','7622975884772771890');`);
  const headers = ['门店ID','门店名称','访问人数','购买人数','成交金额','核销金额','退款金额','门店评分','累计评价数','天'];
  const rows = [headers,
    ['7622975884772771890','测试门店',100,20,99999,88888,77777,4.1,10,'2026-08-01'],
    ['7622975884772771890','测试门店',300,90,99999,88888,77777,4.3,12,'2026-08-02'],
    ['unknown','待关联门店',10,5,99999,88888,77777,4,99,'2026-08-02']];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '经营数据');
  const report = detect(workbook);
  assert.ok(report);
  const result = importReport(db, report, {file_name:'test.xlsx'}, null);
  assert.equal(result.imported, 2); assert.equal(result.unmatched, 1);
  importReport(db, report, {file_name:'test.xlsx'}, null);
  assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM douyin_group_buy_operation_records').n, 3);
  const totals = getReport(db, {}).totals;
  assert.equal(totals.visit_users,400); assert.equal(totals.ordering_users,110);
  assert.equal(totals.order_rate,0.275); assert.equal(totals.store_rating,4.3); assert.equal(totals.review_count,12);
  assert.equal(getReport(db,{date_to:'2026-08-01'}).totals.review_count,10);
  assert.equal(getReport(db,{store_ids:'3'}).days,0);
  assert.equal(getReport(db,{store_ids:'3'}).totals.order_rate,null);
  assert.deepEqual(db.queryOne("SELECT gross_amount,actual_amount FROM business_revenue_records WHERE store_id=1 AND channel=\'douyin_group\'"),{gross_amount:1000,actual_amount:800});
  assert.equal(totals.gross_amount,1500); assert.equal(totals.actual_amount,1200); assert.equal(totals.order_count,6);
  assert.equal(getReport(db,{store_id:1}).totals.gross_amount,1000);
  assert.equal(getReport(db,{store_id:2}).totals.visit_users,null);
  assert.equal(getReport(db,{date_to:'2026-08-01'}).totals.actual_amount,800);
  assert.throws(()=>importReport(db,{headers,rows:[headers,rows[1],rows[1]]},{},null),/重复/);
  assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM douyin_group_buy_operation_records').n,3);
  const bad = [...rows[1]]; bad[0] = 7622975884772771890;
  assert.throws(()=>importReport(db,{headers,rows:[headers,bad]},{},null),/精度/);
  database.close();
  console.log('PASS: import, idempotency, unmatched stores, weighted conversion, period-end snapshots, filters, revenue isolation, invalid records');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
