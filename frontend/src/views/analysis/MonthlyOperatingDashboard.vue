<template>
  <main class="monthly-board-page">
    <section class="board-hero">
      <div>
        <span class="eyebrow">MONTHLY OPERATING BOARD</span>
        <h2>{{ queried ? `${board.store_name} · 月经营数据看板` : '月经营数据看板' }}</h2>
        <p>按记账本展示现金收支，或按日应计成本观察真实经营盈亏。</p>
      </div>
      <div class="update-text"><span>最近查询时间</span><b>{{ queriedAt || '尚未查询' }}</b></div>
    </section>

    <section class="query-card">
      <div class="query-field"><span>选择月份</span><el-date-picker v-model="filters.month" :clearable="false" type="month" value-format="YYYY-MM" placeholder="选择月份" /></div>
      <div class="query-field"><span>截止日期</span><el-date-picker v-model="filters.asOf" :clearable="false" type="date" value-format="YYYY-MM-DD" placeholder="选择时间" /></div>
      <div class="query-field store-select"><span>选择门店</span><StoreRegionSelect v-model="filters.storeIds" :stores="stores" multiple placeholder="全部门店或按区域勾选" /></div>
      <div class="query-field view-select"><span>数据口径</span><el-radio-group v-model="filters.view"><el-radio-button label="cash">现金收支</el-radio-button><el-radio-button label="accrual">经营盈亏</el-radio-button></el-radio-group></div>
      <div class="query-field revenue-view-select"><span>收入数据视角</span><el-radio-group v-model="filters.dataView"><el-radio-button label="cashier">收银机</el-radio-button><el-radio-button label="real">真实数据</el-radio-button></el-radio-group></div>
      <el-button v-if="filters.dataView === 'real'" class="platform-source-button" @click="sourceDialogVisible = true">平台来源 · {{ platformSourceSummary }}</el-button>
      <el-button type="primary" :loading="loading" @click="queryBoard">查询看板</el-button>
    </section>

    <template v-if="queried">
      <section class="revenue-source-panel"><div><span>REVENUE SOURCE</span><h3>{{ board.revenue_source?.view === 'cashier' ? '收银机视角' : '真实数据视角' }}</h3><p>{{ board.revenue_source?.view === 'cashier' ? '全部销售渠道按收银机原始数据计算。' : '店内销售与自提来自收银机；第三方渠道按当前平台来源设置解析。' }}</p></div><div class="revenue-source-metrics"><article><span>销售营业额</span><b>{{ money(board.revenue_source?.gross_amount) }}</b></article><article><span>优惠后收入</span><b>{{ money(board.revenue_source?.income_amount) }}</b></article><article><span>平台费用</span><b class="fee">{{ money(board.revenue_source?.platform_fee_amount) }}</b></article><article><span>实际到账</span><b>{{ money(board.revenue_source?.settled_amount) }}</b></article></div></section>
      <section v-if="isAccrual" class="daily-cost-panel">
        <header>
          <div><span>DAILY ACCRUED COST</span><h3>每日均摊成本</h3><p>固定由工资、房租/物业、水电构成；每个项目可独立设置来源，按本月 {{ board.period.days_in_month }} 天均摊。</p></div>
          <small class="cost-source-tip">调整后需点击“查询看板”重新计算</small>
        </header>
        <div class="daily-cost-grid">
          <article v-for="cost in board.accrual_costs" :key="cost.key" :class="`cost-${cost.key}`">
            <div><span>{{ cost.name }}</span><el-button text size="small" @click="openCostSourceDialog(cost.key)">调整来源</el-button></div>
            <b>{{ money(cost.daily_amount) }}<small>/日</small></b>
            <p>月度基数 {{ money(cost.monthly_basis) }} · 已摊销 {{ money(cost.cumulative_amount) }}</p>
            <em>{{ cost.source }}</em>
          </article>
        </div>
      </section>

      <section class="tables-grid">
        <article class="board-panel expense-panel">
          <header><div><h3>{{ isAccrual ? '经营成本构成' : '现金支出构成' }}</h3><p>{{ isAccrual ? '含日应计成本；非固定类按实际记账日' : '严格按记账本实际记账日期' }}</p></div><span>{{ expenseChildCount }} 个明细</span></header>
          <el-table :data="board.expense_rows" :row-class-name="tableRowClass" size="small" max-height="610" stripe>
            <el-table-column label="支出项目" min-width="190"><template #default="{ row }"><b v-if="row.is_group">{{ row.category }}</b><span v-else class="child-name">{{ row.subcategory }}</span></template></el-table-column>
            <el-table-column label="当日支出" min-width="112" align="right"><template #default="{ row }">{{ money(row.daily_amount) }}</template></el-table-column>
            <el-table-column label="当日占比" width="92" align="right"><template #default="{ row }">{{ percent(rate(row.daily_amount, board.totals.daily_expense)) }}</template></el-table-column>
            <el-table-column label="截至当日" min-width="120" align="right"><template #default="{ row }">{{ money(row.cumulative_amount) }}</template></el-table-column>
            <el-table-column label="本月累计占比" width="112" align="right"><template #default="{ row }">{{ percent(rate(row.cumulative_amount, board.totals.cumulative_expense)) }}</template></el-table-column>
          </el-table>
        </article>

        <article class="board-panel income-panel">
          <header><div><h3>收入构成</h3><p>{{ board.period.cutoff }} 当日与本月累计收入；会员储值独立展示，不计入总收入</p></div><span>{{ incomeChildCount }} 个收入明细</span></header>
          <el-table :data="incomeCompositionRows" :row-class-name="tableRowClass" size="small" max-height="610" stripe>
            <el-table-column label="收入项目" min-width="210"><template #default="{ row }"><b v-if="row.is_group">{{ row.category }}<small v-if="row.is_stored" class="stored-exclusion">不计入总收入</small></b><span v-else class="child-name">{{ row.subcategory }}<small v-if="row.source_label" class="income-source">{{ row.source_label }}</small></span></template></el-table-column>
            <el-table-column label="当日收入" min-width="112" align="right"><template #default="{ row }">{{ money(row.daily_amount) }}</template></el-table-column>
            <el-table-column label="当日占比" width="92" align="right"><template #default="{ row }">{{ row.is_stored ? '—' : percent(rate(row.daily_amount, board.totals.daily_income)) }}</template></el-table-column>
            <el-table-column label="本月累计收入" min-width="125" align="right"><template #default="{ row }">{{ money(row.cumulative_amount) }}</template></el-table-column>
            <el-table-column label="累计收入占比" width="112" align="right"><template #default="{ row }">{{ row.is_stored ? '—' : percent(rate(row.cumulative_amount, board.totals.cumulative_income)) }}</template></el-table-column>
          </el-table>
        </article>
      </section>

      <section class="metric-section">
        <h3>{{ isAccrual ? '经营盈亏汇总' : '现金收支汇总' }}</h3>
        <div class="metric-grid">
          <el-tooltip v-for="metric in summaryMetrics" :key="metric.key" effect="light" placement="top-start" :show-after="160" popper-class="metric-breakdown-tooltip">
            <template #content>
              <div class="metric-breakdown">
                <strong>{{ metric.label }} · 计算构成</strong>
                <p>{{ metric.formula }}</p>
                <div v-for="item in metric.items" :key="item.name" class="breakdown-line"><span>{{ item.name }}</span><b>{{ money(item.amount) }}</b></div>
                <div v-if="!metric.items.length" class="breakdown-empty">当前时间范围内暂无构成记录</div>
                <footer>合计 <b>{{ metric.absolute ? money(metric.amount) : signedMoney(metric.amount) }}</b></footer>
              </div>
            </template>
            <article class="summary-card has-breakdown" :class="metric.tone" tabindex="0">
              <span>{{ metric.label }}<i>查看构成</i></span><b>{{ metric.absolute ? money(metric.amount) : signedMoney(metric.amount) }}</b><small>{{ metric.footnote }}</small>
            </article>
          </el-tooltip>
        </div>
      </section>

      <section class="trend-grid">
        <article class="trend-panel">
          <header><div><h3>本月每日门店{{ isAccrual ? '盈亏' : '现金收支' }}</h3><p>{{ isAccrual ? '当日收入 - 当日经营成本（含日应计成本）' : '当日实际收入 - 当日实际支出' }}</p></div><span>柱状图</span></header>
          <div ref="dailyProfitChartRef" class="trend-chart"></div>
        </article>
        <article class="trend-panel">
          <header><div><h3>本月门店{{ isAccrual ? '盈利' : '现金结余' }}总进度</h3><p>每日净收支累计形成的本月走势</p></div><span>折线图</span></header>
          <div ref="cumulativeProfitChartRef" class="trend-chart"></div>
        </article>
      </section>
    </template>

    <el-empty v-else description="请选择月份、截止日期和门店后查询月经营数据看板" :image-size="120" class="board-empty" />

    <el-dialog v-model="costSourceDialogVisible" :title="`调整${costSourceTargetLabel}来源`" width="520px" class="cost-source-dialog" destroy-on-close>
      <p class="dialog-hint">仅调整{{ costSourceTargetLabel }}的取数来源。选择完成后，请点击页面的“查询看板”重新计算。</p>
      <el-radio-group v-model="draftCostSource" class="cost-source-options">
        <el-radio v-for="option in costSourceOptions" :key="option.value" :label="option.value" border>
          <b>{{ option.label }}</b><span>{{ option.description }}</span>
        </el-radio>
      </el-radio-group>
      <template #footer><el-button @click="costSourceDialogVisible = false">取消</el-button><el-button type="primary" @click="applyCostSource">确认选择</el-button></template>
    </el-dialog>

    <el-dialog v-model="sourceDialogVisible" title="真实数据视角 · 平台来源" width="720px" class="source-config-dialog" destroy-on-close>
      <p class="dialog-hint">店内销售与自提固定取收银机；四个可切换平台可选择收银机或第三方。美团团购始终采用第三方收益明细。切换仅影响本次查询结果，不修改任何原始导入数据。</p>
      <div class="platform-source-grid"><article v-for="item in platformSourceOptions" :key="item.key"><div><b>{{ item.label }}</b><span>{{ item.note }}</span></div><el-radio-group v-model="filters.sourceOverrides[item.key]" size="small"><el-radio-button label="platform">第三方</el-radio-button><el-radio-button label="pos">收银机</el-radio-button></el-radio-group></article></div>
      <template #footer><el-button @click="sourceDialogVisible = false">取消</el-button><el-button type="primary" @click="sourceDialogVisible = false; ElMessage.info('平台来源已调整，请点击查询看板重新计算')">确认选择</el-button></template>
    </el-dialog>
  </main>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import * as echarts from 'echarts'
