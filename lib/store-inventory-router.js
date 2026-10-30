'use strict';
const express=require('express'), path=require('node:path');
const inventory=require('./store-inventory');
function filename(){
  if(process.env.STORE_INVENTORY_DB_PATH)return path.resolve(process.env.STORE_INVENTORY_DB_PATH);
  if(process.env.LOCAL_WEB_PREVIEW==='1'){
    if(!process.env.LOCAL_WEB_DB_PATH)throw new Error('本地预览必须配置独立业务库路径');
    return path.resolve(process.env.LOCAL_WEB_DB_PATH).replace(/(?:\.sqlite)?$/,'-inventory.sqlite');
  }
  return path.join(__dirname,'../data/store-inventory.sqlite');
}
function authorization(db){
  const access=require('./personnel-access');
  function scope(a,code){if(a.admin)return null;if(a.access_configured)return access.effective(db,a.id,a.channel,code);return Number(a.store_id)>0?[Number(a.store_id)]:[];}
  return (a,code,store,p)=>{
    if(a.admin)return true;
    if(!a.can(code))return false;
    const s=scope(a,code);if(s===undefined||Array.isArray(s)&&!s.length)return false;
    if(code==='inventory.configure'&&s!==null)return false;
    if(store&&!access.allows(s,store))return false;
    if(p){const pc='inventory.'+p;if(!a.can(pc))return false;const ps=scope(a,pc);if(ps===undefined||store&&!access.allows(ps,store))return false;}
    return true;
  };
}
function createRouter({db,channel='web',authenticate,service,resolveActor,authorize}){
  const router=express.Router();
  if(authenticate)router.use(authenticate);
  const allowed=authorize||authorization(db);
  let instance=service;
  function getService(){if(!instance)instance=inventory.create({sql:inventory.open(filename()),authorize:allowed,storeExists:id=>!!db.queryOne('SELECT id FROM stores WHERE id=?',[id])});return instance;}
  router.use((req,res,next)=>{try{if(!req.mpUser&&!req.user)throw Object.assign(new Error('请先登录'),{status:401});req.inventoryActor=resolveActor?resolveActor(req):require('./business-ledger').actorFor(db,req.mpUser||req.user,channel);if(!allowed(req.inventoryActor,'inventory.view'))throw Object.assign(new Error('没有库存查看权限'),{status:403});res.set('Cache-Control','private, no-store');next();}catch(e){res.status(e.status||400).json({error:e.message});}});
  const wrap=fn=>async(req,res)=>{try{const result=await fn(getService(),req.inventoryActor,req);res.json({ok:true,...result});}catch(e){const invalid=/UNIQUE constraint/.test(e.message);res.status(e.status||(invalid?409:400)).json({error:invalid?'记录已存在或已被处理，请刷新核对':e.message});}};
  router.get('/context',wrap((s,a)=>({purposes:Object.entries(inventory.PURPOSES).filter(([p])=>a.admin||a.can('inventory.'+p)).map(([id,name])=>({id,name})),sources:inventory.SOURCES,kinds:inventory.TYPES,stores:db.queryAll('SELECT id,store_name FROM stores').filter(st=>Object.keys(inventory.PURPOSES).some(p=>allowed(a,'inventory.view',st.id,p))),capabilities:Object.fromEntries(['configure','receive','close','confirm','transfer'].map(k=>[k,allowed(a,'inventory.'+k)])),channel})));
  router.get('/items',wrap((s,a)=>({items:s.items(a,{includeSuppliers:channel==='web'})})));
  if(channel==='web'){
    router.get('/suppliers',wrap((s,a)=>({items:s.suppliers(a)})));
    router.get('/suppliers/:id/catalog',wrap((s,a,req)=>({items:s.supplierCatalog(a,req.params.id)})));
    router.post('/suppliers/:id/import-preview',wrap((s,a,req)=>({preview:s.previewSupplierImport(a,req.params.id,req.body)})));
    router.post('/suppliers/:id/import',wrap((s,a,req)=>({result:s.importSupplierCatalog(a,req.params.id,req.body)})));
  }
  router.post('/items',wrap((s,a,req)=>{if(channel==='mini')throw Object.assign(new Error('物料配置请在网页后台办理'),{status:403});return {item:s.saveItem(a,req.body)};}));
  router.get('/stock',wrap((s,a,req)=>({items:s.stock(a,req.query.store_id,req.query.purpose)})));
  router.get('/documents',wrap((s,a,req)=>s.list(a,req.query)));
  router.post('/documents',wrap((s,a,req)=>({item:s.createDoc(a,req.body)})));
  router.get('/documents/:id',wrap((s,a,req)=>({item:s.detail(a,req.params.id)})));
  router.put('/documents/:id',wrap((s,a,req)=>({item:s.updateDoc(a,req.params.id,req.body)})));
  router.post('/documents/:id/action',wrap((s,a,req)=>({item:s.action(a,req.params.id,req.body)})));
  router.get('/loans',wrap((s,a,req)=>({items:s.loans(a,req.query.store_id,req.query.purpose)})));
  router.post('/loans/:id/convert',wrap((s,a,req)=>({item:s.waive(a,req.params.id,req.body)})));
  return router;
}
module.exports={createRouter,authorization,filename};
