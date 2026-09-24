<template>
  <main class="notification-page">
    <section class="notification-hero">
      <div>
        <span class="eyebrow">NOTIFICATION CENTER</span>
        <h2>消息通知</h2>
        <p>系统按规则自动生成提醒，也可以手动创建通知；点「确定」即归档，点「稍后处理」会归入待处理清单，方便逐条跟进。</p>
      </div>
      <div class="hero-side">
        <el-button type="primary" @click="openCompose">新建通知</el-button>
        <el-button :loading="loading" @click="load">刷新</el-button>
        <el-button @click="runCheck(true)">立即检查提醒</el-button>
      </div>
    </section>

    <section class="notification-tabs">
      <el-radio-group v-model="scope" size="default" @change="load">
        <el-radio-button label="pending">待处理（{{ counts.pending || 0 }}）</el-radio-button>
        <el-radio-button label="later">稍后处理（{{ counts.later || 0 }}）</el-radio-button>
        <el-radio-button label="archived">已归档（{{ counts.archived || 0 }}）</el-radio-button>
        <el-radio-button label="created">我发出的（{{ created.length }}）</el-radio-button>
      </el-radio-group>
      <small v-if="scope === 'later'" class="tab-hint">这里只显示你标记为「稍后处理」的通知，已按标记时间排序。</small>
      <small v-else-if="scope === 'archived'" class="tab-hint">已确定的通知会归档到这里，不再出现在待处理中。</small>
      <small v-else-if="scope === 'created'" class="tab-hint">你手动发出的通知，含还没到通知时间的；可以看到每位接收人是否已读、是否已处理。</small>
    </section>

    <el-skeleton v-if="loading && !notifications.length" :rows="4" animated />

    <section v-else-if="scope === 'created'" class="created-list">
      <el-empty v-if="!created.length" description="你还没有手动发出过通知。点右上角「新建通知」开始。" :image-size="110" />
      <article v-for="item in created" :key="item.id" class="notification-card">
        <header>
          <div class="notification-card__head">
            <el-tag size="small" :type="item.publish_at && item.publish_at > now ? 'warning' : 'success'" effect="plain">{{ item.publish_at && item.publish_at > now ? '定时待发' : '已发出' }}</el-tag>
            <b>{{ item.title }}</b>
          </div>
          <small class="notification-card__time">{{ item.publish_at ? `通知时间 ${item.publish_at}` : `创建于 ${item.created_at}` }}</small>
        </header>
        <p v-if="item.content" class="notification-card__content">{{ item.content }}</p>
        <div class="notification-card__meta">
          <span>{{ item.recipient_count }} 位接收人</span>
          <span>已处理 {{ item.archived_count }}</span>
          <span>已读 {{ item.recipients.filter(r => r.read).length }}</span>
        </div>
        <div class="recipient-chips">
          <span v-for="r in item.recipients" :key="r.user_id" class="recipient-chip" :class="{ read: r.read, handled: r.handled }">
            {{ r.name }}<small>{{ r.handled ? '已处理' : (r.read ? '已读' : '未读') }}</small>
          </span>
        </div>
        <footer class="notification-card__actions">
          <template v-if="item.editable">
            <el-button size="small" @click="openEditCreated(item)">修改</el-button>
            <el-button size="small" type="danger" plain @click="withdrawCreated(item)">撤回</el-button>
            <span class="created-tip">未发布，可修改或撤回</span>
          </template>
          <span v-else class="created-tip muted">已发布，不可修改或撤回</span>
        </footer>
      </article>
    </section>

    <section v-else-if="notifications.length" class="notification-list">
      <article v-for="item in notifications" :key="item.id" class="notification-card" :class="[`type-${item.type}`, { archived: item.status === '已归档', later: item.later }]">
        <header>
          <div class="notification-card__head">
            <el-tag size="small" :type="item.later ? 'warning' : (item.status === '已归档' ? 'info' : (item.source === 'manual' ? 'success' : 'primary'))" effect="plain">{{ item.type_label }}</el-tag>
            <b>{{ item.title }}</b>
          </div>
          <small class="notification-card__time">{{ item.created_at }}</small>
        </header>
        <p v-if="item.content" class="notification-card__content">{{ item.content }}</p>
        <div class="notification-card__meta">
          <span v-if="item.source === 'manual' && item.creator">来自 {{ item.creator }}</span>
          <span v-if="item.payload?.probation_date">转正日期 {{ item.payload.probation_date }}</span>
          <span v-if="item.payload?.remaining_days !== undefined && item.payload?.remaining_days !== null">距转正 {{ item.payload.remaining_days }} 天</span>
          <span v-if="item.later_at">标记稍后处理：{{ item.later_at }}</span>
          <span v-if="item.archived_at">归档时间：{{ item.archived_at }}</span>
        </div>
        <footer class="notification-card__actions">
          <template v-if="item.status !== '已归档'">
            <el-button type="primary" size="small" :loading="acting === item.id" @click="act(item, 'confirm')">确定</el-button>
            <el-button v-if="!item.later" size="small" :loading="acting === item.id" @click="act(item, 'later')">稍后处理</el-button>
            <el-button v-else size="small" :loading="acting === item.id" @click="act(item, 'reopen')">取消稍后处理</el-button>
          </template>
          <el-button v-else size="small" :loading="acting === item.id" @click="act(item, 'reopen')">退回待处理</el-button>
          <el-button v-if="item.employee_id" link type="primary" size="small" @click="openEmployee(item)">查看员工档案</el-button>
        </footer>
      </article>
    </section>

    <el-empty v-else :description="emptyText" :image-size="110" />

    <!-- 新建/修改通知：人选人、可多选接收者、通知时间可精确到分钟 -->
    <el-dialog v-model="composeVisible" :title="compose.id ? '修改通知（未发布）' : '新建通知'" width="620px" class="compose-dialog" destroy-on-close>
      <el-form label-position="top">
        <el-form-item label="通知标题" required>
          <el-input v-model="compose.title" maxlength="80" show-word-limit placeholder="例如：9 月门店例会时间调整" />
        </el-form-item>
        <el-form-item label="通知内容">
          <el-input v-model="compose.content" type="textarea" :rows="4" maxlength="600" show-word-limit placeholder="填写要告诉对方的具体内容" />
        </el-form-item>
        <el-form-item :label="compose.id ? `接收人（${compose.user_ids.length} 人，修改时不可变更）` : `接收人（已选 ${compose.user_ids.length} 人）`" required>
          <el-select v-model="compose.user_ids" multiple filterable collapse-tags collapse-tags-tooltip :disabled="Boolean(compose.id)" placeholder="可多选，输入姓名可搜索" style="width:100%">
            <el-option v-for="user in users" :key="user.id" :label="`${user.display_name || user.username}（${user.role || user.position_name || '未分配岗位'}）`" :value="user.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="通知时间">
          <el-date-picker v-model="compose.publish_at" type="datetime" value-format="YYYY-MM-DD HH:mm" format="YYYY-MM-DD HH:mm" placeholder="留空表示立即通知" style="width:100%" />
          <small class="compose-hint">可精确到分钟。填了未来时间就是定时通知，到点前接收人看不到（也不会弹窗），到点后自动出现。<template v-if="compose.id">修改时只能改成未来的时间；到点后就不能再改或撤回了。</template></small>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="composeVisible = false">取消</el-button>
        <el-button type="primary" :loading="composing" @click="submitCompose">{{ compose.id ? '保存修改' : (compose.publish_at ? '定时发出' : '立即发出') }}</el-button>
      </template>
    </el-dialog>

  </main>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import { getNotifications, checkNotifications, updateNotification, getNotificationCreated, createNotification, getNotificationSettings, updateCreatedNotification, withdrawNotification } from '@/api'

