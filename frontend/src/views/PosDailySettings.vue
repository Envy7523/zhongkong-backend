<template>
  <div class="daily-page">
    <el-alert title="当前是管理群的全店汇总日报" type="info" :closable="false" show-icon>
      图片包含多家门店数据，只能发送到管理群。门店群日报须使用独立的单店模板和逐店绑定；自动发送时间在“汇总自动发送”设置。
    </el-alert>

    <section class="panel">
      <div class="panel-heading"><div><span>01 · RECIPIENT</span><h2>全店汇总接收机器人</h2><p>仅选择管理群机器人；机器人 Webhook 在企业设置维护。</p></div><el-button @click="load">刷新</el-button></div>
      <div class="binding"><label>发送机器人</label><el-select v-model="selectedBotId" clearable placeholder="尚未选择机器人"><el-option v-for="bot in availableBots" :key="bot.id" :label="bot.name" :value="bot.id" /></el-select><el-button :disabled="selectedBotId === boundBotId" :loading="saving" @click="saveAssignment">保存目标</el-button><el-tag :type="routeEnabled ? 'success' : 'info'">{{ routeEnabled ? '已启用' : boundBotId ? '待确认启用' : '未设置' }}</el-tag><el-button link @click="router.push('/enterprise-settings/robot#bot-registry')">登记机器人</el-button><small>更换目标后路由会关闭，请重新核对预览和目标群，再在本页启用。</small></div>
    </section>

    <section class="panel">
      <div class="panel-heading"><div><span>02 · PREVIEW</span><h2>当日有数据门店总览图</h2><p>按所选日期的收银数据自动纳入门店，无数据门店不展示。外卖和团购栏是收银记录视角，不是第三方平台实际到账。</p></div></div>
      <div class="preview-tools"><el-date-picker v-model="bizDate" type="date" value-format="YYYY-MM-DD" :clearable="false" /><el-button type="primary" :loading="previewLoading" @click="loadPreview">生成只读预览</el-button><el-tag v-if="preview" :type="preview.ready ? 'success' : 'danger'">{{ preview.ready ? `${preview.store_count} 家门店有数据` : '已导入数据校验未通过，禁止发送' }}</el-tag></div>
      <el-alert v-if="preview && !preview.ready" :title="preview.problems.join('；')" type="error" :closable="false" show-icon />
      <div v-if="preview" class="image-wrap"><img :src="preview.image_data_url" alt="收银系统每日高低位数据总览预览" /></div>
      <el-empty v-else description="尚未生成预览，不会自动发送" />
      <div class="approval"><el-checkbox v-model="approvalConfirmed">我已核对日报预览、数据口径及当前机器人对应的目标群</el-checkbox><el-button type="warning" plain :disabled="assignmentDirty || !preview?.ready || !boundBot || !approvalConfirmed || testSendLocked || testSending" :loading="testSending" @click="testSend">向当前群发送一条测试日报</el-button><el-button type="danger" plain :disabled="!routeEnabled" :loading="saving" @click="setRoute(false)">关闭日报路由</el-button><el-button type="primary" :disabled="assignmentDirty || routeEnabled || !preview?.ready || !boundBot || !approvalConfirmed" :loading="saving" @click="setRoute(true)">启用日报路由</el-button></div>
      <p class="footnote">测试发送是真实群消息，但不会开启自动计划。同一业务日期与机器人只允许测试发送一次；若结果未知，先到目标群核对，不要重发。</p>
      <p class="footnote">当前路由：{{ routeEnabled ? '已启用' : '关闭' }}。即使启用路由，也不会立刻推送；日报计划仍需单独开启，且当日有数据门店的记录校验必须通过。</p>
    </section>

  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { getWecomRouting, bindWecomRoute, activateWecomRoute, previewPosDaily, sendPosDailyTest } from '@/api'

