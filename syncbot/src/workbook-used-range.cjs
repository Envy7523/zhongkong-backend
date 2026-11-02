'use strict';
const XLSX=require('xlsx');
// Some merchant exports retain their template dimension after appending rows.
// Expand only to populated cells; never discard a valid declared range.
function restoreUsedRange(sheet){
 let range=sheet['!ref']?XLSX.utils.decode_range(sheet['!ref']):null;
 for(const [address,cell] of Object.entries(sheet)){
  if(!/^[A-Z]+[1-9]\d*$/.test(address)||!cell||(cell.v==null&&!cell.f))continue;
  const point=XLSX.utils.decode_cell(address);
  if(!range)range={s:{...point},e:{...point}};
  else {range.s.r=Math.min(range.s.r,point.r);range.s.c=Math.min(range.s.c,point.c);range.e.r=Math.max(range.e.r,point.r);range.e.c=Math.max(range.e.c,point.c);}
 }
 if(range)sheet['!ref']=XLSX.utils.encode_range(range);
 return sheet;
}
module.exports={restoreUsedRange};
