<template>
  <div class="channel-analytics-page" :class="scopeClass">
    <AnalysisPerspectiveNav />
    <AnalysisSectionNav />
    <section class="channel-hero">
      <div>
        <span class="eyebrow">{{ heroEyebrow }}</span>
        <h2>{{ scopeLabel }}经营视角</h2>
        <p>仅展示门店总收入、{{ scopeLabel }}收入与占比，不包含其他渠道的收入明细。</p>
      </div>
      <el-button plain @click="loadData"><el-icon><Refresh /></el-icon>刷新数据</el-button>
    </section>

    <section class="filter-bar">
      <div class="period-switch">
        <button v-for="item in periods" :key="item.value" :class="{ active: filters.period === item.value }" @click="changePeriod(item.value)">{{ item.label }}视角</button>
      </div>
      <el-select v-model="filters.store_id" clearable filterable placeholder="全部门店" style="width:220px" @change="loadData">
        <el-option v-for="store in stores" :key="store.id" :label="store.store_name" :value="store.id" />
      </el-select>
      <el-date-picker v-model="filters.range" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" @change="loadData" />
      <span class="range-label"><i></i>{{ rangeLabel }}</span>
    </section>

    <section class="metrics" v-loading="loading">
      <article class="metric total">
        <span>门店总收入</span>
        <strong>{{ money(data.totals.store_total) }}</strong>
        <small>统一确认口径的全部营业实收</small>
      </article>
      <article class="metric channel">
        <span>{{ scopeLabel }}收入</span>
        <strong>{{ money(data.totals.scope_income) }}</strong>
        <small>{{ scopeHint }}</small>
      </article>
      <article class="metric ratio">
        <span>{{ scopeLabel }}收入占比</span>
        <strong>{{ percent(data.totals.scope_ratio) }}</strong>
        <el-progress :percentage="Math.round((data.totals.scope_ratio || 0) * 100)" :show-text="false" :stroke-width="7" />
        <small>{{ scopeLabel }}收入 ÷ 门店总收入</small>
      </article>
      <article class="metric promotion">
        <span>第三方推广费</span>
        <strong>{{ money(promotionTotal) }}</strong>
        <small>按门店、按平台归集，不跨门店分摊</small>
      </article>
    </section>

    <section class="content-grid">
      <article class="panel trend-panel">
        <header><div><h3>收入趋势</h3><p>门店总收入与{{ scopeLabel }}收入对比</p></div><span>{{ periodText }}度趋势</span></header>
        <div v-if="data.trend.length" ref="trendRef" class="trend-chart"></div>
        <el-empty v-else :description="`暂无${scopeLabel}营业数据`" />
      </article>

      <article class="panel ranking-panel">
        <header><div><h3>门店{{ scopeLabel }}表现</h3><p>按{{ scopeLabel }}收入从高到低排序</p></div></header>
        <el-table v-if="data.stores.length" :data="data.stores" height="382" size="small">
          <el-table-column type="index" width="48" label="#" />
          <el-table-column prop="store_name" label="门店" min-width="150" show-overflow-tooltip />
          <el-table-column label="总收入" width="118" align="right"><template #default="{ row }">{{ money(row.store_total) }}</template></el-table-column>
          <el-table-column :label="`${scopeLabel}收入`" width="118" align="right"><template #default="{ row }"><b class="channel-value">{{ money(row.scope_income) }}</b></template></el-table-column>
          <el-table-column label="占比" width="82" align="right"><template #default="{ row }">{{ percent(row.scope_ratio) }}</template></el-table-column>
        </el-table>
        <el-empty v-else :description="`暂无门店${scopeLabel}数据`" />
      </article>
    </section>

    <section class="panel promotion-panel">
      <header>
        <div><h3>门店平台费用明细</h3><p>{{ platformHint }}；推广费按门店和平台独立统计</p></div>
        <span>{{ data.platform_breakdown.length }} 条</span>
      </header>
      <el-table v-if="data.platform_breakdown.length" :data="data.platform_breakdown" stripe>
        <el-table-column prop="store_name" label="门店" min-width="160" show-overflow-tooltip />
        <el-table-column prop="platform" label="平台" width="130" />
        <el-table-column label="交易总额" width="125" align="right"><template #default="{ row }">{{ money(row.gross_amount) }}</template></el-table-column>
        <el-table-column label="推广费" width="120" align="right"><template #default="{ row }"><b class="promotion-value">{{ money(row.promotion_fee) }}</b></template></el-table-column>
        <el-table-column label="其他费用" width="120" align="right"><template #default="{ row }">{{ money(row.other_fees) }}</template></el-table-column>
        <el-table-column label="平台实收" width="125" align="right"><template #default="{ row }">{{ money(row.actual_amount) }}</template></el-table-column>
        <el-table-column prop="order_count" label="订单数" width="90" align="right" />
      </el-table>
      <el-empty v-else :description="`暂无${scopeLabel}平台费用数据`" />
    </section>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import * as echarts from 'echarts'
import { Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { getBusinessAnalytics, getStores } from '@/api'
import AnalysisPerspectiveNav from './AnalysisPerspectiveNav.vue'
import AnalysisSectionNav from './AnalysisSectionNav.vue'

const route = useRoute()
const periods = [{ label: '日', value: 'day' }, { label: '周', value: 'week' }, { label: '月', value: 'month' }]
const stores = ref([])
const loading = ref(false)
const trendRef = ref()
const filters = reactive({ period: 'day', store_id: null, range: [] })
const data = reactive({ totals: {}, trend: [], stores: [], platform_breakdown: [] })
let chart

const routeScope = computed(() => route.meta.analyticsScope === 'delivery' ? 'delivery' : 'group-buy')
const scopeLabel = computed(() => routeScope.value === 'delivery' ? '外卖' : '团购')
const scopeClass = computed(() => `scope-${routeScope.value}`)
const heroEyebrow = computed(() => routeScope.value === 'delivery' ? 'DELIVERY PERFORMANCE' : 'GROUP BUY PERFORMANCE')
const scopeHint = computed(() => routeScope.value === 'delivery' ? '美团外卖、淘宝闪购、京东外卖' : '美团团购、抖音团购、免费试')
const platformHint = computed(() => routeScope.value === 'delivery' ? '美团外卖 / 淘宝闪购 / 京东外卖' : '美团团购 / 抖音团购 / 免费试')
const promotionTotal = computed(() => data.platform_breakdown.reduce((sum, row) => sum + Number(row.promotion_fee || 0), 0))
const periodText = computed(() => ({ day: '日', week: '周', month: '月' }[filters.period]))
const rangeLabel = computed(() => filters.range?.length === 2 ? `${filters.range[0]} 至 ${filters.range[1]}` : '全部营业周期')

function money(value) { return `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }
function percent(value) { return `${(Number(value || 0) * 100).toFixed(1)}%` }
function changePeriod(period) { filters.period = period; loadData() }

async function loadData() {
  loading.value = true
  try {
    const result = await getBusinessAnalytics(routeScope.value, { period: filters.period, store_id: filters.store_id || undefined, date_from: filters.range?.[0], date_to: filters.range?.[1] })
    Object.assign(data, result)
    await nextTick()
    renderChart()
  } catch (error) { ElMessage.error(error.message) }
  finally { loading.value = false }
}

function renderChart() {
  if (!trendRef.value || !data.trend.length) return
  chart ||= echarts.init(trendRef.value)
  const channelColor = routeScope.value === 'delivery' ? '#0ea5a4' : '#8b5cf6'
  chart.setOption({
    color: ['#b9c5d8', channelColor],
    tooltip: { trigger: 'axis', valueFormatter: value => money(value) },
    legend: { top: 2, right: 8, itemWidth: 16, itemHeight: 7, textStyle: { color: '#69758a' } },
    grid: { left: 14, right: 16, top: 44, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: data.trend.map(item => item.period), axisTick: { show: false }, axisLine: { lineStyle: { color: '#e1e6ee' } }, axisLabel: { color: '#8a94a6' } },
    yAxis: { type: 'value', axisLabel: { color: '#8a94a6', formatter: value => value >= 10000 ? `${(value / 10000).toFixed(1)}万` : value }, splitLine: { lineStyle: { color: '#edf1f6', type: 'dashed' } } },
    series: [
      { name: '门店总收入', type: 'line', smooth: true, symbol: 'none', lineStyle: { width: 2 }, areaStyle: { opacity: .08 }, data: data.trend.map(item => item.store_total) },
      { name: `${scopeLabel.value}收入`, type: 'bar', barMaxWidth: 28, itemStyle: { borderRadius: [5, 5, 0, 0] }, data: data.trend.map(item => item.scope_income) },
    ],
  }, true)
}

function resizeChart() { chart?.resize() }
watch(() => route.fullPath, async () => { chart?.dispose(); chart = null; Object.assign(data, { totals: {}, trend: [], stores: [], platform_breakdown: [] }); await loadData() })
onMounted(async () => { const result = await getStores({ page: 1, pageSize: 200 }).catch(() => ({ stores: [] })); stores.value = result.stores || []; await loadData(); window.addEventListener('resize', resizeChart) })
onBeforeUnmount(() => { chart?.dispose(); window.removeEventListener('resize', resizeChart) })
</script>

<style scoped>
.channel-analytics-page{--accent:#8b5cf6;--accent-soft:#f3efff;--ink:#172033;--muted:#78849a;--line:#e6eaf0;color:var(--ink)}.channel-analytics-page.scope-delivery{--accent:#0d9488;--accent-soft:#ecfdf9}
.channel-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:16px;padding:28px 30px;border-radius:18px;color:#fff;background:radial-gradient(circle at 90% 0,rgba(255,255,255,.18),transparent 34%),linear-gradient(125deg,#222b55 0%,var(--accent) 100%);box-shadow:0 16px 36px color-mix(in srgb,var(--accent) 22%,transparent)}.channel-hero .eyebrow{color:rgba(255,255,255,.7);font-size:10px;font-weight:800;letter-spacing:.18em}.channel-hero h2{margin:7px 0 6px;font-size:27px}.channel-hero p{margin:0;color:rgba(255,255,255,.75);font-size:13px}.channel-hero :deep(.el-button){border-color:rgba(255,255,255,.3);background:rgba(255,255,255,.12);color:#fff}
.filter-bar{display:flex;align-items:center;gap:12px;margin-bottom:16px;padding:12px 14px;border:1px solid var(--line);border-radius:14px;background:#fff;box-shadow:0 6px 18px rgba(33,48,78,.05)}.period-switch{display:flex;padding:3px;border-radius:9px;background:#f1f4f8}.period-switch button{min-width:68px;height:32px;border:0;border-radius:7px;background:transparent;color:#69758a;cursor:pointer}.period-switch button.active{background:#fff;color:var(--accent);font-weight:700;box-shadow:0 2px 7px rgba(32,48,78,.12)}.range-label{display:flex;align-items:center;gap:7px;margin-left:auto;color:#7c8799;font-size:11px;white-space:nowrap}.range-label i{width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:14px}.metric{min-height:142px;padding:20px;border:1px solid var(--line);border-radius:15px;background:#fff;box-shadow:0 7px 21px rgba(33,48,78,.055)}.metric span,.metric small{display:block}.metric span{font-size:12px;font-weight:700}.metric strong{display:block;margin:18px 0 13px;font-size:25px}.metric small{color:#929cad;font-size:10px}.metric.total{background:linear-gradient(145deg,#fff,#f7f9fc)}.metric.channel{border-color:color-mix(in srgb,var(--accent) 35%,#e6eaf0);background:linear-gradient(145deg,#fff,var(--accent-soft))}.metric.channel strong,.metric.ratio strong,.channel-value{color:var(--accent)}.metric.promotion strong,.promotion-value{color:#d97706}.metric.ratio :deep(.el-progress){margin:-3px 0 13px}.metric.ratio :deep(.el-progress-bar__inner){background:var(--accent)}
.content-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(430px,1fr);gap:14px}.panel{overflow:hidden;min-height:450px;border:1px solid var(--line);border-radius:15px;background:#fff;box-shadow:0 7px 22px rgba(33,48,78,.055)}.panel>header{display:flex;align-items:center;justify-content:space-between;padding:17px 19px;border-bottom:1px solid #edf0f4}.panel h3{margin:0;font-size:14px}.panel header p{margin:4px 0 0;color:#929cad;font-size:10px}.panel header>span{padding:5px 9px;border-radius:20px;background:var(--accent-soft);color:var(--accent);font-size:10px}.trend-chart{height:390px}.ranking-panel :deep(.el-table){padding:7px 12px 12px}.promotion-panel{min-height:220px;margin-top:14px}.promotion-panel :deep(.el-table){padding:7px 12px 12px}
@media(max-width:1180px){.metrics{grid-template-columns:repeat(2,1fr)}}
@media(max-width:1050px){.content-grid{grid-template-columns:1fr}.panel{min-height:390px}.promotion-panel{min-height:220px}}
@media(max-width:760px){.channel-hero{align-items:flex-start;flex-direction:column;padding:22px 20px}.filter-bar{align-items:stretch;flex-wrap:wrap}.range-label{width:100%;margin-left:0}.metrics{grid-template-columns:1fr}.period-switch{width:100%}.period-switch button{flex:1}}
</style>
