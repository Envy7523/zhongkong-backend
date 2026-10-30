'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express'),fs=require('fs'),os=require('os'),path=require('path');
const access=require('../lib/personnel-access'),positions=require('../lib/user-positions'),permissions=require('../lib/permissions');
test('运营专员可查看团购商品和两平台评价；有限门店账号及评价图片仍隔离',async()=>{
 const {db,raw}=await require('../tools/store-tasks-fixture')();
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'group-access-'));
 const before={dy:process.env.DOUYIN_REVIEW_SNAPSHOT,media:process.env.DOUYIN_REVIEW_MEDIA_DIR,mt:process.env.MEITUAN_REVIEW_SNAPSHOT};let server;
 try{
  db.run('CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,position_id INTEGER,store_id INTEGER)');
  db.run('CREATE TABLE position_settings(id INTEGER PRIMARY KEY,name TEXT,permissions_json TEXT,is_system INTEGER)');
  db.run('CREATE TABLE store_platforms(store_id INTEGER,platform_id TEXT,platform_name TEXT)');
  db.run('INSERT INTO position_settings VALUES(1,?,?,0),(2,?,?,0)', ['运营专员','["analysis.view"]','协同人员','["collab.manage"]']);
  db.run("INSERT INTO users VALUES(1,'operations',1,NULL),(2,'scoped',1,NULL),(3,'no-analysis',2,NULL),(4,'mini-only',1,NULL)");
  db.run("INSERT INTO store_platforms VALUES(1,'mt1','美团团购'),(2,'mt2','美团团购'),(1,'dy1','抖音团购'),(2,'dy2','抖音团购')");
  positions.initialize(db);access.initialize(db);
  for(const [id,mode,stores,channels]of [[1,'all',[],['web','mini']],[2,'stores',[1],['web','mini']],[3,'all',[],['web']],[4,'all',[],['mini']]])db.run('INSERT INTO access_person_config VALUES(?,1,?)',[id,JSON.stringify({channels,assignments:[{position_id:id===3?2:1,is_primary:true,mode,store_ids:stores,region_ids:[]}]})]);
  const a='a'.repeat(64)+'.jpg',b='b'.repeat(64)+'.jpg';fs.writeFileSync(path.join(tmp,a),'store1');fs.writeFileSync(path.join(tmp,b),'store2');
  const stores=[{storeName:'测试一店',platformStoreId:'dy1'},{storeName:'测试二店',platformStoreId:'dy2'}];
  fs.writeFileSync(path.join(tmp,'dy.json'),JSON.stringify({stores,datasets:{full:{reviews:stores.map((s,i)=>({...s,ratingLabel:'推荐',publishedDate:'2026-10-26',mediaFiles:[i?b:a]}))}}}));
  fs.writeFileSync(path.join(tmp,'mt.json'),JSON.stringify({runId:'test',updatedAt:'2026-10-26T00:00:00Z',stores:[{platformStoreId:'mt1'},{platformStoreId:'mt2'}],reviews:[{platformStoreId:'mt1',rating:5,publishedDisplay:'2026-10-26'},{platformStoreId:'mt2',rating:4,publishedDisplay:'2026-10-26'}]}));
  process.env.DOUYIN_REVIEW_SNAPSHOT=path.join(tmp,'dy.json');process.env.DOUYIN_REVIEW_MEDIA_DIR=tmp;process.env.MEITUAN_REVIEW_SNAPSHOT=path.join(tmp,'mt.json');
  const app=express();app.use((req,res,next)=>{req.user={id:Number(req.get('x-test-user'))};next()});
  app.use(access.webGuard(db));app.use(permissions.createGuard({getUserById:id=>positions.enrich(db,db.queryOne('SELECT * FROM users WHERE id=?',[id])),hasFullAccess:u=>u.position_permissions.includes('*')}));
  app.get('/api/business-analytics/products/:scope',(req,res)=>{const ids=req.query.store_ids?.split(',').map(Number);res.json({products:db.queryAll('SELECT id FROM stores').filter(s=>!ids||ids.includes(s.id)).map(s=>({store_id:s.id}))})});
  app.get('/api/business-analytics/order-insights',(req,res)=>{const ids=req.query.store_ids?.split(',').map(Number);res.json({products:db.queryAll('SELECT id FROM stores').filter(s=>!ids||ids.includes(s.id)).map(s=>({store_id:s.id}))})});
  require('../lib/meituan-reviews').mount({app,db});require('../lib/douyin-reviews').mount({app,db});
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  const get=(user,url,method='GET')=>fetch(base+url,{method,headers:{'x-test-user':String(user)}});
  for(const route of ['/api/business-analytics/products/group-buy','/api/business-analytics/order-insights','/api/business-analytics/meituan-reviews','/api/business-analytics/douyin-reviews']){
   const all=await get(1,route+'?store_ids=2&mode=full');assert.equal(all.status,200,route);
   const own=await get(2,route+'?mode=full');assert.equal(own.status,200);const data=await own.json();assert.ok((data.reviews||data.products).every(r=>(r.storeId||r.store_id)===1));
   assert.equal((await get(2,route+'?store_ids=2&mode=full')).status,403);
   assert.equal((await get(3,route+'?store_ids=1&mode=full')).status,403);
   assert.equal((await get(4,route+'?store_ids=1&mode=full')).status,403);
  }
  assert.equal((await get(1,'/api/business-analytics/douyin-review-media/'+b)).status,200);
  assert.equal((await get(2,'/api/business-analytics/douyin-review-media/'+a)).status,200);
  assert.equal((await get(2,'/api/business-analytics/douyin-review-media/'+b)).status,403);
  assert.equal((await get(3,'/api/business-analytics/douyin-review-media/'+a)).status,403);
  assert.equal((await get(1,'/api/enterprise-settings')).status,403);
  assert.equal((await get(1,'/api/business-analytics/products/group-buy','POST')).status,403);
  db.run("INSERT INTO stores VALUES(3,'后续新开门店')");
  const added=await get(1,'/api/business-analytics/products/group-buy?store_ids=3');assert.equal(added.status,200);assert.deepEqual((await added.json()).products,[{store_id:3}]);
  assert.equal((await get(2,'/api/business-analytics/products/group-buy?store_ids=3')).status,403);
 }finally{
  if(server)await new Promise(r=>server.close(r));raw.close();
  for(const [key,value]of Object.entries({DOUYIN_REVIEW_SNAPSHOT:before.dy,DOUYIN_REVIEW_MEDIA_DIR:before.media,MEITUAN_REVIEW_SNAPSHOT:before.mt}))if(value===undefined)delete process.env[key];else process.env[key]=value;
  fs.rmSync(tmp,{recursive:true,force:true});
 }
});
