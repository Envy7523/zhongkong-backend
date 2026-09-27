<template>
  <section class="route-page" v-loading="loading">
    <header class="route-heading">
      <div><h2>发送机器人分配</h2><p>机器人只在企业设置统一登记；这里决定每类消息由哪个机器人发送。更换目标会自动关闭该消息路由，重新预览并审批后才能发送。</p></div>
      <el-button @click="load">刷新</el-button>
    </header>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <div class="route-grid">
      <article v-for="route in routes" :key="route.message_code" class="route-card">
        <div class="route-top"><div><small>消息类型</small><h3>{{ route.name }}</h3></div><el-tag :type="route.enabled ? 'success' : 'info'">{{ route.enabled ? '已启用' : '待审批' }}</el-tag></div>
        <label :for="'bot-' + route.message_code">接收消息的企微机器人</label>
        <el-select :id="'bot-' + route.message_code" v-model="selected[route.message_code]" clearable placeholder="不分配机器人" :disabled="!canManage">
          <el-option v-for="bot in availableBots" :key="bot.id" :value="bot.id" :label="bot.name" />
        </el-select>
        <p class="route-help">当前：{{ route.bot_name || '尚未分配' }}。采集机器人不使用此设置；它只导出和导入数据。</p>
        <el-button type="primary" plain :disabled="!canManage || Number(selected[route.message_code] || 0) === Number(route.bot_id || 0)" :loading="saving === route.message_code" @click="save(route)">保存分配</el-button>
      </article>
    </div>
    <div class="route-footer"><span>新机器人或 Webhook 凭证统一在企业设置维护，不在这里重复登记。</span><el-button @click="openRegistry">前往机器人登记</el-button></div>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { bindWecomRoute, getWecomRouting } from '@/api'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'

const app = useAppStore()
const auth = useAuthStore()
const router = useRouter()
const canManage = computed(() => auth.can('enterprise-settings.manage'))
const bots = ref([]), routes = ref([]), loading = ref(false), saving = ref(''), error = ref('')
const selected = reactive({})
const availableBots = computed(() => bots.value.filter(bot => bot.enabled && bot.configured))

async function load() {
  loading.value = true; error.value = ''
  try {
    const data = await getWecomRouting()
    if (data?.ok !== true || !Array.isArray(data.routes)) throw new Error('消息路由接口未返回有效数据')
    bots.value = data.bots || []
    routes.value = data.routes.filter(route => ['pos_daily', 'group_buy_daily'].includes(route.message_code))
    for (const route of routes.value) selected[route.message_code] = route.bot_id || null
  } catch (e) { error.value = `读取机器人分配失败：${e.message || e}` }
  finally { loading.value = false }
}
async function save(route) {
  if (!canManage.value) return
  const botId = selected[route.message_code] || null
  const target = bots.value.find(bot => bot.id === botId)
  try {
    await ElMessageBox.confirm(`将「${route.name}」分配给「${target?.name || '不分配'}」。保存会立即关闭原发送路由，但不会立刻发送；之后需要重新核对预览与目标群并审批。`, '确认更换接收机器人', { type: 'warning' })
  } catch { return }
  saving.value = route.message_code
  try {
    await bindWecomRoute(route.message_code, { bot_id: botId })
    await load()
    ElMessage.success('机器人分配已保存；发送路由已关闭，需重新审批')
  } catch (e) { ElMessage.error(`保存失败：${e.message}`) }
  finally { saving.value = '' }
}
function openRegistry() {
  app.openTabFromId('enterprise-settings')
  router.push('/enterprise-settings/robot#bot-registry')
}
onMounted(load)
</script>

<style scoped>
.route-page{padding:22px;border:1px solid var(--el-border-color-light);border-radius:14px;background:var(--el-bg-color)}.route-heading,.route-top,.route-footer{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.route-heading h2{margin:0;font-size:20px}.route-heading p,.route-help,.route-footer span{color:var(--el-text-color-secondary);font-size:12px;line-height:1.7}.route-heading p{margin:7px 0 0}.route-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:18px}.route-card{padding:19px;border:1px solid var(--el-border-color-light);border-radius:12px}.route-top{margin-bottom:22px}.route-top small{color:var(--el-text-color-secondary)}.route-top h3{margin:5px 0 0;font-size:17px}.route-card label{display:block;margin-bottom:8px;font-size:12px;font-weight:700}.route-card .el-select{width:100%}.route-help{min-height:42px;margin:10px 0 15px}.route-footer{align-items:center;margin-top:19px;padding-top:16px;border-top:1px solid var(--el-border-color-light)}@media(max-width:760px){.route-grid{grid-template-columns:1fr}.route-heading,.route-footer{align-items:flex-start;flex-direction:column}}
</style>
