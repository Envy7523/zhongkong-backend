<template>
  <view class="workbench">
    <view class="welcome"><text class="eyebrow">鹅太公中控</text><view class="welcome-title">门店工作台</view><text class="welcome-sub">事项有进度，经营有数据，账目有明细。</text></view>
    <view class="profile"><view class="avatar">{{ (user?.display_name || user?.username || '鹅').slice(0, 1) }}</view><view class="profile-info"><view class="profile-name">{{ user?.display_name || user?.username || '加载中' }}</view><text class="muted">{{ user?.role || '正在获取权限' }} · {{ user?.store_id ? '本店范围' : '按岗位授权' }}</text></view><button class="logout" @tap="logout">退出登录</button></view>
    <view v-if="error" class="error"><text>{{ error }}</text><button @tap="refresh">重新加载</button></view>
    <view class="section-heading"><text>常用功能</text><text class="muted">{{ loading ? '更新中…' : '按当前人员权限开放' }}</text></view>
    <button v-for="item in entries" :key="item.key" class="feature" :disabled="!allowed(item.permission)" @tap="open(item.path)">
      <view class="feature-icon" :class="item.key"><image :src="item.icon" /></view>
      <view class="feature-body"><view class="feature-title">{{ item.title }}<text class="feature-tag">{{ allowed(item.permission) ? item.tag : '未开通' }}</text></view><text class="feature-desc">{{ item.description }}</text></view><text class="chevron">›</text>
    </button>
    <view v-if="allowed('collab.manage')" class="task-panel"><view class="section-heading"><text>协同进度</text><text class="muted">{{ statsLoading ? '加载中' : '当前可见事项' }}</text></view><view class="task-metrics"><view><text class="metric-num">{{ stats?.pending ?? '—' }}</text><text>待开始</text></view><view><text class="metric-num orange">{{ stats?.doing ?? '—' }}</text><text>进行中</text></view><view><text class="metric-num">{{ stats?.done ?? '—' }}</text><text>已完成</text></view></view></view>
    <view class="workbench-note">数据来自中控后台。门店范围与功能权限由管理员统一管理。</view>
  </view>
</template>
<script setup>
import { ref } from 'vue'
import { onShow, onPullDownRefresh } from '@dcloudio/uni-app'
import api from '../../common/api'
import { getToken, getUser, saveSession, clearAllSession } from '../../common/request'
const user = ref(getUser())
const loading = ref(false)
const statsLoading = ref(false)
const error = ref('')
const stats = ref(null)
const entries = [
  { key: 'collab', title: '协同事项', tag: '跟进', description: '发起事项、查看回复、跟进处理进度', permission: 'collab.manage', path: '/pages/collab/list', icon: '/static/nav/collab-on.png' },
  { key: 'revenue', title: '门店数据', tag: '经营', description: '按门店与日期查看营业额及渠道构成', permission: 'analysis.view', path: '/pages/revenue/index', icon: '/static/nav/revenue-on.png' },
  { key: 'ledger', title: '记账本', tag: '明细', description: '按门店、单日或周期核对分类与记账流水', permission: 'bookkeeping.manage', path: '/pages/bookkeeping/index', icon: '/static/nav/ledger-on.png' },
]
function allowed(permission) { return (user.value?.position_permissions || []).some(p => p === '*' || p === permission) }
function open(path) { uni.switchTab({ url: path }) }
function logout() { clearAllSession(); uni.reLaunch({ url: '/pages/login/login' }) }
async function refresh() {
  if (!getToken()) { uni.reLaunch({ url: '/pages/login/login' }); return }
  if (loading.value) return
  loading.value = true; error.value = ''; stats.value = null
  try {
    const res = await api.me(); user.value = res.user; saveSession(getToken(), res.user)
    if (allowed('collab.manage')) {
      statsLoading.value = true
      try { stats.value = (await api.issueStats()).stats } catch { /* 数字保持未加载状态，不伪装为零 */ }
      finally { statsLoading.value = false }
    }
  } catch (e) { error.value = e.message }
  finally { loading.value = false }
}
onShow(refresh)
onPullDownRefresh(async () => { await refresh(); uni.stopPullDownRefresh() })
</script>
<style scoped>
.workbench { padding: 32rpx 28rpx 48rpx; }
.welcome { padding: 28rpx 8rpx 40rpx; }.eyebrow { color: var(--brand); font-size: 24rpx; font-weight: 600; }.welcome-title { font-size: 52rpx; font-weight: 700; margin: 12rpx 0; letter-spacing: 2rpx; }.welcome-sub { color: var(--text-2); font-size: 26rpx; }
.profile { display: flex; align-items: center; gap: 18rpx; padding: 24rpx; background: white; border-radius: 22rpx; margin-bottom: 36rpx; }.avatar { width: 76rpx; height: 76rpx; line-height: 76rpx; text-align: center; background: var(--brand-soft); color: var(--brand); border-radius: 22rpx; font-size: 34rpx; font-weight: 700; }.profile-info { flex: 1; min-width: 0; }.profile-name { font-weight: 600; font-size: 30rpx; }.muted { font-size: 24rpx; color: var(--text-2); }.logout { margin: 0; font-size: 24rpx; background: #f5f6f8; padding: 0 20rpx; line-height: 88rpx; color: var(--text-2); }
.section-heading { display: flex; align-items: center; justify-content: space-between; font-size: 30rpx; font-weight: 600; margin-bottom: 20rpx; }.section-heading .muted { font-weight: 400; }
.feature { display: flex; align-items: center; text-align: left; padding: 28rpx 24rpx; margin: 0 0 20rpx; background: white; border-radius: 24rpx; line-height: 1.5; color: var(--text-1); box-shadow: 0 4rpx 20rpx rgba(31,35,41,.03); }.feature[disabled] { opacity: .55; }.feature-icon { background: var(--brand-soft); width: 88rpx; height: 88rpx; border-radius: 22rpx; display: flex; align-items: center; justify-content: center; margin-right: 22rpx; }.feature-icon image { width: 48rpx; height: 48rpx; }.feature-body { flex: 1; min-width: 0; }.feature-title { font-size: 32rpx; font-weight: 600; display: flex; align-items: center; gap: 16rpx; }.feature-tag { font-size: 20rpx; padding: 2rpx 10rpx; background: #f5f6f8; border-radius: 8rpx; font-weight: 400; color: var(--text-2); }.feature-desc { display: block; color: var(--text-2); font-size: 24rpx; margin-top: 10rpx; }.chevron { font-size: 40rpx; color: var(--text-3); padding-left: 12rpx; }
.task-panel { margin-top: 36rpx; padding: 28rpx; background: white; border-radius: 24rpx; }.task-metrics { display: flex; }.task-metrics view { flex: 1; display: flex; flex-direction: column; text-align: center; font-size: 24rpx; color: var(--text-2); }.metric-num { font-size: 44rpx; font-weight: 700; color: var(--text-1); margin-bottom: 6rpx; }.orange { color: var(--brand); }.workbench-note { margin: 32rpx 16rpx; color: var(--text-2); font-size: 24rpx; line-height: 1.8; }.error { background: #fff0ed; padding: 24rpx; margin-bottom: 24rpx; color: #a33320; border-radius: 16rpx; }.error button { font-size: 26rpx; }
button::after { border: none; }
</style>
