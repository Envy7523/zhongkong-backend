import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

const PAGE_TITLES = {
  dashboard: '数据概括',
  'api-config': '中控绑定',
  pipeline: '一键推送',
  'table-reader': '表格读取',
  'data-query': '数据查询',
  report: '日报推送',
  settings: '网页设置',
  'ai-assistant': 'AI助手',
  'data-import': '数据导入',
  'user-management': '人员管理',
  analysis: '数据分析',
  'store-management': '门店管理',
  'menu-management': '菜品管理',
  'cost-accounting': '成本核算',
}

const SUB_LABELS = {
  analysis: { revenue: '门店营收构成', cost: '门店成本分析', sales: '门店销量统计', supplies: '门店耗材消耗' },
  'store-management': { 'info-basic': '门店基本信息', 'info-circle': '门店商圈', 'info-platform': '第三方平台', 'info-config': '门店配置', map: '全国地图', fixed: '固定成本', operating: '运营成本' },
  'menu-management': { overview: '菜品总览', cost: '菜品成本', expiry: '效期管理' },
  'cost-accounting': { daily: '日成本核算', weekly: '周成本核算', monthly: '月成本核算' },
}

// 从 menu index 解析 page 和 sub
const INDEX_TO_PAGE_SUB = {}
for (const [page, subs] of Object.entries(SUB_LABELS)) {
  for (const sub of Object.keys(subs)) {
    INDEX_TO_PAGE_SUB[`${page}-${sub}`] = { page, sub }
  }
}
// 简单页面
for (const page of Object.keys(PAGE_TITLES)) {
  if (!page.includes('-')) {
    INDEX_TO_PAGE_SUB[page] = { page, sub: null }
  }
}

export const useAppStore = defineStore('app', () => {
  const sidebarCollapsed = ref(false)
  const serverOnline = ref(false)
  const serverStatusText = ref('⏳ 检测中...')

  // 标签页管理
  const tabs = ref([])
  const activeTabId = ref('')

  function getTabTitle(id) {
    const info = INDEX_TO_PAGE_SUB[id]
    if (!info) return id
    const base = PAGE_TITLES[info.page] || info.page
    if (info.sub && SUB_LABELS[info.page]?.[info.sub]) {
      return base + ' · ' + SUB_LABELS[info.page][info.sub]
    }
    return base
  }

  function openTabFromId(id) {
    const existing = tabs.value.find((t) => t.id === id)
    if (existing) {
      activeTabId.value = id
      return
    }

    const title = getTabTitle(id)
    tabs.value.push({
      id,
      title,
      closable: id !== 'dashboard',
    })
    activeTabId.value = id
  }

  function closeTab(id) {
    const idx = tabs.value.findIndex((t) => t.id === id)
    if (idx === -1) return
    const tab = tabs.value[idx]
    if (!tab.closable) return
    tabs.value.splice(idx, 1)
    if (activeTabId.value === id) {
      const next = tabs.value[Math.min(idx, tabs.value.length - 1)]
      activeTabId.value = next?.id || ''
    }
  }

  function closeOtherTabs() {
    const active = tabs.value.find((t) => t.id === activeTabId.value)
    if (!active) return
    tabs.value = tabs.value.filter((t) => t.id === activeTabId.value || !t.closable)
  }

  const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value))

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  function setServerStatus(online) {
    serverOnline.value = online
    serverStatusText.value = online ? '● 服务运行中' : '● 后端未启动'
  }

  return {
    sidebarCollapsed,
    serverOnline,
    serverStatusText,
    tabs,
    activeTabId,
    activeTab,
    openTabFromId,
    closeTab,
    closeOtherTabs,
    toggleSidebar,
    setServerStatus,
  }
})
