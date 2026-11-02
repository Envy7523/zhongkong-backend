'use strict';
const XLSX=require('xlsx'),crypto=require('crypto');
function parseFinance(buffer,from,to){
 const workbook=XLSX.read(buffer,{type:'buffer'}),sheet=workbook.Sheets['收益明细'];if(!sheet)throw Error('benefit_sheet_missing');
 let range=sheet['!ref']?XLSX.utils.decode_range(sheet['!ref']):null;
 for(const [address,cell] of Object.entries(sheet))if(/^[A-Z]+[1-9]\d*$/.test(address)&&cell&&(cell.v!=null||cell.f)){
  const point=XLSX.utils.decode_cell(address);if(!range)range={s:{...point},e:{...point}};else{range.s.r=Math.min(range.s.r,point.r);range.s.c=Math.min(range.s.c,point.c);range.e.r=Math.max(range.e.r,point.r);range.e.c=Math.max(range.e.c,point.c);}
 }
 if(range)sheet['!ref']=XLSX.utils.encode_range(range);
 const grid=XLSX.utils.sheet_to_json(sheet,{header:1,defval:''}),header=grid[0]||[];
 for(const name of ['收益时间','美团门店ID','售价（美团售价）','商家应得','流水类型'])if(!header.includes(name))throw Error('benefit_columns_missing');
 const rows=XLSX.utils.sheet_to_json(sheet),valid=rows.filter(r=>r.收益时间&&r.美团门店ID&&r.流水类型);
 if(valid.length!==rows.length||!valid.length)throw Error('benefit_rows_incomplete');
 for(const row of valid){const date=String(row.收益时间).slice(0,10).replaceAll('/','-');if(date<from||date>to)throw Error('benefit_date_mismatch');if(!/^\d+$/.test(String(row.美团门店ID)))throw Error('benefit_store_id_invalid');}
 const sum=key=>valid.reduce((n,r)=>{const value=Number(String(r[key]??'0').replaceAll(',',''));if(!Number.isFinite(value))throw Error('benefit_amount_invalid');return n+Math.round(value*100);},0);
 const dates={};for(const row of valid){const date=String(row.收益时间).slice(0,10).replaceAll('/','-');dates[date]=(dates[date]||0)+1;}
 return {rowCount:valid.length,dates,storeCount:new Set(valid.map(r=>String(r.美团门店ID))).size,storeIds:[...new Set(valid.map(r=>String(r.美团门店ID)))],saleCents:sum('售价（美团售价）'),merchantCents:sum('商家应得'),sha256:crypto.createHash('sha256').update(buffer).digest('hex')};
}
module.exports={parseFinance};
