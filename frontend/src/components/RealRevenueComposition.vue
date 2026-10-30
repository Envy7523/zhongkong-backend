<template>
  <section class="real-income-composition">
    <header class="composition-heading"><div><h3>营业收入构成</h3><p>{{period?period+' · ':''}}消费／营业全额 · 扣减及最终到手见下方</p></div><span class="field-count">{{result.rows.length}} 项字段</span></header>
    <div v-if="result.rows.length" class="composition-layout">
    <el-table :key="tableStateKey" :data="result.rows" row-key="key" stripe class="real-income-table" :row-class-name="({row})=>row.platformMissing?'platform-missing-row':'platform-complete-row'">
      <el-table-column prop="name" label="收入字段" min-width="160" fixed="left"/>
      <el-table-column prop="kind" label="类型" width="100"/>
      <el-table-column label="取数来源" min-width="180">
        <template #default="{row}">
          <el-popover v-if="row.platformMissing" placement="top" trigger="click" :width="380">
            <template #reference><button type="button" class="source-details" :aria-label="row.name+'：查看缺失的第三方数据日期'"><el-tag type="danger" size="small" effect="plain">{{row.source}}</el-tag></button></template>
            <div class="missing-details">
              <strong>{{row.name}} · 数据待核对</strong>
              <p>{{row.source==='会员交易流水'?'会员流水或营业日关联待补齐，仅展示已核实消费全额；本金、赠金和到手见下方。':'仅汇总已导入的平台数据，缺失日期未使用收银机补数。'}}</p>
              <ul v-if="row.missingDays.length"><li v-for="day in row.missingDays" :key="[day.store_id,day.biz_date,day.reason].join('|')"><b>{{day.biz_date}}</b><span>{{day.store_name||'门店 '+day.store_id}}</span><small>{{day.reason}}</small></li></ul>
              <p v-else>请重新查询以获取缺失日期。</p>
            </div>
          </el-popover>
          <el-tag v-else :type="row.sourceTone" size="small" effect="plain">{{row.source}}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="全额" min-width="175" align="right"><template #default="{row}"><span :class="{missing:row.fullAmount===null}">{{row.fullAmount===null?'未提供':money(row.fullAmount)}}</span></template></el-table-column>
      <el-table-column v-if="compare" label="全额环比" min-width="120" align="right"><template #default="{row}">{{row.fullCompareRate===null?'—':(row.fullCompareRate>0?'+':'')+(row.fullCompareRate*100).toFixed(1)+'%'}}</template></el-table-column>
      <el-table-column label="全额占比" min-width="110" align="right"><template #default="{row}">{{row.fullRatio===null?'—':(row.fullRatio*100).toFixed(1)+'%'}}</template></el-table-column>
    </el-table>
    <aside class="income-ring-column" :aria-label="chartTitle">
      <h4>{{chartTitle}}</h4>
      <div ref="chartElement" class="income-ring-chart"/>
      <ul v-if="chartRows.length" class="income-ring-legend">
        <li v-for="row in chartRows" :key="row.key">
          <i :style="{background:row.color}" aria-hidden="true"/>
          <span class="legend-name" :title="row.name">{{row.name}}</span>
          <span class="legend-ratio">{{(row.actual/chartTotal*100).toFixed(1)}}%</span>
        </li>
      </ul>
    </aside>
    </div>
    <el-empty v-else description="暂无营业收入构成数据" :image-size="64"/>
    <p class="amount-note">支付方式按消费金额、平台按营业全额列示。构成合计与最终到手不同，扣减及结算见下方。<span v-if="result.fullMissingCount"> {{result.fullMissingCount}} 项未提供全额。</span><span v-if="result.fullPendingCount"> {{result.fullPendingCount}} 项覆盖范围待核对，仅展示已取得部分。</span></p>
    <MemberConsumption :data="data.member_card_consumption"/>
    <PlatformIncomeComposition :items="data.platform_income_composition||[]"/>

  </section>
</template>
<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import * as echarts from 'echarts'
import { realRevenueComposition } from '@/utils/real-revenue-composition.mjs'
import MemberConsumption from './MemberConsumption.vue'
import PlatformIncomeComposition from './PlatformIncomeComposition.vue'

const props = defineProps({ data: { type: Object, required: true }, previous: { type: Object, default: () => ({}) }, compare: Boolean, period: { type: String, default: '' } })
const result = computed(() => realRevenueComposition(props.data, props.previous))
// A query can reuse the same payment/channel keys with different coverage.
// Recreate the table when its warning state changes, including fixed cells.
const tableStateKey = computed(() => JSON.stringify(result.value.rows.map(row => [row.key, row.platformMissing, row.missingDays])))
const money = v => v === null || v === undefined ? '—' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const colors = ['#2563eb', '#14b8a6', '#a78bfa', '#f59e0b', '#64748b', '#60a5fa', '#f97316', '#06b6d4', '#ec4899', '#22c55e']
// Pie sectors represent positive receipts only. Keep zero, missing and refund
// amounts intact in the table, rather than turning refunds into positive slices.
const chartRows = computed(() => result.value.rows.map((row, index) => ({ ...row, actual:row.fullAmount, color: colors[index % colors.length] })).filter(row => row.actual > 0))
const chartTotal = computed(() => chartRows.value.reduce((cents, row) => cents + Math.round(row.actual * 100), 0) / 100)
const chartTitle = computed(() => result.value.rows.some(row => row.fullAmount < 0) ? '正向全额占比' : '全额占比')
const chartElement = ref(null)
let chart = null, resizeObserver = null

