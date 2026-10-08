'use strict';
const crypto = require('crypto');
const now = () => new Date().toISOString();
const json = value => JSON.stringify(value);
const parse = value => JSON.parse(value);
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function date(value) {
  const parsed = new Date(value + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('日期不正确');
  return value;
}
function shift(value, days) { const d = new Date(value + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function ensureSchema(db) {
  db.run(`CREATE TABLE IF NOT EXISTS store_task_templates (id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',questions_json TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS store_task_instances (id INTEGER PRIMARY KEY AUTOINCREMENT,template_id INTEGER NOT NULL,template_version INTEGER NOT NULL,store_id INTEGER NOT NULL,business_date TEXT NOT NULL,due_at TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,questions_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',revision INTEGER NOT NULL DEFAULT 0,created_by INTEGER NOT NULL,created_at TEXT NOT NULL,UNIQUE(template_id,store_id,business_date))`);
  db.run(`CREATE TABLE IF NOT EXISTS store_task_answers (id INTEGER PRIMARY KEY AUTOINCREMENT,task_id INTEGER NOT NULL,question_id TEXT NOT NULL,user_id INTEGER NOT NULL,user_name TEXT NOT NULL,response_json TEXT NOT NULL,created_at TEXT NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS store_task_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT,task_id INTEGER NOT NULL,version INTEGER NOT NULL,snapshot_json TEXT NOT NULL,submitted_by INTEGER NOT NULL,submitted_name TEXT NOT NULL,submitted_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',reviewed_by INTEGER,reviewed_name TEXT,reviewed_at TEXT,review_note TEXT,UNIQUE(task_id,version))`);
  db.run(`CREATE TABLE IF NOT EXISTS store_task_files (path TEXT PRIMARY KEY,task_id INTEGER NOT NULL,user_id INTEGER NOT NULL,mime TEXT NOT NULL,created_at TEXT NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS store_task_guide_files (path TEXT PRIMARY KEY,user_id INTEGER NOT NULL,mime TEXT NOT NULL,created_at TEXT NOT NULL)`);
  db.run('CREATE INDEX IF NOT EXISTS idx_store_tasks_store_date ON store_task_instances(store_id,business_date)');
  db.run('CREATE INDEX IF NOT EXISTS idx_store_tasks_answers ON store_task_answers(task_id,question_id,user_id,id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_store_tasks_submissions ON store_task_submissions(task_id,version)');
  db.run(`CREATE TABLE IF NOT EXISTS store_task_schedules (id INTEGER PRIMARY KEY AUTOINCREMENT,template_id INTEGER NOT NULL,store_id INTEGER NOT NULL,template_version INTEGER NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,questions_json TEXT NOT NULL,frequency TEXT NOT NULL,start_date TEXT NOT NULL,next_date TEXT NOT NULL,due_time TEXT NOT NULL,created_by INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,stopped_at TEXT)`);
}
const seed = { title: '开早检查', description: '开早准备共同执行，按检查项提交证据，由审核人确认。门店名称自动显示，无需填写。', questions: [
  ...['煲例汤', '煲米饭', '柠檬茶茶底配置', '泡罗汉果茶', '补充自主小吃'].map((title, i) => ({ id: `opening-${i + 2}`, title, type: 'photo', required: true, min: 1, max: 1, description: '请上传该项开早准备的现场照片' })),
  { id: 'opening-7', title: '检查补充餐桌抽屉物品', description: '检查补充餐桌抽屉物品（一次性手套、牙签、纸巾、筷子）', type: 'choice', required: true, options: ['已完成', '未完成'] },
] };
function questions(input) {
  if (!Array.isArray(input) || !input.length || input.length > 60) fail('请设置1至60个问题');
  const ids = new Set();
  return input.map(item => {
    const q = { id: item.id || crypto.randomUUID(), title: String(item.title || '').trim(), description: String(item.description || '').trim(), type: item.type, required: item.required !== false };
    if (!/^[\w-]{1,80}$/.test(q.id) || ids.has(q.id)) fail('问题编号重复或不正确'); ids.add(q.id);
    if (!q.title || q.title.length > 100 || q.description.length > 500 || !['photo', 'text', 'choice', 'number', 'multiple', 'dropdown', 'date'].includes(q.type)) fail('问题内容不正确');
    if(item.execution_mode!=null){if(!['single','shared'].includes(item.execution_mode))fail('请选择单人完成或多人共同完成');q.execution_mode=item.execution_mode;}
    if(item.guide_images!=null){if(!Array.isArray(item.guide_images)||item.guide_images.length>3||item.guide_images.some(p=>typeof p!=='string'||!/^\/uploads\/store-tasks\/guides\/[\da-f-]{36}\.(jpg|png|webp)$/.test(p))||new Set(item.guide_images).size!==item.guide_images.length)fail('每题最多3张有效说明图片');q.guide_images=[...item.guide_images];}
    if (q.type === 'photo') {
      q.min = Number(item.min ?? 1); q.max = Number(item.max ?? 1);
      if (!Number.isInteger(q.min) || !Number.isInteger(q.max) || q.min < 0 || q.max < Math.max(q.min, 1) || q.max > 9) fail('照片数量需在0至9张内，最大值不能小于最小值');
    }
    if (['choice', 'dropdown', 'multiple'].includes(q.type)) { if (!Array.isArray(item.options)) fail('选项格式不正确'); q.options = [...new Set(item.options.map(v => String(v).trim()).filter(Boolean))]; if (q.options.length < 2 || q.options.length > 12 || q.options.some(v => v.length > 80)) fail('选择题需设置2至12个选项'); }
    if (q.type === 'text') {
      q.maxLength = Number(item.maxLength ?? 2000); q.multiline = item.multiline !== false; q.format = item.format || 'plain';
      if (!Number.isInteger(q.maxLength) || q.maxLength < 1 || q.maxLength > 2000 || !['plain', 'phone'].includes(q.format)) fail('文字长度或格式不正确');
    }
    if (q.type === 'number') {
      if (item.lower != null) q.lower = Number(item.lower); if (item.upper != null) q.upper = Number(item.upper);
      if (item.precision != null) q.precision = Number(item.precision);
      if (q.lower != null && !Number.isFinite(q.lower) || q.upper != null && !Number.isFinite(q.upper) || q.lower != null && q.upper != null && q.lower > q.upper || q.precision != null && (!Number.isInteger(q.precision) || q.precision < 0 || q.precision > 6)) fail('数字范围或小数位数不正确');
    }
    if (['text','number'].includes(q.type)) { q.placeholder = String(item.placeholder || '').slice(0, 200); }
    return q;
  });
}
function permitted(user, code) { return (user?.position_permissions || []).some(v => v === '*' || v === code); }
function requirePermission(user, code) { if (!user?.id) fail('请先登录', 401); if (!permitted(user, code)) fail('当前岗位没有门店任务权限', 403); }
function scopeCheck(scope, storeId) { if (scope !== null && Number(scope) !== Number(storeId)) fail('无权操作此门店任务', 403); }
function transaction(db, fn) { db.run('BEGIN'); try { const value = fn(); db.run('COMMIT'); db.save(); return value; } catch (e) { db.run('ROLLBACK'); throw e; } }
function templates(db) { return db.queryAll('SELECT * FROM store_task_templates ORDER BY id DESC').map(r => ({ ...r, questions: parse(r.questions_json), questions_json: undefined })); }
function saveTemplate(db, body, user) {
  requirePermission(user, 'store-tasks.manage');
  const title = String(body.title || '').trim(), description = String(body.description || '').trim();
  if (!title || title.length > 100 || description.length > 1000) fail('请填写有效项目名称和说明');
  const qs = questions(body.questions);
  for(const q of qs)for(const image of q.guide_images||[])if(!db.queryOne('SELECT path FROM store_task_guide_files WHERE path=?',[image]))fail('说明图片不存在，请重新上传');
  if (body.id) {
    const old = db.queryOne('SELECT * FROM store_task_templates WHERE id=?', [Number(body.id)]);
    if (!old) fail('项目不存在', 404);
    if (Number(body.version) !== old.version) fail('项目已被修改，请刷新后重试', 409);
    db.run('UPDATE store_task_templates SET title=?,description=?,questions_json=?,version=version+1,updated_at=? WHERE id=?', [title, description, json(qs), now(), old.id]);
    db.save(); return { id: old.id };
  }
  const id = db.insert('INSERT INTO store_task_templates (title,description,questions_json,updated_at) VALUES (?,?,?,?)', [title, description, json(qs), now()]); db.save(); return { id };
}
function dispatch(db, body, user, scope = null) {
  requirePermission(user, 'store-tasks.manage');
  const template = db.queryOne('SELECT * FROM store_task_templates WHERE id=?', [Number(body.template_id)]);
  if (!template) fail('项目不存在', 404);
  if (!Array.isArray(body.store_ids)) fail('请选择有效门店');
  const stores = [...new Set(body.store_ids.map(Number))];
  if (!stores.length || stores.length > 200 || stores.some(id => !Number.isInteger(id) || !db.queryOne('SELECT id FROM stores WHERE id=?', [id]))) fail('请选择有效门店');
  stores.forEach(id => scopeCheck(scope, id));
  const from = date(body.from), to = body.long_term === true ? from : date(body.to);
  if (from > to || (new Date(to) - new Date(from)) / 86400000 > 92) fail('下发范围最多93天，结束日不能早于开始日');
  if (!['once', 'daily', 'weekly', 'monthly'].includes(body.frequency) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.due_time || '')) fail('请选择周期和有效截止时间');
  if (body.long_term === true) {
    if (body.frequency === 'once') fail('单次任务不能长期生效');
    return transaction(db, () => {
      for (const store of stores) {
        if (db.queryOne('SELECT id FROM store_task_schedules WHERE template_id=? AND store_id=? AND active=1', [template.id, store])) fail('该门店已有此项目的长期计划，请先停用原计划');
        db.insert(`INSERT INTO store_task_schedules (template_id,store_id,template_version,title,description,questions_json,frequency,start_date,next_date,due_time,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [template.id,store,template.version,template.title,template.description,template.questions_json,body.frequency,from,from,body.due_time,user.id,now()]);
      }
      return { created:0, existing:0, schedules:stores.length, long_term:true };
    });
  }
  let created = 0, existing = 0;
  return transaction(db, () => {
    for (let day = from, i = 0; day <= to; day = shift(day, 1), i++) {
      const monthLast = new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0).getDate();
      if (body.frequency === 'once' && i > 0 || body.frequency === 'weekly' && i % 7 !== 0 || body.frequency === 'monthly' && Number(day.slice(8)) !== Math.min(Number(from.slice(8)), monthLast)) continue;
      for (const store of stores) {
        if (db.queryOne('SELECT id FROM store_task_instances WHERE template_id=? AND store_id=? AND business_date=?', [template.id, store, day])) { existing++; continue; }
        db.insert(`INSERT INTO store_task_instances (template_id,template_version,store_id,business_date,due_at,title,description,questions_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, [template.id, template.version, store, day, day + 'T' + body.due_time + ':00+08:00', template.title, template.description, template.questions_json, user.id, now()]); created++;
      }
    }
    return { created, existing };
  });
}
function businessToday() { return new Date(Date.now()+8*3600000).toISOString().slice(0,10); }
function scheduleMatches(s, day) {
  if(s.frequency==='daily') return true;
  if(s.frequency==='weekly') return (new Date(day)-new Date(s.start_date))/86400000%7===0;
  const last=new Date(Date.UTC(Number(day.slice(0,4)),Number(day.slice(5,7)),0)).getUTCDate();
  return Number(day.slice(8))===Math.min(Number(s.start_date.slice(8)),last);
}
function generateScheduled(db, through=businessToday()) {
  date(through);
  const plans=db.queryAll('SELECT * FROM store_task_schedules WHERE active=1 AND next_date<=?', [through]);
  if(!plans.length) return {created:0};
  return transaction(db,()=>{
    let created=0;
    for(const s of plans) {
      // Each tick catches up at most 31 days per store; no unbounded allocation.
      const end=shift(s.next_date,30)<through?shift(s.next_date,30):through;
      for(let day=s.next_date;day<=end;day=shift(day,1)) {
        if(!scheduleMatches(s,day)||db.queryOne('SELECT id FROM store_task_instances WHERE template_id=? AND store_id=? AND business_date=?',[s.template_id,s.store_id,day]))continue;
        db.insert(`INSERT INTO store_task_instances (template_id,template_version,store_id,business_date,due_at,title,description,questions_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,[s.template_id,s.template_version,s.store_id,day,day+'T'+s.due_time+':00+08:00',s.title,s.description,s.questions_json,s.created_by,now()]);created++;
      }
      db.run('UPDATE store_task_schedules SET next_date=? WHERE id=?',[shift(end,1),s.id]);
    }
    return {created};
  });
}
function schedules(db, user, scope=null) {
  requirePermission(user,'store-tasks.manage');
  return db.queryAll('SELECT p.id,p.template_id,p.title,p.store_id,s.store_name,p.frequency,p.start_date,p.next_date,p.due_time,p.active,p.template_version FROM store_task_schedules p JOIN stores s ON s.id=p.store_id WHERE (? IS NULL OR p.store_id=?) ORDER BY p.active DESC,p.id DESC',[scope,scope]);
}
function stopSchedule(db,id,user,scope=null) {
  requirePermission(user,'store-tasks.manage');
  const plan=db.queryOne('SELECT * FROM store_task_schedules WHERE id=?',[Number(id)]);
  if(!plan)fail('长期计划不存在',404);scopeCheck(scope,plan.store_id);
  db.run('UPDATE store_task_schedules SET active=0,stopped_at=? WHERE id=?',[now(),plan.id]);db.save();return {id:plan.id};
}
function list(db, query, scope) {
  const from = date(query.from), to = date(query.to);
  if (from > to || (new Date(to) - new Date(from)) / 86400000 > 92) fail('查询范围最多93天');
  generateScheduled(db);
  const params = [from, to], clauses = ['t.business_date>=?', 't.business_date<=?'];
  if (scope !== null) { clauses.push('t.store_id=?'); params.push(Number(scope)); }
  if (query.store_id) { scopeCheck(scope, query.store_id); clauses.push('t.store_id=?'); params.push(Number(query.store_id)); }
  const rows=db.queryAll(`SELECT t.id,t.title,t.store_id,s.store_name,t.business_date,t.due_at,t.status,t.revision,t.template_version,t.questions_json,
    (SELECT COUNT(DISTINCT a.user_id) FROM store_task_answers a WHERE a.task_id=t.id) AS contributors
    FROM store_task_instances t JOIN stores s ON s.id=t.store_id WHERE ${clauses.join(' AND ')} ORDER BY t.business_date DESC,t.id DESC LIMIT 1000`, params);
  const grouped=new Map();
  for(let start=0;start<rows.length;start+=500){const ids=rows.slice(start,start+500).map(r=>r.id);for(const a of db.queryAll(`SELECT * FROM store_task_answers WHERE task_id IN (${ids.map(()=>'?').join(',')}) ORDER BY id`,ids)){if(!grouped.has(a.task_id))grouped.set(a.task_id,new Map());grouped.get(a.task_id).set(`${a.question_id}:${a.user_id}`,{...a,response:parse(a.response_json)});}}
  return rows.map(r=>{const qs=parse(r.questions_json),results=questionResults(qs,[...(grouped.get(r.id)?.values()||[])]),completed=results.filter(q=>q.complete).length;return {...r,questions_json:undefined,completed,total:qs.length,in_progress:qs.length-completed};});
}
function detail(db, id, scope) {
  const task = db.queryOne('SELECT t.*,s.store_name FROM store_task_instances t JOIN stores s ON s.id=t.store_id WHERE t.id=?', [Number(id)]);
  if (!task) fail('任务不存在', 404); scopeCheck(scope, task.store_id);
  const all = db.queryAll('SELECT * FROM store_task_answers WHERE task_id=? ORDER BY id', [task.id]);
  const latest = new Map(); all.forEach(r => latest.set(`${r.question_id}:${r.user_id}`, { ...r, response: parse(r.response_json), response_json: undefined }));
  const qs = parse(task.questions_json);
  const answers = [...latest.values()];
  const results = questionResults(qs,answers);
  const submissions = db.queryAll('SELECT * FROM store_task_submissions WHERE task_id=? ORDER BY version DESC', [task.id]).map(r => ({ ...r, snapshot: parse(r.snapshot_json), snapshot_json: undefined }));
  return { ...task, questions: qs, questions_json: undefined, results, submissions, completed: results.filter(r => r.complete).length, total: qs.length };
}
function questionResults(qs,answers){
  return qs.map(q => {
    const contributions = answers.filter(a => a.question_id === q.id);
    const photos = [...new Set(contributions.flatMap(a => a.response.images || []))];
    const values = [...new Set(contributions.map(a => a.response.value).filter(v => v !== '' && v !== null && v !== undefined))];
    const conflict = ['choice', 'number', 'dropdown', 'multiple', 'date'].includes(q.type) && values.length > 1;
    const complete = q.type === 'photo' ? photos.length >= (q.required ? Math.max(1, q.min) : q.min) && photos.length <= q.max : values.length > 0 && !conflict;
    const active=contributions.filter(a=>a.response.value!==''&&a.response.value!=null || a.response.images?.length);
    const owner=q.execution_mode==='single'?active[0]:null;
    return { ...q, execution_mode:q.execution_mode||'shared', contributions, photos, values, conflict, complete, owner:owner?{id:owner.user_id,name:owner.user_name}:null, completed_by:complete?active.map(a=>({id:a.user_id,name:a.user_name,at:a.created_at})):[] };
  });
}
function submissionList(db, query={}, scope=null) {
  const page=Number(query.page||1),pageSize=Number(query.page_size||20);
  if(!Number.isInteger(page)||page<1||!Number.isInteger(pageSize)||pageSize<1||pageSize>50)fail('分页参数不正确');
  const where=[],params=[];
  if(scope!==null){where.push('t.store_id=?');params.push(Number(scope));}
  if(query.store_id){scopeCheck(scope,query.store_id);where.push('t.store_id=?');params.push(Number(query.store_id));}
  if(query.from||query.to){
    const from=date(query.from),to=date(query.to);if(from>to)fail('结束日期不能早于开始日期');
    where.push('r.submitted_at>=? AND r.submitted_at<?');params.push(new Date(from+'T00:00:00+08:00').toISOString(),new Date(shift(to,1)+'T00:00:00+08:00').toISOString());
  }
  const join='FROM store_task_submissions r JOIN store_task_instances t ON t.id=r.task_id JOIN stores s ON s.id=t.store_id';
  const clause=()=>where.length?' WHERE '+where.join(' AND '):'';
  const counts=db.queryOne(`SELECT COUNT(*) AS total,COALESCE(SUM(r.status='pending'),0) AS pending,COALESCE(SUM(r.status='approved'),0) AS approved,COALESCE(SUM(r.status='rejected'),0) AS rejected ${join}${clause()}`,params);
  if(query.status){if(!['pending','approved','rejected'].includes(query.status))fail('审核状态不正确');where.push('r.status=?');params.push(query.status);}
  const total=db.queryOne(`SELECT COUNT(*) AS n ${join}${clause()}`,params).n;
  const rows=db.queryAll(`SELECT r.id,r.task_id,r.version,r.status,r.submitted_by,r.submitted_name,r.submitted_at,r.reviewed_name,r.reviewed_at,r.review_note,t.title,t.store_id,t.business_date,s.store_name ${join}${clause()} ORDER BY r.submitted_at DESC,r.id DESC LIMIT ? OFFSET ?`,[...params,pageSize,(page-1)*pageSize]);
  return {rows,total,counts,page,page_size:pageSize};
}
function submissionDetail(db,id,scope=null){
  const record=db.queryOne(`SELECT r.*,t.title,t.description,t.store_id,t.business_date,t.status AS task_status,s.store_name FROM store_task_submissions r JOIN store_task_instances t ON t.id=r.task_id JOIN stores s ON s.id=t.store_id WHERE r.id=?`,[Number(id)]);
  if(!record)fail('提交记录不存在',404);scopeCheck(scope,record.store_id);
  record.snapshot=parse(record.snapshot_json);delete record.snapshot_json;
  const latest=db.queryOne('SELECT MAX(version) AS version FROM store_task_submissions WHERE task_id=?',[record.task_id]);
  record.current=latest.version===record.version;
  return record;
}
function writeAnswer(db, id, body, user, scope) {
  requirePermission(user, 'store-tasks.execute'); const task = detail(db, id, scope);
  if (['pending', 'approved'].includes(task.status)) fail('任务已提交审核，不能修改；退回后可重新填写', 409);
  if (Number(body.revision) !== task.revision) fail('同事已更新任务，请刷新后保留你的内容再保存', 409);
  const q = task.questions.find(q => q.id === body.question_id); if (!q) fail('问题不存在');
  const current=task.results.find(r=>r.id===q.id);
  if(q.execution_mode==='single'&&current.owner&&current.owner.id!==user.id)fail('该项已由'+current.owner.name+'填写，请查看门店共同进度，不能重复提交',409);
  const response = { value: '', images: [] };
  if (q.type === 'photo') {
    if (!Array.isArray(body.images)) fail('图片列表格式不正确');
    response.images = [...new Set(body.images)];
    if (response.images.length > q.max || response.images.some(v => typeof v !== 'string' || !/^\/uploads\/store-tasks\/[a-f0-9-]+\.(jpg|png|webp)$/.test(v) || !db.queryOne('SELECT path FROM store_task_files WHERE path=? AND task_id=? AND user_id=?', [v, task.id, user.id]))) fail('请上传本任务中你自己的图片，且不要超过数量要求');
  } else {
    if (q.type === 'multiple') {
      let selections = body.value ?? [];
      if (typeof selections === 'string') { try { selections = selections ? JSON.parse(selections) : []; } catch { fail('多选答案格式不正确'); } }
      if (!Array.isArray(selections) || selections.some(v => typeof v !== 'string' || !q.options.includes(v))) fail('多选答案不在题目选项中');
      selections = q.options.filter(v => selections.includes(v));
      response.value = selections.length ? JSON.stringify(selections) : '';
    } else response.value = String(body.value ?? '').trim();
    if (response.value.length > 2000 || ['choice','dropdown'].includes(q.type) && response.value && !q.options.includes(response.value) || q.type === 'number' && response.value && !Number.isFinite(Number(response.value))) fail('填写内容不符合题目要求');
    if (q.type === 'text' && (response.value.length > (q.maxLength || 2000) || response.value && q.format === 'phone' && !/^\d{11}$/.test(response.value))) fail('文字长度或手机号格式不符合题目要求');
    if (q.type === 'date' && response.value) date(response.value);
    if (q.type === 'number' && response.value) {
      const value = Number(response.value);
      if (q.lower != null && value < q.lower || q.upper != null && value > q.upper || q.precision != null && (!/^-?\d+(?:\.\d+)?$/.test(response.value) || (response.value.split('.')[1] || '').length > q.precision)) fail('数值不符合范围或小数位数要求');
    }
  }
  return transaction(db, () => {
    db.insert('INSERT INTO store_task_answers (task_id,question_id,user_id,user_name,response_json,created_at) VALUES (?,?,?,?,?,?)', [task.id, q.id, user.id, user.display_name || user.username, json(response), now()]);
    const after = detail(db, task.id, scope);
    if (after.results.some(r => r.type === 'photo' && r.photos.length > r.max)) fail('同事已上传足够照片，请先协调再补充', 409);
    db.run('UPDATE store_task_instances SET revision=revision+1,status=? WHERE id=?', ['draft', task.id]);
    return { revision: task.revision + 1 };
  });
}
function submit(db, id, body, user, scope) {
  requirePermission(user, 'store-tasks.execute'); const task = detail(db, id, scope);
  if (Number(body.revision) !== task.revision || ['pending', 'approved'].includes(task.status)) fail('任务已更新或提交，请刷新', 409);
  const incomplete = task.results.filter(r => r.conflict || r.required && !r.complete);
  if (incomplete.length) fail('请完成必填题或协调冲突：' + incomplete.map(q => q.title).join('、'));
  return transaction(db, () => {
    const version = (task.submissions[0]?.version || 0) + 1;
    db.insert('INSERT INTO store_task_submissions (task_id,version,snapshot_json,submitted_by,submitted_name,submitted_at) VALUES (?,?,?,?,?,?)', [task.id, version, json(task.results), user.id, user.display_name || user.username, now()]);
    db.run("UPDATE store_task_instances SET status='pending',revision=revision+1 WHERE id=?", [task.id]); return { version };
  });
}
function review(db, id, body, user, scope) {
  requirePermission(user, 'store-tasks.review'); const task = detail(db, id, scope);
  if (task.status !== 'pending' || Number(body.version) !== task.submissions[0]?.version || !['approved', 'rejected'].includes(body.status)) fail('审核版本或状态已变化，请刷新', 409);
  const note = String(body.note || '').trim(); if (note.length > 1000 || body.status === 'rejected' && !note) fail('退回需填写意见，最多1000字');
  return transaction(db, () => {
    db.run('UPDATE store_task_submissions SET status=?,reviewed_by=?,reviewed_name=?,reviewed_at=?,review_note=? WHERE id=?', [body.status, user.id, user.display_name || user.username, now(), note, task.submissions[0].id]);
    db.run('UPDATE store_task_instances SET status=?,revision=revision+1 WHERE id=?', [body.status, task.id]); return { status: body.status };
  });
}
module.exports = { ensureSchema, seed, templates, saveTemplate, dispatch, list, detail, writeAnswer, submit, review, permitted, requirePermission, scopeCheck, date, shift, generateScheduled, schedules, stopSchedule, submissionList, submissionDetail };
