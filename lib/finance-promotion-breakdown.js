'use strict';
const labels={automatic:'自动充值（扣余额）',manual:'手动充值（扫码支付）',other:'其他推广费用'};
function fundingType(row){
 const label=String(row.label||'');
 if(/充值/.test(label)&&(/扫码|手动|人工/.test(label)||row.source_kind==='external'))return 'manual';
 if(/余额变动|充值/.test(label))return 'automatic';
 return 'other';
}
function group(details,from,to){
 const buckets=new Map();
 for(const r of details.filter(x=>x.category==='promotion')){
  const type=fundingType(r);if(!buckets.has(type))buckets.set(type,[]);
  buckets.get(type).push({label:r.platform+' · '+r.label,amount:-r.amount,source:r.source||(r.source_kind==='external'?'额外开销登记':'平台原始账单'),date:r.date,record_id:r.record_id||null,batch_id:r.batch_id||null});
 }
 return Object.keys(labels).filter(type=>buckets.has(type)).map(type=>({label:labels[type],funding_type:type,amount:buckets.get(type).reduce((n,r)=>n+Math.round(r.amount*100),0)/100,source:'按原始来源分组',date:from===to?from:from+' 至 '+to,children:buckets.get(type)}));
}
module.exports={fundingType,group};
