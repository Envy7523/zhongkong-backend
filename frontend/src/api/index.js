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
export const updateMyProfile = (data) => http.put('/api/auth/profile', data)

// ===== 配置 =====
export const getConfig = () => http.get('/api/config')
export const saveConfig = (data) => http.post('/api/config', data)
export const getBotStatus = () => http.get('/api/bot/status')
export const reconnectEnterpriseRobot = () => http.post('/api/enterprise-settings/robot/reconnect')
export const previewEnterpriseBotQuestion = (content) => http.post('/api/enterprise-settings/robot/preview-query', { content })
export const createEnterpriseAiProfile = (data) => http.post('/api/enterprise-settings/ai-profiles', data)
export const updateEnterpriseAiProfile = (profileId, data) => http.put(`/api/enterprise-settings/ai-profiles/${profileId}`, data)
// 保存仅影响未来计划，不立即执行或补跑历史日期。
export const getAutomationSchedule = () => http.get('/api/enterprise-settings/schedule')
export const saveAutomationSchedule = (data) => http.post('/api/enterprise-settings/schedule', data)
export const disableAutomationSchedule = () => http.post('/api/enterprise-settings/schedule/disable')
export const getWecomRouting = () => http.get('/api/enterprise-settings/wecom-routing')
export const createWecomBot = (data) => http.post('/api/enterprise-settings/wecom-routing/bots', data)
export const updateWecomBot = (id, data) => http.put(`/api/enterprise-settings/wecom-routing/bots/${id}`, data)
export const bindWecomRoute = (code, data) => http.put(`/api/enterprise-settings/wecom-routing/routes/${code}`, data)
export const activateWecomRoute = (code, data) => http.post(`/api/enterprise-settings/wecom-routing/routes/${code}/activation`, data)
export const savePosDailyExclusions = (data) => http.put('/api/enterprise-settings/wecom-routing/pos-daily/exclusions', data)
export const previewPosDaily = (businessDate) => http.get('/api/enterprise-settings/pos-daily/preview', { params: { business_date: businessDate } })
export const sendPosDailyTest = (data) => http.post('/api/enterprise-settings/pos-daily/test-send', data, { timeout: 30000 })

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
export const previewGroupBuyDailyPush = (data) => http.post('/api/push/group-buy-daily/preview', data)
export const sendGroupBuyDailyPush = (data) => http.post('/api/push/group-buy-daily/send', data)
export const getPushProfiles = () => http.get('/api/push/profiles')
export const updatePushProfile = (id, data) => http.put(`/api/push/profiles/${id}`, data)

// ===== 仪表盘 =====
export const getDashboardStats = () => http.get('/api/dashboard/stats')

// ===== 门店 CRUD =====
export const getStores = (params) => http.get('/api/db/stores', { params })
export const getStoreById = (id) => http.get(`/api/db/stores/${id}`)
export const createStore = (data) => http.post('/api/db/stores', data)
export const updateStore = (id, data) => http.put(`/api/db/stores/${id}`, data)
export const deleteStore = (id) => http.delete(`/api/db/stores/${id}`)
export const getStorePlatforms = () => http.get('/api/store-platforms')
export const saveStorePlatforms = (storeId, platforms) => http.put(`/api/stores/${storeId}/platforms`, { platforms })
export const resolveStorePlatform = (params) => http.get('/api/store-platforms/resolve', { params })

