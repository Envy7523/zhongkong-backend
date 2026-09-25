<template>
  <div class="daily-page">
    <el-alert title="发送仍受两道开关控制" type="warning" :closable="false" show-icon>
      机器人与项目消息的分配统一在“企业设置 → 机器人管理”维护。本页只负责收银日报的范围、预览和发送审批；“同步与日报时间”中的自动计划仍须单独开启。
    </el-alert>

    <section class="panel">
      <div class="panel-heading"><div><span>01 · RECIPIENT</span><h2>收银日报发送目标</h2><p>按企业设置中的“收银系统每日高低位数据”分配自动匹配；本项目不再保存或修改机器人密钥。</p></div><el-button @click="load">刷新</el-button></div>
      <div class="binding"><label>当前机器人</label><strong>{{ boundBot?.name || '尚未分配' }}</strong><el-tag :type="routeEnabled ? 'success' : 'info'">{{ routeEnabled ? '日报路由已启用' : '日报路由关闭' }}</el-tag><el-button @click="router.push('/enterprise-settings/robot#bot-registry')">前往统一机器人管理</el-button><small>修改目标后本路由会自动关闭；请重新核对群与日报样式。</small></div>
    </section>

    <section class="panel">
      <div class="panel-heading"><div><span>02 · STORE SCOPE</span><h2>收银日报门店范围</h2><p>排除项只作用于本日报，不修改中控门店主档。其他正常营业门店缺数时会阻止发送。</p></div></div>
      <div class="scope-list"><div v-for="row in stores" :key="row.id" class="scope-row"><el-checkbox v-model="excludedIds" :value="row.id">{{ row.store_name }}</el-checkbox><el-input v-if="excludedIds.includes(row.id)" v-model="reasons[row.id]" placeholder="排除原因，如已停业、放养门店" maxlength="80" /></div></div>
      <el-button :loading="saving" @click="saveScope">保存日报范围</el-button>
    </section>

    <section class="panel">
      <div class="panel-heading"><div><span>03 · PREVIEW</span><h2>全门店总览图</h2><p>只读取云端中控数据库中的收银记录。外卖和团购栏是收银记录视角，不是第三方平台实际到账。</p></div></div>
      <div class="preview-tools"><el-date-picker v-model="bizDate" type="date" value-format="YYYY-MM-DD" :clearable="false" /><el-button type="primary" :loading="previewLoading" @click="loadPreview">生成只读预览</el-button><el-tag v-if="preview" :type="preview.ready ? 'success' : 'danger'">{{ preview.ready ? `${preview.store_count} 家门店覆盖完整` : '数据缺失，禁止发送' }}</el-tag></div>
      <el-alert v-if="preview && !preview.ready" :title="preview.problems.join('；')" type="error" :closable="false" show-icon />
      <div v-if="preview" class="image-wrap"><img :src="preview.image_data_url" alt="收银系统每日高低位数据总览预览" /></div>
      <el-empty v-else description="尚未生成预览，不会自动发送" />
      <div class="approval"><el-checkbox v-model="templateApproved">我已核对并批准日报图片样式与收银数据口径</el-checkbox><el-checkbox v-model="targetVerified">我已在企业微信中确认当前机器人对应正确的群</el-checkbox><el-button type="warning" plain :disabled="!preview?.ready || !boundBot || !templateApproved || !targetVerified || testSendLocked || testSending" :loading="testSending" @click="testSend">向当前群发送一条测试日报</el-button><el-button type="danger" plain :disabled="!routeEnabled" :loading="saving" @click="setRoute(false)">关闭日报路由</el-button><el-button type="primary" :disabled="routeEnabled || !preview?.ready || !boundBot || !templateApproved || !targetVerified" :loading="saving" @click="setRoute(true)">启用日报路由</el-button></div>
      <p class="footnote">测试发送是真实群消息，但不会开启自动计划。同一业务日期与机器人只允许测试发送一次；若结果未知，先到目标群核对，不要重发。</p>
      <p class="footnote">当前路由：{{ routeEnabled ? '已启用' : '关闭' }}。即使启用路由，也不会立刻推送；日报计划仍需单独开启，且当日导入与覆盖校验必须通过。</p>
    </section>

  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { getStores, getWecomRouting, activateWecomRoute, savePosDailyExclusions, previewPosDaily, sendPosDailyTest } from '@/api'

const yesterday = new Date(Date.now() - 86400000)
const router = useRouter()
const bizDate = ref(`${yesterday.getFullYear()}-${String(yesterday.getMonth()+1).padStart(2,'0')}-${String(yesterday.getDate()).padStart(2,'0')}`)
const routing = reactive({ bots: [], routes: [], exclusions: [] })
const stores = ref([]), excludedIds = ref([]), reasons = reactive({})
const saving = ref(false), previewLoading = ref(false), preview = ref(null)
const templateApproved = ref(false), targetVerified = ref(false), routeEnabled = ref(false)
const testSending = ref(false), testSendLocked = ref(false)
const boundBotId = computed(() => routing.routes.find(row => row.message_code === 'pos_daily')?.bot_id || null)
const routeRevision = computed(() => Number(routing.routes.find(row => row.message_code === 'pos_daily')?.revision || 0))
const boundBot = computed(() => routing.bots.find(bot => bot.id === boundBotId.value && bot.enabled && bot.configured) || null)

function requestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function load() {
  try {
    const [response, storeResponse] = await Promise.all([getWecomRouting(), getStores({ page: 1, page_size: 500 })])
    const oldBotId = boundBotId.value
    routing.bots = response.bots || []; routing.routes = response.routes || []; routing.exclusions = response.exclusions || []
    if (oldBotId !== boundBotId.value) { preview.value = null; templateApproved.value = false; targetVerified.value = false; testSendLocked.value = false }
    routeEnabled.value = Boolean(routing.routes.find(row => row.message_code === 'pos_daily')?.enabled)
    stores.value = (storeResponse.stores || storeResponse.rows || []).filter(row => row.status === '正常营业')
    excludedIds.value = routing.exclusions.map(row => row.store_id)
    for (const row of routing.exclusions) reasons[row.store_id] = row.reason
  } catch (error) { ElMessage.error(`读取日报设置失败：${error.message}`) }
}
async function saveScope() {
  const exclusions = excludedIds.value.map(id => ({ store_id: id, reason: String(reasons[id] || '').trim() }))
  if (exclusions.some(row => !row.reason)) return ElMessage.warning('每个排除门店都需要填写原因')
  saving.value = true
  try { await savePosDailyExclusions({ exclusions }); preview.value = null; templateApproved.value = false; await load(); ElMessage.success('日报范围已保存，请重新生成预览') }
  catch (error) { ElMessage.error(error.message) } finally { saving.value = false }
}
async function loadPreview() {
  previewLoading.value = true; templateApproved.value = false
  try { preview.value = await previewPosDaily(bizDate.value); testSendLocked.value = false }
  catch (error) { preview.value = null; ElMessage.error(`预览失败：${error.message}`) } finally { previewLoading.value = false }
}
async function testSend() {
  if (!preview.value?.ready || !boundBot.value || !templateApproved.value || !targetVerified.value) return
  const name = boundBot.value.name
  try {
    await ElMessageBox.confirm(`将 ${bizDate.value} 的收银日报图片真实发送到「${name}」所在的群。请确认该机器人对应的是测试目标群。`, '确认发送一条测试日报', { type: 'warning', confirmButtonText: '确认发送', cancelButtonText: '取消' })
  } catch { return }
  testSending.value = true
  try {
    const result = await sendPosDailyTest({ business_date: bizDate.value, bot_id: boundBot.value.id, request_id: requestId(), confirm_template_approved: true, confirm_target_verified: true })
    testSendLocked.value = true
    ElMessage.success(`测试日报已发送至「${result.target_name}」；自动计划仍未改变`)
  } catch (error) {
    testSendLocked.value = true
    ElMessage.error(`测试发送未确认：${error.message}。请先到目标群核对，勿重复点击。`)
  } finally { testSending.value = false }
}
async function setRoute(enabled) {
  saving.value = true
  try { await activateWecomRoute('pos_daily', { enabled, expected_bot_id: boundBotId.value, expected_revision: routeRevision.value, confirm_template_approved: templateApproved.value, confirm_target_verified: targetVerified.value }); await load(); ElMessage.success(enabled ? '日报路由已启用；日报计划仍需单独开启' : '日报路由已关闭') }
  catch (error) { ElMessage.error(error.message) } finally { saving.value = false }
}
onMounted(load)
</script>

<style scoped>
.daily-page{display:grid;gap:16px;padding:12px 0 30px;color:#263848}.panel{padding:23px;background:#fff;border:1px solid #dfe6eb;border-radius:12px;box-shadow:0 6px 20px #1838540a}.panel-heading{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:18px}.panel-heading span{font-size:11px;font-weight:700;letter-spacing:.12em;color:#277e87}.panel-heading h2{margin:4px 0 5px;font-size:20px}.panel-heading p{margin:0;color:#687b89;font-size:12px}.bot-create{display:grid;grid-template-columns:minmax(180px,1fr) minmax(260px,2fr) auto;gap:10px;margin-bottom:16px}.binding{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:16px;padding:14px;background:#f5f9fa;border-radius:8px}.binding label{font-size:13px;font-weight:700}.binding .el-select{width:290px}.binding small{color:#71818b}.scope-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:15px}.scope-row{display:flex;align-items:center;gap:10px;min-height:42px;padding:4px 9px;border:1px solid #edf1f3;border-radius:7px}.scope-row .el-checkbox{min-width:220px}.preview-tools,.approval{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin:15px 0}.image-wrap{overflow:auto;border:1px solid #d9e0e4;background:#f5f6f7}.image-wrap img{display:block;max-width:none;width:100%;min-width:1100px}.approval{padding:14px 0 4px;border-top:1px solid #e5ebee}.approval .el-checkbox{width:100%;height:auto}.footnote{margin:8px 0 0;color:#697b89;font-size:12px}@media(max-width:800px){.bot-create,.scope-list{grid-template-columns:1fr}.binding{align-items:stretch;flex-direction:column}.binding .el-select{width:100%}.scope-row{flex-wrap:wrap}}
</style>
