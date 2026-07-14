<template>
  <div class="card-compact">
    <div class="card-header">门店成本分析</div>
    <el-table :data="rows" v-if="rows.length" style="width:100%;">
      <el-table-column prop="store_name" label="门店" />
      <el-table-column prop="date" label="日期" />
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
    <p v-else style="color:#999;padding:20px;">暂无成本数据</p>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { getCostAnalysis, getStores } from '@/api'

const rows = ref([])

onMounted(async () => {
  try {
    const [costData, storeData] = await Promise.all([getCostAnalysis(), getStores({ page: 1, page_size: 200 })])
    const stores = storeData.stores || []
    rows.value = (costData.rows || []).slice(0, 20).map(r => {
      const store = stores.find(s => s.id === r.store_id)
      return { ...r, store_name: store?.store_name || r.store_id || '—' }
    })
  } catch {}
})
</script>
