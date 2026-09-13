<template>
  <view class="rev-page">
    <!-- 门店 + 日期 -->
    <view class="picker-bar">
      <view class="store-pick" @tap="openStoreSheet">
        <view class="store-name mp-ellipsis">{{ store ? store.store_name : '选择门店' }}</view>
        <view class="store-sub mp-muted">
          {{ store ? [store.city, store.district].filter(Boolean).join(' · ') || store.status : '点击选择' }}
          <text class="caret">▾</text>
        </view>
      </view>

      <view class="date-nav">
        <view class="date-arrow" :class="{ 'date-arrow--off': !data.prev_date }" @tap="goDate(data.prev_date)">◀</view>
        <picker mode="date" :value="date" @change="onPickDate">
          <view class="date-current">
            <text class="date-text">{{ date || '选择日期' }}</text>
            <text class="date-week mp-muted">{{ weekOf(date) }}</text>
          </view>
        </picker>
        <view class="date-arrow" :class="{ 'date-arrow--off': !data.next_date }" @tap="goDate(data.next_date)">▶</view>
      </view>
    </view>

    <!-- 有数据的日期快捷选 -->
    <scroll-view v-if="quickDates.length" class="quick-dates" scroll-x :show-scrollbar="false">
      <view
        v-for="d in quickDates"
        :key="d"
        class="quick-date"
        :class="{ 'quick-date--on': d === date }"
        @tap="goDate(d)"
      >{{ d.slice(5) }}</view>
    </scroll-view>

    <view v-if="loading" class="mp-empty">加载中…</view>

    <!-- 空状态 -->
    <view v-else-if="!data.found" class="empty-wrap">
      <view class="empty-icon">📊</view>
      <view class="empty-title">{{ store ? store.store_name : '' }}</view>
      <view class="empty-msg">{{ data.message || '这一天没有日报数据' }}</view>
      <view v-if="data.latest" class="mp-btn mp-btn--primary empty-btn" @tap="goDate(data.latest)">
        查看最近有数据的一天（{{ data.latest }}）
      </view>
    </view>

    <template v-else>
      <!-- 主指标 -->
      <view class="hero">
        <view class="hero-label">营业额</view>
        <view class="hero-value">¥{{ money(data.summary.revenue) }}</view>
        <view class="hero-compare">
          <template v-if="data.compare">
            <text class="cmp-label">较 {{ data.compare.date.slice(5) }}</text>
            <text class="cmp-pill" :class="diffClass(data.compare.revenue_pct)">
              {{ diffArrow(data.compare.revenue_pct) }}{{ data.compare.revenue_pct === null ? '—' : Math.abs(data.compare.revenue_pct) + '%' }}
            </text>
            <text class="cmp-abs mp-muted">
              {{ data.compare.revenue_diff >= 0 ? '+' : '-' }}¥{{ money(Math.abs(data.compare.revenue_diff)) }}
            </text>
          </template>
          <text v-else class="mp-muted">无上一日数据可比</text>
        </view>
      </view>

      <!-- 指标格（后端下发 metrics，兼容不同数据源） -->
      <view class="grid">
        <view v-for="m in data.metrics" :key="m.key" class="grid-item">
          <text class="grid-label">{{ m.label }}</text>
          <text class="grid-value">{{ metricText(m) }}</text>
          <text v-if="m.sub" class="grid-sub mp-muted">{{ m.sub }}</text>
        </view>
      </view>

      <!-- 分组条形（渠道构成 / 平台明细 / 营收构成） -->
      <view v-for="sec in data.sections" :key="sec.key" class="block">
        <view class="block-head">
          <text class="block-title">{{ sec.title }}</text>
          <text class="block-sum mp-muted">合计 ¥{{ money(sec.total) }}</text>
        </view>
        <view v-for="it in sec.items" :key="sec.key + '-' + it.key" class="bar-row">
          <view class="bar-top">
            <text class="bar-label">{{ it.label }}</text>
            <text class="bar-value">¥{{ money(it.value) }}</text>
            <text class="bar-pct mp-muted">{{ share(it.value, sec.total) }}</text>
          </view>
          <view class="bar-track">
            <view
              class="bar-fill"
              :class="sec.key === 'composition' ? 'bar-fill--pay' : 'bar-fill--channel'"
              :style="{ width: shareWidth(it.value, sec.total) }"
            ></view>
          </view>
          <text v-if="it.sub" class="bar-sub mp-muted">{{ it.sub }}</text>
        </view>
        <view v-if="!sec.items.length" class="mp-muted block-empty">该日无数据</view>
      </view>

      <view class="foot-tip mp-muted">
        口径与 PC 后台一致：营业额 = 营业收入 + 优惠金额；实收 = 营业收入；平台费用含服务费、推广费、保险与退款。
        「渠道构成」「平台明细」「营收构成」是不同维度，各自合计，不做相加。
      </view>
    </template>

    <!-- 门店选择弹层 -->
    <view v-if="storeShow" class="mask" @tap="storeShow = false">
      <view class="sheet" @tap.stop>
        <view class="sheet-title">选择门店</view>
        <input
          v-model="storeKeyword"
          class="sheet-search"
          type="text"
          placeholder="搜索门店名称"
          placeholder-class="ph"
        />
        <scroll-view class="store-list" scroll-y>
          <view
            v-for="s in filteredStores"
            :key="s.id"
            class="store-item"
            :class="{ 'store-item--on': store && s.id === store.id }"
            @tap="pickStore(s)"
          >
            <view class="store-item-name">{{ s.store_name }}</view>
            <view class="store-item-sub mp-muted">
              {{ [s.city, s.district].filter(Boolean).join(' · ') }}<text v-if="s.status"> · {{ s.status }}</text>
            </view>
          </view>
          <view v-if="!filteredStores.length" class="mp-empty">没有匹配的门店</view>
        </scroll-view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app'
