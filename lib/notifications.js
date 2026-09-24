// 消息通知：转正提醒、合同到期提醒等规则的生成、查询与状态流转。
// 设计要点：
//   1) 生成是「惰性」的——用户打开通知或在后台操作时触发检查，用一个短节流避免频繁查库；
//   2) 幂等靠 notifications.dedupe_key（唯一索引），同一次转正/合同到期只会生成一条；
//   3) 状态只有两个用户可见值：待处理、已归档；「稍后处理」是待处理下的一个显式标记，用于单独归类查看；
//   4) 规则本身是「配置」不是「代码分支」—— 每类提醒在 RULE_DEFS 里描述一次，
//      runChecks / previewUpcoming 遍历它，因此新增第三类提醒只需加一条定义。
const TYPE_PROBATION_DUE = 'probation_due';
const TYPE_CONTRACT_EXPIRING = 'contract_expiring';
const TYPE_LABELS = { [TYPE_PROBATION_DUE]: '转正提醒', [TYPE_CONTRACT_EXPIRING]: '合同到期提醒' };
const STATUS_PENDING = '待处理';
const STATUS_ARCHIVED = '已归档';
const CHECK_THROTTLE_MS = 60 * 1000;
let lastCheckAt = 0;

/**
 * 提醒规则定义表 —— 每类提醒在这里描述一次，生成与预览逻辑共用。
 * 字段说明：
 *   dateField    员工表上的「里程碑日期」列
 *   dateLabel    该日期在界面/文案里的中文名
 *   defaultLeadDays  未配置时的默认提前天数
 *   previewTitle 规则页上「近期节点」面板的标题
 *   buildTitle / buildContent  生成通知文案
 */
const RULE_DEFS = {
  [TYPE_PROBATION_DUE]: {
    label: '转正提醒',
    description: '员工转正日期前 N 天提醒指定人员，便于提前准备转正材料与评估。',
    dateField: 'probation_date',
    dateLabel: '转正日期',
    defaultLeadDays: 15,
    previewTitle: '近期转正节点',
    buildTitle: (employee, remaining) => (remaining === 0
      ? `${employee.name} 今日转正`
      : `${employee.name} 将在 ${remaining} 天后转正（${employee.probation_date}）`),
    buildContent: employee => `${employee.store_name || '未归属门店'} · ${employee.position || '未填岗位'}｜转正日期 ${employee.probation_date}。请提前完成转正评估与材料准备。`,
  },
  [TYPE_CONTRACT_EXPIRING]: {
    label: '合同到期提醒',
    description: '员工劳动合同到期前 N 天提醒指定人员，便于提前启动续签评估与手续办理。',
    dateField: 'contract_end_date',
    dateLabel: '合同到期日',
    defaultLeadDays: 30,
    previewTitle: '近期合同到期节点',
    buildTitle: (employee, remaining) => (remaining === 0
      ? `${employee.name} 的劳动合同今日到期`
      : `${employee.name} 的劳动合同将在 ${remaining} 天后到期（${employee.contract_end_date}）`),
    buildContent: employee => {
      const span = employee.contract_start_date
        ? `合同期限 ${employee.contract_start_date} 至 ${employee.contract_end_date}`
        : `合同到期日 ${employee.contract_end_date}`;
      return `${employee.store_name || '未归属门店'} · ${employee.position || '未填岗位'}｜${span}。请提前启动续签评估与手续办理。`;
    },
  },
};