// ===== 门店 GLB 模型（分片上传 + 断点续传）=====
// 模型文件存在服务端磁盘上，库里只存元数据；下载走 JWT 鉴权接口。
// 100MB+ 的文件必须分片传：单片失败只重传一片，且前端把 upload_id 记在 localStorage，
// 关掉页面再回来能接着传（服务端以磁盘上的 .part 文件为准判断已收到哪些片）。
export const listStoreModels = () => http.get('/api/store-models')
export const getStoreModel = (storeId) => http.get(`/api/stores/${storeId}/model`)
export const getStoreModelAnnotations = (modelId) => http.get(`/api/store-models/${modelId}/annotations`)
export const createStoreModelAnnotation = (modelId, data) => http.post(`/api/store-models/${modelId}/annotations`, data)
export const deleteStoreModelAnnotation = (modelId, annotationId) => http.delete(`/api/store-models/${modelId}/annotations/${annotationId}`)
export const initStoreModelUpload = (data) => http.post('/api/store-models/uploads', data)
export const getStoreModelUploadState = (uploadId) => http.get(`/api/store-models/uploads/${uploadId}`)
// 单片可能要传几十秒，这里关掉全局 30s 超时，交给 axios 自身的进度事件
export const uploadStoreModelChunk = (uploadId, index, blob, onProgress) => http.put(
  `/api/store-models/uploads/${uploadId}/chunks/${index}`,
  blob,
  { headers: { 'Content-Type': 'application/octet-stream' }, timeout: 0, onUploadProgress: onProgress }
)
export const completeStoreModelUpload = (uploadId) => http.post(`/api/store-models/uploads/${uploadId}/complete`, null, { timeout: 0 })
export const abortStoreModelUpload = (uploadId) => http.delete(`/api/store-models/uploads/${uploadId}`)
export const deleteStoreModel = (id) => http.delete(`/api/store-models/${id}`)
export const getStoreModelPurge = () => http.get('/api/store-models/maintenance/orphans')
export const purgeStoreModelOrphans = (dryRun = true) => http.post('/api/store-models/maintenance/purge', { dry_run: dryRun })

// ===== 自定义门店区域 =====
export const getStoreRegions = () => http.get('/api/store-regions')
export const createStoreRegion = (data) => http.post('/api/store-regions', data)
export const updateStoreRegion = (id, data) => http.put(`/api/store-regions/${id}`, data)
export const deleteStoreRegion = (id) => http.delete(`/api/store-regions/${id}`)
export const setStoreRegionMembership = (storeId, regionId) => http.put(`/api/stores/${storeId}/region-membership`, { region_id: regionId })

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
export const getPositions = () => http.get('/api/positions')
export const createPosition = (data) => http.post('/api/positions', data)
export const updatePosition = (id, data) => http.put(`/api/positions/${id}`, data)
export const deletePosition = (id) => http.delete(`/api/positions/${id}`)

// ===== 菜品管理 =====
export const getMenuItems = (params) => http.get('/api/menu', { params })
export const createMenuItem = (data) => http.post('/api/menu', data)
export const updateMenuItem = (id, data) => http.put(`/api/menu/${id}`, data)
export const deleteMenuItem = (id) => http.delete(`/api/menu/${id}`)
export const getMenuCategories = () => http.get('/api/menu-categories')
export const getMenuCategoryList = () => http.get('/api/menu-category/list')
export const createMenuCategory = (data) => http.post('/api/menu-category', data)
export const updateMenuCategory = (id, data) => http.put(`/api/menu-category/${id}`, data)
export const reorderMenuCategories = (ids) => http.put('/api/menu-category/order', { ids })
export const deleteMenuCategory = (id) => http.delete(`/api/menu-category/${id}`)
export const adoptMenuCategory = (name) => http.post('/api/menu-category/adopt', { name })
export const getMenuCostComponents = (id) => http.get(`/api/menu/${id}/cost-components`)
export const saveMenuCostComponents = (id, components) => http.put(`/api/menu/${id}/cost-components`, { components })
export const deleteMenuCostComponents = (id) => http.delete(`/api/menu/${id}/cost-components`)

