<template>
  <div class="bookkeeping-records">
    <BookkeepingHeader active="records" />

    <el-card class="records-card" shadow="never">
      <div class="store-info">
        <span class="label">门店：{{ storeName }}</span>
        <span v-if="!storeName" class="hint">（未绑定门店）</span>
      </div>

      <!-- 筛选栏 -->
      <div class="filters">
        <div class="filter-field">
          <span class="filter-label">日期</span>
          <el-date-picker
            v-model="filters.date_from"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="开始日期"
            clearable
            style="width: 100%"
            @change="handleFilter"
          />
          <span class="filter-sep">至</span>
          <el-date-picker
            v-model="filters.date_to"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="结束日期"
            clearable
            style="width: 100%"
            @change="handleFilter"
          />
        </div>

        <div class="filter-field">
          <span class="filter-label">分类</span>
          <el-select
            v-model="filters.category_id"
            placeholder="全部分类"
            clearable
            style="width: 180px"
            @change="handleFilter"
          >
            <el-option
              v-for="cat in categories"
              :key="cat.id"
              :label="cat.name"
              :value="cat.id"
            />
          </el-select>
        </div>

        <div class="filter-field">
          <span class="filter-label">视图</span>
          <el-radio-group v-model="mode">
            <el-radio-button value="detail">明细</el-radio-button>
            <el-radio-button value="daily">按日汇总</el-radio-button>
          </el-radio-group>
        </div>

        <div class="filter-field filter-actions">
          <el-button @click="resetFilters">重置</el-button>
          <el-button type="primary" :loading="loading" @click="loadData">
            查询
          </el-button>
        </div>
      </div>
    </el-card>

    <!-- 明细模式 -->
    <el-card v-if="mode === 'detail'" class="records-card" shadow="never">
      <div class="card-head">
        <span class="card-title">📋 记账明细</span>
        <span class="card-total">
          合计：<strong class="amount">{{ sumAmount }}</strong>
        </span>
      </div>
      <el-table :data="entries" v-loading="loading" stripe style="width: 100%">
        <el-table-column prop="date" label="日期" width="110" />
        <el-table-column prop="category_name" label="分类" width="120" />
        <el-table-column prop="subcategory_name" label="子分类" min-width="120">
          <template #default="{ row }">{{ row.subcategory_name || '—' }}</template>
        </el-table-column>
        <el-table-column label="金额" width="110" align="right">
          <template #default="{ row }">{{ formatAmount(row.amount) }}</template>
        </el-table-column>
        <el-table-column label="图片" width="150">
          <template #default="{ row }">
            <div v-if="imagesOf(row).length" class="thumb-list">
              <el-image
                v-for="(img, i) in imagesOf(row).slice(0, maxThumbs)"
                :key="i"
                :src="img"
                :preview-src-list="imagesOf(row)"
                :initial-index="i"
                fit="cover"
                class="thumb"
                preview-teleported
                hide-on-click-modal
              />
              <span v-if="imagesOf(row).length > maxThumbs" class="thumb-more">
                +{{ imagesOf(row).length - maxThumbs }}
              </span>
            </div>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ row.remark || '—' }}</template>
        </el-table-column>
        <el-table-column prop="user_name" label="记账人" width="120" />
        <el-table-column label="操作" width="80" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="danger" text @click="handleDelete(row)">
              删除
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无记账记录" :image-size="80" />
        </template>
      </el-table>
    </el-card>

    <!-- 按日汇总模式 -->
    <el-card v-else class="records-card" shadow="never">
      <div class="card-head">
        <span class="card-title">📊 按日汇总</span>
        <span class="card-total">
          合计：<strong class="amount">{{ sumDailyAmount }}</strong>
        </span>
      </div>
      <el-table :data="dailyRows" v-loading="loading" stripe style="width: 100%">
        <el-table-column prop="date" label="日期" width="140" />
        <el-table-column label="总金额" align="right">
          <template #default="{ row }">{{ formatAmount(row.total_amount) }}</template>
        </el-table-column>
        <el-table-column label="笔数" width="120" align="center">
          <template #default="{ row }">{{ row.entry_count ?? 0 }}</template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无汇总数据" :image-size="80" />
        </template>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { getBookkeepingEntries, deleteBookkeepingEntry, getBookkeepingCategories } from '@/api'
