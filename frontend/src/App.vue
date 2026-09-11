<template>
  <LoginView v-if="isLoginPage" />
  <div v-else :class="['app-layout enterprise-theme', { 'is-compact': responsiveCollapsed }]">
    <!-- 侧边栏 -->
    <aside :class="['app-sidebar', { 'is-collapsed': isSidebarCollapsed }]">
      <div class="sidebar-brand">
        <span class="sidebar-brand-mark">鹅</span>
        <span class="sidebar-brand-copy">
          <b>鹅太公中控</b>
          <small>经营管理平台</small>
        </span>
      </div>
      <div class="sidebar-navigation">
        <el-menu
          :default-active="sidebarActive"
          :collapse="isSidebarCollapsed"
          background-color="transparent"
          text-color="#93a0b8"
          active-text-color="#fff"
          @select="handleMenuSelect"
        >
          <div class="sidebar-section-label">总览</div>
          <el-menu-item index="dashboard">
            <el-icon><DataAnalysis /></el-icon>
            <template #title><span>数据概括</span><small class="nav-badge">HOME</small></template>
          </el-menu-item>

          <div class="sidebar-section-label">核心业务</div>
          <el-menu-item
            index="analysis-group"
            @mouseenter="showPopup('analysis', $event)"
            @mouseleave="scheduleHidePopup"
            :class="{ 'is-popup-open': popupMenu.group === 'analysis', 'is-active': store.activeTabId?.startsWith('analysis-') }"
          >
            <el-icon><TrendCharts /></el-icon>
            <template #title><span>数据分析</span><span class="nav-arrow">›</span></template>
          </el-menu-item>
          <el-menu-item
            index="store-management-group"
            @mouseenter="showPopup('store-management', $event)"
            @mouseleave="scheduleHidePopup"
            :class="{ 'is-popup-open': popupMenu.group === 'store-management', 'is-active': store.activeTabId?.startsWith('store-management-') }"
          >
            <el-icon><Shop /></el-icon>
            <template #title><span>门店管理</span><span class="nav-arrow">›</span></template>
          </el-menu-item>
          <el-menu-item
            index="store-preparation-group"
            @mouseenter="showPopup('store-preparation', $event)"
            @mouseleave="scheduleHidePopup"
            :class="{ 'is-popup-open': popupMenu.group === 'store-preparation', 'is-active': store.activeTabId?.startsWith('store-preparation-') }"
          >
            <el-icon><Box /></el-icon>
            <template #title><span>筹建门店</span><span class="nav-arrow">›</span></template>
          </el-menu-item>
          <el-menu-item
            index="menu-management-group"
            @mouseenter="showPopup('menu-management', $event)"
            @mouseleave="scheduleHidePopup"
            :class="{ 'is-popup-open': popupMenu.group === 'menu-management', 'is-active': store.activeTabId?.startsWith('menu-management-') }"
          >
            <el-icon><DishDot /></el-icon>
            <template #title><span>菜品管理</span><span class="nav-arrow">›</span></template>
          </el-menu-item>
          <el-menu-item
            index="cost-accounting-group"
            @mouseenter="showPopup('cost-accounting', $event)"
            @mouseleave="scheduleHidePopup"
            :class="{ 'is-popup-open': popupMenu.group === 'cost-accounting', 'is-active': store.activeTabId?.startsWith('cost-accounting-') }"
          >
            <el-icon><Money /></el-icon>
            <template #title><span>成本核算</span><span class="nav-arrow">›</span></template>
          </el-menu-item>

          <el-menu-item
            index="staff-management-group"
            @mouseenter="showPopup('staff-management', $event)"
            @mouseleave="scheduleHidePopup"
            :class="{ 'is-popup-open': popupMenu.group === 'staff-management', 'is-active': store.activeTabId?.startsWith('staff-management-') }"
          >
            <el-icon><Avatar /></el-icon>
            <template #title><span>人事专区</span><span class="nav-arrow">›</span></template>
          </el-menu-item>

          <div class="sidebar-section-label">运营工具</div>
          <el-menu-item index="collab-list">
            <el-icon><List /></el-icon>
            <template #title><span>协同事项</span><small class="nav-badge new">NEW</small></template>
          </el-menu-item>
          <el-menu-item index="bookkeeping-entry">
            <el-icon><Notebook /></el-icon>
            <template #title><span>记账本</span><small class="nav-badge new">NEW</small></template>
          </el-menu-item>
          <el-menu-item
            index="data-import-group"
            @mouseenter="showPopup('data-import', $event)"
            @mouseleave="scheduleHidePopup"
            :class="{ 'is-popup-open': popupMenu.group === 'data-import', 'is-active': store.activeTabId?.startsWith('data-import-') }"
          >
            <el-icon><Download /></el-icon>
            <template #title><span>数据导入</span><span class="nav-arrow">›</span></template>
          </el-menu-item>
          <el-menu-item index="pipeline">
            <el-icon><Upload /></el-icon>
            <template #title>一键推送</template>
          </el-menu-item>
          <el-menu-item index="ai-assistant">
            <el-icon><ChatDotRound /></el-icon>
            <template #title><span>AI 助手</span><small class="nav-badge beta">BETA</small></template>
          </el-menu-item>

          <div class="sidebar-section-label">系统管理</div>
          <el-menu-item index="enterprise-settings">
            <el-icon><Setting /></el-icon>
            <template #title>企业设置</template>
          </el-menu-item>
          <el-menu-item index="user-management">
            <el-icon><User /></el-icon>
            <template #title>人员管理</template>
          </el-menu-item>
          <el-menu-item index="settings">
            <el-icon><Setting /></el-icon>
            <template #title>网页设置</template>
          </el-menu-item>
        </el-menu>
      </div>

    </aside>

    <!-- 浮动弹出菜单面板 -->
    <Teleport to="body">
      <div
        class="nav-popup-panel"
        :class="{ visible: popupMenu.visible }"
        :style="popupStyle"
        @mouseenter="cancelHidePopup"
        @mouseleave="scheduleHidePopup"
      >
        <template v-if="popupMenu.group">
          <div
            v-for="section in popupMenu.sections"
            :key="section.title"
            class="popup-section"
          >
            <div class="popup-section-title">{{ section.title }}</div>
            <div
              v-for="item in section.items"
              :key="item.index"
              class="popup-item"
              :class="{ active: store.activeTabId === item.index }"
              @click="selectPopupItem(item.index)"
            >
              {{ item.label }}
            </div>
          </div>
        </template>
      </div>
    </Teleport>

    <!-- 主区域 -->
    <div class="app-main">
      <div class="app-topbar">
        <el-button @click="toggleSidebar" text aria-label="展开或收起侧边栏">
          <el-icon v-if="isSidebarCollapsed"><Expand /></el-icon>
          <el-icon v-else><Fold /></el-icon>
        </el-button>
        <span class="topbar-title">{{ pageTitle }}</span>
        <span :class="['topbar-status', store.serverOnline ? 'online' : 'offline']">{{ store.serverStatusText }}</span>
        <el-dropdown v-if="auth.user" trigger="click" class="topbar-account">
          <button class="topbar-account-trigger" type="button">
            <img v-if="auth.user.avatar_url" :src="auth.user.avatar_url" class="topbar-avatar" alt="" />
            <span v-else class="topbar-avatar fallback">{{ userInitial }}</span>
            <span class="topbar-account-copy">
              <b>{{ auth.user.display_name || auth.user.username }}</b>
              <small>{{ auth.user.role || '系统成员' }}</small>
            </span>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item :icon="SwitchButton" divided @click="handleLogout">退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>

      <div class="tab-bar-wrapper" v-if="store.tabs.length > 0">
        <div class="tab-bar">
          <div
            v-for="tab in store.tabs"
            :key="tab.id"
            :class="['tab-item', { active: tab.id === store.activeTabId }]"
            @click="selectTab(tab.id)"
            :title="tab.title"
          >
            <span class="tab-title">{{ tab.title }}</span>
            <span v-if="tab.closable" class="tab-close" @click.stop="closeTab(tab.id)">×</span>
          </div>
        </div>
        <div class="tab-actions">
          <el-button size="small" text @click="store.closeOtherTabs()" title="关闭其他标签页">⋮</el-button>
        </div>
      </div>

      <div ref="contentAreaRef" class="content-area">
        <router-view v-slot="{ Component, route }">
          <KeepAlive :max="30">
            <component v-if="isSpecialRoute && Component" :is="Component" :key="route.name || route.path" />
          </KeepAlive>
        </router-view>
        <KeepAlive :max="30">
          <component v-if="!isSpecialRoute" :is="currentView" :key="store.activeTabId" />
        </KeepAlive>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { SwitchButton } from '@element-plus/icons-vue'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { getConfig } from '@/api'
