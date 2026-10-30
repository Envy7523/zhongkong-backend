/**
 * 岗位功能权限：权限码目录 + 接口映射 + 服务端强制校验中间件
 *
 * 设计要点：
 * 1. 权限码目录（PERMISSION_CATALOG）是唯一事实来源，岗位设置界面直接复用它渲染勾选项，
 *    避免"界面有这一项、后端不认"或反过来的漂移。
 * 2. 接口映射用「最长前缀匹配」：命中第一条最具体的规则即返回其权限码；
 *    没有命中任何规则的 /api 接口视为不需要额外权限（只要登录）。
 *    新增接口时若属于已收录的模块，会自动继承该模块权限；否则是开放接口。
 * 3. 认证、当前用户信息、企业微信回调属于登录前或登录自身能力，必须放行。
 * 4. 岗位维护（/api/positions 的写操作、岗位分配）只有系统管理员可做。
 */

const ALWAYS_ALLOWED = [
  '/api/auth/login',
  '/api/mp/auth',
];

// 只有系统管理员（权限含 *）可访问
const ADMIN_ONLY = [
  '/api/users',
  '/api/access',
  '/api/operation-audit',
  '/api/settings',
  '/api/config',
  '/api/notifications/settings',
  '/api/enterprise-settings/wecom-routing',
  '/api/enterprise-settings/api-registry',
  '/api/bot',
  '/api/wechat/token',
  '/api/business-ledger/integrations',
  '/api/enterprise-settings/schedule',
  '/api/enterprise-settings/report-sync-plans',
  '/api/positions',
  '/api/db-viewer',
  '/api/store-models/maintenance',
];

// 前缀 -> 权限码。更长前缀优先；同长度时"带方法限定"的规则优先于不限方法的规则。
// 只列"需要强制校验"的接口；业务模块不在此列（改动由菜单与路由守卫控制，见 requiredPermission 注释）。
const PERMISSION_RULES = [
  ['/api/collab','collab.manage'],
  // Analysis subqueries also run independently of their parent view. Their
  // store rows are constrained by personnel-access (media checks ownership).
  ['/api/business-analytics/products', 'analysis.view', 'GET'],
  ['/api/business-analytics/order-insights', 'analysis.view', 'GET'],
  ['/api/business-analytics/meituan-reviews', 'analysis.view', 'GET'],
  ['/api/business-analytics/douyin-reviews', 'analysis.view', 'GET'],
  ['/api/business-analytics/douyin-review-media', 'analysis.view', 'GET'],
  // Delivery classification belongs to data analysis, even though its legacy URL
  // lives under enterprise-settings. Keep all other enterprise settings protected.
  ['/api/enterprise-settings/delivery-fee-rules', 'analysis.view'],
  ['/api/bookkeeping/expense-tags', 'bookkeeping.manage'],
  ['/api/analysis-agents', 'analysis.view'],
  ['/api/staff', 'staff.view'],
  // 门店凭证（闭店通知 / 租约 / 迁址协议）的存取：与员工附件同级的显式权限码。
  // 注意 /api/db/stores 故意不在此列 —— 门店清单是十几个功能共用的下拉数据源，
  // 按模块拦接口会让有权限的功能整块空白（见本文件顶部的分层策略说明）。
  ['/api/store-attachments', 'store.manage'],
  ['/api/notifications/settings', 'notifications.rules'],
  ['/api/notifications', 'notifications.view'],
  // 营业数据导入接口：从"登录即可"收紧为显式权限码。
  // 仅对 POST 生效（GET /api/business-analytics/import-batches 不受影响：前缀后接 "-batches"，
  // 不满足 pathMatches 的 (?:/|$) 边界，故不会命中本规则）。
  // 授权现状：系统管理员('*') 与 岗位「运营专员」（已显式授予 business_analytics.import）可继续人工导入；
  // 自动化身份 syncbot_importer 仅持有该权限码。
  ['/api/business-analytics/import', 'business_analytics.import', 'POST'],
  ['/api/bookkeeping/pos-daily-import', 'business_analytics.import', 'POST'],
  ['/api/bookkeeping/pos-daily-import', 'business_analytics.import', 'GET'],
  // ===== 系统管理（仍强制校验）=====
  ['/api/db-viewer', 'db-viewer.view'],
  ['/api/enterprise-settings', 'enterprise-settings.manage'],
  ['/api/bot', 'enterprise-settings.manage'],
  ['/api/wechat/token', 'enterprise-settings.manage'],
  ['/api/users', 'users.manage'],
  ['/api/settings', 'settings.manage'],
  ['/api/config', 'settings.manage'],
  ['/api/geocode', 'settings.manage'],
  ['/api/amap', 'settings.manage'],
];

