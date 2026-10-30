<template>
 <section v-loading="loading" class="task-stores">
  <header><span class="eyebrow">当前任务</span><h2>{{template.title}}</h2><p>查看参与门店及最近一期执行情况。</p></header>
  <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
  <div class="counts"><div><small>参与门店</small><strong>{{rows.length}}</strong></div><div><small>待提交</small><strong>{{rows.filter(r=>['draft','rejected'].includes(r.status)).length}}</strong></div><div><small>待审核</small><strong>{{rows.filter(r=>r.status==='pending').length}}</strong></div><div><small>已通过</small><strong>{{rows.filter(r=>r.status==='approved').length}}</strong></div></div>
  <div class="filters"><el-input v-model="keyword" placeholder="搜索参与门店" clearable aria-label="搜索参与门店"/><el-select v-model="state" clearable placeholder="全部执行状态" aria-label="门店执行状态"><el-option v-for="(v,k) in labels" :key="k" :label="v" :value="k"/></el-select><el-button @click="load">刷新</el-button></div>
  <el-table :data="filtered" row-key="store_id" empty-text="暂无参与门店，可通过下发设置加入门店">
   <el-table-column prop="store_name" label="参与门店" min-width="185"/>
   <el-table-column label="下发方式" min-width="130"><template #default="{row}"><span>{{row.plan?cycles[row.plan.frequency]+' · 长期':row.task_kind==='windowed'?'限时任务':'指定日期'}}</span><small v-if="row.plan" class="sub">{{row.plan.opens_time||'00:00'}}—{{row.plan.due_time}}</small></template></el-table-column>
   <el-table-column label="最近一期" width="120"><template #default="{row}">{{row.business_date||'尚未生成'}}</template></el-table-column>
   <el-table-column label="执行状态" width="125"><template #default="{row}"><el-tooltip :disabled="!row.execution_reason" :content="row.execution_reason"><el-tag :type="tone(row.status)">{{labels[row.status]||row.status}}</el-tag></el-tooltip></template></el-table-column>
   <el-table-column label="后续下发" width="125"><template #default="{row}">{{row.plan?.next_date||'无自动计划'}}</template></el-table-column>
   <el-table-column label="操作" width="155" fixed="right"><template #default="{row}"><el-button v-if="row.task_id" link type="primary" @click="$emit('view-task',row.task_id)">查看任务</el-button><el-button link type="danger" :disabled="removing!==null" @click="remove(row)">移除</el-button></template></el-table-column>
  </el-table>
  <p class="footnote">状态对应门店最近一期任务。移除后停止后续自动下发，已下发任务及提交、审核记录保留。需要重新加入时，请使用该任务的下发设置。</p>
 </section>
</template>
<script setup>
import {ref,computed,watch} from 'vue';import {ElMessage,ElMessageBox} from 'element-plus';import {storeTaskApi} from '@/api';
const props=defineProps({template:{type:Object,required:true}}),emit=defineEmits(['changed','view-task']);
const rows=ref([]),loading=ref(false),error=ref(''),keyword=ref(''),state=ref(''),removing=ref(null);let request=0;
const labels={draft:'待提交',pending:'待审核',approved:'已通过',rejected:'已退回',missed:'超时未提交',forfeited:'逾期弃权',blocked:'等待前置任务',not_started:'未到开始时间',scheduled:'待生成'},cycles={daily:'每日',weekly:'每周',monthly:'每月'},tone=s=>({pending:'warning',approved:'success',rejected:'danger',missed:'danger',forfeited:'danger'}[s]||'info');
const filtered=computed(()=>rows.value.filter(r=>r.store_name.includes(keyword.value.trim())&&(!state.value||r.status===state.value)));
async function load(){const version=++request;loading.value=true;error.value='';try{const data=await storeTaskApi.stores(props.template.id);if(version===request)rows.value=data.rows}catch(e){if(version===request){error.value=e.message;rows.value=[]}}finally{if(version===request)loading.value=false}}
async function remove(row){try{await ElMessageBox.confirm(`将「${row.store_name}」移出「${props.template.title}」？后续不再自动下发，已下发任务及历史记录保留。`,'移除参与门店',{confirmButtonText:'确认移除',cancelButtonText:'取消',type:'warning'});removing.value=row.store_id;await storeTaskApi.removeStore(props.template.id,row.store_id);await load();emit('changed');ElMessage.success('门店已移除')}catch(e){if(e!=='cancel'&&e!=='close')ElMessage.error(e.message||'移除失败')}finally{removing.value=null}}
watch(()=>props.template.id,()=>{keyword.value='';state.value='';load()},{immediate:true});
</script>
<style scoped>
.task-stores{color:var(--el-text-color-primary)}header{padding:4px 0 18px}.eyebrow{font-size:12px;color:var(--el-text-color-secondary)}h2{font-size:23px;margin:8px 0}header p,.footnote{font-size:13px;color:var(--el-text-color-secondary);line-height:1.8}.counts{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:4px 0 22px}.counts>div{border:1px solid var(--el-border-color-light);border-radius:10px;padding:16px;background:var(--el-fill-color-extra-light)}.counts small{color:var(--el-text-color-secondary);font-size:12px;display:block}.counts strong{display:block;font-size:25px;margin-top:7px;font-variant-numeric:tabular-nums}.filters{display:flex;gap:10px;margin-bottom:18px}.filters .el-input{max-width:300px}.filters .el-select{width:190px}.sub{display:block;margin-top:5px;color:var(--el-text-color-secondary);font-size:12px}.footnote{padding:14px 0}@media(max-width:640px){.counts{grid-template-columns:repeat(2,1fr)}.filters{flex-wrap:wrap}}
</style>
