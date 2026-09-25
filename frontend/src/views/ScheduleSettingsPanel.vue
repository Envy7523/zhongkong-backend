<template>
  <div class="schedule-panel" v-loading="loading">
    <header class="schedule-hero">
      <div>
        <p class="eyebrow">AUTOMATION · ASIA/SHANGHAI</p>
        <h1>自动导报表与日报时间</h1>
        <p>只设置未来的执行计划；保存不会立刻导出、导入、补跑或发送日报。</p>
      </div>
      <el-button :disabled="loading" @click="load">刷新状态</el-button>
    </header>

    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="schedule-alert" />
    <el-alert title="当前里程碑仅包含收银系统“综合营业统计”；其他报表独立验收。同步与日报是两个独立计划，日报发送由中控负责。" type="info" :closable="false" show-icon class="schedule-alert" />

    <section class="schedule-card" aria-label="计划设置">
      <div class="section-heading">
        <div><h2>每日计划</h2><p>时区固定为北京时间。关闭开关后仍可先保存时间。</p></div>
        <span class="schedule-badge">{{ scheduleStatus }}</span>
      </div>
      <div class="schedule-grid">
        <div class="schedule-job">
          <div class="job-head"><div><strong>自动下载并导入报表</strong><small>收银系统综合营业统计（美团管家采集）→ 校验 → 中控</small></div><el-switch v-model="form.sync_enabled" aria-label="启用自动同步" /></div>
          <label for="sync-time">每天执行时间</label>
          <input id="sync-time" v-model="form.sync_time" type="time" step="60" />
          <p>下次计划：{{ formatNext(snapshot.next_run?.sync) }}</p>
        </div>
        <div class="schedule-job">
          <div class="job-head"><div><strong>自动发送日报</strong><small>由中控侧核验数据后发送</small></div><el-switch v-model="form.report_enabled" aria-label="启用自动日报" /></div>
          <label for="report-time">每天执行时间</label>
          <input id="report-time" v-model="form.report_time" type="time" step="60" />
          <p>下次计划：{{ formatNext(snapshot.next_run?.report) }}</p>
        </div>
      </div>
      <div class="actions">
        <el-button type="primary" :loading="saving" :disabled="!loaded || loading" @click="save">保存未来计划</el-button>
        <el-button type="danger" plain :loading="disabling" :disabled="!loaded || loading || (!saved.sync_enabled && !saved.report_enabled)" @click="disable">一键停用</el-button>
        <span>设置保存后不补跑；是否真正到点执行，以运行记录为准。</span>
      </div>
      <p v-if="snapshot.config?.updated_at" class="update-note">上次修改：{{ formatDateTime(snapshot.config.updated_at) }} · {{ snapshot.config.updated_by_name || '系统' }}</p>
    </section>

    <section class="schedule-card" aria-label="最近运行">
      <div class="section-heading"><div><h2>最近运行</h2><p>区分“计划已保存”和“任务实际完成”。</p></div></div>
      <div class="run-summary">
        <div><small>最近同步</small><strong>{{ runLabel(snapshot.last?.sync) }}</strong></div>
        <div><small>最近日报</small><strong>{{ runLabel(snapshot.last?.report) }}</strong></div>
      </div>
      <el-table :data="snapshot.recent_runs || []" size="small" empty-text="暂无运行记录" class="runs-table">
        <el-table-column label="业务日期" prop="business_date" min-width="120" />
        <el-table-column label="任务" min-width="100"><template #default="{ row }">{{ row.job === 'sync' ? '报表同步' : row.job === 'report' ? '日报发送' : row.job }}</template></el-table-column>
        <el-table-column label="状态" prop="status" min-width="110" />
        <el-table-column label="原因" min-width="180" show-overflow-tooltip><template #default="{ row }">{{ row.reason || '—' }}</template></el-table-column>
      </el-table>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { disableAutomationSchedule, getAutomationSchedule, saveAutomationSchedule } from '@/api'

const loading = ref(false)
const saving = ref(false)
const disabling = ref(false)
const loaded = ref(false)
const error = ref('')
const form = reactive({ sync_enabled: false, sync_time: '01:05', report_enabled: false, report_time: '09:00' })
const saved = reactive({ sync_enabled: false, sync_time: '01:05', report_enabled: false, report_time: '09:00' })
const snapshot = reactive({ config: null, next_run: {}, last: {}, recent_runs: [] })
const scheduleStatus = computed(() => form.sync_enabled || form.report_enabled ? '有计划已启用' : '全部停用')
const formatDateTime = value => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}
const formatNext = value => value ? formatDateTime(value) : '未启用或尚未计算'
const runLabel = run => run ? `${run.business_date || '未知日期'} · ${run.status || '未知状态'}` : '暂无记录'

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await getAutomationSchedule()
    if (data?.ok !== true || !data.config) throw new Error('计划接口未返回有效配置')
    Object.assign(snapshot, data)
    for (const key of Object.keys(form)) form[key] = data.config[key]
    Object.assign(saved, form)
    loaded.value = true
  } catch (e) {
    error.value = `无法读取计划：${e.message || e}`
    loaded.value = false
  } finally { loading.value = false }
}

