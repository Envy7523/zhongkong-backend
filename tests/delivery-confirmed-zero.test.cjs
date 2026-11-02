'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{database,body}=require('./delivery-client-cloud.test.cjs');
const sync=require('../lib/delivery-client-sync'),analytics=require('../lib/business-analytics'),operating=require('../syncbot/src/meituan-delivery/operating-contract'),product=require('../syncbot/src/meituan-delivery/product-contract'),health=require('../lib/delivery-client-health');
async function fixture({date='2026-10-30',positive=false,storeId=24}={}){
 const db=await database();db.run('INSERT INTO stores VALUES(?,\'东平三院店\',\'正常营业\',\'2025-06-14\',\'\')',[storeId]);db.run('INSERT INTO store_platforms VALUES(?,\'美团外卖\',\'33212601\',\'2025-09-01\')',[storeId]);
 const device=sync.enroll(db,{name:'核对测试',account:'test'}),scope=sync.scope(db,date),rows=scope.bindings.map(b=>{
  const r={日期:date.replaceAll('-',''),门店名称:b.store_name,门店id:b.platform_id,省份:'广东',门店所在城市:'惠州',区县市:'惠城'};
  for(const field of operating.metrics)r[field]=b.store_id===storeId&&['营业收入','优惠前总额','有效订单'].includes(field)?'':'0';if(positive&&b.store_id===storeId)r.营业收入='1';
  return operating.fields.map(k=>r[k]).join(',');
 });
 sync.importFile(db,analytics,device,body('operating',date,Buffer.from(operating.fields.join(',')+'\n'+rows.join('\n')+'\n'),scope));sync.importFile(db,analytics,device,body('product',date,Buffer.from(product.fields.join(',')+'\n'),scope));
 return {db,device,date,scope,finish:type=>sync.finish(db,device,{type,date,scope_version:scope.version})};
}
test('user-confirmed zero order applies only to the exact day and binding while preserving blank original fields',async()=>{
 const f=await fixture();try{for(const type of ['operating','product']){const r=f.finish(type);assert.equal(r.status,'success');assert.equal(r.verification.confirmed_zero_days.length,1);}assert.equal(JSON.parse(f.db.queryOne('SELECT raw_json FROM meituan_delivery_operation_records WHERE meituan_store_id=?',['33212601']).raw_json).营业收入,'');assert.match(health.evidence(f.db,'meituan_delivery_operating',f.date).reason,/用户确认/);}finally{f.db.close();}
});
test('confirmation cannot hide positive source values, another date, or a reassigned binding',async()=>{
 for(const options of [{positive:true},{date:'2026-10-31'},{storeId:99}]){const f=await fixture(options);try{assert.equal(f.finish('operating').status,'unverified');assert.equal(f.finish('operating').verification.confirmed_zero_days.length,0);}finally{f.db.close();}}
});
test('both original reports must still exist with valid hashes; no missing or changed evidence is waived',async()=>{
 const f=await fixture();try{f.db.run("UPDATE delivery_collector_files SET sha256='invalid' WHERE report_type='meituan_delivery_product'");assert.equal(f.finish('operating').status,'unverified');f.db.run("DELETE FROM delivery_collector_files WHERE report_type='meituan_delivery_product'");assert.equal(f.finish('operating').status,'unverified');}finally{f.db.close();}
});
