import test from 'node:test'
import assert from 'node:assert/strict'
import {WORKSPACE_GROUPS,workspaceId,workspaceForPath,workspaceRoute} from '../frontend/src/navigation/workspaces.mjs'
import {isAdminPath} from '../frontend/src/navigation/system.mjs'
import {visibleBusinessGroups} from '../frontend/src/navigation/business-workspaces.mjs'
test('全部工作区保留旧地址，不合并不同业务组件的缓存身份',()=>{
 const paths=WORKSPACE_GROUPS.flatMap(g=>g.pages.map(p=>p.path));assert.equal(new Set(paths).size,paths.length)
 for(const group of WORKSPACE_GROUPS)for(const page of group.pages){assert.equal(workspaceId(page.tabId||page.index),group.key);assert.equal(workspaceForPath(page.path+'/').key,group.key)}
 assert.equal(workspaceId('workflows'),workspaceId('collab'));assert.equal(workspaceId('user-management'),workspaceId('operation-audit'))
 assert.notEqual(workspaceId('analysis-total-brand'),workspaceId('analysis-delivery-brand'))
 assert.notEqual(workspaceId('data-import-pos'),workspaceId('data-import-pos-automation'))
 const group=workspaceForPath('/operations/reports');assert.equal(workspaceRoute(group.key,{[group.key]:'/collab/12?from=report'}),'/collab/12?from=report')
})
test('自动采集子页不能靠旧权限或地址绕过管理员，业务导入与个人页独立',()=>{
 for(const path of ['/user-management','/position-settings','/admin/operation-audit','/admin/finance-integrations','/data-import/pos/automation','/data-import/pos/automation/schedule','/pipeline/pos-daily/schedule','/business-analytics/sync-runs'])assert.equal(isAdminPath(path),true)
 for(const path of ['/data-import/pos','/data-import/group-buy','/my/payslips','/my/requests','/finance/payments','/staff-management/employees','/notifications'])assert.equal(isAdminPath(path),false)
})
test('个人工作台全员可用，付款与记账保留独立授权',()=>{
 assert.deepEqual(visibleBusinessGroups([]).flatMap(g=>g.pages.map(p=>p.index)),['my-payslips','notifications'])
 assert.deepEqual(visibleBusinessGroups(['bookkeeping.manage']).find(g=>g.key==='finance-tools').pages.map(p=>p.index),['bookkeeping-entry'])
 assert.deepEqual(visibleBusinessGroups(['finance.payments.manage']).find(g=>g.key==='finance-tools').pages.map(p=>p.index),['finance-approvals'])
 assert.equal(visibleBusinessGroups(['*']).find(g=>g.key==='finance-tools').pages.length,2)
 for(const page of visibleBusinessGroups(['*']).flatMap(g=>g.pages))assert(!['finance-payments','my-requests'].includes(page.index))
 assert.equal(WORKSPACE_GROUPS.flatMap(g=>g.pages).filter(p=>['/finance/payments','/my/requests'].includes(p.path)).length,0)
})
