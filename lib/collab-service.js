/**
 * 协同事项管理 — Service 业务逻辑层
 * 负责业务规则校验、权限控制、数据组装
 */
const repo = require('./collab-repository');

// 状态流转映射：每个状态可以推进到的下一个状态
const ALLOWED_TRANSITIONS = {
  '待开始': ['进行中', '已完成'],
  '进行中': ['已完成', '未完成'],
  '已完成': [],       // 不可逆
  '未完成': ['已完成'], // 未完成也可以后续手动标记为已完成
};

/**
 * 发起事项
 * @param {Object} data - { title, description, deadline, start_time, participants, participants_name }
 * @param {Object} user  - { id, display_name }
 * @returns {Object} { issue, error }
 */
function createIssue(data, user) {
  if (!data.title || !data.title.trim()) {
    return { error: '事项标题不能为空' };
  }
  if (data.title.length > 100) {
    return { error: '标题不能超过100字' };
  }

  const participants = data.participants || [];
  const participantsName = data.participants_name || [];

  // 根据 participants 数组长度自动决定初始状态：
  // - 设置了开始时间(start_time) → 待开始（由系统在开始时间自动推进，或手动推进）
  // - 没有开始时间 → 保持待开始，等待手动推进
  const issue = repo.createIssue({
    title: data.title.trim(),
    description: (data.description || '').trim(),
    deadline: data.deadline || null,
    start_time: data.start_time || null,
    participants,
    participants_name: participantsName,
    created_by: user.id,
    created_by_name: user.display_name || user.username || '',
    issue_no: repo.generateIssueNo(),
  });

  return { issue };
}

/**
 * 获取事项列表
 * @param {Object} filters - { status, keyword, page, pageSize }
 */
function listIssues(filters) {
  return repo.listIssues(filters);
}

/**
 * 获取事项详情（含回复）
 */
function getIssueDetail(id) {
  const issue = repo.getIssueById(id);
  if (!issue) return { error: '事项不存在' };

  const replies = repo.listReplies(id).map(r => ({
    ...r,
    images: safeParseJSON(r.images, []),
  }));

  return { issue, replies };
}

/**
 * 添加回复
 * @param {number} issueId
 * @param {string} content
 * @param {Array} images - base64 字符串数组
 * @param {Object} user
 */
function addReply(issueId, content, images, user) {
  if (!content || !content.trim()) {
    return { error: '回复内容不能为空' };
  }
  if (images && images.length > 3) {
    return { error: '最多上传3张图片' };
  }

  const issue = repo.getIssueById(issueId);
  if (!issue) return { error: '事项不存在' };
  if (issue.status === '已完成' || issue.status === '未完成') {
    return { error: '已完成/未完成的事项不能回复' };
  }

  const reply = repo.createReply(
    issueId,
    user.id,
    user.display_name || user.username || '',
    content.trim(),
    images || []
  );

  return {
    reply: { ...reply, images: safeParseJSON(reply.images, []) },
    issue: repo.getIssueById(issueId),
  };
}

/**
 * 推进事项状态（单向不可逆）
 * @param {number} issueId
 * @param {string} newStatus - 进行中 | 已完成 | 未完成
 * @param {string} note - 推进说明
 * @param {Object} user - 当前操作用户
 */
function advanceStatus(issueId, newStatus, note, user) {
  const issue = repo.getIssueById(issueId);
  if (!issue) return { error: '事项不存在' };

  // 仅发起人可以推进状态
  if (user.id !== issue.created_by) {
    return { error: '仅发起人可以推进事项进度' };
  }

  // 检查状态流转是否合法
  const allowed = ALLOWED_TRANSITIONS[issue.status] || [];
  if (!allowed.includes(newStatus)) {
    return { error: `不能从「${issue.status}」直接切换到「${newStatus}」。允许的下一步：${allowed.join('、')}` };
  }

  if (!note || !note.trim()) {
    return { error: '推进说明不能为空' };
  }

  const updated = repo.advanceStatus(issueId, newStatus, note.trim());
  return { issue: updated };
}

// ==================== 工具 ====================

function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = {
  createIssue,
  listIssues,
  getIssueDetail,
  addReply,
  advanceStatus,
};
