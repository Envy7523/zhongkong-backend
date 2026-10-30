'use strict';
// Files cross the cloud channel in small requests; no image data is stored in SQLite.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const CHUNK_LENGTH = 48 * 1024;
const TTL = 60 * 60 * 1000;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

function createTransfers(uploadDir, now = Date.now) {
  const root = path.resolve(uploadDir, '.transfers');
  const sessions = new Map();
  // Restore ownership and expiry after a local/server restart; received chunks stay reusable.
  if(fs.existsSync(root))for(const entry of fs.readdirSync(root,{withFileTypes:true})){
    if(!entry.isDirectory()||!/^[a-f0-9-]{36}$/.test(entry.name))continue;
    try{const s=JSON.parse(fs.readFileSync(path.join(root,entry.name,'session.json'),'utf8'));if(s.expires>now()&&Number.isInteger(s.length)&&s.length>0&&s.length<=Math.ceil(MAX_IMAGE_BYTES/3)*4)sessions.set(entry.name,s)}catch{}
  }
  function remove(id) {
    const target = path.resolve(root, id);
    if (!/^[a-f0-9-]{36}$/.test(id) || path.dirname(target) !== root) fail('无效上传目录');
    fs.rmSync(target, { recursive: true, force: true });
    sessions.delete(id);
  }
  function cleanup() {
    for (const [id, session] of sessions) if (session.expires <= now()) remove(id);
    if (!fs.existsSync(root)) return;
    // A restart may leave unfinished transfers. Never touch completed task photos.
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name) || sessions.has(entry.name)) continue;
      if (now() - fs.statSync(path.join(root, entry.name)).mtimeMs > TTL) remove(entry.name);
    }
  }
  function get(id, userId, taskId) {
    cleanup();
    const session = sessions.get(String(id));
    if (!session || session.userId !== userId || session.taskId !== taskId) fail('图片上传已失效，请重新选择照片', 404);
    return session;
  }
  function start(body, userId, taskId) {
    cleanup();
    const length = Number(body.length), mime = String(body.mime || '');
    if (!['jpeg', 'png', 'webp'].includes(mime) || !Number.isInteger(length) || length <= 0 || length % 4 || length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) fail('单张照片最多50MB，支持JPEG、PNG、WebP');
    if (sessions.size >= 64 || [...sessions.values()].filter(s => s.userId === userId).length >= 2) fail('有照片正在上传，请稍后重试', 429);
    if ([...sessions.values()].reduce((n,s)=>n+s.length*3/4,0)+length*3/4>512*1024*1024) fail('图片上传繁忙，请稍后重试',429);
    const id = crypto.randomUUID();
    fs.mkdirSync(path.join(root, id), { recursive: true, mode: 0o700 });
    const session={ userId, taskId, length, mime, count: Math.ceil(length / CHUNK_LENGTH), expires: now() + TTL };
    sessions.set(id,session);fs.writeFileSync(path.join(root,id,'session.json'),JSON.stringify(session),{mode:0o600});
    return { upload_id: id, chunk_length: CHUNK_LENGTH };
  }
  function chunk(body, userId, taskId) {
    const s = get(body.upload_id, userId, taskId), index = Number(body.index), data = String(body.chunk || '');
    if (!Number.isInteger(index) || index < 0 || index >= s.count) fail('图片分段编号无效');
    const expected = Math.min(CHUNK_LENGTH, s.length - index * CHUNK_LENGTH);
    if (data.length !== expected || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || (index < s.count - 1 && data.includes('='))) fail('图片分段内容无效');
    const file = path.join(root, body.upload_id, String(index));
    if (fs.existsSync(file)) {
      if (!fs.readFileSync(file).equals(Buffer.from(data,'base64'))) fail('图片分段已存在且内容不同', 409);
    } else fs.writeFileSync(file, Buffer.from(data,'base64'), { flag: 'wx', mode: 0o600 });
    s.expires = now() + TTL;
    fs.writeFileSync(path.join(root,body.upload_id,'session.json'),JSON.stringify(s),{mode:0o600});
    return { received: index };
  }
  function read(id, userId, taskId) {
    const s = get(id, userId, taskId), chunks = [];
    for (let index = 0; index < s.count; index++) {
      const file = path.join(root, id, String(index));
      if (!fs.existsSync(file)) fail('图片尚未上传完整，请重新选择照片', 409);
      chunks.push(fs.readFileSync(file).toString('base64'));
    }
    const data = chunks.join('');
    if (data.length !== s.length || Buffer.from(data, 'base64').length > MAX_IMAGE_BYTES) fail('图片内容过大或不完整');
    return `data:image/${s.mime};base64,${data}`;
  }
  function writeTo(id,userId,taskId,destination) {
    const s=get(id,userId,taskId);
    for(let i=0;i<s.count;i++)if(!fs.existsSync(path.join(root,id,String(i))))fail('图片尚未上传完整，请重试',409);
    const fd=fs.openSync(destination,'wx',0o600);let size=0;
    try{for(let i=0;i<s.count;i++){const data=fs.readFileSync(path.join(root,id,String(i)));size+=data.length;fs.writeSync(fd,data)}
      if(size>MAX_IMAGE_BYTES||Math.ceil(size/3)*4!==s.length)fail('图片内容过大或不完整');
    }catch(e){fs.closeSync(fd);fs.unlinkSync(destination);throw e}
    fs.closeSync(fd);return {mime:s.mime,size};
  }
  function removeTask(taskId) {
    const ids = new Set([...sessions].filter(([, session]) => session.taskId === taskId).map(([id]) => id));
    if (fs.existsSync(root)) for (const entry of fs.readdirSync(root, {withFileTypes:true})) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      const file = path.join(root, entry.name, 'session.json');
      if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).taskId === taskId) ids.add(entry.name);
    }
    for (const id of ids) remove(id);
  }
  return { start, chunk, read, writeTo, remove, removeTask };
}
module.exports = { createTransfers, CHUNK_LENGTH, MAX_IMAGE_BYTES };
