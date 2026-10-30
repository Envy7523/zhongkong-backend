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
          :popper-style="popupMenu.visible ? { display: 'none' } : undefined"
          background-color="transparent"
          text-color="#93a0b8"
          active-text-color="#fff"
          @select="handleMenuSelect"
        >
          <div v-if="canSeeNavGroup('dashboard')" class="sidebar-section-label">总览</div>
          <el-menu-item v-if="canSeeNav('dashboard')" index="dashboard">
            <el-icon><DataAnalysis /></el-icon>
            <template #title><span>数据概括</span><small class="nav-badge">HOME</small></template>
          </el-menu-item>

          <div v-if="canSeeNavGroup('core-business')" class="sidebar-section-label">核心业务</div>
          <el-menu-item
            v-if="canSeeNav('analysis-group')"
            index="analysis-group"
            @mouseenter="showPopup('analysis', $event)"
            @mouseleave="scheduleHidePopup"
            :class="{ 'is-popup-open': popupMenu.group === 'analysis', 'is-active': store.activeTabId?.startsWith('analysis-') }"
          >
            <el-icon><TrendCharts /></el-icon>
            <template #title><span>数据分析</span><span class="nav-arrow">›</span></template>
          </el-menu-item>
          <el-menu-item
            v-if="canSeeNav('store-management-group')"
            index="store-management-group"
            @mouseenter="showPopup('store-management', $event)"
            @mouseleave="scheduleHidePopup"
            :class="{ 'is-popup-open': popupMenu.group === 'store-management', 'is-active': store.activeTabId?.startsWith('store-management-') }"
          >
            <el-icon><Shop /></el-icon>
            <template #title><span>门店管理</span><span class="nav-arrow">›</span></template>
          </el-menu-item>
          <el-menu-item
            v-if="canSeeNav('store-preparation-group')"
            index="store-preparation-group"
            @mouseenter="showPopup('store-preparation', $event)"
            @mouseleave="scheduleHidePopup"
            :class="{ 'is-popup-open': popupMenu.group === 'store-preparation', 'is-active': store.activeTabId?.startsWith('store-preparation-') }"
          >
            <el-icon><Box /></el-icon>
            <template #title><span>筹建门店</span><span class="nav-arrow">›</span></template>
          </el-menu-item>
          <el-menu-item
            v-if="canSeeNav('menu-management-group')"
            index="menu-management-group"
            @mouseenter="showPopup('menu-management', $event)"
            @mouseleave="scheduleHidePopup"
            :class="{ 'is-popup-open': popupMenu.group === 'menu-management', 'is-active': router.currentRoute.value.path.startsWith('/menu-management/') }"
          >
            <el-icon><DishDot /></el-icon>
            <template #title><span>菜品管理</span><span class="nav-arrow">›</span></template>
          </el-menu-item>
          <el-menu-item
            v-if="canSeeNav('staff-management-group')"
            index="staff-management-group"
            ref="staffMenuRef"
            aria-label="人事专区"
            @mouseenter="showPopup('staff-management', $event)"
            @click="showStaffPopup"
            @keydown.enter.prevent="showStaffPopup"
            @mouseleave="scheduleHidePopup"
            :class="{ 'is-popup-open': popupMenu.group === 'staff-management', 'is-active': store.activeTabId?.startsWith('staff-management-') }"
          >
            <el-icon><Avatar /></el-icon>
            <template #title><span>人事专区</span><span class="nav-arrow">›</span></template>
          </el-menu-item>

          <div v-if="canSeeNavGroup('operation-tools')" class="sidebar-section-label">运营工具</div>
          <el-menu-item v-for="group in visibleOperations" :key="group.index" :index="group.index" :ref="element => setPopupMenuRef(group.key, element)"
            :aria-label="group.label" aria-haspopup="true" :aria-expanded="popupMenu.visible && popupMenu.group === group.key"
            @mouseenter="showPopup(group.key, $event)" @mouseleave="scheduleHidePopup"
            @click="showGroupPopup(group.key, $event)" @keydown.enter.prevent="showGroupPopup(group.key, $event)" @keydown.space.prevent="showGroupPopup(group.key, $event)"
            :class="{ 'is-popup-open': popupMenu.group === group.key, 'is-active': operationGroupForPath(router.currentRoute.value.path)?.key === group.key }">
            <el-icon><List v-if="group.key === 'operations-affairs'"/><Shop v-else/></el-icon>
            <template #title><span>{{ group.label }}</span><span class="nav-arrow">›</span></template>
          </el-menu-item>
          <el-menu-item v-if="canSeeNav('knowledge-base')" index="knowledge-base"><el-icon><List /></el-icon><template #title>知识库管理</template></el-menu-item>
          <el-menu-item
            v-if="canSeeNav('data-import-group')"
            index="data-import-group"
            @mouseenter="showPopup('data-import', $event)"
            @mouseleave="scheduleHidePopup"
            :class="{ 'is-popup-open': popupMenu.group === 'data-import', 'is-active': store.activeTabId?.startsWith('data-import-') }"
          >
            <el-icon><Download /></el-icon>
            <template #title><span>数据导入</span><span class="nav-arrow">›</span></template>
          </el-menu-item>
          <el-menu-item v-if="canSeeNav('pipeline')" index="pipeline">
            <el-icon><Upload /></el-icon>
            <template #title>日报发送</template>
          </el-menu-item>
          <el-menu-item v-if="canSeeNav('ai-assistant')" index="ai-assistant">
            <el-icon><ChatDotRound /></el-icon>
            <template #title><span>AI 助手</span><small class="nav-badge beta">BETA</small></template>
          </el-menu-item>
          <el-menu-item v-for="group in visibleBusiness" :key="group.index" :index="group.index" :ref="element=>setPopupMenuRef(group.key,element)" :aria-label="group.label" aria-haspopup="true" :aria-expanded="popupMenu.visible&&popupMenu.group===group.key" @mouseenter="showPopup(group.key,$event)" @mouseleave="scheduleHidePopup" @click="showGroupPopup(group.key,$event)" @keydown.enter.prevent="showGroupPopup(group.key,$event)" @keydown.space.prevent="showGroupPopup(group.key,$event)" :class="{'is-popup-open':popupMenu.group===group.key,'is-active':group.pages.some(p=>router.currentRoute.value.path===p.path)}"><el-icon><Notebook v-if="group.key==='finance-tools'"/><User v-else/></el-icon><template #title><span>{{group.label}}</span><small v-if="group.key==='personal-workspace'&&notificationPending" class="nav-badge">{{notificationPending}}</small><span class="nav-arrow">›</span></template></el-menu-item>

          <div v-if="auth.isAdmin" class="sidebar-section-label">管理员专区</div>
          <el-menu-item v-for="group in visibleSystem" :key="group.index" :index="group.index" :ref="element => setPopupMenuRef(group.key, element)"
            :aria-label="group.label" aria-haspopup="true" :aria-expanded="popupMenu.visible && popupMenu.group === group.key"
            @mouseenter="showPopup(group.key, $event)" @mouseleave="scheduleHidePopup"
            @click="showGroupPopup(group.key, $event)" @keydown.enter.prevent="showGroupPopup(group.key, $event)" @keydown.space.prevent="showGroupPopup(group.key, $event)"
            :class="{ 'is-popup-open': popupMenu.group === group.key, 'is-active': systemGroupForPath(router.currentRoute.value.path)?.key === group.key }">
            <el-icon><User v-if="group.key === 'system-access'"/><Setting v-else/></el-icon>
            <template #title><span>{{ group.label }}</span><span class="nav-arrow">›</span></template>
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
        @keydown.esc.stop="popupMenu.visible = false"
      >
        <template v-if="popupMenu.group">
          <div
            v-for="section in popupMenu.sections"
            :key="section.title"
            class="popup-section"
          >
            <div class="popup-section-title">{{ section.title }}</div>
            <div
              v-for="item in section.items.filter(canSeePopupItem)"
              :key="item.index"
              class="popup-item"
              :class="{ active: store.activeTabId === item.index || operationPageForPath(router.currentRoute.value.path)?.index === item.index || systemPageForPath(router.currentRoute.value.path)?.index === item.index }"
              role="button"
              tabindex="0"
              @keydown.enter.prevent="selectPopupItem(item.index)"
              @keydown.space.prevent="selectPopupItem(item.index)"
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
        <DailyUpdateNotice v-if="auth.isAdmin" :key="auth.user.id" :user-id="auth.user.id" />
        <el-tooltip :content="isDarkTheme ? '切换到日间模式' : '切换到夜间模式'" placement="bottom">
          <button class="theme-toggle" type="button" :aria-label="isDarkTheme ? '切换到日间模式' : '切换到夜间模式'" @click="toggleTheme">
            <span class="theme-toggle-orb"><el-icon class="theme-icon sun"><Sunny /></el-icon><el-icon class="theme-icon moon"><Moon /></el-icon></span>
          </button>
        </el-tooltip>
        <el-tooltip content="消息通知" placement="bottom">
          <button class="topbar-notification" type="button" aria-label="消息通知" @click="openNotifications">
            <el-icon><Bell /></el-icon>
            <span v-if="notificationPending" class="topbar-notification__badge">{{ notificationPending > 99 ? '99+' : notificationPending }}</span>
          </button>
        </el-tooltip>
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
              <el-dropdown-item :icon="Setting" @click="openProfileSettings">个人设置</el-dropdown-item>
              <el-dropdown-item :icon="SwitchButton" divided @click="handleLogout">退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>

      <el-dialog v-model="profileDialog.visible" title="个人设置" width="520px" class="profile-settings-dialog" destroy-on-close>
        <div class="profile-settings-head">
          <el-avatar :size="64" :src="profileDialog.preview || auth.user?.avatar_url" class="profile-settings-avatar">{{ userInitial }}</el-avatar>
          <div><b>{{ profileDialog.form.display_name || profileDialog.form.username || '当前用户' }}</b><small>头像、账号和密码仅影响当前登录账号</small></div>
          <div class="profile-avatar-actions">
            <el-upload accept="image/png,image/jpeg,image/webp" :show-file-list="false" :auto-upload="false" :on-change="handleProfileAvatarChange"><el-button size="small">更换头像</el-button></el-upload>
            <el-button v-if="profileDialog.preview || auth.user?.avatar_url" size="small" text type="danger" @click="clearProfileAvatar">移除</el-button>
          </div>
        </div>
        <el-form label-position="top" class="profile-settings-form" @submit.prevent>
          <el-form-item label="账号"><el-input v-model.trim="profileDialog.form.username" maxlength="50" autocomplete="username" /></el-form-item>
          <el-form-item label="姓名 / 显示名称"><el-input v-model.trim="profileDialog.form.display_name" maxlength="50" /></el-form-item>
          <el-divider>修改密码（如不修改可留空）</el-divider>
          <el-form-item label="当前密码" :required="profileNeedsCurrentPassword"><el-input v-model="profileDialog.form.current_password" type="password" show-password autocomplete="current-password" placeholder="修改账号或密码时需要填写" /></el-form-item>
          <el-form-item label="新密码"><el-input v-model="profileDialog.form.new_password" type="password" show-password autocomplete="new-password" placeholder="至少 6 位" /></el-form-item>
          <el-form-item label="确认新密码"><el-input v-model="profileDialog.form.confirm_password" type="password" show-password autocomplete="new-password" /></el-form-item>
        </el-form>
        <template #footer><el-button @click="profileDialog.visible = false">取消</el-button><el-button type="primary" :loading="profileDialog.saving" @click="saveProfileSettings">保存设置</el-button></template>
      </el-dialog>

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
        <div class="workspace-route-frame" :class="{ 'staff-workspace-shell': isStaffManagementRoute, 'inventory-workspace-shell': router.currentRoute.value.name === 'store-inventory' }">
          <StaffWorkspaceNav v-if="isStaffManagementRoute" />
          <OperationsWorkspaceNav v-else-if="operationGroupForPath(router.currentRoute.value.path)" />
          <SystemWorkspaceNav v-else-if="systemGroupForPath(router.currentRoute.value.path)" />
          <PersonalWorkspaceNav v-else-if="personalPageForPath(router.currentRoute.value.path)" />
          <FinanceWorkspaceNav v-else-if="router.currentRoute.value.path.startsWith('/finance/')" />
          <router-view v-slot="{ Component, route }">
            <KeepAlive :max="30">
              <component v-if="isSpecialRoute && Component" :is="Component" :key="isCollabRoute ? route.path : (route.name || route.path)" />
            </KeepAlive>
          </router-view>
          <KeepAlive :max="30">
            <component v-if="!isSpecialRoute" :is="currentView" :key="store.activeTab?.pageId || store.activeTabId" />
          </KeepAlive>
        </div>
      </div>
      <!-- 首次弹窗：进入后台时把还没弹过的新通知弹一次，每条只弹一次 -->
      <NotificationPopup v-if="auth.user" />
    </div>
  </div>
