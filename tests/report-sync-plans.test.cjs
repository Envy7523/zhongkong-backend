const {test}=require('node:test'),assert=require('node:assert/strict');
const {mountReportSyncPlans,PREFIX,INTERNAL}=require('../lib/report-sync-plans');
test('real SQL plans persist categories, separate group times, audit and reject unauthorized updates',async()=>{
 const SQL=await require('sql.js')(),sql=new SQL.Database();let saves=0;
 const db={run:(s,p)=>sql.run(s,p),queryOne:(s,p)=>{const q=sql.prepare(s);q.bind(p||[]);const row=q.step()?q.getAsObject():null;q.free();return row;},save:()=>saves++};
 db.run('CREATE TABLE schedule_config(id INTEGER,sync_enabled INTEGER,sync_time TEXT,updated_at TEXT,version INTEGER)');
 db.run("INSERT INTO schedule_config VALUES(1,1,'01:05',NULL,1)");
 db.run('CREATE TABLE users(id INTEGER,position_id INTEGER)');db.run('CREATE TABLE position_settings(id INTEGER,permissions_json TEXT)');
 db.run("INSERT INTO position_settings VALUES(1,'[\"enterprise-settings.manage\"]')");db.run('INSERT INTO users VALUES(1,1)');
 const routes={},app={get:(p,h)=>routes['GET '+p]=h,post:(p,h)=>routes['POST '+p]=h};
 mountReportSyncPlans({app,db,permissions:require('../lib/permissions'),audit:{loadSecret:()=>null}});
 function request(method,url,options={}){const res={statusCode:200,status(c){this.statusCode=c;return this;},json(value){this.body=value;return this;}};routes[method+' '+url]({user:{id:1,username:'test'},body:{},params:{},get:()=>null,...options},res);return res;}
 const initial=request('GET',PREFIX);assert.equal(initial.statusCode,200);assert.equal(initial.body.plans.length,20);
 const member=initial.body.plans.find(p=>p.report_type==='member_card_transactions');assert.equal(member.enabled,false);assert.equal(member.run_time,'06:20');assert.equal(member.category,'system');
 const orders=initial.body.plans.find(p=>p.report_type==='all_channel_orders');assert.equal(orders.enabled,true);assert.equal(orders.run_time,'05:20');assert.equal(orders.category,'system');
 const group=initial.body.plans.filter(p=>p.category==='group'&&p.platform==='美团团购');assert.equal(group.length,3);assert.ok(group.every(p=>p.enabled&&p.run_time==='03:00'));
 const douyin=initial.body.plans.find(p=>p.report_type==='douyin_group_report1');assert.equal(douyin.category,'group');assert.equal(douyin.enabled,false);assert.equal(douyin.run_time,'04:00');const operation=initial.body.plans.find(p=>p.report_type==='douyin_group_report2');assert.equal(operation.enabled,false);assert.equal(operation.run_time,'04:00');
 const save=type=>request('POST',PREFIX+'/:reportType',{params:{reportType:type},body:{enabled:true,run_time:'03:00'}});
 assert.equal(save('meituan_group_report1').body.changed,false);
 const changed=request('POST',PREFIX+'/:reportType',{params:{reportType:'meituan_group_report2'},body:{enabled:false,run_time:'05:15'}});
 assert.equal(changed.statusCode,200);assert.equal(changed.body.plan.version,2);assert.equal(changed.body.plan.enabled,false);
 const reread=request('GET',PREFIX).body.plans;assert.equal(reread.find(p=>p.report_type==='meituan_group_report2').run_time,'05:15');assert.equal(reread.find(p=>p.report_type==='meituan_group_report1').run_time,'03:00');
 assert.equal(db.queryOne('SELECT count(*) n FROM report_sync_plan_audit').n,1);assert.equal(saves,2);
 assert.equal(request('POST',PREFIX+'/:reportType',{user:null}).statusCode,401);
 assert.equal(request('GET',INTERNAL+'/:reportType',{socket:{remoteAddress:'127.0.0.1'},params:{reportType:'meituan_group_report1'}}).statusCode,401);
 sql.close();
});