const TYPE_META = Object.fromEntries(
  Object.entries(RULE_DEFS).map(([type, def]) => [type, { label: def.label, description: def.description }])
);
// 通知规则：哪些人接收哪类通知。配置保存在 config.json 的 notifications.rules。
function defaultRules() {
  return Object.fromEntries(Object.entries(RULE_DEFS).map(([type, def]) => [
    type,
    { enabled: true, lead_days: def.defaultLeadDays, user_ids: [] },
  ]));
}
function notificationSettings(config = {}) {
  const section = config.notifications || {};
  const stored = section.rules && typeof section.rules === 'object' ? section.rules : {};
  const rules = {};
  Object.entries(defaultRules()).forEach(([type, fallback]) => {
    const item = stored[type] || {};
    rules[type] = {
      enabled: item.enabled !== false,
      lead_days: Math.max(0, Math.min(90, Number(item.lead_days) || fallback.lead_days)),
      user_ids: [...new Set((Array.isArray(item.user_ids) ? item.user_ids : []).map(Number).filter(id => Number.isInteger(id) && id > 0))],
    };
  });
  return { rules, meta: TYPE_META };
}
/** 本地时区的今天（YYYY-MM-DD）。不用 toISOString：东八区零点会退回前一天。 */
function localToday() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function shiftDate(date, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return '';
  const value = new Date(`${date}T00:00:00`);
  if (Number.isNaN(value.getTime())) return '';
  value.setDate(value.getDate() + days);
  // 不使用 toISOString：本地零点转 UTC 会在东八区退回一天，导致 30 天窗口实际只有 29 天。
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return String(year) + '-' + month + '-' + day;
}
function daysBetween(from, to) {
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.round((b - a) / 86400000);
}
// 用于规则页展示：即使还未到提醒窗口，也让管理者能看到系统已识别到的近期节点与预计触发日。
// 单类实现；type 决定看哪个日期列与哪套文案。
function previewUpcomingFor(db, type, { config = {}, today = '', limit = 8 } = {}) {
  const def = RULE_DEFS[type];
  if (!def) return [];
  const rule = notificationSettings(config).rules[type];
  if (!rule?.enabled) return [];
  const field = def.dateField;
  const rows = db.queryAll(
    `SELECT id, name, store_name, position, probation_date, contract_start_date, contract_end_date FROM employees
      WHERE status='在职' AND TRIM(COALESCE(${field},'')) <> '' AND ${field} >= ?
      ORDER BY ${field}, id LIMIT ?`,
    [today, Math.max(1, Math.min(20, Number(limit) || 8))]
  );
  return rows.map(employee => {
    const milestone = employee[field];
    const triggerDate = shiftDate(milestone, -rule.lead_days);
    return {
      type,
      date_field: field,
      date_label: def.dateLabel,
      employee_id: employee.id,
      name: employee.name,
      store_name: employee.store_name || '',
      position: employee.position || '',
      milestone_date: milestone,
      trigger_date: triggerDate,
      days_until_trigger: daysBetween(today, triggerDate),
      days_until_milestone: daysBetween(today, milestone),
      // 兼容旧字段名（转正提醒原样保留，前端历史代码读它）
      probation_date: field === 'probation_date' ? milestone : '',
      days_until_probation: field === 'probation_date' ? daysBetween(today, milestone) : null,
    };
  });
}