import LoginView from '@/views/LoginView.vue'

import DashboardView from '@/views/DashboardView.vue'
import PipelineView from '@/views/PipelineView.vue'
import DataImportView from '@/views/DataImportView.vue'
import BusinessDataImport from '@/views/BusinessDataImport.vue'
import UserManagementView from '@/views/UserManagementView.vue'
import AiAssistantView from '@/views/AiAssistantView.vue'
import SettingsView from '@/views/SettingsView.vue'
import SalesAnalysis from '@/views/analysis/SalesAnalysis.vue'
import SuppliesAnalysis from '@/views/analysis/SuppliesAnalysis.vue'
import StoreBasic from '@/views/store/StoreBasic.vue'
import StorePlatform from '@/views/store/StorePlatform.vue'
import StoreConfig from '@/views/store/StoreConfig.vue'
import StoreFixedCost from '@/views/store/StoreFixedCost.vue'
import StoreOperatingCost from '@/views/store/StoreOperatingCost.vue'
import StoreBusinessCircle from '@/views/store/StoreBusinessCircle.vue'
import StoreMap from '@/views/store/StoreMap.vue'
import StoreRegionManage from '@/views/store/StoreRegionManage.vue'
import MenuOverview from '@/views/menu/MenuOverview.vue'
import MenuCategory from '@/views/menu/MenuCategory.vue'
import MenuCost from '@/views/menu/MenuCost.vue'
import MenuExpiry from '@/views/menu/MenuExpiry.vue'
import MenuAccounting from '@/views/menu/MenuAccounting.vue'
import MenuTemplate from '@/views/menu/MenuTemplate.vue'
import DailyCost from '@/views/cost/DailyCost.vue'
import WeeklyCost from '@/views/cost/WeeklyCost.vue'
import MonthlyCost from '@/views/cost/MonthlyCost.vue'
import StaffManager from '@/views/staff/StaffManager.vue'
import StaffClerk from '@/views/staff/StaffClerk.vue'
import StaffTest from '@/views/staff/StaffTest.vue'
import StaffEmployees from '@/views/staff/StaffEmployees.vue'
import StaffStoreManagement from '@/views/staff/StaffStoreManagement.vue'
import SalaryPlaceholder from '@/views/staff/SalaryPlaceholder.vue'
import BookkeepingEntry from '@/views/bookkeeping/BookkeepingEntry.vue'
import BookkeepingCategories from '@/views/bookkeeping/BookkeepingCategories.vue'
import BookkeepingRecords from '@/views/bookkeeping/BookkeepingRecords.vue'

