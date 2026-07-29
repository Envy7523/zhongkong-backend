const repo = require('./collab-repository');

const MANUAL_STATUSES = ['待开始', '进行中', '已完成', '未完成', '已终止'];

function createIssue(data, user) {
  if (!data.title || !data.title.trim()) return { error: '事项标题不能为空' };
  if (data.title.trim().length > 100) return { error: '标题不能超过 100 个字符' };
  return { issue: repo.createIssue({
    title: data.title.trim(), description: (data.description || '').trim(),
    deadline: data.deadline || null, start_time: data.start_time || null,
    participants: Array.isArray(data.participants) ? data.participants : [],
    participants_name: Array.isArray(data.participants_name) ? data.participants_name : [],
    visibility: data.visibility === 'internal' ? 'internal' : 'public',
    created_by: user.id, created_by_name: user.display_name || user.username || '',
    issue_no: repo.generateIssueNo(),
  }) };
}

function canView(issue, user) { return Number(issue.created_by) === Number(user.id) || (issue.participants || []).map(Number).includes(Number(user.id)); }
function listIssues(filters, user) {
  const source = repo.listIssues({ ...filters, page: 1, pageSize: 50 });
  const visibleRows = source.rows.filter(issue => canView(issue, user));
  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(filters.pageSize) || 20));
  return { ...source, rows: visibleRows.slice((page - 1) * pageSize, page * pageSize), total: visibleRows.length, page, pageSize };
}

function getIssueDetail(id, user) {
  const issue = repo.getIssueById(id);
  if (!issue) return { error: '事项不存在' };
  if (!canView(issue, user)) return { error: '无权查看内部事项' };
  refreshDeadline(issue);
  const currentIssue = repo.getIssueById(id);
  const exited = new Map((currentIssue.participants_history || []).map(item => [Number(item.id), item]));
  const replies = repo.listReplies(id).map(reply => ({ ...reply, images: safeJSON(reply.images, []), reply_type: reply.reply_type || 'progress', member_left_at: exited.get(Number(reply.user_id))?.left_at || null }));
  const completionReplies = replies.filter(reply => reply.reply_type === 'completion');
  return { issue: currentIssue, replies, completionReplies };
}

function canParticipate(issue, user) {
  return Number(issue.created_by) === Number(user.id)
    || (issue.participants || []).map(Number).includes(Number(user.id))
    || String(user.role || '').includes('管理员');
}

function isIssueParticipant(issue, userId) {
  return (issue.participants || []).map(Number).includes(Number(userId));
}

function addReply(issueId, content, images, replyType, user, parentId = null, replyToUserId = null, replyToName = '') {
  if (!content || !content.trim()) return { error: '跟进内容不能为空' };
  if ((images || []).length > 3) return { error: '最多上传 3 张图片' };
  const issue = repo.getIssueById(issueId);
  if (!issue) return { error: '事项不存在' };
  if (['已完成', '未完成', '已终止'].includes(issue.status)) return { error: '该事项已结束，不能继续跟进' };
  if (!canParticipate(issue, user)) return { error: '只有发起人、协作成员或系统管理员可以发布跟进' };
  const type = ['progress', 'next_step', 'completion', 'clarification'].includes(replyType) ? replyType : 'progress';
  if (type === 'next_step' && Number(issue.created_by) !== Number(user.id)) return { error: '只有发起人可以发布下一步安排' };
  if (parentId && !repo.listReplies(issueId).some(reply => Number(reply.id) === Number(parentId))) return { error: '回复目标不存在' };
  if (parentId) {
    const parent = repo.listReplies(issueId).find(reply => Number(reply.id) === Number(parentId));
    const senderIsCreator = Number(issue.created_by) === Number(user.id);
    const senderIsParticipant = isIssueParticipant(issue, user.id);
    const recipientIsParticipant = parent && isIssueParticipant(issue, parent.user_id);
    const recipientIsCreator = parent && Number(parent.user_id) === Number(issue.created_by);
    if (senderIsCreator && !recipientIsParticipant) return { error: '发起人只能回复协作成员的动态' };
    if (senderIsParticipant && recipientIsCreator && type !== 'clarification') return { error: '回复发起人仅可用于确认、提问或澄清' };
    if (senderIsParticipant && (!recipientIsParticipant && !recipientIsCreator || Number(parent.user_id) === Number(user.id))) return { error: '协作成员只能回复其他协作成员，或向发起人确认提问' };
    if (!senderIsCreator && !senderIsParticipant) return { error: '没有回复权限' };
    // 被回复人只从原动态推导，忽略客户端提交的用户信息。
    replyToUserId = parent.user_id;
    replyToName = parent.user_name || '';
  } else {
    replyToUserId = null;
    replyToName = '';
  }
  const reply = repo.createReply(issueId, user.id, user.display_name || user.username || '', content.trim(), images || [], type, parentId, replyToUserId, replyToName);
  return { reply: { ...reply, images: safeJSON(reply.images, []) }, issue: repo.getIssueById(issueId) };
}

function reviewCompletion(issueId, replyId, approved, note, user) {
  const issue = repo.getIssueById(issueId);
  if (!issue) return { error: '事项不存在' };
  if (Number(issue.created_by) !== Number(user.id)) return { error: '只有发起人可以审批完成提报' };
  const reply = repo.listReplies(issueId).find(item => Number(item.id) === Number(replyId));
  if (!reply || reply.reply_type !== 'completion') return { error: '完成提报不存在' };
  const reviewed = repo.reviewCompletion(replyId, approved, user.id, note);
  return { reply: { ...reviewed, images: safeJSON(reviewed.images, []) }, issue: repo.getIssueById(issueId) };
}

