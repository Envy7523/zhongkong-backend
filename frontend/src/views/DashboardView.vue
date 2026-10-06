<template>
  <main class="home-page" aria-labelledby="home-title">
    <div class="home-masthead"><span>鹅太公中控 <b>/</b> OPERATIONS OVERVIEW</span><time>{{ todayLabel }}</time></div>
    <section class="home-hero" aria-labelledby="home-title">
      <div class="hero-rings" aria-hidden="true"></div>
      <div class="hero-message">
        <p class="hero-kicker">经营中枢 <span></span> {{ latestDate ? `业务日 ${latestDate}` : '等待经营数据' }}</p>
        <h1 id="home-title">看见经营全貌，<br><em>掌握每一步变化。</em></h1>
        <p>从门店实收到报表同步，先看清盘面，再决定今天的工作。</p>
        <div class="hero-actions">
          <button v-if="canViewAnalysis" class="hero-primary" type="button" @click="openTarget('analysis-total-brand', '/analysis/total/brand')">进入经营分析 <el-icon><ArrowRight /></el-icon></button>
          <button v-if="canViewImports" class="hero-secondary" type="button" @click="openTarget('data-import-pos-automation', '/data-import/pos/automation')">查看采集进度 <el-icon><ArrowRight /></el-icon></button>
        </div>
      </div>
      <div class="hero-feature" aria-live="polite">
        <div class="feature-head"><span>收银机视角 · 最近业务日实收</span><small>DATA SNAPSHOT</small></div>
        <strong class="feature-value">{{ latestDate ? money(latestActual) : '—' }}</strong>
        <p>{{ latestDate ? `${latestDate} · ${latestRows.length} 家门店有记录` : !canViewAnalysis ? '当前岗位无经营数据权限' : revenueLoaded ? '暂无已入库的经营日报' : '正在读取经营数据' }}</p>
        <div class="feature-bottom"><div><span>营业额</span><b>{{ latestDate ? money(latestRevenue) : '—' }}</b></div><div><span>订单量</span><b>{{ latestDate ? integer(latestOrders) : '—' }}</b></div><div><span>数据范围</span><b>{{ latestDate ? '收银系统' : '待导入' }}</b></div></div>
      </div>
    </section>

    <div v-if="loadError" class="home-notice" role="status">部分数据暂时无法读取，页面仅展示已取得的内容。<button type="button" :disabled="loading" @click="loadOverview">重新读取</button></div>

    <section class="home-brief" aria-labelledby="brief-title">
      <div class="home-section-head"><span>01 — 经营速览</span><h2 id="brief-title">今天先看什么</h2><p>只突出有依据的变化与待办，不把资料数量当作经营成果。</p></div>
      <div class="brief-grid">
        <article class="brief-feature"><span class="brief-label">经营观察</span><h3>{{ latestDate ? comparisonTitle : '等第一份经营日报到齐，再开始判断。' }}</h3><p>{{ latestDate ? comparisonDetail : '目前没有可用于首页汇总的收银日报。导入后，这里会展示实收变化与门店覆盖；不会用档案数量代替经营数据。' }}</p><small>{{ latestDate ? `依据：${latestDate} 收银日报 · ${latestRows.length} 家门店` : '数据尚未形成' }}</small></article>
        <article class="brief-attention"><span class="brief-label">需要留意</span><h3>{{ canViewImports ? attentionTitle : '按岗位查看经营信息' }}</h3><p>{{ canViewImports ? attentionDetail : '报表采集状态仅向具备导入管理权限的岗位展示。' }}</p><button v-if="canViewImports" class="brief-link" type="button" @click="openTarget('data-import-pos-automation', '/data-import/pos/automation')">打开运行记录 <el-icon><ArrowRight /></el-icon></button></article>
      </div>
    </section>

    <div class="home-middle">
      <section class="home-panel" aria-labelledby="stores-title">
        <div class="panel-head"><div><span>02 — 经营指标</span><h2 id="stores-title">营业概况</h2></div><small>{{ latestDate ? `${latestDate} · 最大值为 100%` : '等待经营数据' }}</small></div>
        <template v-if="latestDate">
          <div v-for="item in summaryBars" :key="item.key" class="summary-line">
            <span class="summary-label">{{ item.label }}</span>
            <div class="summary-track"><span class="summary-fill" :class="`summary-fill--${item.key}`" :style="{ width: `${item.percent}%` }"></span></div>
            <strong class="summary-value">{{ item.display }}</strong>
            <small class="summary-percent">{{ item.percent === 100 ? '100' : item.percent.toFixed(1) }}%</small>
          </div>
          <p class="panel-note">柱长按原始数值相对最大值缩放；金额为元、订单量为单，单位不同，不代表可直接比较。</p>
        </template>
        <div v-else class="panel-empty"><b>—</b><span>暂无经营指标</span><small>等待收银系统报表导入</small></div>
      </section>
      <section v-if="canViewImports" class="home-panel" aria-labelledby="reports-title"><div class="panel-head"><div><span>03 — 数据链路</span><h2 id="reports-title">三份报表，各自推进</h2></div></div><p class="panel-lead">导入成功不等于日报已发送。每份报表独立核对。</p><div v-for="(report, index) in reportCards" :key="report.key" class="report-line"><i>0{{ index + 1 }}</i><div><strong>{{ report.name }}</strong><small>{{ report.date ? `业务日 ${report.date}` : '尚无运行记录' }}</small></div><span :class="`state-${report.state}`">{{ report.label }}</span></div><p v-if="syncError" class="panel-warning">部分运行状态未取得，请以运行记录为准。</p></section>
    </div>

    <section class="home-foundation" aria-labelledby="foundation-title"><div><span>系统底座</span><h2 id="foundation-title">经营背后的基础档案</h2><p>这里是当前档案口径，不代表最近业务日的营业覆盖。</p></div><dl><div><dt>正常营业门店</dt><dd>{{ statsLoaded ? integer(stats.activeStores) : '—' }}</dd></div><div><dt>在职员工</dt><dd>{{ statsLoaded ? integer(stats.employeeCount) : '—' }}</dd></div><div><dt>在售菜品</dt><dd>{{ statsLoaded ? integer(stats.menuCount) : '—' }}</dd></div></dl></section>
  </main>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { getDashboardStats, getDashboardPosSummary, getSyncRuns } from '@/api'
