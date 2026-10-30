import { NAV_ITEM_PERMISSIONS, permits } from '../permissions.js'

// 只组织现有入口；权限码、页面地址和业务操作继续各自维护。
export const SYSTEM_GROUPS = [
  { key: 'system-access', index: 'system-access-group', label: '账号与权限', pages: [
    { index: 'user-management', path: '/user-management', label: '人员管理' },
    { index: 'position-settings', path: '/position-settings', label: '岗位设置' },
    { index: 'operation-audit', path: '/admin/operation-audit', label: '操作日志' },
  ] },
  { key: 'system-config', index: 'system-config-group', label: '系统配置', pages: [
    { index: 'enterprise-settings', path: '/enterprise-settings/robot', label: '企业设置' },
    { index: 'notification-rules', path: '/notification-rules', label: '通知规则' },
    { index: 'settings', path: '/settings', label: '网页设置' },
    { index: 'finance-integrations', path: '/admin/finance-integrations', label: '审批与提醒接入' },
    { index: 'approval-store-bindings', path: '/admin/approval-store-bindings', label: '审批门店绑定' },
  ] },
  { key:'system-automation',index:'system-automation-group',label:'采集与自动报表',pages:[
    {index:'data-import-pos-automation',path:'/data-import/pos/automation',label:'自动导报表'},
    {index:'automation-schedule',path:'/pipeline/pos-daily/schedule',label:'自动采集与发送计划'},
    {index:'analysis-sync-runs',path:'/business-analytics/sync-runs',label:'采集运行记录'},
  ]},
]
export const SYSTEM_PAGES = SYSTEM_GROUPS.flatMap(group => group.pages)
export const canAccessSystemPage = (page, permissions = []) => !!page && permissions.includes('*')
export const visibleSystemGroups = (permissions = []) => SYSTEM_GROUPS.map(group => ({
  ...group, pages: group.pages.filter(page => canAccessSystemPage(page, permissions)),
})).filter(group => group.pages.length)
export const systemPageForPath = path => {
  const normalized = String(path || '').replace(/\/+$/, '')
  return SYSTEM_PAGES.find(page => page.path === normalized || page.index==='data-import-pos-automation' && normalized.startsWith(page.path+'/'))
}
export const isAdminPath=path=>!!systemPageForPath(path)||/^\/admin(?:\/|$)/.test(path)
export const systemGroupForPath = path => SYSTEM_GROUPS.find(group => group.pages.includes(systemPageForPath(path)))
