<template>
 <div class="ledger-page">
  <section class="card-compact">
   <div class="binding-heading"><div><h2>审批门店绑定</h2><p>统一维护钉钉、企业微信的源部门与后台门店关系，同一部门绑定一次即可应用于全部相关审批。</p></div><el-tag>管理员配置</el-tag></div>
   <div class="binding-stats"><span>源部门 <b>{{summary.departments||0}}</b></span><span>已对应门店 <b>{{summary.matched||0}}</b></span><span>总部／非门店 <b>{{summary.non_store||0}}</b></span><span>待绑定 <b>{{summary.pending||0}}</b></span></div>
   <div class="ledger-tools"><el-select v-model="platform" placeholder="全部平台" aria-label="绑定来源平台" clearable style="width:165px" @change="reset"><el-option value="dingtalk" label="钉钉"/><el-option value="wecom" label="企业微信"/></el-select><el-select v-model="status" placeholder="全部绑定状态" aria-label="绑定状态" clearable style="width:170px" @change="reset"><el-option value="matched" label="已对应门店"/><el-option value="unmatched" label="待绑定"/><el-option value="ambiguous" label="同名冲突"/><el-option value="non_store" label="总部／非门店"/><el-option value="missing_store" label="档案缺失"/></el-select><el-input v-model="q" placeholder="搜索原部门、部门ID或后台门店" clearable style="width:300px" @keyup.enter="reset"/><el-button @click="reset">查询／刷新</el-button></div>
   <p v-if="error" class="ledger-error" role="alert">{{error}}</p>
  </section>
  <section class="card-compact"><el-table :data="items" v-loading="loading" empty-text="当前范围暂无源部门">
   <el-table-column prop="platform_label" label="来源平台" width="100"/><el-table-column prop="department" label="源部门" min-width="230" show-overflow-tooltip/><el-table-column prop="source_department_id" label="源部门ID" min-width="150" show-overflow-tooltip/><el-table-column prop="record_count" label="关联审批" width="95"/>
   <el-table-column label="后台门店／归属" min-width="230"><template #default="{row}">{{row.store_match.store_name}}<small class="binding-method">{{methodLabel(row.store_match)}}</small></template></el-table-column><el-table-column label="最后维护" min-width="160"><template #default="{row}">{{localTime(row.updated_at)}}</template></el-table-column><el-table-column label="操作" width="110" fixed="right"><template #default="{row}"><el-button link type="primary" @click="edit(row)">{{row.store_match.method==='confirmed'?'修改绑定':'设置绑定'}}</el-button></template></el-table-column>
  </el-table><el-pagination :current-page="page" :page-size="50" :total="total" layout="total,prev,pager,next" @current-change="v=>{page=v;load()}"/></section>
  <NotificationDialog v-model="dialog" title="设置审批门店绑定" subtitle="核实源部门身份后，选择后台门店或总部归属。" :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy">
   <dl v-if="selected" class="binding-detail"><div><dt>来源平台</dt><dd>{{selected.platform_label}}</dd></div><div><dt>关联审批</dt><dd>{{selected.record_count}} 条</dd></div><div class="wide"><dt>源部门</dt><dd>{{selected.department}}</dd></div><div class="wide"><dt>源部门ID</dt><dd>{{selected.source_department_id||'历史数据未提供，以精确部门名识别'}}</dd></div></dl>
   <el-form label-position="top"><el-form-item label="归属类型" required><el-radio-group v-model="kind"><el-radio value="store">后台门店</el-radio><el-radio value="non_store">总部／非门店</el-radio><el-radio value="unmatched">暂不绑定</el-radio></el-radio-group></el-form-item><el-form-item v-if="kind==='store'" label="对应后台门店" required><el-select v-model="store" filterable placeholder="选择已核实的后台门店" style="width:100%"><el-option v-for="s in stores" :key="s.id" :value="s.id" :label="s.store_name"/></el-select></el-form-item><el-form-item label="核对依据" required><el-input v-model="note" type="textarea" :rows="3" maxlength="300" show-word-limit placeholder="填写简称、归属或部门身份的核对依据"/></el-form-item></el-form>
   <p class="binding-help">保存后统一更新同一平台、同一企业、同一源部门的展示归属，不修改审批原件或费用归属。</p><p v-if="dialogError" class="ledger-error" role="alert">{{dialogError}}</p><template #footer><el-button :disabled="busy" @click="dialog=false">取消</el-button><el-button type="primary" :loading="busy" :disabled="!note.trim()||kind==='store'&&!store" @click="save">保存绑定</el-button></template>
  </NotificationDialog>
 </div>
</template>
<script setup>
import {ref,onActivated,onDeactivated} from 'vue'
import {businessLedgerApi as api} from '@/api'
import NotificationDialog from '@/components/NotificationDialog.vue'
import '@/styles/business-ledger.css'
const items=ref([]),stores=ref([]),summary=ref({}),total=ref(0),page=ref(1),platform=ref(''),status=ref(''),q=ref(''),loading=ref(false),error=ref(''),dialog=ref(false),selected=ref(null),kind=ref('store'),store=ref(null),note=ref(''),busy=ref(false),dialogError=ref('')
const localTime=v=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—',methodLabel=m=>m.method==='confirmed'?'管理员已绑定':m.method==='exact'?'名称唯一对应':m.status==='ambiguous'?'存在同名门店，需人工绑定':m.status==='missing_store'?'原门店档案已缺失':'尚未绑定'
let generation=0
async function load(){const n=++generation;loading.value=true;error.value='';try{const r=await api.approvalStoreBindings({platform:platform.value,status:status.value,q:q.value,page:page.value});if(n===generation){items.value=r.items;stores.value=r.stores;summary.value=r.summary;total.value=r.total}}catch(e){if(n===generation)error.value=e.message}finally{if(n===generation)loading.value=false}}
function reset(){page.value=1;load()}
function edit(row){selected.value=row;kind.value=row.store_match.status==='non_store'?'non_store':row.store_match.store_id?'store':'unmatched';store.value=row.store_match.store_id;note.value=row.note;dialogError.value='';dialog.value=true}
async function save(){if(busy.value)return;busy.value=true;dialogError.value='';try{await api.saveApprovalStoreBinding(selected.value.id,{mapping_version:selected.value.store_match.version,kind:kind.value,store_id:store.value,note:note.value});dialog.value=false;await load()}catch(e){dialogError.value=e.message}finally{busy.value=false}}
onActivated(load);onDeactivated(()=>{generation++;dialog.value=false})
</script>
<style scoped>
.binding-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.binding-stats{display:flex;flex-wrap:wrap;gap:16px 32px;padding:12px 0 20px;color:var(--el-text-color-secondary)}.binding-stats b{font-size:20px;color:var(--el-text-color-primary);margin-left:8px}.binding-method{display:block;color:var(--el-text-color-secondary)}.binding-detail{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px;background:var(--el-fill-color-light);border-radius:8px;margin:0 0 20px}.binding-detail .wide{grid-column:1/-1}.binding-detail dt{font-size:12px;color:var(--el-text-color-secondary);margin-bottom:6px}.binding-detail dd{margin:0;overflow-wrap:anywhere}.binding-help{color:var(--el-text-color-secondary);font-size:12px}
</style>
