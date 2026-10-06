<template>
  <div class="agent-page">
    <section class="agent-hero">
      <div>
        <span class="eyebrow">OPERATIONS INTELLIGENCE</span>
        <h2>AI 经营分析</h2>
        <p>队长分派渠道、菜品、账本专员。每步展示数据口径、计算结果与建议；不自动改价、导入或发群。</p>
      </div>
      <el-tag type="success" effect="plain">分析只读 · 建议需人工决定</el-tag>
    </section>

    <section class="agent-panel setup-panel">
      <div class="section-heading"><div><span class="step-index">01</span><h3>创建分析任务</h3></div><span>一次只分析一家门店，最多连续 31 天</span></div>
      <div class="setup-grid">
        <label><span>门店</span><el-select v-model="form.store_id" filterable placeholder="选择门店"><el-option v-for="store in stores" :key="store.id" :label="store.store_name" :value="store.id" /></el-select></label>
        <label><span>业务日期</span><el-date-picker v-model="form.range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" :disabled-date="disableDate" /></label>
        <label><span>分析模式</span><el-select v-model="form.mode"><el-option label="规则计算（不调用外部模型）" value="rules" /><el-option label="AI 辅助解读" value="ai" :disabled="!config.ai_enabled || !config.profiles?.length" /></el-select></label>
        <label v-if="form.mode === 'ai'"><span>模型配置</span><el-select v-model="form.profile_id" placeholder="选择模型"><el-option v-for="profile in config.profiles" :key="profile.id" :label="`${profile.name} · ${profile.model}`" :value="profile.id" /></el-select></label>
        <label v-if="form.mode === 'ai'"><span>思考深度</span><el-select v-model="form.depth"><el-option label="简要" value="brief" /><el-option label="标准" value="standard" /><el-option label="深入" value="deep" /></el-select></label>
      </div>
      <p v-if="form.mode === 'ai'" class="data-notice">{{ config.data_policy }} 页面只展示模型的结论摘要，不展示或保存内部思维链。</p>
      <p v-else class="data-notice">规则模式在中控本地计算，不调用外部模型。模型由「企业设置 → 机器人设置」统一管理。</p>
      <div class="setup-actions"><el-button type="primary" :loading="submitting" @click="submit">开始分析</el-button><el-button @click="refreshRuns">刷新记录</el-button></div>
    </section>

    <div class="agent-columns">
      <section class="agent-panel history-panel">
        <div class="section-heading"><div><span class="step-index">02</span><h3>运行记录</h3></div><span>最近 50 次</span></div>
        <el-empty v-if="!runs.length" description="还没有分析记录" :image-size="72" />
        <button v-for="item in runs" :key="item.id" type="button" class="run-item" :class="{ selected: selected?.id === item.id }" @click="selectRun(item.id)">
          <strong>#{{ item.id }} {{ item.store_name }}</strong>
          <small>{{ item.date_from }} 至 {{ item.date_to }}</small>
          <span><el-tag size="small" :type="statusType(item.status)">{{ statusLabel(item.status) }}</el-tag><em>{{ item.mode === 'ai' ? item.profile_name : '规则计算' }}</em></span>
        </button>
      </section>

      <section class="agent-panel detail-panel">
        <div class="section-heading"><div><span class="step-index">03</span><h3>执行路线与结果</h3></div><span v-if="selected">#{{ selected.id }} · {{ selected.created_by_name }}</span></div>
        <el-empty v-if="!selected" description="选择一条运行记录，查看专员分工和结果" :image-size="90" />
        <template v-else>
          <div class="run-overview"><b>{{ selected.store_name }}</b><span>{{ selected.date_from }} — {{ selected.date_to }}</span><el-tag :type="statusType(selected.status)">{{ statusLabel(selected.status) }}</el-tag></div>
          <el-alert v-if="selected.error_text" :title="selected.error_text" type="error" :closable="false" show-icon />
          <div v-if="selected.status !== 'running'" class="analysis-lead">
            <div class="analysis-lead-title"><div><span class="eyebrow">ANALYSIS FIRST</span><h3>经营判断与下一步</h3></div><el-tag :type="aiDone === 4 ? 'success' : 'warning'">{{ selected.mode === 'ai' ? `AI 解读 ${aiDone}/4` : '规则分析' }}</el-tag></div>
            <template v-if="selected.mode === 'ai' && aiDone < 4"><el-alert title="这次模型没有生成完整的最终文字；下方是中控规则分析，不应视为 AI 分析完成。" type="warning" :closable="false" show-icon /><el-button type="primary" plain :loading="retrying" @click="retryAi">仅补齐 AI 解读（不重新取数、不重导入）</el-button></template>
            <p v-for="finding in selected.result?.findings || []" :key="finding" class="lead-finding">{{ finding }}</p>
            <div class="lead-actions"><b>调整计划</b><div v-for="action in selected.result?.actions || []" :key="action.priority + action.action" class="lead-action"><strong>{{ action.priority }}</strong><span>{{ action.action }}<small>责任建议：{{ action.owner }}</small></span></div></div>
            <div v-if="synthesisStep?.interpretation" class="model-note"><strong>队长 AI 综合结论</strong><p>{{ synthesisStep.interpretation }}</p></div>
            <p class="lead-boundary">{{ selected.result?.boundary }}</p>
          </div>
          <h4 class="route-heading">各专员如何得出结论</h4>
          <div class="route-list">
            <article v-for="(step, index) in selected.steps" :key="step.step_key" class="route-step">
              <div class="route-rail"><span :class="step.status">{{ index + 1 }}</span><i v-if="index < selected.steps.length - 1" /></div>
              <div class="route-content">
                <div class="route-title"><h4>{{ step.step_name }}</h4><el-tag size="small" :type="statusType(step.status)">{{ statusLabel(step.status) }}</el-tag></div>
                <small v-if="step.started_at">{{ step.started_at }}<template v-if="step.finished_at"> → {{ step.finished_at }}</template></small>
                <template v-if="step.status.startsWith('completed')">
                  <p v-if="step.step_key === 'coordinator'">{{ step.result.mode }}；按渠道 → 菜品 → 账本 → 综合计划执行。所有专员只有聚合数据读取权。</p>
                  <template v-if="['channels','dishes','ledger'].includes(step.step_key)">
                    <p v-for="observation in step.result.observations || []" :key="observation" class="finding">{{ observation }}</p>
                    <div v-if="step.interpretation" class="model-note"><strong>专员 AI 判断与建议</strong><p>{{ step.interpretation }}</p></div>
                    <details class="raw-data"><summary>展开{{ step.step_name.split(' · ')[0] }}原始聚合数据</summary>
                      <template v-if="step.step_key === 'channels'"><p class="note">{{ step.result.note }}</p><el-table v-if="step.result.pos?.length" :data="step.result.pos" size="small" max-height="260"><el-table-column prop="channel" label="收银渠道" /><el-table-column prop="days" label="天数" width="70" /><el-table-column label="实收" width="120"><template #default="scope">¥{{ money(scope.row.actual_amount) }}</template></el-table-column></el-table><el-table v-if="step.result.platform?.length" :data="step.result.platform" size="small" max-height="220"><el-table-column prop="platform" label="平台实收（独立口径）" /><el-table-column prop="channel" label="渠道" /><el-table-column label="实际到账"><template #default="scope">¥{{ money(scope.row.actual_amount) }}</template></el-table-column></el-table></template>
                      <template v-if="step.step_key === 'dishes'"><p class="note">{{ step.result.note }}</p><el-table v-if="step.result.top?.length" :data="step.result.top" size="small" max-height="290"><el-table-column prop="product_name" label="菜品（前 15）" /><el-table-column prop="quantity" label="数量" width="80" /><el-table-column label="品项收入" width="120"><template #default="scope">¥{{ money(scope.row.income_amount) }}</template></el-table-column></el-table></template>
                      <template v-if="step.step_key === 'ledger'"><p class="note">{{ step.result.note }}</p><el-table v-if="step.result.categories?.length" :data="step.result.categories" size="small" max-height="290"><el-table-column prop="category_name" label="大类" /><el-table-column prop="subcategory_name" label="小类" /><el-table-column label="金额" width="120"><template #default="scope">¥{{ money(scope.row.amount) }}</template></el-table-column></el-table></template>
                    </details>
                  </template>
                  <template v-if="step.step_key === 'synthesis'"><div class="coverage">计划 {{ step.result.coverage?.expected_days }} 天 · 收银 {{ step.result.coverage?.pos_days }} 天 · 菜品 {{ step.result.coverage?.dish_days }} 天 · 账本 {{ step.result.coverage?.ledger_days }} 天</div><p v-for="finding in step.result.findings" :key="finding" class="finding">{{ finding }}</p><el-alert v-for="warning in step.result.warnings" :key="warning" :title="warning" type="warning" :closable="false" class="warning" /><div v-for="action in step.result.actions" :key="action.priority + action.action" class="action"><b>{{ action.priority }}</b><span>{{ action.action }}<small>责任建议：{{ action.owner }}</small></span></div><p class="note">{{ step.result.boundary }}</p></template>
                  <div v-if="step.step_key === 'synthesis' && step.interpretation" class="model-note"><strong>AI 结论摘要（建议，非已验证事实）</strong><p>{{ step.interpretation }}</p></div>
                  <el-alert v-if="step.error_text" :title="step.error_text" type="warning" :closable="false" class="warning" />
                  <details class="evidence"><summary>查看取数证据与边界</summary><pre>{{ JSON.stringify(step.evidence, null, 2) }}</pre></details>
                </template>
              </div>
            </article>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { getStores, getAnalysisAgentConfig, getAnalysisAgentRuns, getAnalysisAgentRun, startAnalysisAgentRun, retryAnalysisAgentRun } from '@/api'

