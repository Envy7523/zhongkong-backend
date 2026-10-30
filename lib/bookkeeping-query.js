'use strict';
const A=require('./personnel-access'),UP=require('./user-positions'),POLICY=require('./channel-permissions');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
function scope(db,req,exporting=false){
 const raw=db.queryOne('SELECT * FROM users WHERE id=?',[req.user?.id]);if(!raw)fail('未登录',401);
 const u=UP.enrich(db,raw,'web');POLICY.assertOperation(u,'/api/bookkeeping/entries','GET','web');
 const effective=code=>{const s=A.effective(db,u.id,'web',code);return s===undefined?(u.store_id?[Number(u.store_id)]:null):s};
 let s=effective('bookkeeping.manage');
 if(exporting){POLICY.assertOperation(u,'/api/bookkeeping/entries/export','GET','web');const code=u.position_permissions.includes('bookkeeping.export')?'bookkeeping.export':'bookkeeping.manage';s=A.intersect(s,effective(code))}
 return s;
}
function filter(q,s){
 const scoped=A.sqlScope(s),where=[scoped.sql],params=[...scoped.params];
 for(const key of ['date_from','date_to'])if(q[key]&&(!/^\d{4}-\d{2}-\d{2}$/.test(q[key])||!Number.isFinite(Date.parse(q[key]))||new Date(q[key]).toISOString().slice(0,10)!==q[key]))fail('日期格式无效');
 if(q.date_from&&q.date_to&&q.date_from>q.date_to)fail('开始日期不能晚于结束日期');
 for(const [key,op] of [['date_from','>='],['date_to','<=']])if(q[key]){where.push('date'+op+'?');params.push(q[key])}
 for(const key of ['category_id','subcategory_id'])if(q[key]!==undefined&&q[key]!==null&&q[key]!==''){if(!/^[1-9]\d*$/.test(String(q[key])))fail('分类无效');where.push(key+'=?');params.push(Number(q[key]))}
 const values=q.store_ids?String(q.store_ids).split(','):q.store_id?[q.store_id]:[];
 if(values.length){if(values.some(id=>!/^[1-9]\d*$/.test(String(id))))fail('门店编号无效');const ids=[...new Set(values.map(Number))];if(ids.some(id=>!A.allows(s,id)))fail('无权查询其他门店',403);where.push('store_id IN ('+ids.map(()=>'?').join(',')+')');params.push(...ids)}
 return {sql:' FROM bookkeeping_entries WHERE '+where.join(' AND '),params};
}
function query(db,q,s,{all=false}={}){
 const f=filter(q,s),totals=db.queryOne('SELECT COUNT(*) AS total,ROUND(COALESCE(SUM(amount),0),2) AS amount'+f.sql,f.params);
 if(all&&totals.total>100000)fail('结果超过10万条，请缩小日期或门店范围后导出');
 if(q.aggregate==='summary')return {ok:true,aggregate:'summary',rows:db.queryAll('SELECT category_id,category_name,subcategory_id,subcategory_name,ROUND(SUM(amount),2) AS total_amount,COUNT(*) AS entry_count'+f.sql+' GROUP BY category_id,category_name,subcategory_id,subcategory_name ORDER BY category_name,subcategory_name',f.params),...totals};
 const page=Math.max(1,Math.floor(Number(q.page)||1)),page_size=Math.min(200,Math.max(10,Math.floor(Number(q.page_size)||50)));
 return {ok:true,entries:db.queryAll('SELECT *'+f.sql+' ORDER BY date DESC,id DESC'+(all?'':' LIMIT ? OFFSET ?'),all?f.params:[...f.params,page_size,(page-1)*page_size]),...totals,page,page_size};
}
function workbook(data,q){
 const X=require('xlsx'),book=X.utils.book_new(),summary=data.aggregate==='summary';
 const heading=summary?['大类','小类','汇总金额','记录笔数']:['日期','门店','分类','子分类','金额','备注','记账人'];
 const rows=summary?data.rows.map(r=>[r.category_name,r.subcategory_name||'未分类',Number(r.total_amount),r.entry_count]):data.entries.map(r=>[r.date,r.store_name,r.category_name,r.subcategory_name||'',Number(r.amount),r.remark||'',r.user_name||'']);
 const total=summary?['合计','',Number(data.amount),data.total]:['合计','','','',Number(data.amount),'',''];
 const sheet=X.utils.aoa_to_sheet([heading,...rows,total]);sheet['!cols']=(summary?[24,28,18,16]:[14,32,22,25,18,55,22]).map(wch=>({wch}));const amountCol=summary?2:4;
 for(let r=1;r<=rows.length+1;r++){const cell=sheet[X.utils.encode_cell({r,c:amountCol})];if(cell)cell.z='#,##0.00'}
 sheet['!autofilter']={ref:X.utils.encode_range({r:0,c:0},{r:rows.length,c:heading.length-1})};
 X.utils.book_append_sheet(book,sheet,summary?'分类汇总':'记账明细');
 X.utils.book_append_sheet(book,X.utils.aoa_to_sheet([['查询条件','值'],['开始日期',q.date_from||'不限'],['结束日期',q.date_to||'不限'],['门店筛选',q.store_ids||q.store_id||'全部授权门店'],['大类编号',q.category_id||'不限'],['小类编号',q.subcategory_id||'不限'],['记录条数',data.total],['金额合计',Number(data.amount)],['说明','导出当前查询条件下全部授权结果，不限当前分页']]),'查询说明');
 return X.write(book,{type:'buffer',bookType:'xlsx'});
}
module.exports={scope,filter,query,workbook};
