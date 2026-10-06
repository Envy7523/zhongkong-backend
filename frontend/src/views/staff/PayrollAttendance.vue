<template>
  <div class="attendance-page" v-loading="loading">
    <section class="card-compact">
      <h2>月出勤管理</h2>
      <p>集团员工、门店员工分别维护工作、休息与放假安排。上个月及之前只可查看；本月及未来月份可提前设置。</p>
      <div class="toolbar">
        <el-date-picker v-model="period" type="month" value-format="YYYY-MM" :clearable="false" @change="loadMonth" />
        <el-radio-group v-model="group" @change="loadMonth"><el-radio-button value="group">集团员工</el-radio-button><el-radio-button value="store">门店员工</el-radio-button></el-radio-group>
        <el-tag :type="editable?'success':'info'">{{ editable?'可编辑':'历史月份 · 只读' }}</el-tag>
      </div>
      <div class="totals"><b>应出勤 {{ hasCalendar ? counts.work : setting.published_at ? setting.scheduled_days : '未登记' }} 天</b><span>休息 {{ hasCalendar ? counts.rest : '未登记' }} 天</span><span>放假 {{ hasCalendar ? counts.holiday : '未登记' }} 天</span><span>{{ setting.published_at ? `最后提交：${setting.published_by} · ${setting.published_at}` : '尚未提交' }}</span></div>
      <el-alert v-if="!hasCalendar" :title="setting.published_at?'该月份仅保存了应出勤天数，未登记具体工作、休息及放假日期。':'请登记每日安排后提交；应出勤天数由工作日期自动统计。'" type="info" :closable="false" />
      <div v-if="editable" class="toolbar batch">
        <el-select v-model="batchType" style="width:150px"><el-option label="全部日期" value="all" /><el-option label="周一至周五" value="weekday" /><el-option label="周六、周日" value="weekend" /></el-select>
        <el-select v-model="batchStatus" style="width:120px"><el-option label="工作" value="work" /><el-option label="休息" value="rest" /><el-option label="放假" value="holiday" /></el-select>
        <el-time-select v-model="batchStart" start="00:00" end="23:30" step="00:30" placeholder="上班时间（选填）" />
        <el-time-select v-model="batchEnd" start="00:00" end="23:30" step="00:30" placeholder="下班时间（选填）" />
        <el-checkbox v-model="batchNextDay">次日下班</el-checkbox>
        <el-button @click="applyBatch">应用到所选日期</el-button>
      </div>
      <el-table :data="days" border class="calendar-table">
        <el-table-column label="序号" width="65"><template #default="{$index}">{{ $index+1 }}</template></el-table-column>
        <el-table-column prop="date" label="日期" width="125" />
        <el-table-column prop="weekday" label="星期" width="75" />
        <el-table-column label="安排" width="130"><template #default="{row}"><el-select v-if="editable" v-model="row.type" placeholder="未登记"><el-option label="工作" value="work" /><el-option label="休息" value="rest" /><el-option label="放假" value="holiday" /></el-select><span v-else>{{ labels[row.type] || '未登记' }}</span></template></el-table-column>
        <el-table-column label="上班时间" width="165"><template #default="{row}"><el-input v-if="editable && row.type==='work'" v-model="row.start_time" placeholder="HH:mm（选填）" /><span v-else>{{ row.type==='work' ? row.start_time || '未登记' : '—' }}</span></template></el-table-column>
        <el-table-column label="下班时间" width="220"><template #default="{row}"><div v-if="editable && row.type==='work'" class="shift"><el-input v-model="row.end_time" placeholder="HH:mm（选填）" /><el-checkbox v-model="row.next_day">次日</el-checkbox></div><span v-else>{{ row.type==='work' ? (row.end_time || '未登记')+(row.next_day?'（次日）':'') : '—' }}</span></template></el-table-column>
        <el-table-column label="备注 / 放假说明" min-width="190"><template #default="{row}"><el-input v-if="editable" v-model="row.note" maxlength="200" placeholder="例如：国庆放假" /><span v-else>{{ row.note || '—' }}</span></template></el-table-column>
      </el-table>
      <div v-if="editable" class="toolbar"><el-button type="primary" :loading="saving" @click="save">提交{{ group==='group'?'集团':'门店' }}员工出勤安排</el-button><span>提交后同步对应草稿工资表；待审核、已审核工资表保留原设置。</span></div>
    </section>
    <section class="card-compact"><h3>已登记月份</h3><el-table :data="history" empty-text="暂无登记"><el-table-column label="序号" width="65"><template #default="{$index}">{{ $index+1 }}</template></el-table-column><el-table-column prop="period" label="月份" width="110" /><el-table-column label="员工范围" width="120"><template #default="{row}">{{ row.staff_group==='group'?'集团员工':'门店员工' }}</template></el-table-column><el-table-column prop="scheduled_days" label="应出勤天数" width="115" /><el-table-column label="每日明细" width="100"><template #default="{row}">{{ row.calendar.length?'已登记':'未登记' }}</template></el-table-column><el-table-column prop="published_by" label="提交人" /><el-table-column prop="published_at" label="提交时间" /><el-table-column label="操作" width="90"><template #default="{row}"><el-button link type="primary" @click="openHistory(row)">{{ row.can_edit?'查看 / 编辑':'查看' }}</el-button></template></el-table-column></el-table></section>
  </div>