import api from '../../common/api'
import { getToken } from '../../common/request'

const stores = ref([])
const store = ref(null)
const date = ref('')
const data = reactive({ found: false, summary: {}, metrics: [], sections: [], compare: null, available_dates: [] })
const loading = ref(false)
const storeShow = ref(false)
const storeKeyword = ref('')

const filteredStores = computed(() => {
  const kw = storeKeyword.value.trim()
  if (!kw) return stores.value
  return stores.value.filter(s => s.store_name.includes(kw) || (s.city || '').includes(kw))
})

/** 快捷日期：最近有数据的 5 天（排除当前选中） */
const quickDates = computed(() => (data.available_dates || []).filter(d => d !== date.value).slice(0, 5))

onLoad(async () => {
  if (!getToken()) {
    uni.reLaunch({ url: '/pages/login/login' })
    return
  }
  await loadStores()
})

onPullDownRefresh(async () => {
  await loadData(date.value, true)
  uni.stopPullDownRefresh()
})

async function loadStores() {
  try {
    const res = await api.storeList()
    stores.value = res.stores || []
    if (!stores.value.length) {
      uni.showToast({ title: '没有可选门店', icon: 'none' })
      return
    }
    // 默认选第一家；若 URL 带了 store_id 则用它（便于从别的页面直达）
    const want = Number(store.value?.id || 0)
    store.value = stores.value.find(s => s.id === want) || stores.value[0]
    await loadData('')
  } catch (e) { /* request 层已提示 */ }
}

async function loadData(d, silent = false) {
  if (!store.value) return
  loading.value = true
  try {
    const res = await api.revenue(store.value.id, d || undefined)
    Object.assign(data, normalize(res))
    date.value = res.date || ''
  } catch (e) {
    data.found = false
  } finally {
    loading.value = false
  }
}

/**
 * 统一视图模型：后端可能返回两种数据源的形状
 *   1) 真实库（business_revenue_records）：已带 metrics / sections
 *   2) 老库（daily_reports）：channels + pay_sources，这里补成同一形状
 * 这样页面只认 metrics / sections，换数据源不用改页面。
 */
function normalize(res) {
  if (Array.isArray(res.metrics) && Array.isArray(res.sections)) return res

  const s = res.summary || {}
  const metrics = [
    { key: 'actual', label: '实收', value: s.actual_revenue, type: 'money' },
    { key: 'orders', label: '有效订单', value: s.order_count, type: 'int', unit: '单' },
    { key: 'avg', label: '客单价', value: s.avg_order_value, type: 'money' },
    { key: 'discount', label: '优惠', value: s.discount_amount, type: 'money', sub: `占比 ${s.discount_rate || 0}%` },
  ]
  const sections = [
    { key: 'channel', title: '销售渠道', total: res.channel_total || 0, items: res.channels || [] },
    { key: 'pay', title: '堂食消费来源', total: res.pay_total || 0, items: res.pay_sources || [] },
  ].filter(sec => (sec.items || []).length)

  return { ...res, metrics, sections }
}