import { ArrowRight } from '@element-plus/icons-vue'

const router = useRouter()
const store = useAppStore()
const auth = useAuthStore()
const stats = ref({})
const dailyRows = ref([])
const statsLoaded = ref(false)
const revenueLoaded = ref(false)
const loading = ref(false)
const loadError = ref(false)
const syncError = ref(false)
const latestReports = ref({})

const canViewAnalysis = computed(() => auth.can('analysis.view'))
const canViewImports = computed(() => auth.can('data-import.manage'))
const todayLabel = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full', timeZone: 'Asia/Shanghai' }).format(new Date())
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0
const integer = value => new Intl.NumberFormat('zh-CN').format(number(value))
const money = value => `¥${new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number(value))}`

const reportTypes = [
  { key: 'cashier_composite', name: '综合营业统计' },
  { key: 'item_sales_detail', name: '品项销售明细' },
  { key: 'pos_bookkeeping_daily', name: '门店收支统计' },
]
function reportState(run) {
  if (!run) return { state: 'empty', label: '暂无记录' }
  if (run.status === 'success' && run.imported) return { state: 'success', label: '导入成功' }
  if (run.status === 'failed') return { state: 'failed', label: '执行失败' }
  if (run.status === 'waiting_human') return { state: 'warning', label: '等待处理' }
  if (run.status === 'running') return { state: 'running', label: '运行中' }
  return { state: 'empty', label: '待核对' }
}
const reportCards = computed(() => reportTypes.map(type => {
  const run = latestReports.value[type.key]
  return { ...type, date: run?.business_date || '', ...reportState(run) }
}))
const dates = computed(() => [...new Set(dailyRows.value.map(row => String(row.date || '')).filter(Boolean))].sort().reverse())
const latestDate = computed(() => dates.value[0] || '')
const latestRows = computed(() => dailyRows.value.filter(row => row.date === latestDate.value))
const previousRows = computed(() => dailyRows.value.filter(row => row.date === dates.value[1]))
const sum = (rows, field) => rows.reduce((total, row) => total + number(row[field]), 0)
const latestActual = computed(() => sum(latestRows.value, 'actual_revenue'))
const latestRevenue = computed(() => sum(latestRows.value, 'revenue'))
const latestOrders = computed(() => sum(latestRows.value, 'order_count'))
const sameCoverage = computed(() => {
  if (!previousRows.value.length || latestRows.value.length !== previousRows.value.length) return false
  const ids = rows => rows.map(row => String(row.store_id || row.store_name || '')).sort().join('|')
  return ids(latestRows.value) === ids(previousRows.value)
})
const comparisonTitle = computed(() => {
  if (!previousRows.value.length) return '最新一天的经营，已经摆在眼前。'
  if (!sameCoverage.value) return '两天门店范围不同，先核对覆盖。'
  const previous = sum(previousRows.value, 'actual_revenue')
  if (!previous) return '已取得两天记录，前日实收为零。'
  const delta = (latestActual.value - previous) / previous * 100
  return `实收较前一记录日${delta >= 0 ? '增加' : '减少'} ${Math.abs(delta).toFixed(1)}%`
})
const comparisonDetail = computed(() => {
  if (!previousRows.value.length) return `已入库 ${latestRows.value.length} 家门店的收银日报，实收 ${money(latestActual.value)}。后续有相同门店范围的前一记录日时，再展示可比变化。`
  if (!sameCoverage.value) return `${latestDate.value} 有 ${latestRows.value.length} 家门店记录，${dates.value[1]} 有 ${previousRows.value.length} 家。为避免误判，首页暂不计算涨跌。`
  return `${latestDate.value} 实收 ${money(latestActual.value)}，前一记录日 ${dates.value[1]} 实收 ${money(sum(previousRows.value, 'actual_revenue'))}；两天门店范围一致。`
})
const summaryBars = computed(() => {
  const items = [
    { key: 'revenue', label: '营业额', value: latestRevenue.value, display: money(latestRevenue.value) },
    { key: 'actual', label: '实收', value: latestActual.value, display: money(latestActual.value) },
    { key: 'orders', label: '订单量', value: latestOrders.value, display: `${integer(latestOrders.value)} 单` },
  ]
  const maximum = Math.max(0, ...items.map(item => item.value))
  return items.map(item => ({ ...item, percent: maximum ? item.value / maximum * 100 : 0 }))
})
const attentionReports = computed(() => reportCards.value.filter(report => ['failed', 'warning'].includes(report.state)))
const attentionTitle = computed(() => attentionReports.value.length ? `${attentionReports.value.length} 份报表需要处理` : reportCards.value.every(report => report.state === 'success') ? '三份报表均显示导入成功' : '数据链路仍有待核对项')
const attentionDetail = computed(() => attentionReports.value.length ? `${attentionReports.value.map(report => report.name).join('、')}需要查看运行记录；首页不自动重试或认定已补齐。` : reportCards.value.every(report => report.state === 'success') ? '这是各报表最近一次运行状态，不代表三份报表属于同一业务日期，也不代表群日报已送达。' : '有报表尚无记录、运行中或状态待核对。请在运行记录里按业务日期确认。')

