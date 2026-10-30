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
  require('./store-task-duty').initialize(db);
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
  for (const [name, definition] of [
    ['task_kind', "TEXT NOT NULL DEFAULT 'routine'"],
    ['opens_at', 'TEXT'],
    ['target_count', 'INTEGER NOT NULL DEFAULT 1'],
    ['depends_on_template_id', 'INTEGER'],
    ['dependency_gate', "TEXT NOT NULL DEFAULT 'submitted'"],
    ['time_policy', "TEXT NOT NULL DEFAULT 'legacy'"],
  ]) { try { db.run(`ALTER TABLE store_task_instances ADD COLUMN ${name} ${definition}`); } catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; } }
  for (const [name, definition] of [
    ['opens_time', 'TEXT'],
    ['weekday', 'INTEGER'],
    ['depends_on_template_id', 'INTEGER'],
    ['dependency_gate', "TEXT NOT NULL DEFAULT 'submitted'"],
    ['time_policy', "TEXT NOT NULL DEFAULT 'legacy'"],
  ]) { try { db.run(`ALTER TABLE store_task_schedules ADD COLUMN ${name} ${definition}`); } catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; } }
  for (const [table, name, definition] of [
    ['store_task_answers', 'attempt_no', 'INTEGER NOT NULL DEFAULT 1'],
    ['store_task_submissions', 'late_submission', 'INTEGER NOT NULL DEFAULT 0'],
  ]) { try { db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`); } catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; } }
  db.run(`CREATE TABLE IF NOT EXISTS store_task_reopen_grants (id INTEGER PRIMARY KEY AUTOINCREMENT,task_id INTEGER NOT NULL,reason TEXT NOT NULL,expires_at TEXT NOT NULL,granted_by INTEGER NOT NULL,granted_at TEXT NOT NULL)`);
  db.run('CREATE INDEX IF NOT EXISTS idx_store_task_reopen ON store_task_reopen_grants(task_id,expires_at)');
  require('./store-task-members').initialize(db);
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
function scopeCheck(scope, storeId) { if (!require('./personnel-access').allows(scope,storeId)) fail('无权操作此门店任务', 403); }
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
  const kind = body.task_kind === 'windowed' ? 'windowed' : 'routine';
  const opensTime = body.opens_time == null || body.opens_time === '' ? null : String(body.opens_time);
  if (opensTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(opensTime)) fail('开始时间不正确');
  if (kind === 'windowed' && (body.frequency !== 'once' || body.long_term === true || !opensTime)) fail('限时任务需要开始时间和一次性下发');
  const opening = from + 'T' + (opensTime || '00:00') + ':00+08:00';
  const deadline = (kind === 'windowed' ? to : from) + 'T' + body.due_time + ':00+08:00';
  if (kind === 'windowed' && Date.parse(opening) >= Date.parse(deadline)) fail('截止时间必须晚于开始时间');
  const targetCount = kind === 'windowed' ? Number(body.target_count ?? 1) : 1;
  const timePolicy = kind === 'windowed' || body.enforce_time === true ? 'strict' : 'legacy';
  if (kind === 'routine' && timePolicy === 'strict' && opensTime && opensTime >= body.due_time) fail('当天截止时间必须晚于开始时间');
  if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 30) fail('目标完成次数应为1至30次');
  const weekday = body.weekday == null ? null : Number(body.weekday);
  if (weekday !== null && (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || body.frequency !== 'weekly')) fail('执行星期不正确');
  const dependency = body.depends_on_template_id == null || body.depends_on_template_id === '' ? null : Number(body.depends_on_template_id);
  const gate = body.dependency_gate || 'submitted';
  if (dependency !== null && (!Number.isInteger(dependency) || dependency === template.id || !db.queryOne('SELECT id FROM store_task_templates WHERE id=?',[dependency]))) fail('前置任务不正确');
  if (!['submitted','approved'].includes(gate)) fail('前置任务条件不正确');
  if (body.long_term === true) {
    if (body.frequency === 'once') fail('单次任务不能长期生效');
    return transaction(db, () => {
      for (const store of stores) {
        if (db.queryOne('SELECT id FROM store_task_schedules WHERE template_id=? AND store_id=? AND active=1', [template.id, store])) fail('该门店已有此任务的长期计划，请先在门店管理中移除后重新下发');
        db.insert(`INSERT INTO store_task_schedules (template_id,store_id,template_version,title,description,questions_json,frequency,start_date,next_date,due_time,created_by,created_at,opens_time,weekday,depends_on_template_id,dependency_gate,time_policy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [template.id,store,template.version,template.title,template.description,template.questions_json,body.frequency,from,from,body.due_time,user.id,now(),opensTime,weekday,dependency,gate,timePolicy]);
      }
      require('./store-task-members').register(db,template.id,stores);
      return { created:0, existing:0, schedules:stores.length, long_term:true };
    });
  }
  let created = 0, existing = 0;
  return transaction(db, () => {
    for (let day = from, i = 0; day <= to; day = shift(day, 1), i++) {
      const monthLast = new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0).getDate();
      if (body.frequency === 'once' && i > 0 || body.frequency === 'weekly' && (weekday === null ? i % 7 !== 0 : new Date(day+'T00:00:00Z').getUTCDay() !== weekday) || body.frequency === 'monthly' && Number(day.slice(8)) !== Math.min(Number(from.slice(8)), monthLast)) continue;
      for (const store of stores) {
        if (db.queryOne('SELECT id FROM store_task_instances WHERE template_id=? AND store_id=? AND business_date=?', [template.id, store, day])) { existing++; continue; }
        db.insert(`INSERT INTO store_task_instances (template_id,template_version,store_id,business_date,due_at,title,description,questions_json,created_by,created_at,task_kind,opens_at,target_count,depends_on_template_id,dependency_gate,time_policy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [template.id, template.version, store, day, (kind === 'windowed' ? to : day) + 'T' + body.due_time + ':00+08:00', template.title, template.description, template.questions_json, user.id, now(),kind,day+'T'+(opensTime||'00:00')+':00+08:00',targetCount,dependency,gate,timePolicy]); created++;
      }
    }
    require('./store-task-members').register(db,template.id,stores);
    return { created, existing };
  });
}
function businessToday() { return new Date(Date.now()+8*3600000).toISOString().slice(0,10); }
function scheduleMatches(s, day) {
  if(s.frequency==='daily') return true;
  if(s.frequency==='weekly') return s.weekday == null ? (new Date(day)-new Date(s.start_date))/86400000%7===0 : new Date(day+'T00:00:00Z').getUTCDay()===s.weekday;
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
        db.insert(`INSERT INTO store_task_instances (template_id,template_version,store_id,business_date,due_at,title,description,questions_json,created_by,created_at,opens_at,depends_on_template_id,dependency_gate,time_policy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[s.template_id,s.template_version,s.store_id,day,day+'T'+s.due_time+':00+08:00',s.title,s.description,s.questions_json,s.created_by,now(),day+'T'+(s.opens_time||'00:00')+':00+08:00',s.depends_on_template_id,s.dependency_gate||'submitted',s.time_policy||'legacy']);created++;
      }
      db.run('UPDATE store_task_schedules SET next_date=? WHERE id=?',[shift(end,1),s.id]);
    }
    return {created};
  });
}
function schedules(db, user, scope=null) {
  requirePermission(user,'store-tasks.manage');
  const f=require('./personnel-access').sqlScope(scope,'p.store_id');
  return db.queryAll(`SELECT p.id,p.template_id,p.title,p.store_id,s.store_name,p.frequency,p.start_date,p.next_date,p.due_time,p.active,p.template_version FROM store_task_schedules p JOIN stores s ON s.id=p.store_id WHERE p.active=1 AND ${f.sql} ORDER BY p.id DESC`,f.params);
}
function stopSchedule(db,id,user,scope=null) {
  requirePermission(user,'store-tasks.manage');
  const plan=db.queryOne('SELECT * FROM store_task_schedules WHERE id=?',[Number(id)]);
  if(!plan)fail('长期计划不存在',404);scopeCheck(scope,plan.store_id);
  require('./store-task-members').remove(db,plan.template_id,plan.store_id,user,scope);return {id:plan.id};
}
function executionState(db, task, current = Date.now()) {
  const grant = db.queryOne('SELECT id,expires_at FROM store_task_reopen_grants WHERE task_id=? AND expires_at>? ORDER BY id DESC LIMIT 1',[task.id,new Date(current).toISOString()]);
  const frozen = ['pending','approved'].includes(task.status);
  const strict = task.time_policy === 'strict' || task.task_kind === 'windowed';
  let phase = frozen ? task.status : 'available', reason = '';
  if (!frozen && strict && !grant && Date.parse(task.due_at) <= current) {
    phase = task.task_kind === 'windowed' ? 'forfeited' : 'missed';
    reason = task.task_kind === 'windowed' ? '任务已截止，未达标部分按弃权处理' : '已超过填写截止时间';
  } else if (!frozen && strict && !grant && task.opens_at && Date.parse(task.opens_at) > current) {
    phase = 'not_started'; reason = '未到任务开始时间';
  } else if (!frozen && task.depends_on_template_id) {
    const prior = db.queryOne('SELECT id,title,status FROM store_task_instances WHERE template_id=? AND store_id=? AND business_date=? ORDER BY id DESC LIMIT 1',[task.depends_on_template_id,task.store_id,task.business_date]);
    const ready = prior && (task.dependency_gate === 'approved' ? prior.status === 'approved' : ['pending','approved'].includes(prior.status));
    if (!ready) { phase='blocked'; reason=`请先完成${prior?.title || '前置任务'}`; }
  }
  return {phase,can_edit:phase==='available',reason,reopened:!!grant,reopen_until:grant?.expires_at||null};
}
function requireExecutable(db, task) {
  const state=executionState(db,task);
  if (!state.can_edit) fail(state.reason || '任务当前不可填写',409);
  return state;
}
function reopen(db,id,body,user,scope) {
  if(!permitted(user,'store-tasks.manage')&&!permitted(user,'store-tasks.review'))fail('没有补填授权权限',403);
  const task=detail(db,id,scope),reason=String(body.reason||'').trim(),expiresAt=String(body.expires_at||'');
  if(!['missed','forfeited'].includes(task.effective_status))fail('只有逾期未完成任务可以授权补填',409);
  if(task.status==='approved'||task.status==='pending')fail('已提交或已通过的任务不能直接开放补填',409);
  const expiry=Date.parse(expiresAt);
  if(!reason||reason.length>500||!Number.isFinite(expiry)||expiry<=Date.now()||expiry>Date.now()+7*86400000)fail('请填写原因，并将补填截止时间设在未来7天内');
  return transaction(db,()=>({id:db.insert('INSERT INTO store_task_reopen_grants(task_id,reason,expires_at,granted_by,granted_at) VALUES(?,?,?,?,?)',[task.id,reason,new Date(expiry).toISOString(),user.id,now()]),expires_at:new Date(expiry).toISOString()}));
}
function list(db, query, scope) {
  const from = date(query.from), to = date(query.to);
  if (from > to || (new Date(to) - new Date(from)) / 86400000 > 92) fail('查询范围最多93天');
  generateScheduled(db);
  const params = [to, from, from, to], clauses = ["((t.task_kind='windowed' AND substr(t.opens_at,1,10)<=? AND substr(t.due_at,1,10)>=?) OR (t.task_kind!='windowed' AND t.business_date>=? AND t.business_date<=?))"];
  // The caller supplies a date range; windowed tasks remain visible on every day they overlap it.
  const f=require('./personnel-access').sqlScope(scope,'t.store_id');clauses.push(f.sql);params.push(...f.params);
  if (query.store_id) { scopeCheck(scope, query.store_id); clauses.push('t.store_id=?'); params.push(Number(query.store_id)); }
  const rows=db.queryAll(`SELECT t.id,t.template_id,t.title,t.store_id,s.store_name,t.business_date,t.opens_at,t.due_at,t.task_kind,t.time_policy,t.target_count,t.depends_on_template_id,t.dependency_gate,t.status,t.revision,t.template_version,t.questions_json,
    (SELECT COUNT(DISTINCT a.user_id) FROM store_task_answers a WHERE a.task_id=t.id) AS contributors,
    (SELECT COUNT(*) FROM store_task_submissions r WHERE r.task_id=t.id AND r.status='approved') AS approved_count
    FROM store_task_instances t JOIN stores s ON s.id=t.store_id WHERE ${clauses.join(' AND ')} ORDER BY t.business_date DESC,t.id DESC LIMIT 1000`, params);
  const grouped=new Map();
  for(let start=0;start<rows.length;start+=500){const batch=rows.slice(start,start+500),ids=batch.map(r=>r.id),attempts=new Map(batch.map(r=>[r.id,r.approved_count+1]));for(const a of db.queryAll(`SELECT * FROM store_task_answers WHERE task_id IN (${ids.map(()=>'?').join(',')}) ORDER BY id`,ids)){if(a.attempt_no!==attempts.get(a.task_id))continue;if(!grouped.has(a.task_id))grouped.set(a.task_id,new Map());grouped.get(a.task_id).set(`${a.question_id}:${a.user_id}`,{...a,response:parse(a.response_json)});}}
  return rows.map(r=>{const qs=parse(r.questions_json),answers=[...(grouped.get(r.id)?.values()||[])],results=questionResults(qs,answers),completed=results.filter(q=>q.complete).length,execution=executionState(db,r);return {...r,questions_json:undefined,contributors:new Set(answers.map(a=>a.user_id)).size,completed,total:qs.length,in_progress:qs.length-completed,ready_to_submit:results.every(q=>!q.conflict&&(!q.required||q.complete)),execution,effective_status:['forfeited','missed'].includes(execution.phase)?execution.phase:r.status};});
}
function detail(db, id, scope) {
  const task = db.queryOne('SELECT t.*,s.store_name FROM store_task_instances t JOIN stores s ON s.id=t.store_id WHERE t.id=?', [Number(id)]);
  if (!task) fail('任务不存在', 404); scopeCheck(scope, task.store_id);
  const approvedCount=db.queryOne("SELECT COUNT(*) AS count FROM store_task_submissions WHERE task_id=? AND status='approved'",[task.id]).count;
  const all = db.queryAll('SELECT * FROM store_task_answers WHERE task_id=? AND attempt_no=? ORDER BY id', [task.id,approvedCount+1]);
  const latest = new Map(); all.forEach(r => latest.set(`${r.question_id}:${r.user_id}`, { ...r, response: parse(r.response_json), response_json: undefined }));
  const qs = parse(task.questions_json);
  const answers = [...latest.values()];
  const results = questionResults(qs,answers);
  const submissions = db.queryAll('SELECT r.*,d.duty_json FROM store_task_submissions r LEFT JOIN store_task_submission_duties d ON d.submission_id=r.id WHERE task_id=? ORDER BY version DESC', [task.id]).map(r => ({ ...r, snapshot: parse(r.snapshot_json), responsibility:r.duty_json?parse(r.duty_json):null, duty_json:undefined, snapshot_json: undefined }));
  const execution=executionState(db,task);
  return { ...task, questions: qs, questions_json: undefined, results, submissions, approved_count:submissions.filter(r=>r.status==='approved').length,execution,effective_status:['forfeited','missed'].includes(execution.phase)?execution.phase:task.status,ready_to_submit:results.every(q=>!q.conflict&&(!q.required||q.complete)), completed: results.filter(r => r.complete).length, total: qs.length };
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
  const f=require('./personnel-access').sqlScope(scope,'t.store_id');where.push(f.sql);params.push(...f.params);
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
  const duty=db.queryOne('SELECT duty_json FROM store_task_submission_duties WHERE submission_id=?',[record.id]);
  record.responsibility=duty?parse(duty.duty_json):null;
  const latest=db.queryOne('SELECT MAX(version) AS version FROM store_task_submissions WHERE task_id=?',[record.task_id]);
  record.current=latest.version===record.version;
  return record;
}
function writeAnswer(db, id, body, user, scope) {
  requirePermission(user, 'store-tasks.execute'); const task = detail(db, id, scope);
  requireExecutable(db,task);
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
    db.insert('INSERT INTO store_task_answers (task_id,question_id,user_id,user_name,response_json,created_at,attempt_no) VALUES (?,?,?,?,?,?,?)', [task.id, q.id, user.id, user.display_name || user.username, json(response), now(), task.approved_count+1]);
    const after = detail(db, task.id, scope);
    if (after.results.some(r => r.type === 'photo' && r.photos.length > r.max)) fail('同事已上传足够照片，请先协调再补充', 409);
    db.run('UPDATE store_task_instances SET revision=revision+1,status=? WHERE id=?', ['draft', task.id]);
    return { revision: task.revision + 1 };
  });
}
function submit(db, id, body, user, scope) {
  if(!user?.id)fail('请先登录',401);
  const task = detail(db, id, scope);
  requireExecutable(db,task);
  const responsibility=require('./store-task-duty').requireSubmit(db,task,user);
  if (Number(body.revision) !== task.revision || ['pending', 'approved'].includes(task.status)) fail('任务已更新或提交，请刷新', 409);
  const incomplete = task.results.filter(r => r.conflict || r.required && !r.complete);
  if (incomplete.length) fail('请完成必填题或协调冲突：' + incomplete.map(q => q.title).join('、'));
  return transaction(db, () => {
    const version = (task.submissions[0]?.version || 0) + 1;
    db.insert('INSERT INTO store_task_submissions (task_id,version,snapshot_json,submitted_by,submitted_name,submitted_at,late_submission) VALUES (?,?,?,?,?,?,?)', [task.id, version, json(task.results), user.id, user.display_name || user.username, now(), task.execution.reopened && Date.now()>Date.parse(task.due_at)?1:0]);
    const record=db.queryOne('SELECT id FROM store_task_submissions WHERE task_id=? AND version=?',[task.id,version]);
    db.run('INSERT INTO store_task_submission_duties(submission_id,duty_json) VALUES(?,?)',[record.id,json(responsibility)]);
    db.run("UPDATE store_task_instances SET status='pending',revision=revision+1 WHERE id=?", [task.id]); return { version };
  });
}
function review(db, id, body, user, scope) {
  requirePermission(user, 'store-tasks.review'); const task = detail(db, id, scope);
  if (task.status !== 'pending' || Number(body.version) !== task.submissions[0]?.version || !['approved', 'rejected'].includes(body.status)) fail('审核版本或状态已变化，请刷新', 409);
  const note = String(body.note || '').trim(); if (note.length > 1000 || body.status === 'rejected' && !note) fail('退回需填写意见，最多1000字');
  return transaction(db, () => {
    db.run('UPDATE store_task_submissions SET status=?,reviewed_by=?,reviewed_name=?,reviewed_at=?,review_note=? WHERE id=?', [body.status, user.id, user.display_name || user.username, now(), note, task.submissions[0].id]);
    const completed=task.approved_count+(body.status==='approved'?1:0);
    const more=body.status==='approved'&&task.task_kind==='windowed'&&completed<task.target_count;
    db.run('UPDATE store_task_instances SET status=?,revision=revision+1 WHERE id=?', [more?'draft':body.status, task.id]); return { status:more?'draft':body.status,approved_count:completed,target_count:task.target_count };
  });
}
module.exports = { ensureSchema, seed, templates, saveTemplate, dispatch, list, detail, writeAnswer, submit, review, reopen, executionState, requireExecutable, permitted, requirePermission, scopeCheck, date, shift, generateScheduled, schedules, stopSchedule, submissionList, submissionDetail };
