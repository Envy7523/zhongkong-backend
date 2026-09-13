<template>
  <view class="list-page">
    <!-- 营业数据入口 -->
    <view class="entry" @tap="goRevenue">
      <view class="entry-left">
        <text class="entry-icon">📊</text>
        <view>
          <view class="entry-title">门店营业数据</view>
          <view class="entry-sub">选择门店与日期，查看营业额与渠道构成</view>
        </view>
      </view>
      <text class="entry-arrow">›</text>
    </view>

    <!-- 顶部统计 -->
    <view class="stats">
      <view class="stat" @tap="pickStatus('')">
        <text class="stat-num">{{ stats.total }}</text>
        <text class="stat-label">全部</text>
      </view>
      <view class="stat" @tap="pickStatus('待开始')">
        <text class="stat-num">{{ stats.pending }}</text>
        <text class="stat-label">待开始</text>
      </view>
      <view class="stat" @tap="pickStatus('进行中')">
        <text class="stat-num stat-num--doing">{{ stats.doing }}</text>
        <text class="stat-label">进行中</text>
      </view>
      <view class="stat" @tap="pickStatus('未完成')">
        <text class="stat-num stat-num--undone">{{ stats.undone }}</text>
        <text class="stat-label">未完成</text>
      </view>
      <view class="stat" @tap="pickStatus('已完成')">
        <text class="stat-num stat-num--done">{{ stats.done }}</text>
        <text class="stat-label">已完成</text>
      </view>
    </view>

    <!-- 筛选 -->
    <view class="filters">
      <scroll-view class="tabs" scroll-x :show-scrollbar="false">
        <view
          v-for="t in tabs"
          :key="t.value"
          class="tab"
          :class="{ 'tab--on': status === t.value && !onlyMine }"
          @tap="pickStatus(t.value)"
        >{{ t.label }}</view>
      </scroll-view>
      <view class="mine-toggle" :class="{ 'mine-toggle--on': onlyMine }" @tap="toggleMine">
        {{ onlyMine ? '✓ ' : '' }}与我相关
      </view>
    </view>

    <view class="search">
      <input
        v-model="keyword"
        class="search-input"
        type="text"
        placeholder="搜索事项标题"
        placeholder-class="ph"
        confirm-type="search"
        @confirm="reload"
      />
      <view v-if="keyword" class="search-clear" @tap="clearKeyword">✕</view>
    </view>

    <!-- 列表 -->
    <view v-if="rows.length" class="cards">
      <view v-for="item in rows" :key="item.id" class="issue" @tap="goDetail(item.id)">
        <view class="mp-between issue-top">
          <text class="issue-no">{{ item.issue_no }}</text>
          <text class="mp-chip" :class="statusStyle(item.status_display).cls">{{ item.status_display }}</text>
        </view>
        <view class="issue-title">{{ item.title }}</view>
        <view class="issue-desc" v-if="item.description">{{ item.description }}</view>
        <view class="issue-meta mp-muted">
          <text>👤 {{ item.created_by_name || '—' }}</text>
          <text v-if="item.participants_name && item.participants_name.length"> → {{ item.participants_name.join('、') }}</text>
        </view>
        <view class="mp-between issue-foot">
          <text class="mp-muted">📅 {{ (item.created_at || '').slice(0, 10) }}</text>
          <view class="foot-right">
            <text v-if="item.deadline" class="deadline" :class="{ 'deadline--over': item.overdue }">⏰ {{ item.deadline }}</text>
            <text v-if="item.reply_count" class="mp-muted">💬 {{ item.reply_count }}</text>
            <text v-if="item.is_mine" class="mine-tag">我</text>
          </view>
        </view>
      </view>

      <view class="load-more mp-muted" @tap="loadMore">
        {{ finished ? '没有更多了' : (loading ? '加载中…' : '加载更多') }}
      </view>
    </view>

    <view v-else-if="!loading" class="mp-empty">
      <view class="empty-icon">📋</view>
      <view>暂无事项，点右下角「＋」发起第一条</view>
    </view>
    <view v-else class="mp-empty">加载中…</view>

    <!-- 发起事项 -->
    <view class="fab" @tap="goCreate">＋</view>
  </view>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { onLoad, onShow, onPullDownRefresh, onReachBottom } from '@dcloudio/uni-app'
