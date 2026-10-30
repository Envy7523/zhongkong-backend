'use strict';
// Daily-report presentation only. Shared settlement, monthly boards and source
// transactions retain their existing principal-based net-income calculation.
const memberPolicy=require('./member-consumption-policy');
const paymentComposition=require('./dine-payment-composition');
const cents=n=>Math.round(Number(n||0)*100);
function split(revenue,sources,from,to){
 const active=[];
 for(let day=from;day<=to;day=new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10)){
  const comp=sources.composition.filter(r=>r.biz_date===day);
  const sales=sources.pos.filter(r=>r.biz_date===day&&['store_sales','pickup'].includes(r.channel));
  if(sources.closed_dates?.includes(day)&&!comp.some(r=>cents(r.amount)!==0)&&!sales.some(r=>cents(r.recorded_amount)!==0))continue;
  active.push({day,payment:paymentComposition.read(comp)});
 }
 const policy=sources.member_card_consumption;
 const days=(policy?.available?policy.days:[]).filter(r=>active.some(d=>d.day===r.biz_date));
 const ready=active.every(({day,payment})=>policy?.available?days.some(r=>r.biz_date===day&&r.ready):payment.parts.member.present&&payment.parts.member.rows.every(r=>cents(r.amount)===0));
 const summary=memberPolicy.summarize(days,from,to);
 const originalMemberFees=revenue.details.filter(r=>r.payment_fee).reduce((n,r)=>n+Number(r.payment_fee.member_fee_cents||0),0);
 const principal=ready?cents(summary.principal):null,gift=ready?cents(summary.gift):null,fee=ready?cents(summary.fee):null;
 const memberBase=policy?.available?(principal||0):active.reduce((n,d)=>n+d.payment.parts.member.cents,0);
 const values={...revenue.values,
  dine:revenue.values.dine===null?null:(cents(revenue.values.dine)-memberBase)/100,
  memberConsumption:ready?(principal+gift)/100:null,
  // Reconcile the included principal fee once and keep it inside the fee
  // total. Its breakdown remains available; gift is a separate deduction.
  fee:revenue.values.fee===null||!ready?null:(cents(revenue.values.fee)+originalMemberFees-fee)/100,
  memberGift:ready?(gift===0?0:-gift/100):null};
 const details=revenue.details.map(r=>{
  if(!r.payment_fee)return {...r};
  const p=r.payment_fee,scan=p.fee_cents-Number(p.member_fee_cents||0);
  return {...r,label:p.order_based?'收款手续费（逐笔计算）':'收款手续费（理论估算）',amount:scan/100,source:String(r.source||'收银付款手续费').split('；会员本金')[0],payment_fee:{...p,fee_cents:scan,member_fee_cents:0}};
 });
 for(const d of days.filter(r=>r.ready)){
  details.push({platform:'会员卡',date:d.biz_date,label:'会员消费赠金扣减',category:'member_gift',amount:d.gift_cents/100,source:'会员消费及退单流水；赠金不计实收'});
  details.push({platform:'会员卡',date:d.biz_date,label:'会员本金手续费（0.38%测算）',category:'member_fee',amount:d.fee_cents/100,source:'消费本金逐笔×0.0038；退款反冲，非实际提现账单',principal:d.principal_cents/100,fee_actual:false});
 }
 const problems=[...revenue.problems];
 if(!ready){
  problems.push('会员卡消费本金、赠金或营业日关联不完整，会员卡消费及对应扣减暂留空。');
  details.push({platform:'会员卡',date:from===to?from:from+' 至 '+to,label:'会员消费赠金扣减',category:'member_gift',amount:null,source:'会员消费明细待核对'});
  details.push({platform:'会员卡',date:from===to?from:from+' 至 '+to,label:'会员本金手续费（0.38%测算）',category:'member_fee',amount:null,source:'会员本金明细待核对'});
 }
 return {...revenue,values,details,problems,ready:revenue.ready&&ready,member_split:{ready,principal:principal===null?null:principal/100,gift:gift===null?null:gift/100,consumption:values.memberConsumption,fee:fee===null?null:fee/100,days}};
}
module.exports={split};
