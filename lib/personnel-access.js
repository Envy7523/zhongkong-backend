'use strict';
const {normalizePermissions}=require('./permissions');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const ids=value=>{if(!Array.isArray(value))fail('门店范围必须是数组');const result=[...new Set(value.map(Number))];if(result.some(n=>!Number.isInteger(n)||n<=0))fail('无效门店或区域编号');return result};
function initialize(db){
 db.run('CREATE TABLE IF NOT EXISTS access_position_config(position_id INTEGER PRIMARY KEY,config_json TEXT NOT NULL)');
 db.run('CREATE TABLE IF NOT EXISTS access_person_config(user_id INTEGER PRIMARY KEY,version INTEGER NOT NULL DEFAULT 1,config_json TEXT NOT NULL)');
 db.run('CREATE TABLE IF NOT EXISTS access_change_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,actor_id INTEGER,action TEXT,reason TEXT,before_json TEXT,after_json TEXT,created_at TEXT)');
}
function legacyPosition(row){return {category: /督导/.test(row.name)?'group':/店长|店员/.test(row.name)?'store':'group',channels:['web','mini'],mode:'all',store_ids:[],region_ids:[],enabled:true};}
function positionConfig(db,row){const saved=db.queryOne('SELECT config_json FROM access_position_config WHERE position_id=?',[row.id]);return saved?JSON.parse(saved.config_json):legacyPosition(row)}
function positions(db){return db.queryAll('SELECT id,name,permissions_json,is_system FROM position_settings ORDER BY id').map(p=>({...p,permissions:normalizePermissions(p.permissions_json),...positionConfig(db,p)}))}
function config(db,userId){const row=db.queryOne('SELECT * FROM access_person_config WHERE user_id=?',[userId]);return row?{...JSON.parse(row.config_json),version:row.version}:null}
function scopeIds(db,rule){
 if(rule.mode==='all')return null;
 if(rule.mode==='stores')return [...new Set((rule.store_ids||[]).map(Number))];
 if(rule.mode!=='regions')return [];
 const regions=db.queryAll('SELECT id,parent_id FROM store_regions'),selected=new Set((rule.region_ids||[]).map(Number));
 let changed=true;while(changed){changed=false;for(const r of regions)if(selected.has(Number(r.parent_id))&&!selected.has(Number(r.id))){selected.add(Number(r.id));changed=true}}
 if(!selected.size)return [];
 return db.queryAll(`SELECT DISTINCT store_id FROM store_region_members WHERE region_id IN (${[...selected].map(()=>'?').join(',')})`,[...selected]).map(r=>Number(r.store_id));
}
function intersect(a,b){return a===null?b:b===null?a:a.filter(id=>b.includes(id))}
function union(scopes){return scopes.includes(null)?null:[...new Set(scopes.flat())].sort((a,b)=>a-b)}
function allows(scope,id){return scope===null||(Array.isArray(scope)?scope.includes(Number(id)):Number(scope)===Number(id))}
function sqlScope(scope,column='store_id'){if(scope===null)return {sql:'1=1',params:[]};const list=Array.isArray(scope)?scope:[scope];return list.length?{sql:`${column} IN (${list.map(()=>'?').join(',')})`,params:list}:{sql:'1=0',params:[]}}
function effective(db,userId,channel='mini',permission){
 const saved=config(db,userId);if(!saved)return undefined;
 if(!saved.channels.includes(channel))return [];
 const allPositions=positions(db);
 const rows=saved.assignments.map(a=>({a,p:allPositions.find(p=>p.id===a.position_id)})).filter(({p})=>p&&p.enabled&&p.channels.includes(channel));
 return union(rows.filter(({p})=>!permission||require('./channel-permissions').forPosition(p,channel).some(k=>k==='*'||k===permission)).map(({a,p})=>intersect(scopeIds(db,a),scopeIds(db,p))));
}
function permissions(db,userId,channel){const saved=config(db,userId);if(!saved)return undefined;if(channel&&!saved.channels.includes(channel))return [];return [...new Set(positions(db).filter(p=>saved.assignments.some(a=>a.position_id===p.id)&&p.enabled&&(!channel||p.channels.includes(channel))).flatMap(p=>channel?require('./channel-permissions').forPosition(p,channel):p.permissions))]}
function validateScope(db,rule,allowAll=true){
 if(!['all','stores','regions'].includes(rule.mode)||(!allowAll&&rule.mode==='all'))fail('请选择有效负责范围');
 const result={mode:rule.mode,store_ids:ids(rule.store_ids||[]),region_ids:ids(rule.region_ids||[])};
 const selected=rule.mode==='stores'?result.store_ids:result.region_ids;
 if(rule.mode!=='all'&&!selected.length)fail('每个岗位必须明确设置负责门店或区域');
 const table=rule.mode==='stores'?'stores':'store_regions';
 if(rule.mode!=='all'&&selected.some(id=>!db.queryOne(`SELECT id FROM ${table} WHERE id=?`,[id])))fail('所选门店或区域不存在');
 return result;
}
function channels(value){if(!Array.isArray(value)||!value.length||value.some(v=>!['web','mini'].includes(v)))fail('至少选择一个登录端');return [...new Set(value)]}
function transaction(db,fn){db.run('BEGIN');try{const result=fn();db.run('COMMIT');db.save();return result}catch(e){db.run('ROLLBACK');throw e}}
function log(db,userId,actor,action,reason,before,after){db.insert('INSERT INTO access_change_logs(user_id,actor_id,action,reason,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)',[userId,actor,action,reason,JSON.stringify(before),JSON.stringify(after),new Date().toISOString()])}
function preparePerson(db,userId,body){
 if(!Array.isArray(body.assignments)||!body.assignments.length||body.assignments.length>10)fail('请选择1至10个岗位');
 if(body.assignments.filter(a=>a.is_primary).length!==1)fail('必须设置且只能设置一个主岗位');
 const seen=new Set(),ps=positions(db);
 const assignments=body.assignments.map(a=>{const p=ps.find(p=>p.id===Number(a.position_id));if(!p||!p.enabled||seen.has(p.id))fail('岗位无效、重复或未启用');seen.add(p.id);const scope=validateScope(db,a);const actual=intersect(scopeIds(db,scope),scopeIds(db,p));if(actual!==null&&!actual.length)fail(p.name+'的负责门店与岗位适用范围没有交集');return {position_id:p.id,is_primary:!!a.is_primary,...scope}});
 const next={channels:channels(body.channels),employee_id:body.employee_id?Number(body.employee_id):null,assignments};
 for(const a of assignments){const p=ps.find(p=>p.id===a.position_id);if(p.permissions.includes('*')&&(a.mode!=='all'||p.mode!=='all'))fail('管理员全部权限不能用于受限门店岗位，请使用具体功能权限')}
 if(next.employee_id){if(!db.queryOne('SELECT id FROM employees WHERE id=?',[next.employee_id]))fail('关联员工不存在');for(const other of db.queryAll('SELECT * FROM users'))if(other.id!==userId&&Number(config(db,other.id)?.employee_id||other.employee_id)===next.employee_id)fail('该员工已关联其他账号')}
 if(next.channels.some(ch=>!assignments.some(a=>ps.find(p=>p.id===a.position_id).channels.includes(ch))))fail('选择的登录端没有可用岗位');
 const review_fingerprint=require('crypto').createHash('sha256').update(JSON.stringify({next,positions:assignments.map(a=>({position:ps.find(p=>p.id===a.position_id),actual:intersect(scopeIds(db,a),scopeIds(db,ps.find(p=>p.id===a.position_id)))}))})).digest('hex');
 if(body.review_fingerprint&&body.review_fingerprint!==review_fingerprint)fail('岗位模板或负责范围已变化，请重新核对实际权限后保存',409);
 return {next,ps,assignments,review_fingerprint};
}
function writePerson(db,userId,next,ps,before,actor,reason){const assignments=next.assignments;db.run('INSERT INTO access_person_config(user_id,version,config_json) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET version=excluded.version,config_json=excluded.config_json',[userId,(before?.version||0)+1,JSON.stringify(next)]);db.run('DELETE FROM user_positions WHERE user_id=?',[userId]);for(const a of assignments)db.run('INSERT INTO user_positions(user_id,position_id) VALUES(?,?)',[userId,a.position_id]);const primary=assignments.find(a=>a.is_primary);db.run('UPDATE users SET position_id=?,role=? WHERE id=?',[primary.position_id,ps.find(p=>p.id===primary.position_id).name,userId]);log(db,userId,actor,'person.save',reason,before,next);return config(db,userId)}
function savePerson(db,userId,body,actor){
 const user=db.queryOne('SELECT * FROM users WHERE id=?',[userId]);if(!user)fail('账号不存在',404);
 const before=config(db,userId);if(Number(body.version||0)!==Number(before?.version||0))fail('配置已被更新，请刷新后重试',409);
 if(!String(body.reason||'').trim())fail('请填写调整原因');
 const {next,ps,assignments}=preparePerson(db,userId,body);
 if(userId===actor&&!assignments.some(a=>ps.find(p=>p.id===a.position_id).permissions.includes('*')&&a.mode==='all')||userId===actor&&!next.channels.includes('web'))fail('不能移除自己的管理员权限或网页访问');
 require('./store-manager-uniqueness').assertPerson(db,user,next);
 return transaction(db,()=>writePerson(db,userId,next,ps,before,actor,body.reason));
}
function savePosition(db,id,body,actor){const p=positions(db).find(p=>p.id===id);if(!p)fail('岗位不存在',404);if(!['group','store','mini'].includes(body.category))fail('请选择岗位分类');const next={...(p.channel_permissions?{channel_permissions:p.channel_permissions,policy_version:p.policy_version}:{}),...validateScope(db,body),category:body.category,channels:channels(body.channels),enabled:body.enabled!==false};if(p.permissions.includes('*')&&(!next.enabled||!next.channels.includes('web')||next.mode!=='all'))fail('管理员岗位必须保持网页和全门店权限');return transaction(db,()=>{require('./store-manager-uniqueness').protect(db,()=>db.run('INSERT INTO access_position_config VALUES(?,?) ON CONFLICT(position_id) DO UPDATE SET config_json=excluded.config_json',[id,JSON.stringify(next)]));log(db,null,actor,'position.save',body.reason||'维护岗位分类与适用范围',p,next);return next})}
function report(db,id,channel='mini'){
 const saved=config(db,id),ps=positions(db),stores=db.queryAll('SELECT id,store_name FROM stores');
 if(!saved){const user=require('./user-positions').enrich(db,db.queryOne('SELECT * FROM users WHERE id=?',[id]),channel);if(!user)return {configured:false,assignments:[],permissions:[]};const allowed=user.store_id?[Number(user.store_id)]:null;return {configured:false,legacy:true,assignments:ps.filter(p=>user.position_ids.includes(p.id)).map(p=>({position_id:p.id,name:p.name,stores:p.enabled&&p.channels.includes(channel)?stores.filter(s=>allows(intersect(allowed,scopeIds(db,p)),s.id)):[]})),permissions:user.position_permissions.map(code=>({code,stores:stores.filter(s=>allows(allowed,s.id))}))}}
 return {configured:true,...saved,...require('./personnel-directory').evaluateDraft(db,saved,ps)[channel]};
}
function webGuard(db){return (req,res,next)=>{
 if(!req.user||!req.path.startsWith('/api/')||req.path.startsWith('/api/mp/'))return next();
 try{const saved=config(db,req.user.id);if(!saved)return next();
 const rights=permissions(db,req.user.id,'web');if(!saved.channels.includes('web'))fail('此账号未开放网页登录',403);
 if(rights.includes('*'))return next();
 const path=req.path;
 if(/^\/api\/(auth\/(me|profile)|notifications)(\/|$)/.test(path))return next();
 if(/^\/api\/(staff-roster(?:\/.*)?|payroll-context|payroll-sheets(?:\/.*)?|store-staff(?:\/\d+)?|payroll-month-settings\/\d{4}-\d{2}|payroll-attendance-settings|payroll-review(?:\/.*)?)$/.test(path))return next();
 if(/^\/api\/(staff|employees|store-staff)(\/|$)/.test(path))return next(); // Profile middleware applies action, row and field checks.
 if(path.startsWith('/api/store-tasks'))return next();
 if(path.startsWith('/api/knowledge'))return next(); // Knowledge routes apply their own function and audience checks.
 if(path.startsWith('/api/store-operations'))return next(); // Store operations enforce their own function and record scope.
 if(req.method==='GET'&&(path==='/api/db/stores'||path==='/api/store-regions')){
 const scope=effective(db,req.user.id,'web');const original=res.json.bind(res);
 req.accessStoreScope=scope;
 res.json=body=>{if(body.stores)body.stores=body.stores.filter(s=>allows(scope,s.id));if(body.regions)body.regions=body.regions.map(r=>({...r,store_ids:(r.store_ids||[]).filter(id=>allows(scope,id)),stores:(r.stores||[]).filter(s=>allows(scope,s.id))}));return original(body)};return next();
 }
 const analysis=/^\/api\/business-analytics\/(overview|views(?:\/.*)?|meituan-operation|douyin-reviews)$/.test(path);
 const ledger=/^\/api\/bookkeeping\/(entries|categories|subcategories)$/.test(path);
 if(req.method==='GET'&&(analysis||ledger)){
 const code=analysis?'analysis.view':'bookkeeping.manage';if(!rights.includes(code))fail('没有此查询权限',403);
 const scope=effective(db,req.user.id,'web',code),raw=String(req.query.store_ids||req.query.store_id||'');
 const wanted=raw?raw.split(',').map(Number):scope;
 if(Array.isArray(wanted)&&wanted.some(id=>!Number.isInteger(id)||!allows(scope,id)))fail('无权查询所选门店',403);
 if(scope!==null&&!scope.length)fail('此功能没有负责门店',403);
 if(scope!==null)Object.defineProperty(req,'query',{value:{...req.query,store_ids:(wanted||scope).join(',')},configurable:true});
 // Legacy bookkeeping uses the token's single-store binding; scoped assignments take precedence.
 req.user={...req.user,store_id:null};return next();
 }
 if(req.channelOperation){const scope=req.channelOperationScope;const target=Number(path.match(/^\/api\/(?:db\/)?stores\/(\d+)(?:\/|$)/)?.[1]);if(scope===null||target&&allows(scope,target))return next();}
 const globalCode=require('./permissions').requiredPermission(path,req.method);
 // Older modules without row-level guards are available only when this exact
 // function is explicitly assigned for all stores. A different all-store role
 // must never expand a finite assignment for this function.
 if(globalCode&&globalCode!=='*'&&rights.includes(globalCode)&&effective(db,req.user.id,'web',globalCode)===null)return next();
 fail('该入口尚未开放给按岗位分配门店的账号',403);
 }catch(e){res.status(e.status||403).json({error:e.message})}
}}
function mount(app,db,getUser){
 app.use('/api/access',(req,res,next)=>{const user=getUser(req.user?.id);if(!user?.position_permissions?.includes('*'))return res.status(403).json({error:'仅管理员可维护和查询人员权限'});next()});
 const wrap=fn=>(req,res)=>{try{res.json({ok:true,...fn(req)})}catch(e){res.status(e.status||400).json({error:e.message})}};
 app.get('/api/access/config',wrap(()=>require('./personnel-directory').directory(db)));
 app.post('/api/access/preview',wrap(req=>require('./personnel-directory').preview(db,req.body)));
 app.put('/api/access/users/:id/profile',wrap(req=>require('./personnel-directory').saveProfile(db,Number(req.params.id),req.body,req.user.id)));
 app.get('/api/access/permission-catalog',wrap(()=>({channels:require('./channel-permissions').catalog()})));
 app.put('/api/access/positions/:id/policy',wrap(req=>require('./channel-permissions').save(db,Number(req.params.id),req.body,req.user.id)));
 app.put('/api/access/users/:id',wrap(req=>({access:savePerson(db,Number(req.params.id),req.body,req.user.id)})));
 app.post('/api/access/users',wrap(req=>require('./personnel-directory').create(db,req.body,req.user.id)));
 app.put('/api/access/positions/:id',wrap(req=>({position:savePosition(db,Number(req.params.id),req.body,req.user.id)})));
 app.get('/api/access/users/:id/effective',wrap(req=>report(db,Number(req.params.id),req.query.channel||'mini')));
 app.get('/api/access/logs',wrap(req=>({rows:db.queryAll('SELECT l.*,u.display_name AS actor_name FROM access_change_logs l LEFT JOIN users u ON u.id=l.actor_id WHERE (? IS NULL OR l.user_id=?) ORDER BY l.id DESC LIMIT 200',[req.query.user_id?Number(req.query.user_id):null,req.query.user_id?Number(req.query.user_id):null])})));
 app.get('/api/access/store-members',wrap(req=>({rows:db.queryAll('SELECT id,display_name FROM users').filter(u=>config(db,u.id)&&allows(effective(db,u.id,req.query.channel||'mini',req.query.permission||'analysis.view'),req.query.store_id))})));
}
module.exports={initialize,positions,config,scopeIds,intersect,union,allows,sqlScope,effective,permissions,validateScope,savePerson,savePosition,report,mount,webGuard,preparePerson,writePerson,transaction,log};
