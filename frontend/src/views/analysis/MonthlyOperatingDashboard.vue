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
      <el-button v-if="filters.dataView === 'real'" class="platform-source-button" @click="openSourceDialog">平台来源 · {{ platformSourceSummary }}</el-button>
      <el-button type="primary" :loading="loading" @click="queryBoard">查询看板</el-button>
    </section>

    <template v-if="queried">
      <section class="revenue-source-panel"><div><span>REVENUE SOURCE</span><h3>{{ board.revenue_source?.view === 'cashier' ? '收银机视角' : '真实数据视角' }}</h3><p>{{ board.revenue_source?.view === 'cashier' ? '全部销售渠道按收银机原始数据计算。' : '店内销售与自提来自收银机；第三方渠道按当前平台来源设置解析。' }}</p></div><div class="revenue-source-metrics"><article><span>销售营业额</span><b>{{ money(board.revenue_source?.gross_amount) }}</b></article><article><span>优惠后收入</span><b>{{ money(board.revenue_source?.income_amount) }}</b></article><article><span>平台费用</span><b class="fee">{{ money(board.revenue_source?.platform_fee_amount) }}</b></article><article><span>实际到账</span><b>{{ money(board.revenue_source?.settled_amount) }}</b></article></div></section>
      <section v-if="isAccrual" class="daily-cost-panel">
        <header>
          <div><span>DAILY ACCRUED COST</span><h3>每日均摊成本</h3><p>固定由工资、房租/物业、水电构成；每个项目可独立设置来源，按本月 {{ board.period.days_in_month }} 天均摊。</p>
            <small v-if="singleStoreId" class="store-scope-note" :class="{ saved: costSourceSaved }">
              {{ costSourceSaved ? '来源设置已按本门店保存，切换门店会各自带出各自的口径' : '来源设置将按本门店保存（本店尚未保存过，当前为默认值）' }}<template v-if="costSourceSaving"> · 保存中…</template>
            </small>
            <small v-else class="store-scope-note warn">
              当前选了 {{ filters.storeIds.length }} 家门店（或未选），来源设置不会按店保存；请单选一家门店再调整，才会记住该店的口径
            </small>
          </div>
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

      <section v-if="efficiency.visible" class="efficiency-panel">
        <header>
          <div>
            <span>LABOR EFFICIENCY</span>
            <h3>人效</h3>
            <p v-if="efficiency.included">{{ efficiency.headline }}</p>
            <p v-else>人效 = 出勤人员工资 ÷ 收银机店内销售，仅单门店口径。</p>
          </div>
          <small class="efficiency-region">统计范围：{{ efficiency.regionCities }}</small>
        </header>

        <template v-if="efficiency.included">
          <div class="efficiency-body">
            <article class="efficiency-chip">
              <span>当日人效</span>
              <b :class="efficiency.tone">{{ efficiency.dayDisplay }}</b>
              <em>{{ efficiency.day.date }} 出勤 {{ efficiency.day.people }} 人 · 工资 {{ money(efficiency.day.wage_total) }}</em>
            </article>
            <article class="efficiency-chip">
              <span>当日店内销售</span>
              <b>{{ money(efficiency.day.store_sales) }}</b>
              <em>收银机渠道「店内销售」当日值</em>
            </article>
            <article class="efficiency-chip">
              <span>期间累计人效</span>
              <b :class="efficiency.rangeTone">{{ efficiency.rangeDisplay }}</b>
              <em>月初至 {{ efficiency.board.range.date_to }}：工资 {{ money(efficiency.range.wage_total) }} ÷ 店内销售 {{ money(efficiency.range.store_sales) }}</em>
            </article>
            <article class="efficiency-chip">
              <span>期间出勤人数</span>
              <b>{{ efficiency.range.people }}<small> 人</small></b>
              <em>考勤 {{ efficiency.range.attendance_days }} 天 · 兼职 {{ efficiency.range.work_hours }} 小时</em>
            </article>
          </div>

          <p class="efficiency-formula">
            口径：全职 = {{ efficiency.board.formula.full_time }}；兼职 = {{ efficiency.board.formula.part_time }}。
            分母 = {{ efficiency.board.formula.denominator }}。{{ efficiency.board.formula.attendance_rule }}。
          </p>
          <p v-if="efficiency.gapHint" class="efficiency-warning">{{ efficiency.gapHint }}</p>

          <div class="efficiency-detail">
            <div class="detail-head">
              <div class="detail-switch">
                <el-radio-group v-model="efficiencyScope" size="small">
                  <el-radio-button label="day">{{ efficiency.day.date }} 当日出勤（{{ efficiency.day.rows.length }} 人）</el-radio-button>
                  <el-radio-button label="range">本月至今出勤过的（{{ efficiency.range.rows_total }} 人）</el-radio-button>
                </el-radio-group>
              </div>
              <small v-if="efficiencyScope === 'range' && efficiency.range.rows_truncated" class="detail-truncated">仅列出工资最高的 {{ efficiency.range.rows.length }} 条</small>
            </div>
            <el-table :data="efficiencyRows" size="small" class="detail-table" :default-sort="{ prop: 'name', order: 'ascending' }">
              <el-table-column prop="name" label="姓名" width="86" sortable />
              <el-table-column prop="position" label="岗位" width="104" show-overflow-tooltip />
              <el-table-column label="用工类型" width="88">
                <template #default="{ row }"><span :class="['hire-tag', row.hire_type === '兼职' ? 'part' : 'full']">{{ row.hire_type }}</span></template>
              </el-table-column>
              <el-table-column :label="efficiencyScope === 'day' ? '当日出勤' : '出勤天数'" width="96" align="right">
                <template #default="{ row }">{{ efficiencyScope === 'day' ? '是' : `${row.total_attendance_days} 天` }}</template>
              </el-table-column>
              <el-table-column label="工作时长" width="98" align="right">
                <template #default="{ row }">{{ row.hire_type === '兼职' ? `${row.work_hours} 小时` : '—' }}</template>
              </el-table-column>
              <el-table-column label="工资构成（月）" min-width="196">
                <template #default="{ row }">
                  <span v-if="row.wage_parts" class="parts">
                    基本 {{ num(row.wage_parts.base_salary) }}<template v-if="row.wage_parts.position_allowance"> · 岗位 {{ num(row.wage_parts.position_allowance) }}</template><template v-if="row.wage_parts.performance_salary"> · 绩效 {{ num(row.wage_parts.performance_salary) }}</template><template v-if="row.wage_parts.attendance_bonus"> · 全勤 {{ num(row.wage_parts.attendance_bonus) }}</template><template v-if="row.wage_parts.housing_allowance"> · 房补 {{ num(row.wage_parts.housing_allowance) }}</template>
                    <b class="parts-total">= {{ num(row.wage_parts.monthly_total) }}</b>
                  </span>
                  <span v-else class="parts">{{ row.hourly_rate ? `${row.hourly_rate} 元/时` : '时薪未录入' }}</span>
                </template>
              </el-table-column>
              <el-table-column label="工资算法" min-width="184">
                <template #default="{ row }">
                  <span class="wage-note" :class="{ missing: !row.has_wage_basis }">{{ row.wage_note }}</span>
                  <small v-if="!row.has_wage_basis" class="missing-tag">缺工资构成</small>
                </template>
              </el-table-column>
              <el-table-column label="工时工资" width="106" align="right" sortable prop="wage">
                <template #default="{ row }"><b class="wage-value">{{ money(row.wage) }}</b></template>
              </el-table-column>
              <el-table-column label="占比" width="88" align="right">
                <template #default="{ row }">{{ percent(rate(row.wage, efficiencyRowsWageTotal)) }}</template>
              </el-table-column>
            </el-table>
            <div class="detail-footer">
              <span v-for="line in efficiencySummaryLines" :key="line.label">{{ line.label }} <b>{{ line.value }}</b></span>
            </div>
          </div>
        </template>

        <el-empty v-if="!efficiency.included" :description="efficiency.emptyText" :image-size="72" />
      </section>
    </template>

    <el-empty v-else description="请选择月份、截止日期和门店后查询月经营数据看板" :image-size="120" class="board-empty" />

    <el-dialog v-model="costSourceDialogVisible" :title="`调整${costSourceTargetLabel}来源`" width="520px" class="cost-source-dialog" destroy-on-close>
      <p class="dialog-hint">仅调整{{ costSourceTargetLabel }}的取数来源。<b v-if="singleStoreId">确认后会保存到本门店</b><b v-else>当前未单选门店，不会按店保存</b>；保存完成后请点击页面的“查询看板”重新计算。</p>
      <el-radio-group v-model="draftCostSource" class="cost-source-options">
        <el-radio v-for="option in costSourceOptions" :key="option.value" :label="option.value" border>
          <b>{{ option.label }}</b><span>{{ option.description }}</span>
        </el-radio>
      </el-radio-group>
      <template #footer>
        <el-button v-if="singleStoreId && costSourceSaved" text type="warning" @click="resetCostSources">恢复默认</el-button>
        <el-button @click="costSourceDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="applyCostSource">确认选择</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="sourceDialogVisible" title="真实数据视角 · 平台来源" width="720px" class="source-config-dialog" destroy-on-close>
      <p class="dialog-hint">店内销售与自提固定取收银机；四个可切换平台可选择收银机或第三方。美团团购始终采用第三方收益明细（该项不可改）。
        <b v-if="singleStoreId">确认后会保存到本门店{{ sourceSaved ? '（本店已保存过）' : '（本店尚未保存过，当前为默认值）' }}</b>
        <b v-else>当前未单选门店，不会按店保存</b>；保存完成后请点击查询看板重新计算。</p>
      <div class="platform-source-grid"><article v-for="item in platformSourceOptions" :key="item.key"><div><b>{{ item.label }}</b><span>{{ item.note }}</span></div><el-radio-group v-model="draftSourceOverrides[item.key]" size="small" :disabled="item.key === 'meituan_group'"><el-radio-button label="platform">第三方</el-radio-button><el-radio-button label="pos">收银机</el-radio-button></el-radio-group></article></div>
      <template #footer>
        <el-button v-if="singleStoreId && sourceSaved" text type="warning" @click="resetPlatformSources">恢复默认</el-button>
        <el-button @click="sourceDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="sourceSaving" @click="applySourceOverrides">确认选择</el-button>
      </template>
    </el-dialog>
  </main>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import * as echarts from 'echarts'
