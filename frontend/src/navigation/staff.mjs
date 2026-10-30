// 人事导航统一由此维护；页面地址保持稳定，工作区按业务归并。
export const STAFF_GROUPS = [
  { id: 'staff-management-people', label: '人员与组织', description: '员工档案、集团通讯录与人员安排', pages: [
    { id: 'staff-management-employees', path: '/staff-management/employees', label: '员工管理', permissions: ['staff.view', 'staff.store.edit'] },
    { id: 'staff-management-organizations', path: '/staff-management/organizations', label: '组织与通讯录', permissions: ['staff.view'] },
    { id: 'staff-management-store', path: '/staff-management/store-management', label: '店长分配', permissions: ['staff.view'] },
    { id:'staff-management-training',path:'/staff-management/training',label:'培训派发',permissions:['staff.training.manage','staff.training.configure','staff.training.view'] },
    { id: 'staff-management-dispatch', path: '/staff-management/dispatch', label: '员工调岗', permissions: ['staff.view'] },
  ] },
  { id: 'staff-management-time', label: '考勤管理', description: '员工考勤、月出勤与每日同步任务', pages: [
    { id: 'staff-management-roster', path: '/staff-management/roster', label: '员工考勤', permissions: ['staff.store.edit', 'payroll.attendance'] },
    { id: 'staff-management-attendance', path: '/staff-management/attendance', label: '月出勤管理', permissions: ['payroll.attendance'] },
    { id: 'staff-management-daily-tasks', path: '/staff-management/daily-tasks', label: '每日任务', permissions: ['staff.view'] },
  ] },
  { id: 'staff-management-payroll', label: '薪资管理', description: '工资表制作、审核与工资条查询', pages: [
    { id: 'staff-management-salary', path: '/staff-management/salary', label: '工资表制作', permissions: ['staff.view', 'payroll.view', 'payroll.prepare', 'payroll.attendance', 'payroll.review'] },
    { id: 'staff-management-review', path: '/staff-management/review', label: '工资审核', permissions: ['payroll.review', 'payroll.attendance'] },
    { id: 'staff-management-payslips', path: '/staff-management/payslips', label: '员工工资条查询', permissions: ['staff.view', 'payroll.view', 'payroll.prepare', 'payroll.attendance', 'payroll.review'] },
    { id:'staff-management-payslip-delivery',path:'/staff-management/payslip-delivery',label:'工资条发布与签收',permissions:['payroll.publish'] },
  ] },
]
export const STAFF_PAGES = STAFF_GROUPS.flatMap(group => group.pages)
export const staffPageForPath = path => STAFF_PAGES.find(page => page.path === String(path).replace(/\/$/, ''))
export const staffGroupForId = id => STAFF_GROUPS.find(group => group.id === id || group.pages.some(page => page.id === id))
export const staffWorkspaceId = id => staffGroupForId(id)?.id || id
export function canAccessStaffPage(page, permissions = []) {
  if (!page) return false
  if (permissions.includes('*')) return true
  // 店长不可跨店查询工资条，沿用原有的人事及上级范围。
  if (page.id === 'staff-management-payslips' && permissions.includes('staff.store.edit') && !permissions.some(p => ['staff.view', 'payroll.attendance', 'payroll.review'].includes(p))) return false
  return page.permissions.some(code => permissions.includes(code))
}
export function visibleStaffGroups(permissions = []) {
  return STAFF_GROUPS.map(group => ({ ...group, pages: group.pages.filter(page => canAccessStaffPage(page, permissions)) })).filter(group => group.pages.length)
}
export function staffRouteForId(id, permissions, remembered = {}) {
  const direct = STAFF_PAGES.find(page => page.id === id)
  if (direct) return canAccessStaffPage(direct, permissions) ? direct.path : null
  const group = visibleStaffGroups(permissions).find(group => group.id === id)
  if (!group) return null
  return group.pages.find(page => page.path === remembered[group.id])?.path || group.pages[0].path
}
