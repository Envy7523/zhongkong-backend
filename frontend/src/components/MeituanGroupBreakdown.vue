<template>
  <div v-if="items.length" class="group-breakdown">
    <div class="breakdown-scroll" tabindex="0" aria-label="美团团购券与一键买单尾款明细">
      <table>
        <thead><tr><th scope="col">收入类型</th><th scope="col">销售金额</th><th scope="col">平台优惠</th><th scope="col">顾客实付</th><th scope="col">平台费用（核对）</th><th scope="col">最终到手</th></tr></thead>
        <tbody><tr v-for="item in items" :key="item.kind"><th scope="row">{{item.name}}<span v-if="item.partial" class="pending">待补齐</span><span v-else-if="!item.available" class="empty">暂无记录</span></th><td>{{money(item.gross)}}</td><td>{{money(item.discount)}}</td><td>{{money(item.income)}}</td><td>{{money(item.fees)}}</td><td class="net">{{money(item.net)}}</td></tr></tbody>
      </table>
    </div>
    <p>两项均已计入美团团购合计；费用仅供核对，不再扣减。<span v-if="items.some(item=>item.partial)">待补部分保留已导入金额。</span></p>
  </div>
</template>
<script setup>
defineProps({items:{type:Array,default:()=>[]}})
const money=value=>value==null?'—':'¥'+Number(value).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})
</script>
<style scoped>
.group-breakdown{margin-top:16px}.breakdown-scroll{overflow-x:auto;border:1px solid var(--el-border-color-lighter);border-radius:8px}.breakdown-scroll:focus-visible{outline:2px solid var(--el-color-primary);outline-offset:2px}table{width:100%;border-collapse:collapse;white-space:nowrap;font-size:13px;font-variant-numeric:tabular-nums}th,td{padding:13px 16px;text-align:right;border-bottom:1px solid var(--el-border-color-lighter)}thead th{background:var(--el-fill-color-light);font-size:12px;color:var(--el-text-color-secondary);font-weight:500}th:first-child{text-align:left}tbody th{font-weight:500;color:var(--el-text-color-regular)}tbody tr:last-child>*{border-bottom:0}tbody tr:nth-child(even){background:var(--el-fill-color-lighter)}.net{color:var(--el-color-success-dark-2);font-weight:600}.pending,.empty{font-size:11px;margin-left:8px}.pending{color:var(--el-color-danger)}.empty,p{color:var(--el-text-color-secondary)}p{font-size:12px;line-height:1.7;margin:10px 0 0}@media(max-width:620px){th,td{padding:11px 12px}}
</style>
