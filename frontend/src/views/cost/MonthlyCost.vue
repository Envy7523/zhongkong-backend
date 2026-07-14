<template>
  <div class="card-compact">
    <div class="card-header">📊 月成本核算</div>
    <el-table :data="rows" v-if="rows.length" style="width:100%;">
      <el-table-column prop="month" label="月" />
      <el-table-column label="营业额">
        <template #default="{ row }">¥{{ (row.revenue || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 }) }}</template>
      </el-table-column>
      <el-table-column label="食材成本">
        <template #default="{ row }">¥{{ (row.food_cost || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 }) }}</template>
      </el-table-column>
      <el-table-column label="净利润">
        <template #default="{ row }">
          <span :style="{ color: (row.net_profit || 0) >= 0 ? '#52c41a' : '#ff4d4f' }">
            ¥{{ (row.net_profit || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 }) }}
          </span>
        </template>
      </el-table-column>
    </el-table>
    <p v-else style="color:#999;padding:20px;">暂无月成本数据</p>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { getMonthlyCost } from '@/api'

const rows = ref([])

onMounted(async () => {
  try {
    const data = await getMonthlyCost()
    rows.value = data.rows || []
  } catch {}
})
</script>