const COMPONENT_MAP = {
  dashboard: DashboardView,
  pipeline: PipelineView,
  'data-import': DataImportView,
  'data-import-pos': BusinessDataImport,
  'data-import-group-buy': BusinessDataImport,
  'data-import-delivery': BusinessDataImport,
  'data-import-legacy': DataImportView,
  'user-management': UserManagementView,
  'ai-assistant': AiAssistantView,
  settings: SettingsView,
  'analysis-sales': SalesAnalysis,
  'analysis-supplies': SuppliesAnalysis,
  'store-management-info-basic': StoreBasic,
  'store-management-info-circle': StoreBusinessCircle,
  'store-management-info-platform': StorePlatform,
  'store-management-info-config': StoreConfig,
  'store-management-region': StoreRegionManage,
  'store-management-map': StoreMap,
  'store-management-fixed': StoreFixedCost,
  'store-management-operating': StoreOperatingCost,
  'menu-management-overview': MenuOverview,
  'menu-management-category': MenuCategory,
  'menu-management-template': MenuTemplate,
  'menu-management-cost': MenuCost,
  'menu-management-expiry': MenuExpiry,
  'menu-management-accounting': MenuAccounting,
  'cost-accounting-daily': DailyCost,
  'cost-accounting-weekly': WeeklyCost,
  'cost-accounting-monthly': MonthlyCost,
  'staff-management-manager': StaffManager,
  'staff-management-clerk': StaffClerk,
  'staff-management-test': StaffTest,
  'staff-management-employees': StaffEmployees,
  'staff-management-store': StaffStoreManagement,
  'staff-management-salary': SalaryPlaceholder,
  'bookkeeping-entry': BookkeepingEntry,
  'bookkeeping-categories': BookkeepingCategories,
  'bookkeeping-records': BookkeepingRecords,
}

