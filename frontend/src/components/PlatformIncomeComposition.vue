<template>
  <section v-if="items.length" class="platform-compositions" aria-label="第三方平台收入构成">
    <article v-for="item in items" :key="item.channel" class="platform-card" :class="{'needs-review':item.missing_days.length>0}">
      <header><strong>{{item.name}}收入构成</strong><span>平台报表</span><el-tag v-if="item.missing_days.length" type="danger" size="small">{{item.available?'部分数据待核对':'待补数据'}}</el-tag><el-tag v-else-if="!item.available" type="info" size="small">{{item.source_overridden?'当前选用收银来源':'暂无平台记录'}}</el-tag></header>
      <div class="platform-metrics">
        <div class="metric total"><span>{{item.gross_label}}</span><b>{{money(item.gross)}}</b><small>{{item.gross_pending?'已导入部分 · 营业日报待补齐':'平台原始金额'}}</small></div>
        <span class="flow-symbol" aria-hidden="true">→</span>
        <div class="metric discount"><span>{{item.discount_label}}</span><b>{{money(item.discount)}}</b><small>按平台报表口径</small></div>
        <span class="flow-symbol" aria-hidden="true">→</span>
        <div class="metric"><span>{{item.income_label}}</span><b>{{money(item.income)}}</b><small>按平台原始口径</small></div>
        <span class="flow-symbol" aria-hidden="true">→</span>
        <div class="metric"><span>平台费用（核对）</span><b>{{money(item.fees)}}</b><small>含退款冲销 · 可展开明细</small></div>
        <span class="flow-symbol" aria-hidden="true">→</span>
        <div class="metric net"><span>最终到手</span><b>{{money(item.net)}}</b><small>{{item.ready?'平台结算实收':'已导入部分'}}</small></div>
      </div>
      <MeituanGroupBreakdown v-if="item.channel==='meituan_group'" :items="item.breakdown||[]"/>
      <footer><span>金额按各平台报表原口径分别列示；费用仅核对，已扣费用不再重复扣减。</span><span v-if="item.source_overridden">当前部分渠道选用收银来源，本卡仅展示第三方部分。</span></footer>
      <details v-if="item.fee_details.length" class="fee-details"><summary>费用明细</summary><dl><template v-for="(fee,index) in item.fee_details" :key="fee.label+'|'+index"><dt>{{fee.label}}</dt><dd>{{money(fee.amount)}}</dd></template></dl><p>正数为费用、负数为冲回；原始费用明细用于核对，不再次计入总收入。</p></details>
      <details v-if="item.missing_days.length" class="missing-details"><summary>{{item.missing_days.length}} 项待补齐，查看门店与日期</summary><ul><li v-for="day in item.missing_days" :key="[day.store_id,day.biz_date,day.reason].join('|')">{{day.biz_date}} · {{day.store_name||'门店 '+day.store_id}} · {{day.reason}}</li></ul><p>已有金额继续展示，缺失部分不使用收银金额补数。</p></details>
    </article>
  </section>
</template>
<script setup>
import MeituanGroupBreakdown from './MeituanGroupBreakdown.vue'
defineProps({items:{type:Array,default:()=>[]}})
const money=n=>n===null||n===undefined?'—':'¥'+Number(n).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})
</script>
<style scoped>
.platform-card{margin:18px 0;border:1px solid var(--el-border-color-lighter);border-radius:10px;background:var(--el-bg-color);padding:18px 22px;color:var(--el-text-color-primary)}header{display:flex;align-items:center;gap:12px;flex-wrap:wrap}header strong{font-size:15px}header>span{font-size:12px;color:var(--el-text-color-secondary)}.platform-metrics{display:grid;grid-template-columns:minmax(0,1fr) 20px minmax(0,1fr) 20px minmax(0,1fr) 20px minmax(0,1fr) 20px minmax(0,1.15fr);align-items:center;gap:12px;margin:22px 0 16px}.metric{display:flex;flex-direction:column;gap:9px;min-width:0;padding:16px 12px}.metric>span,small,footer{font-size:12px;color:var(--el-text-color-secondary)}b{font-size:23px;font-variant-numeric:tabular-nums;line-height:1.25;overflow-wrap:anywhere}.total{background:var(--el-fill-color-light);border-radius:8px}.discount b{color:var(--el-color-warning-dark-2)}.net{border:1px solid var(--el-color-success-light-7);border-radius:8px;background:var(--el-color-success-light-9)}.net b{color:var(--el-color-success-dark-2)}.flow-symbol{text-align:center;color:var(--el-text-color-placeholder);font-size:20px}footer{display:flex;justify-content:space-between;gap:8px 20px;flex-wrap:wrap;padding-top:12px;border-top:1px solid var(--el-border-color-lighter);line-height:1.7}.help{display:inline-grid;place-items:center;width:14px;height:14px;border:1px solid var(--el-border-color);border-radius:50%;font-style:normal;margin-left:5px}.needs-review{border-color:var(--el-color-danger-light-5)}details{font-size:12px;margin-top:12px}summary{cursor:pointer;color:var(--el-text-color-secondary)}.missing-details,.missing-details summary{color:var(--el-color-danger)}ul{max-height:180px;overflow:auto;padding-left:18px;line-height:1.9}p{color:var(--el-text-color-secondary);line-height:1.7}dl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px 24px;max-width:660px;margin:14px 0}dt{color:var(--el-text-color-regular)}dd{margin:0;font-variant-numeric:tabular-nums}@media(max-width:1000px){.platform-metrics{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.flow-symbol{display:none}.net{grid-column:span 2}}@media(max-width:620px){.platform-metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.platform-card{padding:16px}.total,.net{grid-column:span 2}.metric{padding:14px 10px}.metric:nth-of-type(4){grid-column:span 2}b{font-size:21px}}
</style>
