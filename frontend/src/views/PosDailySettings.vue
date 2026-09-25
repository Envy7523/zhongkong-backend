<template>
  <div class="daily-page">
    <el-alert title="发送仍受两道开关控制" type="warning" :closable="false" show-icon>
      此页绑定专用机器人并审批样式；“同步与日报时间”中的日报计划也必须单独开启。预览不会向企业微信群发送任何内容。
    </el-alert>

    <section class="panel">
      <div class="panel-heading"><div><span>01 · RECIPIENT</span><h2>企业微信群机器人</h2><p>可登记多个机器人。每类消息显式选择目标群；地址只写入，不回显到页面。</p></div><el-button @click="load">刷新</el-button></div>
      <div class="bot-create">
        <el-input v-model="botName" placeholder="机器人名称，例如：收银日报专用群" maxlength="80" />
        <el-input v-model="webhookUrl" type="password" show-password autocomplete="off" placeholder="企业微信 Webhook URL（保存后不回显）" />
        <el-button type="primary" :loading="saving" @click="addBot">添加机器人</el-button>
      </div>
      <el-table :data="routing.bots" empty-text="尚未登记机器人" size="small">
        <el-table-column prop="name" label="机器人 / 目标群" min-width="240" />
        <el-table-column label="凭证" width="110"><template #default="{ row }">{{ row.configured ? '已保存' : '未配置' }}</template></el-table-column>
        <el-table-column label="状态" width="110"><template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column>
        <el-table-column label="操作" width="170"><template #default="{ row }"><el-button link type="primary" @click="openEdit(row)">改名 / 换密钥</el-button></template></el-table-column>
      </el-table>
      <div class="binding"><label>“收银系统每日高低位数据”使用</label><el-select v-model="selectedBot" clearable placeholder="请选择专用机器人（不使用默认机器人）"><el-option v-for="bot in routing.bots.filter(item => item.enabled)" :key="bot.id" :label="bot.name" :value="bot.id" /></el-select><el-button :loading="saving" @click="saveBinding">保存绑定</el-button><small>更换目标后，日报路由会自动关闭，需重新审批。</small></div>
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
      <div class="approval"><el-checkbox v-model="templateApproved">我已核对并批准日报图片样式与收银数据口径</el-checkbox><el-checkbox v-model="targetVerified">我已在企业微信中确认所选机器人对应正确的群</el-checkbox><el-button type="danger" plain :disabled="!routeEnabled" :loading="saving" @click="setRoute(false)">关闭日报路由</el-button><el-button type="primary" :disabled="routeEnabled || !preview?.ready || !selectedBot || !templateApproved || !targetVerified" :loading="saving" @click="setRoute(true)">启用日报路由</el-button></div>
      <p class="footnote">当前路由：{{ routeEnabled ? '已启用' : '关闭' }}。即使启用路由，也不会立刻推送；日报计划仍需单独开启，且当日导入与覆盖校验必须通过。</p>
    </section>

    <el-dialog v-model="editVisible" title="修改机器人" width="520px" :close-on-click-modal="false"><el-form label-position="top"><el-form-item label="名称"><el-input v-model="edit.name" maxlength="80" /></el-form-item><el-form-item label="新 Webhook 地址（留空则保持原密钥）"><el-input v-model="edit.webhook_url" type="password" show-password autocomplete="off" /></el-form-item><el-form-item><el-switch v-model="edit.enabled" active-text="启用机器人" inactive-text="停用机器人" /></el-form-item></el-form><template #footer><el-button @click="editVisible=false">取消</el-button><el-button type="primary" :loading="saving" @click="saveEdit">保存</el-button></template></el-dialog>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { getStores, getWecomRouting, createWecomBot, updateWecomBot, bindWecomRoute, activateWecomRoute, savePosDailyExclusions, previewPosDaily } from '@/api'

const yesterday = new Date(Date.now() - 86400000)
const bizDate = ref(`${yesterday.getFullYear()}-${String(yesterday.getMonth()+1).padStart(2,'0')}-${String(yesterday.getDate()).padStart(2,'0')}`)
const routing = reactive({ bots: [], routes: [], exclusions: [] })
const stores = ref([]), excludedIds = ref([]), reasons = reactive({}), selectedBot = ref(null)
const botName = ref(''), webhookUrl = ref(''), saving = ref(false), previewLoading = ref(false), preview = ref(null)
const templateApproved = ref(false), targetVerified = ref(false), routeEnabled = ref(false)
const editVisible = ref(false), edit = reactive({ id: null, name: '', webhook_url: '', enabled: true })

