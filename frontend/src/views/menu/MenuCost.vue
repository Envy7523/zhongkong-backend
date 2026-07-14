<template>
  <div class="card-compact">
    <div class="card-header">💰 菜品成本</div>
    <el-table :data="items" v-if="items.length" style="width:100%;" v-loading="loading">
      <el-table-column prop="name" label="菜品名称" min-width="140" />
      <el-table-column label="售价">
        <template #default="{ row }">¥{{ (row.price || 0).toFixed(2) }}</template>
      </el-table-column>
      <el-table-column label="成本">
        <template #default="{ row }">¥{{ (row.cost || 0).toFixed(2) }}</template>
      </el-table-column>
      <el-table-column label="毛利率">
        <template #default="{ row }">
          <span :style="{ color: row.price > 0 && ((row.price - row.cost) / row.price * 100) >= 60 ? '#52c41a' : '#faad14' }">
            {{ row.price > 0 ? ((row.price - (row.cost || 0)) / row.price * 100).toFixed(0) : 0 }}%
          </span>
        </template>
      </el-table-column>
    </el-table>
    <p v-else style="color:#999;padding:20px;">暂无菜品数据</p>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { getMenuItems } from '@/api'

const items = ref([])
const loading = ref(false)

onMounted(async () => {
  loading.value = true
  try {
    const data = await getMenuItems({ page: 1, page_size: 200 })
    items.value = data.items || []
  } catch {} finally { loading.value = false }
})
</script>
