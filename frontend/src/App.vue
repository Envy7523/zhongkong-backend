<template>
  <LoginView v-if="isLoginPage" />
  <div v-else class="app-layout">
    <!-- 侧边栏 -->
    <div :class="['app-sidebar', { 'is-collapsed': store.sidebarCollapsed }]">
      <div class="sidebar-brand">
        <span :class="['sidebar-brand-text', { collapsed: store.sidebarCollapsed }]">鹅太公中控</span>
      </div>
      <el-menu
        :default-active="store.activeTabId"
        :collapse="store.sidebarCollapsed"
        background-color="#1e1e2f"
        text-color="#a0a0b8"
        active-text-color="#fff"
        @select="handleMenuSelect"
        style="border-right:none;height:calc(100vh - 56px);"
      >
        <el-menu-item index="dashboard">
          <el-icon><DataAnalysis /></el-icon>
          <template #title>数据概括</template>
        </el-menu-item>

        <!-- 数据分析 — 浮动弹出 -->
        <el-menu-item
          index="analysis-group"
          @mouseenter="showPopup('analysis', $event)"
          @mouseleave="scheduleHidePopup"
          :class="{ 'is-popup-open': popupMenu.group === 'analysis', 'is-active': store.activeTabId?.startsWith('analysis-') }"
        >
          <el-icon><TrendCharts /></el-icon>
          <template #title>
            <span>数据分析</span>
            <span class="nav-arrow" v-show="!store.sidebarCollapsed">▸</span>
          </template>
        </el-menu-item>

        <el-menu-item index="api-config">
          <el-icon><Link /></el-icon>
          <template #title>中控绑定</template>
        </el-menu-item>

        <el-menu-item index="ai-assistant">
          <el-icon><ChatDotRound /></el-icon>
          <template #title>AI助手</template>
        </el-menu-item>

        <!-- 门店管理 — 浮动弹出 -->
        <el-menu-item
          index="store-management-group"
          @mouseenter="showPopup('store-management', $event)"
          @mouseleave="scheduleHidePopup"
          :class="{ 'is-popup-open': popupMenu.group === 'store-management', 'is-active': store.activeTabId?.startsWith('store-management-') }"
        >
          <el-icon><Shop /></el-icon>
          <template #title>
            <span>门店管理</span>
            <span class="nav-arrow" v-show="!store.sidebarCollapsed">▸</span>
          </template>
        </el-menu-item>

        <!-- 菜品管理 — 浮动弹出 -->
        <el-menu-item
          index="menu-management-group"
          @mouseenter="showPopup('menu-management', $event)"
          @mouseleave="scheduleHidePopup"
          :class="{ 'is-popup-open': popupMenu.group === 'menu-management', 'is-active': store.activeTabId?.startsWith('menu-management-') }"
        >
          <el-icon><DishDot /></el-icon>
          <template #title>
            <span>菜品管理</span>
            <span class="nav-arrow" v-show="!store.sidebarCollapsed">▸</span>
          </template>
        </el-menu-item>

        <el-menu-item index="user-management">
          <el-icon><User /></el-icon>
          <template #title>人员管理</template>
        </el-menu-item>

        <!-- 成本核算 — 浮动弹出 -->
        <el-menu-item
          index="cost-accounting-group"
          @mouseenter="showPopup('cost-accounting', $event)"
          @mouseleave="scheduleHidePopup"
          :class="{ 'is-popup-open': popupMenu.group === 'cost-accounting', 'is-active': store.activeTabId?.startsWith('cost-accounting-') }"
        >
          <el-icon><Money /></el-icon>
          <template #title>
            <span>成本核算</span>
            <span class="nav-arrow" v-show="!store.sidebarCollapsed">▸</span>
          </template>
        </el-menu-item>

        <el-menu-item index="data-import">
          <el-icon><Download /></el-icon>
          <template #title>数据导入</template>
        </el-menu-item>

        <el-menu-item index="pipeline">
          <el-icon><Upload /></el-icon>
          <template #title>一键推送</template>
        </el-menu-item>

        <el-menu-item index="settings">
          <el-icon><Setting /></el-icon>
          <template #title>网页设置</template>
        </el-menu-item>
      </el-menu>
      <div :class="['sidebar-footer', { collapsed: store.sidebarCollapsed }]">v0.3.0</div>
    </div>

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
        <span class="topbar-title">{{ store.activeTab?.title || '数据概括' }}</span>
        <span :class="['topbar-status', store.serverOnline ? 'online' : 'offline']">{{ store.serverStatusText }}</span>
        <span class="topbar-user" v-if="auth.user">
          <el-icon><User /></el-icon>
          {{ auth.user.display_name || auth.user.username }}
          <el-button text size="small" type="danger" @click="handleLogout" style="margin-left:8px;">登出</el-button>
        </span>
      </div>

      <div class="tab-bar-wrapper" v-if="store.tabs.length > 0">
        <div class="tab-bar">
          <div
            v-for="tab in store.tabs"
            :key="tab.id"
            :class="['tab-item', { active: tab.id === store.activeTabId }]"
            @click="store.activeTabId = tab.id"
            :title="tab.title"
          >
            <span class="tab-title">{{ tab.title }}</span>
            <span v-if="tab.closable" class="tab-close" @click.stop="store.closeTab(tab.id)">×</span>
          </div>
        </div>
        <div class="tab-actions">
          <el-button size="small" text @click="store.closeOtherTabs()" title="关闭其他标签页">⋮</el-button>
        </div>
      </div>

      <div class="content-area">
        <component :is="currentView" :key="store.activeTabId" />
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
  const sidebarWidth = store.sidebarCollapsed ? 64 : 220
  const rect = event.currentTarget.getBoundingClientRect()
  popupMenu.group = group
  popupMenu.sections = POPUP_CONFIG[group]?.sections || []
  popupMenu.top = rect.top
  popupMenu.left = sidebarWidth + 6
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