</template>

<script setup>
import DailyUpdateNotice from '@/components/DailyUpdateNotice.vue'
import StaffWorkspaceNav from '@/components/StaffWorkspaceNav.vue'
import '@/styles/staff-workspace-frame.css'
import '@/styles/inventory-workspace-frame.css'
import { STAFF_GROUPS, STAFF_PAGES, staffPageForPath, staffWorkspaceId, staffRouteForId, visibleStaffGroups, canAccessStaffPage } from '@/navigation/staff.mjs'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Setting, SwitchButton, Bell } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { getConfig, updateMyProfile, getNotificationSummary } from '@/api'
import LoginView from '@/views/LoginView.vue'

import DashboardView from '@/views/DashboardView.vue'
import PushCenterView from '@/views/PushCenterView.vue'
import BusinessDataImport from '@/views/BusinessDataImport.vue'
import UserManagementView from '@/views/UserManagementView.vue'
import NotificationCenterView from '@/views/NotificationCenterView.vue'
import NotificationRulesView from '@/views/NotificationRulesView.vue'
import NotificationPopup from '@/components/NotificationPopup.vue'
import PositionSettingsView from '@/views/PositionSettingsView.vue'
import AiAssistantView from '@/views/AiAssistantView.vue'
import SettingsView from '@/views/SettingsView.vue'
import SalesAnalysis from '@/views/analysis/SalesAnalysis.vue'
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
import StaffManager from '@/views/staff/StaffManager.vue'
import StaffClerk from '@/views/staff/StaffClerk.vue'
import StaffTest from '@/views/staff/StaffTest.vue'
import StaffEmployees from '@/views/staff/StaffEmployeeAccess.vue'
import StaffStoreManagement from '@/views/staff/StaffStoreManagement.vue'
import StaffOrganizations from '@/views/staff/StaffOrganizations.vue'
import StaffDailyTasks from '@/views/staff/StaffDailyTasks.vue'
import SalaryPlaceholder from '@/views/staff/SalaryPlaceholder.vue'
import StaffRoster from '@/views/staff/StaffRoster.vue'
import PayrollAttendance from '@/views/staff/PayrollAttendance.vue'
import PayrollReview from '@/views/staff/PayrollReview.vue'
import EmployeePayslips from '@/views/staff/EmployeePayslips.vue'
import StaffDispatch from '@/views/staff/StaffDispatch.vue'
import BookkeepingEntry from '@/views/bookkeeping/BookkeepingEntry.vue'
import BookkeepingCategories from '@/views/bookkeeping/BookkeepingCategories.vue'
import BookkeepingRecords from '@/views/bookkeeping/BookkeepingRecords.vue'
import BookkeepingExpenseTags from '@/views/bookkeeping/BookkeepingExpenseTags.vue'
import { BUSINESS_GROUPS, visibleBusinessGroups, canAccessBusinessPage, personalPageForPath } from '@/navigation/business-workspaces.mjs'
import PersonalWorkspaceNav from '@/components/PersonalWorkspaceNav.vue'
import FinanceWorkspaceNav from '@/components/FinanceWorkspaceNav.vue'
import { workspaceForPath, workspaceForId, workspaceRoute } from '@/navigation/workspaces.mjs'
import { NAV_GROUP_PERMISSIONS, NAV_ITEM_PERMISSIONS } from '@/permissions'
import { OPERATION_GROUPS, OPERATION_PAGES, canAccessOperationPage, visibleOperationGroups, operationGroupForPath, operationPageForPath } from '@/navigation/operations.mjs'
import OperationsWorkspaceNav from '@/components/OperationsWorkspaceNav.vue'
import { SYSTEM_GROUPS, SYSTEM_PAGES, canAccessSystemPage, visibleSystemGroups, systemGroupForPath, systemPageForPath } from '@/navigation/system.mjs'
import SystemWorkspaceNav from '@/components/SystemWorkspaceNav.vue'
const visibleOperations = computed(() => visibleOperationGroups(auth.permissions))
const visibleBusiness = computed(()=>visibleBusinessGroups(auth.permissions))
const visibleSystem = computed(() => visibleSystemGroups(auth.permissions))

