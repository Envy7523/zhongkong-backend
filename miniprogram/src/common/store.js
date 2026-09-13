import { reactive } from 'vue'

/**
 * 极简全局状态（P0 不引 pinia，减少小程序端构建与体积负担）
 * 需要持久化的部分由 common/request.js 负责写 Storage
 */
export const store = reactive({
  token: '',
  user: null,
  /** 服务端启用的登录方式：password / openid / wxwork */
  providers: [],
  /** 未读/待办角标（P1 使用） */
  badge: 0,
})

export function setSession(token, user) {
  store.token = token || ''
  store.user = user || null
}

export function clearSession() {
  store.token = ''
  store.user = null
}

export function isAdmin() {
  return ['管理员', '督导'].includes(store.user?.role)
}
