'use strict';
const isOneClick = value => /^一键买单/.test(String(value || '').trim());
const isDinePayment = value => /^(?:美团\/大众点评|美团|大众点评)支付(?:[-－]|$)/.test(String(value || '').trim());
const isMeituan = value => /^(?:美团\/大众点评|美团|大众点评)团购(?:[-－]|$)/.test(String(value || '').trim()) || isOneClick(value);
const isGroup = value => String(value || '').trim()==='抖音团购' || isMeituan(value);
function applyComposition(records, composition) {
  const days=new Map();
  for(const row of composition){const key=`${row.store_id}|${row.biz_date}`;if(!days.has(key))days.set(key,[]);days.get(key).push(row);}
  const applied=new Set();
  for(const row of records){
    if(row.source_type!=='pos'||row.channel!=='meituan_group')continue;
    const key=`${row.store_id}|${row.biz_date}`,parts=days.get(key)||[];
    // Reclassify historical mirrors even on days without a one-click tail.
    // Meituan/DaZhong payment is dine-in, while vouchers and tails stay group-buy.
    if(!parts.some(p=>isMeituan(p.category)||isDinePayment(p.category)))continue;
    row.recorded_amount=applied.has(key)?0:parts.filter(p=>isMeituan(p.category)).reduce((n,p)=>n+Math.round(Number(p.amount)*100),0)/100;
    applied.add(key);
  }
}
module.exports={isOneClick,isDinePayment,isMeituan,isGroup,applyComposition};
