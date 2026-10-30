import test from 'node:test'
import assert from 'node:assert/strict'
import { NAV_ITEM_PERMISSIONS, permits } from '../frontend/src/permissions.js'
import { SYSTEM_GROUPS, SYSTEM_PAGES, visibleSystemGroups, systemPageForPath, systemGroupForPath } from '../frontend/src/navigation/system.mjs'

test('管理员专区归集账号、日志、配置和采集，保留全部旧地址',()=>{
 assert.deepEqual(SYSTEM_GROUPS.map(g=>g.label),['账号与权限','系统配置','采集与自动报表'])
 for(const path of ['/user-management','/position-settings','/enterprise-settings/robot','/notification-rules','/settings','/admin/operation-audit','/admin/finance-integrations','/admin/approval-store-bindings','/data-import/pos/automation','/pipeline/pos-daily/schedule'])assert(systemPageForPath(path))
 assert.equal(new Set(SYSTEM_PAGES.map(p=>p.index)).size,SYSTEM_PAGES.length)
 assert.equal(visibleSystemGroups(['*']).flatMap(g=>g.pages).length,SYSTEM_PAGES.length)
})
test('32种旧系统权限组合均不能代替管理员；采集服务导入权不扩大',()=>{
 const codes=['users.manage','positions.manage','enterprise-settings.manage','notifications.rules','settings.manage']
 for(let mask=0;mask<32;mask++)assert.deepEqual(visibleSystemGroups(codes.filter((_,bit)=>mask&(1<<bit))),[])
 assert.deepEqual(visibleSystemGroups(['data-import.manage','business_analytics.import']),[])
 assert(SYSTEM_PAGES.every(page=>NAV_ITEM_PERMISSIONS[page.index]==='*'))
})

test('直接访问和尾斜杠保留分组及当前功能，不误收消息中心或人事档案', () => {
  for (const page of SYSTEM_PAGES) {
    assert.equal(systemPageForPath(page.path), page)
    assert.equal(systemPageForPath(page.path + '/'), page)
    assert.ok(systemGroupForPath(page.path).pages.includes(page))
  }
  for (const path of ['/notifications', '/staff-management/employees', '/user-management-extra', '/enterprise-settings/unknown']) {
    assert.equal(systemPageForPath(path), undefined)
    assert.equal(systemGroupForPath(path), undefined)
  }
})
