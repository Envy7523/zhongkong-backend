/**
 * 前端权限码目录：与后端 lib/permissions.js 的 PERMISSION_CATALOG 保持同一套编码。
 * 这里只放"键"，中文说明由后端目录渲染到岗位设置界面，避免两处各写一份文案。
 */

export const PERMISSION_KEYS = [
  'dashboard.view',
  'analysis.view',
  'store.manage',
  'store-preparation.manage',
  'menu.manage',
  'cost.manage',
  'staff.view',
  'collab.manage',
  'bookkeeping.manage',
  'data-import.manage',
  'pipeline.manage',
  'ai-assistant.view',
  'db-viewer.view',
  'enterprise-settings.manage',
  'users.manage',
  'positions.manage',
  'settings.manage',
]

// 左侧导航分组 → 需要的权限码（组内任一命中即显示该组）
export const NAV_GROUP_PERMISSIONS = {
  dashboard: ['dashboard.view'],
  'core-business': ['analysis.view', 'store.manage', 'store-preparation.manage', 'menu.manage', 'cost.manage', 'staff.view'],
  'operation-tools': ['collab.manage', 'bookkeeping.manage', 'data-import.manage', 'pipeline.manage', 'ai-assistant.view'],
  system: ['db-viewer.view', 'enterprise-settings.manage', 'users.manage', 'positions.manage', 'settings.manage'],
}

// 菜单项 index → 需要的权限码
export const NAV_ITEM_PERMISSIONS = {
  dashboard: 'dashboard.view',
  'analysis-group': 'analysis.view',
  'store-management-group': 'store.manage',
  'store-preparation-group': 'store-preparation.manage',
  'menu-management-group': 'menu.manage',
  'cost-accounting-group': 'cost.manage',
  'staff-management-group': 'staff.view',
  'collab-list': 'collab.manage',
  'bookkeeping-entry': 'bookkeeping.manage',
  'data-import-group': 'data-import.manage',
  pipeline: 'pipeline.manage',
  'ai-assistant': 'ai-assistant.view',
  'db-viewer': 'db-viewer.view',
  'enterprise-settings': 'enterprise-settings.manage',
  'user-management': 'users.manage',
  'position-settings': 'positions.manage',
  settings: 'settings.manage',
}

/** 权限判断：'*' 放行一切 */
export function permits(permissions, code) {
  const list = Array.isArray(permissions) ? permissions : []
  if (list.includes('*')) return true
  if (!code) return true
  return list.includes(code)
}

/** 分组下是否有任意一个可访问的项 */
export function permitsAny(permissions, codes) {
  const list = Array.isArray(codes) ? codes : [codes]
  return list.some(code => permits(permissions, code))
}
