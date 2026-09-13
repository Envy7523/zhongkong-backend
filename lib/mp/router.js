/**
 * 小程序接口层（/api/mp/*）
 *
 * 原则：只加不改 —— 现有 server.js 的 99 个后台接口原样保留给 PC 端，
 * 小程序走这里：独立 token、独立字段裁剪（DTO）、强制角色与数据范围。
 *
 * 挂载方式见 server.js：「app.use('/api/mp', require('./lib/mp/router'))」
 */
const express = require('express');
const db = require('../db');
const collabService = require('../collab-service');
const auth = require('./auth');
const upload = require('./upload');
const revenueMap = require('./revenue-map');

// 真实后台的业务分析模块（F:\NewDeom\lib\business-analytics.js）。
// 存在时营业数据一律走它 → 口径与 PC 后台永远一致；不存在时退回本文件内的原始 SQL。
let businessAnalytics = null;
try { businessAnalytics = require('../business-analytics'); } catch { businessAnalytics = null; }

/** 状态流转提示：优先用 service 导出的规则，没有则用本地镜像（只用于前端渲染按钮，实际校验仍在 service 内） */
const ALLOWED_TRANSITIONS = collabService.ALLOWED_TRANSITIONS || {
  '待开始': ['进行中', '已完成'],
  '进行中': ['已完成', '未完成'],
  '已完成': [],
  '未完成': ['已完成'],
};

/**
 * 兼容两版 collab-service 的签名差异：
 *   F 版 addReply(issueId, content, images, replyType, user, ...)
 *   G 版 addReply(issueId, content, images, user)
 * 按声明参数个数自适应，避免搬迁后调用错位。
 */
const collabUsesReplyType = collabService.addReply.length >= 5;

const router = express.Router();

// ==================== 工具 ====================

function fail(res, e) {
  const status = e && e.status ? e.status : 500;
  res.status(status).json({ error: (e && e.message) || '服务异常' });
}

/** 相对路径补成绝对地址：小程序的 <image src> 无法解析相对路径 */
function absUrl(req, p) {
  const s = String(p || '');
  if (!s) return '';
  if (/^https?:\/\//i.test(s) || s.startsWith('data:')) return s;
  return `${req.protocol}://${req.get('host')}${s.startsWith('/') ? '' : '/'}${s}`;
}

/** 兼容三种历史图片形态：绝对 URL / 相对路径 / 裸 base64（PC 端旧数据） */
function normalizeImage(req, v) {
  const s = String(v || '');
  if (!s) return '';
  if (/^https?:\/\//i.test(s) || s.startsWith('data:')) return s;
  if (s.startsWith('/')) return absUrl(req, s);
  return `data:image/jpeg;base64,${s}`;
}

/** 事项 DTO：只下发给小程序需要的字段，并补上可执行的下一步动作 */
function issueDto(req, item, replyCount = 0) {
  if (!item) return null;
  const uid = req.mpUser?.id;
  const allowed = ALLOWED_TRANSITIONS[item.status] || [];
  return {
    id: item.id,
    issue_no: item.issue_no,
    title: item.title,
    description: item.description || '',
    deadline: item.deadline || '',
    start_time: item.start_time || '',
    status: item.status,
    status_display: item.status_display || item.status,
    participants: item.participants || [],
    participants_name: item.participants_name || [],
    created_by: item.created_by,
    created_by_name: item.created_by_name || '',
    created_at: item.created_at,
    updated_at: item.updated_at,
    completion_note: item.completion_note || '',
    completed_at: item.completed_at || '',
    reply_count: replyCount,
    next_status: allowed,
    can_advance: item.created_by === uid && allowed.length > 0,
    is_mine: item.created_by === uid || (item.participants || []).includes(uid),
    overdue: item.status === '进行中' && !!item.deadline && item.deadline < new Date().toISOString().slice(0, 10),
  };
}

function replyDto(req, r) {
  return {
    id: r.id,
    issue_id: r.issue_id,
    user_id: r.user_id,
    user_name: r.user_name || '',
    content: r.content,
    images: (r.images || []).map(v => normalizeImage(req, v)).filter(Boolean),
    created_at: r.created_at,
  };
}

function replyCounts(issueIds) {
  if (!issueIds.length) return {};
  const placeholders = issueIds.map(() => '?').join(',');
  const rows = db.queryAll(
    `SELECT issue_id, COUNT(*) AS c FROM collab_replies WHERE issue_id IN (${placeholders}) GROUP BY issue_id`,
    issueIds
  );
  return rows.reduce((acc, r) => { acc[r.issue_id] = r.c; return acc; }, {});
}

// ==================== 鉴权中间件 ====================

function mpAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: '未登录' });
  try {
    const payload = auth.verify(header.slice(7));
    const user = db.queryOne('SELECT id,username,role,display_name,phone,avatar_url FROM users WHERE id=?', [payload.id]);
    if (!user) return res.status(401).json({ error: '账号不存在' });
    req.mpUser = { ...user, identity_type: payload.identity_type, store_id: payload.store_id || null };
    req.storeScope = auth.storeScope(user); // null = 全部门店
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// ==================== 连通性自检（联调期很有用） ====================

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'zhongkong-mp-api',
    version: '0.1.0',
    time: new Date().toISOString(),
    auth: 'Bearer <mp_token>',
  });
});