// ===== 菜品核算（禽类消耗反推）=====
// 当前挂在「菜品管理」下，功能打通后整体迁往「成本核算」，届时改这里的路径前缀即可。
export const getPoultrySpecies = () => http.get('/api/poultry/species')
export const createPoultrySpecies = (data) => http.post('/api/poultry/species', data)
export const updatePoultrySpecies = (id, data) => http.put(`/api/poultry/species/${id}`, data)
export const deletePoultrySpecies = (id) => http.delete(`/api/poultry/species/${id}`)
export const getPoultryYields = (params) => http.get('/api/poultry/yields', { params })
export const savePoultryYields = (birdId, rows) => http.put(`/api/poultry/yields/${birdId}`, { rows })
export const deletePoultryYield = (id) => http.delete(`/api/poultry/yields/${id}`)
export const getPoultryDishUsageOverview = (params) => http.get('/api/poultry/dish-usage', { params })
export const getPoultryDishUsage = (menuItemId) => http.get('/api/poultry/dish-usage', { params: { menu_item_id: menuItemId } })
export const savePoultryDishUsage = (menuItemId, rows) => http.put(`/api/poultry/dish-usage/${menuItemId}`, { rows })
// 按分组勾选多个菜品批量套用同一套部位耗用
export const batchSavePoultryDishUsage = (data) => http.post('/api/poultry/dish-usage/batch', data)
export const getPoultryConfiguredMenus = () => http.get('/api/poultry/dish-usage/configured')
export const getPoultryAccounting = (params) => http.get('/api/poultry/accounting', { params })
export const getPoultryConsumptionComparison = (params) => http.get('/api/poultry/accounting/consumption-comparison', { params })
// 消耗校准：模型理论只数 vs 门店录入的实际消耗只数（MAPE），用于评价参数好坏（每条都要跑一次核算，故放宽超时）
export const getPoultryCalibration = (params) => http.get('/api/poultry/calibration', { params, timeout: 180000 })
export const getPoultryConsumption = (params) => http.get('/api/poultry/consumption', { params })
export const savePoultryConsumption = (data) => http.post('/api/poultry/consumption', data)
export const deletePoultryConsumption = (id) => http.delete(`/api/poultry/consumption/${id}`)
export const getPoultryTemplate = () => http.get('/api/poultry/template')
export const importPoultryWorkbook = (data) => http.post('/api/poultry/import', data, { timeout: 120000 })
// 禽类菜范围（覆盖率分母口径：哪些菜算禽类菜，用户可维护）
export const getPoultryScope = () => http.get('/api/poultry/scope')
export const savePoultryScopeKeywords = (keywords) => http.put('/api/poultry/scope/keywords', { keywords })
export const savePoultryScopeDishes = (data) => http.post('/api/poultry/scope/dishes', data)
export const getPoultryScopePreview = () => http.get('/api/poultry/scope/preview')

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
export const getMonthlyOperatingDashboard = (params) => http.get('/api/analysis/monthly-operating-dashboard', { params })
export const getBusinessAnalytics = (scope = 'overview', params) => http.get(`/api/business-analytics/views/${scope}`, { params })
export const getMeituanOperation = (params) => http.get('/api/business-analytics/meituan-operation', { params })
export const getGroupBuyDailySummary = (params) => http.get('/api/business-analytics/group-buy/daily-summary', { params })
// all=1 直接写进 URL：不依赖 params 序列化与合并顺序，避免请求丢掉 all 后
// 被后端判成「既没给门店也没要全量」而报“请选择有效门店”。
export const getAllGroupBuyDailySummaries = (params = {}) => {
  const query = { ...params, all: '1' }
  // 去掉 undefined/null/空串：axios 不会发送这些键，但手写查询串会把它们变成
  // "store_id=undefined" 之类的脏值，后端判定门店无效就会报“请选择有效门店”。
  const search = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== '')).toString()
  return http.get(`/api/business-analytics/group-buy/daily-summary?${search}`)
}
export const saveGroupBuyDailySummary = (data) => http.put('/api/business-analytics/group-buy/daily-summary', data)
export const getDeliveryExternalExpenses = (params) => http.get('/api/business-analytics/external-expenses', { params })
export const createDeliveryExternalExpense = (data) => http.post('/api/business-analytics/external-expenses', data)
export const saveDeliveryExternalExpenseDaily = (data) => http.put('/api/business-analytics/external-expenses/daily', data)
export const deleteDeliveryExternalExpense = (id) => http.delete(`/api/business-analytics/external-expenses/${id}`)
export const getBusinessProductAnalytics = (scope = 'overview', params) => http.get(`/api/business-analytics/products/${scope}`, { params })
export const getBusinessProductMappings = (scope = 'overview', params) => http.get(`/api/business-analytics/mappings/${scope}`, { params })
export const saveBusinessProductMapping = (data) => http.put('/api/business-analytics/mappings', data)
export const savePosProductMapping = (data) => http.put('/api/business-analytics/pos-mappings', data)
export const batchSaveBusinessProductMappings = (data) => http.post('/api/business-analytics/mappings/batch', data)
export const deleteBusinessProductMapping = (id) => http.delete(`/api/business-analytics/mappings/${id}`)
export const getSpecLinks = (params) => http.get('/api/business-analytics/spec-links', { params })
export const saveSpecLinks = (data) => http.put('/api/business-analytics/spec-links', data)
export const deleteSpecLinks = (params) => http.delete('/api/business-analytics/spec-links', { params })
export const autoBindBusinessProductMappings = (scope) => http.post('/api/business-analytics/mappings/auto-bind', { scope })
// 与「堂食菜品绑定」的「智能采用全部推荐」同款：只采用精确命中的推荐
export const adoptBusinessProductRecommendations = (scope) => http.post('/api/business-analytics/mappings/adopt-recommendations', { scope })
export const previewAutoBindBusinessProductMappings = (scope) => http.post('/api/business-analytics/mappings/auto-bind/preview', { scope })
export const executeAutoBindBusinessProductMappings = (data) => http.post('/api/business-analytics/mappings/auto-bind/execute', data)
export const getBusinessDiagnosis = (params) => http.get('/api/business-analytics/diagnoses', { params })
export const generateBusinessDiagnosis = (data) => http.post('/api/business-analytics/diagnoses', data)
export const importBusinessData = (data) => http.post('/api/business-analytics/import', data, { timeout: 120000 })
export const importMeituanDeliveryData = (data) => http.post('/api/business-analytics/import/meituan-delivery', data, { timeout: 120000 })
export const importMeituanGroupBuyData = (data) => http.post('/api/business-analytics/import/meituan-group-buy', data, { timeout: 120000 })
export const importMeituanGroupOperationData = (data) => http.post('/api/business-analytics/import/meituan-group-operation', data, { timeout: 120000 })
export const importDouyinGroupBuyData = (data) => http.post('/api/business-analytics/import/douyin-group-buy', data, { timeout: 120000 })
export const importJdDeliveryData = (data) => http.post('/api/business-analytics/import/jd-delivery', data, { timeout: 120000 })
export const importTaobaoFlashData = (data) => http.post('/api/business-analytics/import/taobao-flash', data, { timeout: 120000 })
export const getBusinessImportBatches = (params) => http.get('/api/business-analytics/import-batches', { params })
export const getBusinessTemplate = (sourceType) => http.get('/api/business-analytics/template', { params: { source_type: sourceType } })