// 岗位设置界面用的权限目录：与左侧导航一一对应。
const PERMISSION_CATALOG = [
  { key: 'overview', label: '总览', description: '左侧导航 · 总览', items: [
    { key: 'dashboard.view', label: '数据概括' },
  ] },
  { key: 'core-business', label: '核心业务', description: '左侧导航 · 核心业务', items: [
    { key: 'analysis.view', label: '数据分析' },
    { key: 'store.manage', label: '门店管理' },
    { key: 'store-preparation.manage', label: '筹建门店（3D 渲染复用门店模型接口，需同时具备门店管理）' },
    { key: 'menu.manage', label: '菜品管理' },
    { key: 'staff.view', label: '人事专区（完整员工档案）' },
    { key: 'staff.store.edit', label: '本店员工录入与编辑（须绑定门店）' },
    { key: 'payroll.view', label: '工资表查看' },
    { key: 'payroll.prepare', label: '工资表制作与提交' },
    { key: 'payroll.attendance', label: '集团与门店月出勤管理' },
    { key: 'payroll.review', label: '工资审核（不可审核本人提交）' },
    { key: 'payroll.publish', label: '工资条发布与签收管理（须全工资范围）' },
    { key: 'finance.payments.manage', label: '财务付款执行（按负责门店）' },
  ] },
  { key: 'operation-tools', label: '运营工具', description: '左侧导航 · 运营工具', items: [
    { key: 'inventory.view', label: '门店库存查看' },
    { key: 'inventory.business', label: '营业用料范围' },
    { key: 'inventory.staff_meal', label: '员工餐用料范围' },
    { key: 'inventory.receive', label: '库存收货与出入单填报' },
    { key: 'inventory.close', label: '每日收档耗用与实盘填报' },
    { key: 'inventory.confirm', label: '库存单据确认与盘点调整' },
    { key: 'inventory.transfer', label: '营业员工餐转料与借还' },
    { key: 'inventory.configure', label: '库存物料档案维护（全部负责范围）' },
    { key: 'store-reports.submit', label: '问题申报与跟进（小程序）' },
    { key: 'store-reports.view', label: '申报记录查询（按负责门店）' },
    { key: 'learning.view', label: '学习资料查看（小程序）' },
    { key: 'knowledge.edit', label: '知识库编辑与学习记录查询' },
    { key: 'knowledge.publish', label: '知识库发布与下架' },
    { key: 'collab.manage', label: '协同事项' },
    { key: 'inspections.view', label: '巡检报告与整改进度查看' },
    { key: 'inspections.submit', label: '巡检报告编辑、拆解与下发' },
    { key: 'inspections.assign', label: '巡检整改人员分配' },
    { key: 'inspections.execute', label: '执行本人巡检整改项' },
    { key: 'inspections.review', label: '巡检整改复核' },
    { key: 'store-tasks.manage', label: '门店任务项目编辑与下发' },
    { key: 'store-tasks.execute', label: '门店任务共同填写（最终提交由负责人完成）' },
    { key: 'mini-duty.assign', label: '指定当班人（仅小程序）' },
    { key: 'mini-staff.transfer', label: '员工调店发起与签收（仅小程序、本人店长范围）' },
    { key: 'staff.onboarding.view', label: '入职申请过程与结果查看（后台）' },
    { key: 'mini-staff.invite', label: '本店员工邀请入职与确认（小程序店长）' },
    { key: 'mini-staff.offboard', label: '本店员工离职登记（小程序店长，无上级审批）' },
    { key: 'staff.offboarding.view', label: '离职交接记录查看与本人环节办理（后台）' },
    { key: 'mini-staff.profile.view', label: '本店员工资料查看（小程序店长，只读）' },
    { key: 'mini-staff.support.request', label: '请求员工支援（小程序，按申请门店范围）' },
    { key: 'staff.support.view', label: '员工支援申请过程与结果查询（后台只读）' },
    { key: 'staff.transfers.view', label: '调店过程与结果查询（后台只读）' },
    { key: 'workflow.manage', label: '审批流程配置（后台、全门店范围）' },
    { key: 'workflow.start', label: '发起自定义流程申请（按负责门店）' },
    { key: 'workflow.view', label: '审批记录查询（按负责门店）' },
    { key: 'workflow.execute', label: '审批通过后确认执行（人事后台）' },
    { key: 'store-manager.identity', label: '正式店长职责（需总部任命，按岗位门店范围生效）' },
    { key: 'staff.profile.hr', label: '人事档案职责（仍须字段及门店授权）' },
    { key: 'staff.profile.finance', label: '财务结算职责（仍须字段及门店授权）' },
    { key: 'staff.training.manage', label: '直属督导培训派发、续期与归回' },
    { key: 'staff.training.configure', label: '设置实习店长所属门店和直属督导' },
    { key: 'staff.training.view', label: '培训记录查看与知会（按所属门店）' },
    { key: 'staff.hq.manage', label: '总部储备人员调动、店长任命与生效处理' },
    { key: 'store-notices.manage', label: '门店公告发布、回执查询与自动提醒设置' },
    { key: 'store-tasks.review', label: '门店任务审核' },
    { key: 'bookkeeping.manage', label: '记账本' },
    { key: 'data-import.manage', label: '数据导入' },
    { key: 'business_analytics.import', label: '营业数据导入（接口调用 / 自动化）' },
    { key: 'pipeline.manage', label: '一键推送' },
    { key: 'ai-assistant.view', label: 'AI 助手' },
    { key: 'notifications.view', label: '消息通知（所有角色默认可收发）' },
  ] },
  { key: 'system', label: '管理员专区', description: '仅系统管理员使用', items: [
    { key: 'enterprise-settings.manage', label: '企业设置' },
    { key: 'users.manage', label: '人员账号（仅管理员）' },
    { key: 'positions.manage', label: '岗位设置（仅管理员）' },
    { key: 'settings.manage', label: '网页设置' },
    { key: 'notifications.rules', label: '通知规则' },
  ] },
];