import { ElMessage } from 'element-plus'
import { getMonthlyOperatingDashboard, getStores } from '@/api'
import StoreRegionSelect from '@/components/StoreRegionSelect.vue'

function today() { return new Date().toISOString().slice(0, 10) }
const filters = reactive({ month: today().slice(0, 7), asOf: today(), storeIds: [], view: 'cash', dataView: 'real', sourceOverrides: { meituan_delivery: 'platform', taobao_flash: 'platform', jd_delivery: 'platform', douyin_group: 'platform', meituan_group: 'platform' }, costSources: { wage: 'operating_previous', rent: 'bookkeeping', utilities: 'bookkeeping' } })
const stores = ref([])
const loading = ref(false)
const queried = ref(false)
const queriedAt = ref('')
const costSourceDialogVisible = ref(false)
const sourceDialogVisible = ref(false)
const draftCostSource = ref('operating_previous')
const costSourceTarget = ref('wage')
const dailyProfitChartRef = ref()
const cumulativeProfitChartRef = ref()
const board = reactive({ store_name: '', period: {}, view: 'cash', cost_sources: {}, wage: {}, accrual_costs: [], income_rows: [], expense_rows: [], stored_value_rows: [], daily_profit_series: [], totals: {} })
const isAccrual = computed(() => board.view === 'accrual')
const platformSourceOptions = [
  { key: 'meituan_delivery', label: '美团外卖', note: '美团外卖平台数据' },
  { key: 'taobao_flash', label: '淘宝闪购', note: '闪购日报和账单汇总' },
  { key: 'jd_delivery', label: '京东外卖（京东秒送）', note: '京东平台营业数据' },
  { key: 'douyin_group', label: '抖音团购', note: '抖音团购平台数据' },
  { key: 'meituan_group', label: '美团团购', note: '美团/大众点评团购及支付' },
]
const platformSourceSummary = computed(() => `${platformSourceOptions.filter(item => filters.sourceOverrides[item.key] === 'platform').length}/5 第三方`)
const incomeChildCount = computed(() => board.income_rows.filter(row => !row.is_group).length)
const expenseChildCount = computed(() => board.expense_rows.filter(row => !row.is_group).length)
const incomeCompositionRows = computed(() => [
  ...board.income_rows,
  ...(board.stored_value_rows || []).map(row => ({ ...row, is_stored: true })),
])
const costSourceOptions = [
  { value: 'operating_previous', label: '运营成本 · 上月数据', description: '读取门店管理“运营成本”内上月录入的工资、房租/物业或水电费。' },
  { value: 'operating_current', label: '运营成本 · 本月数据', description: '读取门店管理“运营成本”内本月录入的工资、房租/物业或水电费。' },
  { value: 'bookkeeping', label: '记账本记录数据', description: '汇总当前查询范围内的工资、房租/物业、水电记录作为本月均摊基数。' },
]
const costSourceTargetLabel = computed(() => ({ wage: '工资', rent: '房租/物业', utilities: '水电' }[costSourceTarget.value] || '成本'))
const summaryMetrics = computed(() => {
  const day = board.period.cutoff || '当日'
  const range = board.period.start ? `${board.period.start} 至 ${board.period.cutoff}` : '本期累计'
  const expenseName = isAccrual.value ? '经营成本' : '现金支出'
  const expenseRows = groupBreakdown(board.expense_rows, 'daily_amount')
  const totalExpenseRows = groupBreakdown(board.expense_rows, 'cumulative_amount')
  const incomeRows = groupBreakdown(board.income_rows, 'daily_amount')
  const totalIncomeRows = groupBreakdown(board.income_rows, 'cumulative_amount')
  const storedRows = groupBreakdown(board.stored_value_rows, 'daily_amount')
  const totalStoredRows = groupBreakdown(board.stored_value_rows, 'cumulative_amount')
  return [
    { key: 'daily-expense', tone: 'expense', label: isAccrual.value ? '当日经营成本' : '当日现金支出', amount: Number(board.totals.daily_expense || 0), absolute: true, footnote: day, formula: `${expenseName}各大类合计`, items: expenseRows },
    { key: 'daily-income', tone: 'income', label: '当日总收入', amount: Number(board.totals.daily_income || 0), absolute: true, footnote: day, formula: '销售收入及其他经营收入合计，不含会员储值', items: incomeRows },
    { key: 'daily-net', tone: netClass(board.totals.daily_net), label: isAccrual.value ? '当日经营盈亏' : '当日现金收支', amount: Number(board.totals.daily_net || 0), absolute: false, footnote: '收入 - 支出', formula: `当日总收入 ${money(board.totals.daily_income)} − ${expenseName} ${money(board.totals.daily_expense)}`, items: netBreakdown('daily') },
    { key: 'daily-stored', tone: 'stored', label: '当日储值', amount: Number(board.totals.daily_stored_value || 0), absolute: true, footnote: '会员充值/储值', formula: '会员充值及储值金额，不直接计入经营收入', items: storedRows },
    { key: 'cumulative-expense', tone: 'expense', label: isAccrual.value ? '截至当日经营成本' : '截至当日现金支出', amount: Number(board.totals.cumulative_expense || 0), absolute: true, footnote: range, formula: `${expenseName}各大类累计合计`, items: totalExpenseRows },
    { key: 'cumulative-income', tone: 'income', label: '截至当日总收入', amount: Number(board.totals.cumulative_income || 0), absolute: true, footnote: range, formula: '销售收入及其他经营收入累计，不含会员储值', items: totalIncomeRows },
    { key: 'cumulative-net', tone: netClass(board.totals.cumulative_net), label: isAccrual.value ? '截至当日经营盈亏' : '截至当日现金收支', amount: Number(board.totals.cumulative_net || 0), absolute: false, footnote: '收入 - 支出', formula: `累计总收入 ${money(board.totals.cumulative_income)} − ${expenseName} ${money(board.totals.cumulative_expense)}`, items: netBreakdown('cumulative') },
    { key: 'cumulative-stored', tone: 'stored', label: '当月储值', amount: Number(board.totals.cumulative_stored_value || 0), absolute: true, footnote: `截至 ${day}`, formula: '会员充值及储值累计，不直接计入经营收入', items: totalStoredRows },
  ]
})
let dailyProfitChart
let cumulativeProfitChart

