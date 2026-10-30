<template>
  <span class="hotspot-host"><el-popover :visible="active && visible" :disabled="!active" @update:visible="value=>visible=value" trigger="hover" placement="auto" width="min(520px, 90vw)" :show-after="150" :hide-after="150">
    <template #reference><button type="button" class="value-hotspot" :aria-label="`${label} ${detail.title} ${displayValue}，查看数据构成`" @click="open"><span class="sr-only">{{ label }} {{ displayValue }}，查看构成</span></button></template>
    <div class="breakdown-popover">
      <strong>{{ detail.title }} · {{ label }}：{{ displayValue }}</strong>
      <p>{{ detail.from }}<template v-if="detail.to !== detail.from"> 至 {{ detail.to }}</template></p>
      <p class="formula">{{ detail.formula }}</p>
      <div v-for="note in detail.notes || []" :key="note" :style="{color:detail.availability?.abnormal || detail.unavailable ? 'var(--el-color-warning-dark-2)' : 'var(--el-text-color-regular)'}">{{ note }}</div>
      <div class="source-list"><div v-for="(item,index) in visibleItems.slice(0,12)" :key="index" class="source-row"><div>{{ item.label }}<small>{{ item.source }} · {{ item.date }}<template v-if="item.record_id"> · 记录#{{ item.record_id }}</template><template v-if="item.batch_id"> · 批次#{{ item.batch_id }}</template><template v-if="item.days_in_month"> · 按{{ item.days_in_month }}天分摊</template></small></div><b>{{ money(item.amount) }}</b></div></div>
      <div v-if="detail.delivery_structure || detail.promotion_structure" class="delivery-fees"><template v-for="entry in visibleFeeEntries" :key="entry.label"><strong>{{ entry.label }}原始明细</strong><div v-for="(fee,index) in entry.children" :key="index" class="source-row"><div>{{ fee.label }}<small>{{ fee.date }}</small></div><b>{{ money(fee.amount) }}</b></div></template></div>
      <small>共 {{ visibleItems.length }} 项；点击数值可固定展开全部明细。</small>
    </div>
  </el-popover></span>
</template>
<script setup>
import { computed, ref, onDeactivated, onActivated } from 'vue'
import { filterFinanceItems } from '@/utils/finance-breakdown-items.mjs'
const props=defineProps({detail:{type:Object,required:true},label:{type:String,required:true},rate:Boolean})
const visibleItems=computed(()=>filterFinanceItems(props.detail.items||[]))
const visibleFeeEntries=computed(()=>visibleItems.value.filter(r=>r.label!=='平台实收'&&r.children?.length))
const emit=defineEmits(['open'])
const visible=ref(false)
const active=ref(true)
onDeactivated(()=>{active.value=false;visible.value=false})
onActivated(()=>{active.value=true;visible.value=false})
function open(){visible.value=false;emit('open',{detail:props.detail,label:props.label,rate:props.rate})}
const money=value=>value===null||value===undefined?'未取得':Number(value).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})
const displayValue=computed(()=>props.detail.value===null?'留空':props.rate?`${(props.detail.value*100).toFixed(2)}%`:money(props.detail.value))
</script>
<style scoped>
.hotspot-host{position:absolute;display:block}
.value-hotspot{display:block;position:absolute;width:100%;height:100%;border:0;padding:0;background:transparent;cursor:help;border-radius:2px}.value-hotspot:hover,.value-hotspot:focus-visible{background:#409eff14;outline:2px solid #409eff;outline-offset:-2px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.breakdown-popover{font-size:13px;line-height:1.6}.breakdown-popover strong{color:var(--el-text-color-primary)}.breakdown-popover p{margin:5px 0}.formula{padding:7px;background:var(--el-fill-color-light);border-radius:5px}.note{color:var(--el-color-warning-dark-2)}.source-list{max-height:280px;overflow:auto;margin:10px 0}.source-row{display:flex;align-items:flex-start;justify-content:space-between;gap:15px;padding:7px 0;border-bottom:1px solid var(--el-border-color-lighter)}.source-row div{min-width:0;overflow-wrap:anywhere}.source-row b{white-space:nowrap;font-variant-numeric:tabular-nums}.source-row small{display:block;color:var(--el-text-color-secondary)}
</style>
