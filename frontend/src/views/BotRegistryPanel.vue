<template>
  <section id="bot-registry" class="registry-card" aria-labelledby="registry-title">
    <header class="registry-heading">
      <div>
        <p class="eyebrow">ONE REGISTRY · EXPLICIT ROUTES</p>
        <h2 id="registry-title">企业微信群机器人统一管理</h2>
        <p>机器人只在此登记和修改。每个项目消息分配一个目标；没有分配时不发送，也不会借用别的项目机器人。</p>
      </div>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </header>

    <el-form label-position="top" class="registry-create" @submit.prevent="addBot">
      <el-form-item label="机器人名称"><el-input v-model="name" maxlength="80" placeholder="例如：Nameless 或运营群机器人" /></el-form-item>
      <el-form-item label="企业微信群 Webhook 地址"><el-input v-model="webhook" type="password" autocomplete="new-password" placeholder="仅在添加或更换时填写，保存后不回显" /></el-form-item>
      <el-form-item class="registry-create__action"><el-button type="primary" native-type="submit" :loading="saving">添加机器人</el-button></el-form-item>
    </el-form>

    <el-table :data="bots" size="small" empty-text="尚未登记企业微信群机器人">
      <el-table-column prop="name" label="机器人" min-width="190" />
      <el-table-column label="Webhook" width="110"><template #default="{ row }">{{ row.configured ? '已安全保存' : '未配置' }}</template></el-table-column>
      <el-table-column label="消息路由" width="105"><template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '可分配' : '暂停' }}</el-tag></template></el-table-column>
      <el-table-column label="操作" width="120"><template #default="{ row }"><el-button link type="primary" @click="openEdit(row)">修改</el-button></template></el-table-column>
    </el-table>

    <div class="routes-heading"><h3>项目消息分配</h3><p>分配只是指定目标，不会立即发消息或开启计划。更换机器人会自动关闭该消息路由，需在项目中重新核对。</p></div>
    <div v-for="item in messageRows" :key="item.code" class="route-row">
      <div><strong>{{ item.name }}</strong><small>{{ item.enabled ? '发送路由已启用' : '发送路由关闭' }}</small></div>
      <el-select v-model="selected[item.code]" clearable :aria-label="`${item.name}发送机器人`" placeholder="尚未分配机器人">
        <el-option v-for="bot in bots.filter(row => row.enabled && row.configured)" :key="bot.id" :label="bot.name" :value="bot.id" />
      </el-select>
      <el-button :loading="saving" @click="saveAssignment(item.code)">保存分配</el-button>
    </div>

    <el-dialog v-model="editVisible" title="修改机器人" width="520px" :close-on-click-modal="false">
      <el-form label-position="top">
        <el-form-item label="机器人名称"><el-input v-model="edit.name" maxlength="80" /></el-form-item>
        <el-form-item label="新 Webhook 地址（留空则保持现有凭证）"><el-input v-model="edit.webhook_url" type="password" autocomplete="new-password" /></el-form-item>
        <el-form-item><el-switch v-model="edit.enabled" active-text="允许分配消息路由" inactive-text="暂停消息路由" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="editVisible=false">取消</el-button><el-button type="primary" :loading="saving" @click="saveEdit">保存修改</el-button></template>
    </el-dialog>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { getWecomRouting, createWecomBot, updateWecomBot, bindWecomRoute } from '@/api'

const loading = ref(false), saving = ref(false)
const bots = ref([]), routes = ref([]), messageTypes = ref({})
const selected = reactive({})
const name = ref(''), webhook = ref('')
const editVisible = ref(false), edit = reactive({ id: null, name: '', webhook_url: '', enabled: true })
const messageRows = computed(() => Object.entries(messageTypes.value).map(([code, title]) => ({
  code, name: title, enabled: Boolean(routes.value.find(row => row.message_code === code)?.enabled),
})))

async function load() {
  loading.value = true
  try {
    const result = await getWecomRouting()
    bots.value = result.bots || []
    routes.value = result.routes || []
    messageTypes.value = result.message_types || {}
    for (const [code] of Object.entries(messageTypes.value)) selected[code] = routes.value.find(row => row.message_code === code)?.bot_id || null
  } catch (error) { ElMessage.error(`读取机器人管理失败：${error.message}`) }
  finally { loading.value = false }
}
async function addBot() {
  saving.value = true
  try { await createWecomBot({ name: name.value, webhook_url: webhook.value }); name.value = ''; webhook.value = ''; await load(); ElMessage.success('机器人已登记，尚未分配任何消息') }
  catch (error) { ElMessage.error(error.message) }
  finally { saving.value = false }
}
function openEdit(row) { Object.assign(edit, { id: row.id, name: row.name, webhook_url: '', enabled: row.enabled }); editVisible.value = true }
async function saveEdit() {
  saving.value = true
  try { await updateWecomBot(edit.id, { name: edit.name, webhook_url: edit.webhook_url, enabled: edit.enabled }); edit.webhook_url = ''; editVisible.value = false; await load(); ElMessage.success('机器人已更新；凭证或可分配状态变化时，相关发送路由会关闭') }
  catch (error) { ElMessage.error(error.message) }
  finally { saving.value = false }
}
async function saveAssignment(code) {
  saving.value = true
  try { await bindWecomRoute(code, { bot_id: selected[code] || null }); await load(); ElMessage.success('项目消息目标已保存；发送路由仍关闭，须在项目中核对并启用') }
  catch (error) { ElMessage.error(error.message) }
  finally { saving.value = false }
}
onMounted(load)
</script>

<style scoped>
.registry-card{margin-top:16px;padding:24px 26px;border:1px solid #dce5f1;border-radius:16px;background:#fff;box-shadow:0 9px 24px rgba(22,41,76,.045)}
.registry-heading{display:flex;justify-content:space-between;align-items:start;gap:16px}.registry-heading h2{margin:4px 0 6px;color:#1c3154;font-size:20px}.registry-heading p:last-child,.routes-heading p{margin:0;color:#687b91;font-size:12px;line-height:1.6}.eyebrow{margin:0;color:#2c73bb;font-size:10px;font-weight:800;letter-spacing:.14em}
.registry-create{display:grid;grid-template-columns:minmax(190px,1fr) minmax(260px,2fr) auto;gap:12px;align-items:end;margin:20px 0 8px}.registry-create__action{align-self:end}.registry-create :deep(.el-form-item){margin-bottom:12px}
.routes-heading{margin:24px 0 12px;padding-top:18px;border-top:1px solid #e8edf5}.routes-heading h3{margin:0 0 5px;color:#253d61;font-size:15px}.route-row{display:grid;grid-template-columns:minmax(190px,1fr) minmax(220px,1.3fr) auto;gap:14px;align-items:center;padding:12px 0;border-bottom:1px solid #edf0f5}.route-row strong,.route-row small{display:block}.route-row strong{font-size:13px;color:#263d59}.route-row small{margin-top:4px;color:#73869a;font-size:11px}
@media(max-width:760px){.registry-card{padding:18px}.registry-create,.route-row{grid-template-columns:1fr}.registry-heading{align-items:stretch;flex-direction:column}.registry-heading>.el-button{align-self:start}}
</style>
