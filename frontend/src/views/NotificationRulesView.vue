<template>
  <main class="notification-rules-page">
    <section class="rules-hero">
      <div>
        <span class="eyebrow">NOTIFICATION RULES</span>
        <h2>通知规则</h2>
        <p>设置各类到期提醒的提前天数和接收人。提醒会出现在运营工具的「消息通知」中。</p>
      </div>
      <el-button type="primary" :loading="saving" @click="save">保存规则</el-button>
    </section>
    <section class="rules-panel">
      <header>
        <div><h3>到期提醒</h3><p>员工转正、劳动合同到期临近时，系统将通知所选人员。</p></div>
        <el-button :loading="checking" @click="checkNow">立即检查</el-button>
      </header>
      <article v-for="(rule, type) in rules" :key="type" class="rule-card">
        <div class="rule-card__head">
          <div><b>{{ rule.label || type }}</b><small>{{ rule.description || '按日期自动生成提醒' }}</small></div>
          <el-switch v-model="rule.enabled" active-text="启用" inactive-text="停用" />
        </div>
        <div class="rule-card__body">
          <label class="rule-field">
            <span>提前提醒天数</span>
            <el-input-number v-model="rule.lead_days" :min="0" :max="90" controls-position="right" />
            <small>例如填 {{ rule.date_label === '合同到期日' ? 30 : 15 }}：在{{ rule.date_label || '日期' }}前该天数生成消息通知。</small>
          </label>
          <label class="rule-field">
            <span>接收人员</span>
            <el-select v-model="rule.user_ids" multiple filterable collapse-tags collapse-tags-tooltip placeholder="请选择接收提醒的后台人员">
              <el-option v-for="user in users" :key="user.id" :label="userLabel(user)" :value="user.id" />
            </el-select>
            <small>接收人可在运营工具的「消息通知」中确认、归档或稍后处理。</small>
          </label>
        </div>
      </article>
      <section v-for="(rule, type) in rules" v-show="upcomingOf(type).length" :key="'up-' + type" class="upcoming-panel">
        <b>{{ rule.preview_title || '近期节点' }}</b>
        <p>以下为系统已识别的员工；到预计触发日才会进入「消息通知」。</p>
        <div v-for="item in upcomingOf(type)" :key="type + '-' + item.employee_id" class="upcoming-item">
          <span><strong>{{ item.name }}</strong><em v-if="item.store_name"> · {{ item.store_name }}</em></span>
          <span>{{ item.date_label || '日期' }} {{ item.milestone_date }}</span>
          <span>预计 {{ item.trigger_date }} 生成提醒<small v-if="item.days_until_trigger > 0">（还有 {{ item.days_until_trigger }} 天）</small><small v-else>（已进入提醒范围）</small></span>
        </div>
      </section>
    </section>
  </main>
</template>
<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { checkNotifications, getNotificationSettings, saveNotificationSettings } from '@/api'
const rules = reactive({})
const users = ref([])
const upcomingByType = reactive({})
const saving = ref(false)
const checking = ref(false)
const userLabel = (user) => (user.display_name || user.username) + '（' + (user.role || user.position_name || '未分配岗位') + '）'
const upcomingOf = (type) => upcomingByType[type] || []
function applyPayload(data) {
  Object.keys(rules).forEach(key => delete rules[key])
  // 接口已在每条规则里带上 label / description / date_label，直接整体替换即可。
  Object.assign(rules, data.rules || {})
  users.value = data.users || users.value
  Object.keys(upcomingByType).forEach(key => delete upcomingByType[key])
  const grouped = data.upcoming_by_type || (data.upcoming ? { probation_due: data.upcoming } : {})
  Object.assign(upcomingByType, grouped)
}
async function load() {
  try { applyPayload(await getNotificationSettings()) }
  catch (error) { ElMessage.error('读取通知规则失败：' + error.message) }
}
async function save() {
  saving.value = true
  try { applyPayload(await saveNotificationSettings({ rules })); ElMessage.success('通知规则已保存') }
  catch (error) { ElMessage.error('保存失败：' + error.message) }
  finally { saving.value = false }
}
async function checkNow() {
  checking.value = true
  try {
    const data = await checkNotifications()
    ElMessage.success(data.generated ? '已生成 ' + data.generated + ' 条到期提醒' : '当前没有到期提醒')
  } catch (error) { ElMessage.error('检查失败：' + error.message) }
  finally { checking.value = false }
}
onMounted(load)
</script>
<style scoped>
.notification-rules-page { max-width:1120px; margin:0 auto; padding:24px; color:#182230; }
.rules-hero { display:flex; justify-content:space-between; align-items:center; gap:20px; padding:24px 28px; border-radius:18px; color:#fff; background:linear-gradient(120deg,#2c476a,#4d6f99); box-shadow:0 12px 30px rgba(24,72,123,.12); }
.eyebrow { color:#c8ddf6; font-size:11px; font-weight:700; letter-spacing:.14em; }
.rules-hero h2 { margin:5px 0 7px; font-size:26px; }
.rules-hero p { margin:0; color:#e1ecf9; font-size:13px; line-height:1.7; }
.rules-panel { margin-top:20px; padding:20px; border:1px solid #e5ecf5; border-radius:16px; background:#fff; }
.rules-panel > header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:14px; }
.rules-panel h3 { margin:0 0 5px; color:#243d5e; font-size:17px; }
.rules-panel p { margin:0; color:#8b9aad; font-size:12px; }
.rule-card { padding:16px 18px; border:1px solid #e5ecf5; border-radius:12px; background:#fbfcfe; }
.rule-card + .rule-card { margin-top:12px; }
.rule-card__head { display:flex; align-items:center; justify-content:space-between; gap:14px; }
.rule-card__head b { display:block; color:#2c476a; font-size:14px; }
.rule-card__head small { color:#8b9aad; font-size:11px; }
.rule-card__body { display:grid; grid-template-columns:200px 1fr; gap:18px; margin-top:16px; }
.rule-field { display:flex; flex-direction:column; gap:7px; }
.rule-field > span { color:#6e7c90; font-size:12px; font-weight:600; }
.rule-field small { color:#94a2b4; font-size:11px; line-height:1.5; }
.upcoming-panel { margin-top:16px; padding:14px 16px; border-radius:10px; background:#f5f8fc; }
.upcoming-panel > b { color:#2c476a; font-size:13px; }
.upcoming-panel > p { margin:5px 0 10px; color:#8493a6; font-size:11px; }
.upcoming-item { display:grid; grid-template-columns:minmax(180px,1fr) 150px minmax(230px,1.2fr); gap:12px; padding:9px 0; border-top:1px solid #e3eaf3; color:#536981; font-size:12px; }
.upcoming-item strong { color:#2c476a; }
.upcoming-item em { color:#8493a6; font-style:normal; }
.upcoming-item small { margin-left:4px; color:#c48425; }
@media (max-width:760px) { .rules-hero { align-items:flex-start; flex-direction:column; } .rule-card__body, .upcoming-item { grid-template-columns:1fr; gap:4px; } }
</style>