// 左侧导航按岗位权限过滤：分组标题与菜单项都由这里判断，
// 权限来自 /api/auth/me（后端每次从岗位表读取，分配岗位后重新登录即生效）。
const canSeePopupItem = item => {
  const businessPage=BUSINESS_GROUPS.flatMap(g=>g.pages).find(p=>p.index===item.index)
  if(businessPage)return canAccessBusinessPage(businessPage,auth.permissions)
  const systemPage = SYSTEM_PAGES.find(page => page.index === item.index)
  if (systemPage) return canAccessSystemPage(systemPage, auth.permissions)
  const operation = OPERATION_PAGES.find(page => page.index === item.index)
  if (operation) return canAccessOperationPage(operation, auth.permissions)
  if (item.index.startsWith('staff-management-')) {
    const group = STAFF_GROUPS.find(group => group.id === item.index)
    return group ? visibleStaffGroups(auth.permissions).some(item => item.id === group.id) : canAccessStaffPage(STAFF_PAGES.find(page => page.id === item.index), auth.permissions)
  }
  return true
}
const canSeeNav = index => ['user-management','position-settings','operation-audit','finance-integrations','approval-store-bindings','data-import-pos-automation','automation-schedule','analysis-sync-runs','settings','notification-rules','enterprise-settings'].includes(index) ? auth.isAdmin : auth.can(NAV_ITEM_PERMISSIONS[index])
const canSeeNavGroup = group => auth.canAny(NAV_GROUP_PERMISSIONS[group] || [])

