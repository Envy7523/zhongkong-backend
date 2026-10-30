<template><section class="position-scope"><div class="pair"><el-form-item label="岗位分类"><el-select v-model="draft.category"><el-option value="group" label="集团岗位"/><el-option value="store" label="门店岗位"/><el-option value="mini" label="小程序岗位"/></el-select></el-form-item><el-form-item label="允许登录端"><el-checkbox-group v-model="draft.channels"><el-checkbox value="web">网页</el-checkbox><el-checkbox value="mini">小程序</el-checkbox></el-checkbox-group></el-form-item></div><el-form-item label="岗位适用门店（不是人员负责范围）"><RoleScopeEditor :model-value="draft" @update:model-value="value=>Object.assign(draft,value)" :stores="data.stores" :regions="data.regions"/></el-form-item><el-switch v-model="draft.enabled" active-text="岗位启用"/><p>岗位可适用于全门店；分配人员时仍必须单独设置此人的负责范围。</p><el-button :loading="saving" @click="save">保存分类与适用范围</el-button></section></template>
<script setup>
import {onMounted,reactive,ref,watch} from 'vue'
import {personnelAccessApi} from '@/api'
import RoleScopeEditor from './RoleScopeEditor.vue'
import {ElMessage} from 'element-plus'
const props=defineProps({positionId:{type:Number,required:true}}),data=reactive({positions:[],stores:[],regions:[]}),draft=reactive({}),saving=ref(false)
async function load(){try{Object.assign(data,await personnelAccessApi.config());const p=data.positions.find(p=>p.id===props.positionId);if(p)Object.assign(draft,{category:p.category,channels:[...p.channels],mode:p.mode,store_ids:[...p.store_ids],region_ids:[...p.region_ids],enabled:p.enabled})}catch(e){ElMessage.error(e.message)}}
async function save(){saving.value=true;try{await personnelAccessApi.position(props.positionId,JSON.parse(JSON.stringify(draft)));ElMessage.success('岗位分类与适用范围已保存')}catch(e){ElMessage.error(e.message)}finally{saving.value=false}}
watch(()=>props.positionId,load);onMounted(load)
</script>
<style scoped>.position-scope{border:1px solid #e2e9f3;padding:18px;border-radius:12px;margin-bottom:22px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:18px}.position-scope p{font-size:12px;color:#7a8799}.el-select{width:100%}</style>