</template>
<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { getPayrollAttendanceSettings, getPayrollMonthSetting, savePayrollMonthSetting } from '@/api'
const currentMonth=ref(''),period=ref(''),group=ref('store'),history=ref([]),days=ref([]),setting=ref({scheduled_days:26,version:0}),loading=ref(false),saving=ref(false)
const batchType=ref('weekday'),batchStatus=ref('work'),batchStart=ref(''),batchEnd=ref(''),batchNextDay=ref(false)
const labels={work:'工作',rest:'休息',holiday:'放假'}
const editable=computed(()=>!!currentMonth.value && period.value>=currentMonth.value)
const hasCalendar=computed(()=>days.value.length>0 && days.value.every(day=>!!day.type))
const counts=computed(()=>days.value.reduce((all,day)=>{if(day.type)all[day.type]++;return all},{work:0,rest:0,holiday:0}))
let generation=0
async function loadMonth(){if(!period.value)return;const token=++generation;loading.value=true;try{const data=await getPayrollMonthSetting(period.value);if(token!==generation)return;currentMonth.value=data.current_month;setting.value=data.settings[group.value];const count=new Date(Number(period.value.slice(0,4)),Number(period.value.slice(5)),0).getDate();days.value=Array.from({length:count},(_,index)=>{const date=`${period.value}-${String(index+1).padStart(2,'0')}`,weekdayIndex=new Date(`${date}T12:00:00+08:00`).getUTCDay();return {date,type:'',start_time:'',end_time:'',next_day:false,note:'',...setting.value.calendar.find(day=>day.date===date),weekday:['周日','周一','周二','周三','周四','周五','周六'][weekdayIndex],weekend:[0,6].includes(weekdayIndex)}})}catch(error){ElMessage.error(error.message)}finally{if(token===generation)loading.value=false}}
async function loadHistory(){const data=await getPayrollAttendanceSettings();history.value=data.settings;currentMonth.value=data.current_month}
function applyBatch(){for(const day of days.value){if(batchType.value==='weekday' && day.weekend || batchType.value==='weekend' && !day.weekend)continue;Object.assign(day,{type:batchStatus.value,start_time:batchStatus.value==='work'?batchStart.value:'',end_time:batchStatus.value==='work'?batchEnd.value:'',next_day:batchStatus.value==='work' && batchNextDay.value})}}
async function save(){if(!editable.value || !hasCalendar.value){ElMessage.warning('请登记当月每一天的安排');return}try{await ElMessageBox.confirm(`确认提交 ${period.value} ${group.value==='group'?'集团':'门店'}员工安排？工作 ${counts.value.work} 天，休息 ${counts.value.rest} 天，放假 ${counts.value.holiday} 天。`,'提交出勤安排');saving.value=true;await savePayrollMonthSetting(period.value,{staff_group:group.value,scheduled_days:counts.value.work,calendar:days.value,version:setting.value.version});await loadHistory();await loadMonth();ElMessage.success('出勤安排已提交')}catch(error){if(error!=='cancel' && error!=='close')ElMessage.error(error.message)}finally{saving.value=false}}
async function openHistory(row){period.value=row.period;group.value=row.staff_group;await loadMonth()}
onMounted(async()=>{loading.value=true;try{await loadHistory();period.value=currentMonth.value;await loadMonth()}catch(error){ElMessage.error(error.message)}finally{loading.value=false}})
</script>
<style scoped>
.attendance-page{display:grid;gap:16px;min-width:0}.attendance-page h2,.attendance-page h3{margin:0 0 12px}.attendance-page p{color:#64748b;font-size:13px}.toolbar,.totals{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin:16px 0}.totals{padding:16px;background:#f2f7fc;border-radius:8px;font-size:13px}.totals b{color:#2563eb}.toolbar>span{font-size:12px;color:#64748b}.batch :deep(.el-date-editor){width:165px}.calendar-table{width:100%}.shift{display:flex;gap:8px;align-items:center}.shift .el-input{min-width:90px}.shift .el-checkbox{margin-right:0}
</style>
