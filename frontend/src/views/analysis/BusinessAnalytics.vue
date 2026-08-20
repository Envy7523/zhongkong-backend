<template>
  <div class="business-analytics-page">
    <AnalysisPerspectiveNav />
    <AnalysisSectionNav />
    <section class="analytics-hero">
      <div class="hero-copy">
        <span class="eyebrow">BUSINESS INTELLIGENCE</span>
        <h2>集团经营总视角</h2>
        <p>统一查看全部门店与渠道的经营结果，按日、周、月观察实收、渠道构成、平台费用与核对差异。</p>
      </div>
      <div class="hero-actions">
        <el-button plain @click="loadData"><el-icon><Refresh /></el-icon>刷新数据</el-button>
        <el-button type="primary" @click="openImport"><el-icon><Upload /></el-icon>导入营业数据</el-button>
      </div>
    </section>

    <section class="filter-bar">
      <div class="period-switch" aria-label="统计周期">
        <button v-for="item in periods" :key="item.value" :class="{ active: filters.period === item.value }" @click="changePeriod(item.value)">
          {{ item.label }}视角
        </button>
      </div>
      <el-select v-model="filters.store_id" clearable filterable placeholder="全部门店" style="width:220px" @change="loadData">
        <el-option v-for="store in storeOptions" :key="store.id" :label="store.store_name" :value="store.id" />
      </el-select>
      <el-date-picker v-model="filters.range" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" @change="loadData" />
      <div class="filter-summary"><span class="live-dot"></span>{{ rangeLabel }}</div>
    </section>

    <section class="metric-grid" v-loading="loading">
      <article class="metric-card primary">
        <div><span>确认实收</span><small>线下实收 + 线上平台结算</small></div>
        <strong>{{ money(data.totals.confirmed) }}</strong>
        <div class="metric-foot"><i></i>当前筛选范围</div>
      </article>
      <article class="metric-card">
        <div><span>线下堂食</span><small>扫码、现金、储值消费等</small></div>
        <strong>{{ money(data.totals.offline) }}</strong>
        <div class="metric-foot">占实收 {{ ratio(data.totals.offline, data.totals.confirmed) }}</div>
      </article>
      <article class="metric-card">
        <div><span>团购实收</span><small>美团团购 + 抖音团购 + 免费试</small></div>
        <strong>{{ money(data.totals.group_buy) }}</strong>
        <div class="metric-foot">占实收 {{ ratio(data.totals.group_buy, data.totals.confirmed) }}</div>
      </article>
      <article class="metric-card">
        <div><span>外卖实收</span><small>美团、淘宝闪购、京东</small></div>
        <strong>{{ money(data.totals.delivery) }}</strong>
        <div class="metric-foot">占实收 {{ ratio(data.totals.delivery, data.totals.confirmed) }}</div>
      </article>
      <article class="metric-card warning">
        <div><span>线上核对差额</span><small>收银记录 - 平台实收</small></div>
        <strong>{{ signedMoney(data.totals.online_difference) }}</strong>
        <div class="metric-foot">平台费用合计 {{ money(data.totals.fees) }}</div>
      </article>
      <article class="metric-card success">
        <div><span>数据验证率</span><small>已有平台账单的线上记录</small></div>
        <strong>{{ percent(data.totals.verification_rate) }}</strong>
        <el-progress :percentage="Math.round((data.totals.verification_rate || 0) * 100)" :show-text="false" :stroke-width="6" />
      </article>
    </section>

    <section class="content-tabs">
      <button v-for="tab in tabs" :key="tab.value" :class="{ active: activeTab === tab.value }" @click="activeTab = tab.value">
        {{ tab.label }}<em v-if="tab.value === 'reconciliation'">{{ reconciliationCount }}</em>
      </button>
    </section>

    <template v-if="activeTab === 'overview'">
      <section class="chart-grid">
        <article class="panel trend-panel">
          <header><div><h3>门店实收趋势</h3><p>按{{ periodText }}聚合，线上已优先采用平台实际结算</p></div><span class="panel-badge">{{ data.trend.length }} 个周期</span></header>
          <div v-if="data.trend.length" ref="trendChartRef" class="chart"></div>
          <el-empty v-else description="暂无营业数据，请先导入收银系统文件" />
        </article>
        <article class="panel composition-panel">
          <header><div><h3>实收构成</h3><p>线下、团购与外卖的收入占比</p></div></header>
          <div v-if="data.totals.confirmed" ref="compositionChartRef" class="chart"></div>
          <el-empty v-else description="暂无构成数据" />
        </article>
      </section>

      <section class="lower-grid">
        <article class="panel store-ranking">
          <header><div><h3>门店实收排名</h3><p>统一口径后的确认实收</p></div></header>
          <div v-if="data.stores.length" class="ranking-list">
            <div v-for="(store, index) in data.stores.slice(0, 8)" :key="store.store_id">
              <span class="rank" :class="{ top: index < 3 }">{{ index + 1 }}</span>
              <div><b>{{ store.store_name }}</b><small>{{ store.verified_channels }} 个线上渠道已验证</small></div>
              <strong>{{ money(store.actual) }}</strong>
            </div>
          </div>
          <el-empty v-else description="暂无门店数据" />
        </article>
      </section>
    </template>

    <section v-else-if="activeTab === 'reconciliation'" class="panel reconciliation-panel">
      <header>
        <div><h3>收银系统与平台双向验证</h3><p>差额 = 收银系统记录 - 平台实际结算；尚未导入平台账单的渠道显示为“待验证”</p></div>
        <el-tag type="warning" effect="light">{{ reconciliationCount }} 条存在差额</el-tag>
      </header>
      <el-table :data="data.reconciliation" stripe>
        <el-table-column prop="biz_date" label="日期" width="110" />
        <el-table-column prop="store_name" label="门店" min-width="170" show-overflow-tooltip />
        <el-table-column prop="channel_label" label="线上渠道" width="120" />
        <el-table-column label="收银记录" width="130" align="right"><template #default="{ row }">{{ money(row.recorded) }}</template></el-table-column>
        <el-table-column label="平台实收" width="130" align="right"><template #default="{ row }"><span v-if="row.has_platform">{{ money(row.actual) }}</span><el-tag v-else size="small" type="info">待验证</el-tag></template></el-table-column>
        <el-table-column label="平台费用" width="120" align="right"><template #default="{ row }">{{ money(row.fees) }}</template></el-table-column>
        <el-table-column label="差额" width="120" align="right"><template #default="{ row }"><span v-if="row.difference != null" :class="differenceClass(row.difference)">{{ signedMoney(row.difference) }}</span><span v-else>—</span></template></el-table-column>
        <el-table-column label="核对状态" width="110"><template #default="{ row }"><el-tag v-if="!row.has_platform" type="info" size="small">待导入</el-tag><el-tag v-else-if="Math.abs(row.difference) <= 0.01" type="success" size="small">一致</el-tag><el-tag v-else type="warning" size="small">有差额</el-tag></template></el-table-column>
      </el-table>
    </section>

    <section v-else class="panel import-history">
      <header><div><h3>数据导入记录</h3><p>每次导入会覆盖同门店、同日期、同渠道的旧记录，避免重复统计</p></div><el-button type="primary" @click="openImport">继续导入</el-button></header>
      <el-table :data="data.batches" stripe>
        <el-table-column prop="created_at" label="导入时间" width="170" />
        <el-table-column label="数据来源" width="130"><template #default="{ row }"><el-tag :type="row.source_type === 'platform' ? 'success' : 'primary'">{{ row.source_type === 'platform' ? '线上平台' : '收银系统' }}</el-tag></template></el-table-column>
        <el-table-column prop="platform" label="平台" width="120"><template #default="{ row }">{{ row.platform || '全部渠道' }}</template></el-table-column>
        <el-table-column prop="file_name" label="文件" min-width="180" show-overflow-tooltip />
        <el-table-column label="数据范围" width="210"><template #default="{ row }">{{ row.date_from || '—' }} 至 {{ row.date_to || '—' }}</template></el-table-column>
        <el-table-column prop="row_count" label="写入记录" width="100" align="right" />
        <el-table-column prop="imported_by_name" label="导入人" width="110" />
      </el-table>
    </section>

    <el-dialog v-model="importVisible" title="导入经营数据" width="620px" class="business-import-dialog">
      <div class="import-steps"><span class="active">1 选择来源</span><i></i><span :class="{ active: importForm.file }">2 上传文件</span><i></i><span>3 自动核对</span></div>
      <el-form label-position="top">
        <el-form-item label="数据来源">
          <el-radio-group v-model="importForm.source_type" @change="resetImportFile">
            <el-radio-button value="pos">收银系统</el-radio-button>
            <el-radio-button value="platform">线上平台</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="importForm.source_type === 'platform'" label="平台渠道">
          <el-select v-model="importForm.platform" placeholder="请选择平台" style="width:100%">
            <el-option v-for="platform in platforms" :key="platform" :label="platform" :value="platform" />
          </el-select>
        </el-form-item>
        <el-form-item label="营业数据文件">
          <label class="file-drop" :class="{ selected: importForm.file }">
            <input type="file" accept=".xlsx,.xls,.csv" @change="selectFile" />
            <el-icon><DocumentAdd /></el-icon>
            <b>{{ importForm.file ? importForm.file.name : '点击选择 Excel / CSV 文件' }}</b>
            <small>{{ importForm.file ? formatFileSize(importForm.file.size) : '支持收银系统日报、平台结算与商品销量明细' }}</small>
          </label>
        </el-form-item>
        <button type="button" class="template-link" @click="downloadTemplate"><el-icon><Download /></el-icon>下载{{ importForm.source_type === 'platform' ? '线上平台' : '收银系统' }}导入模板</button>
        <div class="import-note">
          <b>导入规则</b>
          <p v-if="importForm.source_type === 'pos'">收银数据负责记录线下实收和各线上渠道的收银金额，作为经营总账与后续核对基准。</p>
          <p v-else>平台数据负责记录订单金额、实际结算、手续费、保险费、推广费、退款及商品销量，用于修正线上实收。</p>
        </div>
      </el-form>
      <template #footer><el-button @click="importVisible = false">取消</el-button><el-button type="primary" :loading="importing" :disabled="!canImport" @click="submitImport">开始导入并核对</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import * as echarts from 'echarts'
