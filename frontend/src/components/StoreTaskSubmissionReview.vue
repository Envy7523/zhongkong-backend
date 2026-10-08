<template>
  <section v-loading="loading" class="submission-records">
    <div class="record-filters">
      <div class="date-filter"><el-date-picker v-model="dates" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" aria-label="提交日期范围" style="width:100%;flex:none" /></div>
      <el-select v-model="storeId" clearable filterable placeholder="全部授权门店" aria-label="提交门店" class="store-filter"><el-option v-for="s in stores" :key="s.id" :value="s.id" :label="s.store_name" /></el-select>
      <el-select v-model="state" clearable placeholder="全部审核状态" aria-label="审核状态筛选" class="state-filter"><el-option label="待审核" value="pending" /><el-option label="审核驳回" value="rejected" /><el-option label="审核通过" value="approved" /></el-select>
      <el-button type="primary" @click="query">查询</el-button><el-button @click="reset">重置</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="space" />
    <div class="record-counts"><span>全部提交 <b>{{counts.total}}</b></span><span>待审核 <b>{{counts.pending}}</b></span><span>审核通过 <b>{{counts.approved}}</b></span><span>审核驳回 <b>{{counts.rejected}}</b></span></div>
    <el-table :data="records" stripe row-key="id" empty-text="暂无提交记录">
      <el-table-column prop="title" label="表单名称" min-width="190" />
      <el-table-column prop="store_name" label="提交门店" min-width="175" />
      <el-table-column label="提交时间" min-width="175"><template #default="{row}">{{fmt(row.submitted_at)}}</template></el-table-column>
      <el-table-column prop="submitted_name" label="提交人" min-width="100" />
      <el-table-column label="提交版本" width="95"><template #default="{row}">第 {{row.version}} 版</template></el-table-column>
      <el-table-column label="审核状态" width="115"><template #default="{row}"><el-tag :type="tone(row.status)">{{label(row.status)}}</el-tag></template></el-table-column>
      <el-table-column label="操作" width="80" fixed="right"><template #default="{row}"><el-button link type="primary" @click="open(row.id)">查看</el-button></template></el-table-column>
    </el-table>
    <el-pagination v-if="total" v-model:current-page="page" :page-size="20" :total="total" layout="total, prev, pager, next" class="pagination" @current-change="load" />
    <p class="record-hint">默认显示全部已提交记录；日期按提交时间筛选。驳回后的重新提交会保留为新版本，历史记录可查看。</p>
    <el-drawer v-model="opened" size="min(800px,95vw)" title="表单提交明细与审核" :close-on-click-modal="false" :before-close="close" destroy-on-close>
      <div v-loading="detailLoading">
        <el-alert v-if="detailError" :title="detailError" type="error" :closable="false" show-icon />
        <template v-if="record">
          <header class="record-header"><h2>{{record.title}}</h2><p>{{record.store_name}} · 业务日期 {{record.business_date}}</p><p>{{record.submitted_name}} · {{fmt(record.submitted_at)}} · 第 {{record.version}} 版</p><el-tag :type="tone(record.status)">{{label(record.status)}}</el-tag><p v-if="!record.current" class="record-hint">这是一份历史版本，仅供查看；请在列表中审核最新提交。</p></header>
          <section v-if="record.status!=='pending'" class="receipt"><h3>审核回执</h3><p>{{label(record.status)}} · {{record.reviewed_name}} · {{fmt(record.reviewed_at)}}</p><p>备注：{{record.review_note||'无备注'}}</p></section>
          <article v-for="(q,i) in record.snapshot" :key="q.id" class="submitted-question"><h3>{{String(i+1).padStart(2,'0')}} {{q.title}}</h3><el-tag size="small">{{q.execution_mode==='single'?'单人完成':'多人共同完成'}}</el-tag><StoreTaskInstructions :text="q.description" :images="q.guide_images||[]" /><p v-if="!q.contributions.length" class="record-hint">未填写（选填项）</p><div v-for="a in q.contributions" :key="a.id" class="submitted-answer"><small>{{a.user_name}} · {{fmt(a.created_at)}}</small><p v-if="a.response.value">{{displayValue(q,a.response.value)}}</p><div class="photo-buttons"><el-button v-for="(image,n) in a.response.images" :key="image" size="small" @click="showPhoto(image)">查看照片 {{n+1}}</el-button></div></div></article>
          <section v-if="reviewable" class="decision-panel"><h3>审核结果</h3><el-radio-group v-model="decision" :disabled="saving" aria-label="选择审核结果"><el-radio-button value="rejected">审核驳回</el-radio-button><el-radio-button value="approved">审核通过</el-radio-button></el-radio-group><p class="record-hint">请先选择审核状态，再填写备注。驳回必须填写，通过可不填写。</p><label class="note-label" for="submission-review-note">审核备注{{decision==='rejected'?'（必填）':decision==='approved'?'（选填）':''}}</label><el-input id="submission-review-note" v-model="note" type="textarea" :rows="3" maxlength="1000" show-word-limit :disabled="!decision||saving" :placeholder="decision?'填写审核备注':'请先选择审核状态'" /><el-alert v-if="auditError" :title="auditError" type="error" :closable="false" class="space" /><el-button type="primary" :loading="saving" :disabled="!decision||(decision==='rejected'&&!note.trim())" class="submit-decision" @click="audit">提交审核结果</el-button></section>
          <el-button v-if="nextPending" class="space" @click="open(nextPending.id)">查看下一条待审核</el-button>
        </template>
      </div>
    </el-drawer>
    <el-dialog v-model="photoOpen" title="提交照片" width="min(700px,95vw)"><img v-if="photo" :src="photo" alt="员工提交的现场照片" class="receipt-photo" /></el-dialog>
  </section>
