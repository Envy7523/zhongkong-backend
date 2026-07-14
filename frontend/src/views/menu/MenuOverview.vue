<template>
  <div class="card-compact">
    <div class="card-header">🍽️ 菜品总览</div>
    <el-table :data="items" v-if="items.length" style="width:100%;" v-loading="loading">
      <el-table-column prop="name" label="菜品名称" min-width="140" />
      <el-table-column prop="category" label="分类" width="100" />
      <el-table-column label="售价">
        <template #default="{ row }">¥{{ (row.price || 0).toFixed(2) }}</template>
      </el-table-column>
      <el-table-column label="成本">
        <template #default="{ row }">¥{{ (row.cost || 0).toFixed(2) }}</template>
      </el-table-column>
      <el-table-column prop="expiry_days" label="效期(天)" width="90" />
      <el-table-column prop="status" label="状态" width="80" />
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