const router = useRouter()
const scope = ref('pending')
const loading = ref(false)
const acting = ref(null)
const notifications = ref([])
const counts = reactive({ pending: 0, archived: 0, later: 0 })
// 手动创建通知
const composeVisible = ref(false)
const composing = ref(false)
const users = ref([])
const created = ref([])
const now = ref('')
const compose = reactive({ id: null, title: '', content: '', user_ids: [], publish_at: '' })

const emptyText = computed(() => ({
  pending: '当前没有待处理通知。员工转正提醒会在到期前自动出现在这里。',
  later: '还没有标记为「稍后处理」的通知。',
  archived: '还没有已归档的通知。',
  created: '你还没有手动发出过通知。',
}[scope.value] || '暂无通知'))

async function load() {
  loading.value = true
  try {
    if (scope.value === 'created') { await loadCreated(); return }
    const data = await getNotifications({ status: scope.value })
    notifications.value = data.notifications || []
    Object.assign(counts, data.counts || {})
    if (data.check?.generated) ElMessage.success(`已自动生成 ${data.check.generated} 条转正提醒`)
  } catch (error) { ElMessage.error('读取通知失败：' + error.message) }
  finally { loading.value = false }
}
async function loadCreated() {
  try {
    const data = await getNotificationCreated()
    created.value = data.notifications || []
    now.value = data.now || ''
  } catch (error) { ElMessage.error('读取我发出的通知失败：' + error.message) }
}
async function loadUsers() {
  if (users.value.length) return
  try { users.value = (await getNotificationSettings()).users || [] } catch { /* 失败不阻断 */ }
}
async function openCompose() {
  await loadUsers()
  Object.assign(compose, { id: null, title: '', content: '', user_ids: [], publish_at: '' })
  composeVisible.value = true
}
// 修改未发布的定时通知：只能改标题、内容与时间，接收人不变
async function openEditCreated(item) {
  if (!item.editable) return ElMessage.warning('已发布的通知不能修改')
  await loadUsers()
  Object.assign(compose, {
    id: item.id, title: item.title || '', content: item.content || '',
    user_ids: (item.recipients || []).map(r => r.user_id), publish_at: item.publish_at || '',
  })
  composeVisible.value = true
}
// 撤回转未发布的定时通知
async function withdrawCreated(item) {
  try {
    await ElMessageBox.confirm(`确定撤回「${item.title}」吗？撤回后接收人将看不到这条通知。`, '撤回通知', { type: 'warning', confirmButtonText: '撤回', cancelButtonText: '取消' })
  } catch { return }
  try {
    const data = await withdrawNotification(item.id)
    ElMessage.success(data.message || '已撤回')
    await loadCreated()
    window.dispatchEvent(new Event('notifications:changed'))
  } catch (error) { ElMessage.error('撤回失败：' + error.message) }
}
async function submitCompose() {
  if (!compose.title.trim()) return ElMessage.warning('请填写通知标题')
  if (!compose.user_ids.length) return ElMessage.warning('请至少选择一位接收人')
  composing.value = true
  try {
    if (compose.id) {
      const data = await updateCreatedNotification(compose.id, {
        title: compose.title.trim(), content: compose.content.trim(), publish_at: compose.publish_at || '',
      })
      ElMessage.success(data.message || '已保存修改')
      composeVisible.value = false
      await loadCreated()
    } else {
      const data = await createNotification({
        title: compose.title.trim(), content: compose.content.trim(),
        user_ids: compose.user_ids, publish_at: compose.publish_at || '',
      })
      ElMessage.success(data.message || '通知已创建')
      composeVisible.value = false
      window.dispatchEvent(new Event('notifications:changed'))
      await load()
    }
  } catch (error) { ElMessage.error('保存失败：' + error.message) }
  finally { composing.value = false }
}
async function runCheck(manual) {
  loading.value = true
  try {
    const data = await checkNotifications()
    if (data.generated) ElMessage.success(`本次生成 ${data.generated} 条提醒`)
    else if (manual) ElMessage.info('当前没有到期的提醒')
    Object.assign(counts, data.counts || {})
    if (scope.value === 'pending') notifications.value = data.notifications || []
  } catch (error) { ElMessage.error('检查失败：' + error.message) }
  finally { loading.value = false }
}
async function act(item, action) {
  acting.value = item.id
  try {
    const data = await updateNotification(item.id, { action, status: scope.value })
    notifications.value = data.notifications || []
    Object.assign(counts, data.counts || {})
    ElMessage.success({ confirm: '已归档', later: '已标记稍后处理', reopen: '已退回待处理' }[action] || '已更新')
  } catch (error) { ElMessage.error('操作失败：' + error.message) }
  finally { acting.value = null }
}
function openEmployee(item) {
  router.push({ path: '/staff-management/employees', query: { keyword: '', focus: String(item.employee_id) } })
}
onMounted(load)
</script>

