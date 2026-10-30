'use strict';

// Must run in the same transaction as the binding change. Source amounts,
// report batches and raw JSON stay intact; only exact-ID ownership is resolved.
function reconcile(db, {storeId, storeName, platformName, platformId}) {
  const source = {
    '淘宝闪购': {tables:[['taobao_flash_daily_reports','biz_date'],['taobao_flash_bills','bill_date']],id:'platform_store_id',rebuild:'rebuildTaobaoFlashRevenue'},
    '美团外卖': {tables:[['meituan_delivery_daily_records','biz_date'],['meituan_delivery_bills','bill_date']],id:'meituan_store_id',rebuild:'rebuildMeituanDeliveryRevenue'},
    '美团团购': {tables:[['meituan_group_buy_benefit_records','income_date'],['meituan_group_buy_operation_records','biz_date']],id:'meituan_store_id',group:true},
    '抖音团购': {tables:[['douyin_group_buy_settlement_records','income_date'],['douyin_group_buy_operation_records','biz_date']],id:'douyin_store_id',group:true},
  }[platformName];
  if (!source || !platformId) return {matched:0};
  const tables = source.tables;
  const pending = [],excluded=require('./platform-source-exclusions').load(db,platformName);
  let excludedRows=0;
  for (const [table, day] of tables) {
    if (!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name=?",[table])) continue;
    const conflict = db.queryOne(`SELECT id FROM ${table} WHERE ${source.id}=? AND store_id IS NOT NULL AND store_id<>? LIMIT 1`,[platformId,storeId]);
    if (conflict) throw Error('该平台报表已归属其他门店，请先核对，未自动转移历史数据');
    const columns=new Set(db.queryAll(`PRAGMA table_info(${table})`).map(r=>r.name));
    const candidates = db.queryAll(`SELECT id,${day} biz_date${columns.has('source_store_name')?',source_store_name':''} FROM ${table} WHERE ${source.id}=? AND (store_id IS NULL OR match_status<>'matched')`,[platformId]);
    const rows=candidates.filter(row=>!excluded(row.source_store_name));
    for(const row of candidates.filter(row=>excluded(row.source_store_name))){db.run(`UPDATE ${table} SET store_id=NULL,store_name='',match_status='excluded' WHERE id=?`,[row.id]);excludedRows++;}
    if (rows.length) pending.push({table,rows,timestamp:columns.has('updated_at')});
  }
  if (!pending.length) return {matched:0,excluded:excludedRows};
  const dates = pending.flatMap(p=>p.rows.map(r=>r.biz_date)).sort();
  const from=dates[0],to=dates.at(-1),matched=pending.reduce((n,p)=>n+p.rows.length,0);
  const batchId = db.insert(`INSERT INTO business_import_batches
    (source_type,platform,file_name,row_count,imported_by_name,date_from,date_to) VALUES (?,?,?,?,?,?,?)`,
    ['platform',platformName,'已存报表按平台ID重新匹配',matched,'平台绑定重新匹配',from,to]);
  for (const {table,rows,timestamp} of pending) for (const row of rows) db.run(`UPDATE ${table} SET store_id=?,store_name=?,match_status='matched'${timestamp?",updated_at=datetime('now','localtime')":''} WHERE id=?`,[storeId,storeName,row.id]);
  const rebuilt = source.group
    ? require('./group-binding-rebuild').rebuild(db,{from,to,batchId,storeId,platformName})
    : require('./business-analytics')[source.rebuild](db,{from,to,batchId,storeId});
  return {matched,excluded:excludedRows,batch_id:batchId,date_from:from,date_to:to,...rebuilt};
}
module.exports = {reconcile};
