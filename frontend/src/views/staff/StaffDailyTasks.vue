<template>
 <main class="staff-ui daily-staff-page" v-loading="loading"><header class="staff-page-heading"><div><span class="staff-eyebrow">粤宏潮 · 人事自动化</span><h1>每日任务</h1><p>自动执行考勤同步，查看任务进度、异常及入库结果。</p></div><el-button :loading="loading" @click="load">刷新状态</el-button></header>
 <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="daily-task-alert"/>
 <section v-if="task" class="staff-panel"><header class="staff-panel-heading"><div><div class="task-title"><h2>钉钉考勤同步</h2><el-tag :type="tone">{{ taskLabel }}</el-tag></div><p class="staff-muted">每天 {{ task.planned_time }} 自动执行 · 北京时间 · 回扫近 {{ task.lookbackDays }} 天，覆盖补卡更新</p></div><el-tag effect="plain">{{ task.enabled?'每日自动执行':'已停用' }}</el-tag></header>
 <div class="daily-task-metrics"><div><small>已绑定员工</small><strong>{{ task.mapped_employees || 0 }}<em>人</em></strong></div><div><small>最近同步人数</small><strong>{{ latestResult?.employee_count ?? '—' }}<em>人</em></strong></div><div><small>最近入库打卡</small><strong>{{ latestResult?.record_count ?? '—' }}<em>条</em></strong></div><div><small>下次任务</small><b>{{ nextRun }}</b></div></div>
 <div class="staff-panel-body"><el-alert v-if="!task.configured" title="钉钉应用尚未配置，任务正在等待配置，不计为同步成功。" type="warning" show-icon :closable="false"/><el-alert v-else-if="!task.mapped_employees" title="尚无已绑定钉钉员工ID的员工，请在员工基础资料中维护。" type="warning" show-icon :closable="false"/><p class="staff-muted">任务同步截至前一天的考勤；失败后按 5、15、60 分钟间隔重试，每日最多尝试 4 次。成功任务不会因服务重启而重复执行。</p><h3>每日执行记录</h3><el-table :data="task.recent_tasks||[]" empty-text="暂无每日执行记录；任务到点自动开始"><el-table-column prop="business_date" label="数据截止日" width="125"/><el-table-column label="状态" width="105"><template #default="{row}"><el-tag :type="row.status==='success'?'success':row.status==='failed'?'danger':'warning'">{{ statusName(row.status) }}</el-tag></template></el-table-column><el-table-column prop="attempts" label="尝试次数" width="90" align="center"/><el-table-column label="同步范围" min-width="210"><template #default="{row}">{{ row.window_start }} 至 {{ row.window_end }}</template></el-table-column><el-table-column prop="message" label="执行结果" min-width="260"/><el-table-column label="下次重试" min-width="160"><template #default="{row}">{{ format(row.next_retry_at) }}</template></el-table-column></el-table></div></section>
 </main>
</template>
<script setup>
import {computed,onBeforeUnmount,onMounted,ref} from 'vue'
import {getAttendanceDailyTask} from '@/api'
import '@/styles/staff-workspace.css'
const task=ref(null),loading=ref(false),error=ref('');let timer
const statusName=s=>({success:'已完成',failed:'失败',running:'执行中',blocked:'待配置'})[s]||'待执行'
const taskLabel=computed(()=>!task.value?.enabled?'已停用':!task.value?.configured?'待配置':statusName(task.value.latest_task?.status))
const tone=computed(()=>!task.value?.configured?'warning':task.value?.latest_task?.status==='success'?'success':task.value?.latest_task?.status==='failed'?'danger':'info')
const latestResult=computed(()=>{try{return JSON.parse(task.value?.latest_task?.result_json||'{}')}catch{return {}}})
const format=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—'
const nextRun=computed(()=>task.value?.latest_task?.next_retry_at?format(task.value.latest_task.next_retry_at):task.value?.next_run_at||'—')
async function load(){if(loading.value)return;loading.value=true;error.value='';try{task.value=await getAttendanceDailyTask()}catch(e){error.value=e.message||'任务状态读取失败'}finally{loading.value=false}}
onMounted(()=>{load();timer=setInterval(load,60000)});onBeforeUnmount(()=>clearInterval(timer))
</script>
<style scoped>
.task-title{display:flex;gap:12px;align-items:center}.daily-task-metrics{display:grid;grid-template-columns:1fr 1fr 1fr 1.6fr;border-bottom:1px solid var(--staff-line)}.daily-task-metrics>div{padding:24px;display:grid;gap:12px;border-right:1px solid var(--staff-line)}.daily-task-metrics>div:last-child{border-right:0}.daily-task-metrics small{font-size:12px;color:var(--staff-muted)}.daily-task-metrics strong{font-size:27px;font-weight:650;font-variant-numeric:tabular-nums}.daily-task-metrics em{font-size:12px;color:var(--staff-muted);font-style:normal;font-weight:400;margin-left:8px}.daily-task-metrics b{font-size:15px;line-height:1.5}.staff-panel-body h3{font-size:14px;margin:28px 0 16px}.daily-task-alert{margin-bottom:16px}@media(max-width:750px){.daily-task-metrics{grid-template-columns:1fr 1fr}.daily-task-metrics>div{padding:18px;border-bottom:1px solid var(--staff-line)}.task-title{flex-wrap:wrap}}
</style>