async function openTarget(id, path) {
  store.openTabFromId(id)
  if (path) await router.push(path)
}

async function loadOverview() {
  if (loading.value) return
  loading.value = true
  loadError.value = false
  syncError.value = false
  const jobs = [
    getDashboardStats().then(data => {
      if (!data?.ok) throw new Error('dashboard_stats_unavailable')
      stats.value = data.stats || {}
      statsLoaded.value = true
    }).catch(() => { loadError.value = true }),
  ]
  if (canViewAnalysis.value) jobs.push(getDashboardPosSummary().then(data => {
    if (!data?.ok || data.view !== 'cashier') throw new Error('pos_summary_unavailable')
    dailyRows.value = data.rows || []
    revenueLoaded.value = true
  }).catch(() => { loadError.value = true }))
  if (canViewImports.value) {
    jobs.push(...reportTypes.map(async type => {
      try {
        const data = await getSyncRuns({ report_type: type.key, page: 1, page_size: 5 })
        if (!data?.ok) throw new Error('sync_runs_unavailable')
        latestReports.value = { ...latestReports.value, [type.key]: data.runs?.[0] || null }
      } catch { syncError.value = true; loadError.value = true }
    }))
  }
  await Promise.all(jobs)
  loading.value = false
}

onMounted(loadOverview)
</script>

