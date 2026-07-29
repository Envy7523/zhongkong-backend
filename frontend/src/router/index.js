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