onMounted(async () => {
  try {
    const data = await getStores({ page: 1, page_size: 200 })
    stores.value = data.stores || []
  } catch { ElMessage.error('门店列表加载失败') }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resizeCharts)
  dailyProfitChart?.dispose()
  cumulativeProfitChart?.dispose()
})

async function queryBoard() {
  if (!filters.month || !filters.asOf) return ElMessage.warning('请先选择月份和截止日期')
  loading.value = true
  try {
    const data = await getMonthlyOperatingDashboard({
      month: filters.month, as_of: filters.asOf, store_ids: filters.storeIds.join(',') || undefined, view: filters.view,
      data_view: filters.dataView, source_overrides: JSON.stringify({ ...filters.sourceOverrides, meituan_group: 'platform' }),
      wage_source: filters.costSources.wage, rent_source: filters.costSources.rent, utilities_source: filters.costSources.utilities,
    })
    Object.assign(board, data)
    queried.value = true
    queriedAt.value = new Date().toLocaleString('zh-CN', { hour12: false })
    await nextTick()
    renderCharts()
  } catch (error) {
    ElMessage.error(error.message || '看板查询失败')
  } finally { loading.value = false }
}

function openCostSourceDialog(key) {
  costSourceTarget.value = key
  draftCostSource.value = filters.costSources[key]
  costSourceDialogVisible.value = true
}
function applyCostSource() {
  filters.costSources[costSourceTarget.value] = draftCostSource.value
  costSourceDialogVisible.value = false
  ElMessage.info(`${costSourceTargetLabel.value}来源已调整，请点击“查询看板”重新计算`)
}