import { ElMessage } from 'element-plus'
import { getMonthlyOperatingDashboard, getStoreDashboardSettings, getStores, resetStoreDashboardSettings, saveStoreDashboardSettings } from '@/api'
import StoreRegionSelect from '@/components/StoreRegionSelect.vue'

function today() { return new Date().toISOString().slice(0, 10) }
const DEFAULT_COST_SOURCES = { wage: 'operating_previous', rent: 'bookkeeping', utilities: 'bookkeeping' }
const DEFAULT_SOURCE_OVERRIDES = { meituan_delivery: 'platform', taobao_flash: 'platform', jd_delivery: 'platform', douyin_group: 'platform', meituan_group: 'platform' }
const filters = reactive({ month: today().slice(0, 7), asOf: today(), storeIds: [], view: 'cash', dataView: 'real', sourceOverrides: { meituan_delivery: 'platform', taobao_flash: 'platform', jd_delivery: 'platform', douyin_group: 'platform', meituan_group: 'platform' }, costSources: { wage: 'operating_previous', rent: 'bookkeeping', utilities: 'bookkeeping' } })
const stores = ref([])
const loading = ref(false)
const queried = ref(false)
const queriedAt = ref('')
const costSourceDialogVisible = ref(false)
const costSourceSaved = ref(false)
const sourceSaved = ref(false)
// 平台来源对话框用草稿副本：原实现直接把单选绑在 filters.sourceOverrides 上，
// 导致点「取消」并不会撤销已改的选项。
const draftSourceOverrides = ref({ ...DEFAULT_SOURCE_OVERRIDES })
const sourceDialogVisible = ref(false)
const draftCostSource = ref('operating_previous')
const costSourceTarget = ref('wage')
const dailyProfitChartRef = ref()
const cumulativeProfitChartRef = ref()
const board = reactive({ store_name: '', period: {}, view: 'cash', cost_sources: {}, wage: {}, accrual_costs: [], income_rows: [], expense_rows: [], stored_value_rows: [], daily_profit_series: [], totals: {}, labor_efficiency: null })
const isAccrual = computed(() => board.view === 'accrual')
// 人效：仅单门店查询时展示。当日口径 = 截止日当天出勤人员的当天工资；期间口径 = 月初至截止日期间出勤过的所有人。
const efficiencyScope = ref('day')
const efficiency = computed(() => {
  const info = board.labor_efficiency
  const regionCities = (info?.region?.cities || []).join('、') || '未配置'
  if (!info || !queried.value || !info.enabled) return { visible: false, included: false, regionCities }
  const emptyBase = { visible: true, included: false, regionCities, board: info, day: {}, range: {}, dayDisplay: '—', rangeDisplay: '—', tone: '', rangeTone: '', gapHint: '' }
  if (!info.included) {
    const emptyText = info.reason === 'out_of_region'
      ? `人效暂只统计「${regionCities}」的门店${info.store_city ? `，当前门店城市为「${info.store_city}」` : '（当前门店城市未填写）'}。`
      : info.reason === 'no_store' ? '人效只对单家门店计算，多门店汇总不展示。' : '人效统计范围尚未配置。'
    return { ...emptyBase, emptyText }
  }
  const day = info.day || {}
  const range = info.range_totals || {}
  const tone = ratio => ratio === null || ratio === undefined ? '' : ratio >= 0.3 ? 'high' : ratio >= 0.15 ? 'mid' : 'low'
  const names = info.data_gap?.day_names || []
  const missingDay = day.missing_basis_count || 0
  const gapHint = missingDay
    ? `注意：${day.date} 出勤的 ${missingDay} 人没有工资依据（全职月工资构成为 0 或兼职时薪未录入），工时为 0 计：${names.join('、')}。`
    : ''
  return {
    ...emptyBase,
    included: true,
    day,
    range,
    dayDisplay: day.ratio === null || day.ratio === undefined ? '—' : percent(day.ratio),
    rangeDisplay: range.ratio === null || range.ratio === undefined ? '—' : percent(range.ratio),
    tone: tone(day.ratio),
    rangeTone: tone(range.ratio),
    gapHint,
    headline: `${day.date} 当日人效 ${day.ratio === null || day.ratio === undefined ? '—' : percent(day.ratio)}`
      + `（出勤 ${day.people || 0} 人 · 工资 ${money(day.wage_total)} ÷ 店内销售 ${money(day.store_sales)}）`
      + `；月初至 ${info.range?.date_to} 期间人效 ${range.ratio === null || range.ratio === undefined ? '—' : percent(range.ratio)}`,
  }
})
const efficiencyRows = computed(() => {
  const info = board.labor_efficiency
  if (!info?.included) return []
  return (efficiencyScope.value === 'day' ? info.day?.rows : info.range_totals?.rows) || []
})
const efficiencyRowsWageTotal = computed(() => efficiencyRows.value.reduce((sum, row) => sum + Number(row.wage || 0), 0))
const efficiencySummaryLines = computed(() => {
  const info = board.labor_efficiency
  if (!info?.included) return []
  const scope = efficiencyScope.value === 'day' ? info.day : info.range_totals
  if (!scope) return []
  return [
    { label: '人数', value: `${scope.people || 0} 人（全职 ${scope.full_time_people || 0} / 兼职 ${scope.part_time_people || 0}）` },
    { label: '工资合计', value: money(scope.wage_total) },
    { label: '全职考勤', value: `${scope.attendance_days || 0} 天` },
    { label: '兼职工时', value: `${scope.work_hours || 0} 小时` },
    { label: '店内销售', value: money(scope.store_sales) },
    { label: '人效', value: scope.ratio === null || scope.ratio === undefined ? '—' : percent(scope.ratio) },
  ]
})

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

