const db = require('./db');

function createIssue(params) {
  const id = db.insert(`INSERT INTO collab_issues (issue_no,title,description,deadline,start_time,participants,participants_name,status,created_by,created_by_name,visibility) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [params.issue_no || generateIssueNo(), params.title, params.description || '', params.deadline || null, params.start_time || null, JSON.stringify(params.participants || []), JSON.stringify(params.participants_name || []), '待开始', params.created_by, params.created_by_name || '', params.visibility || 'public']);
  return getIssueById(id);
}
function listIssues(filters = {}) {
  const conditions = [], params = [];
  if (filters.status) { conditions.push('status = ?'); params.push(filters.status); }
  if (filters.phase === 'active') { conditions.push("archived_at IS NULL AND status IN ('待开始','进行中')"); }
  if (filters.phase === 'ended') { conditions.push("archived_at IS NULL AND status IN ('已完成','未完成','已终止')"); }
  if (filters.phase === 'archived') { conditions.push('archived_at IS NOT NULL'); }
  if (filters.keyword) { conditions.push('title LIKE ?'); params.push(`%${filters.keyword}%`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const page = Math.max(1, Number.parseInt(filters.page, 10) || 1), pageSize = Math.min(50, Math.max(1, Number.parseInt(filters.pageSize, 10) || 20));
  const total = db.queryOne(`SELECT COUNT(*) AS cnt FROM collab_issues ${where}`, params)?.cnt || 0;
  const rows = db.queryAll(`SELECT * FROM collab_issues ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  return { rows: rows.map(normalizeIssue), total, page, pageSize };
}
function getIssueById(id) { const row = db.queryOne('SELECT * FROM collab_issues WHERE id = ?', [id]); return row ? normalizeIssue(row) : null; }
function normalizeIssue(row) { return { ...row, participants: safeJSON(row.participants, []), participants_name: safeJSON(row.participants_name, []), participants_history: safeJSON(row.participants_history, []), status_display: row.status }; }
function updateParticipants(id, participants, participantsName, history) {
  db.run("UPDATE collab_issues SET participants=?, participants_name=?, participants_history=?, updated_at=datetime('now','localtime') WHERE id=?", [JSON.stringify(participants || []), JSON.stringify(participantsName || []), JSON.stringify(history || []), id]);
  return getIssueById(id);
}
function updateDeadline(id, deadline) { db.run("UPDATE collab_issues SET deadline=?, updated_at=datetime('now','localtime') WHERE id=?", [deadline || null, id]); return getIssueById(id); }
function archiveIssue(id) { db.run("UPDATE collab_issues SET archived_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?", [id]); return getIssueById(id); }
function deleteIssue(id) { db.run('DELETE FROM collab_issues WHERE id=?', [id]); }
function getUsers() { return db.queryAll('SELECT id, username, display_name FROM users ORDER BY id'); }
function advanceStatus(id, status, note = '') {
  const terminal = ['已完成', '未完成', '已终止'].includes(status);
  const fields = ['status = ?', "updated_at = datetime('now','localtime')", 'completion_note = ?']; const params = [status, note];
  if (status === '进行中') fields.push("start_time = COALESCE(start_time, date('now','localtime'))");
  if (status === '已完成') fields.push("completed_at = datetime('now','localtime')");
  if (status === '已终止') fields.push("terminated_at = datetime('now','localtime')");
  if (status !== '已完成') fields.push('completed_at = NULL');
  if (status !== '已终止') fields.push('terminated_at = NULL');
  db.run(`UPDATE collab_issues SET ${fields.join(', ')} WHERE id = ?`, [...params, id]);
  return getIssueById(id);
}
function createReply(issueId, userId, userName, content, images = [], replyType = 'progress', parentId = null, replyToUserId = null, replyToName = '') {
  const completionStatus = replyType === 'completion' ? 'pending' : '';
  const id = db.insert('INSERT INTO collab_replies (issue_id,user_id,user_name,content,images,reply_type,parent_id,reply_to_user_id,reply_to_name,completion_status) VALUES (?,?,?,?,?,?,?,?,?,?)', [issueId, userId, userName || '', content, JSON.stringify(images), replyType, parentId, replyToUserId, replyToName, completionStatus]);
  db.run("UPDATE collab_issues SET updated_at = datetime('now','localtime') WHERE id = ?", [issueId]);
  return db.queryOne('SELECT * FROM collab_replies WHERE id = ?', [id]);
}
function updateReply(replyId, content, images = []) {
  db.run("UPDATE collab_replies SET content=?, images=?, edited_at=datetime('now','localtime') WHERE id=?", [content, JSON.stringify(images), replyId]);
  return db.queryOne('SELECT * FROM collab_replies WHERE id = ?', [replyId]);
}
function listReplies(issueId) { return db.queryAll('SELECT * FROM collab_replies WHERE issue_id = ? ORDER BY created_at ASC, id ASC', [issueId]); }
function reviewCompletion(replyId, approved, reviewerId, note) {
  db.run("UPDATE collab_replies SET completion_status=?, reviewed_by=?, reviewed_at=datetime('now','localtime'), review_note=? WHERE id=?", [approved ? 'approved' : 'rejected', reviewerId, note || '', replyId]);
  return db.queryOne('SELECT * FROM collab_replies WHERE id=?', [replyId]);
}
function extendDeadline(issueId, oldDeadline, newDeadline, reason, user) {
  const id = db.insert('INSERT INTO collab_extensions (issue_id,old_deadline,new_deadline,reason,created_by,created_by_name) VALUES (?,?,?,?,?,?)', [issueId, oldDeadline, newDeadline, reason, user.id, user.display_name || user.username || '']);
  db.run("UPDATE collab_issues SET deadline=?, status='进行中', terminated_at=NULL, updated_at=datetime('now','localtime') WHERE id=?", [newDeadline, issueId]);
  return db.queryOne('SELECT * FROM collab_extensions WHERE id=?', [id]);
}
function generateIssueNo() { const prefix = `ISS-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-`; const last = db.queryOne('SELECT issue_no FROM collab_issues WHERE issue_no LIKE ? ORDER BY id DESC LIMIT 1', [`${prefix}%`]); const seq = last ? Number.parseInt(last.issue_no.split('-').pop(), 10) + 1 : 1; return `${prefix}${String(seq).padStart(4,'0')}`; }
function safeJSON(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
module.exports = { createIssue, listIssues, getIssueById, getUsers, updateParticipants, updateDeadline, archiveIssue, deleteIssue, advanceStatus, createReply, updateReply, listReplies, reviewCompletion, extendDeadline, generateIssueNo };