import { DocumentAdd, Download, Refresh, Upload } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { getBusinessAnalytics, getBusinessTemplate, getStores, importBusinessData } from '@/api'
import AnalysisPerspectiveNav from './AnalysisPerspectiveNav.vue'
import AnalysisSectionNav from './AnalysisSectionNav.vue'

const periods = [{ label: '日', value: 'day' }, { label: '周', value: 'week' }, { label: '月', value: 'month' }]
const tabs = [{ label: '经营总览', value: 'overview' }, { label: '双向核对', value: 'reconciliation' }, { label: '导入记录', value: 'imports' }]
const platforms = ['美团团购', '抖音团购', '免费试', '美团外卖', '淘宝闪购', '京东外卖']
const activeTab = ref('overview')
const loading = ref(false)
const importing = ref(false)
const importVisible = ref(false)
const storeOptions = ref([])
const trendChartRef = ref()
const compositionChartRef = ref()
let trendChart
let compositionChart
const filters = reactive({ period: 'day', store_id: null, range: [] })
const importForm = reactive({ source_type: 'pos', platform: '', file: null })
const data = reactive({ totals: {}, trend: [], reconciliation: [], stores: [], top_products: [], batches: [] })

const periodText = computed(() => ({ day: '日', week: '周', month: '月' }[filters.period]))
const rangeLabel = computed(() => filters.range?.length === 2 ? `${filters.range[0]} 至 ${filters.range[1]}` : '当前全部营业数据')
const reconciliationCount = computed(() => data.reconciliation.filter(row => row.difference != null && Math.abs(row.difference) > 0.01).length)
const canImport = computed(() => importForm.file && (importForm.source_type === 'pos' || importForm.platform))

