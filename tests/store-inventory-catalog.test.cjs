const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const I=require('../lib/store-inventory');
function fixture(){const sql=I.open(':memory:'),admin={id:1,admin:true,display_name:'隔离管理员'},staff={id:2,admin:false};const authorize=(a,c)=>a.admin||c==='inventory.view';const service=I.create({sql,authorize,storeExists:id=>id===1});return {sql,admin,staff,service};}
function file(price='47.8',day='2026-10-29'){
 const rows=[{name:'绿九九蕃薯叶',unit:'斤',quoted_price:'2.58'},{name:'绿九九蕃薯叶19斤',unit:'件',quoted_price:price},{name:'海天白醋4.9L',unit:'桶',quoted_price:'12.39'}].map((r,i)=>({...r,supplier:'绿春翔+',observation_id:'obs-'+i,supplier_sku_id:null,last_observed_at:day+'T03:20:45.000Z',descriptions:[],minimum_orders:[],source_labels:['隔离报价测试'],evidence_files:[],effective_date_verified:false,applicable_store_ids:null}));
 return {source_name:'隔离测试.json',data:JSON.stringify({supplier:'绿春翔+',observed_date:day,count:rows.length,scope:{all_catalog_complete:false},rows})};
}
test('供应商分组待导入，预览只读，原报价单位建档，不产生库存或成本数量',()=>{const f=fixture();try{
 assert.deepEqual(f.service.suppliers(f.admin).map(s=>[s.name,s.status]),[['绿春翔','待导入'],['粤宏潮','待导入']]);
 const body=file(),preview=f.service.previewSupplierImport(f.admin,'lcx',body);assert.equal(preview.new_items,3);assert.equal(f.service.items(f.admin).length,0);
 const result=f.service.importSupplierCatalog(f.admin,'lcx',body);assert.equal(result.new_items,3);assert.equal(result.replayed,false);
 const rows=f.service.items(f.admin,{includeSuppliers:true});assert.equal(rows.find(r=>r.name==='绿九九蕃薯叶19斤').unit,'件');assert(rows.every(r=>r.supplier_ids.join()==='lcx'));assert(rows.every(r=>r.active));
 const q=f.service.supplierCatalog(f.admin,'lcx');assert.equal(q.find(r=>r.source_unit==='件').quoted_price,'47.8');assert(q.every(r=>r.supplier_sku_id===null));assert(rows.every(r=>r.code.startsWith('LCX-')));
 for(const table of ['inv_balances','inv_documents','inv_movements'])assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM '+table).get().n,0);
 assert.equal(f.service.suppliers(f.admin).find(s=>s.id==='yhc').status,'待导入');
 assert(f.service.items(f.admin).every(r=>!Object.hasOwn(r,'supplier_ids')),'小程序沿用原物料字段');
}finally{f.sql.close();}});
test('同文件幂等，新报价追加，保留既有人工名称与库存单位且旧日期不覆盖新报价',()=>{const f=fixture();try{
 const b=file();f.service.importSupplierCatalog(f.admin,'lcx',b);const again=f.service.importSupplierCatalog(f.admin,'lcx',b);assert.equal(again.replayed,true);assert.equal(again.new_items,0);assert.equal(f.service.items(f.admin).length,3);
 const oil=f.service.items(f.admin,{includeSuppliers:true}).find(i=>i.unit==='桶');f.service.saveItem(f.admin,{...oil,name:'白醋已核对规格',unit:'升'});
 f.service.importSupplierCatalog(f.admin,'lcx',file('46.5','2026-10-30'));f.service.importSupplierCatalog(f.admin,'lcx',file('50','2026-10-28'));
 assert.equal(f.service.items(f.admin).length,3);assert.equal(f.service.items(f.admin).find(i=>i.id===oil.id).unit,'升');assert.equal(f.service.items(f.admin).find(i=>i.id===oil.id).name,'白醋已核对规格');
 assert.equal(f.service.supplierCatalog(f.admin,'lcx').find(i=>i.source_unit==='件').quoted_price,'46.5');
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM inv_catalog_quotes').get().n,9);
}finally{f.sql.close();}});
test('供应商、价格、单位和重复报价冲突拒绝；中途失败整批回滚',()=>{const f=fixture();try{
 assert.throws(()=>f.service.importSupplierCatalog(f.admin,'yhc',file()),/待提供/);
 for(const mutate of [d=>d.supplier='其他供应商',d=>d.rows[0].quoted_price='NaN',d=>d.rows[0].unit='未知单位',d=>d.rows.push({...d.rows[0]})]){
  const b=file(),d=JSON.parse(b.data);mutate(d);d.count=d.rows.length;assert.throws(()=>f.service.importSupplierCatalog(f.admin,'lcx',{...b,data:JSON.stringify(d)}));assert.equal(f.service.items(f.admin).length,0);
 }
 const b=file(),d=JSON.parse(b.data);d.rows[2].observation_id=d.rows[0].observation_id;
 assert.throws(()=>f.service.importSupplierCatalog(f.admin,'lcx',{...b,data:JSON.stringify(d)}));assert.equal(f.service.items(f.admin).length,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM inv_catalog_batches').get().n,0);
}finally{f.sql.close();}});
test('一个共用物料可关联多个供应商，旧客户端不清除分组，错误订单来源不能入库',()=>{const f=fixture();try{
 let item=f.service.saveItem(f.admin,{code:'YHC-TEST',name:'隔离鹅肉',unit:'斤',supplier_ids:['yhc']});assert.deepEqual(item.supplier_ids,['yhc']);
 item=f.service.saveItem(f.admin,{id:item.id,revision:item.revision,code:item.code,name:item.name,unit:item.unit});assert.deepEqual(item.supplier_ids,['yhc']);
 const receipt={kind:'receipt',store_id:1,purpose:'business',business_date:'2026-10-29',source_key:'lcx',order_ref:'隔离订单',request_key:crypto.randomUUID(),lines:[{item_id:item.id,quantity:'1'}]};
 assert.throws(()=>f.service.createDoc(f.admin,receipt),/供应商/);
 item=f.service.saveItem(f.admin,{...item,supplier_ids:['lcx','yhc']});assert.deepEqual(item.supplier_ids,['lcx','yhc']);assert(f.service.createDoc(f.admin,receipt).id);
 assert.throws(()=>f.service.saveItem(f.admin,{code:'invalid',name:'无效供应商',unit:'斤',supplier_ids:['unknown']}));assert.equal(f.service.items(f.admin).length,1);
}finally{f.sql.close();}});
test('报价导入和查看需配置权限，mini不注册供应商管理接口',async()=>{const f=fixture(),express=require('express'),app=express();app.use(express.json());app.use((req,res,next)=>{if(req.headers['x-test-user'])req.user={id:Number(req.headers['x-test-user'])};next();});const {createRouter}=require('../lib/store-inventory-router');const options={db:{queryAll:()=>[{id:1,store_name:'隔离门店'}]},service:f.service,authorize:(a,c)=>a.admin||c==='inventory.view',resolveActor:req=>req.user.id===1?f.admin:f.staff};app.use('/api/inventory',createRouter(options));app.use('/api/mp/inventory',createRouter({...options,channel:'mini'}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{assert.equal((await fetch(base+'/api/inventory/suppliers')).status,401);assert.equal((await fetch(base+'/api/inventory/suppliers',{headers:{'x-test-user':'2'}})).status,403);assert.equal((await fetch(base+'/api/mp/inventory/suppliers',{headers:{'x-test-user':'1'}})).status,404);assert.equal((await fetch(base+'/api/inventory/suppliers',{headers:{'x-test-user':'1'}})).status,200);}finally{await new Promise(r=>server.close(r));f.sql.close();}
});
