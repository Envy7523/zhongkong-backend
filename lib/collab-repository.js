/**
 * 协同事项管理 — Repository 数据访问层
 * 负责所有 collab_issues / collab_replies 表的数据库操作
 */
const db = require('./db');

// ==================== 事项 CRUD ====================

/**
 * 创建事项
 * @param {Object} params - { title, description, deadline, start_time, participants, participants_name, created_by, created_by_name, issue_no }
 * @returns {Object} 新创建的事项
 */
function createIssue(params) {
  const issueNo = params.issue_no || generateIssueNo();
  const participants = JSON.stringify(params.participants || []);
  const participantsName = JSON.stringify(params.participants_name || []);
  const id = db.insert(
    `INSERT INTO collab_issues (issue_no, title, description, deadline, start_time, participants, participants_name, status, created_by, created_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [issueNo, params.title, params.description || '', params.deadline || null,
     params.start_time || null, participants, participantsName, '待开始',
     params.created_by, params.created_by_name || '']
  );
  return getIssueById(id);
}

/**
 * 获取事项列表（支持筛选和搜索）
 * @param {Object} filters - { status, keyword, page, pageSize }
 * @returns {{ rows: Array, total: number }}
 */
function listIssues(filters = {}) {
  const conditions = [];
  const params = [];

  if (filters.status && filters.status !== '全部') {
    if (filters.status === '未完成') {
      // 未完成 = 数据库中 status 为未完成，或 进行中+已过期
      conditions.push(`(status = '未完成' OR (status = '进行中' AND deadline IS NOT NULL AND deadline < date('now','localtime')))`);
    } else {
      conditions.push('status = ?');
      params.push(filters.status);
    }
  }
  if (filters.keyword) {
    conditions.push('title LIKE ?');
    params.push(`%${filters.keyword}%`);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const page = Math.max(1, parseInt(filters.page) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(filters.pageSize) || 20));
  const offset = (page - 1) * pageSize;

  const total = db.queryOne(`SELECT COUNT(*) as cnt FROM collab_issues ${where}`, params)?.cnt || 0;
  const rows = db.queryAll(
    `SELECT * FROM collab_issues ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );

  // 动态标记过期事项（进行中 + 已过截止时间 → 展示为未完成）
  const now = new Date().toISOString().slice(0, 10);
  rows.forEach(r => {
    if (r.status === '进行中' && r.deadline && r.deadline < now) {
      r.status_display = '未完成';
    } else {
      r.status_display = r.status;
    }
    r.participants = safeParseJSON(r.participants, []);
    r.participants_name = safeParseJSON(r.participants_name, []);
  });

  return { rows, total, page, pageSize };
}

/**
 * 根据 ID 获取事项
 */
function getIssueById(id) {
  const row = db.queryOne('SELECT * FROM collab_issues WHERE id = ?', [id]);
  if (row) {
    row.participants = safeParseJSON(row.participants, []);
    row.participants_name = safeParseJSON(row.participants_name, []);
    const now = new Date().toISOString().slice(0, 10);
    if (row.status === '进行中' && row.deadline && row.deadline < now) {
      row.status_display = '未完成';
    } else {
      row.status_display = row.status;
    }
  }
  return row;
}

/**
 * 根据编号获取事项
 */
function getIssueByNo(issueNo) {
  return db.queryOne('SELECT * FROM collab_issues WHERE issue_no = ?', [issueNo]);
}

/**
 * 推进事项状态（单向不可逆：待开始→进行中→已完成/未完成）
 * @param {number} id
 * @param {string} newStatus - 进行中 | 已完成 | 未完成
 * @param {string} note - 推进说明
 * @returns {Object} 更新后的事项
 */
function advanceStatus(id, newStatus, note = '') {
  const now = `datetime('now','localtime')`;
  const updates = [];
  const params = [];

  updates.push(`status = ?`);
  params.push(newStatus);
  updates.push(`updated_at = ${now}`);

  if (newStatus === '进行中') {
    updates.push(`start_time = COALESCE(start_time, date('now','localtime'))`);
    updates.push(`completion_note = ?`);
    params.push(note || '');
  } else if (newStatus === '已完成') {
    updates.push(`completed_at = ${now}`);
    updates.push(`completion_note = ?`);
    params.push(note);
  } else if (newStatus === '未完成') {
    updates.push(`completion_note = ?`);
    params.push(note);
  }

  params.push(id);
  db.run(`UPDATE collab_issues SET ${updates.join(', ')} WHERE id = ?`, params);
  return getIssueById(id);
}

// ==================== 回复 CRUD ====================

/**
 * 创建回复
 */
function createReply(issueId, userId, userName, content, images = []) {
  const id = db.insert(
    `INSERT INTO collab_replies (issue_id, user_id, user_name, content, images)
     VALUES (?, ?, ?, ?, ?)`,
    [issueId, userId, userName || '', content, JSON.stringify(images)]
  );

  // 同时更新事项的 updated_at
  db.run(`UPDATE collab_issues SET updated_at = datetime('now','localtime') WHERE id = ?`, [issueId]);

  return db.queryOne('SELECT * FROM collab_replies WHERE id = ?', [id]);
}

/**
 * 获取事项的所有回复（时间正序）
 */
function listReplies(issueId) {
  return db.queryAll(
    'SELECT * FROM collab_replies WHERE issue_id = ? ORDER BY created_at ASC',
    [issueId]
  );
}

// ==================== 编号生成 ====================

/**
 * 生成事项编号：ISS-YYYYMMDD-NNNN
 */
function generateIssueNo() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `ISS-${today}-`;
  const last = db.queryOne(
    "SELECT issue_no FROM collab_issues WHERE issue_no LIKE ? ORDER BY id DESC LIMIT 1",
    [`${prefix}%`]
  );
  let seq = 1;
  if (last) {
    const parts = last.issue_no.split('-');
    seq = parseInt(parts[parts.length - 1]) + 1;
  }
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

// ==================== 工具 ====================

function safeParseJSON(str, fallback) {
  if (!str || str === '') return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = {
  createIssue,
  listIssues,
  getIssueById,
  getIssueByNo,
  advanceStatus,
  createReply,
  listReplies,
  generateIssueNo,
};
