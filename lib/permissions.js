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
  '/api/positions',
  '/api/store-models/maintenance',
];

// 前缀 -> 权限码。更长前缀优先；同长度时"带方法限定"的规则优先于不限方法的规则。
// 只读放行必须用 readOnlyAccess() 生成：它会自动补一条"其余方法归管理权限"的规则，
// 否则 POST/PUT/DELETE 会因为没有任何规则命中而被放行（这个坑踩过一次）。
const readOnlyAccess = prefix => [[prefix, null, 'GET'], [prefix, 'store.manage']];

const PERMISSION_RULES = [
  // ===== 总览 =====
  ['/api/dashboard', 'dashboard.view'],

  // ===== 核心业务 =====
  ['/api/business-analytics', 'analysis.view'],
  ['/api/analysis', 'analysis.view'],
  ['/api/dish-sales', 'analysis.view'],

  // 门店「查询 / 聚合读」放行（登录即可）：门店清单与区域是 12+ 个功能共用的下拉数据源
  // （每日总结、经营分析、菜品核算、人事、记账、推送中心、月看板…），
  // 按管理权限拦截会让有权限的功能因为拿不到门店列表而整块空白。
  ...readOnlyAccess('/api/store-regions'),
  ...readOnlyAccess('/api/store-platforms'),
  ...readOnlyAccess('/api/db/stores'),
  ['/api/stores/province-stats', null, 'GET'],
  ['/api/stores/city-stats', null, 'GET'],
  ['/api/stores/district-stats', null, 'GET'],
  ['/api/stores/locations', null, 'GET'],
  ['/api/stores/province-stats', 'store.manage'],
  ['/api/stores/city-stats', 'store.manage'],
  ['/api/stores/district-stats', 'store.manage'],
  ['/api/stores/locations', 'store.manage'],
  // 3D 模型文件读取归筹建门店能力（3D 页面取模型走这条；模型库管理仍在下面）
  ['/api/stores/:id/model', 'store-preparation.manage', 'GET'],
  ['/api/store-models', 'store-preparation.manage'],
  ['/api/store-models/maintenance', '*'],
  ['/api/map-pins', 'store.manage'],
  ['/api/fixed-costs', 'store.manage'],
  ['/api/operating-costs', 'store.manage'],

  // 单店详情、平台、在职员工：GET 放行（3D、评论区等都要读门店），写操作仍归门店管理
  ...readOnlyAccess('/api/stores/:id/platforms'),
  ...readOnlyAccess('/api/stores/:id/employees'),
  ...readOnlyAccess('/api/stores/:id'),
  ['/api/stores/:storeId/comments', 'store.manage'],
  ['/api/stores', 'store.manage'],

  ['/api/menu', 'menu.manage'],
  ['/api/menu-categories', 'menu.manage'],
  ['/api/menu-category', 'menu.manage'],
  ['/api/menu-templates', 'menu.manage'],
  ['/api/poultry', 'menu.manage'],
  ['/api/cost-accounting', 'cost.manage'],
  ['/api/staff', 'staff.view'],
  ['/api/payroll', 'staff.view'],
  ['/api/payroll-sheets', 'staff.view'],
  ['/api/employees', 'staff.view'],

  // ===== 运营工具 =====
  ['/api/collab', 'collab.manage'],
  ['/api/bookkeeping', 'bookkeeping.manage'],
  ['/api/reports', 'data-import.manage'],
  ['/api/supplies', 'data-import.manage'],
  // 推送（日报卡片预览与发送到企微群）属于敏感动作，归一键推送权限
  ['/api/push', 'pipeline.manage'],
  ['/api/pipeline', 'pipeline.manage'],
  ['/api/push-logs', 'pipeline.manage'],
  ['/api/webhook', 'pipeline.manage'],
  ['/api/wechat', 'pipeline.manage'],
  ['/api/ai', 'ai-assistant.view'],

  // ===== 系统管理 =====
  ['/api/db-viewer', 'db-viewer.view'],
  ['/api/enterprise-settings', 'enterprise-settings.manage'],
  ['/api/bot', 'enterprise-settings.manage'],
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
    { key: 'cost.manage', label: '成本核算' },
    { key: 'staff.view', label: '人事专区' },
  ] },
  { key: 'operation-tools', label: '运营工具', description: '左侧导航 · 运营工具', items: [
    { key: 'collab.manage', label: '协同事项' },
    { key: 'bookkeeping.manage', label: '记账本' },
    { key: 'data-import.manage', label: '数据导入' },
    { key: 'pipeline.manage', label: '一键推送' },
    { key: 'ai-assistant.view', label: 'AI 助手' },
  ] },
  { key: 'system', label: '系统管理', description: '左侧导航 · 系统管理', items: [
    { key: 'db-viewer.view', label: '数据库查看' },
    { key: 'enterprise-settings.manage', label: '企业设置' },
    { key: 'users.manage', label: '人员管理' },
    { key: 'positions.manage', label: '岗位设置' },
    { key: 'settings.manage', label: '网页设置' },
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
 * 规则形如 [前缀, 权限码或null, 可选HTTP方法]：
 *  - 前缀更长者优先；
 *  - 前缀等长时，带方法限定的规则优先于不限方法的规则，
 *    因此 ['/api/db/stores', null, 'GET'] 只放行读，写仍走 ['/api/db/stores', 'store.manage']。
 */
function requiredPermission(pathname, method) {
  const path = String(pathname || '');
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

    const user = getUserById(req.user?.id);
    const permissions = normalizePermissions(user?.permissions_json);
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
