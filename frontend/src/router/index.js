import { createRouter, createWebHistory } from 'vue-router'
import LoginView from '@/views/LoginView.vue'

const routes = [
  {
    path: '/login',
    name: 'login',
    component: LoginView,
  },
  {
    path: '/dashboard',
    alias: '/',
    name: 'dashboard',
    // App.vue 负责渲染普通工作台标签；这里仅提供一个有效路由记录，
    // 让直接访问或刷新 /dashboard 时不会落入未匹配状态。
    component: { render: () => null },
  },
  {
    path: '/analysis',
    redirect: '/analysis/total/brand',
  },
  {
    path: '/analysis/business',
    redirect: '/analysis/total/brand',
  },
  {
    path: '/analysis/business/overview',
    redirect: '/analysis/total/brand',
  },
  {
    path: '/analysis/business/group-buy',
    redirect: '/analysis/group-buy/brand',
  },
  {
    path: '/analysis/business/delivery',
    redirect: '/analysis/delivery/store',
  },
  {
    path: '/analysis/business/group',
    redirect: '/analysis/total/brand',
  },
  {
    path: '/analysis/business/:pathMatch(.*)*',
    redirect: '/analysis/total/brand',
  },
  {
    path: '/analysis/total/brand',
    name: 'analysis-total-brand',
    component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analysisKey: 'analysis-total-brand', analysisTitle: '总数据视角 · 全门店汇总', analysisScope: 'total', analysisMode: 'brand' },
  },
  {
    path: '/analysis/total/store',
    name: 'analysis-total-store',
    component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analysisKey: 'analysis-total-store', analysisTitle: '总数据视角 · 单店数据', analysisScope: 'total', analysisMode: 'store' },
  },
  {
    path: '/analysis/total/custom',
    name: 'analysis-total-custom',
    component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analysisKey: 'analysis-total-custom', analysisTitle: '总数据视角 · 自选门店汇总', analysisScope: 'total', analysisMode: 'custom' },
  },
  {
    path: '/analysis/group-buy/platform/meituan', name: 'analysis-group-meituan', component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analysisKey: 'analysis-group-meituan', analysisTitle: '团购视角 · 美团团购', analysisScope: 'group-buy', analysisMode: 'platform', analysisPlatform: '美团团购' },
  },
  {
    path: '/analysis/group-buy/platform/douyin', name: 'analysis-group-douyin', component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analysisKey: 'analysis-group-douyin', analysisTitle: '团购视角 · 抖音团购', analysisScope: 'group-buy', analysisMode: 'platform', analysisPlatform: '抖音团购' },
  },
  {
    path: '/analysis/group-buy/platform/free-trial', name: 'analysis-group-free-trial', component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analysisKey: 'analysis-group-free-trial', analysisTitle: '团购视角 · 美团免费试', analysisScope: 'group-buy', analysisMode: 'platform', analysisPlatform: '免费试' },
  },
  {
    path: '/analysis/group-buy/brand', name: 'analysis-group-brand', component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analysisKey: 'analysis-group-brand', analysisTitle: '品牌团购汇总', analysisScope: 'group-buy', analysisMode: 'brand' },
  },
  {
    path: '/analysis/group-buy/store', name: 'analysis-group-store', component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analysisKey: 'analysis-group-store', analysisTitle: '门店团购汇总', analysisScope: 'group-buy', analysisMode: 'store' },
  },
  {
    path: '/analysis/delivery/platform/meituan', name: 'analysis-delivery-meituan', component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analysisKey: 'analysis-delivery-meituan', analysisTitle: '外卖视角 · 美团外卖', analysisScope: 'delivery', analysisMode: 'platform', analysisPlatform: '美团外卖' },
  },
  {
    path: '/analysis/delivery/platform/taobao', name: 'analysis-delivery-taobao', component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analysisKey: 'analysis-delivery-taobao', analysisTitle: '外卖视角 · 淘宝闪购', analysisScope: 'delivery', analysisMode: 'platform', analysisPlatform: '淘宝闪购' },
  },
  {
    path: '/analysis/delivery/platform/jd', name: 'analysis-delivery-jd', component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analysisKey: 'analysis-delivery-jd', analysisTitle: '外卖视角 · 京东外卖', analysisScope: 'delivery', analysisMode: 'platform', analysisPlatform: '京东外卖' },
  },
  {
    path: '/analysis/delivery/brand', name: 'analysis-delivery-brand', component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analysisKey: 'analysis-delivery-brand', analysisTitle: '品牌外卖汇总', analysisScope: 'delivery', analysisMode: 'brand' },
  },
  {
    path: '/analysis/delivery/store', name: 'analysis-delivery-store', component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analysisKey: 'analysis-delivery-store', analysisTitle: '门店外卖汇总', analysisScope: 'delivery', analysisMode: 'store' },
  },
  {
    path: '/data-import',
    redirect: '/data-import/pos',
  },
  {
    path: '/data-import/pos',
    name: 'data-import-pos',
    component: () => import('@/views/BusinessDataImport.vue'),
    meta: { importMode: 'pos' },
  },
  {
    path: '/data-import/group-buy',
    name: 'data-import-group-buy',
    component: () => import('@/views/BusinessDataImport.vue'),
    meta: { importMode: 'group-buy' },
  },
  {
    path: '/data-import/delivery',
    name: 'data-import-delivery',
    component: () => import('@/views/BusinessDataImport.vue'),
    meta: { importMode: 'delivery' },
  },
  {
    path: '/data-import/legacy',
    name: 'data-import-legacy',
    component: () => import('@/views/DataImportView.vue'),
    meta: { importMode: 'legacy' },
  },
  {
    path: '/store-management',
    redirect: '/store-management/info-basic',
  },
  {
    path: '/menu-management',
    redirect: '/menu-management/overview',
  },
  {
    path: '/cost-accounting',
    redirect: '/cost-accounting/daily',
  },
  {
    path: '/staff-management',
    redirect: '/staff-management/manager',
  },
  {
    path: '/collab',
    redirect: '/collab/list',
  },
  {
    path: '/collab/list',
    name: 'collab-list',
    component: () => import('@/views/collab/CollabList.vue'),
  },
  {
    path: '/collab/:id(\\d+)',
    name: 'collab-detail',
    component: () => import('@/views/collab/CollabDetail.vue'),
  },
  {
    path: '/collab/:pathMatch(.*)*',
    redirect: '/collab/list',
  },
  {
    path: '/enterprise-settings',
    redirect: '/enterprise-settings/robot',
  },
  {
    path: '/enterprise-settings/robot',
    name: 'enterprise-settings-robot',
    component: () => import('@/views/EnterpriseSettingsView.vue'),
    meta: { enterpriseSection: 'robot' },
  },
  {
    path: '/enterprise-settings/:pathMatch(.*)*',
    redirect: '/enterprise-settings/robot',
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

const TOKEN_KEY = 'etaigong_token'

router.beforeEach((to, from, next) => {
  const token = localStorage.getItem(TOKEN_KEY)
  if (to.path === '/login') {
    if (token) return next('/')
    return next()
  }
  if (!token) return next('/login')
  next()
})

export default router