const stores = ref([])
const config = reactive({ ai_enabled: false, profiles: [], active_profile_id: '', data_policy: '' })
const form = reactive({ store_id: null, range: [], mode: 'rules', depth: 'standard', profile_id: '' })
const runs = ref([])
const selected = ref(null)
const submitting = ref(false)
const retrying = ref(false)
const synthesisStep = computed(() => selected.value?.steps?.find(step => step.step_key === 'synthesis'))
const aiDone = computed(() => (selected.value?.steps || []).filter(step => ['channels', 'dishes', 'ledger', 'synthesis'].includes(step.step_key) && step.interpretation).length)
let timer = null
const money = value => Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const disableDate = date => date >= new Date(new Date().setHours(0, 0, 0, 0))
const statusLabel = status => ({ pending: '待执行', running: '执行中', completed: '已完成', completed_with_warning: '已完成 · 有警告', failed: '失败' }[status] || status)
const statusType = status => ({ pending: 'info', running: 'primary', completed: 'success', completed_with_warning: 'warning', failed: 'danger' }[status] || 'info')

async function refreshRuns() {
  try { runs.value = (await getAnalysisAgentRuns({ store_id: form.store_id || undefined })).runs || [] }
  catch (error) { ElMessage.error(error.response?.data?.error || '无法读取分析记录') }
}
async function selectRun(id) {
  try { selected.value = (await getAnalysisAgentRun(id)).run }
  catch (error) { ElMessage.error(error.response?.data?.error || '无法读取任务详情') }
}
async function tick() {
  if (selected.value?.status !== 'running') return
  await selectRun(selected.value.id)
  if (selected.value?.status !== 'running') await refreshRuns()
}
async function submit() {
  if (!form.store_id || !form.range?.[0] || !form.range?.[1]) return ElMessage.warning('请选择门店和业务日期')
  if (form.mode === 'ai' && !form.profile_id) return ElMessage.warning('请选择模型配置')
  if (form.mode === 'ai') {
    try { await ElMessageBox.confirm('本次会把所选门店日期范围内的聚合经营数据发送给已配置的模型，用于建议生成。继续吗？', '确认 AI 辅助解读', { type: 'warning' }) }
    catch { return }
  }
  submitting.value = true
  try {
    const response = await startAnalysisAgentRun({ store_id: form.store_id, date_from: form.range[0], date_to: form.range[1], mode: form.mode, depth: form.depth, profile_id: form.profile_id })
    await refreshRuns()
    await selectRun(response.id)
    ElMessage.success('分析任务已创建')
  } catch (error) { ElMessage.error(error.response?.data?.error || '创建分析任务失败') }
  finally { submitting.value = false }
}
async function retryAi() {
  if (!selected.value || !form.profile_id) return ElMessage.warning('请先选择模型配置')
  try { await ElMessageBox.confirm('只会把此任务已保存的聚合数据再次发给所选模型补齐解读，不重新下载、导入或修改经营数据。继续吗？', '补齐 AI 解读', { type: 'warning' }) }
  catch { return }
  retrying.value = true
  try { await retryAnalysisAgentRun(selected.value.id, { profile_id: form.profile_id }); await selectRun(selected.value.id); await refreshRuns(); ElMessage.success('AI 解读补齐任务已开始') }
  catch (error) { ElMessage.error(error.response?.data?.error || '补齐失败') }
  finally { retrying.value = false }
}
onMounted(async () => {
  const yesterday = new Date(Date.now() - 86400000)
  const d = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  form.range = [d(new Date(yesterday.getFullYear(), yesterday.getMonth(), 1)), d(yesterday)]
  try {
    const [storeResult, aiConfig] = await Promise.all([getStores({ page: 1, page_size: 500 }), getAnalysisAgentConfig()])
    stores.value = storeResult.stores || []
    Object.assign(config, aiConfig)
    form.profile_id = aiConfig.active_profile_id || aiConfig.profiles?.[0]?.id || ''
    if (aiConfig.ai_enabled && aiConfig.profiles?.some(profile => profile.id === form.profile_id)) form.mode = 'ai'
  } catch (error) { ElMessage.error(error.response?.data?.error || '初始化分析页失败') }
  await refreshRuns()
  if (runs.value.length) await selectRun(runs.value[0].id)
  timer = window.setInterval(tick, 2500)
})
onBeforeUnmount(() => { if (timer) window.clearInterval(timer) })
</script>

