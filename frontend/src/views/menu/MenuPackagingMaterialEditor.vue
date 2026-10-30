<template>
  <el-drawer :model-value="!!material" title="维护包材采购规格" size="min(600px, 100vw)" :before-close="close">
    <el-form v-if="draft" label-position="top" class="purchase-form" @submit.prevent="save">
      <el-form-item label="包材名称" required><el-input v-model="draft.name" aria-label="包材名称" maxlength="120" /></el-form-item>
      <div class="purchase-section">采购规格</div>
      <div class="purchase-grid">
        <el-form-item label="采购单位" required><el-select v-model="draft.purchase_unit" aria-label="采购单位" placeholder="例如：箱、包、件" filterable allow-create default-first-option><el-option v-for="u in ['箱','包','件','袋','提','盒','捆','个','套','根']" :key="u" :label="u" :value="u" /></el-select></el-form-item>
        <el-form-item label="每采购单位内含数量" required><el-input-number v-model="draft.units_per_purchase" aria-label="每采购单位内含数量" :min="1" :max="100000000" :precision="0" :controls="false" placeholder="例如：150" /></el-form-item>
        <el-form-item label="单件单位" required><el-select v-model="draft.unit" aria-label="单件单位" filterable allow-create default-first-option><el-option v-for="u in ['个','套','根','双','张','只','片']" :key="u" :label="u" :value="u" /></el-select></el-form-item>
      </div>
      <el-form-item :label="'采购价（元 / '+(draft.purchase_unit || '采购单位')+'）'" required><el-input-number :model-value="moneyNumber(draft.purchase_price)" @update:model-value="v => draft.purchase_price=moneyNumber(v)" aria-label="每采购单位价格" :min="0" :max="100000000" :step="0.0001" inputmode="decimal" :controls="false" placeholder="例如：58" /></el-form-item>
      <div class="purchase-conversion" aria-label="采购规格换算">
        <span>采购规格</span><b>{{ specification }}</b>
        <div><span>换算单件成本</span><strong data-testid="purchase-unit-cost">{{ moneyAmount(unitCost, '待填写') }}<small v-if="unitCost !== null"> / {{ draft.unit || '单件' }}</small></strong></div>
      </div>
      <p v-if="material?.id && !material.purchase_unit" class="purchase-hint">现有单件成本 {{ moneyAmount(material.unit_cost) }} / {{ material.unit }}，请补充采购规格。</p>
      <p class="purchase-hint">保存后，关联打包方案及菜品使用换算后的单件成本。</p>
    </el-form>
    <p v-if="error" class="purchase-error" role="alert">{{ error }}</p>
    <template #footer><el-button :disabled="saving" @click="close">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存采购规格</el-button></template>
  </el-drawer>
  <NotificationDialog v-model="discard" title="包材修改尚未保存" tone="warning" subtitle="关闭将放弃当前未保存的包材修改。"><template #footer><el-button @click="discard=false">继续编辑</el-button><el-button @click="discard=false; emit('close')">放弃修改</el-button></template></NotificationDialog>
</template>
<script setup>
import {computed,ref,watch} from 'vue'
import {ElMessage} from 'element-plus'
import {menuCostRecipesApi as api} from '@/api'
import NotificationDialog from '@/components/NotificationDialog.vue'
import {moneyAmount,moneyNumber} from './moneyDisplay'
const props=defineProps({material:Object}),emit=defineEmits(['close','saved'])
const draft=ref(null),initial=ref(''),error=ref(''),saving=ref(false),discard=ref(false)
watch(()=>props.material,m=>{draft.value=m?{id:m.id,revision:m.revision,name:m.name||'',unit:m.unit||'个',purchase_unit:m.purchase_unit||'',units_per_purchase:m.units_per_purchase??null,purchase_price:m.purchase_price??null}:null;initial.value=JSON.stringify(draft.value);error.value='';discard.value=false},{immediate:true})
const unitCost=computed(()=>{const d=draft.value;if(!d||d.purchase_price==null||!Number.isFinite(d.purchase_price)||d.purchase_price<0||!Number.isInteger(d.units_per_purchase)||d.units_per_purchase<1)return null;return d.purchase_price/d.units_per_purchase})
const specification=computed(()=>{const d=draft.value;return d?.purchase_unit&&d.units_per_purchase&&d.unit?`1 ${d.purchase_unit} = ${d.units_per_purchase} ${d.unit}`:'填写采购单位、数量与单件单位'})
function close(){if(saving.value)return;if(JSON.stringify(draft.value)!==initial.value)discard.value=true;else emit('close')}
async function save(){if(saving.value||!draft.value)return;error.value='';const d=draft.value;if(!d.name.trim()||!d.unit.trim()||!d.purchase_unit.trim()||unitCost.value===null){error.value='请填写包材名称、采购单位、整件数量、单件单位和采购价。';return}saving.value=true;try{await api.saveMaterial(d);emit('close');emit('saved');ElMessage.success('采购规格已保存，关联成本同步更新')}catch(e){error.value=e.message}finally{saving.value=false}}
</script>
<style scoped>
.purchase-form{color:#354b68}.purchase-form :deep(.el-input-number),.purchase-form :deep(.el-select){width:100%}.purchase-section{font-size:13px;font-weight:600;margin:6px 0 16px;padding-top:14px;border-top:1px solid #e8edf4}.purchase-grid{display:grid;grid-template-columns:1fr 1.3fr 1fr;gap:12px}.purchase-conversion{background:#f4f7fb;border:1px solid #e3eaf3;border-radius:8px;padding:18px 20px;margin-top:8px}.purchase-conversion>span{color:#7c8ba0;font-size:12px;display:block;margin-bottom:8px}.purchase-conversion>b{font-size:16px;color:#314d70;font-weight:600}.purchase-conversion>div{display:flex;align-items:center;justify-content:space-between;margin-top:18px;padding-top:15px;border-top:1px solid #e1e8f1;gap:12px}.purchase-conversion>div>span{color:#657990;font-size:13px}.purchase-conversion strong{color:#2155a0;font-size:22px;font-variant-numeric:tabular-nums}.purchase-conversion strong small{font-size:12px;font-weight:400;color:#718198}.purchase-hint{font-size:12px;line-height:1.8;color:#8492a5;margin:12px 0}.purchase-error{font-size:13px;color:#b96744;line-height:1.8}@media(max-width:500px){.purchase-grid{grid-template-columns:1fr 1fr}.purchase-grid>:last-child{grid-column:1/-1}}
</style>