function money(value) { return `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }
function signedMoney(value) { const n = Number(value || 0); return `${n > 0 ? '+' : n < 0 ? '-' : ''}${money(Math.abs(n))}` }
function percent(value) { return `${(Number(value || 0) * 100).toFixed(1)}%` }
function ratio(value, total) { return total ? `${(Number(value || 0) / total * 100).toFixed(1)}%` : '0.0%' }
function numberText(value) { return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) }
function differenceClass(value) { return Math.abs(value) <= 0.01 ? 'difference-ok' : 'difference-warn' }
function changePeriod(period) { filters.period = period; loadData() }

async function loadData() {
  loading.value = true
  try {
    const result = await getBusinessAnalytics('overview', { period: filters.period, store_id: filters.store_id || undefined, date_from: filters.range?.[0], date_to: filters.range?.[1] })
    Object.assign(data, result)
    await nextTick()
    renderCharts()
  } catch (error) { ElMessage.error(error.message) }
  finally { loading.value = false }
}

function renderCharts() {
  if (activeTab.value !== 'overview') return
  if (trendChartRef.value && data.trend.length) {
    trendChart ||= echarts.init(trendChartRef.value)
    trendChart.setOption({
      color: ['#3b82f6', '#8b5cf6', '#14b8a6'],
      tooltip: { trigger: 'axis', valueFormatter: value => money(value) },
      legend: { top: 2, right: 6, itemWidth: 10, itemHeight: 6, textStyle: { color: '#667085' } },
      grid: { left: 12, right: 12, top: 42, bottom: 5, containLabel: true },
      xAxis: { type: 'category', data: data.trend.map(item => item.period), axisLine: { lineStyle: { color: '#e4e9f1' } }, axisTick: { show: false }, axisLabel: { color: '#8a94a6' } },
      yAxis: { type: 'value', axisLabel: { color: '#8a94a6', formatter: value => value >= 10000 ? `${(value / 10000).toFixed(1)}万` : value }, splitLine: { lineStyle: { color: '#edf1f6', type: 'dashed' } } },
      series: [
        { name: '线下堂食', type: 'bar', stack: 'revenue', data: data.trend.map(item => item.offline), barMaxWidth: 26, itemStyle: { borderRadius: [0, 0, 4, 4] } },
        { name: '团购', type: 'bar', stack: 'revenue', data: data.trend.map(item => item.group_buy), barMaxWidth: 26 },
        { name: '外卖', type: 'bar', stack: 'revenue', data: data.trend.map(item => item.delivery), barMaxWidth: 26, itemStyle: { borderRadius: [4, 4, 0, 0] } },
      ],
    }, true)
  }
  if (compositionChartRef.value && data.totals.confirmed) {
    compositionChart ||= echarts.init(compositionChartRef.value)
    compositionChart.setOption({
      color: ['#3b82f6', '#8b5cf6', '#14b8a6'],
      tooltip: { trigger: 'item', formatter: item => `${item.name}<br/>${money(item.value)} · ${item.percent}%` },
      legend: { bottom: 0, icon: 'circle', itemWidth: 8, textStyle: { color: '#667085' } },
      series: [{ type: 'pie', radius: ['54%', '76%'], center: ['50%', '45%'], label: { show: false }, itemStyle: { borderColor: '#fff', borderWidth: 4, borderRadius: 8 }, data: [
        { name: '线下堂食', value: data.totals.offline || 0 }, { name: '团购', value: data.totals.group_buy || 0 }, { name: '外卖', value: data.totals.delivery || 0 },
      ] }],
      graphic: [{ type: 'text', left: 'center', top: '38%', style: { text: money(data.totals.confirmed), fill: '#182230', fontSize: 18, fontWeight: 700, textAlign: 'center' } }, { type: 'text', left: 'center', top: '48%', style: { text: '确认实收', fill: '#98a2b3', fontSize: 11, textAlign: 'center' } }],
    }, true)
  }
}

function openImport() { importVisible.value = true }
function resetImportFile() { importForm.file = null; importForm.platform = '' }
function selectFile(event) { importForm.file = event.target.files?.[0] || null }
function formatFileSize(bytes) { return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB` }
function readFile(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file) }) }