function openStoreSheet() {
  storeKeyword.value = ''
  storeShow.value = true
}

function pickStore(s) {
  store.value = s
  storeShow.value = false
  loadData('')   // 切店后自动落到该店最近有数据的一天
}

function goDate(d) {
  if (!d) return
  loadData(d)
}

function onPickDate(e) {
  loadData(e.detail.value)
}

// ==================== 格式化 ====================

function money(n) {
  const v = Number(n || 0)
  const neg = v < 0
  const [int, dec] = Math.abs(v).toFixed(2).split('.')
  return (neg ? '-' : '') + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + dec
}

/** 指标格取值：金额带 ¥，计数带单位 */
function metricText(m) {
  if (!m) return '—'
  if (m.type === 'int') return String(m.value == null ? 0 : m.value) + (m.unit || '')
  return '¥' + money(m.value)
}

function share(v, total) {
  if (!total) return '0%'
  return ((Number(v || 0) / Number(total)) * 100).toFixed(1) + '%'
}

function shareWidth(v, total) {
  if (!total) return '0%'
  const p = Math.max(2, (Number(v || 0) / Number(total)) * 100)
  return Math.min(100, p) + '%'
}

function diffClass(pct) {
  if (pct === null || pct === undefined) return 'cmp-pill--flat'
  if (pct > 0) return 'cmp-pill--up'
  if (pct < 0) return 'cmp-pill--down'
  return 'cmp-pill--flat'
}

function diffArrow(pct) {
  if (pct === null || pct === undefined || pct === 0) return ''
  return pct > 0 ? '↑ ' : '↓ '
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function weekOf(d) {
  if (!d) return ''
  const dt = new Date(String(d) + 'T00:00:00')
  return isNaN(dt.getTime()) ? '' : WEEK[dt.getDay()]
}
</script>

<style scoped>
.rev-page {
  min-height: 100vh;
  padding-bottom: 60rpx;
}

/* ---------- 顶部选择区 ---------- */
.picker-bar {
  background: #fff;
  padding: 24rpx 28rpx;
}
.store-pick {
  margin-bottom: 20rpx;
}
.store-name {
  font-size: 34rpx;
  font-weight: 700;
}
.store-sub {
  margin-top: 6rpx;
}
.caret {
  margin-left: 8rpx;
  color: var(--brand);
}
.date-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #f7f8fa;
  border-radius: 16rpx;
  padding: 8rpx;
}
.date-arrow {
  width: 72rpx;
  height: 68rpx;
  line-height: 68rpx;
  text-align: center;
  color: var(--brand);
  font-size: 24rpx;
}
.date-arrow--off {
  color: #c9cdd4;
}
.date-current {
  flex: 1;
  text-align: center;
  padding: 8rpx 0;
}
.date-text {
  font-size: 30rpx;
  font-weight: 600;
}
.date-week {
  margin-left: 12rpx;
  font-size: 24rpx;
}

.quick-dates {
  white-space: nowrap;
  background: #fff;
  padding: 0 24rpx 20rpx;
}
.quick-date {
  display: inline-block;
  padding: 10rpx 24rpx;
  margin-right: 12rpx;
  border-radius: 999rpx;
  background: #f2f3f5;
  color: var(--text-2);
  font-size: 24rpx;
}
.quick-date--on {
  background: var(--brand-soft);
  color: var(--brand);
  font-weight: 600;
}

