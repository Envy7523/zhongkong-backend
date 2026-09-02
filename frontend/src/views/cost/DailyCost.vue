<template>
  <div>
    <div class="card-compact">
      <div class="card-header">🧮 日成本核算</div>
      <el-form inline>
        <el-form-item label="门店">
          <StoreRegionSelect v-model="form.storeId" :stores="stores" placeholder="选择门店或区域" style="width:200px;" />
        </el-form-item>
        <el-form-item label="日期">
          <el-date-picker v-model="form.date" :clearable="false" type="date" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="calculate" :loading="loading">🧮 计算日成本</el-button>
        </el-form-item>
      </el-form>
      <div v-if="result" style="margin-top:12px;">
        <el-alert type="success" :closable="false">
          <p style="margin:0;line-height:1.8;">
            净利润：<strong>¥{{ result.net_profit?.toLocaleString('zh-CN', { minimumFractionDigits: 2 }) }}</strong><br/>
            营业额 ¥{{ result.detail?.revenue?.toLocaleString() || 0 }},
            实收 ¥{{ result.detail?.actualRevenue?.toLocaleString() || 0 }},
            固定成本 ¥{{ result.detail?.dailyFixed || 0 }},
            食材 ¥{{ result.detail?.foodCost || 0 }}
          </p>
        </el-alert>
      </div>
    </div>

    <div class="card-compact">
      <div class="card-header">📋 最近成本核算</div>
      <el-table :data="recent" v-if="recent.length" style="width:100%;">
        <el-table-column prop="date" label="日期" />
        <el-table-column prop="store_name" label="门店" />
        <el-table-column label="营业额">
          <template #default="{ row }">¥{{ (row.revenue || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 }) }}</template>
        </el-table-column>
        <el-table-column label="净利润">
          <template #default="{ row }">
            <span :style="{ color: (row.net_profit || 0) >= 0 ? '#52c41a' : '#ff4d4f' }">
              ¥{{ (row.net_profit || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 }) }}
            </span>
          </template>
        </el-table-column>
      </el-table>
      <p v-else style="color:#999;padding:20px;">点击计算按钮加载</p>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { getStores, calculateCost, getCostAccounting } from '@/api'
import StoreRegionSelect from '@/components/StoreRegionSelect.vue'

const stores = ref([])
const form = reactive({ storeId: null, date: new Date() })
const loading = ref(false)
const result = ref(null)
const recent = ref([])

onMounted(async () => {
  try {
    const data = await getStores({ page: 1, page_size: 200 })
    stores.value = data.stores || []
  } catch {}
})

async function calculate() {
  if (!form.storeId) return
  loading.value = true
  try {
    const data = await calculateCost({
      store_id: parseInt(form.storeId),
      date: form.date instanceof Date ? form.date.toISOString().slice(0, 10) : form.date
    })
    result.value = data
    loadRecent()
  } catch {} finally { loading.value = false }
}

async function loadRecent() {
  try {
    const data = await getCostAccounting({ limit: 10 })
    recent.value = data.rows || []
  } catch {}
}
</script>