// ==================== 登录 ====================

/** 前端据此渲染登录页：个人测试期只有 password（+openid），企业期自动多出 wxwork */
router.get('/auth/providers', (req, res) => {
  const available = auth.availableProviders();
  res.json({
    ok: true,
    providers: [
      { key: 'password', label: '账号密码登录', enabled: available.includes('password') },
      { key: 'openid', label: '微信授权 + 邀请码', enabled: available.includes('openid') },
      { key: 'wxwork', label: '企业微信免登', enabled: available.includes('wxwork') },
    ],
  });
});

router.post('/auth/login/:provider', async (req, res) => {
  try {
    const result = await auth.login(req.params.provider, req.body || {});
    db.save();
    res.json({ ok: true, ...result });
  } catch (e) { fail(res, e); }
});

/** 兼容 POST /api/mp/auth/login { provider, ... } 写法 */
router.post('/auth/login', async (req, res) => {
  try {
    const provider = (req.body && req.body.provider) || 'password';
    const result = await auth.login(provider, req.body || {});
    db.save();
    res.json({ ok: true, ...result });
  } catch (e) { fail(res, e); }
});

router.get('/me', mpAuth, (req, res) => {
  res.json({ ok: true, user: req.mpUser, storeScope: req.storeScope });
});

// ==================== 协同事项：一条完整链路 ====================

/** 列表（支持 status / keyword / page / pageSize，另有 onlyMine=1 只看与我相关） */
router.get('/collab/issues', mpAuth, (req, res) => {
  try {
    const { status, keyword, onlyMine } = req.query;
    const pageSize = Number(req.query.pageSize) || 20;
    const result = collabService.listIssues({
      status: status && status !== '全部' ? status : undefined,
      keyword: keyword || undefined,
      page: Number(req.query.page) || 1,
      // 只看与我相关时需要放大候选集，避免客户端分页错位
      pageSize: onlyMine === '1' || onlyMine === 'true' ? 50 : pageSize,
    }, req.mpUser);
    const counts = replyCounts(result.rows.map(r => r.id));
    let rows = result.rows.map(r => issueDto(req, r, counts[r.id] || 0));
    if (onlyMine === '1' || onlyMine === 'true') rows = rows.filter(r => r.is_mine);
    res.json({ ok: true, rows, total: result.total, page: result.page, pageSize: result.pageSize });
  } catch (e) { fail(res, e); }
});

/** 列表页顶部状态计数 */
router.get('/collab/stats', mpAuth, (req, res) => {
  try {
    const one = (sql, params = []) => db.queryOne(sql, params)?.cnt || 0;
    const overdueSql = "status='进行中' AND deadline IS NOT NULL AND deadline < date('now','localtime')";
    res.json({
      ok: true,
      stats: {
        total: one('SELECT COUNT(*) cnt FROM collab_issues'),
        pending: one("SELECT COUNT(*) cnt FROM collab_issues WHERE status='待开始'"),
        doing: one(`SELECT COUNT(*) cnt FROM collab_issues WHERE status='进行中' AND NOT (${overdueSql})`),
        done: one("SELECT COUNT(*) cnt FROM collab_issues WHERE status='已完成'"),
        undone: one("SELECT COUNT(*) cnt FROM collab_issues WHERE status='未完成'") + one(`SELECT COUNT(*) cnt FROM collab_issues WHERE ${overdueSql}`),
      },
    });
  } catch (e) { fail(res, e); }
});

