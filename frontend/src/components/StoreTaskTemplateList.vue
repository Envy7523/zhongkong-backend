<template>
  <section class="form-library">
    <header><div><h2>全部表单 <span>{{ templates.length }}</span></h2><p>选择表单后编辑内容或配置门店下发，已有任务保留原版本。</p></div><el-button type="primary" @click="$emit('new')">新建表单</el-button></header>
    <div class="library-filters"><el-input v-model="search" clearable aria-label="搜索表单" placeholder="搜索表单名称或说明" /><el-select v-model="filter" aria-label="长期计划筛选"><el-option label="全部表单" value="all" /><el-option label="已启用长期计划" value="active" /><el-option label="未启用长期计划" value="inactive" /></el-select><el-button @click="$emit('plans')">管理长期计划</el-button></div>
    <el-table :data="pageRows" stripe row-key="id" empty-text="暂无符合条件的表单" style="width:100%">
      <el-table-column label="表单名称" min-width="220"><template #default="{row}"><strong>{{row.title}}</strong><p class="description">{{row.description||'暂无说明'}}</p></template></el-table-column>
      <el-table-column label="题目" width="75"><template #default="{row}">{{row.questions.length}} 项</template></el-table-column>
      <el-table-column label="版本" width="75"><template #default="{row}">v{{row.version}}</template></el-table-column>
      <el-table-column label="长期计划" min-width="135"><template #default="{row}"><el-tag :type="activeCount(row)?'success':'info'">{{activeCount(row)?`${activeCount(row)} 家门店生效`:'未启用长期计划'}}</el-tag></template></el-table-column>
      <el-table-column label="更新时间" min-width="165"><template #default="{row}">{{format(row.updated_at)}}</template></el-table-column>
      <el-table-column label="操作" width="180" fixed="right"><template #default="{row}"><el-button link type="primary" @click="$emit('edit',row)">编辑</el-button><el-button link type="primary" @click="$emit('dispatch',row)">下发设置</el-button></template></el-table-column>
    </el-table>
    <el-pagination v-if="filtered.length>15" v-model:current-page="page" :page-size="15" :total="filtered.length" layout="total, prev, pager, next" class="pagination" />
    <el-empty v-if="!templates.length" description="还没有表单，点击新建开始设置" />
  </section>
</template>
<script setup>
import {computed,ref,watch} from 'vue'
const props=defineProps({templates:{type:Array,default:()=>[]},plans:{type:Array,default:()=>[]}})
defineEmits(['new','edit','dispatch','plans'])
const search=ref(''),filter=ref('all'),page=ref(1)
const activeCount=row=>props.plans.filter(p=>p.active&&p.template_id===row.id).length
const filtered=computed(()=>props.templates.filter(t=>(t.title+' '+t.description).toLowerCase().includes(search.value.trim().toLowerCase())&&(filter.value==='all'||(filter.value==='active'?activeCount(t)>0:activeCount(t)===0))))
const pageRows=computed(()=>filtered.value.slice((page.value-1)*15,page.value*15))
watch([search,filter,()=>props.templates.length],()=>page.value=1)
const format=value=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})
</script>
<style scoped>
.form-library{padding:22px;background:var(--el-bg-color);border:1px solid var(--el-border-color-light);border-radius:12px}.form-library header{display:flex;justify-content:space-between;align-items:center;gap:16px}.form-library h2{font-size:18px;margin:0}.form-library h2 span{font-size:13px;font-weight:400;color:var(--el-text-color-secondary);margin-left:10px}.form-library header p{font-size:13px;color:var(--el-text-color-secondary);margin:8px 0 0}.library-filters{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}.library-filters .el-input{max-width:320px}.library-filters .el-select{width:185px}.description{font-size:12px;line-height:1.5;margin:6px 0 0;color:var(--el-text-color-secondary);overflow:hidden;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical}.pagination{margin-top:18px;justify-content:flex-end}@media(max-width:700px){.form-library{padding:14px}.form-library header{align-items:flex-start}.form-library header p{max-width:230px}}
</style>