// 看板的两组取数设置都**按门店保存**（同一张 store_dashboard_settings）：
//   · costSources     —— 每日均摊成本里 工资 / 房租物业 / 水电 的来源
//   · sourceOverrides —— 真实数据视角里各第三方平台的来源（第三方 / 收银机）
// 它们都会改变算出来的钱，属于口径而不是个人偏好：同一家店不同人看到不同口径，数字就对不上了。
const costSourceSaving = ref(false)
const sourceSaving = ref(false)
// 只有「恰好选中一家门店」时才有明确的归属，此时读写该门店的设置；
// 选 0 家（全部）或多家的语义不唯一，沿用当前会话值并在界面提示。
const singleStoreId = computed(() => (filters.storeIds.length === 1 ? Number(filters.storeIds[0]) : null))

function pickSettings(saved, defaults) {
  return saved && typeof saved === 'object' ? { ...defaults, ...saved } : { ...defaults }
}

async function loadDashboardSettingsForCurrentStore() {
  const id = singleStoreId.value
  if (!id) return
  try {
    const data = await getStoreDashboardSettings(id)
    const saved = data?.settings || {}
    // 没保存过就回到默认，避免上一家门店的值“串”到这一家
    filters.costSources = pickSettings(saved.costSources, DEFAULT_COST_SOURCES)
    filters.sourceOverrides = pickSettings(saved.sourceOverrides, DEFAULT_SOURCE_OVERRIDES)
    costSourceSaved.value = Boolean(saved.costSources)
    sourceSaved.value = Boolean(saved.sourceOverrides)
  } catch (error) {
    // 读不到就退回默认值，不打断查询（例如老库还没建这张表）
    filters.costSources = { ...DEFAULT_COST_SOURCES }
    filters.sourceOverrides = { ...DEFAULT_SOURCE_OVERRIDES }
    costSourceSaved.value = false
    sourceSaved.value = false
  }
}