/** 详情（含回复时间线） */
router.get('/collab/issues/:id', mpAuth, (req, res) => {
  try {
    const result = collabService.getIssueDetail(Number(req.params.id), req.mpUser);
    if (result.error) return res.status(404).json({ error: result.error });
    const replies = result.replies.map(r => replyDto(req, r));
    res.json({
      ok: true,
      issue: issueDto(req, result.issue, replies.length),
      replies,
    });
  } catch (e) { fail(res, e); }
});

/** 发起事项 */
router.post('/collab/issues', mpAuth, (req, res) => {
  try {
    const result = collabService.createIssue(req.body || {}, req.mpUser);
    if (result.error) return res.status(400).json({ error: result.error });
    auth.audit(req, 'collab.create', result.issue.issue_no, result.issue.title);
    db.save();
    res.status(201).json({ ok: true, issue: issueDto(req, result.issue) });
  } catch (e) { fail(res, e); }
});

/** 跟进回复（content + images[]，images 传上传接口返回的 URL，兼容旧 base64） */
router.post('/collab/issues/:id/reply', mpAuth, (req, res) => {
  try {
    const { content, images } = req.body || {};
    const result = collabUsesReplyType
      ? collabService.addReply(Number(req.params.id), content || '', images || [], 'progress', req.mpUser)
      : collabService.addReply(Number(req.params.id), content || '', images || [], req.mpUser);
    if (result.error) return res.status(400).json({ error: result.error });
    auth.audit(req, 'collab.reply', `#${req.params.id}`, String(content || '').slice(0, 100));
    db.save();
    res.status(201).json({
      ok: true,
      reply: replyDto(req, result.reply),
      issue: issueDto(req, result.issue),
    });
  } catch (e) { fail(res, e); }
});

/** 推进状态（仅发起人；状态机与 PC 端共用同一份规则） */
router.put('/collab/issues/:id/advance', mpAuth, (req, res) => {
  try {
    const { status, note } = req.body || {};
    const result = collabService.advanceStatus(Number(req.params.id), status || '', note || '', req.mpUser);
    if (result.error) return res.status(400).json({ error: result.error });
    auth.audit(req, 'collab.advance', `#${req.params.id}`, `${result.issue.status}`);
    db.save();
    res.json({ ok: true, issue: issueDto(req, result.issue), reply: replyDto(req, result.reply) });
  } catch (e) { fail(res, e); }
});

/** 可选参与人（用于发起事项时选择） */
router.get('/collab/users', mpAuth, (req, res) => {
  try {
    const users = db.queryAll('SELECT id, username, display_name, role FROM users ORDER BY id');
    res.json({ ok: true, users });
  } catch (e) { fail(res, e); }
});

/** 撤销事项：仅发起人、仅「待开始」状态（发错了能撤回；已推进的事项不可删，保证留痕） */
router.delete('/collab/issues/:id', mpAuth, (req, res) => {
  try {
    const id = Number(req.params.id);
    const issue = db.queryOne('SELECT * FROM collab_issues WHERE id=?', [id]);
    if (!issue) return res.status(404).json({ error: '事项不存在' });
    if (issue.created_by !== req.mpUser.id) return res.status(403).json({ error: '只能撤销自己发起的事项' });
    if (issue.status !== '待开始') return res.status(400).json({ error: `「${issue.status}」的事项不能撤销，仅「待开始」可撤销` });
    db.run('DELETE FROM collab_replies WHERE issue_id=?', [id]);
    db.run('DELETE FROM collab_issues WHERE id=?', [id]);
    auth.audit(req, 'collab.delete', issue.issue_no, issue.title);
    db.save();
    res.json({ ok: true, message: `事项 ${issue.issue_no} 已撤销` });
  } catch (e) { fail(res, e); }
});

// ==================== 图片上传 ====================

