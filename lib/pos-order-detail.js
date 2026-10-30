'use strict';
// Store payment components only; customer names, phone numbers and member identifiers are never persisted.
const XLSX = require('xlsx');
const crypto = require('crypto');
const TYPE = 'all_channel_orders';
const normalized = s => String(s || '').replace(/[\s（）()]/g, '');
function cents(value) {
  const match = String(value ?? '').trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw Error('订单金额格式无效');
  const n = Number(match[2]) * 100 + Number((match[3] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(n)) throw Error('订单金额超出范围');
  return match[1] ? -n : n;
}
function fee(n) { return Math.sign(n) * Math.floor((Math.abs(n) * 38 + 5000) / 10000); }
function kind(label) {
  if (require('./pos-group-payments').isOneClick(label)) return 'platform';
  if (require('./pos-group-payments').isDinePayment(label)) return 'electronic';
  if (/^(扫码支付|微信支付|支付宝支付|银联|银行卡)/.test(label)) return 'electronic';
  if (/^现金/.test(label)) return 'cash';
  if (/^(会员卡|储值卡|小程序储值)/.test(label)) return 'member';
  if (/团购|大众点评支付|外卖|闪购|免费试/.test(label)) return 'platform';
  if (/^(自定义记账|挂账|免单|礼品卡|优惠券)/.test(label)) return 'virtual';
  return 'unknown';
}
function payments(text) {
  if (!String(text || '').trim() || text === '--') return [];
  return String(text).split(/[,，]/).map(part => {
    const m = part.trim().match(/^(.+?)\s+(-?\d+(?:\.\d{1,2})?)(?:[（(]退款[）)])?$/);
    if (!m) throw Error('结账方式金额无法解析');
    return { label: m[1].trim(), cents: cents(m[2]), kind: kind(m[1].trim()) };
  });
}
function date(s) {
  if (typeof s === 'number') { const d = XLSX.SSF.parse_date_code(s); s = d && `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`; }
  const m = String(s || '').trim().replace(/\//g,'-').match(/^\d{4}-\d{2}-\d{2}$/);
  if (!m || new Date(m[0]+'T00:00:00Z').toISOString().slice(0,10)!==m[0]) throw Error('营业日期格式无效');
  return m[0];
}
function detect(workbook) {
  for (const name of workbook.SheetNames) {
    if (!/全渠道订单明细/.test(name)) continue;
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header:1, defval:'', raw:true });
    const index = rows.slice(0,8).findIndex(r => ['门店名称','营业日期','订单号','订单收入','结账方式'].every(h=>r.includes(h)));
    if (index >= 0) return { rows, index };
  }
  return null;
}
function parse(report) {
  const header = report.rows[report.index], col = key => header.indexOf(key);
  const meta = report.rows.slice(0,report.index).flat().join(' ');
  const range = meta.match(/营业日期【(\d{4}\/\d{2}\/\d{2})-(\d{4}\/\d{2}\/\d{2})】/);
  if (!range || !/门店【全部】/.test(meta) || !/订单来源【全部】/.test(meta) || !/订单子来源【全部】/.test(meta)
    || !/订单状态【已选7个】/.test(meta) || !/退单标识【全部】/.test(meta)) throw Error('仅支持全部门店、全部订单来源及完整状态/退款范围的报表');
  const from = date(range[1]), to = date(range[2]), orders = [], seen = new Set();
  for (const r of report.rows.slice(report.index+1)) {
    const id = String(r[col('订单号')] || '').trim();
    if (!id || !/^\d+$/.test(id)) { if (r[col('门店名称')] && !/合计|汇总/.test(r.join(''))) throw Error('存在无法识别的订单行'); continue; }
    const store_name = String(r[col('门店名称')]).trim(), biz_date = date(r[col('营业日期')]);
    if (biz_date<from || biz_date>to) throw Error('订单超出营业日期范围');
    const income_cents = cents(r[col('订单收入')]), components = payments(r[col('结账方式')]);
    if (components.reduce((n,p)=>n+p.cents,0)!==income_cents) throw Error(`付款构成与订单收入不一致：${biz_date}／${store_name}／${id}`);
    const key = `${store_name}|${biz_date}|${id}`;
    if (seen.has(key)) throw Error('报表包含重复订单，未写入');
    seen.add(key);
    orders.push({store_name,biz_date,order_id:id,original_id:String(r[col('原单号')]||'').trim(),
      source:String(r[col('订单来源')]||''),status:String(r[col('订单状态')]||''),income_cents,components});
  }
  if (!orders.length) throw Error('订单报表为空，未覆盖既有数据');
  return {from,to,orders};
}
function initialize(db) {
  db.run(`CREATE TABLE IF NOT EXISTS pos_channel_orders(store_id INTEGER NOT NULL,biz_date TEXT NOT NULL,order_id TEXT NOT NULL,original_id TEXT NOT NULL DEFAULT '',source TEXT NOT NULL,status TEXT NOT NULL,income_cents INTEGER NOT NULL,payments_json TEXT NOT NULL,batch_id INTEGER NOT NULL,PRIMARY KEY(store_id,biz_date,order_id))`);
  db.run('CREATE INDEX IF NOT EXISTS idx_pos_orders_original ON pos_channel_orders(store_id,order_id)');
  db.run(`CREATE TABLE IF NOT EXISTS pos_order_coverage(store_id INTEGER NOT NULL,biz_date TEXT NOT NULL,order_count INTEGER NOT NULL,receipt_cents INTEGER NOT NULL,batch_id INTEGER NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(store_id,biz_date))`);
  db.run(`CREATE TABLE IF NOT EXISTS pos_order_imports(sha256 TEXT PRIMARY KEY,batch_id INTEGER NOT NULL,date_from TEXT NOT NULL,date_to TEXT NOT NULL,order_count INTEGER NOT NULL,store_count INTEGER NOT NULL)`);
}
function prepare(db, report) {
  const IDENTITY = require('./store-pos-identity');
  const stores = db.queryAll('SELECT * FROM stores'), maps = new Map();
  for (const day of new Set(report.orders.map(o=>o.biz_date))) maps.set(day,IDENTITY.nameMap(db,day,normalized));
  const unmatched = new Set();
  for (const row of report.orders) { row.store_id = maps.get(row.biz_date).get(normalized(row.store_name))?.id; if (!row.store_id) unmatched.add(row.store_name); }
  if (unmatched.size) throw Error('订单门店未能唯一匹配，未写入：'+[...unmatched].join('、'));
  return report;
}
function importParsed(db, report, params={}, user={}) {
  initialize(db); prepare(db,report);
  const sha = params.sha256 || crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex');
  const prior = db.queryOne('SELECT * FROM pos_order_imports WHERE sha256=?',[sha]);
  if (prior) return {batch_id:prior.batch_id,data_kind:TYPE,imported:0,source_rows:prior.order_count,matched_stores:prior.store_count,duplicate:true,date_from:prior.date_from,date_to:prior.date_to,relinked:require('./member-card-transactions').relinkAndSave(db)};
  const groups = new Map();
  for (const row of report.orders) { const key=`${row.store_id}|${row.biz_date}`; if (!groups.has(key)) groups.set(key,[]); groups.get(key).push(row); }
  db.run('BEGIN');
  try {
    const batch = db.insert('INSERT INTO business_import_batches(source_type,platform,file_name,row_count,imported_by,imported_by_name,date_from,date_to) VALUES(?,?,?,?,?,?,?,?)', ['pos','收银机全渠道订单明细',params.file_name||'全渠道订单明细',report.orders.length,user.id||null,user.display_name||user.username||'',report.from,report.to]);
    for (const rows of groups.values()) {
      const {store_id,biz_date}=rows[0];
      const previous = db.queryOne('SELECT order_count FROM pos_order_coverage WHERE store_id=? AND biz_date=?',[store_id,biz_date]);
      if (previous && previous.order_count>rows.length) throw Error('新报表订单数量减少，已阻止覆盖完整数据');
      db.run('DELETE FROM pos_channel_orders WHERE store_id=? AND biz_date=?',[store_id,biz_date]);
      for (const o of rows) db.run('INSERT INTO pos_channel_orders VALUES(?,?,?,?,?,?,?,?,?)',[store_id,biz_date,o.order_id,o.original_id,o.source,o.status,o.income_cents,JSON.stringify(o.components),batch]);
      db.run('INSERT OR REPLACE INTO pos_order_coverage VALUES(?,?,?,?,?,?)',[store_id,biz_date,rows.length,rows.reduce((n,o)=>n+o.income_cents,0),batch,sha]);
    }
    const count = new Set(report.orders.map(o=>o.store_id)).size;
    db.run('INSERT INTO pos_order_imports VALUES(?,?,?,?,?,?)',[sha,batch,report.from,report.to,report.orders.length,count]);
    const relinked = require('./member-card-transactions').relinkPending(db);
    db.run('COMMIT'); db.save();
    return {batch_id:batch,data_kind:TYPE,imported:report.orders.length,source_rows:report.orders.length,matched_stores:count,covered_store_days:groups.size,date_from:report.from,date_to:report.to,errors:[],skipped:0,relinked};
  } catch(e) { db.run('ROLLBACK'); throw e; }
}
function importWorkbook(db, report, params,user) { return importParsed(db,parse(report),{...params,sha256:crypto.createHash('sha256').update(Buffer.from(params.data.replace(/^data:.*?base64,/,''),'base64')).digest('hex')},user); }
function dayPolicy(db, id, day, expectedQrCents) {
  if (typeof db.queryOne!=='function') return null;
  const coverage=db.queryOne('SELECT * FROM pos_order_coverage WHERE store_id=? AND biz_date=?',[id,day]);
  if (!coverage) return null;
  const rows=db.queryAll('SELECT * FROM pos_channel_orders WHERE store_id=? AND biz_date=?',[id,day]);
  let fee_cents=0,noncash_cents=0,cash_cents=0,deferred_member_cents=0,qr=0;
  const issues = new Set(), notes=new Set(); let unclassified_cents=0;
  for (const o of rows) {
    const ps=JSON.parse(o.payments_json).map(p=>({...p,kind:kind(p.label)}));
    const names=new Set();
    for (const p of ps) {
      if (p.kind==='cash') cash_cents+=p.cents;
      if (p.kind==='member') deferred_member_cents+=p.cents;
      if (p.kind==='unknown') {unclassified_cents+=p.cents;notes.add('未识别结账方式「'+p.label+'」，暂不推测其手续费');}
      if (p.kind!=='electronic' || !/^扫码支付/.test(p.label)) continue;
      if (names.has(p.label)) issues.add('同一订单存在同支付方式多次付款'); names.add(p.label);
      noncash_cents+=p.cents; if (/^扫码支付/.test(p.label)) qr+=p.cents;
      // Keep originals even when marked partially refunded; the separate negative record reverses it.
      if (p.cents<0 && (!o.original_id || !db.queryOne('SELECT order_id FROM pos_channel_orders WHERE store_id=? AND order_id=?',[id,o.original_id]))) issues.add('退款原单不在已导入范围内');
      fee_cents+=fee(p.cents);
    }
  }
  if (rows.length!==coverage.order_count) issues.add('订单覆盖记录不一致');
  if (expectedQrCents!==undefined && expectedQrCents!==qr) issues.add('订单扫码收入与综合营业统计不一致');
  return {date:day,fee_cents,actual:false,order_based:true,cash_cents,deferred_member_cents,noncash_cents,unclassified_cents,fee_complete:issues.size===0&&notes.size===0,
    source:'全渠道订单明细：扫码支付逐项×3.8‰并四舍五入，扫码退款按负数冲减；现金、会员卡及其他结算方式不收堂食扫码手续费'+(notes.size?'；'+[...notes].join('；'):''),
    warning:[...issues,...notes].join('；'),usable:issues.size===0};
}
module.exports={TYPE,cents,fee,kind,payments,date,detect,parse,initialize,prepare,importParsed,importWorkbook,dayPolicy};
