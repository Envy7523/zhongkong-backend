<template>
  <div class="card-compact">
    <div class="card-header">🛠 运营成本</div>
    <el-form inline style="margin-bottom:16px;">
      <el-form-item label="门店">
        <el-select v-model="storeId" placeholder="选择门店" @change="loadData" style="width:200px;">
          <el-option v-for="s in stores" :key="s.id" :label="s.store_name" :value="s.id" />
        </el-select>
      </el-form-item>
    </el-form>
    <el-table :data="costs" v-if="costs.length" style="width:100%;">
      <el-table-column prop="date" label="日期" />
      <el-table-column prop="item" label="事项" />
      <el-table-column label="金额">
        <template #default="{ row }">¥{{ (row.amount || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 }) }}</template>
      </el-table-column>
    </el-table>
    <p v-else style="color:#999;padding:20px;">请选择门店后查看</p>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { getStores, getOperatingCosts } from '@/api'

const stores = ref([])
const storeId = ref(null)
const costs = ref([])

onMounted(async () => {
  try {
    const data = await getStores({ page: 1, page_size: 200 })
    stores.value = data.stores || []
  } catch {}
})

async function loadData() {
  if (!storeId.value) return
  try {
    const data = await getOperatingCosts(storeId.value)
    costs.value = (data.costs || []).slice(0, 20)
  } catch {}
}
</script>
