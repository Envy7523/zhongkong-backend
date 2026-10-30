'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const insights=require('../lib/store-order-insights');
async function fixture(){
  const SQL=await require('sql.js')(),raw=new SQL.Database();
  const db={queryAll(sql,params=[]){const s=raw.prepare(sql);try{s.bind(params);const out=[];while(s.step())out.push(s.getAsObject());return out}finally{s.free()}},queryOne(sql,p){return this.queryAll(sql,p)[0]||null},run(sql,p=[]){raw.run(sql,p)}};
  db.run('CREATE TABLE stores(id INTEGER,store_name TEXT)');db.run("INSERT INTO stores VALUES(1,'一店'),(2,'二店'),(3,'重复店名'),(4,'重复店名')");
  db.run('CREATE TABLE pos_product_sale_details(store_id INTEGER,biz_date TEXT,order_id TEXT,order_time TEXT,channel TEXT,product_code TEXT,product_name TEXT,spec TEXT,quantity REAL,sales_amount REAL,income_amount REAL)');
  db.run('CREATE TABLE dish_sales(store_name TEXT,order_time TEXT,order_no TEXT,payment_detail TEXT,product_code TEXT,product_name TEXT,spec TEXT,quantity REAL,amount_total REAL,income_amount REAL)');
  db.run('CREATE TABLE pos_order_coverage(store_id INTEGER,biz_date TEXT,order_count INTEGER)');
  const pos=(over={})=>{const r={store_id:1,biz_date:'2026-10-01',order_id:'O1',order_time:'2026-10-01 12:00:00',channel:'meituan_delivery',product_code:'A',product_name:'烧鹅',spec:'小份',quantity:1,sales_amount:30,income_amount:20,...over};db.run('INSERT INTO pos_product_sale_details VALUES(?,?,?,?,?,?,?,?,?,?,?)',Object.values(r))};
  const legacy=(over={})=>{const r={store_name:'一店',order_time:'2026-10-01 12:00:00',order_no:'L1',payment_detail:'现金',product_code:'A',product_name:'烧鹅',spec:'小份',quantity:1,amount_total:30,income_amount:30,...over};db.run('INSERT INTO dish_sales VALUES(?,?,?,?,?,?,?,?,?,?)',Object.values(r))};
  return {db,raw,pos,legacy};
}
const params={date_from:'2026-10-01',date_to:'2026-10-03',store_ids:'1'};
test('同单多菜只计一单，同编号跨门店分开；历史镜像按门店营业日排除，规格独立',async()=>{
  const {db,raw,pos,legacy}=await fixture();try{
    pos();pos({product_code:'B',product_name:'青菜',sales_amount:10});pos({store_id:2});
    legacy();legacy({store_name:'二店'});legacy({order_time:'2026-10-02T13:00:00'});legacy({store_name:'重复店名',order_no:'ambiguous'});
    pos({order_id:'O2',spec:'大份'});
    const r=insights.getInsights(db,{...params,store_ids:'1,2,3,4'});
    assert.equal(r.totals.orders,4);assert.equal(r.hourly[12].total,3);assert.equal(r.hourly[13].total,1);
    assert.equal(r.dishes.rows.find(d=>d.spec==='小份'&&d.channel==='meituan_delivery'&&d.product_code==='A').quantity,2);
    assert(r.dishes.rows.some(d=>d.spec==='大份'));assert.equal(r.dishes.total,4);assert.equal(r.daily[2].total,null);
  }finally{raw.close()}
});
test('结束时刻不包含；跨午夜按钟点，缺时刻仅全天按日计入；缺订单号不按菜品行造单',async()=>{
  const {db,raw,pos}=await fixture();try{
    for(const [id,time]of [['morning','01:30'],['noon','12:00'],['edge','14:00'],['night','23:30']])pos({order_id:id,order_time:'2026-10-01 '+time+':00'});
    pos({order_id:'untimed',order_time:''});pos({order_id:'missing',order_time:'2026-10-01 28:00:00'});pos({order_id:'',order_time:'2026-10-01 12:05:00'});
    let r=insights.getInsights(db,params);assert.equal(r.totals.orders,6);assert.equal(r.totals.untimed_orders,2);assert.equal(r.coverage.unidentified_lines,1);assert.equal(r.dishes.rows[0].quantity,6);
    r=insights.getInsights(db,{...params,time_from:'12:00',time_to:'14:00'});assert.equal(r.totals.orders,1);assert.equal(r.dishes.rows[0].quantity,1);assert.equal(r.hourly[14].total,null);
    r=insights.getInsights(db,{...params,time_from:'22:00',time_to:'02:00'});assert.equal(r.totals.orders,2);assert.equal(r.hourly[23].total,1);assert.equal(r.hourly[1].total,1);assert.equal(r.hourly[12].total,null);
  }finally{raw.close()}
});
test('纯退款不算新订单但菜品冲减保留；跨渠道同单归入独立渠道，全额与到手不混用',async()=>{
  const {db,raw,pos}=await fixture();try{
    pos();pos({channel:'jd_delivery',product_name:'青菜'});pos({order_id:'refund',quantity:-1,sales_amount:-30,income_amount:-20});
    let r=insights.getInsights(db,params);assert.equal(r.totals.orders,1);assert.equal(r.hourly[12].channels.mixed,1);
    assert.equal(r.dishes.rows.find(d=>d.channel==='meituan_delivery').sales_amount,-30);
    r=insights.getInsights(db,{...params,channels:'mixed'});assert.equal(r.totals.orders,1);assert.equal(r.dishes.total,2);
    r=insights.getInsights(db,{...params,channels:'jd_delivery'});assert.equal(r.totals.orders,0);assert.equal(r.dishes.total,0);
  }finally{raw.close()}
});
test('明确零与未导入分开，菜品搜索和分页不改变订单统计',async()=>{
  const {db,raw,pos}=await fixture();try{
    pos();db.run("INSERT INTO pos_order_coverage VALUES(1,'2026-10-02',0)");
    let r=insights.getInsights(db,{...params,keyword:'不存在'});assert.equal(r.totals.orders,1);assert.equal(r.dishes.total,0);assert.equal(r.daily[1].total,0);assert.equal(r.daily[2].total,null);
    pos({product_name:'青菜'});r=insights.getInsights(db,{...params,page_size:1,page:2});assert.equal(r.dishes.total,2);assert.equal(r.dishes.rows.length,1);
    const noWrite=db.run;db.run=()=>{throw Error('writes forbidden')};assert.equal(insights.getInsights(db,params).totals.orders,1);db.run=noWrite;
  }finally{raw.close()}
});
test('参数严格验证，不接受非法日期、门店表达式、超长范围或分页',()=>{
  for(const q of [{date_from:'2026-02-30'},{date_to:'2025-10-01'},{date_to:'2027-01-02'},{date_to:'2027-10-02'},{store_ids:'1 OR 1=1'},{store_ids:['1','2']},{time_from:'25:00'},{time_from:'12:00',time_to:'12:00'},{channels:'untrusted'},{page_size:101}])assert.throws(()=>insights.options({...params,...q}));
});

