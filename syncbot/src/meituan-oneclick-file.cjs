'use strict';
const XLSX=require('xlsx'),crypto=require('crypto');
const {assertDate}=require('./meituan-finance-dates.cjs');
const {restoreUsedRange}=require('./workbook-used-range.cjs');
const DEDUCTION='优惠抵扣金额（=代金券抵扣+买单折扣/满减+券包抵扣+菜品优惠+商家收银促销+免找）';
const REQUIRED=['买单订单号','收益时间','美团门店ID','业务','买单类型','流水类型','消费金额',DEDUCTION,'服务费（平台实际扣除）','合作商商业支持费用','商家承担退款','公益捐款','店内收银抵扣金额','商家应得','买单尾款顾客实付'];
function sheet(workbook){
 const s=workbook.Sheets['收益明细'];if(!s)return null;
 const grid=XLSX.utils.sheet_to_json(restoreUsedRange(s),{header:1,defval:'',raw:true});
 const index=grid.findIndex(row=>REQUIRED.every(h=>row.includes(h)));
 return index<0?null:{headers:grid[index],grid:grid.slice(index+1),headerRow:index+1};
}
const decode=data=>Buffer.from(String(data).replace(/^data:[^,]*;base64,/,''),'base64');
function isWorkbook(data){return !!sheet(data?.Sheets?data:XLSX.read(decode(data),{type:'buffer'}));}
function money(value,optional=false){
 const s=String(value??'').trim().replaceAll(',','');if(optional&&!s)return 0;
 if(!/^-?\d+(?:\.\d{1,2})?$/.test(s))throw Error('oneclick_amount_invalid');
 const cents=Math.round(Number(s)*100);if(!Number.isSafeInteger(cents))throw Error('oneclick_amount_invalid');return cents;
}
function parseFinance(buffer,from,to){
 if(from!==undefined){assertDate(from);assertDate(to);if(from>to)throw Error('oneclick_range_invalid');}
 const book=XLSX.read(buffer,{type:'buffer'}),report=sheet(book);if(!report)throw Error('oneclick_columns_missing');
 const totals={consumptionCents:0,deductionCents:0,posDeductionCents:0,serviceCents:0,refundCents:0,otherCents:0,nonTradeCents:0,merchantCents:0};
 const rows=[],inventory={},dates={},seen=new Set();let sourceRowCount=0;
 for(const gridRow of report.grid){
  if(gridRow.every(v=>v===''||v==null))continue;
  const raw=Object.fromEntries(report.headers.filter(Boolean).map(h=>[h,gridRow[report.headers.indexOf(h)]]));
  const date=String(raw.收益时间).slice(0,10).replaceAll('/','-');assertDate(date);
  if(from&&(date<from||date>to))throw Error('oneclick_date_mismatch');
  const storeId=String(raw.美团门店ID).trim(),type=String(raw.买单类型).trim(),transaction=String(raw.流水类型).trim(),order=String(raw.买单订单号).trim();
  if(!/^\d+$/.test(storeId)||!/^\d+$/.test(order)||raw.业务!=='买单'||!type||!transaction)throw Error('oneclick_row_invalid');
  const amount={consumptionCents:money(raw.消费金额),deductionCents:money(raw[DEDUCTION]),posDeductionCents:money(raw.店内收银抵扣金额),serviceCents:money(raw['服务费（平台实际扣除）'])+money(raw.合作商商业支持费用,true),refundCents:money(raw.商家承担退款),otherCents:money(raw.公益捐款),merchantCents:money(raw.商家应得)};
  if(amount.consumptionCents-amount.deductionCents-amount.posDeductionCents-amount.serviceCents-amount.refundCents-amount.otherCents!==amount.merchantCents)throw Error('oneclick_settlement_formula_mismatch');
  const paid=money(raw.买单尾款顾客实付),base=amount.consumptionCents-amount.deductionCents-amount.posDeductionCents;
  if(type==='一键买单'&&paid!==base)throw Error('oneclick_paid_formula_mismatch');
  const key=[storeId,raw.收益时间,order,type,transaction].join('|');if(seen.has(key))throw Error('oneclick_duplicate_row');seen.add(key);
  sourceRowCount++;inventory[type]=(inventory[type]||0)+1;
  for(const k of Object.keys(amount))totals[k]+=amount[k];
  if(type!=='一键买单')continue;
  rows.push({raw,date,storeId,type,transaction,order,key:'oneclick|'+key,amount,paidCents:paid,tailCents:base-amount.refundCents});dates[date]=(dates[date]||0)+1;
 }
 // These sheets describe the primary settlement rows. Never add them a second time.
 // Unallocated non-trade adjustments have no buy subtype, so require manual review.
 const nonTrade=book.Sheets['非交易明细'];if(nonTrade){const grid=XLSX.utils.sheet_to_json(restoreUsedRange(nonTrade),{header:1,defval:''}),header=grid[0]||[],idx=header.indexOf('商家应得');for(const r of grid.slice(1))if(r.some(Boolean)){const value=money(r[idx]);if(value!==0)throw Error('oneclick_nontrade_unallocated');totals.nonTradeCents+=value;} }
 if(totals.nonTradeCents!==0)throw Error('oneclick_nontrade_unallocated');
 const refundDetail=book.Sheets['已消费退明细'];if(refundDetail){
  const grid=XLSX.utils.sheet_to_json(restoreUsedRange(refundDetail),{header:1,defval:''}),headers=grid[0]||[];
  const amounts=new Map();for(const row of grid.slice(1)){if(!row.some(Boolean))continue;const amount=money(row[headers.indexOf('商家承担退款')]),order=String(row[headers.indexOf('买单订单号')]);amounts.set(order,(amounts.get(order)||0)+amount);}
  for(const [order,amount]of amounts){const main=report.grid.filter(row=>String(row[report.headers.indexOf('买单订单号')])===order).reduce((n,row)=>n+money(row[report.headers.indexOf('商家承担退款')]),0);if(amount!==main)throw Error('oneclick_refund_detail_unverified');}
 }
 const selected={tailCents:0,merchantCents:0,serviceCents:0,refundCents:0,otherCents:0};for(const r of rows){selected.tailCents+=r.tailCents;for(const k of ['merchantCents','serviceCents','refundCents','otherCents'])selected[k]+=r.amount[k];}
 return {...totals,rows,sourceRowCount,rowCount:rows.length,inventory,dates,storeIds:[...new Set(rows.map(r=>r.storeId))],storeCount:new Set(rows.map(r=>r.storeId)).size,selected,sha256:crypto.createHash('sha256').update(buffer).digest('hex')};
}
module.exports={parseFinance,isWorkbook,decode,money,DEDUCTION,REQUIRED};