// ===== AI 自动导报表运行审计（结构化事件；不从普通日志解析）=====
export const getSyncRunsOverview = () => http.get('/api/business-analytics/sync-runs/overview')
export const getSyncRuns = (params) => http.get('/api/business-analytics/sync-runs', { params })
export const getSyncRunDetail = (id) => http.get(`/api/business-analytics/sync-runs/${id}`)

// ===== 菜品销售分析 =====
export const getDishSalesAnalytics = (params) => http.get('/api/dish-sales/analytics', { params })
// 合并口径：双表按区间分段 + 按标准菜品聚合（总视角「菜品销售分析」用）
export const getMergedDishAnalytics = (params) => http.get('/api/dish-sales/dish-analytics', { params })
export const getDishSales = (params) => http.get('/api/dish-sales', { params })
export const getDishSalesStats = () => http.get('/api/dish-sales/stats')
export const getDishSalesMappings = (params) => http.get('/api/dish-sales/mappings', { params })
export const saveDishSalesMapping = (data) => http.post('/api/dish-sales/mappings', data)
export const batchSaveDishSalesMappings = (data) => http.post('/api/dish-sales/mappings/batch', data)
export const deleteDishSalesMapping = (id) => http.delete(`/api/dish-sales/mappings/${id}`)
export const autoBindDishSalesMappings = () => http.post('/api/dish-sales/mappings/auto-bind')
// 智能推荐批量绑定：与「菜品销量」同一套识别规则（菜名归一化 + 编码互校 + 名称/规格唯一）
export const autoBindDishSalesMappingsSmart = () => http.post('/api/dish-sales/mappings/auto-bind-smart')