<style scoped>
.agent-page{padding:24px 30px 48px;color:#19324a;max-width:1700px;margin:auto}.agent-hero{display:flex;align-items:center;justify-content:space-between;gap:16px;background:linear-gradient(110deg,#122941,#1b4f72);color:#fff;padding:30px 34px;border-radius:18px;margin-bottom:18px}.eyebrow{font-size:11px;letter-spacing:.2em;color:#7dd4cf;font-weight:800}.agent-hero h2{font-size:29px;margin:7px 0}.agent-hero p{margin:0;color:#d7e8f2;font-size:13px}.agent-panel{background:#fff;border:1px solid #dce6eb;border-radius:16px;padding:22px;box-shadow:0 8px 25px rgba(22,51,72,.035)}.setup-panel{margin-bottom:18px}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}.section-heading>div{display:flex;align-items:center;gap:10px}.section-heading h3{font-size:17px;margin:0}.section-heading>span{color:#7890a0;font-size:12px}.step-index{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;background:#dff4ef;color:#116d64;font-weight:800;font-size:11px}.setup-grid{display:flex;flex-wrap:wrap;gap:14px}.setup-grid label{display:flex;flex-direction:column;gap:6px;min-width:195px;flex:1}.setup-grid label>span{font-size:12px;font-weight:700;color:#547085}.setup-grid :deep(.el-select),.setup-grid :deep(.el-date-editor){width:100%}.setup-grid label:nth-child(2){flex:1.4;min-width:280px}.data-notice{font-size:12px;color:#647b8c;background:#f2f7f8;padding:10px 12px;border-radius:8px;margin:16px 0}.setup-actions{display:flex;gap:8px}.agent-columns{display:grid;grid-template-columns:minmax(250px,300px) minmax(0,1fr);gap:18px;align-items:start}.history-panel{max-height:760px;overflow:auto}.run-item{display:flex;flex-direction:column;width:100%;text-align:left;border:1px solid #e5ecef;border-radius:11px;background:#fff;padding:12px;margin:0 0 9px;cursor:pointer;color:inherit;gap:5px}.run-item:hover,.run-item.selected{border-color:#46a994;background:#f4fbf9}.run-item strong{font-size:13px}.run-item small{color:#7890a0}.run-item>span{display:flex;align-items:center;gap:8px}.run-item em{font-size:11px;color:#7890a0;font-style:normal}.run-overview{display:flex;align-items:center;gap:12px;background:#f4f8fa;padding:12px;border-radius:9px;margin-bottom:16px}.run-overview span{font-size:12px;color:#648091}.route-list{padding-left:3px}.route-step{display:flex;gap:12px}.route-rail{display:flex;flex-direction:column;align-items:center;width:28px;flex:none}.route-rail span{display:grid;place-items:center;width:27px;height:27px;border-radius:50%;background:#e6eef2;color:#60788b;font-weight:700;font-size:12px}.route-rail span.completed,.route-rail span.completed_with_warning{background:#d2eee4;color:#147960}.route-rail span.running{background:#d8e9fb;color:#185da0}.route-rail span.failed{background:#fee4e0;color:#c53e31}.route-rail i{width:2px;flex:1;background:#dce7eb;min-height:28px}.route-content{flex:1;min-width:0;border-bottom:1px solid #edf1f3;padding:0 0 18px;margin-bottom:18px}.route-title{display:flex;align-items:center;gap:10px}.route-title h4{margin:2px 0 5px;font-size:14px}.route-content>small{display:block;color:#8aa0ae;font-size:11px}.route-content p{font-size:12px;line-height:1.65;white-space:pre-wrap}.metric-line{font-size:13px!important}.metric-line b{color:#0a8778}.note{color:#647d8d;background:#f5f9fa;border-left:3px solid #9bbdc5;padding:8px 10px}.model-note{background:#f0f7fe;border:1px solid #d8e8f8;padding:12px;border-radius:9px;margin-top:10px}.model-note strong{font-size:12px;color:#1d6395}.model-note p{margin-bottom:0}.coverage{font-size:12px;font-weight:700;color:#166c63;margin:12px 0}.warning{margin:8px 0}.action{display:flex;align-items:start;gap:9px;border:1px solid #e6ecec;border-radius:8px;padding:9px;margin:6px 0;font-size:12px}.action>b{background:#e0eee8;color:#126e5e;padding:2px 5px;border-radius:4px}.action small{display:block;color:#8a9ca6;margin-top:4px}.evidence{font-size:11px;color:#6a8392;margin-top:12px;cursor:pointer}.evidence pre{white-space:pre-wrap;word-break:break-word;background:#f5f8fa;border-radius:8px;padding:10px;max-height:160px;overflow:auto}@media(max-width:900px){.agent-page{padding:14px}.agent-columns{grid-template-columns:1fr}.agent-hero{align-items:start;flex-direction:column}.history-panel{max-height:250px}}
</style>
<style scoped>
.finding{border-left:3px solid #42aa94;background:#f1faf6;padding:8px 11px;border-radius:0 7px 7px 0;margin:7px 0!important}
.analysis-lead{border:1px solid #bfe6d8;background:linear-gradient(160deg,#f5fcf8,#fff);border-radius:14px;padding:20px;margin:14px 0 24px}.analysis-lead-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.analysis-lead-title h3{margin:5px 0;font-size:20px}.lead-finding{font-size:14px!important;line-height:1.7!important;border-left:3px solid #248a74;padding:9px 12px;background:#fff;border-radius:0 8px 8px 0}.lead-actions{border-top:1px solid #d7e9e2;padding-top:13px;margin-top:15px}.lead-actions>b{font-size:14px}.lead-action{display:flex;gap:10px;margin-top:10px;padding:10px 12px;background:#fff;border-radius:9px;font-size:13px;line-height:1.6}.lead-action>strong{color:#137667}.lead-action small{display:block;color:#7f929b}.lead-boundary{font-size:12px;color:#667f89}.route-heading{font-size:15px;margin:20px 0}.raw-data{margin-top:12px;padding:10px 12px;border:1px dashed #cadcde;border-radius:8px}.raw-data summary{font-size:12px;color:#387e81;font-weight:700;cursor:pointer}.analysis-lead .el-button{margin-top:12px}
</style>
