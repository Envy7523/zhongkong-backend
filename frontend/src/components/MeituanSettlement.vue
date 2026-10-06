<template>
  <section class="mt-settlement" aria-label="美团营业收入与结算到账核对">
    <div class="amounts">
      <div><span>营业收入（营业日报）</span><strong>{{ money(totals.income_amount) }}</strong></div>
      <div><span>已导入结算到账</span><strong>{{ settlement.has_bills ? money(settlement.confirmed_amount) : '待导入' }}</strong><small>{{ settlement.complete ? '当前有营业的店日均有订单结算记录' : '结算覆盖不完整，不能当作整段最终到账' }}</small></div>
    </div>
    <el-alert v-if="!settlement.complete" type="warning" :closable="false" title="结算资料未齐全，暂不计算整段结算支出和实际到手">
      <p v-if="settlement.missing_days?.length">缺少 {{ settlement.missing_days.length }} 个店日的订单结算记录，对应营业日报收入 {{ money(settlement.missing_operating_income) }}。这部分是待核收入，不是平台扣款。</p>
      <p v-for="day in settlement.missing_days || []" :key="`${day.store_id}-${day.date}`">{{ day.store_name }} · {{ day.date }} · 营业收入 {{ money(day.operating_income) }}</p>
      <p v-if="settlement.missing_operation_days?.length">另有 {{ settlement.missing_operation_days.length }} 个结算店日缺少营业日报，需补齐原表。</p>
    </el-alert>
    <div v-if="settlement.complete" class="equation">营业额 {{ money(totals.gross_amount) }} − 结算支出 {{ money(settlement.expense_total) }} = 结算到账 {{ money(settlement.confirmed_amount) }}</div>
    <el-table :data="settlement.complete ? settlement.expense_items : settlement.fee_items" border>
      <el-table-column prop="label" :label="settlement.complete ? '结算支出构成' : '已导入结算流水的非订单扣款 / 返款'" />
      <el-table-column label="金额" align="right" width="150"><template #default="{ row }">{{ money(row.amount) }}</template></el-table-column>
    </el-table>
    <p class="note">负数表示该原始交易类型净入账。订单内优惠及扣费为营业额与订单应收款的差额，不能全部视作客户优惠；推广充值不等于当日广告消耗。</p>
    <div v-if="settlement.complete">结算到账 {{ money(settlement.confirmed_amount) }} − 第三方成本 {{ money(totals.external_expense_amount) }} − 菜品成本 {{ money(totals.cost_amount) }} = 实际到手 {{ money(settlement.confirmed_amount - (totals.external_expense_amount || 0) - (totals.cost_amount || 0)) }}</div>
  </section>
</template>
<script setup>
import { computed } from 'vue'
const props = defineProps({ totals: { type: Object, required: true } })
const settlement = computed(() => props.totals.settlement || { complete: false, has_bills: false, fee_items: [], missing_days: [] })
const money = value => `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
</script>
<style scoped>
.mt-settlement{margin:20px 0;padding:20px;background:var(--el-bg-color);border:1px solid var(--el-border-color-light);border-radius:12px}.amounts{display:flex;flex-wrap:wrap;gap:48px;margin-bottom:16px}.amounts span,.amounts strong,.amounts small{display:block}.amounts strong{font-size:24px;margin:8px 0}.amounts small,.note{color:var(--el-text-color-secondary);font-size:13px}.equation{padding:16px 0}.el-alert{margin-bottom:16px}
</style>
