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
    redirect: '/analysis/business/group/operations',
  },
  {
    path: '/analysis/business',
    redirect: '/analysis/business/group/operations',
  },
  {
    path: '/analysis/business/overview',
    redirect: '/analysis/business/group/operations',
  },
  {
    path: '/analysis/business/group-buy',
    redirect: '/analysis/business/group-buy/operations',
  },
  {
    path: '/analysis/business/delivery',
    redirect: '/analysis/business/delivery/operations',
  },
  {
    path: '/analysis/business/group',
    redirect: '/analysis/business/group/operations',
  },
  {
    path: '/analysis/business/group/operations',
    name: 'analysis-group-operations',
    component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analyticsScope: 'overview', analyticsSection: 'operations' },
  },
  {
    path: '/analysis/business/group-buy/operations',
    name: 'analysis-group-buy-operations',
    component: () => import('@/views/analysis/ChannelAnalytics.vue'),
    meta: { analyticsScope: 'group-buy', analyticsSection: 'operations' },
  },
  {
    path: '/analysis/business/delivery/operations',
    name: 'analysis-delivery-operations',
    component: () => import('@/views/analysis/ChannelAnalytics.vue'),
    meta: { analyticsScope: 'delivery', analyticsSection: 'operations' },
  },
  {
    path: '/analysis/business/:perspective(group|group-buy|delivery)/products',
    name: 'analysis-products',
    component: () => import('@/views/analysis/ProductSalesAnalytics.vue'),
    meta: { analyticsSection: 'products' },
  },
  {
    path: '/analysis/business/:perspective(group|group-buy|delivery)/mappings',
    name: 'analysis-mappings',
    component: () => import('@/views/analysis/ProductDishMapping.vue'),
    meta: { analyticsSection: 'mappings' },
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
