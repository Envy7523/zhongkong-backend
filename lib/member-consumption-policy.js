'use strict';
// Read-only settlement policy. Asset movements and recharges never become sales.
const cents=n=>Math.round(Number(n||0)*100);
const fee=n=>Math.sign(n)*Math.floor((Math.abs(n)*38+5000)/10000);
const aliases=['会员卡','会员储值消费','储值卡'];
function summarize(days,from,to){
  const rows=days.filter(r=>r.biz_date>=from&&r.biz_date<=to),valid=rows.filter(r=>r.ready);
  const sum=k=>valid.reduce((n,r)=>n+r[k],0);
  const principal=sum('principal_cents'),gift=sum('gift_cents'),total=principal+gift;
  return {available:true,ready:rows.every(r=>r.ready),date_from:from,date_to:to,
    principal:principal/100,gift:gift/100,consumption:total/100,fee:sum('fee_cents')/100,net:(principal-sum('fee_cents'))/100,
    principal_ratio:total>0?principal/total:null,gift_ratio:total>0?gift/total:null,
    fee_rate:0.0038,fee_actual:false,fee_basis:'逐笔消费本金×3.8‰测算；退款反向冲减，非实际提现扣费',
    missing_days:rows.filter(r=>!r.ready).map(r=>({store_id:r.store_id,store_name:r.store_name,biz_date:r.biz_date,reason:r.reason})),
    days:rows};
}
function build(db,ids,from,to,composition){
  const unavailable={available:false,ready:false,date_from:from,date_to:to,principal:null,gift:null,consumption:null,fee:0,net:null,missing_days:[],days:[]};
  if(typeof db.queryOne!=='function'||db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='pos_member_transactions'")?.name!=='pos_member_transactions')return unavailable;
  ids=[...new Set(ids.map(Number).filter(n=>Number.isSafeInteger(n)&&n>0))];
  if(!ids.length)return {...summarize([],from,to),available:true};
  const scope=ids.map(()=>'?').join(',');
  const comp=composition||db.queryAll(`SELECT store_id,biz_date,category,amount FROM business_revenue_compositions WHERE store_id IN (${scope}) AND biz_date BETWEEN ? AND ?`,[...ids,from,to]);
  const rows=db.queryAll(`SELECT store_id,biz_date,transaction_date,principal_cents,gift_cents,consumption_cents FROM pos_member_transactions WHERE store_id IN (${scope}) AND (biz_date BETWEEN ? AND ? OR (biz_date='' AND transaction_date BETWEEN ? AND ?)) AND operation IN ('消费','退单')`,[...ids,from,to,from,to]);
  const imports=db.queryAll('SELECT date_from,date_to FROM pos_member_imports WHERE complete_scope=1 AND date_from<=? AND date_to>=?',[to,from]);
  const names=new Map(db.queryAll(`SELECT id,store_name FROM stores WHERE id IN (${scope})`,ids).map(r=>[r.id,r.store_name]));
  const map=new Map(),memberDays=new Set();
  const day=(id,date)=>{const k=id+'|'+date;if(!map.has(k))map.set(k,{store_id:id,store_name:names.get(id)||'',biz_date:date,pos_cents:0,principal_cents:0,gift_cents:0,consumption_cents:0,fee_cents:0,unmatched:0});return map.get(k);};
  for(const r of comp)if(ids.includes(Number(r.store_id))&&aliases.includes(String(r.category).trim())){const d=day(r.store_id,r.biz_date);d.pos_cents+=cents(r.amount);d.has_pos=true;}
  for(const r of rows){const d=day(r.store_id,r.biz_date||r.transaction_date);if(!r.biz_date){if(r.consumption_cents)d.unmatched++;continue;}if(r.consumption_cents)memberDays.add(d.store_id+'|'+d.biz_date);d.principal_cents+=r.principal_cents;d.gift_cents+=r.gift_cents;d.consumption_cents+=r.consumption_cents;d.fee_cents+=fee(r.principal_cents);}
  for(const d of map.values()){
    d.covered=imports.some(r=>r.date_from<=d.biz_date&&r.date_to>=d.biz_date);
    // A complete export from a new POS system does not cover legacy payments.
    // Explicit POS payment evidence without any linked settled movement is
    // missing data, even when the export's date range includes that day.
    const missingConsumption=d.pos_cents!==0&&!memberDays.has(d.store_id+'|'+d.biz_date);
    d.ready=d.covered&&!d.unmatched&&!!d.has_pos&&!missingConsumption;
    d.reason=!d.covered?'会员交易流水未完整导入':d.unmatched?'会员流水尚未关联收银营业日':!d.has_pos?'收银会员付款构成缺失':missingConsumption?'收银有会员付款，缺少对应消费流水（请核对旧系统报表）':'';
    d.difference_cents=d.principal_cents-d.pos_cents;
    // POS sometimes already reports principal. Replace that component, never subtract gift again.
    d.delta_cents=(d.ready?d.principal_cents:0)-d.pos_cents;
  }
  return summarize([...map.values()].sort((a,b)=>a.biz_date.localeCompare(b.biz_date)||a.store_id-b.store_id),from,to);
}
function applyPrincipal(rows,policy){
  if(!policy?.available)return;
  const byKey=new Map(policy.days.map(d=>[d.store_id+'|'+d.biz_date,d])),used=new Set();
  for(const r of rows){const key=r.store_id+'|'+r.biz_date,d=byKey.get(key);if(!d||used.has(key)||r.member_principal_adjusted||r.exclude_from_sales||!['store_sales','pickup'].includes(r.channel))continue;
    for(const k of ['income','settled','confirmed'])if(r[k]!==undefined)r[k]=(cents(r[k])+d.delta_cents)/100;
    r.member_principal_adjusted=true;used.add(key);
  }
}
function applyFee(rows,policy){
  if(!policy?.available)return;
  const byKey=new Map(policy.days.filter(d=>d.ready).map(d=>[d.store_id+'|'+d.biz_date,d])),used=new Set();
  for(const r of rows){const key=r.store_id+'|'+r.biz_date,d=byKey.get(key);if(!d||used.has(key)||r.member_fee_applied||r.exclude_from_sales||!['store_sales','pickup'].includes(r.channel))continue;
    for(const k of ['income','settled','confirmed'])if(r[k]!==undefined)r[k]=(cents(r[k])-d.fee_cents)/100;
    r.member_fee_applied=true;used.add(key);
  }
}
module.exports={aliases,fee,build,summarize,applyPrincipal,applyFee};