async function save() {
  if (!loaded.value) return
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.sync_time) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(form.report_time)) {
    ElMessage.error('时间须为 HH:mm 格式')
    return
  }
  const patch = Object.fromEntries(Object.keys(form).filter(key => form[key] !== saved[key]).map(key => [key, form[key]]))
  if (!Object.keys(patch).length) { ElMessage.info('设置没有变化'); return }
  if ((!saved.sync_enabled && form.sync_enabled) || (!saved.report_enabled && form.report_enabled)) {
    try {
      await ElMessageBox.confirm('启用后仅在未来到点时尝试执行；不会立刻补跑。请先确认后台 worker 已完成上线验收。', '确认启用自动计划', { type: 'warning', confirmButtonText: '确认启用', cancelButtonText: '取消' })
    } catch { return }
  }
  saving.value = true
  try {
    const result = await saveAutomationSchedule(patch)
    if (result?.ok !== true) throw new Error(result?.reason || '保存失败')
    ElMessage.success('计划已保存；仅影响未来执行')
    await load()
  } catch (e) { ElMessage.error(e.message || '保存失败') }
  finally { saving.value = false }
}

async function disable() {
  try { await ElMessageBox.confirm('将同时停用自动同步和自动日报，不删除历史记录。', '一键停用', { type: 'warning', confirmButtonText: '确认停用', cancelButtonText: '取消' }) }
  catch { return }
  disabling.value = true
  try {
    const result = await disableAutomationSchedule()
    if (result?.ok !== true) throw new Error(result?.reason || '停用失败')
    ElMessage.success('两个自动计划已停用')
    await load()
  } catch (e) { ElMessage.error(e.message || '停用失败') }
  finally { disabling.value = false }
}

onMounted(load)
</script>

<style scoped>
.schedule-panel { color: #16243a; }
.schedule-hero { display: flex; justify-content: space-between; align-items: center; gap: 18px; padding: 25px 28px; color: #fff; border-radius: 18px; background: radial-gradient(circle at 88% 0%, rgba(123,175,255,.55), transparent 30%), linear-gradient(118deg, #152f65, #2364c9); box-shadow: 0 14px 28px rgba(35,85,170,.18); }
.eyebrow { margin: 0 0 7px; color: #b8d1fb; font-size: 10px; font-weight: 800; letter-spacing: .14em; }
.schedule-hero h1 { margin: 0; font-size: 25px; }.schedule-hero p:not(.eyebrow) { margin: 8px 0 0; color: #d5e4ff; font-size: 13px; }
.schedule-alert { margin-top: 15px; }.schedule-card { margin-top: 16px; padding: 24px 26px; border: 1px solid #e6ebf4; border-radius: 16px; background: #fff; box-shadow: 0 9px 24px rgba(22,41,76,.045); }
.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding-bottom: 18px; border-bottom: 1px solid #edf0f5; }.section-heading h2 { margin: 0; color: #1c3154; font-size: 17px; }.section-heading p { margin: 5px 0 0; color: #8a98ab; font-size: 12px; }.schedule-badge { padding: 5px 10px; color: #2770d8; border-radius: 99px; background: #ebf3ff; font-size: 11px; }
.schedule-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 16px; margin-top: 18px; }.schedule-job { padding: 18px; border: 1px solid #dce7f7; border-radius: 12px; background: #f8fbff; }.job-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 20px; }.job-head strong, .job-head small { display: block; }.job-head strong { color: #24436f; font-size: 14px; }.job-head small { margin-top: 4px; color: #7d8da1; font-size: 11px; }.schedule-job label { display: block; margin-bottom: 7px; color: #4e6383; font-size: 12px; font-weight: 700; }.schedule-job input { width: 100%; min-height: 38px; padding: 7px 10px; color: #243b62; border: 1px solid #cbd8e9; border-radius: 8px; background: #fff; font: inherit; box-sizing: border-box; }.schedule-job input:focus-visible { outline: 2px solid #3d7de2; outline-offset: 2px; }.schedule-job p { margin: 11px 0 0; color: #7d8da1; font-size: 12px; }
.actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 22px; }.actions span, .update-note { color: #8a98ab; font-size: 12px; }.update-note { margin: 14px 0 0; }.run-summary { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; margin: 18px 0; }.run-summary div { padding: 14px; border: 1px solid #edf0f5; border-radius: 10px; }.run-summary small, .run-summary strong { display: block; }.run-summary small { color: #8a98ab; }.run-summary strong { margin-top: 5px; color: #24436f; font-size: 13px; }.runs-table :deep(th.el-table__cell) { background: #f7fafd; color: #5c7591; }
@media (max-width: 760px) { .schedule-hero { align-items: flex-start; flex-direction: column; }.schedule-grid, .run-summary { grid-template-columns: 1fr; }.schedule-card { padding: 19px; } }
</style>
