<template>
  <section class="store-bots">
    <header class="heading">
      <div>
        <h2>门店群机器人配置</h2>
        <p>每家门店对应一个机器人。此处只核对归属，单店日报生成与发送尚未启用。</p>
      </div>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </header>
    <el-alert type="info" :closable="false" show-icon title="当前仅登记与核对门店机器人；不会向门店群发送日报。" />
    <div class="summary">
      <div><strong>{{ stores.length }}</strong><span>门店总数</span></div>
      <div><strong>{{ assignedCount }}</strong><span>已登记机器人</span></div>
      <div><strong>{{ stores.length - assignedCount }}</strong><span>待配置门店</span></div>
    </div>
    <div class="toolbar">
      <el-input v-model="keyword" clearable placeholder="搜索门店或机器人" />
      <el-checkbox v-model="onlyUnassigned">只看待配置</el-checkbox>
      <el-button type="primary" plain @click="router.push('/enterprise-settings/robot#bot-registry')">前往机器人管理</el-button>
    </div>
    <el-table v-loading="loading" :data="visibleStores" stripe empty-text="没有符合条件的门店">
      <el-table-column prop="store_name" label="门店" min-width="220" />
      <el-table-column label="归属机器人" min-width="210"><template #default="{ row }">{{ byStore.get(row.id)?.name || '尚未登记' }}</template></el-table-column>
      <el-table-column label="配置状态" min-width="160"><template #default="{ row }"><el-tag :type="statusType(row)">{{ statusText(row) }}</el-tag></template></el-table-column>
      <el-table-column label="日报发送" min-width="145"><template #default>尚未启用</template></el-table-column>
    </el-table>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { getWecomRouting } from '@/api'

const router = useRouter()
const loading = ref(false), stores = ref([]), bots = ref([])
const keyword = ref(''), onlyUnassigned = ref(false)
const byStore = computed(() => new Map(bots.value.filter(bot => bot.audience === 'store' && bot.store_id).map(bot => [bot.store_id, bot])))
const assignedCount = computed(() => stores.value.filter(store => byStore.value.has(store.id)).length)
const visibleStores = computed(() => stores.value.filter(store => {
  const bot = byStore.value.get(store.id)
  return (!onlyUnassigned.value || !bot) && (!keyword.value || `${store.store_name} ${bot?.name || ''}`.toLowerCase().includes(keyword.value.trim().toLowerCase()))
}))
const statusType = store => { const bot = byStore.value.get(store.id); return !bot ? 'info' : bot.enabled && bot.configured ? 'success' : 'warning' }
const statusText = store => { const bot = byStore.value.get(store.id); return !bot ? '待配置' : bot.enabled && bot.configured ? '已登记' : '已登记，暂停使用' }
async function load() {
  loading.value = true
  try { const result = await getWecomRouting(); stores.value = result.stores || []; bots.value = result.bots || [] }
  catch (error) { ElMessage.error(`读取门店机器人失败：${error.message}`) }
  finally { loading.value = false }
}
onMounted(load)
</script>

<style scoped>
.store-bots{padding:24px;border:1px solid #dce5f1;border-radius:14px;background:#fff}.heading{display:flex;justify-content:space-between;gap:16px;align-items:start;margin-bottom:16px}.heading h2{margin:0 0 6px;color:#1c3154;font-size:19px}.heading p{margin:0;color:#687b91;font-size:13px}.summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:18px 0}.summary>div{display:flex;flex-direction:column;gap:4px;padding:16px;border-radius:10px;background:#f5f8fc}.summary strong{font-size:25px;color:#1d416c}.summary span{font-size:12px;color:#697d92}.toolbar{display:flex;align-items:center;gap:14px;margin-bottom:16px}.toolbar .el-input{max-width:260px}.toolbar .el-button{margin-left:auto}@media(max-width:700px){.store-bots{padding:16px}.summary{grid-template-columns:1fr}.toolbar{flex-wrap:wrap}.toolbar .el-button{margin-left:0}}
</style>