async function load() {
  try {
    const [response, storeResponse] = await Promise.all([getWecomRouting(), getStores({ page: 1, page_size: 500 })])
    routing.bots = response.bots || []; routing.routes = response.routes || []; routing.exclusions = response.exclusions || []
    selectedBot.value = routing.routes.find(row => row.message_code === 'pos_daily')?.bot_id || null
    routeEnabled.value = Boolean(routing.routes.find(row => row.message_code === 'pos_daily')?.enabled)
    stores.value = (storeResponse.stores || storeResponse.rows || []).filter(row => row.status === '正常营业')
    excludedIds.value = routing.exclusions.map(row => row.store_id)
    for (const row of routing.exclusions) reasons[row.store_id] = row.reason
  } catch (error) { ElMessage.error(`读取日报设置失败：${error.message}`) }
}
async function addBot() {
  saving.value = true
  try { await createWecomBot({ name: botName.value, webhook_url: webhookUrl.value }); botName.value = ''; webhookUrl.value = ''; await load(); ElMessage.success('机器人已保存，尚未绑定或发送') }
  catch (error) { ElMessage.error(error.message) } finally { saving.value = false }
}
function openEdit(row) { Object.assign(edit, { id: row.id, name: row.name, webhook_url: '', enabled: row.enabled }); editVisible.value = true }
async function saveEdit() {
  saving.value = true
  try { await updateWecomBot(edit.id, { name: edit.name, webhook_url: edit.webhook_url, enabled: edit.enabled }); edit.webhook_url = ''; editVisible.value = false; await load(); ElMessage.success('已保存；若密钥或状态变更，关联路由已关闭') }
  catch (error) { ElMessage.error(error.message) } finally { saving.value = false }
}
async function saveBinding() {
  saving.value = true
  try { await bindWecomRoute('pos_daily', { bot_id: selectedBot.value }); await load(); ElMessage.success('日报目标已绑定，路由仍关闭，等待样式与群审批') }
  catch (error) { ElMessage.error(error.message) } finally { saving.value = false }
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
  try { preview.value = await previewPosDaily(bizDate.value) }
  catch (error) { preview.value = null; ElMessage.error(`预览失败：${error.message}`) } finally { previewLoading.value = false }
}
async function setRoute(enabled) {
  saving.value = true
  try { await activateWecomRoute('pos_daily', { enabled, confirm_template_approved: templateApproved.value, confirm_target_verified: targetVerified.value }); await load(); ElMessage.success(enabled ? '日报路由已启用；日报计划仍需单独开启' : '日报路由已关闭') }
  catch (error) { ElMessage.error(error.message) } finally { saving.value = false }
}
onMounted(load)
</script>

<style scoped>
.daily-page{display:grid;gap:16px;padding:12px 0 30px;color:#263848}.panel{padding:23px;background:#fff;border:1px solid #dfe6eb;border-radius:12px;box-shadow:0 6px 20px #1838540a}.panel-heading{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:18px}.panel-heading span{font-size:11px;font-weight:700;letter-spacing:.12em;color:#277e87}.panel-heading h2{margin:4px 0 5px;font-size:20px}.panel-heading p{margin:0;color:#687b89;font-size:12px}.bot-create{display:grid;grid-template-columns:minmax(180px,1fr) minmax(260px,2fr) auto;gap:10px;margin-bottom:16px}.binding{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:16px;padding:14px;background:#f5f9fa;border-radius:8px}.binding label{font-size:13px;font-weight:700}.binding .el-select{width:290px}.binding small{color:#71818b}.scope-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:15px}.scope-row{display:flex;align-items:center;gap:10px;min-height:42px;padding:4px 9px;border:1px solid #edf1f3;border-radius:7px}.scope-row .el-checkbox{min-width:220px}.preview-tools,.approval{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin:15px 0}.image-wrap{overflow:auto;border:1px solid #d9e0e4;background:#f5f6f7}.image-wrap img{display:block;max-width:none;width:100%;min-width:1100px}.approval{padding:14px 0 4px;border-top:1px solid #e5ebee}.approval .el-checkbox{width:100%;height:auto}.footnote{margin:8px 0 0;color:#697b89;font-size:12px}@media(max-width:800px){.bot-create,.scope-list{grid-template-columns:1fr}.binding{align-items:stretch;flex-direction:column}.binding .el-select{width:100%}.scope-row{flex-wrap:wrap}}
</style>