function selectPopupItem(index) {
  store.openTabFromId(index)
  popupMenu.visible = false
  popupMenu.group = null
  popupMenu.sections = []
}

function handleMenuSelect(index) {
  // 跳过分组菜单项
  if (index.endsWith('-group')) return
  store.openTabFromId(index)
}

watch(() => store.activeTabId, (id) => {
  if (!id) return
  currentView.value = COMPONENT_MAP[id] || DashboardView
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
  store.openTabFromId('dashboard')
})
</script>

<style>
/* ===== 浮动弹出面板（白色，与深色侧边栏区分） ===== */
.nav-popup-panel {
  position: fixed;
  min-width: 320px;
  max-width: 480px;
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06);
  padding: 8px 0;
  z-index: 2000;
  opacity: 0;
  visibility: hidden;
  transform: translateX(-6px);
  transition: opacity 0.18s ease, visibility 0.18s ease, transform 0.18s ease;
  pointer-events: none;
}

.nav-popup-panel.visible {
  opacity: 1;
  visibility: visible;
  transform: translateX(0);
  pointer-events: auto;
}

.popup-section {
  display: grid;
  grid-template-columns: 105px repeat(3, 1fr);
  gap: 0 6px;
  align-items: center;
  padding: 2px 14px;
}

.popup-section + .popup-section {
  border-top: 1px solid #f0f0f0;
}

.popup-section-title {
  grid-column: 1;
  grid-row: 1 / 100;
  padding: 4px 0;
  font-size: 12px;
  font-weight: 700;
  color: #909399;
  white-space: nowrap;
  align-self: start;
}

.popup-item {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  color: #606266;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  border-radius: 4px;
  transition: all 0.15s ease;
}

.popup-item:hover {
  background: #ecf5ff;
  color: #409EFF;
}

.popup-item.active {
  background: #ecf5ff;
  color: #409EFF;
  font-weight: 600;
}

/* 侧边栏箭头 */
.nav-arrow {
  font-size: 11px;
  margin-left: auto;
  opacity: 0.4;
  transition: transform 0.2s;
}

.el-menu-item.is-popup-open .nav-arrow {
  opacity: 1;
  transform: translateX(2px);
}
</style>