const COMPONENT_MAP = {
  dashboard: DashboardView,
  pipeline: PushCenterView,
  'data-import-pos': BusinessDataImport,
  'data-import-group-buy': BusinessDataImport,
  'data-import-delivery': BusinessDataImport,
  'user-management': UserManagementView,
  notifications: NotificationCenterView,
  'notification-rules': NotificationRulesView,
  'position-settings': PositionSettingsView,
  'ai-assistant': AiAssistantView,
  settings: SettingsView,
  'analysis-sales': SalesAnalysis,
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
  'menu-management-cost': MenuCost,
  'menu-management-expiry': MenuExpiry,
  'menu-management-accounting': MenuAccounting,
  'staff-management-manager': StaffManager,
  'staff-management-clerk': StaffClerk,
  'staff-management-test': StaffTest,
  'staff-management-employees': StaffEmployees,
  'staff-management-store': StaffStoreManagement,
  'staff-management-organizations':StaffOrganizations,
  'staff-management-daily-tasks':StaffDailyTasks,
  'staff-management-salary': SalaryPlaceholder,
  'staff-management-attendance': PayrollAttendance,
  'staff-management-roster': StaffRoster,
  'staff-management-review': PayrollReview,
  'staff-management-payslips': EmployeePayslips,
  'staff-management-dispatch': StaffDispatch,
  'bookkeeping-entry': BookkeepingEntry,
  'bookkeeping-categories': BookkeepingCategories,
  'bookkeeping-records': BookkeepingRecords,
  'bookkeeping-expense-tags': BookkeepingExpenseTags,
}

