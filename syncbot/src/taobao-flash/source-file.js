'use strict';
const XLSX=require('xlsx'),crypto=require('node:crypto');
const {plainDate}=require('../meituan-delivery/operating-file');
const aliases={id:['门店ID','门店id','门店编号'],date:['日期','账单日期'],name:['商品名称','商品名'],quantity:['销量','商品销量'],sales:['销售额','商品销售额'],income:['收入','营业收入'],gross:['营业额'],orders:['有效订单'],amount:['结算金额'],billType:['账单类型']};
function scaled(value,scale){
 const text=String(value??'').trim().replace(/[,，￥¥]/g,'');if(!/^[+-]?\d+(?:\.\d+)?$/.test(text))throw Error('flash_source_number_invalid');
 const amount=Number(text)*scale,rounded=Math.round(amount);if(!Number.isFinite(amount)||!Number.isSafeInteger(rounded)||Math.abs(amount-rounded)>0.00001)throw Error('flash_source_precision_invalid');return rounded;
}
function inspectFlashBuffer(buffer,{type,date,expectedStoreIds}={}){
 if(!['operating','product','settlement'].includes(type)||plainDate(date)!==date||!Array.isArray(expectedStoreIds)||!expectedStoreIds.length||new Set(expectedStoreIds).size!==expectedStoreIds.length)throw Error('flash_source_parameters_invalid');
 if(!Buffer.isBuffer(buffer)||buffer.length<20||buffer.length>30*1024*1024)throw Error('flash_source_size_invalid');
 const workbook=XLSX.read(buffer,{type:'buffer',raw:true}),required=type==='operating'?['id','date','income','gross','orders']:type==='product'?['id','date','name','quantity','sales']:['id','date','amount','billType'],candidates=[];
 for(const sheet of workbook.SheetNames){const grid=XLSX.utils.sheet_to_json(workbook.Sheets[sheet],{header:1,raw:true,defval:''});for(let index=0;index<Math.min(3,grid.length);index++){
  const headers=grid[index].map(v=>String(v).trim()),positions={};let valid=true;
  for(const field of required){const matches=headers.map((h,i)=>aliases[field].includes(h)?i:-1).filter(i=>i>=0);if(matches.length!==1){valid=false;break;}positions[field]=matches[0];}
  if(valid)candidates.push({sheet,headers,positions,values:grid.slice(index+1)});
 }}
 if(candidates.length!==1)throw Error('flash_source_sheet_or_headers_ambiguous');
 const source=candidates[0],rows=[],seen=new Set(),stores=new Set(),expected=new Set(expectedStoreIds);let income=0,gross=0,orders=0,sales=0,quantityUnits=0,net=0;
 if(source.values.length>200000)throw Error('flash_source_row_limit');
 for(const values of source.values){if(values.every(v=>String(v).trim()===''))continue;const get=f=>values[source.positions[f]],id=String(get('id')).trim();
  if(!/^\d+$/.test(id))throw Error('flash_source_store_invalid');if(plainDate(get('date'))!==date)throw Error('flash_source_date_mismatch');
  const row={store_id:id,date,matched:expected.has(id),raw:Object.fromEntries(source.headers.map((h,i)=>[h,values[i]??'']))};
  if(type==='operating'){if(seen.has(id))throw Error('flash_source_store_date_duplicate');seen.add(id);income+=row.income_cents=scaled(get('income'),100);gross+=row.gross_cents=scaled(get('gross'),100);orders+=row.orders=scaled(get('orders'),1);}
  else if(type==='product'){row.name=String(get('name')).trim();if(!row.name)throw Error('flash_source_product_missing');quantityUnits+=row.quantity_units=scaled(get('quantity'),10000);row.quantity=row.quantity_units/10000;sales+=row.sales_cents=scaled(get('sales'),100);}
  else {row.bill_type=String(get('billType')).trim();if(!row.bill_type)throw Error('flash_source_bill_type_missing');net+=row.amount_cents=scaled(get('amount'),100);}
  stores.add(id);rows.push(row);
 }
 if(![income,gross,orders,sales,quantityUnits,net].every(Number.isSafeInteger))throw Error('flash_source_total_overflow');
 const unmatched=[...stores].filter(id=>!expected.has(id)),missing=expectedStoreIds.filter(id=>!stores.has(id));
 let controlNet=null;
 if(type==='settlement'&&workbook.Sheets['汇总信息']){const controls=XLSX.utils.sheet_to_json(workbook.Sheets['汇总信息'],{header:1,raw:true,defval:''}).filter(row=>row[0]==='结算金额');if(controls.length!==1)throw Error('flash_source_control_ambiguous');controlNet=scaled(controls[0][1],100);if(controlNet!==net)throw Error('flash_source_control_mismatch');}
 return {ok:true,platform:'taobao_flash',type,date,sheet:source.sheet,row_count:rows.length,store_count:stores.size,store_ids:[...stores].sort(),unmatched_store_ids:unmatched,stores_without_rows:missing,income_cents:income,gross_cents:gross,orders,sales_cents:sales,quantity:quantityUnits/10000,net_cents:net,control_net_cents:controlNet,coverage_verified:type==='operating'&&!unmatched.length&&!missing.length&&rows.length>0,sha256:crypto.createHash('sha256').update(buffer).digest('hex'),rows};
}
module.exports={inspectFlashBuffer};
