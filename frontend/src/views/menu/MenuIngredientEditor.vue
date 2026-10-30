<template>
  <el-drawer :model-value="!!materialId" :title="materialId === 'new' ? '新建通用食材' : '维护通用食材'" size="min(680px, 96vw)" class="ingredient-editor" :before-close="closeEditor">
    <template v-if="form">
      <p class="editor-intro">在这里统一维护成本标准。所有引用此食材的菜品与半成品都会使用同一份标准。</p>
      <el-form label-position="top" novalidate>
        <div class="editor-grid"><el-form-item label="食材名称" required><el-input v-model="form.name" maxlength="80" /></el-form-item><el-form-item label="标准 / 规格"><el-input v-model="form.spec" placeholder="同名不同标准时填写" maxlength="80" /></el-form-item><el-form-item label="类型"><el-select v-model="form.kind"><el-option label="食材" value="食材" /><el-option label="半成品" value="半成品" /></el-select></el-form-item><el-form-item label="最小计量单位" required><el-select v-model="form.unit" filterable allow-create :disabled="!!form.id && (form.usage_count > 0 || form.dependent_count > 0)"><el-option v-for="u in units" :key="u" :label="u" :value="u" /></el-select></el-form-item></div>
        <el-form-item label="成本维护方式"><el-radio-group v-model="form.pricing_mode"><el-radio-button value="manual">统一单位成本</el-radio-button><el-radio-button value="recipe">按通用配方计算</el-radio-button></el-radio-group></el-form-item>
        <el-form-item v-if="form.pricing_mode === 'manual'" :label="`单位成本（元 / ${form.unit}）`" required><el-input-number :model-value="moneyNumber(form.manual_unit_cost)" @update:model-value="v => form.manual_unit_cost=moneyNumber(v)" :min="0" :step="0.0001" inputmode="decimal" :controls="false" style="width:100%" /><p class="field-note">修改后统一影响 {{ form.usage_count || 0 }} 道菜品及 {{ form.dependent_count || 0 }} 项上级通用配方。</p></el-form-item>
        <template v-else>
          <div class="batch-output"><el-form-item :label="`本批次出品数量（${form.unit}）`" required><el-input-number :model-value="form.output_quantity" @update:model-value="v => form.output_quantity=quantityValue(v)" :min="0.01" :step="1" inputmode="decimal" :controls="false" /></el-form-item><div><span>计算后的单位成本</span><strong>{{ calculatedCost == null ? '待完善配方' : '¥' + unitPrice(calculatedCost) + ' / ' + form.unit }}</strong></div></div>
          <div class="batch-heading"><b>通用配方组成</b><el-button plain @click="form.components.push({ material_id: '', quantity: 1 })">添加原料</el-button></div>
          <div v-for="(c, i) in form.components" :key="i" class="batch-line"><el-select v-model="c.material_id" filterable placeholder="选择通用原料" :aria-label="`批次原料${i + 1}`"><el-option v-for="m in ingredients.filter(m => m.id !== form.id)" :key="m.id" :label="label(m)" :value="m.id" /></el-select><el-input-number :model-value="c.quantity" @update:model-value="v => c.quantity=quantityValue(v)" :min="0.01" :step="1" inputmode="decimal" :controls="false" :aria-label="`批次用量${i + 1}`" /><span>{{ ingredient(c.material_id)?.unit || '单位' }}</span><el-button link type="danger" @click="form.components.splice(i, 1)">移除</el-button></div>
          <p class="field-note">单位成本 = 本批全部原料成本 ÷ 出品数量。支持多级半成品，不能循环引用。</p>
        </template>
        <el-form-item label="标准说明"><el-input v-model="form.note" type="textarea" :rows="3" maxlength="1000" /></el-form-item>
      </el-form>
      <el-collapse v-if="form.id" class="merge-section"><el-collapse-item title="合并重复的食材标准" name="merge"><p class="field-note">确认是同一种标准后，可将此食材的所有引用移到另一项。原用量保留，之后按目标标准的价格计算。</p><el-select v-model="mergeTarget" filterable clearable placeholder="选择同单位的目标标准"><el-option v-for="m in mergeOptions" :key="m.id" :label="label(m) + ' · ¥' + unitPrice(m.unit_cost)" :value="m.id" /></el-select><el-button type="warning" plain :disabled="!mergeTarget" @click="mergeVisible = true">合并引用</el-button></el-collapse-item></el-collapse>
      <p v-if="error" class="editor-error" role="alert">{{ error }}</p>
    </template>
    <template #footer><el-button @click="closeEditor()">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存共用标准</el-button></template>
  </el-drawer>
  <NotificationDialog v-model="discardVisible" title="通用食材尚未保存" tone="warning" subtitle="关闭后将放弃当前未保存的标准修改。"><template #footer><el-button @click="discardVisible = false">继续编辑</el-button><el-button @click="discardVisible = false; emit('close')">放弃修改</el-button></template></NotificationDialog>
  <NotificationDialog v-model="mergeVisible" title="确认合并食材标准" tone="warning" subtitle="合并会统一更新关联配方的食材引用和成本。"><p>将“{{ label(form) }}”合并到“{{ label(ingredient(mergeTarget)) }}”。会影响 {{ form?.usage_count || 0 }} 道菜品及 {{ form?.dependent_count || 0 }} 项上级通用配方，原有版本记录保留。</p><template #footer><el-button @click="mergeVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="merge">确认合并</el-button></template></NotificationDialog>