/** 把当前两组设置保存到单选的那家门店；返回是否真的保存了 */
async function persistDashboardSettings(patch, label) {
  const id = singleStoreId.value
  if (!id) return false
  sourceSaving.value = true
  try {
    await saveStoreDashboardSettings(id, patch)
    return true
  } catch (error) {
    ElMessage.warning(`${label}已在本页生效，但保存到门店失败：${error.message}`)
    return false
  } finally { sourceSaving.value = false }
}

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

async function resetPlatformSources() {
  const id = singleStoreId.value
  if (!id) return
  try {
    await resetStoreDashboardSettings(id)
    filters.costSources = { ...DEFAULT_COST_SOURCES }
    filters.sourceOverrides = { ...DEFAULT_SOURCE_OVERRIDES }
    costSourceSaved.value = false
    sourceSaved.value = false
    sourceDialogVisible.value = false
    ElMessage.success('已恢复本门店的默认来源（均摊成本与平台来源），请点击查询看板重新计算')
  } catch (error) { ElMessage.error('恢复默认失败：' + error.message) }
}

async function resetCostSources() {
  const id = singleStoreId.value
  if (!id) return
  try {
    await resetStoreDashboardSettings(id)
    filters.costSources = { ...DEFAULT_COST_SOURCES }
    filters.sourceOverrides = { ...DEFAULT_SOURCE_OVERRIDES }
    costSourceSaved.value = false
    sourceSaved.value = false
    costSourceDialogVisible.value = false
    ElMessage.success('已恢复本门店的默认来源（均摊成本与平台来源），请点击“查询看板”重新计算')
  } catch (error) { ElMessage.error('恢复默认失败：' + error.message) }
}

