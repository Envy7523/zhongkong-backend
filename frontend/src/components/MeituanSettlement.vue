<template>
  <section v-if="missingPlatform.length || settlement.missing_days?.length || settlement.missing_operation_days?.length" class="settlement-missing" aria-label="待补报表">
    <details>
      <summary>待补报表：{{ missingPlatform.length ? `收银机有数据、平台未上传 ${missingPlatform.length} 个店日；` : '' }}{{ settlement.missing_days?.length ? `缺订单结算 ${settlement.missing_days.length} 个店日；` : '' }}{{ settlement.missing_operation_days?.length ? `缺营业日报 ${settlement.missing_operation_days.length} 个店日` : '' }}</summary>
      <p v-for="day in missingPlatform" :key="`pos-${day.store_id}-${day.biz_date}`">{{ day.store_name }} · {{ day.biz_date }}：收银机有数据，平台报表未上传。</p>
      <p v-for="day in settlement.missing_days || []" :key="`bill-${day.store_id}-${day.date}`">{{ day.store_name }} · {{ day.date }}：订单结算未上传。</p>
      <p v-for="day in settlement.missing_operation_days || []" :key="`op-${day.store_id}-${day.date}`">门店 {{ day.store_id }} · {{ day.date }}：营业日报未上传。</p>
    </details>
  </section>
</template>
<script setup>
import { computed } from 'vue'
const props = defineProps({ totals: { type: Object, required: true }, missingPlatformDays: { type: Array, default: () => [] } })
const settlement = computed(() => props.totals.settlement || {})
const missingPlatform = computed(() => props.missingPlatformDays.filter(row => row.channel === 'meituan_delivery'))
</script>
<style scoped>
.settlement-missing{margin:8px 0 20px;color:var(--el-text-color-secondary);font-size:13px}.settlement-missing summary{cursor:pointer}.settlement-missing p{margin:8px 0}
</style>
