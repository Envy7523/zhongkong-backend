const XLSX=require('xlsx');
function detect(w){for(const name of w.SheetNames){const rows=XLSX.utils.sheet_to_json(w.Sheets[name],{header:1,defval:'',raw:true});const headers=(rows[0]||[]).map(x=>String(x).trim());if(['门店ID','天','访问人数','购买人数','门店评分','累计评价数'].every(x=>headers.includes(x)))return {rows,headers};}return null;}
function importReport(db,r,p,u){
 const records=[],seen=new Set();
 for(const [i,row] of r.rows.slice(1).entries()){
 if(row.every(x=>x===''))continue;
 const get=k=>row[r.headers.indexOf(k)];const id=String(get('门店ID')).trim();
 if(typeof get('门店ID')==='number'&&!Number.isSafeInteger(get('门店ID')))throw Error('门店ID必须为文本，避免长数字精度丢失');
 let date=String(get('天')).replaceAll('/','-');if(typeof get('天')==='number'){const d=XLSX.SSF.parse_date_code(get('天'));date=d?`${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`:'';}
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!id)throw Error('第'+(i+2)+'行日期或ID无效');
 const metrics=['访问人数','购买人数','门店评分','累计评价数'].map(k=>{const n=Number(get(k));if(!Number.isFinite(n)||n<0)throw Error('第'+(i+2)+'行'+k+'无效');return n;});
 if(metrics[2]>5)throw Error('门店评分超出范围');
 const key=id+'|'+date;if(seen.has(key))throw Error('门店日期重复：'+key);seen.add(key);
 const s=db.queryOne("SELECT s.id,s.store_name FROM store_platforms p JOIN stores s ON s.id=p.store_id WHERE p.platform_name='抖音团购' AND p.platform_id=?",[id]);
 records.push({id,date,metrics,s,name:String(get('门店名称')||'')});
 }if(!records.length)throw Error('没有有效经营数据');
 db.run('BEGIN');try{
 const batch=db.insert('INSERT INTO business_import_batches(source_type,platform,file_name,row_count,imported_by,imported_by_name) VALUES(?,?,?,?,?,?)',['platform','抖音团购',p.file_name||'',records.length,u?.id||null,u?.display_name||'']);
 for(const x of records){db.run('DELETE FROM douyin_group_buy_operation_records WHERE douyin_store_id=? AND biz_date=?',[x.id,x.date]);db.run('INSERT INTO douyin_group_buy_operation_records(batch_id,douyin_store_id,source_store_name,biz_date,visit_users,ordering_users,store_rating,review_count,store_id,store_name,match_status) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[batch,x.id,x.name,x.date,...x.metrics,x.s?.id||null,x.s?.store_name||'',x.s?'matched':'unmatched']);}
 const dates=records.map(x=>x.date).sort();db.run('UPDATE business_import_batches SET date_from=?,date_to=? WHERE id=?',[dates[0],dates.at(-1),batch]);db.run('COMMIT');db.save();
 const bad=records.filter(x=>!x.s);return {batch_id:batch,data_kind:'douyin_group_operation',imported:records.length-bad.length,raw_imported:records.length,unmatched:bad.length,matched_stores:new Set(records.filter(x=>x.s).map(x=>x.s.id)).size,date_from:dates[0],date_to:dates.at(-1),errors:[...new Set(bad.map(x=>'未关联抖音门店ID：'+x.id))]};
 }catch(e){db.run('ROLLBACK');throw e;}
}
const getReport = require('./douyin-operation-report');
module.exports={detect,importReport,getReport};