function openCostSourceDialog(key) {
  costSourceTarget.value = key
  draftCostSource.value = filters.costSources[key]
  costSourceDialogVisible.value = true
}
function applyCostSource() {
  filters.costSources[costSourceTarget.value] = draftCostSource.value
  costSourceDialogVisible.value = false
  const id = singleStoreId.value
  if (!id) {
    ElMessage.info(`${costSourceTargetLabel.value}来源已调整（当前未单选门店，不会按店保存），请点击“查询看板”重新计算`)
    return
  }
  // 按门店保存：单选门店时立即落库，下次切回这家店会自动带出同一套来源。
  costSourceSaving.value = true
  saveStoreDashboardSettings(id, { costSources: { ...filters.costSources } })
    .then(() => { costSourceSaved.value = true; ElMessage.info(`${costSourceTargetLabel.value}来源已保存到本门店，请点击“查询看板”重新计算`) })
    .catch(error => ElMessage.warning(`${costSourceTargetLabel.value}来源已在本页生效，但保存到门店失败：${error.message}`))
    .finally(() => { costSourceSaving.value = false })
}

function openSourceDialog() {
  draftSourceOverrides.value = { ...filters.sourceOverrides }
  sourceDialogVisible.value = true
}
async function applySourceOverrides() {
  filters.sourceOverrides = { ...draftSourceOverrides.value }
  sourceDialogVisible.value = false
  if (!singleStoreId.value) {
    ElMessage.info('平台来源已调整（当前未单选门店，不会按店保存），请点击查询看板重新计算')
    return
  }
  const ok = await persistDashboardSettings({ sourceOverrides: { ...filters.sourceOverrides } }, '平台来源')
  if (ok) { sourceSaved.value = true; ElMessage.info('平台来源已保存到本门店，请点击查询看板重新计算') }
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
function num(value) { return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) }
function signedMoney(value) { const number = Number(value || 0); return `${number > 0 ? '+' : number < 0 ? '-' : ''}${money(Math.abs(number))}` }
function tableRowClass({ row }) {
  if (row.is_stored) return row.is_group ? 'dashboard-stored-group-row' : 'dashboard-stored-row'
  return row.is_group ? 'dashboard-group-row' : ''
}
function netClass(value) { return Number(value) >= 0 ? 'positive-net' : 'negative-net' }

