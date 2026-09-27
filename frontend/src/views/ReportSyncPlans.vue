<template>
  <div class="sync-plans" v-loading="loading">
    <header class="plans-header">
      <div><p class="eyebrow">DATA COLLECTION · ASIA/SHANGHAI</p><h1>报表同步计划</h1>
        <p>每份报表独立设置采集时间；机器人只导出、校验并导入，不生成或发送日报。</p></div>
      <el-button @click="load">刷新计划</el-button>
    </header>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="notice" />
    <el-alert title="时间均为北京时间；保存只影响未来计划，不会立即导出、补跑或发送。已入库的数据也不会自动进入日报。" type="info" :closable="false" show-icon class="notice" />
    <div class="cards">
      <section v-for="item in plans" :key="item.report_type" class="plan-card" :aria-label="item.name + '同步计划'">
        <div class="card-top"><div><small>{{ item.platform }} · {{ item.source_site }}</small><h2>{{ item.name }}</h2></div>
          <el-switch v-model="item.enabled" :aria-label="'启用' + item.name + '同步'" /></div>
        <label :for="'time-' + item.report_type">每天导出与同步时间</label>
        <input :id="'time-' + item.report_type" v-model="item.run_time" type="time" step="60" />
        <p class="next">下次计划：{{ item.enabled ? formatNext(item.next_run_at, item) : '已停用' }}</p>
        <p class="note">业务日期：计划执行日前一天 · 与日报发送计划独立</p>
        <el-button type="primary" :loading="saving === item.report_type" :disabled="loading || !!saving || !changed(item)" @click="save(item)">保存此报表计划</el-button>
      </section>
    </div>
    <p class="footer-note">执行结果以“运行记录”和中控数据库回读为准；时间已保存不代表报表已成功同步。</p>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { getReportSyncPlans, saveReportSyncPlan, saveAutomationSchedule } from '@/api'

const plans = ref([])
const loading = ref(false)
const saving = ref('')
const error = ref('')
const baseline = ref({})
const changed = item => { const old = baseline.value[item.report_type]; return !!old && (item.enabled !== old.enabled || item.run_time !== old.run_time) }
const formatNext = (value, item) => {
  if (changed(item)) return '保存后重新计算'
  if (!value) return '暂未计算'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '暂未计算' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}
async function load() {
  loading.value = true; error.value = ''
  try {
    const data = await getReportSyncPlans()
    if (data?.ok !== true || !Array.isArray(data.plans) || data.plans.length < 3) throw new Error('报表计划接口未返回完整配置')
    plans.value = data.plans.map(item => ({ ...item }))
    baseline.value = Object.fromEntries(plans.value.map(item => [item.report_type, { enabled: item.enabled, run_time: item.run_time }]))
  } catch (e) { error.value = `无法读取报表计划：${e.message || e}` }
  finally { loading.value = false }
}
async function save(item) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(item.run_time)) { ElMessage.error('时间须为 HH:mm 格式'); return }
  const old = baseline.value[item.report_type]
  if (!old || !changed(item)) return
  if (!old.enabled && item.enabled) {
    try { await ElMessageBox.confirm('启用后仅在未来到点时尝试同步，不补跑旧日；请确认报表采集已验收。', '确认启用', { type: 'warning' }) }
    catch { return }
  }
  saving.value = item.report_type
  try {
    const aPatch = {}
    if (item.enabled !== old.enabled) aPatch.sync_enabled = item.enabled
    if (item.run_time !== old.run_time) aPatch.sync_time = item.run_time
    const result = item.report_type === 'cashier_composite'
      ? await saveAutomationSchedule(aPatch)
      : await saveReportSyncPlan(item.report_type, { enabled: item.enabled, run_time: item.run_time })
    if (result?.ok !== true) throw new Error(result?.reason || '保存失败')
    ElMessage.success('此报表计划已保存；仅影响未来执行')
    await load()
  } catch (e) { ElMessage.error(e.message || '保存失败') }
  finally { saving.value = '' }
}
onMounted(load)
</script>

<style scoped>
.sync-plans { color: var(--el-text-color-primary); }.plans-header { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:24px; border-radius:12px; color:#fff; background:linear-gradient(110deg,#17376c,#2868cb); }.eyebrow { margin:0 0 7px; font-size:11px; letter-spacing:.12em; color:#b9d3ff; }.plans-header h1 { margin:0; font-size:23px; }.plans-header p:last-child { margin:7px 0 0; font-size:13px; color:#e1ebff; }.notice { margin-top:14px; }.cards { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; margin-top:16px; }.plan-card { padding:20px; border:1px solid var(--el-border-color-light); border-radius:12px; background:var(--el-bg-color); }.card-top { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:22px; }.card-top small { color:var(--el-text-color-secondary); font-size:11px; }.card-top h2 { margin:5px 0 0; font-size:18px; }.plan-card label { display:block; margin-bottom:7px; color:var(--el-text-color-regular); font-size:12px; font-weight:700; }.plan-card input { width:100%; box-sizing:border-box; min-height:38px; padding:7px 10px; border:1px solid var(--el-border-color); border-radius:8px; background:var(--el-bg-color); color:var(--el-text-color-primary); font:inherit; }.plan-card input:focus-visible { outline:2px solid var(--el-color-primary); outline-offset:2px; }.next { margin:12px 0 0; font-size:13px; }.note,.footer-note { color:var(--el-text-color-secondary); font-size:12px; }.note { margin:7px 0 19px; }.footer-note { margin-top:14px; }@media(max-width:900px){.cards{grid-template-columns:1fr}.plans-header{align-items:flex-start;flex-direction:column}}
</style>
