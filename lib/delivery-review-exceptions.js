'use strict';

// Business-approved exceptions affect completeness only. Originals and database
// readback must still pass before finish() consults this policy.
const rules = [{
  store_id: 25,
  platform_id: '29547426',
  from: '2026-10-23',
  types: ['operating', 'product'],
  approved_on: '2026-10-24',
  reason: '用户确认：麦地店同店重新开业，美团外卖资质待恢复，营业及商品完整性临时豁免',
}];
const fields = ['营业收入', '优惠前总额', '有效订单'];
const isBlank = value => ['', '--', '—', '-'].includes(String(value ?? '').trim());
// Exact historical store-days confirmed by the user on 2026-11-02: no orders
// because business was slow. This is not a closure or a future exemption.
const confirmedZeroRules=[
  {store_id:24,platform_id:'33212601',date:'2026-10-26'},
  {store_id:24,platform_id:'33212601',date:'2026-10-28'},
  {store_id:24,platform_id:'33212601',date:'2026-10-30'},
  {store_id:9,platform_id:'33851936',date:'2026-10-27'},
];
function confirmedZero(db,type,date,bindings,deviceId){
  if(!['operating','product'].includes(type))return [];
  const rules=confirmedZeroRules.filter(r=>r.date===date&&bindings.some(b=>Number(b.store_id)===r.store_id&&b.platform_id===r.platform_id));
  if(!rules.length)return [];
  const crypto=require('node:crypto'),files={};
  try{
    for(const kind of ['operating','product']){
      const f=db.queryOne("SELECT sha256,source_base64 FROM delivery_collector_files WHERE device_id=? AND report_type=? AND business_date=? AND store_key=''",[deviceId,'meituan_delivery_'+kind,date]);
      if(!f)return [];const bytes=Buffer.from(f.source_base64,'base64');if(crypto.createHash('sha256').update(bytes).digest('hex')!==f.sha256)return [];
      const parse=kind==='operating'?require('../syncbot/src/meituan-delivery/operating-file').parseOperatingBuffer:require('../syncbot/src/meituan-delivery/product-file').parseProductBuffer;
      files[kind]={sha256:f.sha256,parsed:parse(bytes,{from:date,expectedStoreIds:bindings.map(b=>b.platform_id)})};
    }
    return rules.filter(rule=>{
      const rows=files.operating.parsed.rows.filter(r=>r.门店id===rule.platform_id),sales=files.product.parsed.rows.filter(r=>r.门店id===rule.platform_id);
      if(rows.length!==1||sales.length)return false;
      const raw=rows[0];if(isBlank(raw.下单人数)||Number(raw.下单人数)!==0||!fields.every(f=>isBlank(raw[f])||Number(raw[f])===0))return false;
      return !db.queryOne('SELECT 1 found FROM meituan_delivery_product_records WHERE meituan_store_id=? AND biz_date=? AND (quantity<>0 OR sales_amount<>0) LIMIT 1',[rule.platform_id,date]);
    }).map(rule=>({...rule,confirmed_on:'2026-11-02',confirmation:'用户确认：生意差，当日无订单',source_blanks_preserved:true,operating_sha256:files.operating.sha256,product_sha256:files.product.sha256}));
  }catch{return [];}
}

function active(db, type, date, bindings) {
  return rules.filter(rule => {
    if (!rule.types.includes(type) || date < rule.from || !bindings.some(b => Number(b.store_id) === rule.store_id && b.platform_id === rule.platform_id)) return false;
    if (db.queryOne('SELECT 1 found FROM meituan_delivery_product_records WHERE meituan_store_id=? AND biz_date>=? AND biz_date<=? AND (quantity>0 OR sales_amount<>0) LIMIT 1', [rule.platform_id, rule.from, date])) return false;
    const rows = db.queryAll('SELECT biz_date,raw_json FROM meituan_delivery_operation_records WHERE meituan_store_id=? AND biz_date>=? AND biz_date<=?', [rule.platform_id, rule.from, date]);
    // A populated money/order metric ends the exception automatically. Do not
    // waive missing files, absent operating rows, or partially populated data.
    return rows.some(r => r.biz_date === date) && rows.every(r => {
      const raw = JSON.parse(r.raw_json || '{}');
      return fields.every(field => isBlank(raw[field]));
    });
  }).map(rule => ({ ...rule, temporary: true, auto_resume: '首次恢复营业收入、优惠前总额或有效订单数据时，恢复正常核验' }));
}

module.exports = { active, fields, isBlank, confirmedZero };
