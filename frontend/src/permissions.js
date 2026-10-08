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
  'staff.view', 'staff.store.edit', 'payroll.view', 'payroll.prepare', 'payroll.attendance', 'payroll.review',
  'collab.manage',
  'store-tasks.manage', 'store-tasks.execute', 'store-tasks.review',
  'bookkeeping.manage',
  'data-import.manage',
  'pipeline.manage',
  'ai-assistant.view',
  'notifications.view',
  'notifications.rules',
  'db-viewer.view',
  'enterprise-settings.manage',
  'users.manage',
  'positions.manage',
  'settings.manage',
]

// 左侧导航分组 → 需要的权限码（组内任一命中即显示该组）
export const NAV_GROUP_PERMISSIONS = {
  dashboard: ['dashboard.view'],
  'core-business': ['analysis.view', 'store.manage', 'store-preparation.manage', 'menu.manage', 'cost.manage', 'staff.view', 'staff.store.edit', 'payroll.view', 'payroll.prepare', 'payroll.attendance', 'payroll.review'],
  'operation-tools': ['collab.manage', 'store-tasks.manage', 'store-tasks.execute', 'store-tasks.review', 'bookkeeping.manage', 'data-import.manage', 'pipeline.manage', 'ai-assistant.view', 'notifications.view'],
  system: ['db-viewer.view', 'enterprise-settings.manage', 'users.manage', 'positions.manage', 'settings.manage', 'notifications.rules'],
}

// 菜单项 index → 需要的权限码
export const NAV_ITEM_PERMISSIONS = {
  dashboard: 'dashboard.view',
  'analysis-group': 'analysis.view',
  'store-management-group': 'store.manage',
  'store-preparation-group': 'store-preparation.manage',
  'menu-management-group': 'menu.manage',
  'cost-accounting-group': 'cost.manage',
  'staff-management-group': ['staff.view', 'staff.store.edit', 'payroll.view', 'payroll.prepare', 'payroll.attendance', 'payroll.review'],
  'collab-list': 'collab.manage',
  'store-tasks': ['store-tasks.manage','store-tasks.execute','store-tasks.review'],
  'bookkeeping-entry': 'bookkeeping.manage',
  'data-import-group': 'data-import.manage',
  pipeline: 'pipeline.manage',
  'ai-assistant': 'ai-assistant.view',
  notifications: 'notifications.view',
  'notification-rules': 'notifications.rules',
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
  if (!code || code === 'notifications.view') return true
  if (Array.isArray(code)) return code.some(item => permits(list, item))
  return list.includes(code)
}

/** 分组下是否有任意一个可访问的项 */
export function permitsAny(permissions, codes) {
  const list = Array.isArray(codes) ? codes : [codes]
  return list.some(code => permits(permissions, code))
}
