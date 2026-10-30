'use strict';
const kb=require('./knowledge-base'),access=require('./personnel-access');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
function initialize(db){db.run('CREATE TABLE IF NOT EXISTS kb_banners(id INTEGER PRIMARY KEY AUTOINCREMENT,payload_json TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL)')}
function rows(db){return db.queryAll('SELECT * FROM kb_banners ORDER BY id DESC').map(r=>({...JSON.parse(r.payload_json),id:r.id,revision:r.revision,updated_at:r.updated_at})).sort((a,b)=>a.sort_order-b.sort_order||b.id-a.id)}
function save(db,body,user){
 kb.requireRight(user,'knowledge.edit');const old=body.id?rows(db).find(r=>r.id===Number(body.id)):null;if(body.id&&!old)fail('横幅不存在',404);if(old&&Number(body.revision)!==old.revision)fail('横幅已更新，请刷新',409);
 const title=String(body.title||'').trim(),subtitle=String(body.subtitle||'').trim(),file=db.queryOne('SELECT * FROM kb_files WHERE id=?',[body.file_id]);
 if(!title||title.length>60||subtitle.length>120)fail('请填写标题（最多60字），简介最多120字');
 if(!file||!['png','jpg','jpeg','webp'].includes(file.ext)||file.bytes>5*1024*1024)fail('请上传不超过5MB的JPG、PNG或WebP横幅');
 if(!(user.position_permissions||[]).includes('*')&&file.user_id!==user.id&&old?.file_id!==file.id)fail('无权使用此图片',403);
 const enabled=!!body.enabled;if(enabled){kb.requireRight(user,'knowledge.publish');if(file.state!=='ready')fail('横幅图片预览尚未完成，请稍后保存')}
 const entry_id=body.entry_id?Number(body.entry_id):null;if(entry_id)kb.current(db,entry_id);
 const scope={mode:body.mode||'all',store_ids:body.store_ids||[],region_ids:[]};if(!['all','stores'].includes(scope.mode)||!Array.isArray(scope.store_ids)||scope.store_ids.some(id=>!Number.isInteger(id)||!db.queryOne('SELECT id FROM stores WHERE id=?',[id]))||scope.mode==='stores'&&!scope.store_ids.length)fail('请选择有效适用门店');
 const order=Number(body.sort_order||0);if(!Number.isInteger(order)||order<0||order>999)fail('排序应为0至999');if(enabled&&rows(db).filter(r=>r.enabled&&r.id!==old?.id).length>=5)fail('最多启用5张横幅');
 const next={title,subtitle,file_id:file.id,entry_id,enabled,sort_order:order,...scope};
 db.run('BEGIN');try{let id=old?.id;if(id)db.run('UPDATE kb_banners SET payload_json=?,revision=revision+1,updated_at=? WHERE id=?',[JSON.stringify(next),new Date().toISOString(),id]);else id=db.insert('INSERT INTO kb_banners(payload_json,updated_at) VALUES(?,?)',[JSON.stringify(next),new Date().toISOString()]);db.insert('INSERT INTO kb_logs(entry_id,user_id,action,detail_json,created_at) VALUES(?,?,?,?,?)',[entry_id,user.id,'banner.save',JSON.stringify({id,before:old||null,after:next}),new Date().toISOString()]);db.run('COMMIT');db.save();return {id}}catch(e){db.run('ROLLBACK');throw e}
}
function visible(db,banner,store,user){
 if(!banner.enabled||!access.allows(access.scopeIds(db,banner),Number(store)))return false;
 if(!access.allows(kb.miniScope(db,user,{...banner,position_ids:access.positions(db).map(p=>p.id)}),Number(store)))return false;
 if(banner.entry_id){try{kb.readable(db,banner.entry_id,store,user)}catch(e){if([403,404].includes(e.status))return false;throw e}}
 return true;
}
function list(db,store,user){kb.requireRight(user,'learning.view');return rows(db).filter(b=>visible(db,b,store,user)).map(b=>{const f=db.queryOne('SELECT name,ext,bytes FROM kb_files WHERE id=?',[b.file_id]);return {id:b.id,title:b.title,subtitle:b.subtitle,entry_id:b.entry_id,revision:b.revision,file:{id:b.file_id,banner_id:b.id,...f}}})}
function file(db,id,store,user){const b=rows(db).find(b=>b.id===Number(id));kb.requireRight(user,'learning.view');if(!b||!visible(db,b,store,user))fail('无权查看此横幅',403);return db.queryOne('SELECT * FROM kb_files WHERE id=?',[b.file_id])}
module.exports={initialize,rows,save,list,file};