// ===== 日报导入 =====
export const importDailyReport = (data) => http.post('/api/reports/daily/import', data)
export const getDailyReportDB = (params) => http.get('/api/reports/daily/db', { params })

// ===== 耗材 =====
export const addSupply = (data) => http.post('/api/supplies', data)

// ===== 推送日志 =====
export const getPushLogs = (params) => http.get('/api/push-logs', { params })

// ===== 数据导出 =====
export const exportData = (params) => http.get('/api/data/export', { params })

// ===== 门店成本 =====
export const getFixedCosts = (storeId) => http.get(`/api/stores/${storeId}/fixed-costs`)
export const createFixedCost = (storeId, data) => http.post(`/api/stores/${storeId}/fixed-costs`, data)
export const updateFixedCost = (id, data) => http.put(`/api/fixed-costs/${id}`, data)
export const deleteFixedCost = (id) => http.delete(`/api/fixed-costs/${id}`)
export const getOperatingCosts = (storeId) => http.get(`/api/stores/${storeId}/operating-costs`)
export const getOperatingCostLedger = (params) => http.get('/api/operating-costs', { params })
export const saveMonthlyWage = (storeId, data) => http.put(`/api/stores/${storeId}/monthly-wage`, data)
export const saveMonthlyOperatingCost = (storeId, data) => http.put(`/api/stores/${storeId}/monthly-operating-cost`, data)
export const deleteOperatingCost = (id) => http.delete(`/api/operating-costs/${id}`)

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
export const batchDeleteBookkeepingEntries = (ids) => http.post('/api/bookkeeping/entries/batch-delete', { ids })
export const purgeBookkeepingEntries = (date_from, date_to) => http.post('/api/bookkeeping/entries/purge', { date_from, date_to })
export const previewBookkeepingQuickEntry = (data) => http.post('/api/bookkeeping/quick-entry/preview', data)
export const commitBookkeepingQuickEntry = (data) => http.post('/api/bookkeeping/quick-entry/commit', data)

