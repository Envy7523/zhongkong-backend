<template>
  <section class="role-editor">
    <el-form label-position="top">
      <el-form-item label="允许登录端" required><el-checkbox-group :model-value="modelValue.channels" @update:model-value="channels=>patch({channels})"><el-checkbox value="web">网页</el-checkbox><el-checkbox value="mini">小程序</el-checkbox></el-checkbox-group></el-form-item>
      <div class="role-toolbar"><strong>岗位与负责范围</strong><el-popover trigger="click" placement="bottom-end" :width="320"><template #reference><el-button text>复制配置</el-button></template><p>仅复制岗位、负责范围和登录端，请核对后保存。</p><el-select v-model="sourceId" filterable placeholder="选择来源人员"><el-option v-for="u in data.users.filter(u=>u.id!==userId)" :key="u.id" :value="u.id" :label="u.display_name||u.username"/></el-select><el-button style="margin-top:12px" :disabled="!sourceId" @click="copy">载入配置</el-button></el-popover></div>
      <p class="muted">每个岗位分别负责对应门店。主岗位与兼任岗位不会互相扩大权限。</p>
      <article v-for="(a,i) in modelValue.assignments" :key="i" class="assignment" :class="{'primary-assignment':a.is_primary}">
        <div class="role-toolbar"><div><el-tag size="small" :type="a.is_primary?'primary':'info'">{{a.is_primary?'主岗位':'兼任岗位'}}</el-tag><el-button v-if="!a.is_primary" text @click="primary(i)">设为主岗位</el-button></div><el-button text type="danger" @click="remove(i)">移除</el-button></div>
        <el-form-item label="岗位" required><el-select :model-value="a.position_id" filterable placeholder="选择岗位" @update:model-value="value=>setRole(i,{position_id:value})"><el-option-group v-for="c in categories" :key="c.value" :label="c.label"><el-option v-for="p in data.positions.filter(p=>(p.category==='mini'?'store':p.category)===c.value&&p.enabled)" :key="p.id" :value="p.id" :label="p.name" :disabled="modelValue.assignments.some((r,j)=>j!==i&&r.position_id===p.id)"/></el-option-group></el-select></el-form-item>
        <el-form-item label="负责门店 / 区域" required><RoleScopeEditor :model-value="a" :stores="data.stores" :regions="data.regions" @update:model-value="value=>setRole(i,value)"/></el-form-item>
        <p v-if="role(a)?.mode!=='all'&&role(a)" class="muted">岗位适用范围：{{scopeLabel(role(a))}}。实际范围取交集。</p>
        <p v-if="role(a)" class="muted">可用端：{{role(a).channels.map(c=>c==='web'?'网页':'小程序').join('、')}}</p>
        <el-alert v-if="managerConflicts(a).length" type="error" :closable="false" title="所选门店已有正式店长"><template #default><div v-for="c in managerConflicts(a)" :key="c.store.id">{{c.store.store_name}}：{{c.names.join('、')}}</div><router-link to="/workflows">前往工作流 → 正式店长任命</router-link></template></el-alert>
      </article>
      <el-button class="add-role" plain :disabled="modelValue.assignments.length>=10" @click="add">＋ 添加兼任岗位</el-button>
      <el-form-item label="调整原因" required style="margin-top:20px"><el-input :model-value="modelValue.reason" type="textarea" :rows="2" maxlength="1000" placeholder="说明本次新增或岗位调整原因" @update:model-value="reason=>patch({reason})"/></el-form-item>
    </el-form>
  </section>