/** 返回 { [type]: rows[] }，供规则页按类型分别渲染「近期节点」。 */
function previewUpcomingAll(db, { config = {}, today = '', limit = 8 } = {}) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : localToday();
  return Object.fromEntries(
    Object.keys(RULE_DEFS).map(type => [type, previewUpcomingFor(db, type, { config, today: date, limit })])
  );
}
// 生成到期提醒（转正 / 合同到期共用同一套流程，按 RULE_DEFS 遍历）。
// 返回本次新建的条数；失败不抛出，避免影响主流程。
function runChecks(db, { config = {}, today = '', force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastCheckAt < CHECK_THROTTLE_MS) return { generated: 0, details: [], skipped: true };
  lastCheckAt = now;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : localToday();
  const { rules } = notificationSettings(config);
  const details = [];
  let generated = 0;

  Object.entries(RULE_DEFS).forEach(([type, def]) => {
    const rule = rules[type];
    if (!rule?.enabled || !rule.user_ids.length) return;
    const field = def.dateField;
    const windowEnd = shiftDate(date, rule.lead_days);
    const rows = db.queryAll(
      `SELECT id, name, store_name, position, probation_date, contract_start_date, contract_end_date FROM employees
        WHERE status='在职' AND TRIM(COALESCE(${field},'')) <> ''
          AND ${field} >= ? AND ${field} <= ?
        ORDER BY ${field}, id`,
      [date, windowEnd]
    );
    rows.forEach(employee => {
      const milestone = employee[field];
      // 幂等键含「类型 + 员工 + 里程碑日期」：改了日期就是新的一次提醒，同一日期只提醒一次。
      const dedupeKey = `${type}:${employee.id}:${milestone}`;
      const remaining = daysBetween(date, milestone);
      const created = createNotification(db, {
        type, title: def.buildTitle(employee, remaining), content: def.buildContent(employee), dedupeKey,
        relatedEmployeeId: employee.id, userIds: rule.user_ids,
        payload: { employee_id: employee.id, date_field: field, milestone_date: milestone, remaining_days: remaining },
      });
      if (created) {
        generated += 1;
        details.push({ type, employee: employee.name, date_field: field, milestone_date: milestone, remaining_days: remaining, notification_id: created.id, recipients: created.recipients });
      }
    });
  });
  return { generated, details, skipped: false, today: date };
}
// 创建通知；dedupe_key 已存在时返回 null（幂等）。
// kind：notice=通知（确认/稍后处理）；task=任务（稍后处理/马上查看，预留未启用）。
// source：system=规则生成、manual=人工创建；publish_at 为空或已到时间才对收件人可见。
function createNotification(db, { type, kind = 'notice', title, content = '', dedupeKey = '', relatedEmployeeId = null, userIds = [], payload = {}, createdBy = null, source = 'system', publishAt = '' }) {
  const recipients = [...new Set(userIds.map(Number).filter(id => Number.isInteger(id) && id > 0))];
  if (!recipients.length) return null;
  if (dedupeKey) {
    const existing = db.queryOne('SELECT id FROM notifications WHERE dedupe_key=?', [dedupeKey]);
    if (existing) return null;
  }
  const id = db.insert(
    `INSERT INTO notifications (type,kind,title,content,dedupe_key,related_employee_id,payload_json,created_by,source,publish_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [type, kind === 'task' ? 'task' : 'notice', String(title || '').slice(0, 200), String(content || ''), dedupeKey, relatedEmployeeId, JSON.stringify(payload || {}), createdBy, source === 'manual' ? 'manual' : 'system', publishAt]
  );
  recipients.forEach(userId => {
    db.insert(`INSERT OR IGNORE INTO notification_recipients (notification_id,user_id) VALUES (?,?)`, [id, userId]);
  });
  db.save();
  return { id, recipients: recipients.length };
}
// 可见性：未到计划时间的通知对收件人隐藏。
// 用 datetime() 统一成时间点比较（人工录入只到分钟，按该分钟的第 0 秒生效），
// 避免字符串比较在分钟边界把通知提前最多 59 秒放出来。
function visibleCondition(localNow) {
  return `(COALESCE(n.publish_at,'') = '' OR datetime(n.publish_at) <= datetime('${localNow}'))`;
}
function localSecond(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');
}
function localMinute(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace('T', ' ');
}
// 查询某用户的通知：status = 待处理 / 已归档 / 稍后处理 / 全部
function listForUser(db, userId, { status = 'pending', limit = 200 } = {}) {
  const scope = { pending: `r.status='${STATUS_PENDING}'`, archived: `r.status='${STATUS_ARCHIVED}'`, later: `r.status='${STATUS_PENDING}' AND r.later_at <> ''`, all: '1=1' }[status] || '1=1';
  const rows = db.queryAll(
    `SELECT n.id, n.type, n.kind, n.source, n.publish_at, n.title, n.content, n.related_employee_id, n.payload_json, n.created_at,
            u.display_name AS creator_name, u.username AS creator_username,
            r.status, r.later_at, r.archived_at, r.popup_at, r.id AS recipient_id
       FROM notification_recipients r JOIN notifications n ON n.id = r.notification_id
       LEFT JOIN users u ON u.id = n.created_by
      WHERE r.user_id = ? AND ${scope} AND ${visibleCondition(localSecond())}
      ORDER BY (r.later_at <> '') ASC, n.id DESC
      LIMIT ?`,
    [userId, Math.max(1, Math.min(500, Number(limit) || 200))]
  );
  const nowMinute = localMinute();
  const counts = db.queryOne(
    `SELECT SUM(CASE WHEN r.status=? THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN r.status=? THEN 1 ELSE 0 END) AS archived,
            SUM(CASE WHEN r.status=? AND r.later_at <> '' THEN 1 ELSE 0 END) AS later
       FROM notification_recipients r JOIN notifications n ON n.id = r.notification_id
      WHERE r.user_id=? AND ${visibleCondition(nowMinute)}`,
    [STATUS_PENDING, STATUS_ARCHIVED, STATUS_PENDING, userId]
  ) || {};
  return {
    notifications: rows.map(row => ({
      id: row.id, type: row.type, type_label: manualLabel(row),
      kind: row.kind === 'task' ? 'task' : 'notice',
      source: row.source === 'manual' ? 'manual' : 'system',
      creator: row.creator_name || row.creator_username || '',
      publish_at: row.publish_at || '',
      title: row.title, content: row.content, employee_id: row.related_employee_id,
      payload: safeJson(row.payload_json), created_at: row.created_at,
      status: row.status, later: Boolean(row.later_at), later_at: row.later_at || '', archived_at: row.archived_at || '',
      popup_at: row.popup_at || '',
    })),
    counts: { pending: Number(counts.pending || 0), archived: Number(counts.archived || 0), later: Number(counts.later || 0) },
  };
}
// 人工创建的通知给一个统一标签，便于和规则提醒区分
function manualLabel(row) {
  const base = TYPE_LABELS[row.type] || row.type;
  return row.source === 'manual' ? (TYPE_LABELS[row.type] ? `${base} · 人工` : '人工通知') : base;
}
function pendingCount(db, userId) {
  const row = db.queryOne(
    `SELECT COUNT(*) AS n FROM notification_recipients r JOIN notifications n ON n.id = r.notification_id
      WHERE r.user_id=? AND r.status=? AND ${visibleCondition(localSecond())}`,
    [userId, STATUS_PENDING]
  );
  return Number(row?.n || 0);
}
// 状态流转：confirm（确定→归档） / later（稍后处理） / reopen（退回待处理）
function updateStatus(db, userId, notificationId, action) {
  const recipient = db.queryOne('SELECT * FROM notification_recipients WHERE notification_id=? AND user_id=?', [notificationId, userId]);
  if (!recipient) return { ok: false, error: '通知不存在或不属于当前账号' };
  if (action === 'confirm') {
    db.run(`UPDATE notification_recipients SET status=?, archived_at=datetime('now','localtime'), later_at='', updated_at=datetime('now','localtime') WHERE id=?`, [STATUS_ARCHIVED, recipient.id]);
  } else if (action === 'later') {
    db.run(`UPDATE notification_recipients SET status=?, later_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`, [STATUS_PENDING, recipient.id]);
  } else if (action === 'reopen') {
    db.run(`UPDATE notification_recipients SET status=?, later_at='', archived_at='', updated_at=datetime('now','localtime') WHERE id=?`, [STATUS_PENDING, recipient.id]);
  } else {
    return { ok: false, error: '不支持的操作' };
  }
  db.save();
  return { ok: true };
}
function safeJson(text) { try { return JSON.parse(text || '{}'); } catch { return {}; } }
// 待自动弹窗的通知：还没弹过、且仍是待处理。弹过之后不再重复弹（popup_at 只标记展示，不改处理状态）。
function listPopupPending(db, userId, limit = 20) {
  return db.queryAll(
    `SELECT n.id, n.type, n.kind, n.source, n.title, n.content, n.related_employee_id, n.payload_json, n.created_at
       FROM notification_recipients r JOIN notifications n ON n.id = r.notification_id
      WHERE r.user_id = ? AND r.status = ? AND COALESCE(r.popup_at,'') = '' AND ${visibleCondition(localSecond())}
      ORDER BY n.id DESC LIMIT ?`,
    [userId, STATUS_PENDING, Math.max(1, Math.min(50, Number(limit) || 20))]
  ).map(row => ({
    id: row.id, type: row.type, type_label: manualLabel(row),
    kind: row.kind === 'task' ? 'task' : 'notice',
    source: row.source === 'manual' ? 'manual' : 'system',
    title: row.title, content: row.content, employee_id: row.related_employee_id,
    payload: safeJson(row.payload_json), created_at: row.created_at,
  }));
}
// 我创建的通知（含未到时间的），用于创建者自己核对
function listCreatedBy(db, userId, limit = 100) {
  const now = localSecond();
  return db.queryAll(
    `SELECT n.*, (SELECT COUNT(*) FROM notification_recipients r WHERE r.notification_id=n.id) AS recipient_count,
            (SELECT COUNT(*) FROM notification_recipients r WHERE r.notification_id=n.id AND r.status=?) AS archived_count
       FROM notifications n WHERE n.created_by=? ORDER BY
            CASE WHEN COALESCE(n.publish_at,'') <> '' AND datetime(n.publish_at) > datetime(?) THEN 0 ELSE 1 END,
            n.id DESC LIMIT ?`,
    [STATUS_ARCHIVED, userId, now, Math.max(1, Math.min(300, Number(limit) || 100))]
  ).map(row => ({
    id: row.id, title: row.title, content: row.content, publish_at: row.publish_at || '',
    created_at: row.created_at, recipient_count: Number(row.recipient_count || 0), archived_count: Number(row.archived_count || 0),
    // 未到时间且收件人一个都没动过 → 允许修改/撤回
    editable: isScheduledPending(db, row.id, row.publish_at, now),
    recipients: db.queryAll(
      `SELECT u.id, u.username, u.display_name, r.status, r.later_at, r.archived_at, r.popup_at
         FROM notification_recipients r LEFT JOIN users u ON u.id = r.user_id
        WHERE r.notification_id=? ORDER BY r.id`, [row.id]
    ).map(r => ({ user_id: r.id, name: r.display_name || r.username || `用户${r.id}`, status: r.status, read: Boolean(r.popup_at), handled: r.status === STATUS_ARCHIVED })),
  }));
}
// 定时未发布 = 计划时间在未来、且所有收件人都还没读过/没处理过。
// 一旦到点或任一收件人已读/已处理，就不允许再改再撤。
function isScheduledPending(db, notificationId, publishAt, now = localSecond()) {
  const normalized = String(publishAt || '').trim().replace('T', ' ');
  if (!normalized) return false;
  if (normalized <= now) return false;
  const row = db.queryOne(
    `SELECT COUNT(*) AS n FROM notification_recipients
      WHERE notification_id=? AND (status <> ? OR COALESCE(popup_at,'') <> '' OR COALESCE(later_at,'') <> '')`,
    [notificationId, STATUS_PENDING]
  );
  return Number(row?.n || 0) === 0;
}
// 撤回：连同收件人记录一起删除（只允许定时未发布的）
function withdrawNotification(db, userId, notificationId) {
  const row = db.queryOne('SELECT * FROM notifications WHERE id=?', [notificationId]);
  if (!row) return { ok: false, error: '通知不存在' };
  if (Number(row.created_by) !== Number(userId)) return { ok: false, error: '只能撤回自己创建的通知' };
  if (!isScheduledPending(db, row.id, row.publish_at)) return { ok: false, error: '已发布的通知不能撤回' };
  db.run('DELETE FROM notification_recipients WHERE notification_id=?', [row.id]);
  db.run('DELETE FROM notifications WHERE id=?', [row.id]);
  db.save();
  return { ok: true, title: row.title };
}
// 修改：只允许改标题、内容与通知时间（收件人不变；要改人请撤回后重建）
function updateManualNotification(db, userId, notificationId, patch = {}) {
  const row = db.queryOne('SELECT * FROM notifications WHERE id=?', [notificationId]);
  if (!row) return { ok: false, error: '通知不存在' };
  if (Number(row.created_by) !== Number(userId)) return { ok: false, error: '只能修改自己创建的通知' };
  if (row.source !== 'manual' && row.type !== 'manual') return { ok: false, error: '只有人工创建的通知可以修改' };
  if (!isScheduledPending(db, row.id, row.publish_at)) return { ok: false, error: '已发布的通知不能修改' };
  const title = patch.title !== undefined ? String(patch.title).trim() : row.title;
  if (!title) return { ok: false, error: '请填写通知标题' };
  const content = patch.content !== undefined ? String(patch.content).trim() : row.content;
  let publishAt = patch.publish_at !== undefined ? String(patch.publish_at).trim().replace('T', ' ') : row.publish_at;
  if (publishAt && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(publishAt)) return { ok: false, error: '通知时间格式应为 YYYY-MM-DD HH:mm' };
  if (publishAt && !isFuture(publishAt)) return { ok: false, error: '修改后的通知时间必须在未来' };
  db.run(`UPDATE notifications SET title=?, content=?, publish_at=? WHERE id=?`, [title.slice(0, 200), content, publishAt, row.id]);
  db.save();
  return { ok: true, publish_at: publishAt };
}
function isFuture(publishAt, now = localSecond()) {
  return String(publishAt || '').trim().replace('T', ' ') > now;
}
function markPopupShown(db, userId, ids = []) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(id => Number.isInteger(id) && id > 0))];
  let affected = 0;
  list.forEach(id => {
    affected += Number(db.run(
      `UPDATE notification_recipients SET popup_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
        WHERE notification_id=? AND user_id=? AND COALESCE(popup_at,'')=''`,
      [id, userId]
    )) || 0;
  });
  if (list.length) db.save();
  return affected;
}

/** 兼容旧调用：只返回转正提醒的近期节点（原 previewUpcoming 的行为）。 */
function previewUpcoming(db, options = {}) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(options.today) ? options.today : localToday();
  return previewUpcomingFor(db, TYPE_PROBATION_DUE, { ...options, today: date });
}

module.exports = {
  TYPE_PROBATION_DUE, TYPE_CONTRACT_EXPIRING, TYPE_LABELS, TYPE_META, RULE_DEFS, STATUS_PENDING, STATUS_ARCHIVED,
  defaultRules, notificationSettings, previewUpcoming, previewUpcomingAll, previewUpcomingFor, runChecks, createNotification, listForUser, pendingCount, updateStatus, shiftDate, daysBetween,
  listPopupPending, markPopupShown, listCreatedBy, localToday, localMinute, localSecond,
  isScheduledPending, withdrawNotification, updateManualNotification, isFuture,
};