function editReply(issueId, replyId, content, images, user) {
  const issue = repo.getIssueById(issueId);
  if (!issue) return { error: '事项不存在' };
  const reply = repo.listReplies(issueId).find(item => Number(item.id) === Number(replyId));
  if (!reply) return { error: '动态不存在' };
  if (Number(reply.user_id) !== Number(user.id)) return { error: '只能编辑自己发布的动态' };
  if (!content || !content.trim()) return { error: '动态内容不能为空' };
  if ((images || []).length > 3) return { error: '每条动态最多 3 个附件' };
  const updated = repo.updateReply(replyId, content.trim(), images || []);
  return { reply: { ...updated, images: safeJSON(updated.images, []) } };
}

function extendDeadline(issueId, newDeadline, reason, user) {
  const issue = repo.getIssueById(issueId);
  if (!issue) return { error: '事项不存在' };
  if (Number(issue.created_by) !== Number(user.id)) return { error: '只有发起人可以发起延期' };
  if (!newDeadline || (issue.deadline && newDeadline <= issue.deadline)) return { error: '新结束时间必须晚于原结束时间' };
  if (!reason || !reason.trim()) return { error: '请填写延期原因' };
  const extension = repo.extendDeadline(issueId, issue.deadline, newDeadline, reason.trim(), user);
  const reply = repo.createReply(issueId, user.id, user.display_name || user.username || '', `项目延期至 ${newDeadline}：${reason.trim()}`, [], 'extension');
  return { extension, reply: { ...reply, images: [] }, issue: repo.getIssueById(issueId) };
}

function refreshDeadline(issue) {
  if (!issue.deadline || ['已完成', '未完成', '已终止'].includes(issue.status)) return;
  if (issue.deadline >= new Date().toISOString().slice(0, 10)) return;
  repo.advanceStatus(issue.id, '已终止', '结束时间已到，项目自动终止');
  repo.createReply(issue.id, 0, '系统', '结束时间已到，项目自动终止；如需继续请由发起人发起延期。', [], 'deadline');
}

function advanceStatus(issueId, newStatus, note, user) {
  const issue = repo.getIssueById(issueId);
  if (!issue) return { error: '事项不存在' };
  if (Number(user.id) !== Number(issue.created_by)) return { error: '只有发起人可以推进或终止事项' };
  if (!MANUAL_STATUSES.includes(newStatus)) return { error: '无效的项目进度' };
  if (!note || !note.trim()) return { error: '请填写操作说明' };
  const updated = repo.advanceStatus(issueId, newStatus, note.trim());
  repo.createReply(issueId, user.id, user.display_name || user.username || '', note.trim(), [], newStatus === '已终止' ? 'termination' : 'status');
  return { issue: updated };
}

function updateParticipants(issueId, participants, user) {
  const issue = repo.getIssueById(issueId);
  if (!issue) return { error: '事项不存在' };
  if (Number(issue.created_by) !== Number(user.id)) return { error: '只有发起人可以调整参与成员' };
  const active = [...new Set((Array.isArray(participants) ? participants : []).map(Number).filter(id => id && id !== Number(user.id)))];
  const oldIds = (issue.participants || []).map(Number);
  const history = (issue.participants_history || []).filter(item => active.includes(Number(item.id)) ? false : true);
  const previousNames = new Map((issue.participants || []).map((id, index) => [Number(id), issue.participants_name?.[index] || '成员']));
  const removedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
  oldIds.filter(id => !active.includes(id)).forEach(id => { if (!history.some(item => Number(item.id) === id)) history.push({ id, name: previousNames.get(id) || '成员', left_at: removedAt }); });
  const users = repo.getUsers ? repo.getUsers() : [];
  const names = active.map(id => users.find(item => Number(item.id) === id)?.display_name || users.find(item => Number(item.id) === id)?.username || previousNames.get(id) || '成员');
  const updated = repo.updateParticipants(issueId, active, names, history);
  return { issue: updated };
}

function updateDeadline(issueId, deadline, user) {
  const issue = repo.getIssueById(issueId);
  if (!issue) return { error: '事项不存在' };
  if (Number(issue.created_by) !== Number(user.id)) return { error: '只有发起人可以修改结束时间' };
  if (['已完成', '未完成', '已终止'].includes(issue.status)) return { error: '已结束事项请使用项目延期重新启动' };
  if (deadline && issue.start_time && deadline < issue.start_time) return { error: '结束时间不能早于开始时间' };
  return { issue: repo.updateDeadline(issueId, deadline) };
}

function archiveIssue(issueId, user) {
  const issue = repo.getIssueById(issueId);
  if (!issue) return { error: '事项不存在' };
  if (Number(issue.created_by) !== Number(user.id)) return { error: '只有发起人可以归档事项' };
  if (issue.status !== '已完成') return { error: '仅已完成的事项可以归档' };
  const completion = repo.listReplies(issueId).filter(reply => reply.reply_type === 'completion');
  const everyoneConfirmed = !(issue.participants || []).some(id => !completion.some(reply => Number(reply.user_id) === Number(id) && reply.completion_status === 'approved'));
  if (!everyoneConfirmed) return { error: '请先确认所有参与成员的完成提报后再归档' };
  return { issue: repo.archiveIssue(issueId) };
}

function deleteIssue(issueId, user) {
  const issue = repo.getIssueById(issueId);
  if (!issue) return { error: '事项不存在' };
  if (Number(issue.created_by) !== Number(user.id)) return { error: '只有发起人可以删除事项' };
  repo.deleteIssue(issueId);
  return { ok: true };
}

function safeJSON(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
module.exports = { createIssue, listIssues, getIssueDetail, addReply, editReply, reviewCompletion, extendDeadline, advanceStatus, updateParticipants, updateDeadline, archiveIssue, deleteIssue };