import { useAuthStore } from '@/stores/auth'
import BookkeepingHeader from './BookkeepingHeader.vue'

const authStore = useAuthStore()

const maxThumbs = 3

const storeName = computed(() => authStore.user?.store_name || '')

const mode = ref('detail')
const loading = ref(false)
const entries = ref([])
const dailyRows = ref([])
const categories = ref([])

const filters = reactive({
  date_from: '',
  date_to: '',
  category_id: null
})

const sumAmount = computed(() =>
  entries.value.reduce((acc, e) => acc + (Number(e.amount) || 0), 0)
)

const sumDailyAmount = computed(() =>
  dailyRows.value.reduce((acc, r) => acc + (Number(r.total_amount) || 0), 0)
)

function formatAmount(value) {
  const n = Number(value) || 0
  return `¥${n.toFixed(2)}`
}

function imagesOf(row) {
  if (!row) return []
  let val = row.images
  if (val == null || val === '') return []
  if (typeof val === 'string') {
    try { val = JSON.parse(val) } catch { val = [] }
  }
  if (!Array.isArray(val)) return []
  return val.filter((u) => typeof u === 'string' && u)
}

function buildParams() {
  const params = {}
  if (filters.date_from) params.date_from = filters.date_from
  if (filters.date_to) params.date_to = filters.date_to
  if (filters.category_id != null && filters.category_id !== '') {
    params.category_id = filters.category_id
  }
  if (authStore.user?.store_id != null) {
    params.store_id = authStore.user.store_id
  }
  if (mode.value === 'daily') params.aggregate = 'daily'
  return params
}

async function loadData() {
  loading.value = true
  try {
    if (mode.value === 'daily') {
      const data = await getBookkeepingEntries(buildParams())
      dailyRows.value = data?.rows || []
      entries.value = []
    } else {
      const data = await getBookkeepingEntries(buildParams())
      entries.value = data?.entries || []
      dailyRows.value = []
    }
  } catch (e) {
    ElMessage.error(e?.response?.data?.message || e?.message || '加载失败')
  } finally {
    loading.value = false
  }
}

async function loadCategories() {
  try {
    const data = await getBookkeepingCategories()
    categories.value = data?.categories || []
  } catch (e) {
    ElMessage.error('加载分类失败')
  }
}

function handleFilter() {
  loadData()
}

function resetFilters() {
  filters.date_from = ''
  filters.date_to = ''
  filters.category_id = null
  loadData()
}

async function handleDelete(row) {
  try {
    await ElMessageBox.confirm(
      `确定删除 ${formatAmount(row.amount)} 的记账记录吗？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await deleteBookkeepingEntry(row.id)
    ElMessage.success('删除成功')
    loadData()
  } catch (e) {
    ElMessage.error(e?.response?.data?.message || e?.message || '删除失败')
  }
}

watch(mode, () => {
  loadData()
})

onMounted(() => {
  loadCategories()
  loadData()
})
</script>

<style scoped>
.bookkeeping-records {
  padding: 16px;
}

.store-info {
  display: flex;
  align-items: center;
  font-size: 15px;
  color: #303133;
  margin-bottom: 4px;
}

.store-info .label {
  font-weight: 600;
}

.store-info .hint {
  margin-left: 8px;
  font-size: 13px;
  color: #909399;
  font-weight: 400;
}

.records-card {
  border-radius: 8px;
  margin-bottom: 16px;
}

.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 16px;
  margin-top: 12px;
}

.filter-field {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.filter-label {
  font-size: 13px;
  color: #606266;
  white-space: nowrap;
}

.filter-sep {
  color: #909399;
}

.filter-actions {
  margin-left: auto;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.card-title {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
}

.card-total {
  font-size: 14px;
  color: #606266;
}

.card-total .amount {
  color: #e6481e;
  font-size: 16px;
}

.thumb-list {
  display: flex;
  align-items: center;
  gap: 6px;
}

.thumb {
  width: 44px;
  height: 44px;
  border-radius: 4px;
  cursor: pointer;
  background: #f5f7fa;
}

.thumb-more {
  font-size: 12px;
  color: #909399;
}

.muted {
  color: #c0c4cc;
}
</style>
