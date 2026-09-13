/**
 * /api/mp 接口封装（与后端 lib/mp/router.js 一一对应）
 */
import { request } from './request'

function qs(params = {}) {
  const pairs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  return pairs.length ? `?${pairs.join('&')}` : ''
}

export const api = {
  // ---------- 登录 ----------
  /** 探测后端可用性：失败由登录页以醒目横幅呈现，所以这里静默（不弹 toast） */
  providers: () => request({ url: '/api/mp/auth/providers', auth: false, silent: true }),
  loginPassword: (username, password) =>
    request({ url: '/api/mp/auth/login/password', method: 'POST', data: { username, password }, auth: false }),

  /** 企业微信免登（P2 企业主体阶段启用） */
  loginWxwork: (code) =>
    request({ url: '/api/mp/auth/login/wxwork', method: 'POST', data: { code }, auth: false }),

  /** 普通微信授权 + 邀请码（需后端配好 mp.appid/mp.secret） */
  loginOpenid: (code, invite) =>
    request({ url: '/api/mp/auth/login/openid', method: 'POST', data: { code, invite }, auth: false }),

  me: () => request({ url: '/api/mp/me' }),

  // ---------- 协同事项 ----------
  issueList: (params) => request({ url: '/api/mp/collab/issues' + qs(params) }),
  issueStats: () => request({ url: '/api/mp/collab/stats' }),
  issueDetail: (id) => request({ url: `/api/mp/collab/issues/${id}` }),
  issueCreate: (data) => request({ url: '/api/mp/collab/issues', method: 'POST', data }),
  issueReply: (id, content, images = []) =>
    request({ url: `/api/mp/collab/issues/${id}/reply`, method: 'POST', data: { content, images } }),
  issueAdvance: (id, status, note) =>
    request({ url: `/api/mp/collab/issues/${id}/advance`, method: 'PUT', data: { status, note } }),
  issueDelete: (id) => request({ url: `/api/mp/collab/issues/${id}`, method: 'DELETE' }),
  collabUsers: () => request({ url: '/api/mp/collab/users' }),

  // ---------- 门店营业数据（只读） ----------
  /** 门店列表（选择器数据源） */
  storeList: (params) => request({ url: '/api/mp/stores' + qs(params) }),
  /** 某门店有日报数据的日期（倒序） */
  revenueDates: (storeId, limit) => request({ url: '/api/mp/revenue/dates' + qs({ store_id: storeId, limit }) }),
  /** 门店 + 日期 → 营业数据（不传 date 则返回最近有数据的一天） */
  revenue: (storeId, date) => request({ url: '/api/mp/revenue' + qs({ store_id: storeId, date }) }),
}

export default api