// ===== 浮动弹出菜单配置 =====
const POPUP_CONFIG = {
  analysis: {
    sections: [
      {
        title: '总数据视角',
        items: [
          { index: 'analysis-total-brand', label: '品牌视角' },
          { index: 'analysis-total-store', label: '门店视角' },
          { index: 'analysis-total-monthly-dashboard', label: '月经营数据看板' },
          { index: 'analysis-total-binding', label: '堂食菜品绑定' },
        ],
      },
      {
        title: '团购视角',
        items: [
          { index: 'analysis-group-platform', label: '平台视角' },
          { index: 'analysis-group-brand', label: '品牌视角' },
          { index: 'analysis-group-store', label: '门店视角' },
          { index: 'analysis-group-binding', label: '团购菜品绑定' },
        ],
      },
      {
        title: '外卖视角',
        items: [
          { index: 'analysis-delivery-platform', label: '平台视角' },
          { index: 'analysis-delivery-brand', label: '品牌视角' },
          { index: 'analysis-delivery-store', label: '门店视角' },
          { index: 'analysis-delivery-binding', label: '外卖菜品绑定' },
        ],
      },
    ],
  },
  'store-management': {
    sections: [
      {
        title: '门店信息',
        items: [
          { index: 'store-management-info-basic', label: '门店基本信息' },
          { index: 'store-management-info-circle', label: '门店商圈' },
          { index: 'store-management-info-platform', label: '第三方平台' },
          { index: 'store-management-info-config', label: '门店配置' },
          { index: 'store-management-region', label: '门店区域管理' },
        ],
      },
      {
        title: '全国地图',
        items: [
          { index: 'store-management-map', label: '全国地图' },
        ],
      },
      {
        title: '门店成本',
        items: [
          { index: 'store-management-fixed', label: '门店成本' },
          { index: 'store-management-operating', label: '运营成本' },
        ],
      },
    ],
  },
  'store-preparation': {
    sections: [
      { title: '门店渲染', items: [{ index: 'store-preparation-3d', label: '门店渲染' }] },
    ],
  },
  'menu-management': {
    sections: [
      {
        title: '菜品数据',
        items: [
          { index: 'menu-management-overview', label: '菜品总览' },
          { index: 'menu-management-category', label: '菜品分类' },
          { index: 'menu-management-template', label: '菜品模板' },
          { index: 'menu-management-cost', label: '菜品成本' },
          { index: 'menu-management-expiry', label: '效期管理' },
          { index: 'menu-management-accounting', label: '菜品核算' },
        ],
      },
    ],
  },
  'cost-accounting': {
    sections: [
      {
        title: '成本分析',
        items: [
          { index: 'cost-accounting-daily', label: '日成本核算' },
          { index: 'cost-accounting-weekly', label: '周成本核算' },
          { index: 'cost-accounting-monthly', label: '月成本核算' },
        ],
      },
    ],
  },
  'staff-management': {
    sections: [
      {
        title: '人事管理',
        items: [
          { index: 'staff-management-employees', label: '员工管理' },
          { index: 'staff-management-store', label: '门店管理' },
          { index: 'staff-management-salary', label: '工资表制作' },
        ],
      },
    ],
  },
  bookkeeping: {
    sections: [
      {
        title: '记账管理',
        items: [
          { index: 'bookkeeping-entry', label: '门店记账' },
          { index: 'bookkeeping-categories', label: '记账分类' },
          { index: 'bookkeeping-records', label: '门店账本' },
        ],
      },
    ],
  },
  'data-import': {
    sections: [
      {
        title: '经营数据',
        items: [
          { index: 'data-import-pos', label: '收银系统数据' },
          { index: 'data-import-group-buy', label: '团购平台数据' },
          { index: 'data-import-delivery', label: '外卖平台数据' },
        ],
      },
      {
        title: '其他数据',
        items: [{ index: 'data-import-legacy', label: '日报与耗材' }],
      },
    ],
  },
}

const store = useAppStore()
const router = useRouter()
const contentAreaRef = ref(null)
const auth = useAuthStore()
const currentView = shallowRef(DashboardView)
// 笔记本的可用内容宽度通常不足以同时容纳完整侧栏与数据表。
// 默认自动收起侧栏；用户仍可通过顶部按钮临时展开查看导航。
const responsiveCollapsed = ref(false)
const responsiveSidebarOverride = ref(null)
const isSidebarCollapsed = computed(() => store.sidebarCollapsed || (responsiveCollapsed.value && responsiveSidebarOverride.value !== false))

function updateResponsiveLayout() {
  responsiveCollapsed.value = window.innerWidth <= 1440
  if (!responsiveCollapsed.value) responsiveSidebarOverride.value = null
}

function toggleSidebar() {
  if (responsiveCollapsed.value && !store.sidebarCollapsed) {
    responsiveSidebarOverride.value = isSidebarCollapsed.value ? false : null
    return
  }
  store.toggleSidebar()
}