import api from '../../common/api'
import { getToken } from '../../common/request'
import { statusStyle } from '../../common/config'

const tabs = [
  { label: '全部', value: '' },
  { label: '待开始', value: '待开始' },
  { label: '进行中', value: '进行中' },
  { label: '已完成', value: '已完成' },
  { label: '未完成', value: '未完成' },
]

const rows = ref([])
const stats = reactive({ total: 0, pending: 0, doing: 0, done: 0, undone: 0 })
const status = ref('')
const keyword = ref('')
const onlyMine = ref(false)
const page = ref(1)
const pageSize = 10
const total = ref(0)
const loading = ref(false)
const finished = computed(() => rows.value.length >= total.value)

onLoad(() => {
  if (!getToken()) {
    uni.reLaunch({ url: '/pages/login/login' })
    return
  }
  reload()
})

onShow(() => {
  // 从详情/发起页返回时刷新，保证状态推进后列表同步
  if (getToken() && rows.value.length) refresh()
})

onPullDownRefresh(async () => {
  await refresh()
  uni.stopPullDownRefresh()
})

onReachBottom(() => loadMore())

async function fetchStats() {
  try {
    const res = await api.issueStats()
    Object.assign(stats, res.stats || {})
  } catch {}
}

async function fetchPage(p) {
  const res = await api.issueList({
    status: status.value,
    keyword: keyword.value,
    onlyMine: onlyMine.value ? 1 : '',
    page: p,
    pageSize,
  })
  total.value = res.total || 0
  return res.rows || []
}

async function reload() {
  loading.value = true
  page.value = 1
  try {
    rows.value = await fetchPage(1)
    fetchStats()
  } catch (e) {
    rows.value = []
  } finally {
    loading.value = false
  }
}

async function refresh() {
  try {
    rows.value = await fetchPage(1)
    page.value = 1
    fetchStats()
  } catch {}
}

async function loadMore() {
  if (loading.value || finished.value) return
  loading.value = true
  try {
    const next = await fetchPage(page.value + 1)
    if (next.length) {
      rows.value = rows.value.concat(next)
      page.value += 1
    } else {
      total.value = rows.value.length
    }
  } catch {} finally {
    loading.value = false
  }
}

function pickStatus(v) {
  status.value = v
  onlyMine.value = false
  reload()
}

function toggleMine() {
  onlyMine.value = !onlyMine.value
  reload()
}

function clearKeyword() {
  keyword.value = ''
  reload()
}

function goDetail(id) {
  uni.navigateTo({ url: `/pages/collab/detail?id=${id}` })
}

function goCreate() {
  uni.navigateTo({ url: '/pages/collab/create' })
}

function goRevenue() {
  uni.navigateTo({ url: '/pages/revenue/index' })
}
</script>

<style scoped>
.list-page {
  min-height: 100vh;
  padding-bottom: 180rpx;
}

.entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  margin: 24rpx 24rpx 0;
  padding: 26rpx 28rpx;
  border-radius: 20rpx;
  box-shadow: 0 2rpx 12rpx rgba(31, 35, 41, 0.04);
}
.entry-left {
  display: flex;
  align-items: center;
}
.entry-icon {
  font-size: 44rpx;
  margin-right: 20rpx;
}
.entry-title {
  font-size: 30rpx;
  font-weight: 600;
}
.entry-sub {
  margin-top: 6rpx;
  font-size: 22rpx;
  color: var(--text-3);
}
.entry-arrow {
  font-size: 40rpx;
  color: #c9cdd4;
}