// ===== 员工管理（人事档案）=====
export const getStaffList = (params) => http.get('/api/staff', { params })
export const getStaffStats = (params) => http.get('/api/staff/stats', { params })
export const createStaff = (data) => http.post('/api/staff', data)
export const importStaffWorkbook = (data) => http.post('/api/staff/import', data)
export const updateStaff = (id, data) => http.put(`/api/staff/${id}`, data)
export const getStaffLifecycle = (id) => http.get(`/api/staff/${id}/lifecycle`)
export const getStaffSalaryProfile = (id) => http.get(`/api/staff/${id}/salary-profile`)
export const saveStaffSalaryProfile = (id, data) => http.put(`/api/staff/${id}/salary-profile`, data)
export const generateStaffPayrollSheet = (data) => http.post('/api/staff/payroll-sheet', data, { responseType: 'blob', timeout: 120000 })
export const getPayrollMonthSetting = (period) => http.get(`/api/payroll-month-settings/${period}`)
export const savePayrollMonthSetting = (period, data) => http.put(`/api/payroll-month-settings/${period}`, data)
export const getPayrollSheets = () => http.get('/api/payroll-sheets')
export const preparePayrollSheet = (data) => http.post('/api/payroll-sheets/prepare', data)
export const getPayrollSheet = (id) => http.get(`/api/payroll-sheets/${id}`)
export const savePayrollSheet = (id, data) => http.put(`/api/payroll-sheets/${id}`, data)
export const exportPayrollSheet = (id) => http.get(`/api/payroll-sheets/${id}/export`, { responseType: 'blob', timeout: 120000 })
export const getDingTalkAttendanceStatus = () => http.get('/api/staff/dingtalk/status')
export const syncDingTalkAttendance = (data) => http.post('/api/staff/dingtalk/sync', data)
export const getStaffDingTalkAttendance = (id, params) => http.get(`/api/staff/${id}/dingtalk-attendance`, { params })
export const seedStaff = () => http.post('/api/staff/seed')
export const syncPullStaff = () => http.get('/api/staff/sync-pull')
// 以机器人身份从企微智能表格读员工档案（无需自建应用 wedoc 权限）
export const syncStaffFromWecom = () => http.post('/api/staff/sync-wecom', {})
export const getStaffStoreManagers = () => http.get('/api/staff/store-managers')
export const saveStaffStoreManager = (storeId, employeeId) => http.put(`/api/staff/store-managers/${storeId}`, { employee_id: employeeId })
export const getStaffDispatches = (params) => http.get('/api/staff/dispatches', { params })
export const createStaffDispatch = (data) => http.post('/api/staff/dispatches', data)
export const cancelStaffDispatch = (id) => http.put(`/api/staff/dispatches/${id}`, { status: '已取消' })

// ===== 消息通知 =====
export const getNotifications = (params) => http.get('/api/notifications', { params })
export const getNotificationSummary = () => http.get('/api/notifications/summary')
// 手动创建通知：人选人、多选接收者、可定时到分钟
export const createNotification = (data) => http.post('/api/notifications/create', data)
export const getNotificationCreated = () => http.get('/api/notifications/created')
// 仅「定时未发布」的通知可改可撤
export const updateCreatedNotification = (id, data) => http.put(`/api/notifications/created/${id}`, data)
export const withdrawNotification = (id) => http.delete(`/api/notifications/created/${id}`)
// 首次弹窗：返回还没弹过的通知，并标记为已弹（每条只弹一次）
export const getNotificationPopup = () => http.get('/api/notifications/popup')
export const updateNotification = (id, data) => http.put(`/api/notifications/${id}`, data)
export const getNotificationSettings = () => http.get('/api/notifications/settings')
export const saveNotificationSettings = (data) => http.put('/api/notifications/settings', data)
export const checkNotifications = () => http.post('/api/notifications/check', {})
export const sendTestNotification = () => http.post('/api/notifications/test', {})

// ===== 数据库查看器（只读，开发辅助）=====
export const dbViewerOverview = () => http.get('/api/db-viewer/overview')
export const dbViewerTables = () => http.get('/api/db-viewer/tables')
export const dbViewerTable = (name, params) => http.get(`/api/db-viewer/table/${encodeURIComponent(name)}`, { params })
export const dbViewerRefs = (table) => http.get('/api/db-viewer/refs', { params: { table } })
export const dbViewerFeatureMap = () => http.get('/api/db-viewer/feature-map')
export const dbViewerFiles = (dir) => http.get('/api/db-viewer/files', { params: { dir } })
export const dbViewerFile = (filePath, mode) => http.get('/api/db-viewer/file', { params: mode ? { path: filePath, [mode]: '1' } : { path: filePath } })
export const dbViewerQuery = (sql) => http.post('/api/db-viewer/query', { sql })
export const dbViewerDataHealth = (days) => http.get('/api/db-viewer/data-health', { params: { days } })
