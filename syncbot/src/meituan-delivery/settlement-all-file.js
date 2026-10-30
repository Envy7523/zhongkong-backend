'use strict';
const XLSX=require('xlsx');
const {parseSettlementBuffer}=require('./settlement-file');
function inspectSettlementAll(buffer,{from,expectedStoreIds}={}){
 if(!Array.isArray(expectedStoreIds)||!expectedStoreIds.length)throw Error('settlement_scope_invalid');
 if(!Buffer.isBuffer(buffer)||buffer.length>50*1024*1024)throw Error('settlement_file_invalid');
 const wb=XLSX.read(buffer,{type:'buffer',raw:true}),tables={},sourceIds=new Set();
 for(const name of ['订单明细','账单明细']){
  if(!wb.Sheets[name])throw Error('settlement_sheet_missing');
  const grid=XLSX.utils.sheet_to_json(wb.Sheets[name],{header:1,raw:true,defval:''});
  const headers=grid.slice(0,5).map((r,i)=>r.filter(v=>v==='门店id').length===1&&r.filter(v=>v==='结算id').length===1?i:-1).filter(i=>i>=0);
  if(headers.length!==1)throw Error('settlement_header_invalid');
  const h=headers[0],column=grid[h].indexOf('门店id'),rows=grid.slice(h+1).filter(r=>r.some(v=>v!==''&&v!==null));
  for(const row of rows){const id=row[column];if(typeof id==='number'&&!Number.isSafeInteger(id))throw Error('settlement_id_precision');const text=String(id).trim();if(!/^\d+$/.test(text))throw Error('settlement_identity_invalid');sourceIds.add(text);}
  tables[name]={header:grid.slice(0,h+1),column,rows};
 }
 const allIds=[...sourceIds],full=parseSettlementBuffer(buffer,{from,expectedStoreIds:allIds.length?allIds:expectedStoreIds});
 const expected=new Set(expectedStoreIds),filtered=XLSX.utils.book_new();
 for(const [name,t]of Object.entries(tables))XLSX.utils.book_append_sheet(filtered,XLSX.utils.aoa_to_sheet([...t.header,...t.rows.filter(r=>expected.has(String(r[t.column]).trim()))]),name);
 // Derived workbook is for importing only. The immutable uploaded original is retained separately.
 const importBuffer=XLSX.write(filtered,{type:'buffer',bookType:'xlsx'}),parsed=parseSettlementBuffer(buffer,{from,expectedStoreIds:allIds.length?allIds:expectedStoreIds,includedStoreIds:expectedStoreIds});
 parsed.sha256=require('node:crypto').createHash('sha256').update(importBuffer).digest('hex');
 const t=tables['订单明细'],header=t.header.at(-1),amount=header.indexOf('商家应收款'),type=header.indexOf('交易类型'),storeTotals={};
 for(const row of t.rows){const id=String(row[t.column]).trim();if(!expected.has(id))continue;const value=storeTotals[id]??={rows:0,cents:0,transactions:{}};const cents=Math.round(Number(String(row[amount]).replaceAll(',',''))*100),kind=String(row[type]).trim();value.rows++;value.cents+=cents;value.transactions[kind]??={rows:0,cents:0};value.transactions[kind].rows++;value.transactions[kind].cents+=cents;}
 return {importBuffer,parsed:{...parsed,store_totals:storeTotals},receipt:{...parsed,sha256:full.sha256,source_mode:'all_stores',source_row_count:full.row_count,source_store_count:full.store_count,source_receivable_cents:full.receivable_cents,excluded_store_ids:allIds.filter(id=>!expected.has(id)),source_all_reconciled:full.bill_reconciliation_complete,source_controls_verified:full.source_controls_verified}};
}
module.exports={inspectSettlementAll};
