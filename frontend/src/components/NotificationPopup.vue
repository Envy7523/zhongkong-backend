<template>
  <el-dialog
    v-model="visible"
    width="520px"
    class="notify-popup"
    :show-close="false"
    align-center
    @closed="onClosed"
  >
    <template #header>
      <div class="np-head">
        <span class="np-dot" />
        <b>新通知</b>
        <em>{{ items.length }} 条</em>
      </div>
    </template>

    <ul class="np-list">
      <li v-for="item in items" :key="item.id" class="np-item" :class="{ done: handled[item.id] }">
        <div class="np-item__main">
          <b class="np-item__title" :title="item.title">{{ item.title }}</b>
          <span v-if="item.content" class="np-item__desc" :title="item.content">{{ item.content }}</span>
        </div>
        <div class="np-item__side">
          <template v-if="handled[item.id]">
            <span class="np-item__done">{{ handled[item.id] === 'confirm' ? '已归档' : '已稍后' }}</span>
          </template>
          <template v-else>
            <el-button size="small" type="primary" :loading="acting === item.id" @click="act(item, 'confirm')">确定</el-button>
            <el-button size="small" text :loading="acting === item.id" @click="act(item, 'later')">稍后</el-button>
          </template>
        </div>
      </li>
    </ul>

    <template #footer>
      <div class="np-foot">
        <span class="np-foot__hint">{{ remaining ? `还有 ${remaining} 条待处理` : '已全部处理' }}</span>
        <div class="np-foot__actions">
          <el-button size="small" text @click="openCenter">通知中心</el-button>
          <el-button size="small" @click="visible = false">关闭</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'
import { getNotificationPopup, updateNotification } from '@/api'

const router = useRouter()
const visible = ref(false)
const items = ref([])
const acting = ref(null)
const handled = reactive({})
const remaining = computed(() => items.value.filter(item => !handled[item.id]).length)

// 轮询间隔：定时通知到点后，最多这么久就会自动弹出（无需刷新页面）。
// 用户停在某个不刷新页面的功能里处理事情时，也能及时收到。
const POLL_INTERVAL_MS = 30000
let pollTimer = null

async function load() {
  try {
    const data = await getNotificationPopup()
    const list = data.notifications || []
    if (!list.length) return
    // 弹窗已经开着时，把新到的通知并进来，而不是覆盖用户正在处理的那批
    const known = new Set(items.value.map(item => item.id))
    const fresh = list.filter(item => !known.has(item.id))
    if (!fresh.length) return
    items.value = [...items.value, ...fresh]
    visible.value = true
  } catch { /* 弹窗失败不影响主流程 */ }
}
function startPolling() {
  if (pollTimer) return
  pollTimer = window.setInterval(() => {
    // 用户正在看弹窗时不打断；等关掉后下一轮会带出新的
    if (document.hidden || visible.value) return
    load()
  }, POLL_INTERVAL_MS)
}
function stopPolling() {
  if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null }
}
// 页面从后台切回前台时立刻查一次（用户可能挂了很久才回来）
function onVisibilityChange() { if (!document.hidden && !visible.value) load() }
async function act(item, action) {
  acting.value = item.id
  try {
    const data = await updateNotification(item.id, { action, status: 'pending' })
    handled[item.id] = action
    window.dispatchEvent(new CustomEvent('notifications:changed', { detail: { counts: data.counts } }))
    ElMessage.success({ confirm: '已归档', later: '已标记稍后处理' }[action] || '已更新')
  } catch (error) { ElMessage.error('操作失败：' + error.message) }
  finally { acting.value = null }
}
function openCenter() {
  visible.value = false
  router.push('/notifications')
}
function onClosed() {
  items.value = []
  Object.keys(handled).forEach(key => delete handled[key])
  window.dispatchEvent(new Event('notifications:changed'))
}
onMounted(() => {
  load()
  startPolling()
  document.addEventListener('visibilitychange', onVisibilityChange)
})
onBeforeUnmount(() => {
  stopPolling()
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<style scoped>
.np-head { display:flex; align-items:center; gap:8px; }
.np-dot { width:7px; height:7px; border-radius:50%; background:#e0453f; box-shadow:0 0 0 3px rgba(224,69,63,.14); }
.np-head b { color:#243d5e; font-size:15px; font-weight:650; }
.np-head em { color:#93a2b4; font-size:12px; font-style:normal; }
.np-list { max-height:46vh; margin:0; padding:0; overflow:auto; list-style:none; }
.np-item { display:flex; align-items:center; gap:12px; padding:11px 2px; border-top:1px solid #f0f4f9; }
.np-item:first-child { border-top:0; }
.np-item.done { opacity:.55; }
.np-item__main { min-width:0; flex:1; }
.np-item__title { display:block; overflow:hidden; color:#26364b; font-size:13px; font-weight:600; text-overflow:ellipsis; white-space:nowrap; }
.np-item__desc { display:block; margin-top:3px; overflow:hidden; color:#8b9aad; font-size:12px; text-overflow:ellipsis; white-space:nowrap; }
.np-item__side { display:flex; flex:none; align-items:center; gap:4px; }
.np-item__done { color:#5a8f6e; font-size:12px; }
.np-foot { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.np-foot__hint { color:#93a2b4; font-size:12px; }
.np-foot__actions { display:flex; align-items:center; gap:6px; }
</style>
