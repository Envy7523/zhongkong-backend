'use strict';
const names={cash:['现金','现金支付','现金收入'],scan:['扫码支付'],member:['会员卡','会员储值消费','储值卡']};
function read(rows){
 const parts=Object.fromEntries(Object.entries(names).map(([key,aliases])=>{const base=rows.filter(r=>aliases.includes(String(r.category||'').trim()));const matched=key==='scan'?base.concat(rows.filter(r=>require('./pos-group-payments').isDinePayment(r.category))):base;return [key,{present:base.length>0,cents:matched.reduce((n,r)=>n+Math.round(Number(r.amount||0)*100),0),rows:matched}];}));
 return {parts,complete:Object.values(parts).every(p=>p.present),total_cents:Object.values(parts).reduce((n,p)=>n+p.cents,0)};
}
module.exports={read};
