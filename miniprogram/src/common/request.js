/**
 * 请求层：统一 baseUrl、token 注入、401 兜底、错误提示
 *
 * 个人测试期最容易卡住的就是"域名校验"，所以这里把相关错误转成人话提示。
 */
import { DEFAULT_BASE_URL, STORAGE_KEYS } from './config'
import { setSession, clearSession } from './store'

// ==================== 会话与服务器地址 ====================

export function getBaseUrl() {
  return uni.getStorageSync(STORAGE_KEYS.baseUrl) || DEFAULT_BASE_URL
}

export function setBaseUrl(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '')
  if (clean) uni.setStorageSync(STORAGE_KEYS.baseUrl, clean)
  else uni.removeStorageSync(STORAGE_KEYS.baseUrl)
  return getBaseUrl()
}

export function getToken() {
  return uni.getStorageSync(STORAGE_KEYS.token) || ''
}

export function getUser() {
  try { return uni.getStorageSync(STORAGE_KEYS.user) || null } catch { return null }
}

export function saveSession(token, user) {
  uni.setStorageSync(STORAGE_KEYS.token, token)
  uni.setStorageSync(STORAGE_KEYS.user, user)
  setSession(token, user)
}

export function clearAllSession() {
  uni.removeStorageSync(STORAGE_KEYS.token)
  uni.removeStorageSync(STORAGE_KEYS.user)
  clearSession()
}

let redirecting = false
function toLogin() {
  clearAllSession()
  if (redirecting) return
  const pages = getCurrentPages()
  const current = pages.length ? pages[pages.length - 1].route : ''
  if (current && current.includes('login')) return
  redirecting = true
  uni.reLaunch({
    url: '/pages/login/login',
    complete: () => setTimeout(() => { redirecting = false }, 500),
  })
}

// ==================== 基础请求 ====================

function networkHint(err) {
  const base = getBaseUrl()
  const raw = (err && (err.errMsg || err.message)) || '网络异常'
  if (/url not in domain list|not in domain/i.test(raw)) {
    return '域名未在白名单：开发者工具 → 详情 → 本地设置 → 勾选「不校验合法域名」；手机端请打开右上角「调试」'
  }
  if (/fail/i.test(raw)) {
    return `连接不上服务器（${base}）：确认后端已启动、地址正确、手机与电脑在同一网络，且防火墙放行端口`
  }
  return raw
}

/**
 * @param {object} options
 * @param {string} options.url      以 /api/mp 开头的路径
 * @param {string} [options.method] 默认 GET
 * @param {object} [options.data]
 * @param {boolean} [options.auth]  默认 true，false 用于登录等免鉴权接口
 * @param {boolean} [options.silent] 默认 false，true 则失败不自动弹 toast
 */
export function request(options = {}) {
  const { url, method = 'GET', data, auth = true, silent = false, timeout = 20000 } = options
  const header = { 'Content-Type': 'application/json' }
  const token = getToken()
  if (auth && token) header.Authorization = `Bearer ${token}`

  return new Promise((resolve, reject) => {
    uni.request({
      url: getBaseUrl() + url,
      method,
      data,
      header,
      timeout,
      success: (res) => {
        const body = res.data
        if (res.statusCode === 401) {
          if (auth) {
            // 需要鉴权的接口：token 失效或没带
            toLogin()
            const msg = (body && body.error) || '登录已过期，请重新登录'
            if (!silent) uni.showToast({ title: msg, icon: 'none' })
            reject(new Error(msg))
          } else {
            // 免鉴权接口也返回 401 → 服务端根本没有 /api/mp 路由
            // 最常见原因：连到了旧版本后端，或者地址填错了
            const msg = `服务端未响应小程序接口（${getBaseUrl()}）：请确认后端是含 /api/mp 的新版本，且服务器地址填写正确`
            if (!silent) uni.showToast({ title: msg, icon: 'none', duration: 4000 })
            reject(new Error(msg))
          }
          return
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body)
          return
        }
        const msg = (body && body.error) || `请求失败（${res.statusCode}）`
        if (!silent) uni.showToast({ title: msg, icon: 'none' })
        reject(new Error(msg))
      },
      fail: (err) => {
        const msg = networkHint(err)
        if (!silent) uni.showToast({ title: msg, icon: 'none', duration: 3000 })
        reject(new Error(msg))
      },
    })
  })
}

// ==================== 图片上传（拍照 → base64 → 服务端落盘 → 返回 URL） ====================

/**
 * 微信小程序的 <image src> 无法解析相对路径，服务端已返回绝对 URL
 * @param {string} filePath 本地临时文件路径
 * @returns {Promise<string>} 可访问的图片 URL
 */
export function uploadImage(filePath) {
  return new Promise((resolve, reject) => {
    // #ifdef MP-WEIXIN
    uni.getFileSystemManager().readFile({
      filePath,
      encoding: 'base64',
      success: (r) => {
        const ext = String(filePath.split('.').pop() || 'jpg').toLowerCase()
        const mime = ext === 'png' ? 'png' : ext === 'webp' ? 'webp' : ext === 'gif' ? 'gif' : 'jpeg'
        request({
          url: '/api/mp/upload',
          method: 'POST',
          data: { data: `data:image/${mime};base64,${r.data}` },
        }).then(res => resolve(res.url)).catch(reject)
      },
      fail: () => reject(new Error('读取图片失败')),
    })
    // #endif

    // #ifndef MP-WEIXIN
    reject(new Error('当前平台暂不支持图片上传，请在微信小程序中体验'))
    // #endif
  })
}
