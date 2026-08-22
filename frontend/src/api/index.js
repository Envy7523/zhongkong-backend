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
export const getBotStatus = () => http.get('/api/bot/status')
export const reconnectEnterpriseRobot = () => http.post('/api/enterprise-settings/robot/reconnect')
export const previewEnterpriseBotQuestion = (content) => http.post('/api/enterprise-settings/robot/preview-query', { content })
export const createEnterpriseAiProfile = (data) => http.post('/api/enterprise-settings/ai-profiles', data)
export const updateEnterpriseAiProfile = (profileId, data) => http.put(`/api/enterprise-settings/ai-profiles/${profileId}`, data)

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
export const searchAround = (params) => http.get('/api/amap/around', { params })

// ===== 地图自定义点位 =====
export const getMapPins = (params) => http.get('/api/map-pins', { params })
export const createMapPin = (data) => http.post('/api/map-pins', data)
export const updateMapPin = (id, data) => http.put(`/api/map-pins/${id}`, data)
export const deleteMapPin = (id) => http.delete(`/api/map-pins/${id}`)
export const clearAllMapPins = () => http.delete('/api/map-pins')

// ===== 点位评论 =====
export const getPinComments = (pinId) => http.get(`/api/map-pins/${pinId}/comments`)
export const addPinComment = (pinId, content, parentId, replyToName) => http.post(`/api/map-pins/${pinId}/comments`, { content, parent_id: parentId || null, reply_to_name: replyToName || '' })
export const deletePinComment = (pinId, commentId) => http.delete(`/api/map-pins/${pinId}/comments/${commentId}`)

// ===== 门店评论 =====
export const getStoreComments = (storeId) => http.get(`/api/stores/${storeId}/comments`)
export const addStoreComment = (storeId, content, parentId, replyToName) => http.post(`/api/stores/${storeId}/comments`, { content, parent_id: parentId || null, reply_to_name: replyToName || '' })
export const deleteStoreComment = (storeId, commentId) => http.delete(`/api/stores/${storeId}/comments/${commentId}`)

// ===== 用户管理 =====
export const getUsers = () => http.get('/api/users')
export const createUser = (data) => http.post('/api/users', data)
export const updateUser = (id, data) => http.put(`/api/users/${id}`, data)
export const updateUserPassword = (id, password) => http.put(`/api/users/${id}/password`, { password })
export const uploadUserAvatar = (id, data) => http.post(`/api/users/${id}/avatar`, { data })
export const deleteUserAvatar = (id) => http.delete(`/api/users/${id}/avatar`)
export const deleteUser = (id) => http.delete(`/api/users/${id}`)

// ===== 菜品管理 =====
export const getMenuItems = (params) => http.get('/api/menu', { params })
export const createMenuItem = (data) => http.post('/api/menu', data)
export const updateMenuItem = (id, data) => http.put(`/api/menu/${id}`, data)
export const deleteMenuItem = (id) => http.delete(`/api/menu/${id}`)
export const getMenuCategories = () => http.get('/api/menu-categories')
export const getMenuCategoryList = () => http.get('/api/menu-category/list')
export const createMenuCategory = (data) => http.post('/api/menu-category', data)
export const updateMenuCategory = (id, data) => http.put(`/api/menu-category/${id}`, data)
export const deleteMenuCategory = (id) => http.delete(`/api/menu-category/${id}`)
export const adoptMenuCategory = (name) => http.post('/api/menu-category/adopt', { name })
export const getMenuCostComponents = (id) => http.get(`/api/menu/${id}/cost-components`)
export const saveMenuCostComponents = (id, components) => http.put(`/api/menu/${id}/cost-components`, { components })

// ===== 菜品模板 =====
export const getMenuTemplates = () => http.get('/api/menu-templates')
export const createMenuTemplate = (data) => http.post('/api/menu-templates', data)
export const updateMenuTemplate = (id, data) => http.put(`/api/menu-templates/${id}`, data)
export const deleteMenuTemplate = (id) => http.delete(`/api/menu-templates/${id}`)
export const getMenuTemplateDetail = (id) => http.get(`/api/menu-templates/${id}`)
export const createTemplateItem = (templateId, data) => http.post(`/api/menu-templates/${templateId}/items`, data)
export const updateTemplateItem = (templateId, itemId, data) => http.put(`/api/menu-templates/${templateId}/items/${itemId}`, data)
export const deleteTemplateItem = (templateId, itemId) => http.delete(`/api/menu-templates/${templateId}/items/${itemId}`)

// ===== 成本核算 =====
export const getCostAccounting = (params) => http.get('/api/cost-accounting', { params })
export const calculateCost = (data) => http.post('/api/cost-accounting/calculate', data)
export const getWeeklyCost = () => http.get('/api/cost-accounting/weekly')
export const getMonthlyCost = () => http.get('/api/cost-accounting/monthly')

