<template>
  <section v-if="data" class="member-consumption" :class="{'needs-review':!data.ready}">
    <header><strong>会员消费构成</strong><span>{{data.ready?'消费到实收，一目了然':'以下为已核实部分'}}</span><el-tag v-if="!data.ready" type="danger" size="small">待核对</el-tag></header>
    <div class="member-metrics">
      <article class="total"><span>会员消费总额</span><b>{{money(data.consumption)}}</b><small>本金 + 赠金</small></article>
      <span class="flow-symbol" aria-hidden="true">=</span>
      <article><span>消费本金</span><b>{{money(data.principal)}}</b><small>占消费 {{ratio(data.principal_ratio)}}</small></article>
      <span class="flow-symbol" aria-hidden="true">+</span>
      <article class="gift"><span>消费赠金</span><b>{{money(data.gift)}}</b><small>占消费 {{ratio(data.gift_ratio)}} · 门店承担</small></article>
      <span class="flow-symbol" aria-hidden="true">→</span>
      <article><span>本金手续费<el-tooltip :content="data.fee_basis||'本金×0.0038测算，非实际提现扣款'"><i class="estimate">测算</i></el-tooltip></span><b>{{money(data.fee)}}</b><small>本金 × 0.38%</small></article>
      <span class="flow-symbol" aria-hidden="true">→</span>
      <article class="net"><span>最终到手<el-tooltip content="本金减手续费测算，不代表已完成提现"><i class="estimate">测算</i></el-tooltip></span><b>{{money(data.net)}}</b><small>本金 − 手续费</small></article>
    </div>
    <footer><span>赠金不计实收、不收手续费；最终到手已扣一次手续费测算。</span><span v-if="data.daily">当日消费 {{money(data.daily.consumption)}} · 本金 {{money(data.daily.principal)}} · 赠金 {{money(data.daily.gift)}} · 手续费 {{money(data.daily.fee)}} · 到手 {{money(data.daily.net)}}（测算）</span></footer>
    <details v-if="!data.ready"><summary>{{data.available?data.missing_days?.length+' 个店日待核对':'会员交易流水未导入'}}，查看明细</summary><ul><li v-for="day in data.missing_days||[]" :key="day.store_id+'|'+day.biz_date">{{day.biz_date}} · {{day.store_name}} · {{day.reason}}</li></ul><p>仅展示已核实金额，缺失部分不推算赠金或手续费。</p></details>
  </section>
</template>
<script setup>
defineProps({data:{type:Object,default:null}})
const money=n=>n===null||n===undefined?'待核对':'¥'+Number(n).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})
const ratio=n=>n===null||n===undefined?'—':(n*100).toFixed(2)+'%'
</script>
<style scoped>
.member-consumption{margin:18px 0;border:1px solid var(--el-border-color-lighter);border-radius:10px;background:var(--el-bg-color);padding:18px 22px;color:var(--el-text-color-primary)}header{display:flex;align-items:center;gap:12px;flex-wrap:wrap}header strong{font-size:15px}header>span{font-size:12px;color:var(--el-text-color-secondary)}.member-metrics{display:grid;grid-template-columns:minmax(0,1fr) 20px minmax(0,1fr) 20px minmax(0,1fr) 20px minmax(0,1fr) 20px minmax(0,1.15fr);align-items:center;gap:12px;margin:22px 0 16px}.member-metrics article{display:flex;flex-direction:column;gap:9px;min-width:0;padding:16px 12px}.member-metrics article>span,small,footer{font-size:12px;color:var(--el-text-color-secondary)}b{font-size:23px;font-variant-numeric:tabular-nums;line-height:1.25;overflow-wrap:anywhere}.total{background:var(--el-fill-color-light);border-radius:8px}.gift b{color:var(--el-color-warning-dark-2)}.net{border:1px solid var(--el-color-success-light-7);border-radius:8px;background:var(--el-color-success-light-9)}.net b{color:var(--el-color-success-dark-2)}.flow-symbol{text-align:center;color:var(--el-text-color-placeholder);font-size:20px}.estimate{font-style:normal;font-size:10px;margin-left:6px;padding:2px 5px;border-radius:4px;background:var(--el-fill-color-light)}footer{display:flex;justify-content:space-between;gap:8px 20px;flex-wrap:wrap;padding-top:12px;border-top:1px solid var(--el-border-color-lighter);line-height:1.7}.needs-review{border-color:var(--el-color-danger-light-5)}details{font-size:12px;color:var(--el-color-danger);margin-top:12px}summary{cursor:pointer}ul{max-height:180px;overflow:auto;padding-left:18px;line-height:1.9}@media(max-width:1000px){.member-metrics{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.flow-symbol{display:none}.net{grid-column:span 2}}@media(max-width:620px){.member-metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.member-consumption{padding:16px}.total{grid-column:span 2}.net{grid-column:span 2}.member-metrics article{padding:14px 10px}.member-metrics article:nth-of-type(4){grid-column:span 2}b{font-size:21px}}
</style>