.stats {
  display: flex;
  background: #fff;
  padding: 28rpx 0 24rpx;
}
.stat {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.stat-num {
  font-size: 42rpx;
  font-weight: 700;
  line-height: 1.2;
}
.stat-num--doing { color: #ff7d00; }
.stat-num--done { color: #00b42a; }
.stat-num--undone { color: #f53f3f; }
.stat-label {
  margin-top: 6rpx;
  font-size: 22rpx;
  color: var(--text-3);
}

.filters {
  display: flex;
  align-items: center;
  padding: 8rpx 24rpx 0;
  background: #fff;
}
.tabs {
  flex: 1;
  white-space: nowrap;
}
.tab {
  display: inline-block;
  padding: 18rpx 4rpx;
  margin-right: 32rpx;
  font-size: 28rpx;
  color: var(--text-2);
  position: relative;
}
.tab--on {
  color: var(--brand);
  font-weight: 600;
}
.tab--on::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 6rpx;
  width: 44rpx;
  height: 6rpx;
  border-radius: 3rpx;
  background: var(--brand);
  transform: translateX(-50%);
}
.mine-toggle {
  flex-shrink: 0;
  font-size: 24rpx;
  color: var(--text-3);
  padding: 10rpx 22rpx;
  border-radius: 999rpx;
  background: #f2f3f5;
}
.mine-toggle--on {
  color: var(--brand);
  background: var(--brand-soft);
}

.search {
  position: relative;
  padding: 20rpx 24rpx;
  background: #fff;
}
.search-input {
  height: 76rpx;
  background: #f7f8fa;
  border-radius: 999rpx;
  padding: 0 60rpx 0 30rpx;
  font-size: 28rpx;
}
.ph { color: #c9cdd4; }
.search-clear {
  position: absolute;
  right: 46rpx;
  top: 36rpx;
  width: 44rpx;
  height: 44rpx;
  line-height: 44rpx;
  text-align: center;
  color: var(--text-3);
  font-size: 24rpx;
}

.cards {
  padding: 24rpx 0;
}
.issue {
  background: #fff;
  border-radius: 20rpx;
  padding: 28rpx;
  margin: 0 24rpx 20rpx;
  box-shadow: 0 2rpx 12rpx rgba(31, 35, 41, 0.04);
}
.issue-top { margin-bottom: 14rpx; }
.issue-no {
  font-size: 22rpx;
  color: var(--text-3);
  font-family: Menlo, Consolas, monospace;
}
.issue-title {
  font-size: 32rpx;
  font-weight: 600;
  line-height: 1.4;
  margin-bottom: 10rpx;
}
.issue-desc {
  font-size: 26rpx;
  color: var(--text-2);
  line-height: 1.5;
  margin-bottom: 12rpx;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.issue-meta {
  margin-bottom: 16rpx;
}
.issue-foot { font-size: 22rpx; }
.foot-right {
  display: flex;
  align-items: center;
  gap: 16rpx;
}
.deadline { color: var(--text-3); }
.deadline--over { color: #f53f3f; font-weight: 600; }
.mine-tag {
  width: 32rpx;
  height: 32rpx;
  line-height: 32rpx;
  text-align: center;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 20rpx;
}

.load-more {
  text-align: center;
  padding: 24rpx 0 40rpx;
  font-size: 24rpx;
}

.empty-icon {
  font-size: 72rpx;
  margin-bottom: 20rpx;
}

.fab {
  position: fixed;
  right: 40rpx;
  bottom: 80rpx;
  width: 108rpx;
  height: 108rpx;
  border-radius: 50%;
  background: var(--brand);
  color: #fff;
  font-size: 56rpx;
  line-height: 104rpx;
  text-align: center;
  box-shadow: 0 12rpx 28rpx rgba(217, 79, 43, 0.35);
  z-index: 20;
}
</style>
