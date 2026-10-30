const {test,before}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),init=require('sql.js');
let SQL;before(async()=>{SQL=await init();});
function driver(raw,failing=false){
 const source=fs.readFileSync(require.resolve('../lib/db'),'utf8');
 const state=source.slice(source.indexOf('let persistenceFault'),source.indexOf('/** 确保 data'));
 const io=source.slice(source.indexOf('function save()'),source.indexOf('/** 关闭数据库'));
 const tx=source.slice(source.indexOf('function transaction(action)'),source.indexOf('module.exports ='));
 const fakeFs={writeFileSync(){},renameSync(){if(failing)throw new Error('disk-write-failure')},existsSync:()=>false,unlinkSync(){}};
 return new Function('db','fs','DB_PATH','sleepSync',state+io+tx+';return {save,run,queryAll,transaction,available:()=>!persistenceFault}')(raw,fakeFs,'fixture.sqlite',()=>{});
}
test('生产同版本sql.js重复保存后外键持续开启并执行级联',()=>{
 const raw=new SQL.Database(),db=driver(raw);
 raw.run('PRAGMA foreign_keys=ON;CREATE TABLE parent(id INTEGER PRIMARY KEY);CREATE TABLE child(id INTEGER,parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE);INSERT INTO parent VALUES(1);INSERT INTO child VALUES(1,1)');
 db.save();assert.equal(db.queryAll('PRAGMA foreign_keys')[0].foreign_keys,1);db.save();assert.equal(db.queryAll('PRAGMA foreign_keys')[0].foreign_keys,1);
 db.run('DELETE FROM parent WHERE id=1');assert.equal(db.queryAll('SELECT * FROM child').length,0);raw.close();
});
test('真实保存函数注入磁盘失败后保留原异常，停止读写，不能将失败记录再次落盘',()=>{
 const raw=new SQL.Database(),db=driver(raw,true);raw.run('CREATE TABLE rows(id INTEGER)');
 assert.throws(()=>db.transaction(()=>db.run('INSERT INTO rows VALUES(1)')),/disk-write-failure/);
 assert.equal(db.available(),false);assert.throws(()=>db.run('INSERT INTO rows VALUES(2)'),e=>e.status===503);
 assert.throws(()=>db.queryAll('SELECT * FROM rows'),e=>e.status===503);assert.throws(()=>db.save(),e=>e.status===503);raw.close();
});
test('管理员API、手工导入与采集身份边界一致',()=>{
 const p=require('../lib/permissions');
 for(const url of ['/api/users','/api/access/config','/api/positions','/api/operation-audit','/api/config','/api/settings','/api/business-ledger/integrations','/api/enterprise-settings/schedule','/api/enterprise-settings/report-sync-plans','/api/business-analytics/sync-runs/123'])for(const method of ['GET','POST','PUT','DELETE'])assert.equal(p.requiredPermission(url,method),'*',url);
 assert.equal(p.requiredPermission('/api/business-analytics/import','POST'),'business_analytics.import');
 assert.equal(p.requiredPermission('/api/enterprise-settings/delivery-fee-rules','GET'),'analysis.view');
 assert.notEqual(p.requiredPermission('/api/business-analytics/sync-runs/bookkeeping-review','GET'),'*');
 let code=200,next=false;const guard=p.createGuard({getUserById:()=>({username:'syncbot_importer',permissions_json:'["business_analytics.import"]'}),hasFullAccess:()=>false});
 guard({path:'/api/collab/issues',method:'POST',user:{id:1}},{status:n=>{code=n;return {json(){}}}},()=>next=true);assert.equal(code,403);assert.equal(next,false);
});
test('薪资单独同意版本与小程序当前协议一致',async()=>{
 const legal=await import('../miniprogram/src/common/legal-content.mjs');assert.equal(legal.LEGAL_VERSION,require('../lib/business-ledger').PAYSLIP_PRIVACY_VERSION);
});
