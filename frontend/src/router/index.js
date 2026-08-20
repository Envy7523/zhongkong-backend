import { createRouter, createWebHistory } from 'vue-router'
import LoginView from '@/views/LoginView.vue'

const routes = [
  {
    path: '/login',
    name: 'login',
    component: LoginView,
  },
  {
    path: '/',
    redirect: '/dashboard',
  },
  {
    path: '/analysis',
    redirect: '/analysis/business/overview',
  },
  {
    path: '/analysis/business',
    redirect: '/analysis/business/overview',
  },
  {
    path: '/analysis/business/overview',
    name: 'analysis-business-overview',
    component: () => import('@/views/analysis/BusinessAnalytics.vue'),
    meta: { analyticsScope: 'overview' },
  },
  {
    path: '/analysis/business/group-buy',
    name: 'analysis-business-group-buy',
    component: () => import('@/views/analysis/ChannelAnalytics.vue'),
    meta: { analyticsScope: 'group-buy' },
  },
  {
    path: '/analysis/business/delivery',
    name: 'analysis-business-delivery',
    component: () => import('@/views/analysis/ChannelAnalytics.vue'),
    meta: { analyticsScope: 'delivery' },
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
