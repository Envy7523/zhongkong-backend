'use strict';
const XLSX=require('xlsx'),crypto=require('crypto');
const {assertDate}=require('./meituan-finance-dates.cjs');
const METRICS=['门店页访问人数','商品点击人数','门店意向成交金额','门店意向成交人数','门店核销金额','门店核销人数','门店意向退款金额','门店意向退款人数','门店评分','累计评价数','门店点亮数'];
function parseOperation(buffer,from,to){
 assertDate(from);assertDate(to);if(from>to)throw Error('douyin_operation_range_invalid');
 const workbook=XLSX.read(buffer,{type:'buffer'});let rows,headers;
 for(const name of workbook.SheetNames){const grid=XLSX.utils.sheet_to_json(workbook.Sheets[name],{header:1,raw:true,defval:''});const h=(grid[0]||[]).map(x=>String(x).trim());if(h.includes('门店ID')&&METRICS.every(x=>h.includes(x))){rows=grid;headers=h;break;}}
 if(!rows)throw Error('douyin_operation_headers_missing');
 const dateColumn=['天','日期','统计日期'].map(x=>headers.indexOf(x)).find(x=>x>=0);if(dateColumn===undefined)throw Error('douyin_operation_date_missing');
 const ids=new Set(),dates=new Set(),seen=new Set(),totals=Object.fromEntries(METRICS.map(x=>[x,0]));let count=0;
 for(const row of rows.slice(1)){if(row.every(x=>x===''))continue;const id=row[headers.indexOf('门店ID')];if(typeof id!=='string'||!/^\d+$/.test(id.trim()))throw Error('douyin_operation_id_invalid');let date=String(row[dateColumn]).replaceAll('/','-');if(typeof row[dateColumn]==='number'){const d=XLSX.SSF.parse_date_code(row[dateColumn]);date=d?`${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`:'';}assertDate(date);if(date<from||date>to)throw Error('douyin_operation_date_outside_range');const key=id+'|'+date;if(seen.has(key))throw Error('douyin_operation_duplicate');seen.add(key);ids.add(id.trim());dates.add(date);count++;
 for(const name of METRICS){const raw=row[headers.indexOf(name)],v=Number(String(raw).replaceAll(',','').replace(/^¥|^￥/,''));if(raw===''||!Number.isFinite(v)||v<0||(name==='门店评分'&&v>5))throw Error('douyin_operation_metric_invalid');if(!name.includes('金额')&&name!=='门店评分'&&!Number.isInteger(v))throw Error('douyin_operation_count_invalid');totals[name]+=v;}}
 for(let d=from;d<=to;d=new Date(Date.parse(d+'T00:00:00Z')+86400000).toISOString().slice(0,10))if(!dates.has(d))throw Error('douyin_operation_day_missing');
 for(const id of ids)for(const date of dates)if(!seen.has(id+'|'+date))throw Error('douyin_operation_store_day_missing');
 if(!count)throw Error('douyin_operation_empty');return {rowCount:count,storeIds:[...ids].sort(),storeCount:ids.size,dates:[...dates].sort(),totals,sha256:crypto.createHash('sha256').update(buffer).digest('hex')};
}
module.exports={METRICS,parseOperation};