async function submitImport() {
  if (!canImport.value) return
  importing.value = true
  try {
    const result = await importBusinessData({ source_type: importForm.source_type, platform: importForm.platform, file_name: importForm.file.name, data: await readFile(importForm.file) })
    if (!Number(result.imported || 0)) {
      const reasons = (result.errors || []).slice(0, 3).join('；')
      throw new Error(reasons ? `没有有效数据：${reasons}` : '文件中没有通过校验的营业数据')
    }
    ElMessage.success(`已导入 ${result.imported} 条营收记录${result.product_rows ? `、${result.product_rows} 条商品销量` : ''}`)
    if (result.skipped) ElMessage.warning(`${result.skipped} 行未能识别，请检查门店名称和日期`)
    importVisible.value = false
    importForm.file = null
    activeTab.value = 'overview'
    await loadData()
  } catch (error) { ElMessage.error(error.message) }
  finally { importing.value = false }
}

async function downloadTemplate() {
  try {
    const result = await getBusinessTemplate(importForm.source_type)
    const bytes = Uint8Array.from(atob(result.data), char => char.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    const link = document.createElement('a'); link.href = url; link.download = result.file_name; link.click(); URL.revokeObjectURL(url)
  } catch (error) { ElMessage.error(error.message) }
}

function resizeCharts() { trendChart?.resize(); compositionChart?.resize() }
watch(activeTab, async value => { if (value === 'overview') { await nextTick(); renderCharts() } })
onMounted(async () => { const result = await getStores({ page: 1, pageSize: 200 }).catch(() => ({ stores: [] })); storeOptions.value = result.stores || []; await loadData(); window.addEventListener('resize', resizeCharts) })
onBeforeUnmount(() => { trendChart?.dispose(); compositionChart?.dispose(); window.removeEventListener('resize', resizeCharts) })
</script>

<style scoped>
.business-analytics-page{--ink:#162033;--muted:#748096;--line:#e6eaf0;--blue:#3b82f6;min-width:0;color:var(--ink)}
.analytics-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:16px;padding:28px 30px;border-radius:18px;color:#fff;background:radial-gradient(circle at 88% 0,rgba(107,172,255,.35),transparent 34%),linear-gradient(125deg,#14295b 0%,#2255a4 56%,#3b82f6 100%);box-shadow:0 16px 36px rgba(34,75,151,.18)}
.eyebrow{color:#b8d4ff;font-size:10px;font-weight:800;letter-spacing:.2em}.hero-copy h2{margin:7px 0 6px;font-size:27px}.hero-copy p{margin:0;color:rgba(255,255,255,.72);font-size:13px}.hero-actions{display:flex;gap:9px}.hero-actions :deep(.el-button){height:38px;border-radius:9px}.hero-actions :deep(.el-button.is-plain){border-color:rgba(255,255,255,.32);background:rgba(255,255,255,.12);color:#fff}
.filter-bar{display:flex;align-items:center;gap:12px;margin-bottom:16px;padding:12px 14px;border:1px solid var(--line);border-radius:14px;background:#fff;box-shadow:0 6px 18px rgba(33,48,78,.05)}.period-switch{display:flex;padding:3px;border-radius:9px;background:#f1f4f8}.period-switch button{min-width:68px;height:32px;border:0;border-radius:7px;background:transparent;color:#69758a;cursor:pointer;font-size:12px}.period-switch button.active{background:#fff;color:var(--blue);font-weight:700;box-shadow:0 2px 7px rgba(32,48,78,.12)}.filter-summary{display:flex;align-items:center;gap:7px;margin-left:auto;color:#7c8799;font-size:11px;white-space:nowrap}.live-dot{width:7px;height:7px;border-radius:50%;background:#22b980;box-shadow:0 0 0 4px rgba(34,185,128,.1)}
.metric-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-bottom:17px}.metric-card{min-height:130px;padding:17px;border:1px solid var(--line);border-radius:14px;background:#fff;box-shadow:0 6px 18px rgba(33,48,78,.05)}.metric-card>div:first-child span,.metric-card>div:first-child small{display:block}.metric-card span{font-size:12px;font-weight:700}.metric-card small{margin-top:5px;color:#98a2b3;font-size:9px;line-height:1.5}.metric-card strong{display:block;margin:17px 0 12px;font-size:21px;letter-spacing:-.02em}.metric-foot{color:#8a94a6;font-size:10px}.metric-card.primary{border-color:#8ebcff;background:linear-gradient(145deg,#f7fbff,#edf5ff)}.metric-card.primary strong{color:#246bd4}.metric-card.warning strong{color:#d37b12}.metric-card.success strong{color:#159467}.metric-card.success :deep(.el-progress-bar__inner){background:#22b980}
.content-tabs{display:flex;gap:4px;margin-bottom:12px;padding:4px;border:1px solid var(--line);border-radius:11px;background:#f7f8fa;width:max-content}.content-tabs button{height:33px;padding:0 16px;border:0;border-radius:8px;background:transparent;color:#667085;cursor:pointer;font-size:12px}.content-tabs button.active{background:#fff;color:#246bd4;font-weight:700;box-shadow:0 3px 9px rgba(36,57,91,.09)}.content-tabs em{display:inline-grid;min-width:18px;height:18px;margin-left:6px;place-items:center;border-radius:9px;background:#fff1db;color:#c87008;font-size:9px;font-style:normal}
.chart-grid{display:grid;grid-template-columns:minmax(0,1.85fr) minmax(300px,.75fr);gap:14px;margin-bottom:14px}.lower-grid{display:grid;grid-template-columns:1fr;gap:14px}.panel{overflow:hidden;border:1px solid var(--line);border-radius:15px;background:#fff;box-shadow:0 7px 22px rgba(33,48,78,.055)}.panel>header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:17px 19px;border-bottom:1px solid #edf0f4}.panel h3{margin:0;font-size:14px}.panel header p{margin:4px 0 0;color:#929cad;font-size:10px}.panel-badge{padding:5px 9px;border-radius:20px;background:#eef4ff;color:#3d6fc5;font-size:10px}.chart{height:330px}.ranking-list{padding:6px 18px 12px}.ranking-list>div{display:flex;align-items:center;gap:11px;padding:12px 2px;border-bottom:1px solid #eef1f5}.ranking-list>div:last-child{border-bottom:0}.rank{display:grid;width:24px;height:24px;place-items:center;border-radius:7px;background:#f0f2f6;color:#7e899b;font-size:10px;font-weight:700}.rank.top{background:#e8f1ff;color:#3275de}.ranking-list>div>div{min-width:0;flex:1}.ranking-list b,.ranking-list small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ranking-list b{font-size:11px}.ranking-list small{margin-top:3px;color:#9aa3b2;font-size:9px}.ranking-list strong{font-size:12px}.reconciliation-panel,.import-history{min-height:420px}.difference-ok{color:#189768}.difference-warn{color:#d97706;font-weight:700}
.import-steps{display:flex;align-items:center;margin-bottom:20px;padding:11px 14px;border-radius:10px;background:#f6f8fb;color:#a0a8b6;font-size:10px}.import-steps span.active{color:#3275de;font-weight:700}.import-steps i{height:1px;flex:1;margin:0 10px;background:#dfe4ec}.file-drop{display:flex;flex-direction:column;align-items:center;width:100%;padding:25px;border:1px dashed #cfd8e6;border-radius:12px;background:#fafcff;cursor:pointer;transition:.2s}.file-drop:hover,.file-drop.selected{border-color:#6fa3f5;background:#f4f8ff}.file-drop input{display:none}.file-drop .el-icon{margin-bottom:8px;color:#4b86e2;font-size:28px}.file-drop b{font-size:12px}.file-drop small{margin-top:5px;color:#98a2b3;font-size:10px}.template-link{display:flex;align-items:center;gap:5px;margin-top:-4px;padding:0;border:0;background:none;color:#3275de;cursor:pointer;font-size:11px}.import-note{margin-top:17px;padding:13px 14px;border-left:3px solid #72a4f1;border-radius:0 9px 9px 0;background:#f5f8fd}.import-note b{font-size:11px}.import-note p{margin:5px 0 0;color:#7b879a;font-size:10px;line-height:1.65}
@media(max-width:1280px){.metric-grid{grid-template-columns:repeat(3,1fr)}}
@media(max-width:900px){.analytics-hero{align-items:flex-start;flex-direction:column}.filter-bar{align-items:stretch;flex-wrap:wrap}.filter-summary{width:100%;margin-left:0}.metric-grid{grid-template-columns:repeat(2,1fr)}.chart-grid,.lower-grid{grid-template-columns:1fr}.chart{height:300px}}
@media(max-width:560px){.analytics-hero{padding:22px 20px}.hero-actions{width:100%}.hero-actions :deep(.el-button){flex:1}.metric-grid{grid-template-columns:1fr}.period-switch{width:100%}.period-switch button{flex:1}.content-tabs{width:100%}.content-tabs button{flex:1;padding:0 8px}}
</style>
