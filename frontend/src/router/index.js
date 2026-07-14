import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    redirect: '/dashboard',
  },
  // 有子页的页面使用嵌套路由 + redirect
  {
    path: '/analysis',
    redirect: '/analysis/revenue',
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
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