router.post('/upload', mpAuth, (req, res) => {
  try {
    const { data } = req.body || {};
    const saved = upload.saveDataUrl(data);
    auth.audit(req, 'upload', saved.url, `${saved.bytes} bytes`);
    res.json({ ok: true, url: absUrl(req, saved.url), path: saved.url, bytes: saved.bytes });
  } catch (e) { fail(res, e); }
});

// ==================== 门店营业数据（只读） ====================
//
// 口径说明（与 lib/daily-data.js 的 Excel 解析规则保持一致）：
//   营业额 revenue            —— 来自日报源数据
//   实收   actual_revenue     —— 日报直接提供；缺失时 = 店内+自提+美团外卖+淘宝闪购+京东外卖
//   销售渠道 5 项              —— 店内/自提/美团外卖/淘宝闪购/京东外卖（合计即实收结构）
//   堂食支付来源 6 项          —— 美团一键买单/美团团购/抖音团购/储值消费/优惠券/店内+自提收入
//                               （与渠道不是同一维度，界面上要分组展示，不能相加成"合计"）
//   客单价 = 实收 / 有效订单数
//   优惠占比 = 优惠金额 / 营业额

const CHANNELS = [
  { key: 'instore', label: '店内销售', col: 'instore' },
  { key: 'pickup', label: '自提销售', col: 'pickup' },
  { key: 'mt_waimai', label: '美团外卖', col: 'mt_waimai' },
  { key: 'tb_flash', label: '淘宝闪购', col: 'tb_flash' },
  { key: 'jd_waimai', label: '京东外卖', col: 'jd_waimai' },
];

const PAY_SOURCES = [
  { key: 'mt_pay', label: '美团一键买单', col: 'mt_pay' },
  { key: 'mt_tuan', label: '美团团购', col: 'mt_tuan' },
  { key: 'dy_tuan', label: '抖音团购', col: 'dy_tuan' },
  { key: 'stored_value', label: '储值消费', col: 'stored_value' },
  { key: 'coupon', label: '优惠券', col: 'coupon' },
];

/** 金额统一保留 2 位，避免浮点噪声 */
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;

/** 优惠占比归一化为百分数（兼容 '12.34%' / 0.1234 / 12.34 三种历史写法） */
function normalizeRate(raw, discountAmount, revenue) {
  const s = String(raw == null ? '' : raw).trim();
  if (s) {
    if (s.includes('%')) {
      const n = parseFloat(s);
      return isNaN(n) ? 0 : r2(n);
    }
    const n = parseFloat(s);
    if (!isNaN(n)) return r2(n > 1 ? n : n * 100);
  }
  if (revenue > 0 && discountAmount > 0) return r2((discountAmount / revenue) * 100);
  return 0;
}

/** 取门店名（历史导入可能没写 store_id，需要按名字兜底查询） */
function storeOf(storeId) {
  return db.queryOne('SELECT id, store_name, status, store_type, province, city, district FROM stores WHERE id=?', [storeId]);
}

/** 查询某门店某日的日报；同一门店同一天若有多条（重复导入），取最新一条 */
function fetchReport(storeId, date) {
  let row = db.queryOne('SELECT * FROM daily_reports WHERE store_id=? AND date=? ORDER BY id DESC LIMIT 1', [storeId, date]);
  if (row) return row;
  const st = storeOf(storeId);
  if (!st) return null;
  return db.queryOne('SELECT * FROM daily_reports WHERE store_name=? AND date=? ORDER BY id DESC LIMIT 1', [st.store_name, date]) || null;
}

/** 组装渠道/来源分组 */
function buildBreakdown(row) {
  const channels = CHANNELS
    .map(c => ({ key: c.key, label: c.label, value: r2(row[c.col]) }))
    .filter(x => x.value > 0)
    .sort((a, b) => b.value - a.value);

  const instorePickup = r2((Number(row.instore) || 0) + (Number(row.pickup) || 0));
  const paySources = PAY_SOURCES
    .map(c => ({ key: c.key, label: c.label, value: r2(row[c.col]) }))
    .concat([{ key: 'instore_pickup', label: '店内+自提收入', value: instorePickup }])
    .filter(x => x.value > 0)
    .sort((a, b) => b.value - a.value);

  return {
    channels,
    channel_total: r2(channels.reduce((s, x) => s + x.value, 0)),
    pay_sources: paySources,
    pay_total: r2(paySources.reduce((s, x) => s + x.value, 0)),
  };
}