</template>
<script setup>
import {computed,onMounted,reactive,ref} from 'vue'
import {ElMessage,ElMessageBox} from 'element-plus'
import {storeTaskApi} from '@/api'
import StoreTaskInstructions from './StoreTaskInstructions.vue'
const props=defineProps({stores:{type:Array,default:()=>[]},canReview:Boolean})
const dates=ref(null),storeId=ref(null),state=ref(''),records=ref([]),page=ref(1),total=ref(0),loading=ref(false),error=ref('')
const counts=reactive({total:0,pending:0,approved:0,rejected:0}),opened=ref(false),record=ref(null),detailLoading=ref(false),detailError=ref(''),decision=ref(''),note=ref(''),saving=ref(false),auditError=ref(''),photo=ref(''),photoOpen=ref(false)
let selectedId=0,requestVersion=0
const label=s=>({pending:'待审核',approved:'审核通过',rejected:'审核驳回'}[s]||s),tone=s=>({pending:'warning',approved:'success',rejected:'danger'}[s]||'info')
const fmt=s=>s?new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—'
const reviewable=computed(()=>props.canReview&&record.value?.current&&record.value.status==='pending'&&record.value.task_status==='pending')
const nextPending=computed(()=>props.canReview&&records.value.find(r=>r.status==='pending'&&r.id!==record.value?.id))
function displayValue(q,v){if(q.type!=='multiple')return v;try{return JSON.parse(v).join('、')}catch{return v}}
async function load(){const request=++requestVersion;loading.value=true;error.value='';try{const data=await storeTaskApi.submissions({from:dates.value?.[0],to:dates.value?.[1],store_id:storeId.value,status:state.value||undefined,page:page.value,page_size:20});if(request!==requestVersion)return;records.value=data.rows;total.value=data.total;Object.assign(counts,data.counts)}catch(e){if(request===requestVersion){error.value=e.message;records.value=[]}}finally{if(request===requestVersion)loading.value=false}}
function query(){page.value=1;load()}
function reset(){dates.value=null;storeId.value=null;state.value='';query()}
async function open(id){if(saving.value)return;if((decision.value||note.value)&&id!==selectedId){try{await ElMessageBox.confirm('尚未提交审核结果，放弃当前选择并查看下一条？','切换记录')}catch{return}}selectedId=id;opened.value=true;record.value=null;decision.value='';note.value='';auditError.value='';detailError.value='';detailLoading.value=true;try{const data=await storeTaskApi.submission(id);if(selectedId===id)record.value=data.record}catch(e){detailError.value=e.message}finally{if(selectedId===id)detailLoading.value=false}}
async function close(done){if(saving.value)return;if(decision.value||note.value){try{await ElMessageBox.confirm('尚未提交审核结果，是否放弃？','关闭审核')}catch{return}}decision.value='';note.value='';done()}
async function audit(){auditError.value='';if(!['approved','rejected'].includes(decision.value)){auditError.value='请先选择审核状态';return}if(decision.value==='rejected'&&!note.value.trim()){auditError.value='审核驳回必须填写备注';return}saving.value=true;try{await storeTaskApi.review(record.value.task_id,{status:decision.value,note:note.value,version:record.value.version});decision.value='';note.value='';record.value=(await storeTaskApi.submission(selectedId)).record;await load();ElMessage.success('审核完成，门店可在小程序任务明细查看回执')}catch(e){auditError.value=e.message}finally{saving.value=false}}
async function showPhoto(path){try{photo.value=(await storeTaskApi.photo(path)).data;photoOpen.value=true}catch(e){ElMessage.error(e.message)}}
onMounted(load)
defineExpose({load})
</script>
<style scoped>
.record-filters{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0 16px}.record-filters .date-filter{flex:0 0 300px!important;width:300px!important;max-width:100%}.record-filters .store-filter{width:220px}.record-filters .state-filter{width:155px}.record-counts{display:flex;gap:24px;flex-wrap:wrap;padding:16px 20px;background:var(--el-bg-color);border:1px solid var(--el-border-color-light);border-radius:10px;margin-bottom:16px;font-size:13px}.record-counts b{margin-left:8px;font-size:19px}.pagination{justify-content:flex-end;margin-top:18px}.record-hint{color:var(--el-text-color-secondary);font-size:13px;line-height:1.7}.record-header h2{font-size:22px}.record-header p{font-size:13px;line-height:1.8}.submitted-question{border:1px solid var(--el-border-color-light);padding:18px;border-radius:10px;margin-top:16px}.submitted-question h3,.receipt h3,.decision-panel h3{font-size:16px;margin:0 0 12px}.submitted-answer{background:var(--el-fill-color-light);padding:12px;margin:10px 0;border-radius:6px}.submitted-answer small{color:var(--el-text-color-secondary)}.photo-buttons{display:flex;gap:8px;flex-wrap:wrap}.receipt,.decision-panel{padding:20px;background:var(--el-color-primary-light-9);border-radius:10px;margin:20px 0}.receipt p{line-height:1.8;white-space:pre-wrap}.note-label{display:block;font-size:13px;margin:14px 0 10px}.submit-decision{margin-top:16px}.space{margin:16px 0}.receipt-photo{width:100%;max-height:70vh;object-fit:contain}
</style>
