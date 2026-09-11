import { createRouter, createWebHistory } from 'vue-router'
import LoginView from '@/views/LoginView.vue'
// 菜品绑定是高频关键页。直接随入口加载，避免旧标签页请求已失效的异步分包后只剩页面外壳。
import ProductBinding from '@/views/analysis/ProductBinding.vue'

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
    path: '/store-3d',
    name: 'store-3d',
    component: () => import('@/views/store3d/index.vue'),
    meta: { pageKey: 'store-3d', pageTitle: '筹建门店 · 门店渲染' },
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
    redirect: '/analysis/delivery/platform',
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
    meta: { analysisKey: 'analysis-total-brand', analysisTitle: '总数据视角 · 品牌视角', analysisScope: 'total', analysisMode: 'brand' },
  },
  {
    path: '/analysis/total/store',
    name: 'analysis-total-store',
    component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analysisKey: 'analysis-total-store', analysisTitle: '总数据视角 · 门店视角', analysisScope: 'total', analysisMode: 'store' },
  },
  // 保留旧链接，统一进入门店视角，避免收藏地址失效.
  { path: '/analysis/total/custom', redirect: '/analysis/total/store' },
  {
    path: '/analysis/total/monthly-dashboard',
    name: 'analysis-total-monthly-dashboard',
    component: () => import('@/views/analysis/MonthlyOperatingDashboard.vue'),
    meta: { analysisKey: 'analysis-total-monthly-dashboard', analysisTitle: '总数据视角 · 月经营数据看板', analysisScope: 'total', analysisMode: 'monthly-dashboard' },
  },
  {
    path: '/analysis/total/binding',
    name: 'analysis-total-binding',
    component: () => import('@/views/analysis/DishSalesBinding.vue'),
    meta: { analysisKey: 'analysis-total-binding', analysisTitle: '堂食菜品绑定', analysisScope: 'total', analysisMode: 'binding' },
  },
  {
    path: '/analysis/group-buy/binding',
    name: 'analysis-group-binding',
    component: ProductBinding,
    meta: { analysisKey: 'analysis-group-binding', analysisTitle: '团购菜品绑定', analysisScope: 'group-buy', analysisMode: 'binding' },
  },
  {
    path: '/analysis/group-buy/platform', name: 'analysis-group-platform', component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analysisKey: 'analysis-group-platform', analysisTitle: '团购视角 · 平台视角', analysisScope: 'group-buy', analysisMode: 'platform' },
  },
  // 保留历史链接，统一进入新的团购平台视角。
  { path: '/analysis/group-buy/platform/meituan', redirect: '/analysis/group-buy/platform' },
  { path: '/analysis/group-buy/platform/douyin', redirect: '/analysis/group-buy/platform' },
  { path: '/analysis/group-buy/platform/free-trial', redirect: '/analysis/group-buy/platform' },
  {
    path: '/analysis/group-buy/brand', name: 'analysis-group-brand', component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analysisKey: 'analysis-group-brand', analysisTitle: '团购视角 · 品牌视角', analysisScope: 'group-buy', analysisMode: 'brand' },
  },
  {
    path: '/analysis/group-buy/store', name: 'analysis-group-store', component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analysisKey: 'analysis-group-store', analysisTitle: '团购视角 · 门店视角', analysisScope: 'group-buy', analysisMode: 'store' },
  },  {
    path: '/analysis/delivery/binding',
    name: 'analysis-delivery-binding',
    component: ProductBinding,
    meta: { analysisKey: 'analysis-delivery-binding', analysisTitle: '外卖菜品绑定', analysisScope: 'delivery', analysisMode: 'binding' },
  },
  {
    path: '/analysis/delivery/platform', name: 'analysis-delivery-platform', component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analysisKey: 'analysis-delivery-platform', analysisTitle: '外卖视角 · 平台视角', analysisScope: 'delivery', analysisMode: 'platform' },
  },
  // 保留旧的单平台链接，统一落到新的平台视角，避免已收藏地址失效。
  { path: '/analysis/delivery/platform/meituan', redirect: '/analysis/delivery/platform' },
  { path: '/analysis/delivery/platform/taobao', redirect: '/analysis/delivery/platform' },
  { path: '/analysis/delivery/platform/jd', redirect: '/analysis/delivery/platform' },
  {
    path: '/analysis/delivery/brand', name: 'analysis-delivery-brand', component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analysisKey: 'analysis-delivery-brand', analysisTitle: '外卖视角 · 品牌视角', analysisScope: 'delivery', analysisMode: 'brand' },
  },
  {
    path: '/analysis/delivery/store', name: 'analysis-delivery-store', component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analysisKey: 'analysis-delivery-store', analysisTitle: '外卖视角 · 门店视角', analysisScope: 'delivery', analysisMode: 'store' },
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
  // 常规工作台页面同样使用真实子路由。页面仍由 App 的标签容器承载，
  // 此路由记录用于地址栏、刷新恢复和链接分享。
  { path: '/store-management/:section', name: 'workspace-store-management', component: { render: () => null } },
  {
    path: '/menu-management',
    redirect: '/menu-management/overview',
  },
  { path: '/menu-management/:section', name: 'workspace-menu-management', component: { render: () => null } },
  {
    path: '/menu-management/category',
    name: 'menu-management-category',
    component: () => import('@/views/menu/MenuCategory.vue'),
  },
  // 菜品核算：暂挂「菜品管理」下，功能打通后整体迁往「成本核算」（path 改为 /cost-accounting/accounting）。
  {
    path: '/menu-management/accounting',
    name: 'menu-management-accounting',
    component: () => import('@/views/menu/MenuAccounting.vue'),
  },
  {
    path: '/cost-accounting',
    redirect: '/cost-accounting/daily',
  },
  { path: '/cost-accounting/:section', name: 'workspace-cost-accounting', component: { render: () => null } },
  { path: '/bookkeeping', redirect: '/bookkeeping/entry' },
  { path: '/bookkeeping/:section', name: 'workspace-bookkeeping', component: { render: () => null } },
  { path: '/pipeline', name: 'workspace-pipeline', component: { render: () => null } },
  { path: '/ai-assistant', name: 'workspace-ai-assistant', component: { render: () => null } },
  { path: '/user-management', name: 'workspace-user-management', component: { render: () => null } },
  { path: '/settings', name: 'workspace-settings', component: { render: () => null } },
  {
    path: '/staff-management',
    redirect: '/staff-management/employees',
  },
  {
    path: '/staff-management/store-management',
    name: 'staff-management-store',
    component: () => import('@/views/staff/StaffStoreManagement.vue'),
  },
  {
    path: '/staff-management/employees',
    name: 'staff-management-employees',
    component: () => import('@/views/staff/StaffEmployees.vue'),
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

// 发布新构建后，旧标签页偶尔仍会请求上一版带哈希的异步模块。
// 自动刷新一次恢复到最新入口，避免动态路由加载失败后只剩下工作台外壳。
router.onError((error) => {
  const message = String(error?.message || error || '')
  const isStaleModule = /failed to fetch dynamically imported module|importing a module script failed|unable to preload css/i.test(message)
  if (!isStaleModule || typeof window === 'undefined') return
  const key = 'etaigong:module-reload-attempted'
  if (window.sessionStorage.getItem(key)) return
  window.sessionStorage.setItem(key, '1')
  window.location.reload()
})
router.afterEach(() => {
  if (typeof window !== 'undefined') window.sessionStorage.removeItem('etaigong:module-reload-attempted')
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