// ===== 浮动弹出菜单配置 =====
const POPUP_CONFIG = {
  ...Object.fromEntries(BUSINESS_GROUPS.map(group=>[group.key,{sections:[{title:group.label,items:group.pages.map(page=>({index:page.index,label:page.label}))}]}])),
  ...Object.fromEntries(SYSTEM_GROUPS.map(group => [group.key, { sections: [{ title: group.label, items: group.pages.map(page => ({ index: page.index, label: page.label })) }] }])),
  ...Object.fromEntries(OPERATION_GROUPS.map(group => [group.key, { sections: [{ title: group.label, items: group.pages.map(page => ({ index: page.index, label: page.label })) }] }])),
  analysis: {
    sections: [
      {
        title: '总数据视角',
        items: [
          { index: 'analysis-agents', label: 'AI 经营分析' },
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
          { index: 'analysis-group-daily-summary', label: '每日总结' },
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
          { index: 'analysis-delivery-fees', label: '外卖字段分类' },
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
          { index: 'menu-management-cost', label: '菜品成本' },
          { index: 'menu-management-expiry', label: '效期管理' },
          { index: 'menu-management-accounting', label: '菜品核算' },
        ],
      },
    ],
  },
  'staff-management': {
    sections: [{ title: '人事管理', items: STAFF_GROUPS.map(group => ({ index: group.id, label: group.label })) }],
  },
  bookkeeping: {
    sections: [
      {
        title: '记账管理',
        items: [
          { index: 'bookkeeping-entry', label: '门店记账' },
          { index: 'bookkeeping-categories', label: '记账分类' },
          { index: 'bookkeeping-records', label: '门店账本' },
          { index: 'bookkeeping-expense-tags', label: '字段分配' },
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
    ],
  },
}

const store = useAppStore()
const router = useRouter()
const contentAreaRef = ref(null)
const staffMenuRef = ref(null)
const popupMenuRefs = new Map()
const auth = useAuthStore()
const currentView = shallowRef(DashboardView)
const pipelineLastPath = ref('/pipeline/group-buy-daily')
watch(() => router.currentRoute.value.path, path => {
  if (path.startsWith('/pipeline/')) pipelineLastPath.value = path
}, { immediate: true })
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
const isBusinessAnalyticsRoute = computed(() => router.currentRoute.value.path === '/analysis' || router.currentRoute.value.path.startsWith('/analysis/') || router.currentRoute.value.path.startsWith('/business-analytics'))
const isDataImportRoute = computed(() => router.currentRoute.value.path.startsWith('/data-import/'))
const isEnterpriseSettingsRoute = computed(() => router.currentRoute.value.path.startsWith('/enterprise-settings'))
const isStore3dRoute = computed(() => router.currentRoute.value.path === '/store-3d')
const isStaffManagementRoute = computed(() => router.currentRoute.value.path.startsWith('/staff-management/'))
const isNotificationRoute = computed(() => router.currentRoute.value.path.startsWith('/notifications'))
const isNotificationRulesRoute = computed(() => router.currentRoute.value.path.startsWith('/notification-rules'))
const workspaceRouteTabId = computed(() => {
  const route = router.currentRoute.value
  const catalogPage=systemPageForPath(route.path)
  if(catalogPage)return catalogPage.index
  if(route.meta.ledgerPage)return route.name
  const section = String(route.params?.section || '').trim()
  const prefix = {
    'workspace-store-management': 'store-management',
    'workspace-menu-management': 'menu-management',
    'workspace-bookkeeping': 'bookkeeping',
  }[route.name]
  if (prefix && section) return `${prefix}-${section}`
  return {
    'workspace-pipeline-group-buy': 'pipeline',
    'workspace-pipeline-pos': 'pipeline',
    'workspace-pipeline-pos-schedule': 'pipeline',
    'workspace-pipeline-pos-store': 'pipeline',
    'workspace-pipeline-store-finance': 'pipeline',
    'workspace-ai-assistant': 'ai-assistant',
    'workspace-user-management': 'user-management',
    'workspace-position-settings': 'position-settings',
    'workspace-settings': 'settings',
    'knowledge-base':'knowledge-base',
    workflows:'workflows', 'store-operations':'store-operations',
    'store-inventory':'store-inventory', 'operation-reports':'operation-reports', 'operation-personnel':'operation-personnel', 'operation-announcements':'operation-announcements',
    'inspections':'inspections',
    'store-tasks': 'store-tasks',
    // 挂在工作台下的独立静态路由（不是 :section 通配），刷新/直接访问时必须能反查回标签 id，
    // 否则地址栏正确但内容区落到数据概括。新增这类页面记得同步登记。
    'menu-management-category': 'menu-management-category',
    'menu-management-accounting': 'menu-management-accounting',
  }[route.name] || ''
})
const isWorkspaceRoute = computed(() => Boolean(workspaceRouteTabId.value))
const isSpecialRoute = computed(() => router.currentRoute.value.meta.ledgerPage || ['store-inventory','knowledge-base','workflows','store-operations','inspections','operation-reports','operation-personnel','operation-announcements'].includes(router.currentRoute.value.name) || router.currentRoute.value.name === 'store-tasks' || isCollabRoute.value || isBusinessAnalyticsRoute.value || isDataImportRoute.value || isEnterpriseSettingsRoute.value || isStore3dRoute.value || isStaffManagementRoute.value)
const businessRouteTabId = computed(() => router.currentRoute.value.meta.analysisKey || 'analysis-total-brand')
const dataImportRouteTabId = computed(() => ({
  pos: 'data-import-pos',
  'pos-automation': 'data-import-pos-automation',
  'group-buy': 'data-import-group-buy',
  delivery: 'data-import-delivery',
}[router.currentRoute.value.meta.importMode] || 'data-import-pos'))
const staffCurrentPage = computed(() => staffPageForPath(router.currentRoute.value.path))
const staffRouteTabId = computed(() => staffWorkspaceId(staffCurrentPage.value?.id || 'staff-management-employees'))
const staffLastPaths = reactive({})
watch(() => router.currentRoute.value.path, path => {
  const page = staffPageForPath(path)
  if (page) staffLastPaths[staffWorkspaceId(page.id)] = path
}, { immediate: true })
const pageTitle = computed(() => {
  const personal=personalPageForPath(router.currentRoute.value.path)
  if(personal)return '我的工作台 · '+personal.label
  if(router.currentRoute.value.meta.ledgerPage)return router.currentRoute.value.meta.pageTitle
  const systemPage = systemPageForPath(router.currentRoute.value.path)
  if (systemPage) return systemGroupForPath(router.currentRoute.value.path).label + ' · ' + systemPage.label
  const operationPage = operationPageForPath(router.currentRoute.value.path)
  if (operationPage) return operationGroupForPath(router.currentRoute.value.path).label + ' · ' + operationPage.label
  if (router.currentRoute.value.name === 'knowledge-base') return '知识库管理'
  if (router.currentRoute.value.name === 'inspections') return '巡检与整改'
  if (router.currentRoute.value.name === 'store-tasks') return '门店日常任务'
  if (isCollabRoute.value) return '协同事项'
  if (isBusinessAnalyticsRoute.value) {
    return `数据分析 · ${router.currentRoute.value.meta.analysisTitle || '总数据视角'}`
  }
  if (isDataImportRoute.value) {
    const label = { pos: '收银系统数据', 'pos-automation': '自动导报表', 'group-buy': '团购平台数据', delivery: '外卖平台数据' }[router.currentRoute.value.meta.importMode] || '收银系统数据'
    return `数据导入 · ${label}`
  }
  if (isEnterpriseSettingsRoute.value) return '企业设置 · 机器人设置'
  if (isStore3dRoute.value) return '筹建门店 · 门店渲染'
  if (isStaffManagementRoute.value) return `人事专区 · ${staffCurrentPage.value?.label || '员工管理'}`
  if (isWorkspaceRoute.value) return store.activeTab?.title || '工作台'
  return store.activeTab?.title || '数据概括'
})
const sidebarActive = computed(() => {
  const systemGroup = systemGroupForPath(router.currentRoute.value.path)
  if (systemGroup) return systemGroup.index
  const operationGroup = operationGroupForPath(router.currentRoute.value.path)
  if (operationGroup) return operationGroup.index
  if (router.currentRoute.value.name === 'knowledge-base') return 'knowledge-base'
  if (router.currentRoute.value.name === 'inspections') return 'inspections'
  if (router.currentRoute.value.name === 'store-tasks') return 'store-tasks'
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

// ===== 消息通知：顶栏角标 =====
// 每 60 秒刷新一次待处理数量；未读为 0 时不显示角标。
const notificationPending = ref(0)
let notificationTimer = null
async function refreshNotifications() {
  if (!auth.user || !auth.can('notifications.view')) { notificationPending.value = 0; return }
  try { notificationPending.value = Number((await getNotificationSummary()).pending || 0) } catch { /* 未登录或网络异常时静默 */ }
}
function openNotifications() { router.push('/notifications') }

const THEME_KEY = 'etaigong_theme'
const isDarkTheme = ref(localStorage.getItem(THEME_KEY) === 'dark')
function applyTheme(dark, animate = false) {
  const root = document.documentElement
  if (animate) root.classList.add('theme-switching')
  root.classList.toggle('theme-dark', dark)
  root.dataset.theme = dark ? 'dark' : 'light'
  localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light')
  if (animate) window.setTimeout(() => root.classList.remove('theme-switching'), 460)
}
applyTheme(isDarkTheme.value)
function toggleTheme(event) {
  const nextDark = !isDarkTheme.value
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (!document.startViewTransition || reducedMotion) {
    isDarkTheme.value = nextDark
    applyTheme(nextDark, !reducedMotion)
    return
  }
  const rect = event?.currentTarget?.getBoundingClientRect?.()
  const originX = rect ? rect.left + rect.width / 2 : window.innerWidth - 48
  const originY = rect ? rect.top + rect.height / 2 : 28
  const radius = Math.hypot(Math.max(originX, window.innerWidth - originX), Math.max(originY, window.innerHeight - originY))
  const root = document.documentElement
  root.style.setProperty('--theme-ripple-x', `${originX}px`)
  root.style.setProperty('--theme-ripple-y', `${originY}px`)
  root.style.setProperty('--theme-ripple-radius', `${radius}px`)
  let viewTransition
  try {
    viewTransition = document.startViewTransition(() => {
      isDarkTheme.value = nextDark
      applyTheme(nextDark)
    })
  } catch {
    isDarkTheme.value = nextDark
    applyTheme(nextDark, true)
    return
  }
  viewTransition.ready.then(() => root.classList.add('theme-ripple')).catch(() => {})
  viewTransition.finished.finally(() => root.classList.remove('theme-ripple'))
}

const profileDialog = reactive({
  visible: false,
  saving: false,
  preview: '',
  avatarData: '',
  removeAvatar: false,
  originalUsername: '',
  form: { username: '', display_name: '', current_password: '', new_password: '', confirm_password: '' },
})
const profileNeedsCurrentPassword = computed(() =>
  profileDialog.form.username !== profileDialog.originalUsername || Boolean(profileDialog.form.new_password),
)
function openProfileSettings() {
  const user = auth.user || {}
  profileDialog.visible = true
  profileDialog.preview = ''
  profileDialog.avatarData = ''
  profileDialog.removeAvatar = false
  profileDialog.originalUsername = user.username || ''
  profileDialog.form = { username: user.username || '', display_name: user.display_name || user.username || '', current_password: '', new_password: '', confirm_password: '' }
}
function handleProfileAvatarChange(uploadFile) {
  const file = uploadFile?.raw
  if (!file) return
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) {
    ElMessage.warning('请选择 PNG、JPG 或 WebP 格式且不超过 2MB 的头像')
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    profileDialog.preview = String(reader.result || '')
    profileDialog.avatarData = profileDialog.preview
    profileDialog.removeAvatar = false
  }
  reader.readAsDataURL(file)
}
function clearProfileAvatar() {
  profileDialog.preview = ''
  profileDialog.avatarData = ''
  profileDialog.removeAvatar = true
}
async function saveProfileSettings() {
  const form = profileDialog.form
  if (!form.username || !form.display_name) { ElMessage.warning('请填写账号和显示名称'); return }
  if (form.new_password && form.new_password !== form.confirm_password) { ElMessage.warning('两次输入的新密码不一致'); return }
  if (profileNeedsCurrentPassword.value && !form.current_password) { ElMessage.warning('修改账号或密码前，请填写当前密码'); return }
  profileDialog.saving = true
  try {
    const result = await updateMyProfile({
      username: form.username,
      display_name: form.display_name,
      current_password: form.current_password,
      new_password: form.new_password,
      avatar_data: profileDialog.avatarData || undefined,
      remove_avatar: profileDialog.removeAvatar,
    })
    auth.updateSession(result)
    profileDialog.visible = false
    ElMessage.success('个人设置已保存')
  } catch (error) {
    ElMessage.error(error.message || '个人设置保存失败')
  } finally {
    profileDialog.saving = false
  }
}

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
  const element = event?.currentTarget
  if (!element?.getBoundingClientRect) return
  const rect = element.getBoundingClientRect()
  popupMenu.group = group
  popupMenu.sections = POPUP_CONFIG[group]?.sections || []
  popupMenu.top = Math.max(12, Math.min(rect.top - 4, window.innerHeight - (group === 'staff-management' ? 300 : 240)))
  popupMenu.left = group === 'staff-management' ? Math.max(12, Math.min(rect.right + 10, window.innerWidth - 352)) : rect.right + 10
  popupMenu.visible = true
}

function setPopupMenuRef(group, element) {
  if (element) popupMenuRefs.set(group, element)
  else popupMenuRefs.delete(group)
}

function showGroupPopup(group, event) {
  // ElMenuItem的click传出菜单项对象，键盘/鼠标事件才带currentTarget。
  const element = event?.currentTarget || popupMenuRefs.get(group)?.$el
  if (element) showPopup(group, { currentTarget: element })
}

function showStaffPopup() {
  const element = staffMenuRef.value?.$el
  if (element) showPopup('staff-management', { currentTarget: element })
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

const workspaceLastPaths = reactive({})
watch(()=>router.currentRoute.value.fullPath,()=>{const r=router.currentRoute.value,g=workspaceForPath(r.path);if(g)workspaceLastPaths[g.key]=r.fullPath},{immediate:true})

const WORKSPACE_TAB_ROUTES = {
  'my-payslips':'/my/payslips',
  'operation-audit':'/admin/operation-audit','finance-integrations':'/admin/finance-integrations',
  'approval-store-bindings':'/admin/approval-store-bindings',
  workflows:'/workflows', 'store-operations':'/store-operations',
  'store-inventory':'/operations/inventory', 'operation-reports':'/operations/reports', 'operation-personnel':'/operations/personnel', 'operation-announcements':'/operations/announcements',
  'knowledge-base':'/knowledge-base',
  'inspections':'/inspections',
  'store-tasks': '/store-tasks',
  dashboard: '/dashboard',
  pipeline: '/pipeline/group-buy-daily',
  'ai-assistant': '/ai-assistant',
  'user-management': '/user-management',
  notifications: '/notifications',
  'notification-rules': '/notification-rules',
  'position-settings': '/position-settings',
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
  'menu-management-cost': '/menu-management/cost',
  'menu-management-expiry': '/menu-management/expiry',
  'menu-management-accounting': '/menu-management/accounting',
  'bookkeeping-entry': '/bookkeeping/entry',
  'bookkeeping-categories': '/bookkeeping/categories',
  'bookkeeping-records': '/bookkeeping/records',
  'bookkeeping-expense-tags': '/bookkeeping/expense-tags',
}

async function openWorkspaceTab(id) {
  store.openTabFromId(id)
  const routePath = id === 'pipeline' ? pipelineLastPath.value : WORKSPACE_TAB_ROUTES[id]
  if (routePath) await router.push(routePath)
  else await leaveSpecialRoute()
}

async function selectPopupItem(index) {
  const businessPage=BUSINESS_GROUPS.flatMap(g=>g.pages).find(p=>p.index===index)
  if(businessPage){if(!canAccessBusinessPage(businessPage,auth.permissions))return;await router.push(businessPage.path);popupMenu.visible=false;popupMenu.group=null;popupMenu.sections=[];return}
  const systemPage = SYSTEM_PAGES.find(page => page.index === index)
  if (systemPage) {
    if (!canAccessSystemPage(systemPage, auth.permissions)) return
    await router.push(systemPage.path)
    popupMenu.visible = false; popupMenu.group = null; popupMenu.sections = []
    return
  }
  const operation = OPERATION_PAGES.find(page => page.index === index)
  if (operation) {
    if (!canAccessOperationPage(operation, auth.permissions)) return
    store.openTabFromId(operation.tabId || operation.index)
    await router.push(operation.path)
    popupMenu.visible = false; popupMenu.group = null; popupMenu.sections = []
    return
  }
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
      'analysis-agents': '/analysis/agents',
      'analysis-total-brand': '/analysis/total/brand',
      'analysis-total-store': '/analysis/total/store',
      'analysis-total-custom': '/analysis/total/custom',
      'analysis-total-monthly-dashboard': '/analysis/total/monthly-dashboard',
      'analysis-delivery-fees': '/analysis/delivery/fee-rules',
      'analysis-total-binding': '/analysis/total/binding',
      'analysis-group-platform': '/analysis/group-buy/platform',
      'analysis-group-meituan': '/analysis/group-buy/platform',
      'analysis-group-douyin': '/analysis/group-buy/platform',
      'analysis-group-free-trial': '/analysis/group-buy/platform',
      'analysis-group-brand': '/analysis/group-buy/brand',
      'analysis-group-store': '/analysis/group-buy/store',
      'analysis-group-daily-summary': '/analysis/group-buy/daily-summary',
      'analysis-group-binding': '/analysis/group-buy/binding',
      'analysis-delivery-platform': '/analysis/delivery/platform',
      'analysis-delivery-meituan': '/analysis/delivery/platform',
      'analysis-delivery-taobao': '/analysis/delivery/platform',
      'analysis-delivery-jd': '/analysis/delivery/platform',
      'analysis-delivery-brand': '/analysis/delivery/brand',
      'analysis-delivery-store': '/analysis/delivery/store',
      'analysis-delivery-binding': '/analysis/delivery/binding',
      'analysis-sync-runs': '/business-analytics/sync-runs',
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
      'data-import-pos-automation': '/data-import/pos/automation',
      'data-import-group-buy': '/data-import/group-buy',
      'data-import-delivery': '/data-import/delivery',
    }[index]
    await router.push(routePath)
    popupMenu.visible = false
    popupMenu.group = null
    popupMenu.sections = []
    return
  }
  if (index.startsWith('staff-management-')) {
    const routePath = staffRouteForId(index, auth.permissions, staffLastPaths)
    if (!routePath) return
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
  if(workspaceForId(id)){const target=workspaceRoute(id,workspaceLastPaths);if(target)await router.push(target);return}
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
      'analysis-agents': '/analysis/agents',
      'analysis-total-brand': '/analysis/total/brand',
      'analysis-total-store': '/analysis/total/store',
      'analysis-total-custom': '/analysis/total/custom',
      'analysis-total-monthly-dashboard': '/analysis/total/monthly-dashboard',
      'analysis-delivery-fees': '/analysis/delivery/fee-rules',
      'analysis-total-binding': '/analysis/total/binding',
      'analysis-group-platform': '/analysis/group-buy/platform',
      'analysis-group-meituan': '/analysis/group-buy/platform',
      'analysis-group-douyin': '/analysis/group-buy/platform',
      'analysis-group-free-trial': '/analysis/group-buy/platform',
      'analysis-group-brand': '/analysis/group-buy/brand',
      'analysis-group-store': '/analysis/group-buy/store',
      'analysis-group-daily-summary': '/analysis/group-buy/daily-summary',
      'analysis-group-binding': '/analysis/group-buy/binding',
      'analysis-delivery-platform': '/analysis/delivery/platform',
      'analysis-delivery-meituan': '/analysis/delivery/platform',
      'analysis-delivery-taobao': '/analysis/delivery/platform',
      'analysis-delivery-jd': '/analysis/delivery/platform',
      'analysis-delivery-brand': '/analysis/delivery/brand',
      'analysis-delivery-store': '/analysis/delivery/store',
      'analysis-delivery-binding': '/analysis/delivery/binding',
      'analysis-sync-runs': '/business-analytics/sync-runs',
    }[id]
    await router.push(routePath || '/analysis/total/brand')
    return
  }
  if (id.startsWith('data-import-')) {
    store.activeTabId = id
    const routePath = {
      'data-import-pos': '/data-import/pos',
      'data-import-pos-automation': '/data-import/pos/automation',
      'data-import-group-buy': '/data-import/group-buy',
      'data-import-delivery': '/data-import/delivery',
    }[id]
    await router.push(routePath)
    return
  }
  if (id.startsWith('staff-management-')) {
    const routePath = staffRouteForId(id, auth.permissions, staffLastPaths)
    if (routePath) await router.push(routePath)
    return
  }
  const routePath = id === 'pipeline' ? pipelineLastPath.value : WORKSPACE_TAB_ROUTES[id]
  store.activeTabId = id
  if (routePath) await router.push(routePath)
  else await leaveSpecialRoute()
}

