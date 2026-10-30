'use strict';

// Read-only disclosure of the two source kinds. Never replaces resolved revenue.
const cents=value=>Math.round((Number(value)||0)*100);
function build(db, resolved, missing=[], checks=[]) {
  const selected=resolved.filter(r=>r.channel==='meituan_group'&&r.source_used==='platform');
  if(!selected.length)return [];
  const keys=new Set(selected.map(r=>r.store_id+'|'+r.biz_date));
  const ids=[...new Set(selected.map(r=>r.store_id))],dates=selected.map(r=>r.biz_date).sort();
  const raw=db.queryAll(`SELECT store_id,income_date,benefit_kind,sale_price,customer_promotion,customer_paid,merchant_income,fee_breakdown_json
    FROM meituan_group_buy_benefit_records WHERE match_status='matched' AND store_id IN (${ids.map(()=>'?').join(',')}) AND income_date BETWEEN ? AND ?`,[...ids,dates[0],dates.at(-1)])
    .filter(r=>keys.has(r.store_id+'|'+r.income_date));
  const covered=new Set(db.queryAll('SELECT income_date FROM meituan_oneclick_coverage WHERE income_date BETWEEN ? AND ?',[dates[0],dates.at(-1)]).map(r=>r.income_date));
  const zeroDays=selected.every(r=>r.source_status==='platform_no_activity');
  return [['group','团购券'],['oneclick','一键买单（尾款）']].map(([kind,name])=>{
    const rows=raw.filter(r=>(r.benefit_kind==='oneclick'?'oneclick':'group')===kind);
    const missingDays=missing.filter(r=>r.channel==='meituan_group'&&keys.has(r.store_id+'|'+r.biz_date)&&(kind==='oneclick'?r.source_part==='oneclick':r.source_part!=='oneclick'));
    if(kind==='oneclick')for(const r of checks.filter(r=>keys.has(r.store_id+'|'+r.biz_date)&&r.source_status==='missing'&&Number(r.pos_tail)!==0))missingDays.push(r);
    const available=rows.length>0||zeroDays||(kind==='oneclick'&&selected.every(r=>covered.has(r.biz_date)));
    const sum=field=>available?rows.reduce((n,r)=>n+cents(r[field]),0)/100:null;
    const fees=available?rows.reduce((n,r)=>{let f={};try{f=JSON.parse(r.fee_breakdown_json||'{}');}catch{}
      return n+['service_fee','insurance_fee','promotion_fee','refund_amount'].reduce((a,k)=>a+cents(f[k]),0);},0)/100:null;
    return {kind,name,available,partial:missingDays.length>0,gross:sum('sale_price'),discount:sum('customer_promotion'),income:sum('customer_paid'),fees,net:sum('merchant_income')};
  });
}
module.exports={build};