</template>
<script setup>
import {ref} from 'vue'
import RoleScopeEditor from './RoleScopeEditor.vue'
const props=defineProps({modelValue:{type:Object,required:true},data:{type:Object,required:true},userId:{type:Number,default:0}})
const emit=defineEmits(['update:modelValue']),sourceId=ref(null)
const categories=[{value:'group',label:'集团岗位'},{value:'store',label:'门店岗位'}]
const role=a=>props.data.positions.find(p=>p.id===a.position_id)
const patch=value=>emit('update:modelValue',{...props.modelValue,...value})
function setRole(i,value){patch({assignments:props.modelValue.assignments.map((a,j)=>j===i?{...a,...value}:a)})}
function primary(i){patch({assignments:props.modelValue.assignments.map((a,j)=>({...a,is_primary:i===j}))})}
function add(){patch({assignments:[...props.modelValue.assignments,{position_id:null,is_primary:!props.modelValue.assignments.length,mode:'stores',store_ids:[],region_ids:[]}]})}
function remove(i){const rows=props.modelValue.assignments.filter((_,j)=>j!==i);if(rows.length&&!rows.some(a=>a.is_primary))rows[0]={...rows[0],is_primary:true};patch({assignments:rows})}
function copy(){const u=props.data.users.find(u=>u.id===sourceId.value);if(!u)return;const assignments=u.access?.assignments||(u.position_ids||[]).map(id=>({position_id:id,is_primary:id===u.position_id,mode:u.store_id?'stores':'all',store_ids:u.store_id?[u.store_id]:[],region_ids:[]}));patch({assignments:JSON.parse(JSON.stringify(assignments)),channels:[...(u.access?.channels||['web','mini'])],reason:'参考'+(u.display_name||u.username)+'调整岗位与负责范围'})}
function ids(rule){if(rule.mode==='all')return props.data.stores.map(s=>s.id);if(rule.mode==='stores')return rule.store_ids||[];return [...new Set((rule.region_ids||[]).flatMap(id=>props.data.regions.find(r=>r.id===id)?.store_ids||[]))]}
function managerConflicts(a){const p=role(a);if(!p||p.category!=='store'||/储备/.test(p.name)||!p.permissions.includes('store-manager.identity'))return [];const actual=ids(a).filter(id=>ids(p).includes(id));return props.data.stores.filter(s=>actual.includes(s.id)).map(store=>({store,names:props.data.users.filter(u=>u.id!==props.userId&&(u.manager_store_ids===null||u.manager_store_ids?.includes(store.id))).map(u=>u.display_name||u.username)})).filter(c=>c.names.length)}
function scopeLabel(rule){if(rule.mode==='all')return '全部门店';if(rule.mode==='regions')return (rule.region_ids||[]).map(id=>props.data.regions.find(r=>r.id===id)?.name||id).join('、');return (rule.store_ids||[]).map(id=>props.data.stores.find(s=>s.id===id)?.store_name||id).join('、')||'无'}
</script>
<style scoped>
.role-editor{color:#23324a}.role-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px}.role-toolbar strong{font-size:15px}.assignment{border:1px solid #e3e9f2;border-radius:12px;padding:20px 22px;margin:16px 0;background:#fff;box-shadow:0 2px 6px #293d5a03}.assignment.primary-assignment{border-color:#d6e1f7;border-top:3px solid #6488df;padding-top:18px}.assignment .el-form-item{margin-top:18px}.assignment :deep(.el-radio-group){display:flex;gap:8px;flex-wrap:wrap}.assignment :deep(.el-radio-button__inner){font-size:12px}.muted{font-size:12px;line-height:1.8;color:#66758a;margin:8px 0}.el-select,.add-role{width:100%}.add-role{min-height:40px;border-style:dashed;border-radius:10px;color:#436bbd;background:#f6f9ff}.el-alert{margin-top:12px}.role-editor :deep(.el-form-item__label){font-size:13px;color:#52637a}.role-editor :deep(.el-textarea__inner){border-radius:8px;padding:12px}.role-editor :deep(.el-checkbox){margin-right:24px}a{color:var(--el-color-primary)}@media(max-width:600px){.assignment{padding:16px}.role-toolbar{gap:8px}}
</style>