const isLoginPage = computed(() => router.currentRoute.value.path === '/login')
const isCollabRoute = computed(() => router.currentRoute.value.path.startsWith('/collab'))
const isBusinessAnalyticsRoute = computed(() => router.currentRoute.value.path === '/analysis' || router.currentRoute.value.path.startsWith('/analysis/'))
const isDataImportRoute = computed(() => router.currentRoute.value.path.startsWith('/data-import/'))
const isEnterpriseSettingsRoute = computed(() => router.currentRoute.value.path.startsWith('/enterprise-settings'))
const isStore3dRoute = computed(() => router.currentRoute.value.path === '/store-3d')
const isStaffManagementRoute = computed(() => router.currentRoute.value.path.startsWith('/staff-management/'))
const workspaceRouteTabId = computed(() => {
  const route = router.currentRoute.value
  const section = String(route.params?.section || '').trim()
  const prefix = {
    'workspace-store-management': 'store-management',
    'workspace-menu-management': 'menu-management',
    'workspace-cost-accounting': 'cost-accounting',
    'workspace-bookkeeping': 'bookkeeping',
  }[route.name]
  if (prefix && section) return `${prefix}-${section}`
  return {
    'workspace-pipeline': 'pipeline',
    'workspace-ai-assistant': 'ai-assistant',
    'workspace-user-management': 'user-management',
    'workspace-settings': 'settings',
    // 挂在工作台下的独立静态路由（不是 :section 通配），刷新/直接访问时必须能反查回标签 id，
    // 否则地址栏正确但内容区落到数据概括。新增这类页面记得同步登记。
    'menu-management-category': 'menu-management-category',
    'menu-management-accounting': 'menu-management-accounting',
  }[route.name] || ''
})
const isWorkspaceRoute = computed(() => Boolean(workspaceRouteTabId.value))
const isSpecialRoute = computed(() => isCollabRoute.value || isBusinessAnalyticsRoute.value || isDataImportRoute.value || isEnterpriseSettingsRoute.value || isStore3dRoute.value || isStaffManagementRoute.value)
const businessRouteTabId = computed(() => router.currentRoute.value.meta.analysisKey || 'analysis-total-brand')
const dataImportRouteTabId = computed(() => ({
  pos: 'data-import-pos',
  'group-buy': 'data-import-group-buy',
  delivery: 'data-import-delivery',
  legacy: 'data-import-legacy',
}[router.currentRoute.value.meta.importMode] || 'data-import-pos'))
const staffRouteTabId = computed(() => router.currentRoute.value.path.endsWith('/store-management') ? 'staff-management-store' : 'staff-management-employees')
const pageTitle = computed(() => {
  if (isCollabRoute.value) return '协同事项'
  if (isBusinessAnalyticsRoute.value) {
    return `数据分析 · ${router.currentRoute.value.meta.analysisTitle || '总数据视角'}`
  }
  if (isDataImportRoute.value) {
    const label = { pos: '收银系统数据', 'group-buy': '团购平台数据', delivery: '外卖平台数据', legacy: '日报与耗材' }[router.currentRoute.value.meta.importMode] || '收银系统数据'
    return `数据导入 · ${label}`
  }
  if (isEnterpriseSettingsRoute.value) return '企业设置 · 机器人设置'
  if (isStore3dRoute.value) return '筹建门店 · 门店渲染'
  if (isStaffManagementRoute.value) return staffRouteTabId.value === 'staff-management-store' ? '人事专区 · 门店管理' : '人事专区 · 员工管理'
  if (isWorkspaceRoute.value) return store.activeTab?.title || '工作台'
  return store.activeTab?.title || '数据概括'
})
const sidebarActive = computed(() => {
  if (isCollabRoute.value) return 'collab-list'
  if (isBusinessAnalyticsRoute.value) return 'analysis-group'
  if (isDataImportRoute.value) return 'data-import-group'
  if (isEnterpriseSettingsRoute.value) return 'enterprise-settings'
  if (isStore3dRoute.value) return 'store-preparation-group'
  if (isStaffManagementRoute.value) return 'staff-management-group'
  return store.activeTabId
})
const userInitial = computed(() => {
  const name = auth.user?.display_name || auth.user?.username || '用'
  return String(name).trim().slice(0, 1).toUpperCase()
})

function handleLogout() {
  auth.logout()
  router.push('/login')
}
const popupMenu = reactive({
  visible: false,
  group: null,
  sections: [],
  top: 0,
  left: 0,
})
let hideTimer = null

const popupStyle = computed(() => ({
  top: popupMenu.top + 'px',
  left: popupMenu.left + 'px',
}))