function disposeChart() {
  resizeObserver?.disconnect()
  resizeObserver = null
  chart?.dispose()
  chart = null
}
function renderChart() {
  const element = chartElement.value
  if (!element) return disposeChart()
  if (chart && chart.getDom() !== element) disposeChart()
  if (!chart) {
    chart = echarts.init(element, null, { renderer: 'svg' })
    resizeObserver = new ResizeObserver(() => {
      if (element.clientWidth && element.clientHeight) chart?.resize()
    })
    resizeObserver.observe(element)
  }
  const hasAmount = result.value.rows.some(row => row.fullAmount !== null)
  chart.setOption({
    animation: false,
    aria: { enabled: true },
    tooltip: {
      trigger: 'item', renderMode: 'richText',
      formatter: item => `${item.name}\n${money(item.value)} · ${item.percent}%`,
    },
    series: [{
      type: 'pie', radius: ['58%', '80%'], center: ['50%', '50%'],
      label: { show: false }, labelLine: { show: false },
      showEmptyCircle: true, emptyCircleStyle: { color: '#eaf0f7' },
      itemStyle: { borderColor: '#fff', borderWidth: 3, borderRadius: 5 },
      emphasis: { scaleSize: 5 },
      data: chartRows.value.map(row => ({ name: row.name, value: row.actual, itemStyle: { color: row.color } })),
    }],
    graphic: [
      { type: 'text', left: 'center', top: '41%', style: { text: hasAmount ? money(chartTotal.value) : '—', fill: '#182230', fontSize: 19, fontWeight: 700, textAlign: 'center' } },
      { type: 'text', left: 'center', top: '54%', style: { text: chartTitle.value === '正向全额占比' ? '正向全额' : '已取得全额', fill: '#64748b', fontSize: 12, textAlign: 'center' } },
    ],
  }, true)
}
watch(result, renderChart, { flush: 'post' })
onMounted(renderChart)
onBeforeUnmount(disposeChart)
</script>
<style scoped>
.amount-note{padding:0 22px;font-size:12px;line-height:1.8;color:var(--el-text-color-secondary)}
.real-income-composition{color:var(--el-text-color-primary)}
.composition-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 22px;border-bottom:1px solid var(--el-border-color-lighter)}
h3{font-size:16px;margin:0;font-weight:600}.composition-heading p{font-size:12px;color:var(--el-text-color-secondary);margin:7px 0 0;line-height:1.6}
.field-count{font-size:12px;white-space:nowrap;background:var(--el-fill-color-light);color:var(--el-text-color-secondary);padding:5px 10px;border-radius:6px}
.composition-layout{display:grid;grid-template-columns:minmax(0,1fr) 320px;align-items:stretch}
.real-income-table{min-width:0;font-variant-numeric:tabular-nums}
.real-income-table :deep(.platform-complete-row>td.el-table__cell){background:var(--el-bg-color)!important}
.real-income-table :deep(.platform-complete-row.el-table__row--striped>td.el-table__cell){background:var(--el-fill-color-lighter)!important}
.real-income-table :deep(.platform-missing-row>td.el-table__cell){background:var(--el-color-danger-light-9)!important}
.source-details{display:inline-flex;align-items:center;border:0;background:transparent;padding:4px 0;cursor:pointer;color:inherit;font:inherit}
.source-details:focus-visible{outline:2px solid var(--el-color-danger);outline-offset:3px;border-radius:4px}
.missing{color:#99651f}
.member-receipt{display:block;margin-top:3px;color:var(--el-text-color-secondary);font-size:11px;line-height:1.5}
.missing-details{font-size:12px;color:var(--el-text-color-primary)}.missing-details>strong{color:var(--el-color-danger)}.missing-details p{line-height:1.7;margin:8px 0}.missing-details ul{max-height:240px;overflow:auto;padding:0;margin:10px 0 0;list-style:none}.missing-details li{display:grid;grid-template-columns:90px minmax(0,1fr);gap:4px 10px;padding:9px 0;border-top:1px solid var(--el-border-color-lighter)}.missing-details small{grid-column:2;color:var(--el-text-color-secondary)}
.income-ring-column{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px 18px;border-left:1px solid var(--el-border-color-lighter);background:linear-gradient(180deg,#fbfdff,#f5f9ff);min-width:0}
.income-ring-column h4{font-size:13px;font-weight:500;color:var(--el-text-color-secondary);margin:0}
.income-ring-chart{width:100%;height:250px}
.income-ring-legend{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px;list-style:none;padding:0;margin:0;width:100%;font-size:12px;color:var(--el-text-color-regular)}
.income-ring-legend li{display:flex;align-items:center;gap:6px;min-width:0}.income-ring-legend i{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.legend-name{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.legend-ratio{margin-left:auto;color:var(--el-text-color-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.compact .composition-heading{padding:14px 0}.compact h3{font-size:15px}
@media(max-width:1100px){.composition-layout{grid-template-columns:1fr}.income-ring-column{border-left:0;border-top:1px solid var(--el-border-color-lighter);display:grid;grid-template-columns:minmax(230px,300px) minmax(0,1fr);gap:12px 24px;padding:20px 24px}.income-ring-column h4{grid-column:1/-1}.income-ring-chart{height:250px}.income-ring-legend{max-width:480px}}
@media(max-width:600px){.composition-heading{padding:16px;align-items:flex-start}.income-ring-column{display:flex;padding:20px}.income-ring-chart{max-width:300px}.income-ring-legend{max-width:340px}}
</style>
