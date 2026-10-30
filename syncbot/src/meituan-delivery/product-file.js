'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),XLSX=require('xlsx');
const contract=require('./product-contract');
const {plainDate}=require('./operating-file');
function parseProductBuffer(buffer,{from,to=from,expectedStoreIds}={}){
 if(plainDate(from)!==from||plainDate(to)!==to||from>to)throw Error('product_date_range_invalid');
 if(!Buffer.isBuffer(buffer)||buffer.length<30||buffer.length>20*1024*1024)throw Error('product_file_size_invalid');
 if(!Array.isArray(expectedStoreIds)||!expectedStoreIds.length||expectedStoreIds.some(id=>typeof id!=='string'||!/^\d+$/.test(id))||new Set(expectedStoreIds).size!==expectedStoreIds.length)throw Error('product_scope_invalid');
 const binary=buffer.slice(0,2).toString()==='PK'||buffer.slice(0,2).equals(Buffer.from([0xd0,0xcf]));
 const utf8=buffer.toString('utf8'),isUtf8=!binary&&Buffer.from(utf8).equals(buffer);
 const wb=XLSX.read(isUtf8?utf8.replace(/^\uFEFF/,''):buffer,{type:isUtf8?'string':'buffer',raw:true,cellDates:false,...(!binary&&!isUtf8?{codepage:936}:{})});
 if(wb.SheetNames.length!==1)throw Error('product_sheet_ambiguous');
 const grid=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:true,defval:''});
 if(grid.length>100001)throw Error('product_row_limit');
 const headers=grid[0]?.map(v=>String(v).trim());
 if(!headers||headers.length!==contract.fields.length||contract.fields.some(f=>headers.filter(v=>v===f).length!==1))throw Error('product_header_invalid');
 const rows=[],stores=new Set(),seen=new Set(),expected=new Set(expectedStoreIds);
 let sales=0,transactions=0,quantity=0,identicalRows=0;
 function number(value,money=false){const s=String(value).trim().replace(/,/g,'');if(!/^-?\d+(?:\.\d+)?$/.test(s))throw Error('product_number_invalid');const n=Number(s);if(!Number.isFinite(n)||n<0)throw Error('product_number_invalid');if(money&&Math.abs(n*100-Math.round(n*100))>0.00001)throw Error('product_money_precision');if(!money&&!Number.isSafeInteger(n))throw Error('product_count_invalid');return n;}
 for(const source of grid.slice(1)){
  if(source.every(v=>v===''||v===null))continue;
  const r=Object.fromEntries(headers.map((h,i)=>[h,source[i]??'']));
  r.日期=plainDate(r.日期);if(!r.日期||r.日期<from||r.日期>to)throw Error('product_row_date_mismatch');
  if(typeof r.门店id==='number'&&!Number.isSafeInteger(r.门店id))throw Error('product_store_id_precision');
  r.门店id=String(r.门店id).trim();if(!expected.has(r.门店id))throw Error('product_unknown_store');
  if(!String(r.商品名).trim()||!String(r.门店名称).trim())throw Error('product_identity_invalid');
  for(const f of contract.metrics.slice(0,5))r[f]=number(r[f],['商品销售额','订单交易额'].includes(f));
  for(const f of contract.metrics.slice(5))if(!['是','否'].includes(String(r[f]).trim()))throw Error('product_flag_invalid');
  // The observed export omits SKU IDs. Identical-looking rows can be distinct SKUs;
  // preserve all source rows and expose the ambiguity instead of dropping sales.
  const identity=JSON.stringify(contract.fields.map(f=>r[f]));if(seen.has(identity))identicalRows++;seen.add(identity);
  stores.add(r.门店id);sales+=Math.round(r.商品销售额*100);transactions+=Math.round(r.订单交易额*100);quantity+=r.商品销量;rows.push(r);
 }
 if(![sales,transactions,quantity].every(Number.isSafeInteger))throw Error('product_total_overflow');
 // Product rows are sparse; absent stores require reconciliation, never an invented zero or a complete-coverage claim.
 return {ok:true,report_type:contract.reportType,from,to,row_count:rows.length,store_count:stores.size,store_ids:[...stores].sort(),stores_without_rows:expectedStoreIds.filter(id=>!stores.has(id)),sales_cents:sales,transaction_cents:transactions,quantity,identical_source_rows:identicalRows,sku_identity_available:false,totals_complete:true,coverage_verified:false,sha256:crypto.createHash('sha256').update(buffer).digest('hex'),rows};
}
function parseProductFile(file,options){const stat=fs.statSync(file);if(!stat.isFile()||stat.size>20*1024*1024)throw Error('product_file_size_invalid');return parseProductBuffer(fs.readFileSync(file),options);}
module.exports={parseProductBuffer,parseProductFile};
