'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), crypto = require('crypto');
const initSqlJs = require('sql.js');
const analytics = require('../lib/business-analytics');
const sync = require('../lib/meituan-delivery-sync');
const contract = require('../syncbot/src/meituan-delivery/operating-contract');
async function database() {
  const SQL = await initSqlJs(), instance = new SQL.Database();
  instance.run('CREATE TABLE stores(id INTEGER PRIMARY KEY,store_name TEXT); CREATE TABLE store_platforms(store_id INTEGER,platform_name TEXT,platform_id TEXT)');
  instance.run("INSERT INTO stores VALUES(1,'测试门店'); INSERT INTO store_platforms VALUES(1,'美团外卖','12345678')");
  const source = fs.readFileSync(require.resolve('../lib/db'), 'utf8');
  for (const table of ['business_import_batches', 'meituan_delivery_operation_records']) {
    const start = source.indexOf('CREATE TABLE IF NOT EXISTS ' + table + ' (');
    instance.run(source.slice(start, source.indexOf('\n    )', start) + 6));
  }
  const db = {
    run(sql, values = []) { instance.run(sql, values); return instance.getRowsModified(); },
    queryAll(sql, values = []) { const stmt = instance.prepare(sql); stmt.bind(values); const result = []; while (stmt.step()) result.push(stmt.getAsObject()); stmt.free(); return result; },
    queryOne(sql, values) { return this.queryAll(sql, values)[0] || null; },
    insert(sql, values) { this.run(sql, values); return this.queryOne('SELECT last_insert_rowid() id').id; },
    save() {}, close() { instance.close(); },
  };
  return db;
}
function payload(overrides = {}) {
  const row = ['20261005','测试门店','12345678','广东省','深圳','龙岗区','27.34','41.80','1','419','33','0.0788','0.0303','1','4.3'];
  for (const [key, value] of Object.entries(overrides)) row[contract.fields.indexOf(key)] = value;
  const buffer = Buffer.from(contract.fields.join(',') + '\r\n' + row.join(',') + '\r\n');
  return { business_date: '2026-10-05', file_name: 'robot.csv', data: buffer.toString('base64'), sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}
test('真实格式 CSV 通过正式导入器，15 字段回读一致，再次调用不新增批次', async () => {
  const db = await database();
  try {
    const first = sync.importSource(db, analytics, payload());
    assert.equal(first.verification.all_fields_verified, true); assert.equal(first.verification.income_cents, 2734);
    assert.equal(sync.rawRecords(db,{date_from:'2026-10-05',date_to:'2026-10-05'}).rows[0].门店id, '12345678');
    const second = sync.importSource(db, analytics, payload());
    assert.equal(second.reused,true); assert.equal(second.batch_id,first.batch_id);
    assert.equal(db.queryOne('SELECT COUNT(*) n FROM business_import_batches').n,1);
  } finally { db.close(); }
});
test('空值保留在展示源，不伪造为原表的零；百分号转换正确', async () => {
  const db = await database();
  try {
    const result = sync.importSource(db, analytics, payload({营业收入:'',优惠前总额:'',有效订单:'',入店转化率:'7.88%'}));
    assert.equal(result.verification.blank_metric_counts.营业收入,1);
    const row = sync.rawRecords(db,{date_from:'2026-10-05',date_to:'2026-10-05'}).rows[0];
    assert.equal(row.营业收入,''); assert.equal(row.有效订单,'');
    assert.equal(db.queryOne('SELECT visit_rate FROM meituan_delivery_operation_records').visit_rate,0.0788);
  } finally { db.close(); }
});
test('同日其他账号门店保留，本次原表按门店范围核验且来源批次不可混淆', async () => {
  const db = await database();
  try {
    analytics.importMeituanDeliveryWorkbook(db, {...payload({门店id:'87654321',门店名称:'另一账号门店'}),report_kind:'operating'}, {display_name:'人工导入'});
    const before = db.queryOne("SELECT * FROM meituan_delivery_operation_records WHERE meituan_store_id='87654321'");
    const first = sync.importSource(db,analytics,payload());
    assert.equal(first.verification.row_count,1);
    assert.deepEqual(db.queryOne("SELECT * FROM meituan_delivery_operation_records WHERE meituan_store_id='87654321'"),before);
    const shown = sync.rawRecords(db,{date_from:'2026-10-05',date_to:'2026-10-05'});
    assert.equal(shown.total,2); assert.equal(shown.last_run.verified_row_count,1);
    assert.equal(sync.importSource(db,analytics,payload()).batch_id,first.batch_id);
    db.run("UPDATE meituan_delivery_operation_records SET batch_id=? WHERE meituan_store_id='12345678'",[before.batch_id]);
    assert.throws(()=>sync.importSource(db,analytics,payload()),/prior_import_unknown/);
  } finally {db.close();}
});
test('未绑定门店或被替换的源文件必须在入库之前拒绝', async () => {
  const db = await database();
  try {
    assert.throws(()=>sync.importSource(db,analytics,payload({门店id:'99999999'})),/unknown_store/);
    const tampered=payload();tampered.sha256='a'.repeat(64);
    assert.throws(()=>sync.importSource(db,analytics,tampered),/hash_mismatch/);
    assert.equal(db.queryOne('SELECT COUNT(*) n FROM business_import_batches').n,0);
  } finally { db.close(); }
});
test('同日来源改变或数据库被修改时不宣称重复核验通过', async () => {
  const db = await database();
  try {
    sync.importSource(db,analytics,payload());
    assert.throws(()=>sync.importSource(db,analytics,payload({营业收入:'30.00'})),/prior_source_changed/);
    db.run('UPDATE meituan_delivery_operation_records SET income_amount=0');
    assert.throws(()=>sync.importSource(db,analytics,payload()),/database_metric_mismatch/);
  } finally { db.close(); }
});
test('内部导入接口校验 HMAC 和回环代理头，未授权不产生批次', async () => {
  const express = require('express'), audit = require('../lib/sync-job-audit');
  const db = await database(), app = express(), secret = 'test-only-meituan-hmac-secret';
  app.use(express.json()); sync.mount({app,express,db,businessAnalytics:analytics,audit:{...audit,loadSecret:()=>secret}});
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/internal/syncbot/meituan-delivery/import`;
  const body=JSON.stringify(payload()), timestamp=String(Date.now());
  const signature=crypto.createHmac('sha256',secret).update(timestamp+'.'+body).digest('hex');
  const headers={'Content-Type':'application/octet-stream','X-Syncbot-Timestamp':timestamp,'X-Syncbot-Signature':signature};
  try {
    assert.equal((await fetch(endpoint,{method:'POST',body,headers:{...headers,'X-Syncbot-Signature':'a'.repeat(64)}})).status,401);
    assert.equal((await fetch(endpoint,{method:'POST',body,headers:{...headers,'X-Forwarded-For':'127.0.0.1'}})).status,401);
    assert.equal(db.queryOne('SELECT COUNT(*) n FROM business_import_batches').n,0);
    const response=await fetch(endpoint,{method:'POST',body,headers});assert.equal(response.status,200);
    assert.equal((await response.json()).verification.all_fields_verified,true);
  } finally { await new Promise(resolve=>server.close(resolve));db.close(); }
});
test('计划业务日按北京时间计算，不依赖宿主时区', () => {
  const {local}=require('../syncbot/bin/meituan-delivery-schedule');
  assert.deepEqual(local(new Date('2026-10-06T20:00:00Z')),{date:'2026-10-07',time:'04:00',previous:'2026-10-06'});
});
