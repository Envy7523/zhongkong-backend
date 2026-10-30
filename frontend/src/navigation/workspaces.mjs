import { OPERATION_GROUPS } from './operations.mjs'
import { SYSTEM_GROUPS } from './system.mjs'
import { PERSONAL_GROUP } from './business-workspaces.mjs'
export const WORKSPACE_GROUPS=[...OPERATION_GROUPS,...SYSTEM_GROUPS,
 {key:'store-management-info-workspace',label:'门店资料',pages:['info-basic','info-circle','info-platform','info-config','region','map'].map(s=>({index:'store-management-'+s,path:'/store-management/'+s}))},
 {key:'store-management-costs-workspace',label:'门店费用',pages:['fixed','operating'].map(s=>({index:'store-management-'+s,path:'/store-management/'+s}))},
 {key:'data-import-workspace',label:'数据手工导入',pages:['pos','group-buy','delivery'].map(s=>({index:'data-import-'+s,path:'/data-import/'+s}))},
 ...['total','group-buy','delivery'].map(scope=>({key:'analysis-'+scope+'-workspace',label:scope==='total'?'综合经营分析':scope==='group-buy'?'团购经营分析':'外卖经营分析',pages:(scope==='total'?['brand','store','monthly-dashboard','binding']:scope==='group-buy'?['platform','brand','store','daily-summary','binding']:['platform','brand','store','binding']).map(s=>({index:'analysis-'+(scope==='group-buy'?'group':scope)+'-'+s,path:'/analysis/'+scope+'/'+s}))})),
 {key:'finance-workspace',label:'财务工作台',pages:[{index:'finance-approvals',path:'/finance/approvals',label:'请款审批清单'}]},
 PERSONAL_GROUP,
 {key:'bookkeeping-workspace',label:'记账本',pages:['entry','categories','records','expense-tags'].map(s=>({index:'bookkeeping-'+s,path:'/bookkeeping/'+s}))},
 {key:'menu-workspace',label:'菜品管理',pages:['overview','category','cost','expiry','accounting'].map(s=>({index:'menu-management-'+s,path:'/menu-management/'+s}))},
]
export const workspaceForId=id=>WORKSPACE_GROUPS.find(g=>g.key===id||g.pages.some(p=>(p.tabId||p.index)===id||p.index===id))
export const workspaceId=id=>workspaceForId(id)?.key||id
export const workspaceForPath=path=>WORKSPACE_GROUPS.find(g=>g.pages.some(p=>p.path===String(path).replace(/\/+$/,'')||(p.index==='collab-list'&&/^\/collab(?:\/|$)/.test(path))))
export function workspaceRoute(id,remembered={}){const g=workspaceForId(id);return g?(remembered[g.key]||g.pages[0].path):null}