test('有明细但所选时段无订单显示记录范围内的零；缺门店日不隐藏，纯缺时刻不生成小时数据',async()=>{
  const {db,raw,pos}=await fixture();try{
    pos({order_time:''});let r=insights.getInsights(db,params);assert.equal(r.daily[0].total,1);assert(r.hourly.every(h=>h.total===null));
    r=insights.getInsights(db,{...params,time_from:'11:00',time_to:'14:00',store_ids:'1,2'});assert.equal(r.daily[0].total,0);assert.equal(r.coverage.missing_store_days,5);
    pos({order_id:'later',order_time:'2026-10-01 18:00:00'});r=insights.getInsights(db,{...params,time_from:'11:00',time_to:'14:00'});assert.equal(r.hourly[12].total,0);assert.equal(r.daily[1].total,null);
    r=insights.getInsights(db,{...params,page:99});assert.equal(r.dishes.total,1);assert.equal(r.dishes.rows.length,0);
  }finally{raw.close()}
});
test('新接口强制分析权限，有限门店和旧账号绑定不能越权',async()=>{
  const {db,raw,pos}=await fixture();const express=require('express');let server;
  try{
    pos();pos({store_id:2});
    const users={1:{position_permissions:['*']},2:{position_permissions:['analysis.view'],store_id:1},3:{position_permissions:['collab.manage']},4:{position_permissions:['analysis.view']}};
    const app=express();app.use((req,res,next)=>{req.user={id:Number(req.get('x-fixture-user'))};if(req.user.id===4)req.accessStoreScope=[1];next()});
    insights.mount({app,db,getUser:id=>users[id]});server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    const get=(id,q='')=>fetch('http://127.0.0.1:'+server.address().port+'/api/business-analytics/order-insights?date_from=2026-10-01&date_to=2026-10-03'+q,{headers:{'x-fixture-user':String(id)}});
    assert.equal((await get(0)).status,401);assert.equal((await get(3)).status,403);
    for(const id of [2,4]){assert.equal((await get(id,'&store_ids=2')).status,403);assert.equal((await get(id,'&store_id=2')).status,403);assert.equal((await get(id,'&store_ids=1,2')).status,403);assert.equal((await(await get(id)).json()).totals.orders,1)}
    assert.equal((await(await get(1)).json()).totals.orders,2);
  }finally{if(server)await new Promise(r=>server.close(r));raw.close()}
});
