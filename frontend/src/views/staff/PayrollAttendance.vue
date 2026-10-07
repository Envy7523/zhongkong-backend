<template>
  <div class="attendance-page" v-loading="loading">
    <section class="card-compact month-card">
      <div class="heading"><h2>月出勤管理</h2><el-date-picker v-model="period" type="month" value-format="YYYY-MM" :clearable="false" @change="loadMonth" /><el-radio-group v-model="group" @change="loadMonth"><el-radio-button value="group">办公室员工</el-radio-button><el-radio-button value="store">门店员工</el-radio-button></el-radio-group><el-tag v-if="currentMonth && period<currentMonth" type="info">历史月份 · 只读</el-tag></div>
      <template v-if="group==='group'">
        <div class="tools"><span>出勤 {{ counts.work }} 天 · 休息 / 放假 {{ counts.rest+counts.holiday }} 天<span v-if="counts.unset"> · 未标记 {{ counts.unset }} 天</span></span><el-radio-group v-if="editable" v-model="mark"><el-radio-button value="work">标记出勤</el-radio-button><el-radio-button value="rest">标记休息</el-radio-button></el-radio-group><el-button v-if="editable" size="small" @click="weekdays">周一至周五出勤</el-button></div>
        <MonthCalendar :period="period" :days="days" :editable="editable" @select="setDay"><template #default="{day}"><span :class="['day-status',day.type]">{{ labels[day.type] || '未标记' }}</span><small v-if="day.note" class="day-note">{{ day.note }}</small></template></MonthCalendar>
        <p class="muted">{{ editable?'选择出勤或休息后，点击日期标记。':'历史安排仅可查看。' }}<span v-if="!hasCalendar && setting.published_at"> 本月原记录只有应出勤 {{ setting.scheduled_days }} 天，未保存具体日期。</span></p>
      </template>
      <div v-else class="store-days"><span>门店员工月应出勤</span><el-input v-if="editable" v-model="storeDays" inputmode="decimal" style="width:100px" /><b v-else>{{ setting.scheduled_days }}</b><span>天</span><span class="muted">各员工错开休息，具体出勤以个人考勤为准。</span></div>
      <div class="footer"><el-button v-if="editable" type="primary" :loading="saving" @click="save">保存{{ group==='group'?'办公室日历':'门店出勤天数' }}</el-button><span class="muted">{{ setting.published_at ? `最后提交：${setting.published_by} · ${setting.published_at}` : '尚未提交' }}</span></div>
    </section>
    <section class="card-compact"><div class="heading"><h3>历史月份</h3><el-switch v-model="showHistory" active-text="展开" /></div><el-table v-if="showHistory" :data="history" empty-text="暂无登记" size="small"><el-table-column prop="period" label="月份" width="110" /><el-table-column label="员工范围" width="120"><template #default="{row}">{{ row.staff_group==='group'?'办公室员工':'门店员工' }}</template></el-table-column><el-table-column prop="scheduled_days" label="应出勤天数" width="115" /><el-table-column prop="published_by" label="提交人" /><el-table-column prop="published_at" label="提交时间" /><el-table-column label="操作" width="90"><template #default="{row}"><el-button link type="primary" @click="openHistory(row)">{{ row.can_edit?'查看 / 编辑':'查看' }}</el-button></template></el-table-column></el-table></section>
  </div>
</template>
<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import MonthCalendar from '@/components/MonthCalendar.vue'
import { getPayrollAttendanceSettings, getPayrollMonthSetting, savePayrollMonthSetting } from '@/api'
const currentMonth=ref(''),period=ref(''),group=ref('group'),history=ref([]),days=ref([]),setting=ref({scheduled_days:26,version:0}),storeDays=ref(26),loading=ref(false),saving=ref(false),mark=ref('work'),showHistory=ref(false)
const labels={work:'出勤',rest:'休息',holiday:'放假'}
const editable=computed(()=>!!currentMonth.value && period.value>=currentMonth.value && !saving.value)
const hasCalendar=computed(()=>days.value.length>0 && days.value.every(day=>!!day.type))
const counts=computed(()=>days.value.reduce((all,day)=>{all[day.type || 'unset']++;return all},{work:0,rest:0,holiday:0,unset:0}))
let generation=0
async function loadMonth(){if(!period.value)return;const token=++generation;loading.value=true;try{const data=await getPayrollMonthSetting(period.value);if(token!==generation)return;currentMonth.value=data.current_month;setting.value=data.settings[group.value];storeDays.value=setting.value.scheduled_days;const count=new Date(Number(period.value.slice(0,4)),Number(period.value.slice(5)),0).getDate();days.value=Array.from({length:count},(_,index)=>{const date=`${period.value}-${String(index+1).padStart(2,'0')}`;return {date,type:'',start_time:'',end_time:'',next_day:false,note:'',...setting.value.calendar.find(day=>day.date===date)}})}catch(error){ElMessage.error(error.message)}finally{if(token===generation)loading.value=false}}
async function loadHistory(){const data=await getPayrollAttendanceSettings();history.value=data.settings;currentMonth.value=data.current_month}
function setDay(day){if(!editable.value)return;Object.assign(day,{type:mark.value,start_time:'',end_time:'',next_day:false,note:''})}
function weekdays(){for(const day of days.value){const weekday=new Date(`${day.date}T12:00:00+08:00`).getUTCDay();Object.assign(day,{type:[0,6].includes(weekday)?'rest':'work',start_time:'',end_time:'',next_day:false,note:''})}}
async function save(){if(!editable.value)return;if(group.value==='group' && !hasCalendar.value){ElMessage.warning('请标记当月每一天为出勤或休息');return}const scheduledDays=group.value==='group'?counts.value.work:Number(storeDays.value);if(!Number.isFinite(scheduledDays) || scheduledDays<0 || scheduledDays>days.value.length || String(storeDays.value).trim()==='' && group.value==='store'){ElMessage.warning('请输入当月范围内的有效出勤天数');return}try{saving.value=true;await savePayrollMonthSetting(period.value,{staff_group:group.value,scheduled_days:scheduledDays,calendar:group.value==='group'?days.value:[],version:setting.value.version});await loadHistory();await loadMonth();ElMessage.success('已保存')}catch(error){ElMessage.error(error.message)}finally{saving.value=false}}
async function openHistory(row){period.value=row.period;group.value=row.staff_group;await loadMonth()}
onMounted(async()=>{loading.value=true;try{await loadHistory();period.value=currentMonth.value;await loadMonth()}catch(error){ElMessage.error(error.message)}finally{loading.value=false}})
</script>
<style scoped>
.attendance-page{display:grid;gap:14px;min-width:0}.month-card{max-width:980px}.heading,.tools,.footer,.store-days{display:flex;align-items:center;flex-wrap:wrap;gap:14px}.heading{margin-bottom:16px}.heading h2,.heading h3{margin:0}.heading :deep(.el-date-editor){width:155px}.tools{justify-content:space-between;margin-bottom:12px;font-size:13px}.footer{margin-top:16px}.muted{font-size:12px;color:#64748b;line-height:1.6}.store-days{padding:12px 0}.day-status{font-size:12px;color:#94a3b8}.day-status.work{color:#2563eb}.day-status.rest,.day-status.holiday{color:#15803d}.day-note{font-size:11px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%}
</style>
