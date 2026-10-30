import test from 'node:test'
import assert from 'node:assert/strict'
import { createRouter, createMemoryHistory } from '../frontend/node_modules/vue-router/dist/vue-router.mjs'
import { OPERATION_GROUPS, OPERATION_PAGES, operationPageForPath, operationGroupForPath, visibleOperationGroups, legacyReportRedirect } from '../frontend/src/navigation/operations.mjs'
test('运营入口按业务组织，独立协作和原链接继续存在', () => {
  assert.equal(OPERATION_GROUPS.length, 2)
  assert.equal(new Set(OPERATION_PAGES.map(page => page.path)).size, OPERATION_PAGES.length)
  assert.equal(operationGroupForPath('/collab/123').label, '事务协作')
  assert.equal(operationPageForPath('/collaborator'), undefined)
  for (const path of ['/workflows','/collab/list','/store-tasks','/inspections','/operations/reports','/operations/personnel','/operations/announcements']) assert.ok(operationPageForPath(path))
})

test('尾斜杠地址保留原页面、分组和当前页签映射', () => {
  for (const page of OPERATION_PAGES) {
    assert.equal(operationPageForPath(page.path + '/'), page)
    assert.equal(operationGroupForPath(page.path + '/'), operationGroupForPath(page.path))
  }
  assert.equal(operationPageForPath('/collab/123/').index, 'collab-list')
  assert.equal(operationPageForPath('/operations/reports-extra/'), undefined)
})

test('旧申报深链接首次进入及同审批页查询变化均跳转，保留参数和定位', async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/workflows', component: {} },
      { path: '/operations/reports', component: {} },
    ],
  })
  router.beforeEach(legacyReportRedirect)
  const checkedPaths = []
  router.beforeEach(to => { checkedPaths.push(to.path) })
  await router.push('/workflows/?report_id=41&from=notice#record')
  assert.equal(router.currentRoute.value.fullPath, '/operations/reports?report_id=41&from=notice#record')
  await router.push('/workflows')
  await router.push('/workflows?report_id=42&from=collab#detail')
  assert.equal(router.currentRoute.value.fullPath, '/operations/reports?report_id=42&from=collab#detail')
  assert.deepEqual(checkedPaths, ['/operations/reports', '/workflows', '/operations/reports'])
  assert.equal(legacyReportRedirect({ path: '/operations/reports', query: { report_id: '42' } }), undefined)
  assert.equal(legacyReportRedirect({ path: '/workflows', query: {} }), undefined)
})
test('全员基础入口可用，业务管理入口仍逐项授权', () => {
  const paths = permissions => visibleOperationGroups(permissions).flatMap(group => group.pages.map(page => page.path))
  const common=['/operations/reports','/collab/list']
  assert.deepEqual(paths([]),common)
  assert.deepEqual(paths(['collab.manage']),common)
  assert.deepEqual(paths(['store-notices.manage']),[...common,'/operations/announcements'])
  assert.deepEqual(paths(['staff.transfers.view']),[...common,'/operations/personnel'])
  assert.deepEqual(paths(['store-reports.view']),common)
  assert.deepEqual(paths(['store-tasks.execute']),[...common,'/store-tasks'])
  assert.deepEqual(paths(['workflow.execute']),['/operations/reports','/workflows','/collab/list'])
  assert.equal(paths(['*']).length,OPERATION_PAGES.length)
})
