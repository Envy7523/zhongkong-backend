/**
 * 前端权限码目录：与后端 lib/permissions.js 的 PERMISSION_CATALOG 保持同一套编码。
 * 这里只放"键"，中文说明由后端目录渲染到岗位设置界面，避免两处各写一份文案。
 */

export const PERMISSION_KEYS = [
  'inventory.view','inventory.business','inventory.staff_meal','inventory.receive','inventory.close','inventory.confirm','inventory.transfer','inventory.configure',
  'workflow.start','workflow.manage', 'workflow.view', 'workflow.execute','staff.hq.manage','store-manager.identity',
  'dashboard.view',
  'analysis.view',
  'store.manage',
  'store-preparation.manage',
  'menu.manage',
  'staff.view', 'staff.store.edit', 'payroll.view', 'payroll.prepare', 'payroll.attendance', 'payroll.review','payroll.publish','finance.payments.manage',
  'collab.manage',
  'inspections.view','inspections.submit','inspections.assign','inspections.execute','inspections.review',
  'store-reports.submit', 'store-reports.view', 'mini-staff.transfer', 'staff.transfers.view','staff.support.view','staff.offboarding.view','staff.onboarding.view', 'store-notices.manage', 'learning.view', 'knowledge.edit', 'knowledge.publish', 'store-tasks.manage', 'store-tasks.execute', 'store-tasks.review',
  'bookkeeping.manage',
  'data-import.manage',
  'pipeline.manage',
  'ai-assistant.view',
  'notifications.view',
  'notifications.rules',
  'enterprise-settings.manage',
  'users.manage',
  'positions.manage',
  'settings.manage',
]

// 左侧导航分组 → 需要的权限码（组内任一命中即显示该组）
export const NAV_GROUP_PERMISSIONS = {
  dashboard: ['dashboard.view'],
  'core-business': ['payroll.publish','analysis.view', 'store.manage', 'store-preparation.manage', 'menu.manage', 'staff.view', 'staff.store.edit', 'payroll.view', 'payroll.prepare', 'payroll.attendance', 'payroll.review'],
  'operation-tools': ['inventory.view','inspections.view','inspections.submit','inspections.assign','inspections.execute','inspections.review','store-reports.view','staff.hq.manage','workflow.start','workflow.manage','workflow.view','workflow.execute','staff.transfers.view','staff.support.view','staff.offboarding.view','staff.onboarding.view','store-notices.manage','knowledge.edit','collab.manage', 'store-tasks.manage', 'store-tasks.execute', 'store-tasks.review', 'bookkeeping.manage', 'data-import.manage', 'pipeline.manage', 'ai-assistant.view', 'notifications.view'],
  system: ['enterprise-settings.manage', 'users.manage', 'positions.manage', 'settings.manage', 'notifications.rules'],
}

// 菜单项 index → 需要的权限码
export const NAV_ITEM_PERMISSIONS = {
  workflows: ['store-reports.view','workflow.start','workflow.manage','workflow.view','workflow.execute','staff.hq.manage'],
  'analysis-delivery-fees': 'analysis.view',
  'bookkeeping-expense-tags': 'bookkeeping.manage',
  dashboard: 'dashboard.view',
  'analysis-group': 'analysis.view',
  'store-management-group': 'store.manage',
  'store-preparation-group': 'store-preparation.manage',
  'menu-management-group': 'menu.manage',
  'staff-management-group': ['payroll.publish','staff.view', 'staff.store.edit', 'payroll.view', 'payroll.prepare', 'payroll.attendance', 'payroll.review'],
  'collab-list': 'collab.manage',
  'knowledge-base':'knowledge.edit',
  'store-operations':['staff.transfers.view','staff.support.view','staff.offboarding.view','staff.onboarding.view','workflow.manage','store-notices.manage'],
  'inspections':['inspections.view','inspections.submit','inspections.assign','inspections.execute','inspections.review'],
  'store-inventory':'inventory.view',
  'store-tasks': ['store-tasks.manage','store-tasks.execute','store-tasks.review'],
  'bookkeeping-entry': 'bookkeeping.manage',
  'data-import-group': 'data-import.manage',
  pipeline: 'pipeline.manage',
  'ai-assistant': 'ai-assistant.view',
  notifications: 'notifications.view',
  'notification-rules': '*',
  'enterprise-settings': '*',
  'user-management': '*',
  'position-settings': '*',
  settings: '*',
  'operation-audit':'*','finance-integrations':'*','approval-store-bindings':'*','data-import-pos-automation':'*','automation-schedule':'*','analysis-sync-runs':'*',
}

/** 权限判断：'*' 放行一切 */
export function permits(permissions, code) {
  const list = Array.isArray(permissions) ? permissions : []
  if (list.includes('*')) return true
  if (!code || ['notifications.view','collab.manage','collab.create','collab.edit','store-reports.submit'].includes(code)) return true
  if (Array.isArray(code)) return code.some(item => permits(list, item))
  return list.includes(code)
}

/** 分组下是否有任意一个可访问的项 */
export function permitsAny(permissions, codes) {
  const list = Array.isArray(codes) ? codes : [codes]
  return list.some(code => permits(permissions, code))
}
