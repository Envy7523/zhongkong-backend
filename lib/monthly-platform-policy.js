'use strict';
const finance=require('./store-finance-revenue');
const channels={meituan_delivery:'meituan',taobao_flash:'taobao',jd_delivery:'jd'};
function build(db,ids,from,to,rules){
 const costs=new Map(),net=new Map(),warnings=[];let classified=true,complete=true;
 for(const id of ids){const source=finance.loadSources(db,id,from,to);source.fee_rules=rules;
  for(let day=from;day<=to;day=new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10)){
   const result=finance.calculate(source,day,day);if(!result.classified){classified=false;warnings.push(...result.problems.filter(p=>/分类|人工/.test(p)));}
   for(const key of Object.values(channels))if(result.availability[key]?.abnormal){complete=false;warnings.push(result.availability[key].note);}
   const delivery=Object.values(result.delivery);const c=costs.get(day)||{cashier:0,real:0,categories:{third_party:{cashier:0,real:0},promotion:{cashier:0,real:0}}};
   for(const category of ['third_party','promotion']){
    const cashier=delivery.reduce((n,s)=>n+s[category],0),real=delivery.reduce((n,s)=>n+s.outside_platform[category],0);
    c.cashier+=cashier;c.real+=real;c.categories[category].cashier+=cashier;c.categories[category].real+=real;
   }
   costs.set(day,c);
   for(const [channel,key]of Object.entries(channels))net.set(`${id}|${day}|${channel}`,result.delivery[key].available?result.delivery[key].actual:0);
  }
 }
 // Missing manual imports are zero contributions, not a calculation blocker.
 // Classification failures remain separate; readiness is not data completeness.
 return {costs,net,warnings:[...new Set(warnings)],ready:classified,data_complete:complete,missing_as_zero:!complete};
}
module.exports={build};
