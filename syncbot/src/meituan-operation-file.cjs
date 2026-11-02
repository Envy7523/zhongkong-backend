'use strict';
const XLSX=require('xlsx'),crypto=require('crypto');
const {restoreUsedRange}=require('./workbook-used-range.cjs');
const {assertDate}=require('./meituan-finance-dates.cjs');
const metrics=['曝光人数','访问人数','购买人数','打卡人数','成交订单数','成交金额(优惠后)','消费金额','消费人数','退款金额','退款订单数','美团星级','点评星级','全部评价数'];
const key=v=>String(v??'').replace(/\s/g,'').replaceAll('（','(').replaceAll('）',')');
function parseOperation(data,from,to){
 assertDate(from);assertDate(to);if(from>to)throw Error('operation_range_invalid');
 const workbook=XLSX.read(data),records=[],seen=new Set();let sheetName;
 for(const name of workbook.SheetNames){if(name.trim()==='汇总')continue;
  const grid=XLSX.utils.sheet_to_json(restoreUsedRange(workbook.Sheets[name]),{header:1,defval:'',raw:true});
  const h=grid.findIndex((r,i)=>i<5&&r.map(key).includes('美团门店ID')&&r.map(key).includes('日期'));
  if(h<0)continue;if(sheetName)throw Error('operation_multiple_detail_sheets');sheetName=name;
  const headers=grid[h].map(key),col=label=>headers.indexOf(key(label));
  if(metrics.some(m=>col(m)<0))throw Error('operation_required_metric_missing');
  for(const row of grid.slice(h+1)){if(row.every(v=>v===''))continue;
   const rawDate=row[col('日期')],date=typeof rawDate==='number'?XLSX.SSF.format('yyyy-mm-dd',rawDate):String(rawDate).trim().replaceAll('/','-').slice(0,10);
   assertDate(date);const id=String(row[col('美团门店ID')]).trim();
   if(date<from||date>to||!/^\d+$/.test(id))throw Error('operation_row_scope_invalid');
   if(seen.has(id+':'+date))throw Error('operation_duplicate_store_day');seen.add(id+':'+date);
   const values={};for(const m of metrics){const value=row[col(m)];if(value===''||value==='-'||value==='--'){values[m]=null;continue;}const number=Number(String(value).replaceAll(',',''));if(!Number.isFinite(number)||number<0||(m.endsWith('星级')&&number>5))throw Error('operation_metric_invalid');values[m]=number;}
   records.push({date,id,values});
  }
 }
 if(!records.length)throw Error('operation_no_records');
 const dates=[...new Set(records.map(r=>r.date))].sort(),storeIds=[...new Set(records.map(r=>r.id))].sort();
 for(let d=from;d<=to;d=new Date(Date.parse(d+'T00:00:00Z')+86400000).toISOString().slice(0,10))if(!dates.includes(d))throw Error('operation_date_gap');
 const totals=Object.fromEntries(metrics.filter(m=>!m.endsWith('星级')).map(m=>[m,Math.round(records.reduce((n,r)=>n+(r.values[m]||0),0)*100)/100]));
 let summaryVerified=false;
 if(workbook.Sheets['汇总']){
  const grid=XLSX.utils.sheet_to_json(restoreUsedRange(workbook.Sheets['汇总']),{header:1,defval:'',raw:true});const h=grid.findIndex(r=>r.map(key).includes('美团门店ID')&&r.map(key).includes('日期'));
  if(h<0)throw Error('operation_summary_invalid');const columns=grid[h].map(key),summaries=grid.slice(h+1).filter(r=>r.some(v=>v!==''));
  for(const date of dates){const summary=summaries.filter(r=>String(r[columns.indexOf('日期')]).replaceAll('/','-')===date);if(summary.length!==1)throw Error('operation_summary_date_invalid');
   const row=summary[0],count=Number(String(row[columns.indexOf('美团门店ID')]).match(/全部(\d+)个门店/)?.[1]),details=records.filter(r=>r.date===date);
   if(count!==details.length)throw Error('operation_summary_count_mismatch');
   for(const m of metrics.filter(m=>!m.endsWith('星级')&&m!=='全部评价数')){const actual=details.reduce((n,r)=>n+r.values[m],0),expected=Number(row[columns.indexOf(key(m))]);if(!Number.isFinite(expected)||Math.abs(actual-expected)>.011)throw Error('operation_summary_total_mismatch');}
  }summaryVerified=true;
 }
 const missingMetrics=Object.fromEntries(metrics.map(m=>[m,records.filter(r=>r.values[m]===null).length]).filter(([,n])=>n));
 return {sha256:crypto.createHash('sha256').update(data).digest('hex'),rowCount:records.length,storeIds,dates,totals,sheetName,summaryVerified,missingMetrics};
}
module.exports={parseOperation,metrics};
