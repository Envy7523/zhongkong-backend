/**
 * 门店生命周期：闭店 / 迁址 的口径与共同逻辑。
 *
 * 业务口径（2026-09-22 与业务确认，改动前请先确认这三条）：
 *   1) 「同一家店」= 同一个老板对同一家门店的运营。换法人但门店未停业 ≠ 闭店，只记一条「法人变更」事件。
 *   2) **迁址一律「老店闭店 + 新建门店 + 双向关联」**。收银机构编码在迁址后会变，
 *      因此新旧两店各自只记自己的数据，**不做跨店合并口径**；关联仅作“凭证/追溯”：
 *      知道这家店不是全新门店、以及它从哪家店迁来。
 *   3) 状态只有三态：筹建中 / 正常营业 / 已闭店。「迁址」是闭店原因（closed_type），不是状态。
 *      历史遗留的 '闭店'、'迁址' 状态在读取时一并视为已闭店。
 *
 * 闭店时会：
 *   · 写入 closed_date / closed_type / closed_reason 与迁址指针
 *   · 把门店移入「闭店门店」全国统一分组（code='closed'），因此它自然从原区域树里消失
 *   · 原区域记进门店生命线（便于回溯，重开时可归位）
 *   · 解除店长绑定
 *   · **要求该店员工全部处置完毕**（随迁/调岗/离职），否则拒绝闭店
 */

const CLOSED_REGION_CODE = 'closed';
const CLOSED_REGION_NAME = '闭店门店';
const CLOSED_TYPES = ['迁址', '租约到期', '经营不善', '商场物业调整', '其他'];
const STORE_STATUSES = ['筹建中', '正常营业', '已闭店'];
/** 历史数据里可能出现的其它“已结束营业”写法，读取时等同已闭店 */
const CLOSED_STATUS_ALIASES = ['已闭店', '闭店', '迁址'];
const RELOCATION_CLOSED_TYPE = '迁址';

const EVENT_TYPES = [
  '开业', '闭店', '重开', '迁址迁出', '迁址迁入', '更名',
  '法人变更', '店型变更', '区域调整', '店长变更', '资料变更',
];

function safeJson(text, fallback = {}) {
  try { const v = JSON.parse(text || '{}'); return v && typeof v === 'object' ? v : fallback; } catch { return fallback; }
}

/** 该门店是否属于“已结束营业” */
function isClosedStatus(status) {
  return CLOSED_STATUS_ALIASES.includes(String(status || '').trim());
}

/** SQL 片段：把历史别名也算作已闭店 */
const CLOSED_STATUS_SQL = `status IN (${CLOSED_STATUS_ALIASES.map(s => `'${s}'`).join(',')})`;

function closedRegionId(db) {
  const row = db.queryOne('SELECT id FROM store_regions WHERE code=?', [CLOSED_REGION_CODE]);
  return row ? Number(row.id) : null;
}

function addStoreEvent(db, {
  storeId, eventType, eventDate, oldValue = '', newValue = '', note = '',
  source = '本地维护', attachment = {}, details = {},
}) {
  const id = db.insert(
    `INSERT INTO store_lifecycle_events
      (store_id,event_type,event_date,old_value,new_value,note,source,attachment_url,attachment_name,details_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [storeId, String(eventType || '').trim(), String(eventDate || '').trim(),
      String(oldValue || ''), String(newValue || ''), String(note || ''),
      String(source || '本地维护'), String(attachment?.url || ''), String(attachment?.name || ''),
      JSON.stringify(details || {})]
  );
  return id;
}

function listStoreEvents(db, storeId, { limit = 200 } = {}) {
  return db.queryAll(
    `SELECT * FROM store_lifecycle_events WHERE store_id=? ORDER BY event_date DESC, id DESC LIMIT ?`,
    [Number(storeId), Math.max(1, Math.min(500, Number(limit) || 200))]
  ).map(row => ({ ...row, details: safeJson(row.details_json, {}) }));
}

/** 门店当前所属末级区域（含闭店门店组） */
function currentRegion(db, storeId) {
  return db.queryOne(
    `SELECT r.id, r.name, IFNULL(r.code,'') AS code FROM store_region_members m
      JOIN store_regions r ON r.id = m.region_id WHERE m.store_id=? ORDER BY r.id LIMIT 1`,
    [Number(storeId)]
  );
}

/** 把门店移入「闭店门店」分组，并返回它原来的区域（供留痕） */
function moveToClosedRegion(db, storeId) {
  const regionId = closedRegionId(db);
  const previous = currentRegion(db, storeId);
  if (regionId == null) return { moved: false, previous, reason: 'closed_region_missing' };
  if (previous && Number(previous.id) === Number(regionId)) return { moved: false, previous, reason: 'already_closed_group' };
  db.run('DELETE FROM store_region_members WHERE store_id=?', [Number(storeId)]);
  db.run('INSERT OR IGNORE INTO store_region_members (region_id,store_id) VALUES (?,?)', [regionId, Number(storeId)]);
  return { moved: true, previous };
}

/** 校验闭店入参；通过返回 null，否则返回中文错误 */
function validateCloseInput({ closedDate, closedType }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(closedDate || '').trim())) return '请填写闭店日期（YYYY-MM-DD）';
  const type = String(closedType || '').trim();
  if (!type) return '请选择闭店类型';
  if (!CLOSED_TYPES.includes(type)) return `闭店类型不正确，应为：${CLOSED_TYPES.join(' / ')}`;
  return null;
}

/**
 * 员工处置校验：闭店前该店**在职**员工必须全部有明确去向。
 * 判定在职以 leave_date 为准（项目里 deriveEmploymentStatus 就是用它推导的），
 * 已经离职的旧员工不必处置 —— 他们离职时就挂在这家店，属于历史事实。
 */
function pendingEmployees(db, storeId) {
  return db.queryAll(
    `SELECT id, name, status, position FROM employees
      WHERE store_id=? AND TRIM(COALESCE(leave_date,''))='' ORDER BY id`,
    [Number(storeId)]
  );
}

module.exports = {
  CLOSED_REGION_CODE, CLOSED_REGION_NAME, CLOSED_TYPES, STORE_STATUSES,
  CLOSED_STATUS_ALIASES, CLOSED_STATUS_SQL, RELOCATION_CLOSED_TYPE, EVENT_TYPES,
  isClosedStatus, closedRegionId, addStoreEvent, listStoreEvents, currentRegion,
  moveToClosedRegion, validateCloseInput, pendingEmployees, safeJson,
};