const ALL_PERMISSION_KEYS = PERMISSION_CATALOG.flatMap(group => group.items.map(item => item.key));

function permissionLabel(code) {
  for (const group of PERMISSION_CATALOG) {
    const found = group.items.find(item => item.key === code);
    if (found) return found.label;
  }
  return code;
}

// 路径匹配：前缀语义 + 支持 Express 的 :param 段。
// 例：/api/stores/:id 能匹配 /api/stores/9（:param 只吃一段，不吃斜杠）。
const PATH_PATTERN_CACHE = new Map();
function pathMatches(pathname, prefix) {
  let pattern = PATH_PATTERN_CACHE.get(prefix);
  if (!pattern) {
    const source = String(prefix)
      .split('/')
      .map(segment => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/');
    pattern = new RegExp(`^${source}(?:/|$)`);
    PATH_PATTERN_CACHE.set(prefix, pattern);
  }
  return pattern.test(String(pathname));
}

/**
 * 取某条请求需要的权限码；返回 null 表示"登录即可"。
 *
 * 分层策略（2026-09-16 起）：
 *  - 业务接口默认**登录即可**。功能边界的控制在进入前完成：左侧菜单与路由守卫按岗位过滤，
 *    没有权限的模块进不去，因此不再按模块拦接口——否则会把门店清单这类
 *    「12+ 个功能共用的下拉数据源」一起拦掉，导致有权限的功能整块空白。
 *  - 仅"系统管理"组（岗位/人员/数据库查看/企业设置/网页设置）仍强制校验，
 *    因为这些能力在多个页面里都可能触发，不能只靠页面可见性兜底。
 *  - 仅系统管理员（'*'）可执行：岗位维护、用户维护、模型磁盘清理。
 *
 * 规则形如 [前缀, 权限码或null, 可选HTTP方法]：
 *  - 前缀更长者优先；
 *  - 前缀等长时，带方法限定的规则优先于不限方法的规则。
 */
function requiredPermission(pathname, method) {
  const path = String(pathname || '');
  if(pathMatches(path,'/api/business-analytics/sync-runs')&&!pathMatches(path,'/api/business-analytics/sync-runs/bookkeeping-review'))return '*';
  if (ADMIN_ONLY.some(prefix => pathMatches(path, prefix))) return '*';
  const verb = String(method || 'GET').toUpperCase();
  let best = null;
  let bestLength = -1;
  let bestMethodSpecific = false;
  for (const [prefix, code, ruleMethod] of PERMISSION_RULES) {
    if (!pathMatches(path, prefix)) continue;
    const methodSpecific = Boolean(ruleMethod) && String(ruleMethod).toUpperCase() === verb;
    if (ruleMethod && !methodSpecific) continue;
    const length = prefix.length;
    if (length > bestLength || (length === bestLength && methodSpecific && !bestMethodSpecific)) {
      best = code; bestLength = length; bestMethodSpecific = methodSpecific;
    }
  }
  return best;
}

function normalizePermissions(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(item => String(item || '').trim()).filter(Boolean) : [];
    } catch { return []; }
  }
  return [];
}

