import test from 'node:test'
import assert from 'node:assert/strict'
import { STAFF_PAGES, STAFF_GROUPS, visibleStaffGroups, staffRouteForId, staffPageForPath, staffWorkspaceId } from '../frontend/src/navigation/staff.mjs'

test('existing staff and training deep links remain mapped to three workspaces', () => {
  assert.equal(STAFF_PAGES.length,12)
  assert.equal(new Set(STAFF_PAGES.map(page=>page.path)).size,12)
  assert.equal(STAFF_GROUPS.length,3)
  for(const page of STAFF_PAGES){assert.equal(staffPageForPath(page.path+'/')?.id,page.id);assert(STAFF_GROUPS.some(group=>group.id===staffWorkspaceId(page.id)))}
})
test('store managers see employee records, weekly attendance and salary preparation only', () => {
  const groups=visibleStaffGroups(['staff.store.edit','payroll.prepare'])
  assert.deepEqual(groups.flatMap(group=>group.pages.map(page=>page.id)),['staff-management-employees','staff-management-roster','staff-management-salary'])
  assert.equal(staffRouteForId('staff-management-payslips',['staff.store.edit','payroll.prepare']),null)
})
test('HR without attendance permission enters daily tasks rather than restricted attendance pages', () => {
  assert.equal(staffRouteForId('staff-management-time',['staff.view']),'/staff-management/daily-tasks')
  assert.equal(staffRouteForId('staff-management-review',['staff.view']),null)
})
test('review-only staff cannot enter personnel pages and get a valid payroll landing page', () => {
  const groups=visibleStaffGroups(['payroll.review'])
  assert.deepEqual(groups.map(group=>group.id),['staff-management-payroll'])
  assert.equal(staffRouteForId('staff-management-people',['payroll.review']),null)
  assert.equal(staffRouteForId('staff-management-payroll',['payroll.review']),'/staff-management/salary')
})
test('returning to a workspace restores its last permitted page and rejects stale permissions', () => {
  const remembered={'staff-management-payroll':'/staff-management/review'}
  assert.equal(staffRouteForId('staff-management-payroll',['*'],remembered),'/staff-management/review')
  assert.equal(staffRouteForId('staff-management-payroll',['payroll.prepare'],remembered),'/staff-management/salary')
  assert.equal(staffRouteForId('staff-management-payroll',['*'],{'staff-management-payroll':'/settings'}),'/staff-management/salary')
})
test('no permission means no staff navigation; administrators retain all existing pages', () => {
  assert.deepEqual(visibleStaffGroups([]),[])
  assert.equal(visibleStaffGroups(['*']).flatMap(group=>group.pages).length,12)
  assert.equal(staffRouteForId('missing',['*']),null)
})