const yesterday = new Date(Date.now() - 86400000)
const router = useRouter()
const bizDate = ref(`${yesterday.getFullYear()}-${String(yesterday.getMonth()+1).padStart(2,'0')}-${String(yesterday.getDate()).padStart(2,'0')}`)
const routing = reactive({ bots: [], routes: [] })
const selectedBotId = ref(null)
const saving = ref(false), previewLoading = ref(false), preview = ref(null)
const approvalConfirmed = ref(false), routeEnabled = ref(false)
const testSending = ref(false), testSendLocked = ref(false)
const boundBotId = computed(() => routing.routes.find(row => row.message_code === 'pos_daily')?.bot_id || null)
const routeRevision = computed(() => Number(routing.routes.find(row => row.message_code === 'pos_daily')?.revision || 0))
const boundBot = computed(() => routing.bots.find(bot => bot.id === boundBotId.value && bot.audience === 'management' && bot.enabled && bot.configured) || null)
const availableBots = computed(() => routing.bots.filter(bot => bot.audience === 'management' && bot.enabled && bot.configured))
const assignmentDirty = computed(() => selectedBotId.value !== boundBotId.value)

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
    const response = await getWecomRouting()
    const oldBotId = boundBotId.value
    routing.bots = response.bots || []; routing.routes = response.routes || []
    selectedBotId.value = boundBotId.value
    if (oldBotId !== boundBotId.value) { preview.value = null; approvalConfirmed.value = false; testSendLocked.value = false }
    routeEnabled.value = Boolean(routing.routes.find(row => row.message_code === 'pos_daily')?.enabled)
  } catch (error) { ElMessage.error(`读取日报设置失败：${error.message}`) }
}
async function saveAssignment() {
  if (selectedBotId.value === boundBotId.value) return
  saving.value = true
  try {
    await bindWecomRoute('pos_daily', { bot_id: selectedBotId.value || null })
    await load()
    preview.value = null; approvalConfirmed.value = false; testSendLocked.value = false
    ElMessage.success('发送目标已保存；请预览并核对后在本页启用')
  } catch (error) { ElMessage.error(`保存目标失败：${error.message}`) }
  finally { saving.value = false }
}
async function loadPreview() {
  previewLoading.value = true; approvalConfirmed.value = false
  try { preview.value = await previewPosDaily(bizDate.value); testSendLocked.value = false }
  catch (error) { preview.value = null; ElMessage.error(`预览失败：${error.message}`) } finally { previewLoading.value = false }
}
async function testSend() {
  if (!preview.value?.ready || !boundBot.value || !approvalConfirmed.value) return
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
  try { await activateWecomRoute('pos_daily', { enabled, expected_bot_id: boundBotId.value, expected_revision: routeRevision.value, confirm_template_approved: approvalConfirmed.value, confirm_target_verified: approvalConfirmed.value }); await load(); ElMessage.success(enabled ? '日报路由已启用；日报计划仍需单独开启' : '日报路由已关闭') }
  catch (error) { ElMessage.error(error.message) } finally { saving.value = false }
}
onMounted(load)
</script>

<style scoped>
.daily-page{display:grid;gap:16px;padding:12px 0 30px;color:#263848}.panel{padding:23px;background:#fff;border:1px solid #dfe6eb;border-radius:12px;box-shadow:0 6px 20px #1838540a}.panel-heading{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:18px}.panel-heading span{font-size:11px;font-weight:700;letter-spacing:.12em;color:#277e87}.panel-heading h2{margin:4px 0 5px;font-size:20px}.panel-heading p{margin:0;color:#687b89;font-size:12px}.bot-create{display:grid;grid-template-columns:minmax(180px,1fr) minmax(260px,2fr) auto;gap:10px;margin-bottom:16px}.binding{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:16px;padding:14px;background:#f5f9fa;border-radius:8px}.binding label{font-size:13px;font-weight:700}.binding .el-select{width:290px}.binding small{color:#71818b}.scope-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:15px}.scope-row{display:flex;align-items:center;gap:10px;min-height:42px;padding:4px 9px;border:1px solid #edf1f3;border-radius:7px}.scope-row .el-checkbox{min-width:220px}.preview-tools,.approval{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin:15px 0}.image-wrap{overflow:auto;border:1px solid #d9e0e4;background:#f5f6f7}.image-wrap img{display:block;max-width:none;width:100%;min-width:1100px}.approval{padding:14px 0 4px;border-top:1px solid #e5ebee}.approval .el-checkbox{width:100%;height:auto}.footnote{margin:8px 0 0;color:#697b89;font-size:12px}@media(max-width:800px){.bot-create,.scope-list{grid-template-columns:1fr}.binding{align-items:stretch;flex-direction:column}.binding .el-select{width:100%}.scope-row{flex-wrap:wrap}}
</style>
