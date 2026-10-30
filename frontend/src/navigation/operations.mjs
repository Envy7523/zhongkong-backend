// 导航按工作组织，权限仍复用各业务原来的权限码。
export const OPERATION_GROUPS = [
  { key: 'operations-affairs', index: 'operations-affairs-group', label: '事务协作', pages: [
    { index: 'operation-reports', path: '/operations/reports', label: '问题申报', permissions: ['store-reports.submit','store-reports.view', 'workflow.manage', 'workflow.view'] },
    { index: 'workflows', path: '/workflows', label: '审批申请', permissions: ['workflow.start', 'workflow.manage', 'workflow.view', 'workflow.execute', 'staff.hq.manage'] },
    { index: 'collab-list', tabId: 'collab', path: '/collab/list', label: '协同事项', permissions: ['collab.manage'] },
  ] },
  { key: 'operations-store', index: 'operations-store-group', label: '门店运营', pages: [
    { index: 'store-inventory', path: '/operations/inventory', label: '门店库存', permissions: ['inventory.view'] },
    { index: 'store-tasks', path: '/store-tasks', label: '日常任务', permissions: ['store-tasks.manage', 'store-tasks.execute', 'store-tasks.review'] },
    { index: 'inspections', path: '/inspections', label: '巡检与整改', permissions: ['inspections.view', 'inspections.submit', 'inspections.assign', 'inspections.execute', 'inspections.review'] },
    { index: 'operation-personnel', path: '/operations/personnel', label: '人员流程', permissions: ['staff.transfers.view', 'staff.support.view', 'staff.offboarding.view', 'staff.onboarding.view', 'workflow.manage'] },
    { index: 'operation-announcements', path: '/operations/announcements', label: '公告与提醒', permissions: ['store-notices.manage'] },
  ] },
]
export const OPERATION_PAGES = OPERATION_GROUPS.flatMap(group => group.pages)
const normalizedPath = path => String(path || '').replace(/\/+$/, '')
export const operationPageForPath = path => OPERATION_PAGES.find(page => page.index === 'collab-list' ? /^\/collab(?:\/|$)/.test(normalizedPath(path)) : page.path === normalizedPath(path))
export const operationGroupForPath = path => OPERATION_GROUPS.find(group => group.pages.includes(operationPageForPath(path)))
export const canAccessOperationPage = (page, permissions = []) => !!page && (permissions.includes('*') || ['operation-reports','collab-list'].includes(page.index) || page.permissions.some(code => permissions.includes(code)))
export const visibleOperationGroups = (permissions = []) => OPERATION_GROUPS.map(group => ({ ...group, pages: group.pages.filter(page => canAccessOperationPage(page, permissions)) })).filter(group => group.pages.length)

// 全局守卫也覆盖审批页内只变化查询参数的旧链接；目标页仍按原权限校验。
export const legacyReportRedirect = to => normalizedPath(to.path) === '/workflows' && to.query?.report_id
  ? { path: '/operations/reports', query: to.query, hash: to.hash, replace: true }
  : undefined