/** 有数据的日期列表（倒序） */
function datesOf(storeId, limit = 30) {
  const st = storeOf(storeId);
  if (!st) return [];
  const rows = db.queryAll(
    `SELECT DISTINCT date FROM daily_reports
     WHERE (store_id=? OR store_name=?) AND date IS NOT NULL AND date != ''
     ORDER BY date DESC LIMIT ?`,
    [storeId, st.store_name, Math.min(365, Math.max(1, limit))]
  );
  return rows.map(r => r.date);
}

/** 门店列表（供选择器；默认不返回已闭店门店，可用 includeClosed=1 打开） */
router.get('/stores', mpAuth, (req, res) => {
  try {
    const includeClosed = req.query.includeClosed === '1' || req.query.includeClosed === 'true';
    const rows = db.queryAll(
      `SELECT id, store_name, status, store_type, province, city, district
       FROM stores ${includeClosed ? '' : "WHERE IFNULL(status,'') != '已闭店'"} ORDER BY id`
    );
    res.json({ ok: true, stores: rows, total: rows.length });
  } catch (e) { fail(res, e); }
});

/** 某门店有日报数据的日期（用于日期快捷选择 + 默认值 + 数据边界） */
router.get('/revenue/dates', mpAuth, (req, res) => {
  try {
    // 真实库用 business_revenue_records（405 天真实数据）；老快照回退到 daily_reports
    if (bizAvailable()) return bizDatesHandler(req, res);
    const storeId = Number(req.query.store_id);
    if (!storeId) return res.status(400).json({ error: '缺少 store_id' });
    const st = storeOf(storeId);
    if (!st) return res.status(404).json({ error: '门店不存在' });
    const dates = datesOf(storeId, Number(req.query.limit) || 30);
    res.json({ ok: true, store: { id: st.id, store_name: st.store_name }, dates, latest: dates[0] || null });
  } catch (e) { fail(res, e); }
});

/** 门店 + 日期 → 营业数据（含渠道构成与环比上一个有数据的日期） */
router.get('/revenue', mpAuth, (req, res) => {
  try {
    // 真实库用 business_revenue_records；老快照回退到 daily_reports
    if (bizAvailable()) return bizRevenueHandler(req, res);
    const storeId = Number(req.query.store_id);
    const date = String(req.query.date || '').trim();
    if (!storeId) return res.status(400).json({ error: '缺少 store_id' });
    const st = storeOf(storeId);
    if (!st) return res.status(404).json({ error: '门店不存在' });

    const dates = datesOf(storeId, 365);
    const latest = dates[0] || null;

    if (!date) {
      // 未指定日期时，直接给最近有数据的一天，前端一次请求即可出图
      if (!latest) return res.json({ ok: true, store: st, date: null, found: false, latest: null, available_dates: [] });
      const row0 = fetchReport(storeId, latest);
      return res.json(buildRevenuePayload(st, latest, row0, dates, storeId));
    }

    const row = fetchReport(storeId, date);
    if (!row) {
      return res.json({
        ok: true, store: st, date, found: false, latest, available_dates: dates.slice(0, 60),
        message: latest ? `该门店在 ${date} 没有日报数据，最近有数据的是 ${latest}` : '该门店暂无可用的日报数据',
      });
    }
    res.json(buildRevenuePayload(st, date, row, dates, storeId));
  } catch (e) { fail(res, e); }
});

