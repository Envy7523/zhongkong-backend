'use strict';
const crypto=require('node:crypto'),XLSX=require('xlsx');
const {plainDate}=require('../meituan-delivery/operating-file');
const aliases={id:['门店id','门店ID','门店编号','京东门店ID'],date:['日期','营业日期'],name:['商品名','商品名称'],quantity:['商品销量','销量'],sales:['商品销售额','销售额'],income:['收入','营业收入'],gross:['营业额','优惠前总额'],orders:['有效订单','订单数'],completed:['订单完成/退款完成时间','订单完成时间'],amount:['应结金额','实际收入'],orderType:['订单类型']};
function number(value,money=false){const text=String(value??'').trim().replace(/[,，￥¥]/g,'');if(!/^[+-]?\d+(?:\.\d+)?$/.test(text))throw Error('jd_source_number_invalid');if(money&&!/^[+-]?\d+(?:\.\d{1,2})?$/.test(text))throw Error('jd_source_money_precision');const n=Number(text)*(money?100:1);if(!Number.isSafeInteger(n)&&Math.abs(n-Math.round(n))>0.000001)throw Error('jd_source_number_precision');const result=Math.round(n);if(!Number.isSafeInteger(result))throw Error('jd_source_number_overflow');return result;}
function completedDay(value){
 if(typeof value==='number'){const d=XLSX.SSF.parse_date_code(value);return d?plainDate(`${d.y}-${d.m}-${d.d}`):null;}
 return plainDate(String(value??'').trim().slice(0,10));
}
function inspectJdBuffer(buffer,{type,date,expectedStoreIds,allowUnmatched=false}={}){
 if(!['operating','product','settlement'].includes(type)||plainDate(date)!==date||!Array.isArray(expectedStoreIds)||!expectedStoreIds.length||new Set(expectedStoreIds).size!==expectedStoreIds.length||expectedStoreIds.some(id=>typeof id!=='string'||!/^\d+$/.test(id)))throw Error('jd_source_parameters_invalid');
 if(!Buffer.isBuffer(buffer)||buffer.length<20||buffer.length>30*1024*1024)throw Error('jd_source_size_invalid');
 const workbook=XLSX.read(buffer,{type:'buffer',raw:true,cellDates:false}),candidates=[];
 const required=type==='operating'?['id','date','income','gross','orders']:type==='product'?['id','date','name','quantity','sales']:['id','completed','amount','orderType'];
 for(const sheet of workbook.SheetNames){const grid=XLSX.utils.sheet_to_json(workbook.Sheets[sheet],{header:1,raw:true,defval:''});for(let index=0;index<Math.min(3,grid.length);index++){
  const headers=grid[index].map(v=>String(v).trim()),positions={};let valid=true;
  for(const field of required){const matches=headers.map((h,i)=>aliases[field].includes(h)?i:-1).filter(i=>i>=0);if(matches.length!==1){valid=false;break;}positions[field]=matches[0];}
  if(valid)candidates.push({sheet,headers,positions,rows:grid.slice(index+1)});
 }}
 if(candidates.length!==1)throw Error('jd_source_sheet_or_headers_ambiguous');
 const source=candidates[0],expected=new Set(expectedStoreIds),stores=new Set(),seen=new Set(),rows=[];let income=0,gross=0,orders=0,quantity=0,sales=0,receivable=0;
 if(source.rows.length>200000)throw Error('jd_source_row_limit');
 for(const values of source.rows){if(values.every(v=>String(v).trim()===''))continue;
  const get=field=>values[source.positions[field]],id=String(get('id')).trim(),day=type==='settlement'?completedDay(get('completed')):plainDate(get('date'));
  if(!/^\d+$/.test(id)||!expected.has(id)&&!allowUnmatched)throw Error('jd_source_store_outside_scope');if(day!==date)throw Error('jd_source_date_mismatch');
  const raw=Object.fromEntries(source.headers.map((h,i)=>[h,values[i]??''])),row={store_id:id,date:day,matched:expected.has(id),raw};
  if(type==='operating'){if(seen.has(id))throw Error('jd_source_store_date_duplicate');seen.add(id);income+=row.income_cents=number(get('income'),true);gross+=row.gross_cents=number(get('gross'),true);orders+=row.orders=number(get('orders'));}
  else if(type==='product'){row.name=String(get('name')).trim();if(!row.name)throw Error('jd_source_product_missing');quantity+=row.quantity=number(get('quantity'));sales+=row.sales_cents=number(get('sales'),true);}
  else{row.order_type=String(get('orderType')).trim();if(!row.order_type)throw Error('jd_source_order_type_missing');receivable+=row.receivable_cents=number(get('amount'),true);}
  stores.add(id);rows.push(row);
 }
 if(![income,gross,orders,quantity,sales,receivable].every(Number.isSafeInteger))throw Error('jd_source_total_overflow');
 const missing=expectedStoreIds.filter(id=>!stores.has(id));
 return {ok:true,platform:'jd_delivery',type,date,sheet:source.sheet,row_count:rows.length,store_count:stores.size,store_ids:[...stores].sort(),stores_without_rows:missing,unmatched_store_ids:[...stores].filter(id=>!expected.has(id)),income_cents:income,gross_cents:gross,orders,quantity,sales_cents:sales,receivable_cents:receivable,coverage_verified:type==='operating'&&!missing.length&&rows.length>0,sha256:crypto.createHash('sha256').update(buffer).digest('hex'),rows};
}
module.exports={inspectJdBuffer};
