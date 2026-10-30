'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),XLSX=require('xlsx');
const {plainDate}=require('./operating-file');
function parseSettlementBuffer(buffer,{from,to=from,expectedStoreIds,includedStoreIds=expectedStoreIds}={}){
 if(plainDate(from)!==from||plainDate(to)!==to||from>to)throw Error('settlement_date_invalid');
 if(!Array.isArray(expectedStoreIds)||!expectedStoreIds.length||expectedStoreIds.some(id=>typeof id!=='string'||!/^\d+$/.test(id))||new Set(expectedStoreIds).size!==expectedStoreIds.length)throw Error('settlement_scope_invalid');
 if(!Array.isArray(includedStoreIds)||!includedStoreIds.length||includedStoreIds.some(id=>typeof id!=='string'||!/^\d+$/.test(id))||new Set(includedStoreIds).size!==includedStoreIds.length)throw Error('settlement_scope_invalid');
 if(!Buffer.isBuffer(buffer)||buffer.length<30||buffer.length>50*1024*1024||buffer.slice(0,2).toString()!=='PK')throw Error('settlement_file_invalid');
 const wb=XLSX.read(buffer,{type:'buffer',raw:true,cellDates:false});
 function table(name,fields){if(!wb.Sheets[name])throw Error('settlement_sheet_missing');const grid=XLSX.utils.sheet_to_json(wb.Sheets[name],{header:1,raw:true,defval:''});if(grid.length>200001)throw Error('settlement_row_limit');const candidates=grid.slice(0,5).map((r,i)=>fields.every(f=>r.filter(v=>v===f).length===1)?i:-1).filter(i=>i>=0);if(candidates.length!==1)throw Error('settlement_header_invalid');const header=grid[candidates[0]];return grid.slice(candidates[0]+1).filter(r=>r.some(v=>v!==''&&v!==null)).map(r=>Object.fromEntries(header.map((f,i)=>[f,r[i]??''])));}
 const orders=table('订单明细',['门店id','门店名称','结算id','交易类型','商家应收款','账单日期','结算状态']);
 const bills=table('账单明细',['结算id','门店id','账单日期','账单金额','结算状态']);
 const expected=new Set(expectedStoreIds),stores=new Set(),billKeys=new Set(),sums=new Map(),enteredKeys=new Set(),transactions={},statuses=new Set();
 function cents(v){const s=String(v).trim().replace(/,/g,'');if(!/^[+-]?\d+(?:\.\d{1,2})?$/.test(s))throw Error('settlement_money_invalid');const n=Math.round(Number(s)*100);if(!Number.isSafeInteger(n))throw Error('settlement_money_overflow');return n;}
 function identity(r){if(typeof r.门店id==='number'&&!Number.isSafeInteger(r.门店id))throw Error('settlement_id_precision');const store=String(r.门店id).trim();if(!expected.has(store))throw Error('settlement_unknown_store');const date=plainDate(r.账单日期);if(!date||date<from||date>to)throw Error('settlement_date_mismatch');if(typeof r.结算id==='number'&&!Number.isSafeInteger(r.结算id))throw Error('settlement_id_precision');const id=String(r.结算id).trim();if(!/^\d+$/.test(id))throw Error('settlement_identity_invalid');stores.add(store);return JSON.stringify([store,date,id]);}
 let total=0;for(const r of orders){const key=identity(r),type=String(r.交易类型).trim();if(!type||!String(r.门店名称).trim())throw Error('settlement_identity_invalid');const amount=cents(r.商家应收款);sums.set(key,(sums.get(key)||0)+amount);if(String(r.结算状态).trim()!=='未入账')enteredKeys.add(key);total+=amount;transactions[type]??={rows:0,cents:0};transactions[type].rows++;transactions[type].cents+=amount;statuses.add(String(r.结算状态));}
 // An official pending bill can remain zero before entry, while its daily trade
 // receivables already exist. Only a complete official summary, including every
 // transaction description/count/signed cent, can validate that interim source.
 let controlVerified=false;
 if(wb.Sheets['汇总信息']){
  const grid=XLSX.utils.sheet_to_json(wb.Sheets['汇总信息'],{header:1,raw:true,defval:''}),money=v=>cents(String(v).trim().replace(/[元￥¥]/g,''));
  const amounts=grid.filter(r=>r[0]==='账单金额'),totals=grid.filter(r=>r[2]==='合计'),counts=grid.filter(r=>r[0]==='门店数量');
  if(amounts.length!==1||totals.length!==1||counts.length!==1||money(amounts[0][1])!==total||money(totals[0][4])!==total||Number(counts[0][1])!==new Set([...orders,...bills].map(r=>String(r.门店id).trim())).size)throw Error('settlement_source_control_mismatch');
  const descriptions=new Map(),aliases={'商家补送配送费':'补送配送费','折扣菜节省转入广告':'流量助手节省转入广告','推广账户自动充值':'推广账户充值'};
  for(const r of orders){const raw=String(r.交易描述||'').trim(),name=aliases[raw]||raw;if(!name)throw Error('settlement_source_control_description_missing');const g=descriptions.get(name)||{rows:0,cents:0};g.rows++;g.cents+=cents(r.商家应收款);descriptions.set(name,g);}
  const seen=new Set();for(const row of grid){if(!/^\d+笔$/.test(String(row[3])))continue;const name=String(row[2]).trim();if(seen.has(name))throw Error('settlement_source_control_duplicate');seen.add(name);const wanted=descriptions.get(name)||{rows:0,cents:0};if(Number(String(row[3]).slice(0,-1))!==wanted.rows||money(row[4])!==wanted.cents)throw Error('settlement_source_control_mismatch');}
  if([...descriptions.keys()].some(k=>!seen.has(k)))throw Error('settlement_source_control_mismatch');controlVerified=true;
 }
 const pending=[];let billTotal=0;for(const r of bills){const key=identity(r);if(billKeys.has(key))throw Error('settlement_duplicate_bill');billKeys.add(key);const amount=cents(r.账单金额);billTotal+=amount;if((sums.get(key)||0)!==amount){
  if(!controlVerified||String(r.结算状态).trim()!=='待结算'||amount!==0||!sums.has(key)||enteredKeys.has(key))throw Error('settlement_bill_reconciliation_failed');
  pending.push({store_id:String(r.门店id).trim(),date:plainDate(r.账单日期),settlement_id:String(r.结算id).trim(),receivable_cents:sums.get(key),bill_cents:amount});
 }}
 if([...sums.keys()].some(key=>!billKeys.has(key)))throw Error('settlement_bill_missing');
 if(!Number.isSafeInteger(total)||!Number.isSafeInteger(billTotal)||total!==billTotal+pending.reduce((n,r)=>n+r.receivable_cents-r.bill_cents,0))throw Error('settlement_total_mismatch');
 const included=new Set(includedStoreIds),chosenOrders=orders.filter(r=>included.has(String(r.门店id).trim())),chosenBills=bills.filter(r=>included.has(String(r.门店id).trim())),chosenStores=new Set([...chosenOrders,...chosenBills].map(r=>String(r.门店id).trim())),chosenTransactions={};
 let chosenTotal=0;for(const r of chosenOrders){const amount=cents(r.商家应收款),type=String(r.交易类型).trim();chosenTotal+=amount;chosenTransactions[type]??={rows:0,cents:0};chosenTransactions[type].rows++;chosenTransactions[type].cents+=amount;}
 const chosenPending=pending.filter(r=>included.has(r.store_id));
 return {ok:true,report_type:'meituan_delivery_settlement',from,to,row_count:chosenOrders.length,bill_count:chosenBills.length,store_count:chosenStores.size,store_ids:[...chosenStores].sort(),stores_without_rows:includedStoreIds.filter(id=>!chosenStores.has(id)),receivable_cents:chosenTotal,transactions:chosenTransactions,settlement_statuses:[...new Set(chosenOrders.map(r=>String(r.结算状态)))],bank_received_verified:false,totals_complete:true,coverage_verified:chosenStores.size===included.size,sha256:crypto.createHash('sha256').update(buffer).digest('hex'),source_controls_verified:controlVerified,bill_reconciliation_complete:chosenPending.length===0,pending_bills:chosenPending,pending_receivable_cents:chosenPending.reduce((n,r)=>n+r.receivable_cents,0)};
}
function parseSettlementFile(file,options){const stat=fs.statSync(file);if(!stat.isFile()||stat.size>50*1024*1024)throw Error('settlement_file_invalid');return parseSettlementBuffer(fs.readFileSync(file),options);}
module.exports={parseSettlementBuffer,parseSettlementFile};
