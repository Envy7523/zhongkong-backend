import axios from 'axios'

const TOKEN_KEY = 'etaigong_token'

const http = axios.create({
  baseURL: '',
  timeout: 30000,
})

// 请求拦截：自动带 token
http.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY)
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// 响应拦截：401 清除 token 并跳转登录
http.interceptors.response.use(
  (res) => res.data,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem(TOKEN_KEY)
      if (window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
    }
    const msg = err.response?.data?.error || err.message || '请求失败'
    return Promise.reject(new Error(msg))
  }
)

// ===== 认证 =====
export const login = (username, password) => http.post('/api/auth/login', { username, password })
export const getMe = () => http.get('/api/auth/me')

// ===== 配置 =====
export const getConfig = () => http.get('/api/config')
export const saveConfig = (data) => http.post('/api/config', data)

// ===== 企业微信 Token =====
export const getToken = () => http.get('/api/wechat/token')

// ===== Webhook 发送 =====
export const sendWebhook = (data) => http.post('/api/wechat/send', data)

// ===== 企业微信数据查询 =====
export const queryWechatDoc = (data) => http.post('/api/wechat/doc', data)

// ===== 一键推送 =====
export const runPipeline = (data) => http.post('/api/wechat/pipeline', data)

// ===== 智能表格 =====
export const getTableInfo = (data) => http.post('/api/wechat/table/info', data)
export const getTableSheets = (data) => http.post('/api/wechat/table/sheets', data)
export const getTableRecords = (data) => http.post('/api/wechat/table/records', data)
export const tablePipeline = (data) => http.post('/api/wechat/table/pipeline', data)

// ===== 日报推送 =====
export const sendReport = (data) => http.post('/api/wechat/report/send', data)

// ===== 仪表盘 =====
export const getDashboardStats = () => http.get('/api/dashboard/stats')

// ===== 门店 CRUD =====
export const getStores = (params) => http.get('/api/db/stores', { params })
export const getStoreById = (id) => http.get(`/api/db/stores/${id}`)
export const createStore = (data) => http.post('/api/db/stores', data)
export const updateStore = (id, data) => http.put(`/api/db/stores/${id}`, data)
export const deleteStore = (id) => http.delete(`/api/db/stores/${id}`)

// ===== 门店统计 =====
export const getStoreStats = () => http.get('/api/db/stores/stats')
export const getStoreByProvince = () => http.get('/api/db/stores/by-province')
export const getStoreByCity = (province) => http.get('/api/db/stores/by-city', { params: { province } })

// ===== 地图统计（数组格式）=====
export const getProvinceStats = () => http.get('/api/stores/province-stats')
export const getCityStats = (province) => http.get('/api/stores/city-stats', { params: { province } })
export const getDistrictStats = (province, city) => http.get('/api/stores/district-stats', { params: { province, city } })
export const getStoreLocations = (params) => http.get('/api/stores/locations', { params })
export const geocodeAddress = (params) => http.get('/api/geocode', { params })

// ===== 地图自定义点位 =====
export const getMapPins = (params) => http.get('/api/map-pins', { params })
export const createMapPin = (data) => http.post('/api/map-pins', data)
export const updateMapPin = (id, data) => http.put(`/api/map-pins/${id}`, data)
export const deleteMapPin = (id) => http.delete(`/api/map-pins/${id}`)

// ===== 用户管理 =====
export const getUsers = () => http.get('/api/users')
export const createUser = (data) => http.post('/api/users', data)
export const updateUser = (id, data) => http.put(`/api/users/${id}`, data)
export const deleteUser = (id) => http.delete(`/api/users/${id}`)

// ===== 菜品管理 =====
export const getMenuItems = (params) => http.get('/api/db/menu-items', { params })
export const createMenuItem = (data) => http.post('/api/db/menu-items', data)
export const updateMenuItem = (id, data) => http.put(`/api/db/menu-items/${id}`, data)
export const deleteMenuItem = (id) => http.delete(`/api/db/menu-items/${id}`)

// ===== 成本核算 =====
export const getCostAccounting = (params) => http.get('/api/cost-accounting', { params })
export const calculateCost = (data) => http.post('/api/cost-accounting/calculate', data)
export const getWeeklyCost = () => http.get('/api/cost-accounting/weekly')
export const getMonthlyCost = () => http.get('/api/cost-accounting/monthly')

// ===== 数据分析 =====
export const getRevenueAnalysis = (params) => http.get('/api/analysis/revenue', { params })
export const getCostAnalysis = (params) => http.get('/api/analysis/cost', { params })
export const getSalesAnalysis = () => http.get('/api/analysis/sales')

// ===== 日报导入 =====
export const importDailyReport = (data) => http.post('/api/reports/daily/import', data)
export const getDailyReportDB = (params) => http.get('/api/reports/daily/db', { params })

// ===== 耗材 =====
export const addSupply = (data) => http.post('/api/supplies', data)

// ===== 推送日志 =====
export const getPushLogs = (params) => http.get('/api/push-logs', { params })

// ===== 数据导出 =====
export const exportData = (params) => http.get('/api/data/export', { params })

// ===== 门店运营成本 =====
export const getOperatingCosts = (storeId) => http.get(`/api/stores/${storeId}/operating-costs`)
