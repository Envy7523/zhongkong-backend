<template>
  <div class="sync-runs-page">
    <!-- ===== 顶部概览 ===== -->
    <el-card shadow="never" class="overview-card">
      <template #header>
        <div class="card-header">
          <span class="title">综合营业统计 · 自动导入记录</span>
          <div class="header-actions">
            <el-tag size="small" type="info" effect="plain">今日：{{ overview.today || '-' }}</el-tag>
            <el-button size="small" :icon="Refresh" :loading="loading" @click="loadAll">刷新</el-button>
          </div>
        </div>
      </template>
      <el-row :gutter="12">
        <el-col :xs="12" :sm="8" :md="4">
          <div class="stat">
            <div class="stat-label">最近一次运行</div>
            <div class="stat-value">
              <el-tag v-if="overview.latest" size="small" :type="statusType(overview.latest.status)">{{ statusLabel(overview.latest.status) }}</el-tag>
              <span v-else class="muted">暂无</span>
            </div>
            <div class="stat-sub">{{ overview.latest ? overview.latest.business_date + ' · ' + overview.latest.phase : '-' }}</div>
          </div>
        </el-col>
        <el-col :xs="12" :sm="8" :md="4">
          <div class="stat">
            <div class="stat-label">最近成功时间</div>
            <div class="stat-value small">{{ overview.last_success_at ? fmtTime(overview.last_success_at) : '暂无' }}</div>
            <div class="stat-sub">{{ overview.last_success_business_date || '-' }}</div>
          </div>
        </el-col>
        <el-col :xs="8" :sm="8" :md="3">
          <div class="stat"><div class="stat-label">今日成功</div><div class="stat-value ok">{{ overview.today_counts.success }}</div></div>
        </el-col>
        <el-col :xs="8" :sm="8" :md="3">
          <div class="stat"><div class="stat-label">今日失败</div><div class="stat-value bad">{{ overview.today_counts.failed }}</div></div>
        </el-col>
        <el-col :xs="8" :sm="8" :md="3">
          <div class="stat"><div class="stat-label">等待人工</div><div class="stat-value warn">{{ overview.today_counts.waiting_human }}</div></div>
        </el-col>
        <el-col :xs="12" :sm="8" :md="3">
          <div class="stat"><div class="stat-label">运行中</div><div class="stat-value">{{ overview.today_counts.running }}</div></div>
        </el-col>
        <el-col :xs="12" :sm="8" :md="4">
          <div class="stat"><div class="stat-label">待处理异常</div><div class="stat-value bad">{{ overview.pending_exceptions }}</div></div>
        </el-col>
      </el-row>
    </el-card>

    <!-- ===== 筛选 ===== -->
    <el-card shadow="never" class="filter-card">
      <div class="filters">
        <el-select v-model="filters.platform" placeholder="采集站点" clearable size="small" style="width: 120px" @change="reload">
          <el-option label="美团管家" value="meituan" />
        </el-select>
        <el-select v-model="filters.report_type" placeholder="报表类型" clearable size="small" style="width: 190px" @change="reload">
          <el-option label="综合营业统计" value="cashier_composite" />
        </el-select>
        <el-date-picker
          v-model="dateRange" type="daterange" size="small" unlink-panels
          range-separator="至" start-placeholder="业务日期起" end-placeholder="业务日期止"
          value-format="YYYY-MM-DD" style="width: 260px" @change="reload"
        />
        <el-select v-model="filters.status" placeholder="状态" clearable size="small" style="width: 130px" @change="reload">
          <el-option label="成功" value="success" />
          <el-option label="失败" value="failed" />
          <el-option label="运行中" value="running" />
          <el-option label="等待人工" value="waiting_human" />
        </el-select>
        <el-select v-model="filters.is_backfill" placeholder="是否补录" clearable size="small" style="width: 120px" @change="reload">
          <el-option label="仅补录" value="1" />
          <el-option label="仅实时" value="0" />
        </el-select>
        <el-select v-model="filters.imported" placeholder="是否已导入" clearable size="small" style="width: 130px" @change="reload">
          <el-option label="已导入" value="1" />
          <el-option label="未导入" value="0" />
        </el-select>
        <el-select v-model="filters.pushed" placeholder="是否已推送" clearable size="small" style="width: 130px" @change="reload">
          <el-option label="已推送" value="1" />
          <el-option label="未推送" value="0" />
        </el-select>
        <el-button size="small" :icon="Refresh" @click="resetFilters">重置</el-button>
      </div>
    </el-card>

    <!-- ===== 运行列表 ===== -->
    <el-card shadow="never">
      <el-table :data="runs" v-loading="loading" size="small" border stripe @row-click="openDetail" style="width: 100%">
        <el-table-column label="业务来源" width="100"><template #default>收银系统</template></el-table-column>
        <el-table-column label="采集站点" width="100">
          <template #default="{ row }">{{ row.platform === 'meituan' ? '美团管家' : row.platform }}</template>
        </el-table-column>
        <el-table-column label="报表类型" width="140">
          <template #default="{ row }">{{ row.report_type === 'cashier_composite' ? '综合营业统计' : row.report_type }}</template>
        </el-table-column>
        <el-table-column prop="business_date" label="业务日期" width="110" />
        <el-table-column prop="task_id" label="task_id" width="130" show-overflow-tooltip />
        <el-table-column label="开始" width="150"><template #default="{ row }">{{ fmtTime(row.started_at || row.first_event_at) }}</template></el-table-column>
        <el-table-column label="结束" width="150"><template #default="{ row }">{{ fmtTime(row.finished_at || row.last_event_at) }}</template></el-table-column>
        <el-table-column label="耗时" width="90"><template #default="{ row }">{{ fmtDuration(row.duration_ms) }}</template></el-table-column>
        <el-table-column prop="phase" label="当前阶段" width="150" show-overflow-tooltip />
        <el-table-column label="状态" width="150">
          <template #default="{ row }">
            <el-tag size="small" :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag>
            <el-tag v-if="row.is_backfill" size="small" type="warning" effect="plain" class="ml4">历史补录</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="失败原因" min-width="180" show-overflow-tooltip>
          <template #default="{ row }"><span class="muted">{{ row.failure_reason || '-' }}</span></template>
        </el-table-column>
        <el-table-column label="原始文件名" min-width="200" show-overflow-tooltip>
          <template #default="{ row }"><span class="muted">{{ row.original_filename || '-' }}</span></template>
        </el-table-column>
        <el-table-column label="大小" width="90"><template #default="{ row }">{{ fmtSize(row.file_size) }}</template></el-table-column>
        <el-table-column label="SHA-256 前缀" width="130">
          <template #default="{ row }"><code class="sha">{{ row.sha256_prefix || '-' }}</code></template>
        </el-table-column>
        <el-table-column label="导入批次" width="90"><template #default="{ row }">{{ row.import_batch_id || '-' }}</template></el-table-column>
        <el-table-column label="门店(原始/匹配)" width="130">
          <template #default="{ row }">{{ row.raw_store_count ?? '-' }} / {{ row.matched_store_count ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="允许推送" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.ready_to_push ? 'success' : 'info'" effect="plain">{{ row.ready_to_push ? '是' : '否' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="推送状态" width="110">
          <template #default="{ row }">
            <el-tag v-if="row.push_status" size="small" :type="row.push_status === 'success' ? 'success' : 'danger'">{{ row.push_status === 'success' ? '已推送' : '推送失败' }}</el-tag>
            <span v-else class="muted">{{ row.pushed ? '已推送' : '未推送' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }"><el-button link type="primary" size="small" @click.stop="openDetail(row)">详情</el-button></template>
        </el-table-column>
      </el-table>
      <div class="pager">
        <el-pagination
          background layout="total, sizes, prev, pager, next" :total="total"
          v-model:current-page="page" v-model:page-size="pageSize" :page-sizes="[20, 50, 100]"
          @current-change="loadRuns" @size-change="loadRuns"
        />
      </div>
    </el-card>

    <!-- ===== 详情抽屉 ===== -->
    <el-drawer v-model="drawer" title="运行详情" size="54%">
      <div v-if="detailLoading" v-loading="true" style="height: 200px" />
      <div v-else-if="detail">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="task_id">{{ detail.run.task_id }}</el-descriptions-item>
          <el-descriptions-item label="业务日期">{{ detail.run.business_date }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag size="small" :type="statusType(detail.run.status)">{{ statusLabel(detail.run.status) }}</el-tag>
            <el-tag v-if="detail.run.is_backfill" size="small" type="warning" effect="plain" class="ml4">历史补录</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="当前阶段">{{ detail.run.phase || '-' }}</el-descriptions-item>
          <el-descriptions-item label="开始">{{ fmtTime(detail.run.started_at || detail.run.first_event_at) }}</el-descriptions-item>
          <el-descriptions-item label="结束">{{ fmtTime(detail.run.finished_at || detail.run.last_event_at) }}</el-descriptions-item>
          <el-descriptions-item label="耗时">{{ fmtDuration(detail.run.duration_ms) }}</el-descriptions-item>
          <el-descriptions-item label="截图数量">{{ detail.run.screenshot_count || 0 }}</el-descriptions-item>
          <el-descriptions-item label="原始文件名">{{ detail.run.original_filename || '-' }}</el-descriptions-item>
          <el-descriptions-item label="文件大小">{{ fmtSize(detail.run.file_size) }}</el-descriptions-item>
          <el-descriptions-item label="SHA-256 前缀"><code class="sha">{{ detail.run.sha256_prefix || '-' }}</code></el-descriptions-item>
          <el-descriptions-item label="导入批次">{{ detail.run.import_batch_id || '-' }}</el-descriptions-item>
          <el-descriptions-item label="门店(原始/匹配)">{{ detail.run.raw_store_count ?? '-' }} / {{ detail.run.matched_store_count ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="允许推送">{{ detail.run.ready_to_push ? '是' : '否' }}</el-descriptions-item>
        </el-descriptions>

        <el-alert
          v-if="detail.run.is_backfill || detail.run.not_a_realtime_success"
          class="mt12" type="warning" :closable="false" show-icon
          title="历史补录记录（非实时成功）"
          description="该记录由历史归档文件重建：reconstructed=true、not_a_realtime_success=true、ready_to_push=false，不代表一次完整成功的实时同步。"
        />

        <el-alert v-if="detail.run.failure_reason" class="mt12" type="error" :closable="false" show-icon title="失败原因" :description="detail.run.failure_reason" />

        <h4 class="section">阶段时间线</h4>
        <el-timeline>
          <el-timeline-item
            v-for="(e, i) in detail.events" :key="i"
            :timestamp="fmtTime(e.at)" placement="top"
            :type="e.status === 'failed' ? 'danger' : (e.status === 'success' ? 'success' : 'primary')"
          >
            <div class="tl-stage">{{ e.stage }}</div>
            <div v-if="hasKeys(e.detail)" class="tl-detail">{{ compactJson(e.detail) }}</div>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-if="!detail.events.length" description="暂无阶段事件" />

        <h4 class="section">脱敏证据摘要</h4>
        <pre class="evidence">{{ compactJson(detail.evidence) }}</pre>

        <h4 class="section">文件校验结果</h4>
        <pre class="evidence">{{ compactJson(detail.validation) }}</pre>

        <el-alert
          class="mt12" type="info" :closable="false"
          title="原始 Excel 下载在本版本中被禁用"
          description="为避免误取原始报表文件，本页面只展示脱敏后的元数据与校验结果；需要原始文件请走既有的数据导入流程。"
        />
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { getSyncRuns, getSyncRunsOverview, getSyncRunDetail } from '@/api'

const loading = ref(false)
const runs = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const dateRange = ref(null)
const overview = ref({
  today: '', latest: null, last_success_at: null, last_success_business_date: null,
  today_counts: { success: 0, failed: 0, waiting_human: 0, running: 0 }, pending_exceptions: 0,
})
const filters = reactive({ platform: '', report_type: '', status: '', is_backfill: '', imported: '', pushed: '' })

const drawer = ref(false)
const detail = ref(null)
const detailLoading = ref(false)

const STATUS_LABEL = { success: '成功', failed: '失败', running: '运行中', waiting_human: '等待人工' }
const STATUS_TYPE = { success: 'success', failed: 'danger', running: 'primary', waiting_human: 'warning' }
const statusLabel = (s) => STATUS_LABEL[s] || s || '-'
const statusType = (s) => STATUS_TYPE[s] || 'info'

function fmtTime(v) {
  if (!v) return '-'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function fmtDuration(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '-'
  if (n < 1000) return `${n} ms`
  const s = Math.round(n / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  return `${m} 分 ${s % 60} 秒`
}
function fmtSize(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
const hasKeys = (o) => !!o && typeof o === 'object' && Object.keys(o).length > 0
function compactJson(o) {
  if (!hasKeys(o)) return '（无）'
  try { return JSON.stringify(o, null, 1) } catch { return '（无法展示）' }
}

function queryParams() {
  const p = {}
  for (const [k, v] of Object.entries(filters)) if (v !== '' && v !== null && v !== undefined) p[k] = v
  if (dateRange.value && dateRange.value.length === 2) {
    p.date_from = dateRange.value[0]
    p.date_to = dateRange.value[1]
  }
  return p
}

async function loadOverview() {
  try {
    const data = await getSyncRunsOverview()
    if (data && data.ok) {
      overview.value = {
        today: data.today,
        latest: data.latest,
        last_success_at: data.last_success_at,
        last_success_business_date: data.last_success_business_date,
        today_counts: data.today_counts || overview.value.today_counts,
        pending_exceptions: data.pending_exceptions || 0,
      }
    }
  } catch (e) { /* 概览失败不阻断列表 */ }
}
async function loadRuns() {
  loading.value = true
  try {
    const data = await getSyncRuns({ ...queryParams(), page: page.value, page_size: pageSize.value })
    if (data && data.ok) { runs.value = data.runs || []; total.value = data.total || 0 }
  } finally { loading.value = false }
}
function reload() { page.value = 1; loadRuns() }
function resetFilters() {
  for (const k of Object.keys(filters)) filters[k] = ''
  dateRange.value = null
  reload()
}
async function loadAll() { await Promise.all([loadOverview(), loadRuns()]) }

async function openDetail(row) {
  if (!row || !row.id) return
  drawer.value = true
  detailLoading.value = true
  detail.value = null
  try {
    const data = await getSyncRunDetail(row.id)
    if (data && data.ok) detail.value = { run: data.run, events: data.events || [], validation: data.validation || {}, evidence: data.evidence || {} }
  } finally { detailLoading.value = false }
}

onMounted(loadAll)
</script>

<style scoped>
.sync-runs-page { padding: 12px; display: flex; flex-direction: column; gap: 12px; }
.card-header { display: flex; align-items: center; justify-content: space-between; }
.card-header .title { font-weight: 600; font-size: 15px; }
.header-actions { display: flex; align-items: center; gap: 8px; }
.stat { padding: 6px 2px; }
.stat-label { color: var(--el-text-color-secondary); font-size: 12px; }
.stat-value { font-size: 20px; font-weight: 600; line-height: 1.5; }
.stat-value.small { font-size: 14px; }
.stat-value.ok { color: var(--el-color-success); }
.stat-value.bad { color: var(--el-color-danger); }
.stat-value.warn { color: var(--el-color-warning); }
.stat-sub { color: var(--el-text-color-secondary); font-size: 12px; }
.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.muted { color: var(--el-text-color-secondary); }
.ml4 { margin-left: 4px; }
.sha { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.pager { display: flex; justify-content: flex-end; margin-top: 10px; }
.section { margin: 16px 0 6px; font-size: 14px; }
.evidence { background: var(--el-fill-color-light); border-radius: 6px; padding: 8px 10px; font-size: 12px; max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
.tl-stage { font-weight: 600; font-size: 13px; }
.tl-detail { color: var(--el-text-color-secondary); font-size: 12px; white-space: pre-wrap; word-break: break-all; }
.mt12 { margin-top: 12px; }
</style>