</template>
<script setup>
import { computed, ref, watch } from 'vue'
import { quantityValue } from './quantityInput'
import { moneyText, moneyNumber } from './moneyDisplay'
import { ElMessage } from 'element-plus'
import { menuCostRecipesApi as api } from '@/api'
import NotificationDialog from '@/components/NotificationDialog.vue'
const props = defineProps({ materialId: { type: String, default: '' }, ingredients: { type: Array, default: () => [] } })
const emit = defineEmits(['close', 'saved'])
const form = ref(null), initial = ref(''), saving = ref(false), error = ref(''), mergeTarget = ref(''), mergeVisible = ref(false), discardVisible = ref(false)
const units = ['克', '斤', '千克', '毫升', '升', '个', '份', '只', '片', '块', '根', '瓶', '包', '套']
const ingredient = id => props.ingredients.find(m => m.id === id)
const label = m => m ? m.name + (m.spec ? ` · ${m.spec}` : '') : ''
const unitPrice = n => moneyText(n,'待补')
const mergeOptions = computed(() => props.ingredients.filter(m => m.id !== form.value?.id && m.unit === form.value?.unit))
const calculatedCost = computed(() => {
  if (!form.value?.components.length || !form.value.output_quantity) return null
  let sum = 0
  for (const c of form.value.components) { const m = ingredient(c.material_id); if (!m?.complete || !c.quantity) return null; sum += m.unit_cost * c.quantity }
  return sum / form.value.output_quantity
})
watch(() => props.materialId, id => {
  const m = id === 'new' ? { name: '', spec: '', unit: '克', kind: '食材', pricing_mode: 'manual', manual_unit_cost: null, unit_cost: null, output_quantity: 1, components: [], note: '' } : ingredient(id)
  form.value = m ? JSON.parse(JSON.stringify(m)) : null
  initial.value = JSON.stringify(form.value); error.value = ''; mergeTarget.value = ''
}, { immediate: true })
function closeEditor() { if (saving.value) return; if (JSON.stringify(form.value) !== initial.value) discardVisible.value = true; else emit('close') }
async function save() {
  saving.value = true; error.value = ''
  try { const r = await api.saveIngredient(form.value); ElMessage.success('共用标准已保存，关联成本已统一更新'); emit('saved', r.ingredient.id); emit('close') }
  catch (e) { error.value = e.message }
  finally { saving.value = false }
}
async function merge() {
  saving.value = true; error.value = ''
  try { await api.mergeIngredient(form.value.id, { revision: form.value.revision, target_id: mergeTarget.value, target_revision: ingredient(mergeTarget.value).revision }); mergeVisible.value = false; ElMessage.success('引用已统一到目标食材标准'); emit('saved', mergeTarget.value); emit('close') }
  catch (e) { error.value = e.message; mergeVisible.value = false }
  finally { saving.value = false }
}
</script>
<style scoped>
.editor-intro{margin:0 0 22px;padding:12px 14px;background:#f3f7fc;color:#52647a;line-height:1.8;font-size:13px;border-radius:8px}.editor-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}.editor-grid .el-select{width:100%}.field-note{margin:8px 0 0;color:#77869a;font-size:12px;line-height:1.8}.batch-output{display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:center}.batch-output .el-input-number{width:100%}.batch-output span,.batch-output strong{display:block;font-size:13px}.batch-output span{color:#7b8797;margin-bottom:8px}.batch-output strong{color:#235b9d;font-variant-numeric:tabular-nums}.batch-heading{display:flex;align-items:center;justify-content:space-between;margin:12px 0;color:#34465e;font-size:13px}.batch-line{display:grid;grid-template-columns:minmax(0,1fr) 110px 40px 40px;gap:8px;align-items:center;margin-bottom:10px}.batch-line .el-input-number{width:100%}.batch-line>span{color:#6c7b90;font-size:12px}.merge-section{margin-top:22px}.merge-section .el-button{margin-top:12px}.editor-error{color:#c33d3d;font-size:13px;line-height:1.7}@media(max-width:560px){.editor-grid{grid-template-columns:1fr}.batch-line{grid-template-columns:minmax(0,1fr) 90px 30px 34px;gap:5px}.batch-output{grid-template-columns:1fr;gap:0}}
</style>
