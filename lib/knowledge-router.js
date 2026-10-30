'use strict';
const express=require('express'),fs=require('fs'),path=require('path'),crypto=require('crypto'),{execFile}=require('child_process'),kb=require('./knowledge-base'),access=require('./personnel-access');
const extensions=['doc','docx','ppt','pptx','xls','xlsx','pdf','txt','jpg','jpeg','png','webp'],max=50*1024*1024;
function createRouter({db,authenticate,channel='web',dir=path.join(__dirname,'../data/knowledge-files')}){
 const router=express.Router();router.use(authenticate);fs.mkdirSync(dir,{recursive:true});
 let resumed=false;
 router.use((req,res,next)=>{if(channel==='web'&&!resumed){resumed=true;try{for(const f of db.queryAll("SELECT * FROM kb_files WHERE state='processing'")){const folder=path.join(dir,f.id);if(fs.existsSync(path.join(folder,'original.'+f.ext)))queue(f.id,path.join(folder,'original.'+f.ext),folder,f.ext)}}catch(e){resumed=false;return res.status(500).json({error:'知识库尚未就绪'})}}next()});
 const wrap=fn=>async(req,res)=>{try{const result=await fn(req,res);if(!res.headersSent)res.json({ok:true,...result})}catch(e){res.status(e.status||500).json({error:e.status?e.message:'知识库操作失败，请重试'})}};
 const edit=u=>kb.requireRight(u,'knowledge.edit');
 router.get('/config',wrap(req=>{
  const user=req.knowledgeUser;if(channel==='web')edit(user);else kb.requireRight(user,'learning.view');
  const scope=channel==='web'?null:kb.miniScope(db,user,{mode:'all',position_ids:access.positions(db).map(p=>p.id)});
  return {regions:channel==='web'?db.queryAll('SELECT id,name,parent_id FROM store_regions'):[],permissions:user.position_permissions,categories:db.queryAll('SELECT * FROM kb_categories ORDER BY sort_order,id'),positions:channel==='web'?access.positions(db).filter(p=>p.enabled&&p.channels.includes('mini')).map(p=>({id:p.id,name:p.name})):[],stores:db.queryAll('SELECT id,store_name FROM stores').filter(s=>access.allows(scope,s.id))};
 }));
 if(channel==='web'){
  router.get('/banners',wrap(req=>{edit(req.knowledgeUser);return {rows:require('./knowledge-banners').rows(db)}}));
  router.post('/banners',wrap(req=>require('./knowledge-banners').save(db,req.body,req.knowledgeUser)));
  router.get('/entries',wrap(req=>({rows:kb.adminList(db,req.knowledgeUser)})));
  router.post('/entries',wrap(req=>kb.save(db,req.body,req.knowledgeUser)));
  router.post('/entries/:id/publish',wrap(req=>kb.publish(db,req.params.id,req.body,req.knowledgeUser)));
  router.post('/entries/:id/hide',wrap(req=>kb.hide(db,req.params.id,req.body,req.knowledgeUser)));
  router.post('/entries/:id/archive',wrap(req=>kb.archive(db,req.params.id,req.body,req.knowledgeUser)));
  router.post('/entries/:id/restore',wrap(req=>kb.archive(db,req.params.id,req.body,req.knowledgeUser,true)));
  router.get('/entries/:id/report',wrap(req=>({rows:kb.report(db,req.params.id,req.knowledgeUser)})));
  router.get('/entries/:id/versions',wrap(req=>{edit(req.knowledgeUser);return {rows:db.queryAll('SELECT version,published_at,published_by,learning_cycle,payload_json FROM kb_versions WHERE entry_id=? ORDER BY version DESC',[Number(req.params.id)]).map(v=>({...v,payload:JSON.parse(v.payload_json),payload_json:undefined}))}}));
  router.post('/categories',wrap(req=>kb.saveCategory(db,req.body,req.knowledgeUser)));
  router.post('/categories/:id/delete',wrap(req=>kb.deleteCategory(db,req.params.id,req.knowledgeUser)));
  // Authentication and permission validation precede the binary body parser.
  router.post('/files',(req,res,next)=>{try{edit(req.knowledgeUser);next()}catch(e){res.status(403).json({error:e.message})}},express.raw({type:'application/octet-stream',limit:max}),wrap(req=>{
   const name=String(req.query.name||'').split(/[\\/]/).pop(),ext=name.split('.').pop().toLowerCase(),buffer=req.body;
   if(!extensions.includes(ext)||!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>max||name.length>180)throw Object.assign(new Error('支持Word、PPT、Excel、PDF、文字及图片，单份最多50MB'),{status:400});
   const zipped=['docx','pptx','xlsx'].includes(ext),ole=['doc','ppt','xls'].includes(ext);
   if(zipped&&buffer.subarray(0,2).toString()!=='PK'||ole&&!buffer.subarray(0,8).equals(Buffer.from('d0cf11e0a1b11ae1','hex'))||ext==='pdf'&&buffer.subarray(0,5).toString()!=='%PDF-')throw Object.assign(new Error('文件内容与扩展名不一致'),{status:400});
   const id=crypto.randomUUID(),folder=path.join(dir,id);fs.mkdirSync(folder);const file=path.join(folder,'original.'+ext);fs.writeFileSync(file,buffer,{flag:'wx',mode:0o600});
   db.run('INSERT INTO kb_files VALUES(?,?,?,?,?,?,?,?,?,?)',[id,req.knowledgeUser.id,name,ext,buffer.length,crypto.createHash('sha256').update(buffer).digest('hex'),'processing',null,null,new Date().toISOString()]);db.save();queue(id,file,folder,ext);return {file:{id,name,ext,bytes:buffer.length,state:'processing'}};
  }));
 }
 else{
  router.get('/entries/:id/cover/chunk',wrap(req=>{
   const v=kb.readable(db,req.params.id,req.query.store_id,req.knowledgeUser);if(Number(req.query.version)!==v.version)throw Object.assign(new Error('教案已更新，请刷新'),{status:409});
   const f=kb.coverFile(db,v.payload);if(!f)throw Object.assign(new Error('教案尚未设置封面'),{status:404});const folder=path.join(dir,f.id),small=path.join(folder,'cover-thumbnail.jpg'),filename=fs.existsSync(small)?small:path.join(folder,'preview-0.jpg');if(!fs.existsSync(filename))throw Object.assign(new Error('封面预览正在生成'),{status:409});
   const bytes=fs.statSync(filename).size,index=Number(req.query.index||0),size=36*1024,total=Math.ceil(bytes/size);if(!Number.isInteger(index)||index<0||index>=total)throw Object.assign(new Error('无效分块'),{status:400});const buf=Buffer.alloc(Math.min(size,bytes-index*size)),fd=fs.openSync(filename,'r');try{fs.readSync(fd,buf,0,buf.length,index*size)}finally{fs.closeSync(fd)}return {chunk:buf.toString('base64'),index,total,bytes,ext:'jpg',name:f.name};
  }));
  router.get('/banners',wrap(req=>({rows:require('./knowledge-banners').list(db,Number(req.query.store_id),req.knowledgeUser)})));
  router.get('/banners/:id/chunk',wrap(req=>{
   const f=require('./knowledge-banners').file(db,req.params.id,Number(req.query.store_id),req.knowledgeUser);if(!f)throw Object.assign(new Error('横幅图片不存在'),{status:404});
   const thumbnail=path.join(dir,f.id,'preview-0.jpg');if(!fs.existsSync(thumbnail))throw Object.assign(new Error('横幅预览正在生成，请稍后刷新'),{status:409});const filename=thumbnail,ext='jpg';
   const bytes=fs.statSync(filename).size,index=Number(req.query.index||0),size=36*1024,total=Math.ceil(bytes/size);if(!Number.isInteger(index)||index<0||index>=total)throw Object.assign(new Error('无效分块'),{status:400});
   const buf=Buffer.alloc(Math.min(size,bytes-index*size)),fd=fs.openSync(filename,'r');try{fs.readSync(fd,buf,0,buf.length,index*size)}finally{fs.closeSync(fd)}return {chunk:buf.toString('base64'),index,total,bytes,ext,name:f.name};
  }));
  router.get('/entries',wrap(req=>{const rows=kb.list(db,req.query,req.knowledgeUser),page=Math.max(1,Number(req.query.page)||1);return {total:rows.length,page,rows:rows.slice((page-1)*20,page*20).map(r=>({id:r.id,title:r.title,summary:r.summary,topic:r.topic,kind:r.kind,category_id:r.category_id,version:r.version,published_at:r.published_at,status:r.status,home_featured:r.home_featured===true,home_order:r.home_order??100,cover:kb.coverFile(db,r)}))}}));
  router.get('/entries/:id',wrap(req=>({entry:kb.detail(db,req.params.id,req.query.store_id,req.knowledgeUser)})));
  router.post('/entries/:id/read',wrap(req=>kb.read(db,req.params.id,req.body,req.knowledgeUser)));
  router.post('/entries/:id/learn',wrap(req=>kb.read(db,req.params.id,req.body,req.knowledgeUser,true)));
 }
 function fileAccess(req){const id=req.params.file,record=db.queryOne('SELECT * FROM kb_files WHERE id=?',[id]);if(!record)throw Object.assign(new Error('附件不存在'),{status:404});if(channel==='web'){edit(req.knowledgeUser)}else{const v=kb.readable(db,req.params.id,req.query.store_id,req.knowledgeUser);if(!v.payload.file_ids.includes(id))throw Object.assign(new Error('附件不属于此资料'),{status:403});if(Number(req.query.version)!==v.version)throw Object.assign(new Error('资料已更新，请重新打开'),{status:409})}return record}
 const fileRoute=channel==='web'?'/files/:file':'/entries/:id/files/:file';
 router.get(fileRoute+'/preview',wrap(req=>{const f=fileAccess(req),preview=f.preview_json?JSON.parse(f.preview_json):{pages:[],images:[],note:f.error||'正在整理资料，请稍后刷新'};const index=Number(req.query.page||0);if(!Number.isInteger(index)||index<0)throw Object.assign(new Error('无效页码'),{status:400});return {state:f.state,error:f.error,note:preview.note,total:preview.pages.length,images:preview.images.length,layout:preview.layout||null,page:preview.pages[index]||null}}));
 router.get(fileRoute+'/chunk',wrap(req=>{const f=fileAccess(req);let filename=path.join(dir,f.id,'original.'+f.ext),ext=f.ext;
  if(req.query.media!==undefined){const preview=f.preview_json?JSON.parse(f.preview_json):{},media=Number(req.query.media);if(!Number.isInteger(media)||media<0||!preview.images?.[media])throw Object.assign(new Error('图片不存在'),{status:404});filename=path.join(dir,f.id,preview.images[media]);ext='jpg'}
  const bytes=fs.statSync(filename).size,index=Number(req.query.index||0),size=36*1024,total=Math.ceil(bytes/size);if(!Number.isInteger(index)||index<0||index>=total)throw Object.assign(new Error('无效分块'),{status:400});const buf=Buffer.alloc(Math.min(size,bytes-index*size)),fd=fs.openSync(filename,'r');try{fs.readSync(fd,buf,0,buf.length,index*size)}finally{fs.closeSync(fd)}return {chunk:buf.toString('base64'),index,total,bytes,ext,name:f.name};
 }));
 let running=false;const pending=[];
 function queue(id,file,folder,ext){pending.push({id,file,folder,ext});tick()}
 function tick(){if(running||!pending.length)return;running=true;const p=pending.shift();execFile(process.execPath,['--max-old-space-size=192',path.join(__dirname,'knowledge-preview-worker.js'),p.file,p.folder,p.ext],{windowsHide:true,timeout:180000,maxBuffer:1024*1024},(error)=>{try{const preview=!error?fs.readFileSync(path.join(p.folder,'preview.json'),'utf8'):null;db.run('UPDATE kb_files SET state=?,preview_json=?,error=? WHERE id=?',[error?'failed':'ready',preview,error?'自动预览未完成，可查看原文件或上传PDF版本':null,p.id]);db.save()}catch(e){console.warn('[knowledge] preview save failed',e.message)}finally{running=false;tick()}})}
 // Resume interrupted conversions on restart, including uploads retained in drafts.
 return router;
}
module.exports={createRouter};