/** 权限判断：'*' 放行一切；否则要求命中指定权限码 */
function can(permissions, code) {
  const list = normalizePermissions(permissions);
  if (require('./common-capabilities').isCommon(code)) return true;
  if (list.includes('*')) return true;
  if (!code) return true;
  if (code === '*') return false; // 仅系统管理员
  return list.includes(code);
}

function isPublicPath(pathname) {
  const path = String(pathname || '');
  return ALWAYS_ALLOWED.some(prefix => pathMatches(path, prefix));
}

/**
 * 创建强制校验中间件。
 * @param {object} deps
 * @param {(id:number)=>object|null} deps.getUserById 读取用户（需带 permissions_json）
 * @param {(permissions:string[])=>boolean} deps.hasFullAccess 是否是系统管理员岗位
 */
function createGuard({ getUserById, hasFullAccess }) {
  return function positionPermissionGuard(req, res, next) {
    const pathname = req.path || req.originalUrl || '';
    if (isPublicPath(pathname)) return next();
    const required = requiredPermission(pathname, req.method);
    if (!required) return next(); // 未收录的接口：登录即可

    // 安全兜底：没有登录态时**绝不**把 undefined 交给 getUserById ——
    // sql.js 会因绑定 undefined 抛错（stmt.bind），把本应 401 的请求变成 500。
    // 这里明确返回 401，与 server.js 的 JWT 中间件口径保持一致。
    if (!req.user || req.user.id === undefined || req.user.id === null) {
      return res.status(401).json({ error: '未登录' });
    }

    const user = getUserById(req.user?.id);
    if (!user) return res.status(401).json({ error: '账号不存在或已删除' });
    const permissions = normalizePermissions(user?.permissions_json);
    if(required==='collab.manage'&&!permissions.includes('*')&&!permissions.includes(required)&&!require('./common-capabilities').forUser(user,permissions).length)return res.status(403).json({error:'采集导入身份不能使用人员协作功能'});
    if (can(permissions, required)) return next();

    // 岗位设置等管理员能力：明确提示，避免误判为登录失效
    if (required === '*' || !hasFullAccess({ permissions_json: JSON.stringify(permissions), position_permissions: permissions })) {
      if (required === '*') return res.status(403).json({ error: '仅系统管理员岗位可执行该操作' });
    }
    const label = permissionLabel(required);
    return res.status(403).json({ error: `当前岗位没有「${label}」权限，请联系系统管理员开通` });
  };
}

module.exports = {
  PERMISSION_CATALOG,
  ALL_PERMISSION_KEYS,
  PERMISSION_RULES,
  ADMIN_ONLY,
  ALWAYS_ALLOWED,
  requiredPermission,
  normalizePermissions,
  can,
  createGuard,
  permissionLabel,
};
