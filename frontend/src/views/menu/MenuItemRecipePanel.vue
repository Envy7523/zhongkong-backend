<template>
  <section class="menu-item-recipe">
    <header class="recipe-overview-heading"><div><h4>{{ validVariants.length > 1 ? '规格成本对照' : '菜品配方与成本' }}</h4><p>{{ validVariants.length > 1 ? '全部规格直接展开，配方与打包方案按规格独立维护。' : '食材构成与打包方案直接展示，保存后用于当前菜品规格。' }}</p></div><span v-if="validVariants.length > 1" class="variant-count">{{ validVariants.length }} 个规格</span></header>
    <div v-if="validVariants.length > 1" class="variant-comparison-wrap">
      <table class="variant-comparison" aria-label="各规格成本对照"><thead><tr><th>规格</th><th v-if="hasSalePrices" class="numeric">堂食售价</th><th class="numeric">食材成本</th><th class="numeric">打包包材</th><th class="numeric">打包后成本</th><th>维护状态</th></tr></thead><tbody><tr v-for="v in validVariants" :key="v.sourceId"><td><button class="variant-jump" @click="jumpTo(v.sourceId)">{{ v.spec || '默认规格' }}</button><small v-if="v.skuid">{{ v.skuid }}</small></td><td v-if="hasSalePrices" class="numeric">{{ amount(v.dine_in_price, '—') }}</td><td class="numeric">{{ amount(states[v.sourceId]?.food) }}</td><td class="numeric">{{ amount(states[v.sourceId]?.packing) }}</td><td class="numeric"><b>{{ amount(states[v.sourceId]?.packed) }}</b></td><td><span :class="['variant-state',states[v.sourceId]?.dirty?'unsaved':'']">{{ states[v.sourceId]?.loading ? '加载中' : states[v.sourceId]?.saving ? '保存中' : states[v.sourceId]?.dirty ? '未保存' : '已加载' }}</span></td></tr></tbody></table>
    </div>
    <div class="variant-editors"><MenuRecipeVariant v-for="v in validVariants" :key="v.sourceId" :ref="el=>setEditor(v.sourceId,el)" :variant="v" @state="s=>states[s.id]=s" @saved="emit('saved')" /></div>
    <p v-if="!validVariants.length" class="recipe-no-saved-spec">请先保存菜品规格，再维护配方与成本。</p>
    <NotificationDialog v-model="discardVisible" title="菜品成本尚未保存" tone="warning" subtitle="离开将放弃当前未保存的配方、成本及打包方案修改。" @closed="dialogClosed"><p class="unsaved-specs">未保存规格：{{ dirtyNames.join('、') }}</p><template #footer><el-button @click="resolveLeave(false)">继续编辑</el-button><el-button @click="resolveLeave(true)">放弃修改</el-button></template></NotificationDialog>
  </section>
</template>
<script setup>
import {computed,onBeforeUnmount,ref} from 'vue'
import NotificationDialog from '@/components/NotificationDialog.vue'
import MenuRecipeVariant from './MenuRecipeVariant.vue'
import {moneyAmount} from './moneyDisplay'
const props=defineProps({variants:{type:Array,default:()=>[]}}),emit=defineEmits(['saved'])
const validVariants=computed(()=>props.variants.filter(v=>v.sourceId)),hasSalePrices=computed(()=>validVariants.value.some(v=>v.dine_in_price!=null))
const states=ref({}),editors=new Map(),discardVisible=ref(false)
let pending=null,leaveResolve=null
const dirtyNames=computed(()=>validVariants.value.filter(v=>states.value[v.sourceId]?.dirty).map(v=>v.spec||'默认规格'))
const amount=(v,fallback='待补齐')=>moneyAmount(v,fallback)
function setEditor(id,el){if(el)editors.set(id,el);else editors.delete(id)}
function jumpTo(id){document.querySelector(`.menu-recipe-variant[data-variant-id="${Number(id)}"]`)?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'})}
async function canLeave(){if([...editors.values()].some(e=>e.isSaving()))return false;if(![...editors.values()].some(e=>e.isDirty()))return true;if(pending)return pending;discardVisible.value=true;pending=new Promise(resolve=>leaveResolve=resolve);return pending}
function resolveLeave(value){discardVisible.value=false;const fn=leaveResolve;leaveResolve=null;pending=null;fn?.(value)}
function dialogClosed(){if(!discardVisible.value&&pending)resolveLeave(false)}
onBeforeUnmount(()=>resolveLeave(false))
defineExpose({canLeave})
</script>
<style scoped>
.menu-item-recipe{min-width:0;color:#344b68;font-size:13px}.recipe-overview-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.recipe-overview-heading h4{font-size:15px;color:#2b405e;margin:0}.recipe-overview-heading p{font-size:12px;color:#6d7e95;line-height:1.8;margin:7px 0 0}.variant-count{background:#edf3fc;border:1px solid #dfE8f5;border-radius:5px;color:#315b90;font-size:12px;padding:5px 10px;white-space:nowrap}.variant-comparison-wrap{overflow:auto;margin-bottom:22px;border:1px solid #e1e7f0;border-radius:8px}.variant-comparison{width:100%;min-width:590px;table-layout:fixed;border-collapse:collapse;font-size:12px}.variant-comparison th{background:#f3f6fb;font-weight:500;color:#63758d;padding:12px 16px;text-align:left}.variant-comparison td{padding:12px 16px;border-top:1px solid #e8edf4;color:#435772;font-variant-numeric:tabular-nums}.variant-comparison .numeric{text-align:right}.variant-comparison td b{color:#285a96;font-weight:600}.variant-comparison small{display:block;font-size:11px;color:#748297;margin-top:4px;overflow-wrap:anywhere}.variant-jump{background:none;border:0;color:#24558d;font-weight:600;cursor:pointer;padding:0;font-size:13px}.variant-jump:focus-visible{outline:2px solid #4f7cff;outline-offset:4px}.variant-state{font-size:12px;color:#6a7b90}.variant-state.unsaved{color:#a56d20}.variant-editors{display:grid;gap:22px}.unsaved-specs{color:#67768b;font-size:13px;line-height:1.8;margin:0}.recipe-no-saved-spec{padding:20px;background:#f6f8fb;color:#6a7c92;font-size:13px;line-height:1.8}@media(max-width:700px){.recipe-overview-heading{align-items:flex-start}.variant-comparison th,.variant-comparison td{padding:10px}.variant-editors{gap:16px}}
</style>
