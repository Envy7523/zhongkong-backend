<template>
  <div class="card-compact">
    <div class="card-header">门店销量统计</div>
    <el-table :data="rows" v-if="rows.length" style="width:100%;">
      <el-table-column prop="store_name" label="门店" />
      <el-table-column prop="date" label="日期" />
      <el-table-column label="营业额">
        <template #default="{ row }">¥{{ (row.revenue || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 }) }}</template>
      </el-table-column>
      <el-table-column label="实收">
        <template #default="{ row }">¥{{ (row.actual_revenue || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 }) }}</template>
      </el-table-column>
      <el-table-column prop="order_count" label="订单数" />
      <el-table-column label="优惠金额">
        <template #default="{ row }">¥{{ (row.discount_amount || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 }) }}</template>
      </el-table-column>
    </el-table>
    <p v-else style="color:#999;padding:20px;">暂无销售数据</p>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { getSalesAnalysis } from '@/api'

const rows = ref([])

onMounted(async () => {
  try {
    const data = await getSalesAnalysis()
    rows.value = data.rows || []
  } catch {}
})
</script>