/** 组装完整响应（含环比） */
function buildRevenuePayload(st, date, row, dates, storeId) {
  const revenue = r2(row.revenue);
  const actualRevenue = r2(row.actual_revenue);
  const orderCount = Number(row.order_count) || 0;
  const discountAmount = r2(row.discount_amount);
  const breakdown = buildBreakdown(row);

  // 环比：上一个"有数据的日期"，而不是自然日的前一天（跳过未填报的日子）
  const prevDate = dates.find(d => d < date);
  let compare = null;
  if (prevDate) {
    const prev = fetchReport(storeId, prevDate);
    if (prev) {
      const pRev = r2(prev.revenue);
      const pAct = r2(prev.actual_revenue);
      compare = {
        date: prevDate,
        revenue: pRev,
        actual_revenue: pAct,
        revenue_diff: r2(revenue - pRev),
        actual_diff: r2(actualRevenue - pAct),
        revenue_pct: pRev > 0 ? r2(((revenue - pRev) / pRev) * 100) : null,
        actual_pct: pAct > 0 ? r2(((actualRevenue - pAct) / pAct) * 100) : null,
      };
    }
  }

  return {
    ok: true,
    found: true,
    store: st,
    date,
    latest: dates[0] || date,
    available_dates: dates.slice(0, 60),
    prev_date: prevDate || null,
    next_date: dates.filter(d => d > date).pop() || null,
    summary: {
      revenue,
      actual_revenue: actualRevenue,
      order_count: orderCount,
      avg_order_value: orderCount > 0 ? r2(actualRevenue / orderCount) : 0,
      discount_amount: discountAmount,
      discount_rate: normalizeRate(row.discount_rate, discountAmount, revenue),
    },
    ...breakdown,
    compare,
  };
}

// ==================== 营业数据：真实数据源（business_revenue_records） ====================
//
// 口径严格照抄真实系统（F:\NewDeom 的前台 BusinessAnalytics.vue）：
//   营业额     = actual_amount + discount_amount（界面上标注"营业收入 + 优惠金额"）→ 取 SUM(gross_amount)
//   实收       = SUM(actual_amount)（界面标注"实收（营业收入）"）
//   客户优惠   = SUM(discount_amount)
//   平台费用   = 服务费 + 推广费 + 保险 + 退款
//   平台入账   = SUM(platform_income_amount)
//   ⚠️ 不自己重算 gross，直接取库里的列，保证与 PC 后台显示的数字一字不差
//      （实测约 18% 的行 gross ≠ actual + discount，属数据源本身特性，PC 后台同样如此）

const CHANNEL_GROUP_LABEL = {
  offline: '堂食（POS）',
  delivery: '外卖',
  group_buy: '团购',
  platform: '平台',
  pos: '堂食（POS）',
};

let _bizCache = null;
/** 真实营收表是否可用（缓存一次，避免每个请求都查 sqlite_master） */
function bizAvailable() {
  if (_bizCache !== null) return _bizCache;
  try {
    const t = db.queryAll("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('business_revenue_records','business_revenue_compositions')").map(r => r.name);
    _bizCache = t.includes('business_revenue_records');
  } catch { _bizCache = false; }
  return _bizCache;
}

function bizHasCompositions() {
  try {
    return db.queryAll("SELECT name FROM sqlite_master WHERE type='table' AND name='business_revenue_compositions'").length > 0;
  } catch { return false; }
}

/** 该门店有营收记录的日期（倒序） */
function bizDates(storeId, limit = 30) {
  return db.queryAll(
    'SELECT DISTINCT biz_date FROM business_revenue_records WHERE store_id=? AND biz_date IS NOT NULL AND biz_date != \'\' ORDER BY biz_date DESC LIMIT ?',
    [storeId, Math.min(500, Math.max(1, limit))]
  ).map(r => r.biz_date);
}

/** 某门店某日的汇总（一次 SQL 取全部指标） */
function bizSummary(storeId, date) {
  const s = db.queryOne(
    `SELECT COUNT(*) rows,
            IFNULL(SUM(gross_amount),0) gross,
            IFNULL(SUM(actual_amount),0) actual,
            IFNULL(SUM(discount_amount),0) discount,
            IFNULL(SUM(service_fee),0) service_fee,
            IFNULL(SUM(promotion_fee),0) promotion_fee,
            IFNULL(SUM(insurance_fee),0) insurance_fee,
            IFNULL(SUM(refund_amount),0) refund,
            IFNULL(SUM(platform_income_amount),0) platform_income,
            IFNULL(SUM(recorded_amount),0) recorded,
            IFNULL(SUM(order_count),0) orders
     FROM business_revenue_records WHERE store_id=? AND biz_date=?`,
    [storeId, date]
  );
  return s;
}

