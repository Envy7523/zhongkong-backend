import {permits} from '../permissions.js'
export const PERSONAL_GROUP={key:'personal-workspace',index:'personal-workspace-group',label:'我的工作台',pages:[
 {index:'my-payslips',path:'/my/payslips',label:'我的工资条'},
 {index:'notifications',path:'/notifications',label:'消息通知'},
]}
export const FINANCE_GROUP={key:'finance-tools',index:'finance-tools-group',label:'财务工作台',pages:[
 {index:'finance-approvals',path:'/finance/approvals',label:'请款审批清单',permission:'finance.payments.manage'},
 {index:'bookkeeping-entry',path:'/bookkeeping/entry',label:'记账本',permission:'bookkeeping.manage'},
]}
export const BUSINESS_GROUPS=[FINANCE_GROUP,PERSONAL_GROUP]
export const canAccessBusinessPage=(page,permissions)=>!!page&&permits(permissions,page.permission)
export const visibleBusinessGroups=permissions=>BUSINESS_GROUPS.map(g=>({...g,pages:g.pages.filter(p=>canAccessBusinessPage(p,permissions))})).filter(g=>g.pages.length)
export const personalPageForPath=path=>PERSONAL_GROUP.pages.find(p=>p.path===String(path).replace(/\/+$/,''))
