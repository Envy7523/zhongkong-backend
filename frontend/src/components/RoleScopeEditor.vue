<template><div class="scope-editor"><el-radio-group :model-value="modelValue.mode" @update:model-value="mode=>update({mode})"><el-radio-button value="stores">指定门店</el-radio-button><el-radio-button value="regions">按区域负责</el-radio-button><el-radio-button value="all">全部门店</el-radio-button></el-radio-group><StoreRegionSelect v-if="modelValue.mode==='stores'" :model-value="modelValue.store_ids" @update:model-value="store_ids=>update({store_ids})" :stores="stores" multiple restrict-to-stores input-width="100%" placeholder="多选负责门店"/><el-select v-if="modelValue.mode==='regions'" :model-value="modelValue.region_ids" @update:model-value="region_ids=>update({region_ids})" multiple filterable placeholder="选择负责区域（包含下级区域门店）"><el-option v-for="r in regions.filter(r=>r.name!=='闭店门店')" :key="r.id" :value="r.id" :label="r.name"/></el-select><span v-if="modelValue.mode==='all'" class="hint">明确授权全部门店；其他岗位仍按各自范围计算。</span></div></template>
<script setup>
import StoreRegionSelect from './StoreRegionSelect.vue'
const props=defineProps({modelValue:{type:Object,required:true},stores:{type:Array,default:()=>[]},regions:{type:Array,default:()=>[]}})
const emit=defineEmits(['update:modelValue'])
function update(patch){emit('update:modelValue',{...props.modelValue,...patch})}
</script>
<style scoped>.scope-editor{display:grid;gap:12px;width:100%}.hint{font-size:12px;color:#7b8798}.el-select{width:100%}</style>
