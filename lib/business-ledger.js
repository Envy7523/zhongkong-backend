'use strict';
// Payment execution and published payslips share identity/audit infrastructure,
// but never infer payment from approval or signature from message delivery.
const crypto = require('node:crypto');
const access = require('./personnel-access');
const { normalizePermissions } = require('./permissions');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const stamp = () => new Date().toISOString();
const text = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const json = v => JSON.stringify(v);
const PAYSLIP_PRIVACY_VERSION='2026-10-29.1';
function money(v) {
  if (!/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(String(v))) fail('金额须为最多两位小数的非负数');
  const n = Math.round(Number(v) * 100); if (!Number.isSafeInteger(n)) fail('金额超出范围'); return n;
}
function version(row, body) { if (Number(body.version) !== row.version) fail('记录已更新，请刷新后重试', 409); }
function transaction(db, fn) {
  if (db.transaction) return db.transaction(fn);
  let committed = false;
  db.run('BEGIN');
  try { const result = fn(); db.run('COMMIT'); committed = true; db.save(); return result; }
  catch (e) { if (!committed) { try { db.run('ROLLBACK'); } catch {} } throw e; }
}
function initialize(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS operation_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id INTEGER,actor_name TEXT NOT NULL,channel TEXT NOT NULL,
    action TEXT NOT NULL,resource TEXT NOT NULL,before_json TEXT,after_json TEXT,created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_operation_audit_date ON operation_audit(created_at,id);
  CREATE TABLE IF NOT EXISTS finance_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,requester_id INTEGER,store_id INTEGER,entity TEXT NOT NULL,
    title TEXT NOT NULL,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),beneficiary TEXT NOT NULL,
    account TEXT NOT NULL,source TEXT NOT NULL,source_no TEXT NOT NULL,source_link TEXT NOT NULL DEFAULT '',
    approval_state TEXT NOT NULL DEFAULT 'unverified',execution_state TEXT NOT NULL DEFAULT 'pending',
    history_unverified INTEGER NOT NULL DEFAULT 0,handler_id INTEGER,note TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    UNIQUE(source,entity,source_no));
  CREATE TABLE IF NOT EXISTS finance_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,request_id INTEGER NOT NULL REFERENCES finance_requests(id),
    amount_cents INTEGER NOT NULL CHECK(amount_cents>0),paid_on TEXT NOT NULL,reference TEXT NOT NULL,
    beneficiary TEXT NOT NULL DEFAULT '',account TEXT NOT NULL DEFAULT '',
    actor_id INTEGER NOT NULL,idempotency_key TEXT NOT NULL,reversed_at TEXT,reverse_reason TEXT,
    created_at TEXT NOT NULL,UNIQUE(request_id,idempotency_key));
  CREATE TABLE IF NOT EXISTS published_payslips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,employee_id INTEGER NOT NULL,period TEXT NOT NULL,
    revision INTEGER NOT NULL,snapshot_json TEXT NOT NULL,content_hash TEXT NOT NULL,published_by INTEGER NOT NULL,
    published_at TEXT NOT NULL,withdrawn_at TEXT,withdraw_reason TEXT,UNIQUE(employee_id,period,revision));
  CREATE TABLE IF NOT EXISTS payslip_receipts (
    payslip_id INTEGER PRIMARY KEY REFERENCES published_payslips(id),user_id INTEGER,viewed_at TEXT,
    confirmed_at TEXT,confirmation_name TEXT,objection TEXT,objection_at TEXT,content_hash TEXT);
  CREATE TABLE IF NOT EXISTS payslip_consents (
    user_id INTEGER PRIMARY KEY,version TEXT NOT NULL,accepted_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS payslip_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,payslip_id INTEGER NOT NULL REFERENCES published_payslips(id),
    channel TEXT NOT NULL,recipient_id INTEGER NOT NULL,state TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(payslip_id,channel,recipient_id));
  CREATE TABLE IF NOT EXISTS finance_sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,platform TEXT NOT NULL,source_no TEXT NOT NULL,status TEXT NOT NULL,
    message TEXT NOT NULL,actor_id INTEGER,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS finance_source_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,request_id INTEGER NOT NULL REFERENCES finance_requests(id),
    snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL);`);
  // Explicit column inspection supports previews already created by this batch.
  const columns=db.queryAll('PRAGMA table_info(finance_payments)').map(c=>c.name);
  for(const column of ['beneficiary','account'])if(!columns.includes(column))db.run(`ALTER TABLE finance_payments ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
  require('./finance-approval-summaries').initialize(db);
}
const PRIVATE = /password|secret|token|authorization|credential|account$|bank.*|id_card|source_data|base64|signature_image|webhook|key$|config_json|^data$|image_data/i;
function redact(value, depth = 0) {
  if(Buffer.isBuffer(value))return '[二进制内容省略]';
  if (depth > 5) return '[层级省略]';
  if (Array.isArray(value)) { const items=value.slice(0,40).map(v=>redact(v,depth+1));return value.length>40?{items,total:value.length,omitted:true}:items; }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 80).map(([k,v]) => [k, PRIVATE.test(k) ? '[受保护]' : redact(v, depth + 1)]));
  return typeof value === 'string' ? value.length>1000?value.slice(0,1000)+`[截断，原长${value.length}]`:value : value;
}
function audit(db, actor, action, resource, before, after) {
  db.run('INSERT INTO operation_audit(actor_id,actor_name,channel,action,resource,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
    [actor.id || null, actor.display_name || actor.username || '系统', actor.channel || 'web', action, resource, json(redact(before)), json(redact(after)), stamp()]);
}
function actorFor(db, user, channel = 'web') {
  const row = db.queryOne('SELECT * FROM users WHERE id=?', [user?.id]);
  if (!row) fail('账号不存在', 401);
  const actor = require('./user-positions').enrich(db, row, channel);
  const permissions = normalizePermissions(actor.permissions_json || actor.position_permissions);
  actor.channel = channel; actor.admin = permissions.includes('*'); actor.permissions = permissions;
  actor.can = code => actor.admin || permissions.includes(code);
  return actor;
}
function assertRight(actor, code) { if (!actor.can(code)) fail('没有此操作权限', 403); }
function scopeFor(db, actor, code) {
  if (actor.admin) return null;
  if (actor.access_configured) return access.effective(db, actor.id, actor.channel, code);
  return actor.store_id ? [Number(actor.store_id)] : null;
}
function inScope(db, actor, code, storeId) {
  const scope = scopeFor(db, actor, code);
  return storeId == null ? scope === null : access.allows(scope, storeId);
}
function boundEmployee(db, actor) {
  const employee = require('./employee-mini-context').employee(db, actor);
  if (!employee) fail('账号尚未绑定员工档案，请联系管理员核验', 403);
  return employee;
}
function create(db, { buildPayslip } = {}) {
  function request(id, actor, manage = false) {
    const row = db.queryOne('SELECT * FROM finance_requests WHERE id=?', [Number(id)]);
    if (!row) fail('请款记录不存在', 404);
    const allowed = actor.can('finance.payments.manage') && inScope(db,actor,'finance.payments.manage',row.store_id);
    if (manage ? !allowed : !(allowed || row.requester_id === actor.id)) fail('无权访问此请款', 403);
    return row;
  }
  function present(row, actor) {
    const payments = db.queryAll('SELECT * FROM finance_payments WHERE request_id=? ORDER BY id', [row.id]);
    const paid = payments.filter(p => !p.reversed_at).reduce((s,p) => s + p.amount_cents, 0);
    const state = row.history_unverified ? 'history_unverified' : row.approval_state !== 'approved' ? row.approval_state : row.execution_state === 'held' ? 'held' : paid === row.amount_cents ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
    const can_manage = actor.can('finance.payments.manage') && inScope(db,actor,'finance.payments.manage',row.store_id);
    return { ...row, account: can_manage ? row.account : row.account ? '****' + row.account.slice(-4) : '', paid_cents: paid, remaining_cents: row.amount_cents-paid, state, can_manage, payments:payments.map(p=>({...p,account:can_manage?p.account:p.account?'****'+p.account.slice(-4):''})) };
  }
  function addRequest(actor, b, trustedSource = false) {
    const source = text(b.source, 20); if (!['manual','wecom','dingtalk'].includes(source)) fail('请选择审批来源');
    const entity=text(b.entity,100),source_no=text(b.source_no,120), title=text(b.title,150), beneficiary=text(b.beneficiary,100),account=text(b.account,100);
    if (!entity || !source_no || !title || !beneficiary || !account) fail('请填写主体、审批号、用途和收款信息');
    const amount_cents = money(b.amount); if (!amount_cents) fail('请款金额必须大于零');
    const store_id = b.store_id ? Number(b.store_id) : null;
    if (store_id && (!Number.isSafeInteger(store_id) || !db.queryOne('SELECT id FROM stores WHERE id=?',[store_id]))) fail('门店不存在');
    const scope = scopeFor(db,actor,actor.can('finance.payments.manage')?'finance.payments.manage':null);
    if ((store_id == null && scope !== null) || store_id != null && !access.allows(scope,store_id)) fail('无权登记此门店请款',403);
    if (!actor.admin && b.requester_id && Number(b.requester_id)!==actor.id) fail('不能代他人登记请款',403);
    const requester_id = actor.admin && b.requester_id ? Number(b.requester_id) : actor.id;
    if (!db.queryOne('SELECT id FROM users WHERE id=?',[requester_id])) fail('申请人账号不存在');
    if (db.queryOne('SELECT id FROM finance_requests WHERE source=? AND entity=? AND source_no=?',[source,entity,source_no])) fail('此审批单已登记，请在现有记录继续处理',409);
    return transaction(db,()=>{
      const at=stamp(),id=db.insert(`INSERT INTO finance_requests(requester_id,store_id,entity,title,amount_cents,beneficiary,account,source,source_no,source_link,approval_state,history_unverified,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [requester_id,store_id,entity,title,amount_cents,beneficiary,account,source,source_no,text(b.source_link,1000),trustedSource?'approved':'unverified',b.historical?1:0,text(b.note),at,at]);
      audit(db,actor,'finance.create',`finance:${id}`,null,{title,source,source_no,amount_cents});
      return present(request(id,actor),actor);
    });
  }
  function payment(actor,id,b) {
    const row=request(id,actor,true),key=text(b.idempotency_key,100);
    if (!/^[\w-]{8,100}$/.test(key)) fail('缺少有效的提交标识');
    const old=db.queryOne('SELECT * FROM finance_payments WHERE request_id=? AND idempotency_key=?',[row.id,key]);
    if (old) {
      if (old.amount_cents!==money(b.amount)||old.paid_on!==b.paid_on||old.reference!==text(b.reference,300)) fail('提交标识与原付款内容不一致',409);
      return present(row,actor);
    }
    version(row,b); const p=present(row,actor),amount=money(b.amount);
    if(row.approval_state!=='approved'||row.history_unverified||row.execution_state==='held') fail('审批或历史付款未核实，或单据暂缓，不能登记付款');
    if (!amount || amount>p.remaining_cents) fail('付款金额须大于零且不超过未付余额');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.paid_on)||!Number.isFinite(Date.parse(b.paid_on))||new Date(b.paid_on).toISOString().slice(0,10)!==b.paid_on||b.paid_on>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date())) fail('请输入有效的实际付款日期');
    const reference=text(b.reference,300); if(!reference)fail('请登记付款凭证或银行流水引用');
    return transaction(db,()=>{
      db.run('INSERT INTO finance_payments(request_id,amount_cents,paid_on,reference,beneficiary,account,actor_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)',[row.id,amount,b.paid_on,reference,row.beneficiary,row.account,actor.id,key,stamp()]);
      db.run('UPDATE finance_requests SET version=version+1,updated_at=? WHERE id=?',[stamp(),row.id]);
      audit(db,actor,'finance.payment',`finance:${row.id}`,{paid_cents:p.paid_cents},{amount_cents:amount,reference});
      return present(request(row.id,actor),actor);
    });
  }
  function action(actor,id,b) {
    const row=request(id,actor,true); version(row,b); const note=text(b.note); if (!note) fail('请填写核验或处理说明');
    return transaction(db,()=>{
      let changes;
      if (b.action==='verify') changes={approval_state:'approved',history_unverified:0};
      else if(b.action==='reject')changes={approval_state:'rejected'};
      else if(b.action==='hold')changes={execution_state:'held'};
      else if(b.action==='resume')changes={execution_state:'pending'};
      else if(b.action==='revoke')changes={approval_state:'revoked'};
      else fail('未知处理动作');
      if (b.action==='verify' && !['unverified','approved'].includes(row.approval_state)) fail('原审批未通过、已撤销或存在来源冲突，不能通过人工核验恢复');
      db.run(`UPDATE finance_requests SET ${Object.keys(changes).map(k=>k+'=?').join(',')},note=?,handler_id=?,version=version+1,updated_at=? WHERE id=?`,[...Object.values(changes),note,actor.id,stamp(),row.id]);
      audit(db,actor,'finance.'+b.action,`finance:${row.id}`,row,{...changes,note});
      return present(request(row.id,actor),actor);
    });
  }
  function reverse(actor,id,paymentId,b) {
    const row=request(id,actor,true);version(row,b); const p=db.queryOne('SELECT * FROM finance_payments WHERE id=? AND request_id=?',[Number(paymentId),row.id]);
    if(!p)fail('付款记录不存在',404);if(p.reversed_at)fail('此付款记录已冲销',409);if(!text(b.note))fail('请填写冲销原因');
    return transaction(db,()=>{db.run('UPDATE finance_payments SET reversed_at=?,reverse_reason=? WHERE id=?',[stamp(),text(b.note),p.id]);db.run('UPDATE finance_requests SET version=version+1,updated_at=? WHERE id=?',[stamp(),row.id]);audit(db,actor,'finance.reverse',`finance:${row.id}`,p,{payment_id:p.id,reason:text(b.note)});return present(request(row.id,actor),actor);});
  }
  function payslip(id,actor,manage=false) {
    const row=db.queryOne('SELECT * FROM published_payslips WHERE id=?',[Number(id)]);if(!row)fail('工资条不存在',404);
    if (manage) assertRight(actor,'payroll.publish');
    else if(boundEmployee(db,actor).id!==row.employee_id)fail('无权查看他人工资条',403);
    if(manage && scopeFor(db,actor,'payroll.publish')!==null)fail('工资条发布须具备完整工资范围',403);
    return row;
  }
  function slipDto(row,receipt) { const {snapshot_json,...rest}=row;return {...rest,snapshot:JSON.parse(snapshot_json),receipt:receipt||null}; }
  function publish(actor,b) {
    assertRight(actor,'payroll.publish');if(scopeFor(db,actor,'payroll.publish')!==null)fail('工资条发布须具备完整工资范围',403);
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(b.period)||!Number.isSafeInteger(Number(b.employee_id)))fail('请选择员工和月份');
    if(!buildPayslip)fail('工资汇总服务尚未就绪',503);
    const snapshot=buildPayslip(Number(b.employee_id),b.period);
    if(!snapshot?.complete || !snapshot.all_approved)fail('相关门店工资须齐全且全部审核后才能发布');
    const snapshot_json=json(snapshot),hash=crypto.createHash('sha256').update(snapshot_json).digest('hex');
    const last=db.queryOne('SELECT * FROM published_payslips WHERE employee_id=? AND period=? ORDER BY revision DESC LIMIT 1',[Number(b.employee_id),b.period]);
    if(last && !last.withdrawn_at && last.content_hash===hash)return slipDto(last);
    if(last && !text(b.reason))fail('更正或重新发布请填写原因');
    return transaction(db,()=>{
      const at=stamp();if(last&&!last.withdrawn_at)db.run('UPDATE published_payslips SET withdrawn_at=?,withdraw_reason=? WHERE id=?',[at,text(b.reason),last.id]);
      const id=db.insert('INSERT INTO published_payslips(employee_id,period,revision,snapshot_json,content_hash,published_by,published_at) VALUES(?,?,?,?,?,?,?)',[Number(b.employee_id),b.period,(last?.revision||0)+1,snapshot_json,hash,actor.id,at]);
      audit(db,actor,'payslip.publish',`payslip:${id}`,last?{id:last.id,hash:last.content_hash}:null,{employee_id:Number(b.employee_id),period:b.period,hash,reason:text(b.reason)});
      return slipDto(payslip(id,actor,true));
    });
  }
  function receipt(actor,id,b) {
    const row=payslip(id,actor);if(row.withdrawn_at)fail('此版本已撤回，请查看最新工资条',409);
    if(b.content_hash!==row.content_hash)fail('工资条版本不一致，请重新打开',409);
    if(!['confirm','objection'].includes(b.action))fail('请选择确认或提出异议');
    if(b.action==='confirm' && (b.accept!==true||text(b.confirmation_name)!==text(boundEmployee(db,actor).name)))fail('请主动确认并填写本人档案姓名');
    if(b.action==='objection'&&!text(b.note))fail('请填写需要核对的问题');
    const prior=db.queryOne('SELECT * FROM payslip_receipts WHERE payslip_id=?',[row.id]);
    if(prior?.confirmed_at && b.action==='confirm')return prior;
    return transaction(db,()=>{
      const at=stamp();db.run('INSERT OR IGNORE INTO payslip_receipts(payslip_id,user_id,viewed_at) VALUES(?,?,?)',[row.id,actor.id,at]);
      if(b.action==='confirm')db.run('UPDATE payslip_receipts SET user_id=?,confirmed_at=?,confirmation_name=?,content_hash=? WHERE payslip_id=?',[actor.id,at,text(b.confirmation_name),row.content_hash,row.id]);
      else db.run('UPDATE payslip_receipts SET user_id=?,objection=?,objection_at=? WHERE payslip_id=?',[actor.id,text(b.note),at,row.id]);
      audit(db,actor,'payslip.'+b.action,`payslip:${row.id}`,null,{hash:row.content_hash,note:b.action==='objection'?text(b.note):'本人核对工资明细；不代表实际到账'});
      return db.queryOne('SELECT * FROM payslip_receipts WHERE payslip_id=?',[row.id]);
    });
  }
  return {request,present,addRequest,payment,action,reverse,payslip,publish,receipt,slipDto};
}
module.exports={initialize,create,actorFor,assertRight,scopeFor,inScope,boundEmployee,transaction,audit,redact,money,stamp,PAYSLIP_PRIVACY_VERSION};