// 门店选择变化时，把该门店已保存的「每日均摊成本来源」带出来。
// 这样从 A 店切到 B 店会各自用自己的口径，切回来也不用重设 —— 这是本次修的“全门店同步”问题。
watch(() => filters.storeIds.join(','), () => { loadDashboardSettingsForCurrentStore() })
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
.daily-cost-panel { overflow:hidden; margin-bottom:18px; border:1px solid #dce7fb; border-radius:15px; background:linear-gradient(130deg,#f9fbff 0%,#fff 56%); box-shadow:0 8px 22px rgba(38,78,139,.06); }.daily-cost-panel > header { display:flex; justify-content:space-between; align-items:center; gap:18px; padding:17px 20px; border-bottom:1px solid #e7eef9; }.daily-cost-panel header > div:first-child > span { color:#6685bb; font-size:10px; font-weight:700; letter-spacing:.12em; }.daily-cost-panel h3 { margin:3px 0; color:#26466f; font-size:18px; }.daily-cost-panel p { margin:0; color:#75869d; font-size:12px; }.cost-source-tip { color:#7890b0; font-size:11px; }
.store-scope-note { display:block; margin-top:6px; color:#6b8f5f; font-size:11px; line-height:1.6; }
.store-scope-note.saved { color:#2f8f5b; }
.store-scope-note.warn { color:#c07a16; }.daily-cost-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:0; }.daily-cost-grid article { min-height:132px; display:flex; flex-direction:column; gap:7px; padding:16px 20px; border-right:1px solid #e9eff8; }.daily-cost-grid article:last-child { border-right:0; }.daily-cost-grid article > div { display:flex; justify-content:space-between; align-items:center; gap:8px; }.daily-cost-grid article :deep(.el-button.is-text) { padding:3px 0; color:#5d7fbd; font-size:11px; }.daily-cost-grid span { color:#607694; font-size:12px; }.daily-cost-grid b { color:#29476f; font-size:24px; line-height:1.1; }.daily-cost-grid b small { margin-left:3px; color:#8090a5; font-size:11px; font-weight:500; }.daily-cost-grid p { color:#657994; font-size:11px; }.daily-cost-grid em { overflow:hidden; color:#99a6b6; font-size:10px; font-style:normal; text-overflow:ellipsis; white-space:nowrap; }.daily-cost-grid .cost-wage { box-shadow:inset 0 3px #5b85e9; }.daily-cost-grid .cost-rent { box-shadow:inset 0 3px #d99b58; }.daily-cost-grid .cost-utilities { box-shadow:inset 0 3px #4da99d; }
.dialog-hint { margin:0 0 16px; color:#708099; font-size:13px; line-height:1.65; }.cost-source-options { display:flex; flex-direction:column; width:100%; gap:10px; }.cost-source-options :deep(.el-radio) { display:flex; align-items:flex-start; width:100%; height:auto; min-height:74px; margin-right:0; padding:14px; white-space:normal; }.cost-source-options :deep(.el-radio__label) { display:flex; flex-direction:column; gap:5px; padding-left:9px; }.cost-source-options b { color:#2d4568; font-size:13px; }.cost-source-options span { color:#7d8c9f; font-size:11px; line-height:1.55; }
.tables-grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
.board-panel { overflow:hidden; border:1px solid #e5ebf3; border-radius:14px; background:#fff; box-shadow:0 5px 16px rgba(30,54,86,.05); }
.board-panel header { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; padding:16px 18px 13px; border-bottom:1px solid #edf1f5; }.board-panel h3 { margin:0; color:#243d5e; font-size:16px; }.board-panel p { margin:5px 0 0; color:#8a97a7; font-size:11px; }.board-panel header > span { padding:4px 8px; border-radius:12px; color:#57789f; background:#eef5ff; font-size:11px; }
.expense-panel :deep(.dashboard-group-row td) { color:#9a3d33; background:#fff5f3 !important; }.income-panel :deep(.dashboard-group-row td) { color:#18734f; background:#f1fbf6 !important; }.income-panel :deep(.dashboard-stored-group-row td) { color:#bf3548; background:#fff0f2 !important; }.income-panel :deep(.dashboard-stored-row td) { color:#c84c5c; background:#fff9fa !important; }.child-name { padding-left:20px; color:#68778c; }.child-name::before { content:'↳'; margin-right:7px; color:#a7b2c1; }.income-source,.stored-exclusion { display:inline-block; margin-left:7px; padding:1px 5px; border-radius:8px; font-size:10px; font-weight:500; line-height:1.4; vertical-align:1px; }.income-source { color:#5b789d; background:#edf4ff; }.stored-exclusion { color:#c83d4e; background:#ffe0e4; }
.metric-section { margin-top:20px; }.metric-section > h3 { margin:0 0 12px 3px; color:#273e5d; font-size:17px; }.metric-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; }.summary-card { min-height:112px; display:flex; flex-direction:column; justify-content:center; gap:8px; padding:14px 18px; border:2px solid #f0d6b5; background:#fff; }.summary-card span { display:flex; align-items:center; gap:7px; color:#6e7d91; font-size:12px; }.summary-card span i { padding:2px 5px; border-radius:7px; color:#8b9aae; background:#f1f5f9; font-size:9px; font-style:normal; opacity:0; transition:opacity .15s ease; }.summary-card.has-breakdown { cursor:help; outline:none; transition:box-shadow .16s ease, border-color .16s ease; }.summary-card.has-breakdown:hover,.summary-card.has-breakdown:focus { border-color:#93b4df; box-shadow:0 9px 18px rgba(39,83,132,.12); }.summary-card.has-breakdown:hover span i,.summary-card.has-breakdown:focus span i { opacity:1; }.summary-card b { color:#283b57; font-size:24px; line-height:1.1; }.summary-card small { color:#98a4b2; font-size:11px; }.summary-card.expense b, .summary-card.negative-net b { color:#d9504d; }.summary-card.income b, .summary-card.positive-net b { color:#16865a; }.summary-card.stored b { color:#7561c9; }
.metric-breakdown { width:260px; padding:2px; color:#31435b; }.metric-breakdown strong { display:block; margin-bottom:5px; color:#243e65; font-size:13px; }.metric-breakdown > p { margin:0 0 9px; color:#7d8b9d; font-size:11px; line-height:1.5; }.breakdown-line { display:flex; justify-content:space-between; gap:14px; padding:5px 0; border-top:1px dashed #e6ecf4; font-size:12px; }.breakdown-line span { overflow:hidden; color:#617289; text-overflow:ellipsis; white-space:nowrap; }.breakdown-line b { flex:none; color:#2f4669; font-variant-numeric:tabular-nums; }.breakdown-empty { padding:8px 0; color:#97a3b2; font-size:12px; }.metric-breakdown footer { display:flex; justify-content:space-between; margin-top:5px; padding-top:8px; border-top:1px solid #dbe5f0; color:#536983; font-size:12px; }.metric-breakdown footer b { color:#213d64; font-size:14px; }
.board-empty { padding:76px 0; background:#fff; border:1px solid #edf1f5; border-radius:14px; }
.efficiency-panel { margin-top:20px; overflow:hidden; border:1px solid #e2e9f4; border-radius:14px; background:#fff; box-shadow:0 5px 16px rgba(30,54,86,.05); }
.efficiency-panel > header { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; padding:17px 20px 13px; border-bottom:1px solid #eef2f7; }
.efficiency-panel header > div > span { color:#6685bb; font-size:10px; font-weight:700; letter-spacing:.12em; }
.efficiency-panel h3 { margin:3px 0; color:#26466f; font-size:18px; }
.efficiency-panel p { margin:0; color:#75869d; font-size:12px; }
.efficiency-region { flex:none; padding:4px 9px; border-radius:12px; color:#57789f; background:#eef5ff; font-size:11px; }
.efficiency-body { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); }
.efficiency-chip { min-width:0; display:flex; flex-direction:column; gap:7px; padding:16px 20px; border-right:1px solid #eef2f7; }
.efficiency-chip:last-child { border-right:0; }
.efficiency-chip span { color:#607694; font-size:12px; }
.efficiency-chip b { color:#29476f; font-size:24px; line-height:1.1; font-variant-numeric:tabular-nums; }
.efficiency-chip b small { margin-left:3px; color:#8090a5; font-size:11px; font-weight:500; }
.efficiency-chip b.high { color:#16865a; }
.efficiency-chip b.mid { color:#c47c12; }
.efficiency-chip b.low { color:#d9504d; }
.efficiency-chip em { color:#98a4b2; font-size:10px; font-style:normal; line-height:1.5; }
.efficiency-formula, .efficiency-warning, .efficiency-days { padding:11px 20px; font-size:11px; line-height:1.65; }
.efficiency-formula { margin:0; border-top:1px solid #eef2f7; color:#7d8b9d; background:#fbfdff; }
.efficiency-warning { margin:0; border-top:1px dashed #f2ddc2; color:#a56312; background:#fffaf1; }
.efficiency-days { margin:0; border-top:1px dashed #e6ecf4; color:#93a0b1; }
.efficiency-panel :deep(.el-empty) { padding:22px 0; }
.efficiency-detail { border-top:1px solid #eef2f7; }
.detail-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:13px 20px; }
.detail-truncated { color:#a56312; font-size:11px; }
.detail-table { --el-table-border-color:#eef2f7; font-size:12px; }
.detail-table :deep(th.el-table__cell) { background:#f8fbfe !important; color:#5b7391; font-size:11px; font-weight:700; }
.detail-table :deep(.el-table__cell) { padding:6px 0; }
.hire-tag { display:inline-block; padding:1px 6px; border-radius:8px; font-size:10px; line-height:1.5; }
.hire-tag.full { color:#2868b9; background:#eef5ff; }
.hire-tag.part { color:#a56312; background:#fff6e6; }
.parts { color:#5f7691; font-size:11px; }
.parts-total { margin-left:6px; color:#2c476a; font-size:12px; }
.wage-note { display:block; color:#6b7d92; font-size:11px; }
.wage-note.missing { color:#c06a12; }
.missing-tag { display:inline-block; margin-top:3px; padding:1px 5px; border-radius:7px; color:#c06a12; background:#fff5e8; font-size:10px; }
.wage-value { color:#245fae; font-size:13px; font-variant-numeric:tabular-nums; }
.detail-footer { display:flex; flex-wrap:wrap; gap:6px 20px; padding:12px 20px; border-top:1px solid #eef2f7; background:#fbfdff; color:#75869d; font-size:11px; }
.detail-footer b { color:#2c476a; }
.trend-grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; margin-top:20px; }.trend-panel { overflow:hidden; border:1px solid #e5ebf3; border-radius:14px; background:#fff; box-shadow:0 5px 16px rgba(30,54,86,.05); }.trend-panel header { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; padding:16px 18px 8px; }.trend-panel h3 { margin:0; color:#273e5d; font-size:16px; }.trend-panel p { margin:5px 0 0; color:#8a97a7; font-size:11px; }.trend-panel header > span { color:#7391b4; font-size:11px; }.trend-chart { height:300px; }
@media (max-width:1200px) { .tables-grid, .trend-grid { grid-template-columns:1fr; }.efficiency-body { grid-template-columns:1fr 1fr; }.efficiency-chip:nth-child(2n) { border-right:0; }.efficiency-chip:nth-child(-n+2) { border-bottom:1px solid #eef2f7; }.metric-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }.revenue-source-panel{align-items:flex-start;flex-direction:column}.revenue-source-metrics{width:100%;min-width:0;} }
@media (max-width:780px) { .monthly-board-page { padding:14px; }.board-hero { padding:20px; flex-direction:column; }.update-text { text-align:left; }.efficiency-panel > header { flex-direction:column; }.efficiency-body { grid-template-columns:1fr; }.efficiency-chip { border-right:0; border-bottom:1px solid #eef2f7; }.efficiency-chip:last-child { border-bottom:0; }.daily-cost-panel > header { align-items:flex-start; flex-direction:column; }.daily-cost-grid { grid-template-columns:1fr; }.daily-cost-grid article { border-right:0; border-bottom:1px solid #e9eff8; }.daily-cost-grid article:last-child { border-bottom:0; }.metric-grid { grid-template-columns:1fr; }.query-card { align-items:stretch; }.query-field { width:100%; }.store-select { min-width:0; }.revenue-source-metrics,.platform-source-grid{grid-template-columns:1fr 1fr;} }
@media (max-width:520px){.revenue-source-metrics,.platform-source-grid{grid-template-columns:1fr}.platform-source-button{width:100%}}
</style>
