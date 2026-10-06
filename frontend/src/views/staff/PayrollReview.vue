<template>
  <div class="review-workbench" v-loading="loading">
    <section class="card-compact">
      <h2>工资审核</h2><p>只审核门店已提交的工资表。未提交和退回待重提仅显示进度，不提供审批明细。</p>
      <div class="review-controls"><label>工资月份</label><el-date-picker v-model="period" type="month" value-format="YYYY-MM" :clearable="false" @change="changePeriod" /><el-radio-group v-model="staffGroup" @change="clearDetail"><el-radio-button value="store">门店</el-radio-button><el-radio-button value="group">集团</el-radio-button><el-radio-button value="all">全部</el-radio-button></el-radio-group><el-button @click="loadReview">刷新进度</el-button></div>
      <div class="progress-cards"><div><small>应提交</small><b>{{ totals.required }}</b></div><div><small>已提交</small><b>{{ totals.submitted }}</b></div><div><small>未提交 / 待重提</small><b class="warning">{{ totals.unsubmitted }}</b></div><div><small>待审核</small><b class="pending">{{ totals.pending }}</b></div><div><small>已审核</small><b class="approved">{{ totals.approved }}</b></div></div>
    </section>
    <section class="card-compact">
      <div class="review-section-heading"><h3>提交进度 · {{ period }}</h3><el-select v-model="progressFilter" style="width:180px"><el-option label="全部进度" value="all" /><el-option label="未提交 / 待重提" value="unsubmitted" /><el-option label="已提交" value="submitted" /><el-option label="待审核" value="待审核" /><el-option label="已审核" value="已审核" /></el-select></div>
      <el-table :data="progressRows" border empty-text="所选范围暂无记录"><el-table-column type="index" label="序号" width="65" /><el-table-column prop="store_name" label="门店 / 集团" min-width="220" /><el-table-column prop="employee_count" label="制薪人数" width="95" /><el-table-column label="提交状态" width="170"><template #default="{row}"><el-tag :type="statusType(row.status)">{{ row.status }}</el-tag></template></el-table-column><el-table-column prop="submitter_name" label="提交人" width="110" /><el-table-column prop="submitted_at" label="本次提交时间" width="175" /><el-table-column label="操作" width="140"><template #default="{row}"><el-button v-if="row.status==='待审核'" link type="primary" @click="openSheet(row.sheet_id)">查看并审核</el-button><el-button v-else-if="row.status==='已审核'" link type="primary" @click="openSheet(row.sheet_id)">查看已审核</el-button><span v-else>—</span></template></el-table-column></el-table>
      <p class="scope-note">应提交范围：当月有制薪员工或已经生成工资表的门店 / 集团。无制薪员工的门店不计入漏交数量；退回后需重新提交，才再次进入待审队列。</p>
    </section>
    <section class="card-compact"><el-tabs v-model="queueTab"><el-tab-pane :label="`待审核（${pendingSheets.length}）`" name="pending" /><el-tab-pane :label="`已审核（${approvedSheets.length}）`" name="approved" /></el-tabs><el-table :data="queueTab==='pending'?pendingSheets:approvedSheets" :empty-text="queueTab==='pending'?'本月暂无已提交待审核工资表':'本月暂无已审核工资表'"><el-table-column type="index" label="序号" width="65" /><el-table-column prop="store_name" label="门店 / 集团" min-width="220" /><el-table-column prop="employee_count" label="员工数" width="90" /><el-table-column prop="submitter_name" label="提交人" width="110" /><el-table-column prop="submitted_at" label="提交时间" width="175" /><el-table-column label="操作" width="140"><template #default="{row}"><el-button link type="primary" @click="openSheet(row.id)">{{ queueTab==='pending'?'查看并审核':'查看已审核' }}</el-button></template></el-table-column></el-table></section>
    <section v-if="activeSheetId" class="review-detail"><el-button @click="clearDetail">收起明细</el-button><SalaryPlaceholder :key="`${period}-${activeSheetId}`" detail-only :sheet-id="activeSheetId" :review-period="period" @changed="reviewChanged" /></section>
  </div>
</template>
<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { getPayrollReview } from '@/api'
import SalaryPlaceholder from './SalaryPlaceholder.vue'
const now=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(new Date()),[year,month]=now.split('-').map(Number)
const period=ref(new Date(Date.UTC(year,month-2,1)).toISOString().slice(0,7)),staffGroup=ref('store'),progressFilter=ref('all'),queueTab=ref('pending'),activeSheetId=ref(null),loading=ref(false)
const report=ref({coverage:[],pending:[],approved:[]})
const scopedRows=computed(()=>report.value.coverage.filter(row=>staffGroup.value==='all' || row.staff_group===staffGroup.value))
const submitted=row=>['待审核','已审核'].includes(row.status)
const totals=computed(()=>{const rows=scopedRows.value.filter(row=>row.required);return {required:rows.length,submitted:rows.filter(submitted).length,unsubmitted:rows.filter(row=>!submitted(row)).length,pending:rows.filter(row=>row.status==='待审核').length,approved:rows.filter(row=>row.status==='已审核').length}})
const progressRows=computed(()=>scopedRows.value.filter(row=>progressFilter.value==='all' || progressFilter.value==='submitted' && submitted(row) || progressFilter.value==='unsubmitted' && row.required && !submitted(row) || row.status===progressFilter.value))
const pendingSheets=computed(()=>report.value.pending.filter(row=>staffGroup.value==='all' || row.staff_group===staffGroup.value))
const approvedSheets=computed(()=>report.value.approved.filter(row=>staffGroup.value==='all' || row.staff_group===staffGroup.value))
const statusType=status=>({'待审核':'warning','已审核':'success','未提交':'info','退回待重提':'danger'}[status] || 'info')
let requestId=0
function clearDetail(){activeSheetId.value=null}
function openSheet(id){activeSheetId.value=id}
async function loadReview(){const token=++requestId;loading.value=true;try{const data=await getPayrollReview(period.value);if(token===requestId)report.value=data}catch(error){if(token===requestId){report.value={coverage:[],pending:[],approved:[]};ElMessage.error(error.message)}}finally{if(token===requestId)loading.value=false}}
async function changePeriod(){clearDetail();await loadReview()}
async function reviewChanged(){clearDetail();await loadReview()}
onMounted(loadReview)
</script>
<style scoped>
.review-workbench{display:grid;gap:16px;min-width:0}.review-workbench h2,.review-workbench h3{margin:0 0 12px}.review-workbench p{font-size:13px;color:#64748b;line-height:1.7}.review-controls,.review-section-heading{display:flex;gap:14px;align-items:center;flex-wrap:wrap}.review-controls{margin-top:16px}.review-controls :deep(.el-date-editor){width:150px}.review-section-heading{justify-content:space-between;margin-bottom:12px}.review-section-heading h3{margin:0}.progress-cards{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin-top:18px}.progress-cards>div{display:grid;gap:8px;background:#f5f8fc;border:1px solid #e5edf5;border-radius:10px;padding:16px}.progress-cards small{color:#64748b}.progress-cards b{font-size:24px;color:#234e7c}.progress-cards .warning{color:#b45309}.progress-cards .pending{color:#2563eb}.progress-cards .approved{color:#059669}.scope-note{margin-bottom:0}.review-detail{display:grid;gap:12px}@media(max-width:700px){.progress-cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
