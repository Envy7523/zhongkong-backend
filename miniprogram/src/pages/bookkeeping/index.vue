<template>
  <view class="ledger-page">
    <view class="page-heading"><view><text class="eyebrow">门店账目</text><view class="page-title">记账本</view></view><text class="read-tag">查询明细</text></view>
    <view v-if="denied" class="state-card">当前人员未开通记账本权限，请联系管理员。</view>
    <template v-else>
      <view class="filter-card">
        <text class="label">查看门店</text>
        <picker :range="storeChoices" range-key="store_name" :value="storeIndex" :disabled="loading" @change="storeIndex = Number($event.detail.value)"><view class="store-select"><text>{{ storeChoices[storeIndex]?.store_name || '加载门店中…' }}</text><text class="picker-arrow">⌄</text></view></picker>
        <view class="presets"><button v-for="p in presets" :key="p.key" :class="{ selected: period === p.key }" :disabled="loading" @tap="setPeriod(p.key)">{{ p.label }}</button></view>
        <view class="date-range"><view><text class="label">{{ period === 'day' ? '查询日期' : '开始日期' }}</text><picker mode="date" :value="from" :disabled="loading" @change="pickDate('from', $event.detail.value)"><view class="date-field">{{ from }}</view></picker></view><view v-if="period !== 'day'"><text class="label">结束日期</text><picker mode="date" :value="to" :disabled="loading" @change="pickDate('to', $event.detail.value)"><view class="date-field">{{ to }}</view></picker></view></view>
        <view class="secondary-filters"><view><text class="label">记账分类</text><picker :range="categoryChoices" :value="categoryIndex" :disabled="loading" @change="categoryIndex = Number($event.detail.value)"><view class="date-field">{{ categoryChoices[categoryIndex] || '全部分类' }}</view></picker></view><view><text class="label">明细搜索</text><input v-model="keyword" :disabled="loading" class="search-field" placeholder="备注、项目或记账人" maxlength="100" confirm-type="search" @confirm="query" /></view></view>
        <button class="query-button" :disabled="loading || !storeChoices.length" @tap="query">{{ loading ? '查询中…' : '查询记账明细' }}</button>
        <view v-if="latestDate" class="latest-note">最近有记账：{{ latestDate }}<text v-if="from !== latestDate || to !== latestDate" @tap="latest">查看该日</text></view>
      </view>
      <view v-if="error" class="state-card error"><text>{{ error }}</text><button :disabled="loading" @tap="query">重新查询</button></view>
      <view v-if="result" class="results">
        <view class="summary-card"><view class="summary-top"><text>记账金额合计</text><text>{{ appliedStore }}</text></view><view class="amount"><text class="currency">¥</text>{{ money(result.summary.amount) }}</view><text class="summary-period">{{ result.date_from }}{{ result.date_from === result.date_to ? '' : ' 至 ' + result.date_to }}</text><view class="summary-meta"><text>{{ result.summary.count }} 笔明细</text><text>{{ result.summary.store_count }} 家门店</text><text>{{ result.summary.day_count }} 个记账日</text></view></view>
        <view class="view-tabs"><button v-for="v in views" :key="v.key" :class="{ active: view === v.key }" @tap="view = v.key">{{ v.label }}</button></view>
        <view v-if="!result.total" class="state-card"><view class="empty-title">这个范围暂无记账</view><text>调整门店或日期重新查询，或查看最近有记账的一天。</text></view>
        <template v-else-if="view === 'entries'">
          <view v-for="(entry, index) in rows" :key="entry.id">
            <view v-if="index === 0 || rows[index - 1].date !== entry.date" class="day-label">{{ entry.date }}</view>
            <view class="entry-card" @tap="expanded = expanded === entry.id ? null : entry.id"><view class="entry-top"><view class="entry-heading">{{ entry.subcategory_name || entry.category_name || '未分类项目' }}</view><text class="entry-amount">¥{{ money(entry.amount) }}</text></view><view class="entry-meta"><text>{{ entry.store_name || '门店 #' + entry.store_id }}</text><text>{{ entry.category_name || '未分类' }}</text></view><view v-if="entry.remark" class="remark">{{ entry.remark }}</view><view class="entry-foot"><text>{{ entry.user_name || '未记录记账人' }}</text><text>{{ expanded === entry.id ? '收起' : '更多信息' }} {{ expanded === entry.id ? '⌃' : '⌄' }}</text></view><view v-if="expanded === entry.id" class="entry-detail"><text>流水编号：{{ entry.id }}</text><text>记账日期：{{ entry.date }}</text><text>录入时间：{{ entry.created_at || '未记录' }}</text></view></view>
          </view>
          <button class="load-more" :disabled="loading || rows.length >= result.total" @tap="loadMore">{{ loading ? '加载中…' : rows.length >= result.total ? `已显示全部 ${result.total} 笔` : `加载更多（已显示 ${rows.length} / ${result.total}）` }}</button>
        </template>
        <view v-else class="group-card"><view v-for="(group, index) in (view === 'categories' ? result.categories : result.stores)" :key="view === 'categories' ? group.name : group.store_id" class="group-row"><text class="rank">{{ index + 1 }}</text><view class="group-info"><view>{{ view === 'categories' ? group.name || '未分类' : group.store_name || '门店 #' + group.store_id }}</view><text>{{ group.count }} 笔记账</text></view><text class="group-amount">¥{{ money(group.amount) }}</text></view></view>
        <view class="result-note">汇总按当前查询条件计算，包含全部分页明细；金额沿用后台记账口径。</view>
      </view>
      <view v-else-if="loading" class="state-card">正在加载记账数据…</view>
    </template>
  </view>
