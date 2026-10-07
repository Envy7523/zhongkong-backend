const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),express=require('express'),initSqlJs=require('sql.js');
const roles=require('../lib/user-positions'),workflow=require('../lib/payroll-workflow');
test('账号创建和编辑接口保存多个岗位，列表与权限查询使用并集',async()=>{
 const SQL=await initSqlJs(),raw=new SQL.Database();
 const db={run:(s,p=[])=>raw.run(s,p),queryAll:(s,p=[])=>{const q=raw.prepare(s);q.bind(p);const rows=[];while(q.step())rows.push(q.getAsObject());q.free();return rows},save:()=>{}};
 db.queryOne=(s,p)=>db.queryAll(s,p)[0] || null;db.insert=(s,p)=>{db.run(s,p);return db.queryOne('SELECT last_insert_rowid() id').id};
 raw.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT UNIQUE,password_hash TEXT,role TEXT,display_name TEXT,phone TEXT,position_id INTEGER,store_id INTEGER);CREATE TABLE stores(id INTEGER PRIMARY KEY,store_name TEXT);INSERT INTO stores VALUES(1,'A店');CREATE TABLE position_settings(id INTEGER PRIMARY KEY,name TEXT,permissions_json TEXT);INSERT INTO position_settings VALUES(1,'店长','["staff.store.edit","payroll.view","payroll.prepare"]'),(2,'督导','["staff.store.edit","payroll.view"]'),(3,'人事','["staff.view","payroll.attendance"]');`);
 roles.initialize(db);
 const source=fs.readFileSync(require.resolve('../server'),'utf8');let create=source.slice(source.indexOf("app.post('/api/users',"),source.indexOf("app.put('/api/users/:id'"));let update=source.slice(source.indexOf("app.put('/api/users/:id'"));update=update.slice(0,update.indexOf('\napp.',10));
 const app=express();app.use(express.json());
 new Function('app','db','userPositions','payrollWorkflow','parsePositionPermissions','crypto',create+update)(app,db,roles,workflow,v=>JSON.parse(v),require('crypto'));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const request=async(path,method,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()}};
 try{
  assert.equal((await request('/api/users','POST',{username:'test',password:'password',position_ids:[2,1]})).status,400);
  let result=await request('/api/users','POST',{username:'test',password:'password',position_ids:[2,1],store_id:1});assert.equal(result.status,200);const id=result.data.id;
  let actor=workflow.actorFor(db,{user:{id}});assert(actor.ownOnly && actor.canPrepare);assert.deepEqual(roles.enrich(db,db.queryOne('SELECT * FROM users WHERE id=?',[id])).position_ids,[1,2]);
  result=await request('/api/users/'+id,'PUT',{position_ids:[1,3],store_id:1});assert.equal(result.status,200);actor=workflow.actorFor(db,{user:{id}});assert(actor.canAttendance && !actor.ownOnly);
  result=await request('/api/users/'+id,'PUT',{position_ids:[2],store_id:1});assert.equal(result.status,200);actor=workflow.actorFor(db,{user:{id}});assert(!actor.canPrepare && actor.ownOnly);
  const before=db.queryAll('SELECT * FROM users');assert.equal((await request('/api/users/'+id,'PUT',{position_ids:[999]})).status,400);assert.deepEqual(db.queryAll('SELECT * FROM users'),before);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));raw.close()}
});