<style scoped>
.notification-page { max-width:1280px; margin:0 auto; padding:24px; color:#182230; }
.notification-hero { display:flex; justify-content:space-between; align-items:flex-start; gap:20px; padding:24px 28px; border-radius:18px; color:#fff; background:linear-gradient(120deg,#1d3a63,#2f6cb0 72%,#4f9ee0); box-shadow:0 12px 30px rgba(24,72,123,.16); }
.eyebrow { color:#aed8ff; font-size:11px; font-weight:700; letter-spacing:.14em; }
.notification-hero h2 { margin:5px 0 7px; font-size:26px; }
.notification-hero p { margin:0; max-width:760px; color:#d6eafe; font-size:13px; line-height:1.7; }
.hero-side { display:flex; flex-direction:column; gap:8px; }
.notification-tabs { display:flex; align-items:center; gap:14px; margin:18px 0 14px; flex-wrap:wrap; }
.tab-hint { color:#8b9aad; font-size:12px; }
.notification-list { display:grid; gap:12px; }
.created-list { display:grid; gap:12px; }
.recipient-chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
.recipient-chip { display:inline-flex; align-items:center; gap:5px; padding:2px 8px; border-radius:10px; background:#f2f6fb; color:#5b7391; font-size:11px; }
.recipient-chip.read { background:#eef7f1; color:#3f7a58; }
.recipient-chip.handled { background:#e9f5ee; color:#2f6b4a; font-weight:600; }
.recipient-chip small { color:#93a2b4; font-size:10px; }
.compose-hint { display:block; margin-top:6px; color:#93a2b4; font-size:11px; line-height:1.6; }
.notification-card { padding:15px 18px; border:1px solid #e5ecf5; border-left:4px solid #5b85e9; border-radius:12px; background:#fff; box-shadow:0 4px 14px rgba(30,54,86,.05); }
.notification-card.archived { border-left-color:#b9c4d2; background:#fbfcfe; }
.notification-card.later { border-left-color:#e0a13c; }
.notification-card header { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.notification-card__head { display:flex; align-items:center; gap:9px; min-width:0; }
.notification-card__head b { color:#243d5e; font-size:15px; }
.notification-card__time { flex:none; color:#96a3b4; font-size:11px; }
.notification-card__content { margin:9px 0 0; color:#5d6f85; font-size:13px; line-height:1.7; }
.notification-card__meta { display:flex; flex-wrap:wrap; gap:6px 16px; margin-top:9px; color:#7f8fa3; font-size:11px; }
.notification-card__actions { display:flex; align-items:center; gap:8px; margin-top:12px; padding-top:11px; border-top:1px dashed #eaeff6; }
.notification-settings { margin-top:26px; }
.notification-settings > header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:12px; }
.notification-settings h3 { margin:0 0 5px; color:#243d5e; font-size:17px; }
.notification-settings p { margin:0; color:#8b9aad; font-size:12px; }
.rule-card { margin-bottom:12px; padding:15px 18px; border:1px solid #e5ecf5; border-radius:12px; background:#fff; }
.rule-card__head { display:flex; align-items:center; justify-content:space-between; gap:14px; }
.rule-card__head b { display:block; color:#2c476a; font-size:14px; }
.rule-card__head small { color:#8b9aad; font-size:11px; }
.rule-card__body { display:grid; grid-template-columns:200px 1fr; gap:18px; margin-top:14px; }
.rule-field { display:flex; flex-direction:column; gap:7px; }
.rule-field > span { color:#6e7c90; font-size:12px; font-weight:600; }
.rule-field small { color:#94a2b4; font-size:11px; line-height:1.5; }
@media (max-width:900px) { .notification-hero { flex-direction:column; } .hero-side { flex-direction:row; flex-wrap:wrap; } .rule-card__body { grid-template-columns:1fr; } }
</style>