function showPopup(group, event) {
  clearTimeout(hideTimer)
  const rect = event.currentTarget.getBoundingClientRect()
  popupMenu.group = group
  popupMenu.sections = POPUP_CONFIG[group]?.sections || []
  popupMenu.top = Math.min(rect.top - 4, window.innerHeight - 240)
  popupMenu.left = rect.right + 10
  popupMenu.visible = true
}

function scheduleHidePopup() {
  hideTimer = setTimeout(() => {
    popupMenu.visible = false
    popupMenu.group = null
    popupMenu.sections = []
  }, 150)
}

function cancelHidePopup() {
  clearTimeout(hideTimer)
}

async function leaveSpecialRoute() {
  if (isCollabRoute.value || isBusinessAnalyticsRoute.value || isDataImportRoute.value || isEnterpriseSettingsRoute.value || isStore3dRoute.value || isStaffManagementRoute.value) await router.replace('/')
}

const WORKSPACE_TAB_ROUTES = {
  dashboard: '/dashboard',
  pipeline: '/pipeline',
  'ai-assistant': '/ai-assistant',
  'user-management': '/user-management',
  settings: '/settings',
  'store-management-info-basic': '/store-management/info-basic',
  'store-management-info-circle': '/store-management/info-circle',
  'store-management-info-platform': '/store-management/info-platform',
  'store-management-info-config': '/store-management/info-config',
  'store-management-region': '/store-management/region',
  'store-management-map': '/store-management/map',
  'store-management-fixed': '/store-management/fixed',
  'store-management-operating': '/store-management/operating',
  'menu-management-overview': '/menu-management/overview',
  'menu-management-category': '/menu-management/category',
  'menu-management-template': '/menu-management/template',
  'menu-management-cost': '/menu-management/cost',
  'menu-management-expiry': '/menu-management/expiry',
  'menu-management-accounting': '/menu-management/accounting',
  'cost-accounting-daily': '/cost-accounting/daily',
  'cost-accounting-weekly': '/cost-accounting/weekly',
  'cost-accounting-monthly': '/cost-accounting/monthly',
  'bookkeeping-entry': '/bookkeeping/entry',
  'bookkeeping-categories': '/bookkeeping/categories',
  'bookkeeping-records': '/bookkeeping/records',
}

async function openWorkspaceTab(id) {
  store.openTabFromId(id)
  const routePath = WORKSPACE_TAB_ROUTES[id]
  if (routePath) await router.push(routePath)
  else await leaveSpecialRoute()
}

async function selectPopupItem(index) {
  if (index === 'store-preparation-3d') {
    store.openTabFromId(index)
    await router.push('/store-3d')
    popupMenu.visible = false
    popupMenu.group = null
    popupMenu.sections = []
    return
  }
  if (index.startsWith('analysis-')) {
    store.openTabFromId(index)
    const routePath = {
      'analysis-total-brand': '/analysis/total/brand',
      'analysis-total-store': '/analysis/total/store',
      'analysis-total-custom': '/analysis/total/custom',
      'analysis-total-monthly-dashboard': '/analysis/total/monthly-dashboard',
      'analysis-total-binding': '/analysis/total/binding',
      'analysis-group-platform': '/analysis/group-buy/platform',
      'analysis-group-meituan': '/analysis/group-buy/platform',
      'analysis-group-douyin': '/analysis/group-buy/platform',
      'analysis-group-free-trial': '/analysis/group-buy/platform',
      'analysis-group-brand': '/analysis/group-buy/brand',
      'analysis-group-store': '/analysis/group-buy/store',
      'analysis-group-binding': '/analysis/group-buy/binding',
      'analysis-delivery-platform': '/analysis/delivery/platform',
      'analysis-delivery-meituan': '/analysis/delivery/platform',
      'analysis-delivery-taobao': '/analysis/delivery/platform',
      'analysis-delivery-jd': '/analysis/delivery/platform',
      'analysis-delivery-brand': '/analysis/delivery/brand',
      'analysis-delivery-store': '/analysis/delivery/store',
      'analysis-delivery-binding': '/analysis/delivery/binding',
    }[index]
    await router.push(routePath || '/analysis/total/brand')
    popupMenu.visible = false
    popupMenu.group = null
    popupMenu.sections = []
    return
  }
  if (index.startsWith('data-import-')) {
    store.openTabFromId(index)
    const routePath = {
      'data-import-pos': '/data-import/pos',
      'data-import-group-buy': '/data-import/group-buy',
      'data-import-delivery': '/data-import/delivery',
      'data-import-legacy': '/data-import/legacy',
    }[index]
    await router.push(routePath)
    popupMenu.visible = false
    popupMenu.group = null
    popupMenu.sections = []
    return
  }
  await openWorkspaceTab(index)
  popupMenu.visible = false
  popupMenu.group = null
  popupMenu.sections = []
}