</template>
<script setup>
import { ref, computed } from 'vue'
import { onLoad, onPullDownRefresh, onReachBottom } from '@dcloudio/uni-app'
import api from '../../common/api'
import { getToken, getUser } from '../../common/request'
import { money, localDate, periodRange } from '../../common/format'
const presets = [{ key: 'day', label: '单日' }, { key: 'week', label: '本周' }, { key: 'month', label: '本月' }, { key: 'custom', label: '自定义' }]
const views = [{ key: 'entries', label: '流水明细' }, { key: 'categories', label: '分类汇总' }, { key: 'stores', label: '门店汇总' }]
const denied = ref(false), loading = ref(false), error = ref(''), stores = ref([]), allowAll = ref(false)
const storeIndex = ref(0), categoryIndex = ref(0), categories = ref([]), keyword = ref(''), latestDate = ref('')
const from = ref(localDate()), to = ref(localDate()), period = ref('day'), view = ref('entries')
const result = ref(null), rows = ref([]), expanded = ref(null), appliedStore = ref(''), applied = ref(null)
const storeChoices = computed(() => allowAll.value ? [{ id: '', store_name: '全部授权门店' }, ...stores.value] : stores.value)
const categoryChoices = computed(() => ['全部分类', ...categories.value.map(c => c.name)])
function setPeriod(key) {
  period.value = key
  if (key === 'custom') return
  const range = periodRange(key, localDate())
  from.value = range.from; to.value = range.to
  query()
}
function pickDate(field, value) {
  if (field === 'from') from.value = value
  else to.value = value
  if (period.value === 'day') to.value = from.value
  else period.value = 'custom'
}
function latest() {
  if (loading.value) return
  from.value = to.value = latestDate.value; period.value = 'day'; query()
}
async function initialize() {
  if (!getToken()) { uni.reLaunch({ url: '/pages/login/login' }); return }
  loading.value = true; error.value = ''
  try {
    const current = (await api.me()).user
    denied.value = !(current.position_permissions || []).some(p => p === '*' || p === 'bookkeeping.manage')
    if (denied.value) return
    allowAll.value = current.store_id === null || current.store_id === undefined
    const data = await api.bookkeepingOptions()
    stores.value = data.stores || []; categories.value = data.categories || []; latestDate.value = data.latest_date || ''
    if (latestDate.value) from.value = to.value = latestDate.value
  } catch (e) { error.value = e.message }
  finally { loading.value = false }
  if (!denied.value && !error.value) await query()
}
async function query() {
  if (loading.value || denied.value) return
  if (!storeChoices.value.length) { error.value = '当前人员没有可查询的门店'; return }
  if (from.value > to.value) { error.value = '开始日期不能晚于结束日期'; return }
  const selected = storeChoices.value[storeIndex.value]
  loading.value = true; error.value = ''; result.value = null; rows.value = []; expanded.value = null
  const params = { store_id: selected?.id, date_from: from.value, date_to: to.value, category: categoryIndex.value ? categoryChoices.value[categoryIndex.value] : '', keyword: keyword.value.trim(), page_size: 30 }
  try {
    const data = await api.bookkeepingList({ ...params, page: 1 })
    result.value = data; rows.value = data.entries || []; applied.value = params; appliedStore.value = selected?.store_name || ''
  } catch (e) { error.value = e.message }
  finally { loading.value = false }
}
async function loadMore() {
  if (loading.value || !result.value || rows.value.length >= result.value.total) return
  loading.value = true
  try {
    const data = await api.bookkeepingList({ ...applied.value, page: result.value.page + 1 })
    const seen = new Set(rows.value.map(e => e.id)); rows.value.push(...(data.entries || []).filter(e => !seen.has(e.id)))
    result.value.page = data.page
  } catch (e) { error.value = e.message }
  finally { loading.value = false }
}
onLoad(initialize)
onPullDownRefresh(async () => { if (!stores.value.length) await initialize(); else await query(); uni.stopPullDownRefresh() })
onReachBottom(() => { if (view.value === 'entries') loadMore() })
</script>
<style scoped>
.ledger-page { padding: 28rpx 24rpx 44rpx; }.page-heading { display: flex; justify-content: space-between; align-items: center; margin: 12rpx 8rpx 28rpx; }.eyebrow { color: var(--brand); font-size: 24rpx; font-weight: 600; }.page-title { font-size: 44rpx; font-weight: 700; margin-top: 8rpx; }.read-tag { color: var(--text-2); font-size: 24rpx; padding: 8rpx 18rpx; border: 1rpx solid var(--line); border-radius: 24rpx; }
.filter-card { padding: 28rpx; background: white; border-radius: 24rpx; }.label { display: block; font-size: 24rpx; color: var(--text-2); margin-bottom: 10rpx; }.store-select { display: flex; justify-content: space-between; align-items: center; font-size: 30rpx; font-weight: 600; min-height: 88rpx; background: #f6f7f9; padding: 0 22rpx; border-radius: 14rpx; }.picker-arrow { margin-left: 12rpx; color: var(--brand); }.presets { display: flex; gap: 10rpx; margin: 24rpx 0; }.presets button { flex: 1; padding: 0; background: #f5f6f8; font-size: 26rpx; line-height: 88rpx; color: var(--text-2); margin: 0; border-radius: 14rpx; }.presets .selected { background: var(--brand-soft); color: var(--brand); font-weight: 600; }
.date-range,.secondary-filters { display: flex; gap: 18rpx; }.date-range > view,.secondary-filters > view { flex: 1; min-width: 0; }.secondary-filters { margin-top: 22rpx; }.date-field,.search-field { height: 88rpx; line-height: 88rpx; padding: 0 18rpx; background: #f6f7f9; border-radius: 14rpx; font-size: 26rpx; }.search-field { box-sizing: border-box; }.query-button { background: var(--brand); color: white; margin-top: 26rpx; font-size: 28rpx; line-height: 88rpx; border-radius: 16rpx; }.query-button[disabled] { opacity: .5; }.latest-note { display: flex; align-items: center; justify-content: space-between; font-size: 24rpx; color: var(--text-2); margin-top: 16rpx; }.latest-note text { color: var(--brand); padding: 16rpx 4rpx; }
.summary-card { background: #28382f; color: white; border-radius: 24rpx; padding: 30rpx; margin-top: 24rpx; }.summary-top { display: flex; justify-content: space-between; font-size: 24rpx; gap: 16rpx; }.summary-top text:last-child { text-align: right; max-width: 60%; }.amount { font-size: 56rpx; font-weight: 700; margin: 18rpx 0 8rpx; font-variant-numeric: tabular-nums; word-break: break-all; }.currency { font-size: 30rpx; margin-right: 10rpx; }.summary-period { font-size: 24rpx; color: #e0e8e3; }.summary-meta { display: flex; gap: 26rpx; padding-top: 22rpx; margin-top: 24rpx; border-top: 1rpx solid #526057; font-size: 24rpx; flex-wrap: wrap; }
.view-tabs { display: flex; padding: 8rpx; background: #e9ecf0; border-radius: 16rpx; margin: 28rpx 0 18rpx; }.view-tabs button { flex: 1; margin: 0; font-size: 26rpx; padding: 0; line-height: 88rpx; background: transparent; color: var(--text-2); border-radius: 12rpx; }.view-tabs .active { background: white; color: var(--brand); font-weight: 600; }
.day-label { padding: 22rpx 8rpx 16rpx; font-weight: 600; font-size: 26rpx; }.entry-card { padding: 26rpx; background: white; border-radius: 20rpx; margin-bottom: 16rpx; }.entry-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16rpx; }.entry-heading { font-weight: 600; font-size: 30rpx; flex: 1; min-width: 0; word-break: break-all; }.entry-amount { font-size: 30rpx; font-weight: 600; font-variant-numeric: tabular-nums; flex-shrink: 0; }.entry-meta { display: flex; gap: 14rpx; font-size: 24rpx; color: var(--text-2); margin-top: 14rpx; flex-wrap: wrap; }.entry-meta text:last-child { color: var(--brand); }.remark { background: #f6f7f9; padding: 16rpx; margin-top: 18rpx; border-radius: 12rpx; font-size: 26rpx; color: var(--text-2); word-break: break-all; white-space: pre-wrap; }.entry-foot { display: flex; justify-content: space-between; font-size: 24rpx; color: var(--text-2); margin-top: 22rpx; }.entry-detail { border-top: 1rpx solid var(--line); margin-top: 20rpx; padding-top: 20rpx; display: flex; flex-direction: column; gap: 12rpx; font-size: 24rpx; color: var(--text-2); }
.load-more { background: transparent; color: var(--text-2); font-size: 26rpx; line-height: 88rpx; margin: 16rpx 0; }.group-card { background: white; padding: 0 24rpx; border-radius: 20rpx; }.group-row { display: flex; align-items: center; gap: 18rpx; padding: 28rpx 0; border-bottom: 1rpx solid var(--line); }.group-row:last-child { border: none; }.rank { width: 36rpx; color: var(--text-2); font-size: 24rpx; }.group-info { flex: 1; min-width: 0; font-size: 28rpx; }.group-info text { font-size: 24rpx; color: var(--text-2); }.group-amount { font-size: 28rpx; font-weight: 600; }.result-note { font-size: 24rpx; color: var(--text-2); padding: 24rpx 8rpx; line-height: 1.8; }.state-card { margin-top: 24rpx; padding: 38rpx 28rpx; background: white; border-radius: 20rpx; color: var(--text-2); font-size: 26rpx; line-height: 1.8; }.empty-title { font-weight: 600; font-size: 30rpx; color: var(--text-1); margin-bottom: 12rpx; }.error { color: #a33320; background: #fff0ed; }.error button { font-size: 26rpx; margin-top: 20rpx; }button::after { border: none; }
</style>
