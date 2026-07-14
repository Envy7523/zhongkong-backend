<template>
  <div class="card-compact">
    <div class="card-header">门店营收构成 <span style="font-weight:400;color:#999;font-size:13px;">合计 ¥{{ total.toLocaleString('zh-CN', { minimumFractionDigits: 2 }) }}</span></div>
    <el-table :data="rows" v-if="rows.length" style="width:100%;">
      <el-table-column prop="label" label="渠道" />
      <el-table-column label="金额">
        <template #default="{ row }">¥{{ row.value.toLocaleString('zh-CN', { minimumFractionDigits: 2 }) }}</template>
      </el-table-column>
      <el-table-column label="占比">
        <template #default="{ row }">{{ total > 0 ? (row.value / total * 100).toFixed(1) : 0 }}%</template>
      </el-table-column>
    </el-table>
    <p v-else style="color:#999;padding:20px;">暂无营收数据，请先导入日报</p>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { getRevenueAnalysis } from '@/api'

const rows = ref([])
const total = ref(0)

onMounted(async () => {
  try {
    const data = await getRevenueAnalysis()
    const ch = data.channels || {}
    const items = [
      ['店内销售', ch.instore], ['自提销售', ch.pickup], ['美团外卖', ch.mtWaimai],
      ['淘宝闪购', ch.tbFlash], ['京东外卖', ch.jdWaimai], ['美团一键买单', ch.mtPay],
      ['美团团购', ch.mtTuan], ['抖音团购', ch.dyTuan], ['储值消费', ch.stored], ['优惠券', ch.coupon]
    ].filter(r => r[1] > 0).sort((a, b) => b[1] - a[1])
    rows.value = items.map(([label, value]) => ({ label, value }))
    total.value = items.reduce((s, r) => s + r[1], 0)
  } catch {}
})
</script>
