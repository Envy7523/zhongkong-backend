<template>
  <div class="card-compact">
    <div class="card-header">⏱ 效期管理</div>
    <el-table :data="items" v-if="items.length" style="width:100%;" v-loading="loading">
      <el-table-column prop="name" label="菜品名称" min-width="140" />
      <el-table-column prop="category" label="分类" />
      <el-table-column prop="expiry_days" label="保质期(天)" />
      <el-table-column label="状态">
        <template #default="{ row }">
          <el-tag :type="row.expiry_days && row.expiry_days <= 3 ? 'danger' : row.expiry_days && row.expiry_days <= 7 ? 'warning' : ''">
            {{ row.expiry_days ? row.expiry_days + '天' : '—' }}
          </el-tag>
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
    items.value = (data.items || []).sort((a, b) => (a.expiry_days || 999) - (b.expiry_days || 999))
  } catch {} finally { loading.value = false }
})
</script>
