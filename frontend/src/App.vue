<template>
  <LoginView v-if="isLoginPage" />
  <div v-else class="app-layout">
    <!-- 侧边栏 -->
    <aside :class="['app-sidebar', { 'is-collapsed': store.sidebarCollapsed }]">
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
          :collapse="store.sidebarCollapsed"
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

          <div class="sidebar-section-label">运营工具</div>
          <el-menu-item index="collab-list">
            <el-icon><List /></el-icon>
            <template #title><span>协同事项</span><small class="nav-badge new">NEW</small></template>
          </el-menu-item>
          <el-menu-item index="data-import">
            <el-icon><Download /></el-icon>
            <template #title>数据导入</template>
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
          <el-menu-item index="api-config">
            <el-icon><Link /></el-icon>
            <template #title>中控绑定</template>
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
        <el-button @click="store.toggleSidebar()" text>
          <el-icon v-if="store.sidebarCollapsed"><Expand /></el-icon>
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

      <div class="content-area">
        <router-view v-if="isCollabRoute" />
        <component v-else :is="currentView" :key="store.activeTabId" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { getConfig } from '@/api'
import LoginView from '@/views/LoginView.vue'

import DashboardView from '@/views/DashboardView.vue'
import ApiConfigView from '@/views/ApiConfigView.vue'
import PipelineView from '@/views/PipelineView.vue'
import DataImportView from '@/views/DataImportView.vue'
import UserManagementView from '@/views/UserManagementView.vue'
import AiAssistantView from '@/views/AiAssistantView.vue'
import SettingsView from '@/views/SettingsView.vue'
import RevenueAnalysis from '@/views/analysis/RevenueAnalysis.vue'
import CostAnalysis from '@/views/analysis/CostAnalysis.vue'
import SalesAnalysis from '@/views/analysis/SalesAnalysis.vue'
import SuppliesAnalysis from '@/views/analysis/SuppliesAnalysis.vue'
import StoreBasic from '@/views/store/StoreBasic.vue'
import StorePlatform from '@/views/store/StorePlatform.vue'
import StoreConfig from '@/views/store/StoreConfig.vue'
import StoreFixedCost from '@/views/store/StoreFixedCost.vue'
import StoreOperatingCost from '@/views/store/StoreOperatingCost.vue'
import StoreBusinessCircle from '@/views/store/StoreBusinessCircle.vue'
import StoreMap from '@/views/store/StoreMap.vue'
import MenuOverview from '@/views/menu/MenuOverview.vue'
import MenuCost from '@/views/menu/MenuCost.vue'
import MenuExpiry from '@/views/menu/MenuExpiry.vue'
import DailyCost from '@/views/cost/DailyCost.vue'
import WeeklyCost from '@/views/cost/WeeklyCost.vue'
import MonthlyCost from '@/views/cost/MonthlyCost.vue'

const COMPONENT_MAP = {
  dashboard: DashboardView,
  'api-config': ApiConfigView,
  pipeline: PipelineView,
  'data-import': DataImportView,
  'user-management': UserManagementView,
  'ai-assistant': AiAssistantView,
  settings: SettingsView,
  'analysis-revenue': RevenueAnalysis,
  'analysis-cost': CostAnalysis,
  'analysis-sales': SalesAnalysis,
  'analysis-supplies': SuppliesAnalysis,
  'store-management-info-basic': StoreBasic,
  'store-management-info-circle': StoreBusinessCircle,
  'store-management-info-platform': StorePlatform,
  'store-management-info-config': StoreConfig,
  'store-management-map': StoreMap,
  'store-management-fixed': StoreFixedCost,
  'store-management-operating': StoreOperatingCost,
  'menu-management-overview': MenuOverview,
  'menu-management-cost': MenuCost,
  'menu-management-expiry': MenuExpiry,
  'cost-accounting-daily': DailyCost,
  'cost-accounting-weekly': WeeklyCost,
  'cost-accounting-monthly': MonthlyCost,
}

// ===== 浮动弹出菜单配置 =====
const POPUP_CONFIG = {
  analysis: {
    sections: [
      {
        title: '营收分析',
        items: [
          { index: 'analysis-revenue', label: '门店营收构成' },
          { index: 'analysis-cost', label: '门店成本分析' },
        ],
      },
      {
        title: '销售分析',
        items: [
          { index: 'analysis-sales', label: '门店销量统计' },
          { index: 'analysis-supplies', label: '门店耗材消耗' },
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
          { index: 'store-management-fixed', label: '固定成本' },
          { index: 'store-management-operating', label: '运营成本' },
        ],
      },
    ],
  },
  'menu-management': {
    sections: [
      {
        title: '菜品数据',
        items: [
          { index: 'menu-management-overview', label: '菜品总览' },
          { index: 'menu-management-cost', label: '菜品成本' },
          { index: 'menu-management-expiry', label: '效期管理' },
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
}

const store = useAppStore()
const router = useRouter()
const auth = useAuthStore()
const currentView = shallowRef(DashboardView)

const isLoginPage = computed(() => router.currentRoute.value.path === '/login')
const isCollabRoute = computed(() => router.currentRoute.value.path.startsWith('/collab'))
const pageTitle = computed(() => isCollabRoute.value ? '协同事项' : (store.activeTab?.title || '数据概括'))
const sidebarActive = computed(() => {
  if (isCollabRoute.value) return 'collab-list'
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

async function leaveCollabRoute() {
  if (isCollabRoute.value) await router.replace('/')
}

async function selectPopupItem(index) {
  await leaveCollabRoute()
  store.openTabFromId(index)
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
  // 跳过分组菜单项
  if (index.endsWith('-group')) return
  await leaveCollabRoute()
  store.openTabFromId(index)
}

async function selectTab(id) {
  if (id === 'collab') {
    store.activeTabId = id
    await router.push('/collab/list')
    return
  }
  await leaveCollabRoute()
  store.activeTabId = id
}

async function closeTab(id) {
  store.closeTab(id)
  if (id === 'collab' && isCollabRoute.value) await router.push('/')
}

watch(() => store.activeTabId, (id) => {
  if (!id) return
  currentView.value = COMPONENT_MAP[id] || DashboardView
})

watch(isCollabRoute, (active) => {
  if (active) store.openTabFromId('collab')
})

onMounted(async () => {
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
  else store.openTabFromId('dashboard')
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
  transform: translateX(-7px) scale(.985);
  transform-origin: left top;
  transition: opacity .2s ease, visibility .2s ease, transform .24s cubic-bezier(.22,.8,.25,1);
  pointer-events: none;
}
.nav-popup-panel.visible {
  opacity: 1;
  visibility: visible;
  transform: translateX(0) scale(1);
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
  transition: color .16s ease, background-color .16s ease, border-color .16s ease, transform .16s ease;
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
  transform: translateX(1px);
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
  transition: color .18s ease, transform .2s ease;
}
.el-menu-item.is-popup-open .nav-arrow {
  color: #9db4ff;
  transform: translateX(3px);
}

@media (prefers-reduced-motion: reduce) {
  .nav-popup-panel,
  .popup-item,
  .nav-arrow { transition: none; }
}
</style>
