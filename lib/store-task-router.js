'use strict';
const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const service = require('./store-tasks');
function createRouter({ db, authenticate, scopeFor, channel='web', uploadDir = path.join(__dirname, '../data/store-task-files') }) {
  const router = express.Router();
  const duty=require('./store-task-duty');
  const photoTransfers = require('./store-task-photo-transfer').createTransfers(uploadDir);
  router.use(authenticate);
  router.use((req, res, next) => {
    try {
      const taskRights=['store-tasks.manage','store-tasks.execute','store-tasks.review',...(channel==='mini'?[duty.ASSIGN]:[])];
      if (!taskRights.some(p => service.permitted(req.taskUser, p))) throw Object.assign(new Error('没有门店任务权限'), { status: 403 });
      if(req.path.startsWith('/duty')&&channel!=='mini')throw Object.assign(new Error('当班安排仅支持小程序'),{status:403});
      const permission=req.path.startsWith('/duty/candidates')||req.path==='/duty/assign'?duty.ASSIGN:req.path.includes('/review')?'store-tasks.review':req.method!=='GET'&&(/\/(answer|photo)(\/|$)/.test(req.path))?'store-tasks.execute':req.path.startsWith('/dispatch')||req.path.startsWith('/templates')||req.path.startsWith('/schedules')||req.path.startsWith('/guide-images')?'store-tasks.manage':null;
      req.taskScope=permission?scopeFor(req.taskUser,permission):require('./personnel-access').union(taskRights.filter(p=>service.permitted(req.taskUser,p)).map(p=>{const s=scopeFor(req.taskUser,p);return s===null?null:Array.isArray(s)?s:[s]}));
      // 未绑定门店的执行人员不得因历史范围推断而获得所有门店。
      if (!req.taskUser.access_configured && req.taskScope === null && !service.permitted(req.taskUser,'store-tasks.manage') && !service.permitted(req.taskUser,'store-tasks.review')) req.taskScope = -1;
      next();
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  const route = fn => async (req, res) => { try { res.json({ ok: true, ...await fn(req) }); } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : '门店任务服务异常' }); } };
  router.get('/duty',route(req=>{const store=Number(req.query.store_id),day=duty.date(req.query.business_date);service.scopeCheck(req.taskScope,store);return {duty:duty.state(db,store,day,req.taskUser),history:duty.history(db,store,day)};}));
  router.get('/duty/candidates',route(req=>{const roster=duty.candidateRoster(db,Number(req.query.store_id),req.taskUser,req.query.business_date||duty.today());return {members:roster.filter(p=>p.can_select),unavailable_members:roster.filter(p=>!p.can_select)};}));
  router.post('/duty/assign',route(req=>({duty:duty.assign(db,req.body,req.taskUser)})));
  router.post('/duty/confirm',route(req=>({duty:duty.confirm(db,req.body,req.taskUser)})));
  router.get('/config', route(req => {const f=require('./personnel-access').sqlScope(req.taskScope,'id');return {user_id:req.taskUser.id,seed:service.seed,stores:db.queryAll(`SELECT id,store_name FROM stores WHERE ${f.sql} ORDER BY store_name`,f.params),permissions:req.taskUser.position_permissions}}));
  router.get('/templates', route(req => { service.requirePermission(req.taskUser, 'store-tasks.manage'); return { templates: service.templates(db) }; }));
  router.get('/templates/store-summary',route(req=>({rows:require('./store-task-members').summary(db,req.taskUser,req.taskScope)})));
  router.get('/templates/:id/stores',route(req=>({rows:require('./store-task-members').list(db,req.params.id,req.taskUser,req.taskScope)})));
  router.post('/templates/:id/stores/:storeId/remove',route(req=>require('./store-task-members').remove(db,req.params.id,req.params.storeId,req.taskUser,req.taskScope)));
  router.post('/templates', route(req => service.saveTemplate(db, req.body, req.taskUser)));
  router.post('/dispatch', route(req => service.dispatch(db, req.body, req.taskUser, req.taskScope)));
  router.get('/schedules', route(req => ({rows:service.schedules(db,req.taskUser,req.taskScope)})));
  router.post('/schedules/:id/stop', route(req => service.stopSchedule(db,req.params.id,req.taskUser,req.taskScope)));
  router.get('/instances', route(req => {const cache=new Map();return {rows:service.list(db,req.query,req.taskScope).map(task=>{const day=task.task_kind==='windowed'||task.execution?.reopened?duty.today():task.business_date,key=task.store_id+':'+day;if(!cache.has(key))cache.set(key,duty.state(db,task.store_id,day,req.taskUser));return {...task,responsibility:cache.get(key),awaiting_submit:task.execution?.can_edit&&task.ready_to_submit};})};}));
  router.get('/submissions', route(req => service.submissionList(db,req.query,req.taskScope)));
  router.get('/submissions/:id', route(req => ({record:service.submissionDetail(db,req.params.id,req.taskScope)})));
  router.post('/guide-images', route(req=>{
    service.requirePermission(req.taskUser,'store-tasks.manage');
    const match=String(req.body.data||'').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if(!match||match[2].length>5600000)throw Object.assign(new Error('说明图片仅支持4MB以内的JPEG、PNG、WebP'),{status:400});
    const buffer=Buffer.from(match[2],'base64');
    const mime=buffer.subarray(0,3).equals(Buffer.from([255,216,255]))?'jpeg':buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP'?'webp':null;
    if(!mime||buffer.length>4*1024*1024)throw Object.assign(new Error('说明图片内容无效或过大'),{status:400});
    const name=crypto.randomUUID()+'.'+(mime==='jpeg'?'jpg':mime),reference='/uploads/store-tasks/guides/'+name,dir=path.join(uploadDir,'guides');
    fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,name),buffer,{flag:'wx',mode:0o600});
    try{db.insert('INSERT INTO store_task_guide_files(path,user_id,mime,created_at) VALUES(?,?,?,?)',[reference,req.taskUser.id,mime,new Date().toISOString()]);db.save()}catch(e){fs.unlinkSync(path.join(dir,name));throw e}
    return {path:reference};
  }));
  router.get('/instances/:id', route(req => {const task=service.detail(db,req.params.id,req.taskScope),day=task.task_kind==='windowed'||task.execution?.reopened?duty.today():task.business_date;return {task:{...task,responsibility:duty.state(db,task.store_id,day,req.taskUser)}};}));
  router.post('/instances/:id/answer', route(req => service.writeAnswer(db, req.params.id, req.body, req.taskUser, req.taskScope)));
  router.post('/instances/:id/submit', route(req => service.submit(db, req.params.id, req.body, req.taskUser, req.taskScope)));
  router.post('/instances/:id/review', route(req => service.review(db, req.params.id, req.body, req.taskUser, req.taskScope)));
  router.post('/instances/:id/reopen', route(req => service.reopen(db, req.params.id, req.body, req.taskUser, req.taskScope)));
  function writablePhotoTask(req) {
    service.requirePermission(req.taskUser, 'store-tasks.execute');
    const task = service.detail(db, req.params.id, req.taskScope);
    service.requireExecutable(db,task);
    return task;
  }
  router.post('/instances/:id/photo/start', route(req => {
    const task = writablePhotoTask(req);
    return photoTransfers.start(req.body, req.taskUser.id, task.id);
  }));
  router.post('/instances/:id/photo/chunk', route(req => {
    const task = writablePhotoTask(req);
    return photoTransfers.chunk(req.body, req.taskUser.id, task.id);
  }));
  router.post('/instances/:id/photo', route(async req => {
    const task = writablePhotoTask(req);
    if(req.body.upload_id){
      const uploadId=String(req.body.upload_id);
      if(!/^[a-f0-9-]{36}$/.test(uploadId))throw Object.assign(new Error('无效图片上传编号'),{status:400});
      const existing=db.queryOne('SELECT * FROM store_task_files WHERE task_id=? AND user_id=? AND path IN (?,?,?)',[task.id,req.taskUser.id,...['jpg','png','webp'].map(ext=>'/uploads/store-tasks/'+uploadId+'.'+ext)]);
      if(existing)return {path:existing.path}; // Final response can be lost; retries do not duplicate evidence.
      fs.mkdirSync(uploadDir,{recursive:true});
      const temporary=path.join(uploadDir,uploadId+'.part');
      if(fs.existsSync(temporary))throw Object.assign(new Error('图片正在保存，请稍后重试'),{status:409});
      const info=photoTransfers.writeTo(uploadId,req.taskUser.id,task.id,temporary);
      let finalFile;
      try{
        const fd=fs.openSync(temporary,'r'),head=Buffer.alloc(12);try{fs.readSync(fd,head,0,12,0)}finally{fs.closeSync(fd)}
        if(detectMime(head)!==info.mime)throw Object.assign(new Error('照片格式无效'),{status:400});
        // Validate/decode only the preview; preserve every original byte and EXIF.
        await require('./store-task-photo-preview').preview(temporary);
        const filename=uploadId+'.'+(info.mime==='jpeg'?'jpg':info.mime),reference='/uploads/store-tasks/'+filename;
        finalFile=path.join(uploadDir,filename);fs.renameSync(temporary,finalFile);
        fs.renameSync(path.join(uploadDir,'.previews',uploadId+'.part.jpg'),path.join(uploadDir,'.previews',filename+'.jpg'));
        db.insert('INSERT INTO store_task_files (path,task_id,user_id,mime,created_at) VALUES (?,?,?,?,?)',[reference,task.id,req.taskUser.id,info.mime,new Date().toISOString()]);db.save();
        try{photoTransfers.remove(uploadId)}catch(e){console.warn('[task-photo] transfer cleanup pending',e.code||'cleanup')};return {path:reference};
      }catch(e){for(const file of [temporary,finalFile,finalFile&&path.join(uploadDir,'.previews',path.basename(finalFile)+'.jpg'),path.join(uploadDir,'.previews',uploadId+'.part.jpg')])if(file&&fs.existsSync(file))fs.unlinkSync(file);throw e}
    }
    const input = req.body.data;
    const match = String(input || '').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!match || match[2].length > 5600000) throw Object.assign(new Error('仅支持4MB以内的JPEG、PNG、WebP图片'), {status:400});
    const buffer = Buffer.from(match[2], 'base64');
    const mime = buffer.subarray(0, 3).equals(Buffer.from([255,216,255])) ? 'jpeg' : buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png' : buffer.subarray(0,4).toString() === 'RIFF' && buffer.subarray(8,12).toString() === 'WEBP' ? 'webp' : null;
    if (!mime || buffer.length > 4 * 1024 * 1024) throw Object.assign(new Error('图片内容无效或过大'), {status:400});
    const filename = crypto.randomUUID() + '.' + (mime === 'jpeg' ? 'jpg' : mime), reference = '/uploads/store-tasks/' + filename;
    fs.mkdirSync(uploadDir, {recursive:true}); fs.writeFileSync(path.join(uploadDir, filename), buffer, { flag:'wx', mode:0o600 });
    try { db.insert('INSERT INTO store_task_files (path,task_id,user_id,mime,created_at) VALUES (?,?,?,?,?)',[reference,task.id,req.taskUser.id,mime,new Date().toISOString()]); db.save(); }
    catch(e) { fs.unlinkSync(path.join(uploadDir,filename)); throw e; }
    return {path:reference};
  }));
  router.get('/photo', route(req => {
    const reference=String(req.query.path||'');
    if(reference.startsWith('/uploads/store-tasks/guides/')){
      const guide=db.queryOne('SELECT * FROM store_task_guide_files WHERE path=?',[reference]);
      if(!guide)throw Object.assign(new Error('说明图片不存在'),{status:404});
      const scope=require('./personnel-access').sqlScope(req.taskScope,'store_id');
      if(!service.permitted(req.taskUser,'store-tasks.manage')&&!db.queryOne(`SELECT id FROM store_task_instances WHERE instr(questions_json,?)>0 AND ${scope.sql}`,[reference,...scope.params]))throw Object.assign(new Error('无权查看此说明图片'),{status:403});
      return photoResponse(req, guide.mime, path.join(uploadDir,'guides',path.basename(reference)));
    }
    const file = db.queryOne('SELECT * FROM store_task_files WHERE path=?',[String(req.query.path || '')]);
    if (!file) throw Object.assign(new Error('图片不存在'),{status:404});
    service.detail(db,file.task_id,req.taskScope);
    return photoResponse(req, file.mime, path.join(uploadDir,path.basename(file.path)));
  }));
  return router;
}
function detectMime(head){return head.subarray(0,3).equals(Buffer.from([255,216,255]))?'jpeg':head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':head.subarray(0,4).toString()==='RIFF'&&head.subarray(8,12).toString()==='WEBP'?'webp':null}
async function photoResponse(req, mime, file) {
  if(req.query.variant==='thumb'){file=await require('./store-task-photo-preview').preview(file);mime='jpeg'}
  else if(req.query.variant&&req.query.variant!=='original')throw Object.assign(new Error('图片版本无效'),{status:400});
  const bytes=fs.statSync(file).size;
  if(req.query.chunk===undefined)return {data:'data:image/'+mime+';base64,'+fs.readFileSync(file).toString('base64'),bytes};
  // Read one binary segment, not the entire original for every request.
  const index=Number(req.query.chunk),rawLength=144*1024,total=Math.ceil(bytes/rawLength);
  if(!Number.isInteger(index)||index<0||index>=total)throw Object.assign(new Error('图片分段编号无效'),{status:400});
  const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(Math.min(rawLength,bytes-index*rawLength));
  try{fs.readSync(fd,buffer,0,buffer.length,index*rawLength)}finally{fs.closeSync(fd)}
  return {mime,total,index,bytes,chunk:buffer.toString('base64')};
}
module.exports = { createRouter, photoResponse };
