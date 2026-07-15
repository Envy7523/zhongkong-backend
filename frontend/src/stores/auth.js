import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { login as apiLogin, getMe } from '@/api'

const TOKEN_KEY = 'etaigong_token'

export const useAuthStore = defineStore('auth', () => {
  const token = ref(localStorage.getItem(TOKEN_KEY) || '')
  const user = ref(null)
  const initialized = ref(false)

  const isLoggedIn = computed(() => !!token.value)
  const isAdmin = computed(() => user.value?.role === '管理员')

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

  return { token, user, initialized, isLoggedIn, isAdmin, login, init, logout }
})
