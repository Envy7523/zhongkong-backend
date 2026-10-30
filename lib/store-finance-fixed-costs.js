'use strict';
const SOURCES=['bookkeeping','operating_previous','operating_current'];
const ITEMS={rent:'月度房租及物业',utilities:'月度水电费',salary:'月度工资'};
function normalize(input={}){
 const result={};for(const key of Object.keys(ITEMS)){const value=input[key]||'bookkeeping';if(!SOURCES.includes(value))throw Error('无效费用来源');result[key]=value;}
 if(input.reference_month)throw Error('参考月份由日报日期和费用来源确定，不能指定其他月份');
 return result;
}
function settings(db,storeId){
 const row=db.queryOne('SELECT value FROM config WHERE key=?',['store_finance_cost_sources:'+Number(storeId)]);
 if(row){try{const input=JSON.parse(row.value);delete input.reference_month;return normalize(input);}catch{throw Error('门店费用来源配置无效');}}
 return normalize(Number(storeId)===26?{rent:'operating_previous',utilities:'operating_previous',salary:'operating_previous'}:{});
}
function previousMonth(month){return new Date(Date.parse(month+'-01T00:00:00Z')-86400000).toISOString().slice(0,7);}
function calculate(db,storeId,from,to,selected,classify,asOf){
 const feeRules=require('./delivery-fee-rules').read(db);
 const values={rent:0,utilities:0,salary:0},details=[],problems=[];
 const months=new Set();for(let d=from;d<=to;d=new Date(Date.parse(d+'T00:00:00Z')+86400000).toISOString().slice(0,10))months.add(d.slice(0,7));
 for(const month of months){const days=new Date(Date.parse(month+'-01T00:00:00Z'));days.setUTCMonth(days.getUTCMonth()+1);days.setUTCDate(0);const totalDays=days.getUTCDate();
  const first=from.slice(0,7)===month?Number(from.slice(8)):1,last=to.slice(0,7)===month?Number(to.slice(8)):totalDays;
  for(const key of Object.keys(ITEMS)){
   const reportMonth=asOf.slice(0,7),source=selected[key],reference=source==='operating_previous'?previousMonth(reportMonth):reportMonth;
   let rows,basis,found;
   if(source==='bookkeeping'){
    const cutoff=reference===asOf.slice(0,7)?asOf:reference+'-31';
    rows=db.queryAll('SELECT rowid AS id,date,category_name,subcategory_name,amount FROM bookkeeping_entries WHERE store_id=? AND date>=? AND date<=?',[storeId,reference+'-01',cutoff]).filter(r=>classify(r)===key);
    found=rows.length>0;basis=-rows.reduce((n,r)=>n+Math.round(Number(r.amount||0)*100),0);
   }else{
    rows=db.queryAll('SELECT rowid AS id,date,item,amount FROM store_operating_costs WHERE store_id=? AND item=? AND substr(date,1,7)=?',[storeId,ITEMS[key],reference]);found=rows.length>0;basis=rows.reduce((n,r)=>n+Math.round(Number(r.amount||0)*100),0);
   }
   if(!found){values[key]=null;problems.push(`${reference}「${ITEMS[key]}」${source==='bookkeeping'?'记账本':'运营成本'}数据未登记，暂留空。`);}
   else if(values[key]!==null){
    if(source==='bookkeeping'&&feeRules.ledger_enabled){
     const tag=require('./delivery-fee-rules').ledgerType;
     const spread=-rows.filter(r=>tag(r,feeRules)==='accrual').reduce((n,r)=>n+Math.round(Number(r.amount||0)*100),0);
     const direct=rows.filter(r=>tag(r,feeRules)!=='accrual'&&tag(r,feeRules)!=='platform'&&r.date>=from&&r.date<=to).reduce((n,r)=>n+Math.round(Number(r.amount||0)*100),0);
     values[key]+=direct/100-(Math.round(spread*last/totalDays)-Math.round(spread*(first-1)/totalDays))/100;
    }else values[key]-=(Math.round(basis*last/totalDays)-Math.round(basis*(first-1)/totalDays))/100;
   }
   details.push({key,source,reference_month:reference,monthly_amount:found?basis/100:null,days_in_month:totalDays,tag_policy:source==='bookkeeping'&&feeRules.ledger_enabled?'manual':null,source_rows:rows.map(r=>({id:r.id,date:r.date,label:r.item||r.category_name+' / '+r.subcategory_name,amount:Number(r.amount)}))});
  }
 }
 return {values,details,problems,ready:Object.values(values).every(v=>v!==null)};
}
module.exports={normalize,settings,calculate};