/** 组装统一 DTO：hero(summary) + metrics（指标格）+ sections（分组条形） */
function bizPayload(store, date, dates, storeId) {
  const s = bizSummary(storeId, date);
  const revenue = r2(s.gross);
  const actual = r2(s.actual);
  const discount = r2(s.discount);
  const orders = Number(s.orders) || 0;
  const platformFee = r2((Number(s.service_fee) || 0) + (Number(s.promotion_fee) || 0) + (Number(s.insurance_fee) || 0) + (Number(s.refund) || 0));

  const metrics = [
    { key: 'actual', label: '实收（营业收入）', value: actual, type: 'money' },
    { key: 'orders', label: '订单数', value: orders, type: 'int', unit: '单' },
    { key: 'avg', label: '客单价', value: orders > 0 ? r2(actual / orders) : 0, type: 'money' },
    { key: 'discount', label: '客户优惠', value: discount, type: 'money',
      sub: revenue > 0 ? `优惠占比 ${r2((discount / revenue) * 100)}%` : '' },
    { key: 'platform_fee', label: '平台费用', value: platformFee, type: 'money', sub: '服务费/推广费/保险/退款' },
    { key: 'platform_income', label: '平台入账', value: r2(s.platform_income), type: 'money' },
  ];

  // ---- 分组 1：渠道大类 ----
  const groups = db.queryAll(
    `SELECT IFNULL(NULLIF(channel_group,''),'unknown') k,
            IFNULL(SUM(gross_amount),0) gross, IFNULL(SUM(actual_amount),0) actual, COUNT(*) c
     FROM business_revenue_records WHERE store_id=? AND biz_date=? GROUP BY k ORDER BY gross DESC`,
    [storeId, date]
  ).map(x => ({
    key: x.k,
    label: CHANNEL_GROUP_LABEL[x.k] || x.k,
    value: r2(x.gross),
    sub: `实收 ¥${r2(x.actual).toLocaleString('zh-CN', { minimumFractionDigits: 2 })} · ${x.c} 条`,
  }));

  // ---- 分组 2：平台明细 ----
  const platforms = db.queryAll(
    `SELECT IFNULL(NULLIF(platform,''),'（无平台标识）') k,
            IFNULL(SUM(gross_amount),0) gross, IFNULL(SUM(actual_amount),0) actual, COUNT(*) c
     FROM business_revenue_records WHERE store_id=? AND biz_date=? GROUP BY k ORDER BY gross DESC`,
    [storeId, date]
  ).map(x => ({
    key: x.k,
    label: x.k,
    value: r2(x.gross),
    sub: `实收 ¥${r2(x.actual).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}（${x.c} 条）`,
  }));

  const sections = [];
  sections.push({ key: 'channel_group', title: '渠道构成', unit: '营业额', total: r2(groups.reduce((a, b) => a + b.value, 0)), items: groups });
  sections.push({ key: 'platform', title: '平台明细', unit: '营业额', total: r2(platforms.reduce((a, b) => a + b.value, 0)), items: platforms });

  // ---- 分组 3：营收构成（支付/来源维度）----
  if (bizHasCompositions()) {
    const comp = db.queryAll(
      `SELECT category k, IFNULL(SUM(amount),0) amt, COUNT(*) c
       FROM business_revenue_compositions WHERE store_id=? AND biz_date=? GROUP BY k ORDER BY amt DESC`,
      [storeId, date]
    ).map(x => ({ key: x.k, label: x.k, value: r2(x.amt), sub: `${x.c} 条` }));
    if (comp.length) {
      sections.push({ key: 'composition', title: '营收构成（收款/来源）', unit: '金额', total: r2(comp.reduce((a, b) => a + b.value, 0)), items: comp });
    }
  }

  // ---- 环比：上一个有数据的日期 ----
  const prevDate = dates.find(d => d < date);
  let compare = null;
  if (prevDate) {
    const p = bizSummary(storeId, prevDate);
    const pRev = r2(p.gross);
    const pAct = r2(p.actual);
    compare = {
      date: prevDate,
      revenue: pRev,
      actual_revenue: pAct,
      revenue_diff: r2(revenue - pRev),
      actual_diff: r2(actual - pAct),
      revenue_pct: pRev > 0 ? r2(((revenue - pRev) / pRev) * 100) : null,
      actual_pct: pAct > 0 ? r2(((actual - pAct) / pAct) * 100) : null,
    };
  }

  return {
    ok: true,
    found: true,
    source: 'business_revenue_records',
    store,
    date,
    latest: dates[0] || date,
    available_dates: dates.slice(0, 60),
    prev_date: prevDate || null,
    next_date: dates.filter(d => d > date).pop() || null,
    summary: {
      revenue,
      actual_revenue: actual,
      order_count: orders,
      avg_order_value: orders > 0 ? r2(actual / orders) : 0,
      discount_amount: discount,
      discount_rate: revenue > 0 ? r2((discount / revenue) * 100) : 0,
      platform_fee: platformFee,
      platform_income: r2(s.platform_income),
      recorded_amount: r2(s.recorded),
      rows: s.rows,
    },
    metrics,
    sections,
    channels: groups,
    channel_total: r2(groups.reduce((a, b) => a + b.value, 0)),
    compare,
  };
}