// ===== 数据分析 =====
export const getRevenueAnalysis = (params) => http.get('/api/analysis/revenue', { params })
export const getCostAnalysis = (params) => http.get('/api/analysis/cost', { params })
export const getSalesAnalysis = () => http.get('/api/analysis/sales')
export const getBusinessAnalytics = (scope = 'overview', params) => http.get(`/api/business-analytics/views/${scope}`, { params })
export const getBusinessProductAnalytics = (scope = 'overview', params) => http.get(`/api/business-analytics/products/${scope}`, { params })
export const getBusinessProductMappings = (scope = 'overview', params) => http.get(`/api/business-analytics/mappings/${scope}`, { params })
export const saveBusinessProductMapping = (data) => http.put('/api/business-analytics/mappings', data)
export const batchSaveBusinessProductMappings = (data) => http.post('/api/business-analytics/mappings/batch', data)
export const deleteBusinessProductMapping = (id) => http.delete(`/api/business-analytics/mappings/${id}`)
export const autoBindBusinessProductMappings = (scope) => http.post('/api/business-analytics/mappings/auto-bind', { scope })
export const getBusinessDiagnosis = (params) => http.get('/api/business-analytics/diagnoses', { params })
export const generateBusinessDiagnosis = (data) => http.post('/api/business-analytics/diagnoses', data)
export const importBusinessData = (data) => http.post('/api/business-analytics/import', data, { timeout: 120000 })
export const getBusinessTemplate = (sourceType) => http.get('/api/business-analytics/template', { params: { source_type: sourceType } })

// ===== 菜品销售分析 =====
export const getDishSalesAnalytics = (params) => http.get('/api/dish-sales/analytics', { params })
export const getDishSales = (params) => http.get('/api/dish-sales', { params })
export const getDishSalesStats = () => http.get('/api/dish-sales/stats')
export const getDishSalesMappings = (params) => http.get('/api/dish-sales/mappings', { params })
export const saveDishSalesMapping = (data) => http.post('/api/dish-sales/mappings', data)
export const batchSaveDishSalesMappings = (data) => http.post('/api/dish-sales/mappings/batch', data)
export const deleteDishSalesMapping = (id) => http.delete(`/api/dish-sales/mappings/${id}`)
export const autoBindDishSalesMappings = () => http.post('/api/dish-sales/mappings/auto-bind')

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

// ===== 协同事项管理 =====
export const getCollabIssues = (params) => http.get('/api/collab/issues', { params })
export const getCollabIssue = (id) => http.get(`/api/collab/issues/${id}`)
export const createCollabIssue = (data) => http.post('/api/collab/issues', data)
export const updateCollabParticipants = (id, data) => http.put(`/api/collab/issues/${id}/participants`, data)
export const updateCollabDeadline = (id, data) => http.put(`/api/collab/issues/${id}/deadline`, data)
export const archiveCollabIssue = (id) => http.post(`/api/collab/issues/${id}/archive`)
export const deleteCollabIssue = (id) => http.delete(`/api/collab/issues/${id}`)
export const replyCollabIssue = (id, data) => http.post(`/api/collab/issues/${id}/reply`, data)
export const editCollabReply = (id, replyId, data) => http.put(`/api/collab/issues/${id}/replies/${replyId}`, data)
export const advanceCollabIssue = (id, data) => http.put(`/api/collab/issues/${id}/advance`, data)
export const reviewCollabCompletion = (id, replyId, data) => http.put(`/api/collab/issues/${id}/completions/${replyId}/review`, data)
export const extendCollabIssue = (id, data) => http.post(`/api/collab/issues/${id}/extensions`, data)
export const getCollabUsers = () => http.get('/api/collab/users')

// ===== 智能表格 Webhook 测试 =====
export const sendSmartSheet = (data) => http.post('/api/webhook/smartsheet', data)

// ===== Bot 机器人（bot id + secret 数据互通）=====
export const botTest = () => http.post('/api/bot/test')
export const botQuery = (data) => http.post('/api/bot/query', data)

// ===== 记账本 =====
export const getBookkeepingCategories = () => http.get('/api/bookkeeping/categories')
export const createBookkeepingCategory = (data) => http.post('/api/bookkeeping/categories', data)
export const updateBookkeepingCategory = (id, data) => http.put(`/api/bookkeeping/categories/${id}`, data)
export const deleteBookkeepingCategory = (id) => http.delete(`/api/bookkeeping/categories/${id}`)
export const getBookkeepingSubcategories = (params) => http.get('/api/bookkeeping/subcategories', { params })
export const createBookkeepingSubcategory = (data) => http.post('/api/bookkeeping/subcategories', data)
export const updateBookkeepingSubcategory = (id, data) => http.put(`/api/bookkeeping/subcategories/${id}`, data)
export const deleteBookkeepingSubcategory = (id) => http.delete(`/api/bookkeeping/subcategories/${id}`)
export const getBookkeepingEntries = (params) => http.get('/api/bookkeeping/entries', { params })
export const createBookkeepingEntry = (data) => http.post('/api/bookkeeping/entries', data)
export const deleteBookkeepingEntry = (id) => http.delete(`/api/bookkeeping/entries/${id}`)

// ===== 员工管理（店长 + 店员）=====
export const getStaffList = (params) => http.get('/api/staff', { params })
export const getStaffStats = (params) => http.get('/api/staff/stats', { params })
export const updateStaff = (id, data) => http.put(`/api/staff/${id}`, data)
export const seedStaff = () => http.post('/api/staff/seed')
export const syncPullStaff = () => http.get('/api/staff/sync-pull')