<style scoped>
.overview-page { --ink:#14243d; --muted:#64758d; --line:#e3eaf3; --blue:#285fda; max-width:1480px; margin:0 auto; padding:4px 2px 48px; color:var(--ink); }
.overview-hero { display:flex; justify-content:space-between; gap:32px; align-items:flex-end; padding:30px 34px; border-radius:20px; background:linear-gradient(120deg,#122d62 0%,#1a448b 65%,#245cb0 100%); color:#fff; box-shadow:0 14px 32px rgba(20,52,107,.13); }
.eyebrow,.section-kicker { display:block; font-size:11px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; }
.eyebrow { color:#a9cdfd; }
.hero-copy h1 { margin:9px 0 8px; font-size:30px; line-height:1.25; letter-spacing:.02em; }
.hero-copy p { margin:0; color:#d5e4fa; font-size:14px; line-height:1.6; }
.hero-side { display:flex; align-items:center; justify-content:flex-end; gap:10px; flex-wrap:wrap; }
.hero-date { width:100%; text-align:right; color:#c9ddfb; font-size:12px; }
.service-pill { display:inline-flex; align-items:center; gap:7px; min-height:34px; padding:0 11px; border:1px solid rgba(255,255,255,.22); border-radius:999px; background:rgba(255,255,255,.12); font-size:12px; white-space:nowrap; }
.service-dot { width:7px; height:7px; border-radius:50%; background:#7ce5b1; }
.service-pill.is-loading .service-dot { background:#f5cb71; }
.service-pill.is-error .service-dot { background:#ffa4a4; }
.refresh-button { display:inline-flex; align-items:center; gap:7px; min-height:44px; padding:0 13px; border:1px solid rgba(255,255,255,.3); border-radius:9px; background:transparent; color:#fff; font:inherit; font-size:12px; cursor:pointer; transition:background .2s; }
.refresh-button:hover,.refresh-button:focus-visible { background:rgba(255,255,255,.15); }
.refresh-button:disabled { opacity:.6; cursor:wait; }
.overview-section { margin-top:27px; }
.section-heading,.surface-head { display:flex; align-items:end; justify-content:space-between; gap:16px; margin-bottom:16px; }
.section-kicker { color:#5579b1; }
.section-heading h2,.surface-head h2 { margin:5px 0 0; font-size:19px; line-height:1.35; }
.section-note,.surface-head p { margin:6px 0 0; color:var(--muted); font-size:12px; }
.metric-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; }
.metric-card,.surface { border:1px solid var(--line); border-radius:16px; background:#fff; box-shadow:0 4px 18px rgba(23,51,96,.035); }
.metric-card { min-height:150px; padding:20px 21px 18px; }
.metric-top { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.metric-label { color:#4f6078; font-size:13px; font-weight:600; }
.metric-icon,.work-icon { display:inline-grid; place-items:center; flex:none; border-radius:11px; }
.metric-icon { width:34px; height:34px; font-size:18px; }
.tone-blue .metric-icon,.work-icon.tone-blue { color:#2760d6; background:#eaf2ff; }
.tone-teal .metric-icon,.work-icon.tone-teal { color:#087b74; background:#e3f7f3; }
.tone-amber .metric-icon,.work-icon.tone-amber { color:#a96b10; background:#fff3dc; }
.tone-violet .metric-icon,.work-icon.tone-violet { color:#6f5aa8; background:#f0edfb; }
.metric-value { margin-top:9px; color:#14243d; font-size:30px; font-weight:750; line-height:1.1; font-variant-numeric:tabular-nums; }
.metric-foot { margin:8px 0 0; color:var(--muted); font-size:12px; }
.overview-main-grid { display:grid; grid-template-columns:1.16fr 1fr; gap:16px; margin-top:21px; }
.overview-main-grid:has(.work-surface:first-child) { grid-template-columns:1fr; }
.surface { min-width:0; padding:22px 24px; }
.surface-head { align-items:start; }
.surface-head p { line-height:1.5; }
.text-link { display:inline-flex; align-items:center; gap:5px; flex:none; min-height:44px; border:0; background:transparent; color:#285fda; font:inherit; font-size:12px; font-weight:650; cursor:pointer; }
.text-link:hover { text-decoration:underline; }
.sync-list { margin-top:12px; }
.sync-row { display:flex; align-items:center; gap:12px; min-height:65px; border-top:1px solid #edf1f6; }
.sync-mark { display:grid; place-items:center; width:36px; height:36px; flex:none; border-radius:10px; background:#eef2f8; color:#7c8da5; }
.sync-mark.state-success { background:#e7f6ee; color:#168557; }
.sync-mark.state-failed,.sync-mark.state-warning { background:#fff1e6; color:#bb671b; }
.sync-mark.state-running { background:#eaf2ff; color:#2865cf; }
.sync-copy { display:flex; flex-direction:column; gap:4px; min-width:0; flex:1; }
.sync-copy strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
.sync-copy span { color:var(--muted); font-size:11px; }
.sync-state { flex:none; color:#6f7f95; font-size:12px; font-weight:600; }
.sync-state.state-success { color:#168557; }.sync-state.state-failed { color:#b53636; }.sync-state.state-warning { color:#a76019; }.sync-state.state-running { color:#2865cf; }
.inline-notice { margin-top:12px; padding:10px 12px; border-radius:8px; background:#fff5e8; color:#8f581a; font-size:12px; }
.work-list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin-top:16px; }
.work-link { display:flex; align-items:center; gap:11px; min-width:0; min-height:78px; padding:12px; border:1px solid #e7ecf4; border-radius:11px; background:#fbfcff; text-align:left; cursor:pointer; transition:border-color .2s,box-shadow .2s; }
.work-link:hover { border-color:#a8c2ee; box-shadow:0 5px 15px rgba(40,95,218,.09); }
.work-icon { width:38px; height:38px; font-size:18px; }
.work-copy { display:flex; flex-direction:column; gap:4px; min-width:0; flex:1; }
.work-copy strong { color:#24334a; font-size:13px; }.work-copy small { color:var(--muted); font-size:11px; line-height:1.35; }
.work-arrow { color:#8da3c1; }.empty-copy { color:var(--muted); font-size:13px; }
.overview-bottom { display:grid; grid-template-columns:minmax(0,1.45fr) minmax(280px,.75fr); gap:16px; margin-top:16px; }
.overview-bottom:has(.connection-surface:first-child),.overview-bottom:has(.more-surface:only-child) { grid-template-columns:1fr; }
.surface-head.compact { margin-bottom:14px; }
.surface-head.compact h2 { font-size:16px; }
.more-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
.more-link { display:flex; align-items:center; gap:9px; min-width:0; min-height:44px; padding:0 10px; border:1px solid #e9eef5; border-radius:9px; background:#fff; color:#425978; font:inherit; font-size:12px; text-align:left; cursor:pointer; }
.more-link:hover { color:#285fda; border-color:#b8cbed; background:#f8fbff; }
.more-link span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
.more-arrow { font-size:11px; color:#a7b4c7; }
.connection-row { display:flex; justify-content:space-between; gap:10px; padding:10px 0; border-top:1px solid #edf1f6; color:#53647d; font-size:12px; }
.connection-row strong { font-weight:650; }.connection-row .good { color:#168557; }.connection-row .muted { color:#9b6a24; }
.connection-surface p { margin:9px 0 0; color:#7d8aa0; font-size:11px; line-height:1.5; }
button:focus-visible { outline:3px solid #8eb9ff; outline-offset:2px; }
:global(html.theme-dark .overview-page) { --ink:#edf3ff; --muted:#aabbd3; --line:#33435d; --blue:#8db7ff; }
:global(html.theme-dark .overview-page .overview-hero) { background:linear-gradient(120deg,#10213e,#183969); box-shadow:none; }
:global(html.theme-dark .overview-page .metric-card),:global(html.theme-dark .overview-page .surface) { background:#202d42; box-shadow:none; }
:global(html.theme-dark .overview-page .metric-label),:global(html.theme-dark .overview-page .connection-row) { color:#c4d0e2; }
:global(html.theme-dark .overview-page .metric-value),:global(html.theme-dark .overview-page .work-copy strong) { color:#f2f6ff; }
:global(html.theme-dark .overview-page .metric-foot),:global(html.theme-dark .overview-page .section-note),:global(html.theme-dark .overview-page .surface-head p),:global(html.theme-dark .overview-page .work-copy small),:global(html.theme-dark .overview-page .connection-surface p) { color:#b5c5dc; }
:global(html.theme-dark .overview-page .work-link),:global(html.theme-dark .overview-page .more-link) { border-color:#3a4b64; background:#263750; color:#d5e3f7; }
:global(html.theme-dark .overview-page .work-link:hover),:global(html.theme-dark .overview-page .more-link:hover) { border-color:#81aaf0; background:#2c4262; }
:global(html.theme-dark .overview-page .sync-row),:global(html.theme-dark .overview-page .connection-row) { border-color:#354760; }
:global(html.theme-dark .overview-page .sync-state.state-empty),:global(html.theme-dark .overview-page .sync-copy span) { color:#b2c3db; }
:global(html.theme-dark .overview-page .text-link),:global(html.theme-dark .overview-page .section-kicker) { color:#9cc2ff; }
:global(html.theme-dark .overview-page .inline-notice) { background:#463924; color:#ffdaa2; }
@media (max-width:1100px) { .overview-main-grid,.overview-bottom { grid-template-columns:1fr; } .metric-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media (max-width:700px) { .overview-page { padding-bottom:28px; } .overview-hero { align-items:start; flex-direction:column; gap:16px; padding:24px; } .hero-copy h1 { font-size:26px; } .hero-side { justify-content:flex-start; } .hero-date { text-align:left; } .section-heading { align-items:start; flex-direction:column; gap:2px; } .metric-grid,.work-list { grid-template-columns:repeat(2,minmax(0,1fr)); } .metric-card { min-height:135px; padding:16px; } .metric-value { font-size:25px; } .surface { padding:18px; } .more-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media (max-width:480px) { .metric-grid,.work-list,.more-grid { grid-template-columns:1fr; } .metric-card { min-height:112px; } .metric-value { margin-top:4px; } .surface-head { flex-direction:column; } .text-link { padding:0; } }
@media (prefers-reduced-motion:reduce) { .refresh-button,.work-link { transition:none; } }
.home-page{--home-ink:#172943;--home-muted:#607186;--home-line:#e3e8ed;--home-paper:#fff;max-width:1480px;margin:0 auto;padding:2px 2px 55px;color:var(--home-ink)}
.home-masthead{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:18px;color:#536b89;font-size:12px;font-weight:650;letter-spacing:.08em}.home-masthead span:before{content:"";display:inline-block;width:20px;height:2px;margin-right:10px;background:#c39157;vertical-align:middle}.home-masthead b{margin:0 7px;color:#adb9c8}.home-masthead time{font-weight:500;letter-spacing:0}
.home-hero{position:relative;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(320px,.85fr);gap:30px;min-height:380px;overflow:hidden;border-radius:22px;background:radial-gradient(circle at 77% 8%,#305575 0,transparent 27%),linear-gradient(118deg,#102740,#142e4b 55%,#1e4364);color:#fff;box-shadow:0 20px 42px rgba(18,44,72,.13)}.hero-rings{position:absolute;right:-90px;top:-225px;width:540px;height:540px;border:1px solid rgba(226,192,140,.17);border-radius:50%;pointer-events:none}.hero-rings:after{content:"";position:absolute;inset:80px;border:1px solid rgba(226,192,140,.15);border-radius:50%}.hero-message{position:relative;z-index:1;padding:42px 0 40px 52px}.hero-kicker{display:flex;align-items:center;gap:12px;margin:0 0 27px;color:#e8c18b;font-size:12px;font-weight:700;letter-spacing:.12em}.hero-kicker span{display:block;width:24px;height:1px;background:#be935f}.hero-message h1{margin:0;font-size:clamp(31px,3vw,47px);line-height:1.35;letter-spacing:.02em}.hero-message h1 em{color:#e8c18b;font-style:normal}.hero-message>p:not(.hero-kicker){max-width:440px;margin:18px 0 0;color:#d0ddec;font-size:14px;line-height:1.7}.hero-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:28px}.hero-actions button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 18px;border-radius:8px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;transition:background .2s,border-color .2s}.hero-primary{border:1px solid #e4be88;background:#e4be88;color:#17304a}.hero-primary:hover{background:#f3d09b}.hero-secondary{border:1px solid rgba(255,255,255,.35);background:transparent;color:#fff}.hero-secondary:hover{background:rgba(255,255,255,.12)}
.hero-feature{position:relative;z-index:1;align-self:center;min-width:0;margin:27px 31px 27px 0;padding:28px;border:1px solid rgba(255,255,255,.18);border-radius:16px;background:rgba(255,255,255,.095);backdrop-filter:blur(5px)}.feature-head,.feature-bottom{display:flex;justify-content:space-between;gap:10px}.feature-head{color:#d5e1ee;font-size:12px}.feature-head small{color:#dfbb87;font-size:10px;letter-spacing:.15em}.feature-value{display:block;margin:26px 0 6px;font-size:clamp(30px,3vw,46px);line-height:1.2;font-variant-numeric:tabular-nums;white-space:nowrap}.hero-feature p{margin:0;color:#d2deeb;font-size:12px}.feature-bottom{margin-top:25px;padding-top:19px;border-top:1px solid rgba(255,255,255,.22)}.feature-bottom div{display:flex;flex-direction:column;gap:7px;min-width:0}.feature-bottom span{color:#c5d4e4;font-size:11px}.feature-bottom b{font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.home-notice{display:flex;align-items:center;gap:10px;margin-top:15px;padding:11px 14px;border:1px solid #edd1a8;border-radius:9px;background:#fff6e9;color:#795125;font-size:13px}.home-notice button{margin-left:auto;border:0;background:transparent;color:inherit;text-decoration:underline;cursor:pointer}
.home-brief{margin-top:33px}.home-section-head>span,.panel-head>div>span,.home-foundation>div>span{color:#a47749;font-size:11px;font-weight:800;letter-spacing:.14em}.home-section-head h2,.panel-head h2,.home-foundation h2{margin:7px 0 0;font-size:23px;line-height:1.3}.home-section-head p,.home-foundation p{margin:7px 0 0;color:var(--home-muted);font-size:13px;line-height:1.6}.brief-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(280px,.8fr);gap:14px;margin-top:17px}.brief-feature,.brief-attention{min-height:205px;padding:27px 30px;border-radius:15px}.brief-feature{border:1px solid #e9e2d5;background:#f3f0e9}.brief-attention{border:1px solid var(--home-line);background:var(--home-paper)}.brief-label{color:#90683f;font-size:12px;font-weight:750}.brief-label:before{content:"";display:inline-block;width:7px;height:7px;margin-right:8px;border-radius:50%;background:#ba8850}.brief-feature h3,.brief-attention h3{margin:20px 0 8px;font-size:21px;line-height:1.45}.brief-attention h3{font-size:18px}.brief-feature p,.brief-attention p{margin:0;color:#52647a;font-size:13px;line-height:1.7}.brief-feature small{display:block;margin-top:20px;color:#867967;font-size:11px}.brief-link{display:inline-flex;align-items:center;gap:6px;min-height:40px;margin-top:12px;padding:0;border:0;background:transparent;color:#285c8e;font:inherit;font-size:12px;font-weight:700;cursor:pointer}
.home-middle{display:grid;grid-template-columns:minmax(0,1.07fr) minmax(0,.93fr);gap:14px;margin-top:20px}.home-panel{min-width:0;min-height:290px;padding:27px 30px;border:1px solid var(--home-line);border-radius:15px;background:var(--home-paper)}.panel-head{display:flex;align-items:end;justify-content:space-between;gap:12px;margin-bottom:17px}.panel-head h2{font-size:20px}.panel-head>small,.panel-note,.panel-lead{color:var(--home-muted);font-size:11px}.store-line{display:grid;grid-template-columns:27px minmax(100px,1.2fr) minmax(35px,.65fr) auto;align-items:center;gap:12px;min-height:54px;border-top:1px solid var(--home-line)}.store-line i,.report-line i{color:#b3946c;font-family:Georgia,serif;font-size:17px;font-style:normal}.store-line>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:650}.store-line>strong{font-size:13px;font-variant-numeric:tabular-nums}.store-bar{height:5px;overflow:hidden;border-radius:3px;background:#e9edf1}.store-bar b{display:block;height:100%;border-radius:3px;background:#b9864f}.panel-note{margin:16px 0 0;line-height:1.5}.panel-empty{display:flex;align-items:center;justify-content:center;flex-direction:column;min-height:170px;color:var(--home-muted);gap:4px}.panel-empty b{color:#c6ae8f;font-family:Georgia,serif;font-size:40px;font-weight:400}.panel-empty span{font-size:14px;font-weight:650}.panel-empty small{font-size:11px}.panel-lead{margin:-6px 0 14px}.report-line{display:flex;align-items:center;gap:12px;min-height:55px;border-top:1px solid var(--home-line)}.report-line>div{display:flex;flex:1;min-width:0;flex-direction:column;gap:3px}.report-line strong{font-size:13px}.report-line small{color:var(--home-muted);font-size:11px}.report-line>span{flex:none;color:#758195;font-size:11px;font-weight:750}.report-line>span.state-success{color:#13805f}.report-line>span.state-failed{color:#b53b3b}.report-line>span.state-warning{color:#a76524}.report-line>span.state-running{color:#2c66ac}.panel-warning{color:#96642c;font-size:11px}
.home-foundation{display:flex;align-items:center;justify-content:space-between;gap:26px;margin-top:20px;padding:27px 30px;border:1px solid var(--home-line);border-radius:15px;background:var(--home-paper)}.home-foundation h2{font-size:18px}.home-foundation dl{display:flex;gap:35px;margin:0}.home-foundation dl>div{display:flex;flex-direction:column-reverse;gap:4px;min-width:78px}.home-foundation dt{color:var(--home-muted);font-size:11px}.home-foundation dd{margin:0;font-size:24px;font-weight:750;font-variant-numeric:tabular-nums}.home-page button:focus-visible{outline:3px solid #8bb8fc;outline-offset:3px}
:global(html.theme-dark .home-page){--home-ink:#edf3fa;--home-muted:#b9c7d7;--home-line:#39495b;--home-paper:#202f40}:global(html.theme-dark .home-page .home-masthead){color:#bbcadb}:global(html.theme-dark .home-page .brief-feature){border-color:#51483c;background:#39352f}:global(html.theme-dark .home-page .brief-feature p),:global(html.theme-dark .home-page .brief-attention p){color:#c2cedb}:global(html.theme-dark .home-page .brief-feature small){color:#c9b79d}:global(html.theme-dark .home-page .store-bar){background:#3b4b5d}:global(html.theme-dark .home-page .home-notice){border-color:#765b38;background:#443827;color:#f4d3a5}
@media(max-width:1100px){.home-hero{grid-template-columns:1fr 1fr}.hero-message{padding-left:32px}.hero-feature{margin-right:20px}.home-middle{grid-template-columns:1fr}}
@media(max-width:800px){.home-hero{grid-template-columns:1fr;gap:0}.hero-message{padding:32px 30px 10px}.hero-feature{margin:14px 30px 30px}.brief-grid{grid-template-columns:1fr}.home-foundation{align-items:flex-start;flex-direction:column}.home-foundation dl{width:100%;justify-content:space-between}}
@media(max-width:500px){.home-masthead{align-items:flex-start;flex-direction:column;gap:7px}.home-hero{border-radius:15px}.hero-message{padding:27px 22px 10px}.hero-message h1{font-size:31px}.hero-feature{margin:14px 22px 22px;padding:21px}.feature-value{font-size:31px}.feature-bottom{gap:7px}.feature-bottom b{font-size:11px}.brief-feature,.brief-attention,.home-panel,.home-foundation{padding:22px}.store-line{grid-template-columns:22px minmax(70px,1fr) auto}.store-bar{display:none}.store-line>span,.store-line>strong{font-size:12px}.home-foundation dl{gap:10px}.home-foundation dd{font-size:21px}}
@media(prefers-reduced-motion:reduce){.hero-actions button{transition:none}}

/* Local homepage visual revision: technical type, precise numerals and cool data surfaces. */
.home-page{--home-ink:#10243c;--home-muted:#5b6e83;--home-line:#dce7f1;--home-paper:#fff;font-family:"Segoe UI","Microsoft YaHei UI","PingFang SC",sans-serif}
.home-masthead{color:#3e648a;font-family:"Bahnschrift","Segoe UI",sans-serif;font-size:12px;font-weight:700;letter-spacing:.11em}
.home-masthead span:before{width:24px;height:3px;border-radius:2px;background:#00a8c8;box-shadow:0 0 10px rgba(0,184,224,.35)}
.home-masthead b{color:#80a6c5}
.home-masthead time{font-family:"Bahnschrift","Segoe UI",sans-serif;font-variant-numeric:tabular-nums;letter-spacing:.03em}
.home-hero{border:1px solid #204d75;border-radius:17px;background:radial-gradient(circle at 88% 8%,rgba(15,156,198,.25),transparent 26%),linear-gradient(120deg,#07172d 0%,#0a2440 60%,#103756 100%);box-shadow:0 18px 36px rgba(9,38,70,.16)}
.home-hero:before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(66,183,219,.065) 1px,transparent 1px),linear-gradient(90deg,rgba(66,183,219,.065) 1px,transparent 1px);background-size:32px 32px;mask-image:linear-gradient(90deg,transparent 20%,#000);pointer-events:none}
.hero-rings{border-color:rgba(57,207,235,.25)}.hero-rings:after{border-color:rgba(57,207,235,.18)}
.hero-kicker{color:#75ddf2;font-family:"Bahnschrift","Microsoft YaHei UI",sans-serif;font-weight:750;letter-spacing:.15em}.hero-kicker span{background:#37c9e3;box-shadow:0 0 12px rgba(55,201,227,.55)}
.hero-message h1{font-family:"Segoe UI","Microsoft YaHei UI","PingFang SC",sans-serif;font-weight:800;letter-spacing:-.025em;line-height:1.32}.hero-message h1 em{color:#55d5ec;font-weight:800}
.hero-message>p:not(.hero-kicker){color:#c3d8e7;font-size:15px}
.hero-actions button{border-radius:7px}.hero-primary{border-color:#50d7ed;background:#50d7ed;color:#05283d;box-shadow:0 6px 20px rgba(52,207,237,.22)}.hero-primary:hover{background:#91e8f5}.hero-secondary{border-color:rgba(117,221,242,.48)}
.hero-feature{border-color:rgba(98,219,242,.33);border-radius:12px;background:linear-gradient(140deg,rgba(20,76,111,.62),rgba(8,31,56,.87));box-shadow:inset 0 1px 0 rgba(159,236,249,.13),0 18px 35px rgba(0,10,30,.13);backdrop-filter:none}
.feature-head{color:#b6ddec;font-weight:650}.feature-head small{color:#75ddf2;font-family:"Bahnschrift","Consolas",monospace;font-size:11px;font-weight:700;letter-spacing:.13em}
.feature-value{color:#fff;font-family:"Bahnschrift","Arial Narrow","Segoe UI",sans-serif;font-size:clamp(36px,3.6vw,60px);font-weight:700;letter-spacing:-.035em;font-variant-numeric:tabular-nums lining-nums;font-feature-settings:"tnum"}
.hero-feature p{color:#bfd9e6}.feature-bottom{border-color:rgba(100,207,230,.28)}.feature-bottom span{color:#9fc7d8;font-size:12px}.feature-bottom b{font-family:"Bahnschrift","Segoe UI",sans-serif;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums lining-nums}
.home-section-head>span,.panel-head>div>span,.home-foundation>div>span{color:#167eaa;font-family:"Bahnschrift","Microsoft YaHei UI",sans-serif;font-size:12px;letter-spacing:.11em}
.home-section-head h2,.panel-head h2,.home-foundation h2{font-family:"Segoe UI","Microsoft YaHei UI",sans-serif;font-weight:760;letter-spacing:-.02em}
.brief-feature{border-color:#cfe3ee;border-radius:12px;background:linear-gradient(118deg,#edf8fc,#f5fbfe 72%);box-shadow:inset 3px 0 0 #35b7d4}.brief-attention,.home-panel,.home-foundation{border-radius:12px;box-shadow:0 7px 22px rgba(17,55,93,.035)}
.brief-label{color:#087ca2;font-size:12px;font-weight:800;letter-spacing:.06em}.brief-label:before{border-radius:2px;background:#28bbd8;box-shadow:0 0 8px rgba(40,187,216,.3)}
.brief-feature h3,.brief-attention h3{font-weight:760;letter-spacing:-.015em}.brief-feature p,.brief-attention p{color:#465f76}.brief-feature small{color:#4b7894;font-family:"Bahnschrift","Microsoft YaHei UI",sans-serif;font-size:12px;font-variant-numeric:tabular-nums}.brief-link{color:#0879a7;font-size:13px}
.panel-head>small,.panel-note,.panel-lead{font-size:12px}.store-line i,.report-line i{color:#168ab4;font-family:"Bahnschrift","Consolas",monospace;font-size:16px;font-style:normal;font-weight:700;letter-spacing:.02em}
.store-line>strong{font-family:"Bahnschrift","Segoe UI",sans-serif;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums lining-nums}.store-bar{background:#e3f0f5}.store-bar b{background:linear-gradient(90deg,#167bb6,#29c8dd)}.panel-empty b{color:#79b9cc;font-family:"Bahnschrift","Consolas",monospace}
.report-line>span{font-family:"Bahnschrift","Microsoft YaHei UI",sans-serif;font-size:12px}.report-line>span.state-success{color:#087a64}.report-line>span.state-running{color:#086fa9}
.home-foundation dd{color:#0c517e;font-family:"Bahnschrift","Arial Narrow","Segoe UI",sans-serif;font-size:30px;font-weight:720;letter-spacing:-.03em;font-variant-numeric:tabular-nums lining-nums}.home-foundation dt{font-size:12px}
:global(html.theme-dark .home-page){--home-ink:#e9f5fb;--home-muted:#b1c6d5;--home-line:#2d5068;--home-paper:#142b40}
:global(html.theme-dark .home-page .home-masthead){color:#a6d7e8}
:global(html.theme-dark .home-page .brief-feature){border-color:#286078;background:linear-gradient(118deg,#123c55,#16364b)}
:global(html.theme-dark .home-page .brief-feature p),:global(html.theme-dark .home-page .brief-attention p){color:#c8dce7}
:global(html.theme-dark .home-page .brief-feature small){color:#a5d3e3}
:global(html.theme-dark .home-page .home-foundation dd){color:#78d9ef}
:global(html.theme-dark .home-page .store-bar){background:#29475b}
@media(max-width:500px){.home-hero{border-radius:12px}.feature-value{font-size:clamp(24px,8vw,36px);white-space:normal;overflow-wrap:anywhere}.feature-bottom{flex-wrap:wrap}.feature-bottom b{font-size:12px}.home-foundation dd{font-size:25px}}
.summary-line{display:grid;grid-template-columns:64px minmax(0,1fr) minmax(100px,auto) 50px;align-items:center;gap:14px;min-height:62px;border-top:1px solid var(--home-line)}
.summary-label{font-size:14px;font-weight:750;white-space:nowrap}.summary-track{height:11px;overflow:hidden;border-radius:6px;background:#e3f0f5}.summary-fill{display:block;height:100%;border-radius:6px;background:linear-gradient(90deg,#167bb6,#29c8dd)}
.summary-fill--actual{background:linear-gradient(90deg,#117f97,#35c4bd)}.summary-fill--orders{background:linear-gradient(90deg,#4779bd,#82a9ee)}
.summary-value{font-family:"Bahnschrift","Segoe UI",sans-serif;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums lining-nums;text-align:right;white-space:nowrap}.summary-percent{color:var(--home-muted);font-family:"Bahnschrift","Consolas",monospace;font-size:12px;font-variant-numeric:tabular-nums;text-align:right}
:global(html.theme-dark .home-page .summary-track){background:#29475b}
@media(max-width:600px){.home-panel .panel-head{align-items:flex-start;flex-direction:column;gap:5px}.summary-line{grid-template-columns:minmax(0,1fr) auto;gap:7px 12px;padding:12px 0}.summary-track{grid-column:1;grid-row:2}.summary-value{grid-column:2;grid-row:1}.summary-percent{grid-column:2;grid-row:2}}
</style>