async function handleMenuSelect(index) {
  if (index === 'collab-list') {
    store.openTabFromId('collab')
    await router.push('/collab/list')
    return
  }
  if (index === 'enterprise-settings') {
    store.openTabFromId('enterprise-settings')
    await router.push('/enterprise-settings/robot')
    return
  }
  // 跳过分组菜单项
  if (index.endsWith('-group')) return
  await openWorkspaceTab(index)
}

async function selectTab(id) {
  if (id === 'store-preparation-3d') {
    store.activeTabId = id
    await router.push('/store-3d')
    return
  }
  if (id === 'collab') {
    store.activeTabId = id
    await router.push('/collab/list')
    return
  }
  if (id === 'enterprise-settings') {
    store.activeTabId = id
    await router.push('/enterprise-settings/robot')
    return
  }
  if (id.startsWith('analysis-')) {
    store.activeTabId = id
    const routePath = {
      'analysis-total-brand': '/analysis/total/brand',
      'analysis-total-store': '/analysis/total/store',
      'analysis-total-custom': '/analysis/total/custom',
      'analysis-total-monthly-dashboard': '/analysis/total/monthly-dashboard',
      'analysis-total-binding': '/analysis/total/binding',
      'analysis-group-platform': '/analysis/group-buy/platform',
      'analysis-group-meituan': '/analysis/group-buy/platform',
      'analysis-group-douyin': '/analysis/group-buy/platform',
      'analysis-group-free-trial': '/analysis/group-buy/platform',
      'analysis-group-brand': '/analysis/group-buy/brand',
      'analysis-group-store': '/analysis/group-buy/store',
      'analysis-group-binding': '/analysis/group-buy/binding',
      'analysis-delivery-platform': '/analysis/delivery/platform',
      'analysis-delivery-meituan': '/analysis/delivery/platform',
      'analysis-delivery-taobao': '/analysis/delivery/platform',
      'analysis-delivery-jd': '/analysis/delivery/platform',
      'analysis-delivery-brand': '/analysis/delivery/brand',
      'analysis-delivery-store': '/analysis/delivery/store',
      'analysis-delivery-binding': '/analysis/delivery/binding',
    }[id]
    await router.push(routePath || '/analysis/total/brand')
    return
  }
  if (id.startsWith('data-import-')) {
    store.activeTabId = id
    const routePath = {
      'data-import-pos': '/data-import/pos',
      'data-import-group-buy': '/data-import/group-buy',
      'data-import-delivery': '/data-import/delivery',
      'data-import-legacy': '/data-import/legacy',
    }[id]
    await router.push(routePath)
    return
  }
  const routePath = WORKSPACE_TAB_ROUTES[id]
  store.activeTabId = id
  if (routePath) await router.push(routePath)
  else await leaveSpecialRoute()
}

async function closeTab(id) {
  store.closeTab(id)
  if (id === 'collab' && isCollabRoute.value) await router.push('/')
  if (id.startsWith('analysis-') && isBusinessAnalyticsRoute.value) await router.push('/')
  if (id.startsWith('data-import-') && isDataImportRoute.value) await router.push('/')
  if (id === 'enterprise-settings' && isEnterpriseSettingsRoute.value) await router.push('/')
  if (id === 'store-preparation-3d' && isStore3dRoute.value) await router.push('/')
  if (WORKSPACE_TAB_ROUTES[id] && isWorkspaceRoute.value && workspaceRouteTabId.value === id) await router.push('/dashboard')
}

watch(() => store.activeTabId, (id) => {
  if (!id) return
  currentView.value = COMPONENT_MAP[id] || DashboardView
})

watch(isCollabRoute, (active) => {
  if (active) store.openTabFromId('collab')
})
watch(isBusinessAnalyticsRoute, (active) => {
  if (active) store.openTabFromId(businessRouteTabId.value)
})
watch(businessRouteTabId, (id) => {
  if (isBusinessAnalyticsRoute.value) store.openTabFromId(id)
})
watch(isDataImportRoute, (active) => {
  if (active) store.openTabFromId(dataImportRouteTabId.value)
})
watch(isEnterpriseSettingsRoute, (active) => {
  if (active) store.openTabFromId('enterprise-settings')
})
watch(isStaffManagementRoute, (active) => {
  if (active) store.openTabFromId(staffRouteTabId.value)
})
watch(isWorkspaceRoute, (active) => {
  if (active) store.openTabFromId(workspaceRouteTabId.value)
})
watch(workspaceRouteTabId, (id) => {
  if (id && isWorkspaceRoute.value) store.openTabFromId(id)
})