function chartInstance(chart, target) {
  if (!target) return null
  if (chart && chart.getDom() !== target) { chart.dispose(); chart = null }
  return chart || echarts.getInstanceByDom(target) || echarts.init(target)
}

function renderCharts() {
  const rows = board.daily_profit_series || []
  dailyProfitChart = chartInstance(dailyProfitChart, dailyProfitChartRef.value)
  cumulativeProfitChart = chartInstance(cumulativeProfitChart, cumulativeProfitChartRef.value)
  if (!dailyProfitChart || !cumulativeProfitChart) return
  const labels = rows.map(row => `${String(row.day).padStart(2, '0')}日`)
  const axisStyle = { color: '#8290a3', fontSize: 11 }
  const grid = { left: 12, right: 18, top: 30, bottom: 14, containLabel: true }
  dailyProfitChart.setOption({
    tooltip: { trigger: 'axis', valueFormatter: value => money(value) },
    grid,
    xAxis: { type: 'category', data: labels, axisTick: { show: false }, axisLine: { lineStyle: { color: '#e8edf4' } }, axisLabel: axisStyle },
    yAxis: { type: 'value', axisLabel: { ...axisStyle, formatter: value => value >= 10000 || value <= -10000 ? `${(value / 10000).toFixed(1)}万` : value }, splitLine: { lineStyle: { color: '#edf1f6', type: 'dashed' } } },
    series: [{ type: 'bar', name: isAccrual.value ? '当日经营盈亏' : '当日现金收支', barMaxWidth: 28, data: rows.map(row => ({ value: row.daily_net, itemStyle: { color: row.daily_net >= 0 ? '#26a269' : '#e45e5a', borderRadius: row.daily_net >= 0 ? [5, 5, 0, 0] : [0, 0, 5, 5] } })) }],
  }, true)
  cumulativeProfitChart.setOption({
    tooltip: { trigger: 'axis', valueFormatter: value => money(value) },
    grid,
    xAxis: { type: 'category', data: labels, axisTick: { show: false }, axisLine: { lineStyle: { color: '#e8edf4' } }, axisLabel: axisStyle },
    yAxis: { type: 'value', axisLabel: { ...axisStyle, formatter: value => value >= 10000 || value <= -10000 ? `${(value / 10000).toFixed(1)}万` : value }, splitLine: { lineStyle: { color: '#edf1f6', type: 'dashed' } } },
    series: [{ type: 'line', name: isAccrual.value ? '累计经营盈亏' : '累计现金结余', smooth: true, symbol: 'circle', symbolSize: 6, data: rows.map(row => row.cumulative_net), lineStyle: { width: 3, color: '#5179e4' }, itemStyle: { color: '#5179e4' }, areaStyle: { color: 'rgba(81,121,228,.16)' } }],
  }, true)
  window.removeEventListener('resize', resizeCharts)
  window.addEventListener('resize', resizeCharts)
}

