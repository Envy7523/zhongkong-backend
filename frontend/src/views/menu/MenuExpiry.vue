<template>
  <div class="card-compact">
    <div class="card-header">⏱ 效期管理</div>
    <el-table :data="items" v-if="items.length" style="width:100%;" v-loading="loading" size="small">
      <el-table-column prop="name" label="菜品名称" min-width="130" />
      <el-table-column prop="category" label="分类" width="80" />
      <el-table-column label="规格" width="100">
        <template #default="{ row }">
          <span v-if="row.spec_unit || row.spec_weight">
            {{ row.spec_unit || '' }}{{ row.spec_weight ? '/' + row.spec_weight : '' }}
          </span>
          <span v-else style="color:#c0c4cc;">—</span>
        </template>
      </el-table-column>
      <el-table-column label="堂食价" width="80" align="right">
        <template #default="{ row }">¥{{ (row.dine_in_price || 0).toFixed(2) }}</template>
      </el-table-column>
      <el-table-column label="会员价" width="80" align="right">
        <template #default="{ row }">¥{{ (row.member_price || 0).toFixed(2) }}</template>
      </el-table-column>
      <el-table-column prop="expiry_days" label="保质期" width="85" align="center">
        <template #default="{ row }">
          <el-tag
            :type="row.expiry_days && row.expiry_days <= 3 ? 'danger' : row.expiry_days && row.expiry_days <= 7 ? 'warning' : 'info'"
            size="small"
          >
            {{ row.expiry_days ? row.expiry_days + ' 天' : '—' }}
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