// 内容区是独立滚动容器。切换标签/路由时必须回到顶部，
// 否则会沿用上一页的 scrollTop，新页面看起来像被裁切或空白。
watch(() => router.currentRoute.value.fullPath, async () => {
  await nextTick()
  const area = contentAreaRef.value
  if (area) area.scrollTo({ top: 0, left: 0, behavior: 'auto' })
})
watch(isStore3dRoute, (active) => {
  if (active) store.openTabFromId('store-preparation-3d')
})
watch(dataImportRouteTabId, (id) => {
  if (isDataImportRoute.value) store.openTabFromId(id)
})
watch(staffRouteTabId, (id) => {
  if (isStaffManagementRoute.value) store.openTabFromId(id)
})

onMounted(async () => {
  updateResponsiveLayout()
  window.addEventListener('resize', updateResponsiveLayout)
  // 初始化认证
  await auth.init()
  if (!auth.isLoggedIn) {
    router.push('/login')
    return
  }
  try {
    await getConfig()
    store.setServerStatus(true)
  } catch {
    store.setServerStatus(false)
  }
  store.syncTabTitles()
  // 刷新或直接打开协同事项时，保留当前路由；否则会出现 URL 是 /collab，
  // 页面却被初始化逻辑切回数据概括的情况。
  if (isCollabRoute.value) store.openTabFromId('collab')
  else if (isBusinessAnalyticsRoute.value) store.openTabFromId(businessRouteTabId.value)
  else if (isDataImportRoute.value) store.openTabFromId(dataImportRouteTabId.value)
  else if (isEnterpriseSettingsRoute.value) store.openTabFromId('enterprise-settings')
  else if (isStore3dRoute.value) store.openTabFromId('store-preparation-3d')
  else if (isStaffManagementRoute.value) store.openTabFromId(staffRouteTabId.value)
  else if (isWorkspaceRoute.value) store.openTabFromId(workspaceRouteTabId.value)
  else store.openTabFromId('dashboard')
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateResponsiveLayout)
})
</script>

<style>
/* ===== 侧边栏浮动子菜单 ===== */
.nav-popup-panel {
  position: fixed;
  min-width: 338px;
  max-width: 420px;
  padding: 10px;
  overflow: hidden;
  border: 1px solid rgba(225,229,237,.95);
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 18px 45px rgba(23,34,56,.16), 0 4px 12px rgba(23,34,56,.07);
  z-index: 2000;
  opacity: 0;
  visibility: hidden;
  transition: opacity .16s ease, visibility .16s ease;
  pointer-events: none;
}
.nav-popup-panel.visible {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}
.popup-section {
  display: grid;
  grid-template-columns: repeat(2, minmax(145px, 1fr));
  gap: 5px;
  padding: 7px;
}
.popup-section + .popup-section {
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid #edf0f4;
}
.popup-section-title {
  grid-column: 1 / -1;
  padding: 0 6px 5px;
  color: #9aa3b2;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .09em;
  white-space: nowrap;
}
.popup-item {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 41px;
  padding: 0 10px 0 24px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: #596579;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  transition: color .16s ease, background-color .16s ease, border-color .16s ease;
}
.popup-item::before {
  content: "";
  position: absolute;
  left: 10px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #c0c7d2;
  transition: background-color .16s ease, box-shadow .16s ease;
}
.popup-item:hover {
  border-color: #e4eaff;
  background: #f5f7ff;
  color: #3f62c9;
}
.popup-item.active {
  border-color: #dce5ff;
  background: #eef3ff;
  color: #3157c2;
  font-weight: 650;
}
.popup-item.active::before {
  background: #4f7cff;
  box-shadow: 0 0 0 3px rgba(79,124,255,.12);
}

/* 侧边栏箭头 */
.nav-arrow {
  margin-left: auto;
  color: #5f6d85;
  font-size: 17px;
  font-weight: 300;
  opacity: .8;
  transition: color .18s ease;
}
.el-menu-item.is-popup-open .nav-arrow {
  color: #9db4ff;
}

@media (prefers-reduced-motion: reduce) {
  .nav-popup-panel,
  .popup-item,
  .nav-arrow { transition: none; }
}
</style>
