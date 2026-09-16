import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { login as apiLogin, getMe } from '@/api'
import { permits, permitsAny } from '@/permissions'

const TOKEN_KEY = 'etaigong_token'

export const useAuthStore = defineStore('auth', () => {
  const token = ref(localStorage.getItem(TOKEN_KEY) || '')
  const user = ref(null)
  const initialized = ref(false)

  const isLoggedIn = computed(() => !!token.value)
  const isAdmin = computed(() => user.value?.position_permissions?.includes('*') === true)
  const permissions = computed(() => user.value?.position_permissions || [])

  // 菜单、路由、按钮统一走这里判断，避免各自比较数组造成口径不一。
  const can = code => permits(permissions.value, code)
  const canAny = codes => permitsAny(permissions.value, codes)

  function setToken(t) {
    token.value = t
    if (t) localStorage.setItem(TOKEN_KEY, t)
    else localStorage.removeItem(TOKEN_KEY)
  }

  async function login(username, password) {
    const res = await apiLogin(username, password)
    setToken(res.token)
    user.value = res.user
    return res
  }

  async function init() {
    if (!token.value) return
    try {
      const res = await getMe()
      user.value = res.user
    } catch {
      setToken('')
      user.value = null
    }
  }

  function logout() {
    setToken('')
    user.value = null
  }

  function updateSession(session) {
    if (session?.token) setToken(session.token)
    if (session?.user) user.value = session.user
  }

  return { token, user, initialized, isLoggedIn, isAdmin, permissions, can, canAny, login, init, logout, updateSession }
})
