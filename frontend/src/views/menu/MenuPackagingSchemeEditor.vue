<template>
  <el-drawer :model-value="!!scheme" :title="form?.id ? '维护共用打包方案' : '新建打包方案'" size="min(740px, 100vw)" :before-close="closeEditor" append-to-body>
    <template v-if="form"><p class="scheme-intro">堂食、团购打包和外卖共用这里的标准。改动数量会统一影响使用此方案的菜品，包材单价在包材档案维护。</p><el-form label-position="top"><el-form-item label="方案名称" required><el-input v-model="form.name" maxlength="80" /></el-form-item></el-form><div class="scheme-heading"><b>组合明细</b><el-button @click="form.lines.push({material_id:'',quantity:1,scope:'dish'})">添加包材</el-button></div><div class="scheme-labels"><span>包材</span><span>数量</span><span>计算范围</span><span></span></div><div v-for="(l,i) in form.lines" :key="i" class="scheme-line"><el-select v-model="l.material_id" filterable :aria-label="`方案包材${i+1}`"><el-option v-for="m in materials" :key="m.id" :label="m.name+' · '+m.unit" :value="m.id" /></el-select><el-input-number :model-value="l.quantity" @update:model-value="v => l.quantity=quantityValue(v)" :min="0.01" :step="1" inputmode="decimal" :controls="false" :aria-label="`方案用量${i+1}`" /><el-select v-model="l.scope" :aria-label="`方案范围${i+1}`"><el-option label="每份菜品" value="dish" /><el-option label="每笔订单" value="order" /></el-select><el-button link type="danger" @click="form.lines.splice(i,1)">移除</el-button></div><div class="scheme-total"><span>单份 / 单笔各用一次时</span><strong>{{ moneyAmount(total) }}</strong></div><p class="scheme-note">“每份菜品”随份数增加；“每笔订单”按相同包材合并，以配置数量的最大值计一次。原表背心袋按每份1个导入，按实际规则可在这里调整。</p><el-form label-position="top"><el-form-item label="方案说明"><el-input v-model="form.note" type="textarea" :rows="3" /></el-form-item></el-form><p v-if="error" class="scheme-error" role="alert">{{ error }}</p></template>
    <template #footer><el-button @click="closeEditor">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存打包方案</el-button></template>
  </el-drawer>
  <NotificationDialog v-model="discard" title="打包方案尚未保存" subtitle="离开将放弃当前未保存的组合修改。" tone="warning"><template #footer><el-button @click="discard=false">继续编辑</el-button><el-button @click="discard=false; emit('close')">放弃修改</el-button></template></NotificationDialog>
</template>
<script setup>
import { computed,ref,watch } from 'vue'
import { quantityValue } from './quantityInput'
import { moneyAmount } from './moneyDisplay'
import { ElMessage } from 'element-plus'
import NotificationDialog from '@/components/NotificationDialog.vue'
import { menuCostRecipesApi as api } from '@/api'
const props=defineProps({scheme:{type:Object,default:null},materials:{type:Array,default:()=>[]}}),emit=defineEmits(['saved','close'])
const form=ref(null),initial=ref(''),saving=ref(false),error=ref(''),discard=ref(false)
watch(()=>props.scheme,s=>{form.value=s?JSON.parse(JSON.stringify(s)):null;initial.value=JSON.stringify(form.value);error.value=''},{immediate:true})
const total=computed(()=>(form.value?.lines||[]).reduce((s,l)=>s+(Number(l.quantity)||0)*(props.materials.find(m=>m.id===l.material_id)?.unit_cost||0),0))
function closeEditor(){if(saving.value)return;if(JSON.stringify(form.value)!==initial.value)discard.value=true;else emit('close')}
async function save(){saving.value=true;error.value='';try{const r=await api.saveScheme(form.value);emit('saved',r.scheme);emit('close');ElMessage.success('共用打包方案已保存，关联菜品同步更新')}catch(e){error.value=e.message}finally{saving.value=false}}
</script>
<style scoped>
.scheme-intro{background:#f3f7fc;padding:14px;color:#62758e;font-size:12px;line-height:1.9;border-radius:6px;margin:0 0 20px}.scheme-heading{display:flex;justify-content:space-between;align-items:center;margin:18px 0 12px;font-size:14px;color:#354960}.scheme-line,.scheme-labels{display:grid;grid-template-columns:minmax(0,1fr) 95px 120px 32px;gap:9px;align-items:center;margin-bottom:12px}.scheme-labels{font-size:12px;color:#8591a4;margin:0 0 8px}.scheme-line .el-input-number{width:100%}.scheme-total{display:flex;justify-content:space-between;padding:16px;background:#f5f8fc;font-size:13px;margin:18px 0;color:#60748c}.scheme-total strong{color:#2b5b91}.scheme-note{font-size:12px;color:#8a96a7;line-height:1.9}.scheme-error{font-size:13px;color:#b55e3d;line-height:1.8}@media(max-width:600px){.scheme-line,.scheme-labels{grid-template-columns:minmax(0,1fr) 75px 90px 28px;gap:5px}}
</style>
