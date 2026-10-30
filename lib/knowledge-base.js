'use strict';
const access=require('./personnel-access'),up=require('./user-positions'),context=require('./employee-mini-context');
const fail=(m,status=400)=>{throw Object.assign(new Error(m),{status})},now=()=>new Date().toISOString(),parse=s=>JSON.parse(s),can=(u,p)=>(u.position_permissions||[]).some(k=>k==='*'||k===p);
const categories=['收银与系统','团购业务','外卖业务','菜品制作','出品标准','门店运营','营销物料','经营与成本'];
function initialize(db){
 require('./knowledge-banners').initialize(db);
 db.run('CREATE TABLE IF NOT EXISTS kb_categories(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,sort_order INTEGER NOT NULL DEFAULT 0)');
 db.run('CREATE TABLE IF NOT EXISTS kb_entries(id INTEGER PRIMARY KEY AUTOINCREMENT,draft_json TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,published_version INTEGER,status TEXT NOT NULL DEFAULT \'draft\',updated_at TEXT NOT NULL)');
 db.run('CREATE TABLE IF NOT EXISTS kb_versions(entry_id INTEGER,version INTEGER,payload_json TEXT NOT NULL,learning_cycle INTEGER NOT NULL,published_by INTEGER,published_at TEXT,PRIMARY KEY(entry_id,version))');
 db.run('CREATE TABLE IF NOT EXISTS kb_files(id TEXT PRIMARY KEY,user_id INTEGER,name TEXT,ext TEXT,bytes INTEGER,sha256 TEXT,state TEXT,preview_json TEXT,error TEXT,created_at TEXT)');
 db.run('CREATE TABLE IF NOT EXISTS kb_reads(user_id INTEGER,entry_id INTEGER,learning_cycle INTEGER,first_read_at TEXT,last_read_at TEXT,learned_at TEXT,store_id INTEGER,last_version INTEGER,PRIMARY KEY(user_id,entry_id,learning_cycle))');
 db.run('CREATE TABLE IF NOT EXISTS kb_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,entry_id INTEGER,user_id INTEGER,action TEXT,detail_json TEXT,created_at TEXT)');
 db.run('CREATE TABLE IF NOT EXISTS kb_migrations(key TEXT PRIMARY KEY)');
 // Seed once. Renaming/deleting a default category must survive a restart.
 // Startup supplies a schema adapter with run() only. Adopt an existing
 // catalog first, so upgrading does not recreate previously renamed defaults.
 db.run("INSERT OR IGNORE INTO kb_migrations SELECT 'categories-seeded-v1' WHERE EXISTS(SELECT 1 FROM kb_categories)");
 for(let i=0;i<categories.length;i++)db.run("INSERT OR IGNORE INTO kb_categories(name,sort_order) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM kb_migrations WHERE key='categories-seeded-v1')",[categories[i],i]);
 db.run("INSERT OR IGNORE INTO kb_migrations VALUES('categories-seeded-v1')");
}
function initialGrants(db){if(db.queryOne("SELECT key FROM kb_migrations WHERE key='read-v1'"))return;for(const p of access.positions(db).filter(p=>/店长|店员|督导/.test(p.name))){if(!p.permissions.includes('*')&&!p.permissions.includes('learning.view'))db.run('UPDATE position_settings SET permissions_json=? WHERE id=?',[JSON.stringify([...p.permissions,'learning.view']),p.id])}db.run("INSERT INTO kb_migrations VALUES('read-v1')")}
function requireRight(user,right){if(!can(user,right))fail('没有此知识库权限',403)}
function transaction(db,fn){db.run('BEGIN');try{const r=fn();db.run('COMMIT');db.save();return r}catch(e){db.run('ROLLBACK');throw e}}
function log(db,id,user,action,data){db.insert('INSERT INTO kb_logs(entry_id,user_id,action,detail_json,created_at) VALUES(?,?,?,?,?)',[id,user.id,action,JSON.stringify(data),now()])}
function normalize(db,body,user){
 const text=(v,n)=>{const s=String(v||'').trim();if(s.length>n)fail('文字超过长度限制');return s};
 if(!Array.isArray(body.position_ids)||!Array.isArray(body.file_ids||[]))fail('岗位和附件必须为数组');
 const p={title:text(body.title,120),category_id:Number(body.category_id),topic:text(body.topic,60),summary:text(body.summary,300),content:text(body.content,8000),kind:body.kind||'教程',position_ids:[...new Set(body.position_ids.map(Number))],mode:body.mode||'all',store_ids:body.store_ids||[],region_ids:body.region_ids||[],file_ids:[...new Set(body.file_ids||[])],require_relearn:!!body.require_relearn,change_note:text(body.change_note,500)};
 if(!Array.isArray(p.store_ids)||!Array.isArray(p.region_ids)||[...p.store_ids,...p.region_ids].some(n=>!Number.isInteger(n)||n<1))fail('门店或区域选择无效');
 if(p.mode==='stores'&&p.store_ids.some(id=>!db.queryOne('SELECT id FROM stores WHERE id=?',[id]))||p.mode==='regions'&&p.region_ids.some(id=>!db.queryOne('SELECT id FROM store_regions WHERE id=?',[id])))fail('门店或区域不存在');
 if(!p.title||!db.queryOne('SELECT id FROM kb_categories WHERE id=?',[p.category_id]))fail('请填写标题并选择分类');
 if(!['教程','常见问题','标准规范','培训课件','资料模板'].includes(p.kind))fail('无效内容类型');
 if(p.position_ids.length>100||p.position_ids.some(id=>!access.positions(db).some(p=>p.id===id&&p.enabled&&p.channels.includes('mini'))))fail('阅读岗位无效');
 const s=access.scopeIds(db,p);if(!['all','stores','regions'].includes(p.mode)||s!==null&&!s.length)fail('请选择有效适用门店范围');
 p.audience_mode=body.audience_mode||'positions';if(!['all','positions'].includes(p.audience_mode))fail('请选择阅读对象');
 if(p.file_ids.length>12||p.file_ids.some(id=>!db.queryOne('SELECT id FROM kb_files WHERE id=?',[id])))fail('附件无效或超过12份');
 // Editors can reuse attachments only from an existing editable draft, or their own upload.
 const previous=body.id?db.queryOne('SELECT draft_json FROM kb_entries WHERE id=?',[Number(body.id)]):null;
 const reusable=previous?parse(previous.draft_json).file_ids:[];
 if(!can(user,'*')&&p.file_ids.some(id=>db.queryOne('SELECT user_id FROM kb_files WHERE id=?',[id]).user_id!==user.id&&!reusable.includes(id)))fail('无权使用此附件',403);
 p.cover_file_id=body.cover_file_id||null;
 p.home_featured=body.home_featured===true;
 p.home_order=body.home_order===undefined?100:Number(body.home_order);
 if(!Number.isInteger(p.home_order)||p.home_order<1||p.home_order>999)fail('推荐顺序须为1至999的整数');
 if(p.cover_file_id&&typeof p.cover_file_id!=='string')fail('封面选择无效');
 if(p.cover_file_id){const cover=db.queryOne('SELECT * FROM kb_files WHERE id=?',[p.cover_file_id]);if(!cover||!['jpg','jpeg','png','webp'].includes(cover.ext)||cover.bytes>5*1024*1024)fail('教案封面须为5MB以内的JPG、PNG或WebP图片');if(!can(user,'*')&&cover.user_id!==user.id&&(!previous||parse(previous.draft_json).cover_file_id!==cover.id))fail('无权使用此封面',403)}
 return p;
}
function save(db,body,user){requireRight(user,'knowledge.edit');const p=normalize(db,body,user),old=body.id?db.queryOne('SELECT * FROM kb_entries WHERE id=?',[Number(body.id)]):null;if(body.id&&!old)fail('资料不存在',404);if(old?.status==='deleted')fail('请先从回收站恢复资料',409);if(old&&Number(body.revision)!==old.revision)fail('资料已被更新，请刷新后再编辑',409);return transaction(db,()=>{let id=old?.id;if(id)db.run('UPDATE kb_entries SET draft_json=?,revision=revision+1,updated_at=? WHERE id=?',[JSON.stringify(p),now(),id]);else id=db.insert('INSERT INTO kb_entries(draft_json,updated_at) VALUES(?,?)',[JSON.stringify(p),now()]);log(db,id,user,'save',{title:p.title});return {id,revision:(old?.revision||0)+1}})}
function publish(db,id,body,user){requireRight(user,'knowledge.publish');const e=db.queryOne('SELECT * FROM kb_entries WHERE id=?',[Number(id)]);if(!e)fail('资料不存在',404);if(Number(body.revision)!==e.revision)fail('草稿版本已变，请刷新',409);const p=parse(e.draft_json);if(p.audience_mode!=='all'&&!p.position_ids.length)fail('发布前请选择允许阅读的岗位');if(!p.content&&!p.file_ids.length)fail('请添加正文或附件');for(const id of p.file_ids){const file=db.queryOne('SELECT state FROM kb_files WHERE id=?',[id]);if(!file||file.state==='uploading')fail('附件尚未上传完成')}
 if(p.cover_file_id&&db.queryOne('SELECT state FROM kb_files WHERE id=?',[p.cover_file_id])?.state!=='ready')fail('封面预览尚未生成完成，请稍后发布');
 if(e.status==='deleted')fail('请先从回收站恢复资料',409);
 const last=db.queryOne('SELECT * FROM kb_versions WHERE entry_id=? ORDER BY version DESC LIMIT 1',[e.id]);const version=(last?.version||0)+1,cycle=last?(last.learning_cycle+(p.require_relearn?1:0)):1;
 return transaction(db,()=>{db.run('INSERT INTO kb_versions VALUES(?,?,?,?,?,?)',[e.id,version,JSON.stringify(p),cycle,user.id,now()]);db.run("UPDATE kb_entries SET published_version=?,status='published',revision=revision+1,updated_at=? WHERE id=?",[version,now(),e.id]);log(db,e.id,user,'publish',{version,cycle});return {version}});
}
function hide(db,id,body,user){requireRight(user,'knowledge.publish');const e=db.queryOne('SELECT * FROM kb_entries WHERE id=?',[Number(id)]);if(!e)fail('资料不存在',404);if(e.status==='deleted')fail('请先从回收站恢复资料',409);if(Number(body.revision)!==e.revision)fail('资料已变，请刷新',409);return transaction(db,()=>{db.run("UPDATE kb_entries SET status='hidden',revision=revision+1,updated_at=? WHERE id=?",[now(),e.id]);log(db,e.id,user,'hide',{});return {}})}
function miniScope(db,user,p){
 if(context.departed(context.employee(db,user))||!can(user,'learning.view')||user.access_configured&&!user.access_channels.includes('mini'))return [];
 if(can(user,'*'))return access.scopeIds(db,p);
 const positions=access.positions(db),config=access.config(db,user.id),assignments=config?.assignments||db.queryAll('SELECT position_id FROM user_positions WHERE user_id=?',[user.id]).map(a=>({...a,mode:'stores',store_ids:user.store_id?[Number(user.store_id)]:[],region_ids:[]}));
 if(p.audience_mode==='all')p={...p,position_ids:positions.filter(r=>r.enabled&&r.channels.includes('mini')).map(r=>r.id)};
 return access.intersect(access.scopeIds(db,p),access.union(assignments.filter(a=>p.position_ids.includes(a.position_id)).map(a=>{const role=positions.find(p=>p.id===a.position_id);return role?.enabled&&role.channels.includes('mini')&&(role.permissions.includes('*')||role.permissions.includes('learning.view'))?access.union([access.intersect(access.scopeIds(db,a),access.scopeIds(db,role)),context.supportIds(db,user)]):[]})));
}
function archive(db,id,body,user,restore=false){
 requireRight(user,'knowledge.edit');const e=db.queryOne('SELECT * FROM kb_entries WHERE id=?',[Number(id)]);if(!e)fail('资料不存在',404);
 if(Number(body.revision)!==e.revision)fail('资料已被更新，请刷新后重试',409);
 if(restore?e.status!=='deleted':e.status==='deleted')fail('资料状态已变，请刷新',409);
 if(!restore&&e.published_version)requireRight(user,'knowledge.publish');
 return transaction(db,()=>{const status=restore?(e.published_version?'hidden':'draft'):'deleted';db.run('UPDATE kb_entries SET status=?,revision=revision+1,updated_at=? WHERE id=?',[status,now(),e.id]);log(db,e.id,user,restore?'restore':'archive',{previous_status:e.status,status});return {status}});
}
function saveCategory(db,body,user){
 requireRight(user,'knowledge.edit');const id=Number(body.id)||0,old=id?db.queryOne('SELECT * FROM kb_categories WHERE id=?',[id]):null;
 if(id&&!old)fail('分类不存在',404);const name=String(body.name||'').trim(),order=body.sort_order===undefined?(old?.sort_order??999):Number(body.sort_order);
 if(!name||name.length>30)fail('分类名称为1至30字');if(!Number.isInteger(order)||order<0||order>999)fail('分类排序为0至999的整数');
 if(db.queryOne('SELECT id FROM kb_categories WHERE name=? AND id<>?',[name,id]))fail('分类名称重复',409);
 return transaction(db,()=>{const savedId=id||db.insert('INSERT INTO kb_categories(name,sort_order) VALUES(?,?)',[name,order]);if(id)db.run('UPDATE kb_categories SET name=?,sort_order=? WHERE id=?',[name,order,id]);log(db,null,user,'category.save',{id:savedId,before:old,after:{name,sort_order:order}});return {id:savedId}});
}
function deleteCategory(db,id,user){
 requireRight(user,'knowledge.edit');id=Number(id);const category=db.queryOne('SELECT * FROM kb_categories WHERE id=?',[id]);if(!category)fail('分类不存在',404);
 // Historical publications and recycled entries keep their original category.
 const referenced=db.queryAll('SELECT draft_json payload_json FROM kb_entries UNION ALL SELECT payload_json FROM kb_versions').some(r=>Number(parse(r.payload_json).category_id)===id);
 if(referenced)fail('此分类已有资料或历史版本，请保留该分类；可先新建分类调整后续资料',409);
 return transaction(db,()=>{db.run('DELETE FROM kb_categories WHERE id=?',[id]);log(db,null,user,'category.delete',{category});return {}});
}
function current(db,id){const e=db.queryOne('SELECT * FROM kb_entries WHERE id=?',[Number(id)]);if(!e||e.status!=='published')fail('资料未发布或已下架',404);const v=db.queryOne('SELECT * FROM kb_versions WHERE entry_id=? AND version=?',[e.id,e.published_version]);return {...v,id:e.id,payload:parse(v.payload_json)}}
function readable(db,id,store,user){requireRight(user,'learning.view');if(!Number.isInteger(Number(store))||!db.queryOne('SELECT id FROM stores WHERE id=?',[Number(store)]))fail('请选择门店');const v=current(db,id);if(!access.allows(miniScope(db,user,v.payload),Number(store)))fail('没有此资料阅读权限',403);return v}
function status(db,user,v){const r=db.queryOne('SELECT * FROM kb_reads WHERE user_id=? AND entry_id=? AND learning_cycle=?',[user.id,v.id,v.learning_cycle]);return {status:r?.learned_at?'learned':r?'read':'unread',record:r}}
function files(db,ids){return ids.map(id=>db.queryOne('SELECT id,name,ext,bytes,state,error FROM kb_files WHERE id=?',[id])).filter(Boolean)}
function detail(db,id,store,user){const v=readable(db,id,store,user);return {...v.payload,id:v.id,version:v.version,learning_cycle:v.learning_cycle,published_at:v.published_at,cover:coverFile(db,v.payload),files:files(db,v.payload.file_ids),...status(db,user,v)}}
function coverFile(db,payload){const file=payload.cover_file_id&&db.queryOne('SELECT id,name,ext,bytes,state FROM kb_files WHERE id=?',[payload.cover_file_id]);return file?{...file,lesson_cover:true}:null}
function list(db,query,user){requireRight(user,'learning.view');const store=Number(query.store_id);if(!db.queryOne('SELECT id FROM stores WHERE id=?',[store]))fail('请选择门店');const rows=db.queryAll("SELECT id FROM kb_entries WHERE status='published' ORDER BY updated_at DESC").map(e=>current(db,e.id)).filter(v=>access.allows(miniScope(db,user,v.payload),store)).map(v=>({...v.payload,content:undefined,file_ids:undefined,id:v.id,version:v.version,published_at:v.published_at,...status(db,user,v)}));return rows.filter(r=>(String(query.featured)!=='1'||r.home_featured===true)&&(!query.category_id||r.category_id===Number(query.category_id))&&(!query.q||[r.title,r.summary,r.topic].join(' ').toLowerCase().includes(String(query.q).toLowerCase()))&&(!query.status||r.status===query.status)).sort((a,b)=>String(query.featured)==='1'?(a.home_order??100)-(b.home_order??100)||(Date.parse(b.published_at)-Date.parse(a.published_at))||b.id-a.id:0)}
function read(db,id,body,user,learn=false){const v=readable(db,id,body.store_id,user);if(Number(body.version)!==v.version)fail('资料已更新，请重新打开最新版',409);const s=status(db,user,v);if(learn&&!s.record)fail('请先查看资料再确认学习');return transaction(db,()=>{const time=now();db.run('INSERT INTO kb_reads VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,entry_id,learning_cycle) DO UPDATE SET last_read_at=excluded.last_read_at,store_id=CASE WHEN kb_reads.learned_at IS NULL THEN excluded.store_id ELSE kb_reads.store_id END,last_version=excluded.last_version,learned_at=COALESCE(kb_reads.learned_at,excluded.learned_at)',[user.id,v.id,v.learning_cycle,s.record?.first_read_at||time,time,learn?time:null,Number(body.store_id),v.version]);log(db,v.id,user,learn?'learn':'read',{version:v.version,store_id:Number(body.store_id)});return status(db,user,v)})}
function adminList(db,user){requireRight(user,'knowledge.edit');return db.queryAll('SELECT * FROM kb_entries ORDER BY updated_at DESC').map(e=>({...e,draft_json:undefined,...parse(e.draft_json),files:files(db,parse(e.draft_json).file_ids),cover:coverFile(db,parse(e.draft_json)),has_draft:e.published_version?JSON.stringify(parse(e.draft_json))!==db.queryOne('SELECT payload_json FROM kb_versions WHERE entry_id=? AND version=?',[e.id,e.published_version])?.payload_json:true}))}
function report(db,id,user){requireRight(user,'knowledge.edit');const v=current(db,id),stores=db.queryAll('SELECT id,store_name FROM stores');return db.queryAll('SELECT * FROM users').map(r=>up.enrich(db,r,'mini')).map(u=>({u,scope:miniScope(db,u,v.payload)})).filter(({u,scope})=>scope===null||scope.length||status(db,u,v).record).map(({u,scope})=>{const state=status(db,u,v),employee=context.employee(db,u);return {id:u.id,name:u.display_name||u.username,positions:u.position_names,employment_status:employee?.status||'未关联档案',home_store_name:employee?.store_name||stores.find(s=>s.id===employee?.store_id)?.store_name||'',learning_store_name:stores.find(s=>s.id===state.record?.store_id)?.store_name||'',stores:stores.filter(s=>access.allows(scope,s.id)),...state}})}
module.exports={initialize,initialGrants,requireRight,save,publish,hide,archive,saveCategory,deleteCategory,miniScope,current,readable,status,detail,list,read,adminList,report,files,coverFile};