async function closeTab(id) {
  const wasActive=store.activeTabId===id
  store.closeTab(id)
  if(wasActive&&store.activeTabId!==id){
    if(store.activeTabId)await selectTab(store.activeTabId)
    else await router.push('/dashboard')
  }
}

watch(() => [store.activeTabId,store.activeTab?.pageId], ([id,page]) => {
  if (!id) return
  currentView.value = COMPONENT_MAP[page || id] || DashboardView
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
// 通知路由需要显式的 tab 同步：否则点顶栏铃铛只改 URL、内容区仍停在上一页。
watch(isNotificationRoute, (active) => {
  if (active) store.openTabFromId('notifications')
})
watch(isNotificationRulesRoute, (active) => {
  if (active) store.openTabFromId('notification-rules')
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
    store.setServerStatus(Boolean(auth.user))
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
  else if (isNotificationRulesRoute.value) store.openTabFromId('notification-rules')
  else if (router.currentRoute.value.path.startsWith('/notifications')) store.openTabFromId('notifications')
  else store.openTabFromId('dashboard')
  // 通知角标：立即取一次，之后每 60 秒刷新
  await refreshNotifications()
  notificationTimer = window.setInterval(refreshNotifications, 60000)
  // 通知中心里处理完通知后，立刻同步角标
  window.addEventListener('notifications:changed', refreshNotifications)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateResponsiveLayout)
  window.removeEventListener('notifications:changed', refreshNotifications)
  if (notificationTimer) window.clearInterval(notificationTimer)
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


.popup-item:focus-visible{outline:2px solid var(--el-color-primary);outline-offset:1px}

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