/* ---------- 主指标 ---------- */
.hero {
  background: linear-gradient(135deg, #d94f2b 0%, #e8722f 100%);
  margin: 24rpx;
  border-radius: 24rpx;
  padding: 40rpx 36rpx;
  color: #fff;
}
.hero-label {
  font-size: 26rpx;
  opacity: 0.85;
}
.hero-value {
  font-size: 68rpx;
  font-weight: 700;
  line-height: 1.2;
  margin: 8rpx 0 18rpx;
  letter-spacing: 1rpx;
}
.hero-compare {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}
.cmp-label {
  font-size: 24rpx;
  opacity: 0.85;
  margin-right: 12rpx;
}
.cmp-pill {
  font-size: 24rpx;
  padding: 4rpx 16rpx;
  border-radius: 999rpx;
  margin-right: 12rpx;
  background: rgba(255, 255, 255, 0.22);
}
.cmp-pill--up { background: #ffffff; color: #d94f2b; font-weight: 600; }
.cmp-pill--down { background: #1f2329; color: #fff; font-weight: 600; }
.cmp-pill--flat { background: rgba(255, 255, 255, 0.22); color: #fff; }
.cmp-abs {
  font-size: 24rpx;
  color: rgba(255, 255, 255, 0.9) !important;
}

/* ---------- 指标网格 ---------- */
.grid {
  display: flex;
  flex-wrap: wrap;
  background: #fff;
  border-radius: 20rpx;
  margin: 0 24rpx 24rpx;
  padding: 8rpx 0;
}
.grid-item {
  width: 50%;
  box-sizing: border-box;
  padding: 24rpx 28rpx;
  display: flex;
  flex-direction: column;
}
.grid-label {
  font-size: 24rpx;
  color: var(--text-3);
  margin-bottom: 8rpx;
}
.grid-value {
  font-size: 36rpx;
  font-weight: 600;
}
.grid-unit {
  font-size: 22rpx;
  color: var(--text-3);
  margin-left: 4rpx;
}
.grid-sub {
  margin-top: 4rpx;
  font-size: 22rpx;
}

/* ---------- 渠道条形 ---------- */
.block {
  background: #fff;
  border-radius: 20rpx;
  margin: 0 24rpx 24rpx;
  padding: 28rpx;
}
.block-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 20rpx;
}
.block-title {
  font-size: 30rpx;
  font-weight: 600;
}
.block-sum {
  font-size: 24rpx;
}
.block-empty {
  padding: 20rpx 0;
}
.bar-row {
  margin-bottom: 22rpx;
}
.bar-top {
  display: flex;
  align-items: baseline;
  margin-bottom: 10rpx;
}
.bar-label {
  flex: 1;
  font-size: 27rpx;
  color: var(--text-2);
}
.bar-value {
  font-size: 27rpx;
  font-weight: 600;
  margin-right: 16rpx;
}
.bar-pct {
  width: 96rpx;
  text-align: right;
  font-size: 22rpx;
}
.bar-track {
  height: 12rpx;
  background: #f2f3f5;
  border-radius: 6rpx;
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 6rpx;
}
.bar-fill--channel { background: #d94f2b; }
.bar-fill--pay { background: #ff9a5c; }
.bar-sub {
  display: block;
  margin-top: 8rpx;
  font-size: 21rpx;
}

/* ---------- 空状态 ---------- */
.empty-wrap {
  padding: 120rpx 60rpx;
  text-align: center;
}
.empty-icon {
  font-size: 80rpx;
  margin-bottom: 20rpx;
}
.empty-title {
  font-size: 30rpx;
  font-weight: 600;
  margin-bottom: 12rpx;
}
.empty-msg {
  font-size: 26rpx;
  color: var(--text-3);
  line-height: 1.7;
  margin-bottom: 40rpx;
}
.empty-btn {
  margin: 0 auto;
  padding: 0 32rpx;
}

.foot-tip {
  padding: 0 40rpx 40rpx;
  font-size: 22rpx;
  line-height: 1.7;
}

/* ---------- 门店选择弹层 ---------- */
.mask {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 50;
  display: flex;
  align-items: flex-end;
}
.sheet {
  width: 100%;
  max-height: 78vh;
  background: #fff;
  border-radius: 28rpx 28rpx 0 0;
  padding: 32rpx 28rpx calc(28rpx + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
}
.sheet-title {
  font-size: 32rpx;
  font-weight: 700;
  margin-bottom: 20rpx;
}
.sheet-search {
  height: 76rpx;
  background: #f7f8fa;
  border-radius: 14rpx;
  padding: 0 24rpx;
  font-size: 28rpx;
  margin-bottom: 16rpx;
}
.ph { color: #c9cdd4; }
.store-list {
  max-height: 56vh;
}
.store-item {
  padding: 22rpx 20rpx;
  border-radius: 14rpx;
  border-bottom: 2rpx solid var(--line);
}
.store-item--on {
  background: var(--brand-soft);
}
.store-item-name {
  font-size: 29rpx;
  font-weight: 500;
}
.store-item--on .store-item-name {
  color: var(--brand);
}
.store-item-sub {
  margin-top: 6rpx;
  font-size: 22rpx;
}
</style>