function resizeCharts() { dailyProfitChart?.resize(); cumulativeProfitChart?.resize() }

function groupBreakdown(rows, field) {
  return (rows || []).filter(row => row.is_group && Number(row[field] || 0)).map(row => ({ name: row.category, amount: Number(row[field] || 0) }))
}
function netBreakdown(scope) {
  const cumulative = scope === 'cumulative'
  return [
    { name: '总收入', amount: Number(cumulative ? board.totals.cumulative_income : board.totals.daily_income) || 0 },
    { name: isAccrual.value ? '经营成本（减）' : '现金支出（减）', amount: -(Number(cumulative ? board.totals.cumulative_expense : board.totals.daily_expense) || 0) },
  ]
}
function rate(value, total) { return Number(total) ? Number(value || 0) / Number(total) : 0 }
function percent(value) { return `${(Number(value || 0) * 100).toFixed(2)}%` }
function money(value) { return `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }
function signedMoney(value) { const number = Number(value || 0); return `${number > 0 ? '+' : number < 0 ? '-' : ''}${money(Math.abs(number))}` }
function tableRowClass({ row }) {
  if (row.is_stored) return row.is_group ? 'dashboard-stored-group-row' : 'dashboard-stored-row'
  return row.is_group ? 'dashboard-group-row' : ''
}
function netClass(value) { return Number(value) >= 0 ? 'positive-net' : 'negative-net' }
</script>

<style scoped>
.monthly-board-page { max-width: 1680px; margin: 0 auto; padding: 24px; color: #182230; }
.board-hero { display:flex; justify-content:space-between; align-items:flex-start; gap:24px; padding:26px 30px; border-radius:18px; color:#fff; background:linear-gradient(120deg,#14345b,#236cb0 68%,#4b9ee7); box-shadow:0 12px 30px rgba(24,72,123,.16); }
.eyebrow { color:#aed8ff; font-size:11px; font-weight:700; letter-spacing:.14em; }
.board-hero h2 { margin:5px 0 7px; font-size:27px; letter-spacing:.02em; }
.board-hero p { margin:0; color:#d6eafe; font-size:13px; }
.update-text { min-width:130px; display:flex; flex-direction:column; gap:6px; text-align:right; color:#dceeff; font-size:12px; }
.update-text b { color:#fff; font-size:14px; font-weight:600; }
.query-card { display:flex; align-items:flex-end; flex-wrap:wrap; gap:14px; margin:18px 0; padding:16px 18px; border:1px solid #e5edf7; border-radius:14px; background:#fff; box-shadow:0 6px 16px rgba(18,55,95,.05); }
.query-field { display:flex; flex-direction:column; gap:7px; min-width:170px; color:#6e7c90; font-size:12px; font-weight:600; }
.query-field :deep(.el-date-editor), .query-field :deep(.el-select) { width:100%; }
.store-select { min-width:260px; }
.view-select,.revenue-view-select { min-width:214px; }.view-select :deep(.el-radio-group),.revenue-view-select :deep(.el-radio-group) { display:flex; }.view-select :deep(.el-radio-button__inner),.revenue-view-select :deep(.el-radio-button__inner) { padding:9px 12px; font-size:12px; }.platform-source-button{border-color:#b9d6fb;background:#f4f9ff;color:#2868b9;font-weight:700;}
.revenue-source-panel{display:flex;align-items:center;justify-content:space-between;gap:18px;margin:0 0 18px;padding:16px 19px;border:1px solid #d9e8fc;border-radius:14px;background:linear-gradient(115deg,#f7fbff,#fffdf7);box-shadow:0 6px 16px rgba(29,73,132,.05)}.revenue-source-panel>div:first-child>span{color:#6685bb;font-size:10px;font-weight:700;letter-spacing:.12em}.revenue-source-panel h3{margin:3px 0;color:#29476f;font-size:18px}.revenue-source-panel p{margin:0;color:#71839a;font-size:12px}.revenue-source-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;min-width:min(720px,62%)}.revenue-source-metrics article{min-width:0;padding:10px 12px;border:1px solid #e4ebf4;border-radius:10px;background:#fff}.revenue-source-metrics span,.revenue-source-metrics b{display:block}.revenue-source-metrics span{color:#718096;font-size:10px}.revenue-source-metrics b{margin-top:6px;color:#245fae;font-size:16px;white-space:nowrap}.revenue-source-metrics b.fee{color:#c47c12}.platform-source-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.platform-source-grid article{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:72px;padding:12px;border:1px solid #e3eaf3;border-radius:10px;background:#fbfdff}.platform-source-grid b,.platform-source-grid span{display:block}.platform-source-grid b{color:#2c476a;font-size:13px}.platform-source-grid span{margin-top:4px;color:#93a0b1;font-size:10px}.platform-source-grid :deep(.el-radio-button__inner){padding:6px 8px;font-size:11px}
.daily-cost-panel { overflow:hidden; margin-bottom:18px; border:1px solid #dce7fb; border-radius:15px; background:linear-gradient(130deg,#f9fbff 0%,#fff 56%); box-shadow:0 8px 22px rgba(38,78,139,.06); }.daily-cost-panel > header { display:flex; justify-content:space-between; align-items:center; gap:18px; padding:17px 20px; border-bottom:1px solid #e7eef9; }.daily-cost-panel header > div:first-child > span { color:#6685bb; font-size:10px; font-weight:700; letter-spacing:.12em; }.daily-cost-panel h3 { margin:3px 0; color:#26466f; font-size:18px; }.daily-cost-panel p { margin:0; color:#75869d; font-size:12px; }.cost-source-tip { color:#7890b0; font-size:11px; }.daily-cost-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:0; }.daily-cost-grid article { min-height:132px; display:flex; flex-direction:column; gap:7px; padding:16px 20px; border-right:1px solid #e9eff8; }.daily-cost-grid article:last-child { border-right:0; }.daily-cost-grid article > div { display:flex; justify-content:space-between; align-items:center; gap:8px; }.daily-cost-grid article :deep(.el-button.is-text) { padding:3px 0; color:#5d7fbd; font-size:11px; }.daily-cost-grid span { color:#607694; font-size:12px; }.daily-cost-grid b { color:#29476f; font-size:24px; line-height:1.1; }.daily-cost-grid b small { margin-left:3px; color:#8090a5; font-size:11px; font-weight:500; }.daily-cost-grid p { color:#657994; font-size:11px; }.daily-cost-grid em { overflow:hidden; color:#99a6b6; font-size:10px; font-style:normal; text-overflow:ellipsis; white-space:nowrap; }.daily-cost-grid .cost-wage { box-shadow:inset 0 3px #5b85e9; }.daily-cost-grid .cost-rent { box-shadow:inset 0 3px #d99b58; }.daily-cost-grid .cost-utilities { box-shadow:inset 0 3px #4da99d; }
.dialog-hint { margin:0 0 16px; color:#708099; font-size:13px; line-height:1.65; }.cost-source-options { display:flex; flex-direction:column; width:100%; gap:10px; }.cost-source-options :deep(.el-radio) { display:flex; align-items:flex-start; width:100%; height:auto; min-height:74px; margin-right:0; padding:14px; white-space:normal; }.cost-source-options :deep(.el-radio__label) { display:flex; flex-direction:column; gap:5px; padding-left:9px; }.cost-source-options b { color:#2d4568; font-size:13px; }.cost-source-options span { color:#7d8c9f; font-size:11px; line-height:1.55; }
.tables-grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
.board-panel { overflow:hidden; border:1px solid #e5ebf3; border-radius:14px; background:#fff; box-shadow:0 5px 16px rgba(30,54,86,.05); }
.board-panel header { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; padding:16px 18px 13px; border-bottom:1px solid #edf1f5; }.board-panel h3 { margin:0; color:#243d5e; font-size:16px; }.board-panel p { margin:5px 0 0; color:#8a97a7; font-size:11px; }.board-panel header > span { padding:4px 8px; border-radius:12px; color:#57789f; background:#eef5ff; font-size:11px; }
.expense-panel :deep(.dashboard-group-row td) { color:#9a3d33; background:#fff5f3 !important; }.income-panel :deep(.dashboard-group-row td) { color:#18734f; background:#f1fbf6 !important; }.income-panel :deep(.dashboard-stored-group-row td) { color:#bf3548; background:#fff0f2 !important; }.income-panel :deep(.dashboard-stored-row td) { color:#c84c5c; background:#fff9fa !important; }.child-name { padding-left:20px; color:#68778c; }.child-name::before { content:'↳'; margin-right:7px; color:#a7b2c1; }.income-source,.stored-exclusion { display:inline-block; margin-left:7px; padding:1px 5px; border-radius:8px; font-size:10px; font-weight:500; line-height:1.4; vertical-align:1px; }.income-source { color:#5b789d; background:#edf4ff; }.stored-exclusion { color:#c83d4e; background:#ffe0e4; }
.metric-section { margin-top:20px; }.metric-section > h3 { margin:0 0 12px 3px; color:#273e5d; font-size:17px; }.metric-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; }.summary-card { min-height:112px; display:flex; flex-direction:column; justify-content:center; gap:8px; padding:14px 18px; border:2px solid #f0d6b5; background:#fff; }.summary-card span { display:flex; align-items:center; gap:7px; color:#6e7d91; font-size:12px; }.summary-card span i { padding:2px 5px; border-radius:7px; color:#8b9aae; background:#f1f5f9; font-size:9px; font-style:normal; opacity:0; transition:opacity .15s ease; }.summary-card.has-breakdown { cursor:help; outline:none; transition:box-shadow .16s ease, border-color .16s ease; }.summary-card.has-breakdown:hover,.summary-card.has-breakdown:focus { border-color:#93b4df; box-shadow:0 9px 18px rgba(39,83,132,.12); }.summary-card.has-breakdown:hover span i,.summary-card.has-breakdown:focus span i { opacity:1; }.summary-card b { color:#283b57; font-size:24px; line-height:1.1; }.summary-card small { color:#98a4b2; font-size:11px; }.summary-card.expense b, .summary-card.negative-net b { color:#d9504d; }.summary-card.income b, .summary-card.positive-net b { color:#16865a; }.summary-card.stored b { color:#7561c9; }
.metric-breakdown { width:260px; padding:2px; color:#31435b; }.metric-breakdown strong { display:block; margin-bottom:5px; color:#243e65; font-size:13px; }.metric-breakdown > p { margin:0 0 9px; color:#7d8b9d; font-size:11px; line-height:1.5; }.breakdown-line { display:flex; justify-content:space-between; gap:14px; padding:5px 0; border-top:1px dashed #e6ecf4; font-size:12px; }.breakdown-line span { overflow:hidden; color:#617289; text-overflow:ellipsis; white-space:nowrap; }.breakdown-line b { flex:none; color:#2f4669; font-variant-numeric:tabular-nums; }.breakdown-empty { padding:8px 0; color:#97a3b2; font-size:12px; }.metric-breakdown footer { display:flex; justify-content:space-between; margin-top:5px; padding-top:8px; border-top:1px solid #dbe5f0; color:#536983; font-size:12px; }.metric-breakdown footer b { color:#213d64; font-size:14px; }
.board-empty { padding:76px 0; background:#fff; border:1px solid #edf1f5; border-radius:14px; }
.trend-grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; margin-top:20px; }.trend-panel { overflow:hidden; border:1px solid #e5ebf3; border-radius:14px; background:#fff; box-shadow:0 5px 16px rgba(30,54,86,.05); }.trend-panel header { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; padding:16px 18px 8px; }.trend-panel h3 { margin:0; color:#273e5d; font-size:16px; }.trend-panel p { margin:5px 0 0; color:#8a97a7; font-size:11px; }.trend-panel header > span { color:#7391b4; font-size:11px; }.trend-chart { height:300px; }
@media (max-width:1200px) { .tables-grid, .trend-grid { grid-template-columns:1fr; }.metric-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }.revenue-source-panel{align-items:flex-start;flex-direction:column}.revenue-source-metrics{width:100%;min-width:0;} }
@media (max-width:780px) { .monthly-board-page { padding:14px; }.board-hero { padding:20px; flex-direction:column; }.update-text { text-align:left; }.daily-cost-panel > header { align-items:flex-start; flex-direction:column; }.daily-cost-grid { grid-template-columns:1fr; }.daily-cost-grid article { border-right:0; border-bottom:1px solid #e9eff8; }.daily-cost-grid article:last-child { border-bottom:0; }.metric-grid { grid-template-columns:1fr; }.query-card { align-items:stretch; }.query-field { width:100%; }.store-select { min-width:0; }.revenue-source-metrics,.platform-source-grid{grid-template-columns:1fr 1fr;} }
@media (max-width:520px){.revenue-source-metrics,.platform-source-grid{grid-template-columns:1fr}.platform-source-button{width:100%}}
</style>
