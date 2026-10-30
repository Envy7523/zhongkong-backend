'use strict';
const crypto=require('node:crypto');
const UNITS=['克','千克','斤','毫升','升','只','个','包','袋','瓶','桶','罐','盒','板','件'];
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function initialize(sql){
 sql.exec(`
  CREATE TABLE IF NOT EXISTS inv_suppliers(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,note TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS inv_item_suppliers(item_id TEXT NOT NULL REFERENCES inv_items(id),supplier_id TEXT NOT NULL REFERENCES inv_suppliers(id),PRIMARY KEY(item_id,supplier_id));
  CREATE TABLE IF NOT EXISTS inv_catalog_batches(id TEXT PRIMARY KEY,supplier_id TEXT NOT NULL REFERENCES inv_suppliers(id),source_name TEXT NOT NULL,observed_date TEXT NOT NULL,observation_count INTEGER NOT NULL,created_items INTEGER NOT NULL,scope_json TEXT NOT NULL,actor_id INTEGER NOT NULL,created_at TEXT NOT NULL,source_json TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS inv_catalog_products(supplier_id TEXT NOT NULL REFERENCES inv_suppliers(id),product_key TEXT NOT NULL,item_id TEXT NOT NULL REFERENCES inv_items(id),source_name TEXT NOT NULL,source_unit TEXT NOT NULL,PRIMARY KEY(supplier_id,product_key));
  CREATE TABLE IF NOT EXISTS inv_catalog_quotes(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES inv_catalog_batches(id),supplier_id TEXT NOT NULL,product_key TEXT NOT NULL,observation_id TEXT NOT NULL,supplier_sku_id TEXT,quoted_price TEXT NOT NULL,observed_date TEXT NOT NULL,observed_at TEXT NOT NULL,metadata_json TEXT NOT NULL,imported_at TEXT NOT NULL,FOREIGN KEY(supplier_id,product_key) REFERENCES inv_catalog_products(supplier_id,product_key));
  CREATE INDEX IF NOT EXISTS inv_catalog_quote_latest ON inv_catalog_quotes(supplier_id,product_key,observed_date,observed_at,imported_at);
 `);
 if(!sql.prepare('PRAGMA table_info(inv_catalog_batches)').all().some(c=>c.name==='source_json'))sql.exec("ALTER TABLE inv_catalog_batches ADD COLUMN source_json TEXT NOT NULL DEFAULT ''");
 const insert=sql.prepare('INSERT OR IGNORE INTO inv_suppliers(id,name,note) VALUES(?,?,?)');
 insert.run('lcx','绿春翔','营业用料与员工餐为同一家供应商的两个订单来源');
 insert.run('yhc','粤宏潮','待提供供应商目录及计价单位后导入');
}
function prepare(supplierId,body){
 if(supplierId!=='lcx')fail('此供应商资料待提供，暂未配置导入格式');
 if(typeof body?.data!=='string'||Buffer.byteLength(body.data)>1500000)fail('请选择不超过1.5MB的报价JSON文件');
 let dataset;try{dataset=JSON.parse(body.data.replace(/^\uFEFF/,''));}catch{fail('报价文件不是有效JSON');}
 if(!['绿春翔','绿春翔+'].includes(dataset?.supplier))fail('文件供应商与绿春翔分组不符');
 const day=dataset.observed_date,d=new Date(String(day)+'T00:00:00Z');
 if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==day)fail('采集日期无效');
 if(!Array.isArray(dataset.rows)||!dataset.rows.length||dataset.rows.length>1000||dataset.count!==dataset.rows.length)fail('报价记录数量不符，须为1至1000条完整记录');
 const seen=new Set();
 const rows=dataset.rows.map((r,index)=>{
  if(!r||r.supplier!==dataset.supplier||typeof r.name!=='string'||!r.name.trim()||r.name.trim().length>100)fail(`第${index+1}条物料名称或供应商无效`);
  if(!UNITS.includes(r.unit))fail(`第${index+1}条计价单位无法直接建档，请先核对`);
  if(typeof r.quoted_price!=='string'||!/^\d{1,9}(?:\.\d{1,4})?$/.test(r.quoted_price))fail(`第${index+1}条报价无效`);
  if(typeof r.observation_id!=='string'||!r.observation_id||r.observation_id.length>100)fail(`第${index+1}条缺少报价观察编号`);
  if(r.supplier_sku_id!=null&&(typeof r.supplier_sku_id!=='string'||r.supplier_sku_id.length>100))fail('供应商商品编号须保留原始字符串');
  const name=r.name.trim(),key=hash(name+'\0'+r.unit);
  if(seen.has(key))fail('同名同计价单位存在多条报价，请先核对规格，不能自动合并');seen.add(key);
  const observedAt=typeof r.last_observed_at==='string'&&Number.isFinite(Date.parse(r.last_observed_at))?r.last_observed_at:day+'T00:00:00.000Z';
  const metadata={};
  for(const k of ['descriptions','minimum_orders','source_labels','evidence_files']){
   if(r[k]!=null&&(!Array.isArray(r[k])||r[k].length>100||r[k].some(v=>typeof v!=='string'||v.length>2000)))fail('报价附加说明格式无效');
   metadata[k]=r[k]||[];
  }
  metadata.price_kind=r.price_kind||'账号展示报价';metadata.effective_date_verified=r.effective_date_verified===true;
  metadata.applicable_store_ids=r.applicable_store_ids??null;
  return {name,unit:r.unit,key,code:'LCX-'+key.slice(0,14).toUpperCase(),observation_id:r.observation_id,supplier_sku_id:r.supplier_sku_id??null,quoted_price:r.quoted_price,observed_at:observedAt,metadata};
 });
 const sourceName=String(body.source_name||'绿春翔报价.json').replace(/[\\/]/g,'_').slice(0,180);
 return {id:hash(body.data),supplier_id:supplierId,source_name:sourceName,observed_date:day,rows,scope:{all_catalog_complete:dataset.scope?.all_catalog_complete===true,supplier_sku_ids_exposed:dataset.scope?.supplier_sku_ids_exposed===true,applicable_stores_verified:dataset.scope?.applicable_stores_verified===true,quote_effective_date_verified:dataset.scope?.quote_effective_date_verified===true,official_api_verified:dataset.scope?.official_api_verified===true}};
}
function create({sql,check,event,transaction}){
 const all=(q,p=[])=>sql.prepare(q).all(...p),one=(q,p=[])=>sql.prepare(q).get(...p),run=(q,p=[])=>sql.prepare(q).run(...p);
 function supplierIds(itemId){return all('SELECT supplier_id FROM inv_item_suppliers WHERE item_id=? ORDER BY supplier_id',[itemId]).map(r=>r.supplier_id);}
 function validateIds(ids){if(ids===undefined)return;if(!Array.isArray(ids)||ids.length>10||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!one('SELECT 1 FROM inv_suppliers WHERE id=?',[id])))fail('供应商分组无效');}
 function assign(a,itemId,ids){if(ids===undefined)return;validateIds(ids);if(all('SELECT DISTINCT supplier_id FROM inv_catalog_products WHERE item_id=?',[itemId]).some(r=>!ids.includes(r.supplier_id)))fail('物料已有供应商报价关联，不能直接移除该分组');const old=supplierIds(itemId),next=[...ids].sort();if(JSON.stringify(old)===JSON.stringify(next))return;run('DELETE FROM inv_item_suppliers WHERE item_id=?',[itemId]);for(const id of next)run('INSERT INTO inv_item_suppliers VALUES(?,?)',[itemId,id]);event(a,'item.suppliers',null,{item_id:itemId,supplier_ids:old},{item_id:itemId,supplier_ids:next});}
 function enrich(row){const ids=supplierIds(row.id);return {...row,supplier_ids:ids,supplier_names:ids.map(id=>one('SELECT name FROM inv_suppliers WHERE id=?',[id]).name)};}
 function suppliers(a){check(a,'configure');return all(`SELECT s.*, (SELECT COUNT(*) FROM inv_item_suppliers x WHERE x.supplier_id=s.id) item_count,(SELECT COUNT(*) FROM inv_catalog_products p WHERE p.supplier_id=s.id) catalog_count,(SELECT MAX(observed_date) FROM inv_catalog_batches b WHERE b.supplier_id=s.id) observed_date FROM inv_suppliers s ORDER BY CASE s.id WHEN 'lcx' THEN 0 ELSE 1 END`).map(s=>({...s,status:s.catalog_count?'首批已导入':'待导入'}));}
 function catalog(a,supplierId){check(a,'configure');if(!one('SELECT 1 FROM inv_suppliers WHERE id=?',[supplierId]))fail('供应商不存在',404);return all(`SELECT p.*,q.quoted_price,q.observed_date,q.observation_id,q.supplier_sku_id,q.metadata_json,q.batch_id FROM inv_catalog_products p LEFT JOIN inv_catalog_quotes q ON q.id=(SELECT q2.id FROM inv_catalog_quotes q2 WHERE q2.supplier_id=p.supplier_id AND q2.product_key=p.product_key ORDER BY q2.observed_date DESC,q2.observed_at DESC,q2.imported_at DESC LIMIT 1) WHERE p.supplier_id=? ORDER BY p.source_name`,[supplierId]).map(r=>{const {metadata_json,...row}=r;return {...row,metadata:metadata_json?JSON.parse(metadata_json):null};});}
 function preview(a,supplierId,body){check(a,'configure');const data=prepare(supplierId,body),previous=one('SELECT * FROM inv_catalog_batches WHERE id=?',[data.id]);let created=0;
  for(const row of data.rows){if(one('SELECT 1 FROM inv_catalog_products WHERE supplier_id=? AND product_key=?',[supplierId,row.key]))continue;const existing=one('SELECT * FROM inv_items WHERE code=?',[row.code]);if(existing&&(existing.name!==row.name||existing.unit!==row.unit))fail('本地物料编码已被其他资料占用，请先核对',409);if(!existing)created++;}
  return {batch_id:data.id,supplier_id:supplierId,source_name:data.source_name,observed_date:data.observed_date,count:data.rows.length,new_items:previous?0:created,existing_items:previous?data.rows.length:data.rows.length-created,replayed:!!previous,scope:data.scope,sample:data.rows.slice(0,12).map(({name,unit,code,quoted_price})=>({name,unit,code,quoted_price}))};
 }
 function importCatalog(a,supplierId,body){check(a,'configure');const data=prepare(supplierId,body),plan=preview(a,supplierId,body);return transaction(()=>{
  if(one('SELECT 1 FROM inv_catalog_batches WHERE id=?',[data.id]))return {...plan,new_items:0,existing_items:data.rows.length,replayed:true};
  const now=new Date().toISOString();let created=0;run('INSERT INTO inv_catalog_batches(id,supplier_id,source_name,observed_date,observation_count,created_items,scope_json,actor_id,created_at,source_json) VALUES(?,?,?,?,?,?,?,?,?,?)',[data.id,supplierId,data.source_name,data.observed_date,data.rows.length,0,JSON.stringify(data.scope),a.id,now,body.data]);
  for(const row of data.rows){let product=one('SELECT * FROM inv_catalog_products WHERE supplier_id=? AND product_key=?',[supplierId,row.key]);
   if(!product){let material=one('SELECT * FROM inv_items WHERE code=?',[row.code]);if(material&&(material.name!==row.name||material.unit!==row.unit))fail('本地物料编码冲突，请刷新核对',409);if(!material){created++;const id=crypto.randomUUID();run('INSERT INTO inv_items(id,code,name,unit) VALUES(?,?,?,?)',[id,row.code,row.name,row.unit]);material=one('SELECT * FROM inv_items WHERE id=?',[id]);}run('INSERT INTO inv_catalog_products VALUES(?,?,?,?,?)',[supplierId,row.key,material.id,row.name,row.unit]);product={item_id:material.id};}
   run('INSERT OR IGNORE INTO inv_item_suppliers VALUES(?,?)',[product.item_id,supplierId]);
   run('INSERT INTO inv_catalog_quotes VALUES(?,?,?,?,?,?,?,?,?,?,?)',[hash(data.id+'\0'+row.observation_id),data.id,supplierId,row.key,row.observation_id,row.supplier_sku_id,row.quoted_price,data.observed_date,row.observed_at,JSON.stringify(row.metadata),now]);
  }
  run('UPDATE inv_catalog_batches SET created_items=? WHERE id=?',[created,data.id]);
  event(a,'supplier.catalog_import',null,null,{supplier_id:supplierId,batch_id:data.id,count:data.rows.length,new_items:created,observed_date:data.observed_date,scope:data.scope});
  return {...plan,new_items:created,existing_items:data.rows.length-created,replayed:false};
 });}
 return {supplierIds,validateIds,assign,enrich,suppliers,catalog,preview,importCatalog};
}
module.exports={initialize,create,prepare,UNITS};
