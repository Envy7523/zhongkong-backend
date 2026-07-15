<template>
  <div class="card-compact">
    <div class="card-header">💰 菜品成本</div>
    <el-table :data="items" v-if="items.length" style="width:100%;" v-loading="loading" size="small">
      <el-table-column prop="name" label="菜品名称" min-width="130" />
      <el-table-column prop="category" label="分类" width="80" />
      <el-table-column label="堂食价" width="85" align="right">
        <template #default="{ row }">¥{{ (row.dine_in_price || 0).toFixed(2) }}</template>
      </el-table-column>
      <el-table-column label="会员价" width="85" align="right">
        <template #default="{ row }">¥{{ (row.member_price || 0).toFixed(2) }}</template>
      </el-table-column>
      <el-table-column label="外卖价" width="85" align="right">
        <template #default="{ row }">¥{{ (row.takeout_price || 0).toFixed(2) }}</template>
      </el-table-column>
      <el-table-column label="成本" width="75" align="right">
        <template #default="{ row }">¥{{ (row.cost || 0).toFixed(2) }}</template>
      </el-table-column>
      <el-table-column label="堂食毛利率" width="90" align="center">
        <template #default="{ row }">
          <span :style="{ color: marginColor(row, 'dine_in_price') }">
            {{ marginPct(row, 'dine_in_price') }}%
          </span>
        </template>
      </el-table-column>
      <el-table-column label="会员毛利率" width="90" align="center">
        <template #default="{ row }">
          <span :style="{ color: marginColor(row, 'member_price') }">
            {{ marginPct(row, 'member_price') }}%
          </span>
        </template>
      </el-table-column>
      <el-table-column label="外卖毛利率" width="90" align="center">
        <template #default="{ row }">
          <span :style="{ color: marginColor(row, 'takeout_price') }">
            {{ marginPct(row, 'takeout_price') }}%
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

function marginPct(row, priceField) {
  const price = row[priceField] || 0
  if (price <= 0) return 0
  return ((price - (row.cost || 0)) / price * 100).toFixed(0)
}
function marginColor(row, priceField) {
  const pct = parseFloat(marginPct(row, priceField))
  if (pct >= 60) return '#52c41a'
  if (pct >= 40) return '#faad14'
  return '#ff4d4f'
}

onMounted(async () => {
  loading.value = true
  try {
    const data = await getMenuItems({ page: 1, page_size: 200 })
    items.value = data.items || []
  } catch {} finally { loading.value = false }
})
</script>
