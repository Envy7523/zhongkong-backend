'use strict';
const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const service = require('./store-tasks');
function createRouter({ db, authenticate, scopeFor, uploadDir = path.join(__dirname, '../data/store-task-files') }) {
  const router = express.Router();
  router.use(authenticate);
  router.use((req, res, next) => {
    try {
      if (!['store-tasks.manage', 'store-tasks.execute', 'store-tasks.review'].some(p => service.permitted(req.taskUser, p))) throw Object.assign(new Error('没有门店任务权限'), { status: 403 });
      req.taskScope = scopeFor(req.taskUser);
      // 未绑定门店的执行人员不得因历史范围推断而获得所有门店。
      if (req.taskScope === null && !service.permitted(req.taskUser,'store-tasks.manage') && !service.permitted(req.taskUser,'store-tasks.review')) req.taskScope = -1;
      next();
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  const route = fn => (req, res) => { try { res.json({ ok: true, ...fn(req) }); } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : '门店任务服务异常' }); } };
  router.get('/config', route(req => ({ user_id:req.taskUser.id, seed: service.seed, stores: db.queryAll('SELECT id,store_name FROM stores WHERE (? IS NULL OR id=?) ORDER BY store_name', [req.taskScope, req.taskScope]), permissions: req.taskUser.position_permissions })));
  router.get('/templates', route(req => { service.requirePermission(req.taskUser, 'store-tasks.manage'); return { templates: service.templates(db) }; }));
  router.post('/templates', route(req => service.saveTemplate(db, req.body, req.taskUser)));
  router.post('/dispatch', route(req => service.dispatch(db, req.body, req.taskUser, req.taskScope)));
  router.get('/schedules', route(req => ({rows:service.schedules(db,req.taskUser,req.taskScope)})));
  router.post('/schedules/:id/stop', route(req => service.stopSchedule(db,req.params.id,req.taskUser,req.taskScope)));
  router.get('/instances', route(req => ({ rows: service.list(db, req.query, req.taskScope) })));
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
  router.get('/instances/:id', route(req => ({ task: service.detail(db, req.params.id, req.taskScope) })));
  router.post('/instances/:id/answer', route(req => service.writeAnswer(db, req.params.id, req.body, req.taskUser, req.taskScope)));
  router.post('/instances/:id/submit', route(req => service.submit(db, req.params.id, req.body, req.taskUser, req.taskScope)));
  router.post('/instances/:id/review', route(req => service.review(db, req.params.id, req.body, req.taskUser, req.taskScope)));
  router.post('/instances/:id/photo', route(req => {
    service.requirePermission(req.taskUser, 'store-tasks.execute');
    const task = service.detail(db, req.params.id, req.taskScope);
    if (['pending','approved'].includes(task.status)) throw Object.assign(new Error('审核中的任务不能补充照片'), {status:409});
    const match = String(req.body.data || '').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
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
      if(!service.permitted(req.taskUser,'store-tasks.manage')&&!db.queryOne('SELECT id FROM store_task_instances WHERE instr(questions_json,?)>0 AND (? IS NULL OR store_id=?)',[reference,req.taskScope,req.taskScope]))throw Object.assign(new Error('无权查看此说明图片'),{status:403});
      return {data:'data:image/'+guide.mime+';base64,'+fs.readFileSync(path.join(uploadDir,'guides',path.basename(reference))).toString('base64')};
    }
    const file = db.queryOne('SELECT * FROM store_task_files WHERE path=?',[String(req.query.path || '')]);
    if (!file) throw Object.assign(new Error('图片不存在'),{status:404});
    service.detail(db,file.task_id,req.taskScope);
    return {data:'data:image/'+file.mime+';base64,'+fs.readFileSync(path.join(uploadDir,path.basename(file.path))).toString('base64')};
  }));
  return router;
}
module.exports = { createRouter };