/** /api/mp/revenue/dates 的真实数据源实现 */
function bizDatesHandler(req, res) {
  const storeId = Number(req.query.store_id);
  if (!storeId) return res.status(400).json({ error: '缺少 store_id' });
  const st = storeOf(storeId);
  if (!st) return res.status(404).json({ error: '门店不存在' });
  const dates = bizDates(storeId, Number(req.query.limit) || 30);
  res.json({ ok: true, source: 'business_revenue_records', store: { id: st.id, store_name: st.store_name }, dates, latest: dates[0] || null });
}

/** /api/mp/revenue 的真实数据源实现 */
function bizRevenueHandler(req, res) {
  const storeId = Number(req.query.store_id);
  const date = String(req.query.date || '').trim();
  if (!storeId) return res.status(400).json({ error: '缺少 store_id' });
  const st = storeOf(storeId);
  if (!st) return res.status(404).json({ error: '门店不存在' });

  const dates = bizDates(storeId, 500);
  const latest = dates[0] || null;

  // 首选：复用真实后台的对账口径（businessAnalytics.getOverview）
  if (businessAnalytics && typeof businessAnalytics.getOverview === 'function') {
    return analyticsRevenueHandler(req, res, st, storeId, date, dates, latest);
  }

  if (!date) {
    if (!latest) {
      return res.json({ ok: true, source: 'business_revenue_records', found: false, store: st, date: null, latest: null, available_dates: [], message: '该门店暂无营收数据' });
    }
    return res.json(bizPayload(st, latest, dates, storeId));
  }

  if (!dates.includes(date)) {
    return res.json({
      ok: true, source: 'business_revenue_records', found: false, store: st, date, latest,
      available_dates: dates.slice(0, 60),
      message: latest ? `该门店在 ${date} 没有营收记录，最近有数据的是 ${latest}` : '该门店暂无营收数据',
    });
  }

  res.json(bizPayload(st, date, dates, storeId));
}

/**
 * 走真实后台 analytics 的营业数据实现
 * —— 一律调用 businessAnalytics.getOverview(db, { date_from, date_to, store_id }) 取数，
 *    不自己 SUM，保证与 PC 后台显示的营业额/实收/优惠/费用完全一致。
 */
function analyticsRevenueHandler(req, res, st, storeId, date, dates, latest) {
  const target = date || latest;
  if (!target) {
    return res.json({
      ok: true, source: 'business_analytics', found: false, store: st, date: null,
      latest: null, available_dates: [], message: '该门店暂无营收数据',
    });
  }
  if (date && !dates.includes(date)) {
    return res.json({
      ok: true, source: 'business_analytics', found: false, store: st, date, latest,
      available_dates: dates.slice(0, 60),
      message: latest ? `该门店在 ${date} 没有营收记录，最近有数据的是 ${latest}` : '该门店暂无营收数据',
    });
  }

  const params = { date_from: target, date_to: target, store_id: storeId };
  const ov = businessAnalytics.getOverview(db, params);

  const prevDate = dates.find(d => d < target) || null;
  let compareOv = null;
  if (prevDate) {
    try { compareOv = businessAnalytics.getOverview(db, { date_from: prevDate, date_to: prevDate, store_id: storeId }); } catch { compareOv = null; }
  }
  const nextDate = dates.filter(d => d > target).pop() || null;

  res.json(revenueMap.mapOverviewToMobile(ov, {
    store: st, date: target, dates, prevDate, nextDate, compareOv,
  }));
}

module.exports = router;
