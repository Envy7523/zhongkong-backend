<template>
  <div class="bookkeeping-records">
    <BookkeepingHeader active="records" />

    <el-card class="records-card" shadow="never">
      <div class="records-overview">
        <div>
          <span class="overview-label">账本范围</span>
          <strong>{{ selectedStoreLabel }}</strong>
          <small>{{ canSelectStore ? '可选择单店或查看全部门店' : '当前账号仅可查看已绑定门店' }}</small>
        </div>
        <span class="overview-count">{{ mode === 'detail' ? recordTotal : summaryRows.length }} {{ mode === 'detail' ? '条记录' : '个分类' }}</span>
      </div>

      <!-- 筛选栏 -->
      <div class="filters">
        <div class="filter-field date-filter">
          <span class="filter-label">日期</span>
          <div class="date-range">
            <el-date-picker v-model="filters.date_from" :clearable="false" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" @change="handleFilter" />
            <span class="filter-sep">至</span>
            <el-date-picker v-model="filters.date_to" :clearable="false" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" @change="handleFilter" />
          </div>
        </div>

        <div v-if="canSelectStore" class="filter-field">
          <span class="filter-label">门店</span>
          <StoreRegionSelect v-model="filters.store_ids" :stores="stores" multiple placeholder="全部门店或按区域勾选" @update:model-value="handleFilter" />
        </div>

        <div class="filter-field">
          <span class="filter-label">分类</span>
          <el-select
            v-model="filters.category_id"
            placeholder="全部分类"
            clearable
            style="width: 180px"
            @change="handleCategoryChange"
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
          <span class="filter-label">子分类</span>
          <el-select
            v-model="filters.subcategory_id"
            placeholder="先选择分类"
            clearable
            filterable
            :disabled="!filters.category_id"
            style="width: 180px"
            @change="handleFilter"
          >
            <el-option
              v-for="subcategory in subcategories"
              :key="subcategory.id"
              :label="subcategory.name"
              :value="subcategory.id"
            />
          </el-select>
        </div>

        <div class="filter-field view-filter">
          <span class="filter-label">视图</span>
          <el-radio-group v-model="mode">
            <el-radio-button value="detail">每日明细</el-radio-button>
            <el-radio-button value="summary">分类汇总</el-radio-button>
          </el-radio-group>
        </div>

        <div class="filter-field filter-actions">
          <el-button type="success" plain @click="openQuickEntry">快捷录入</el-button>
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
          合计：<strong :class="amountClass(sumAmount)">{{ formatAmount(sumAmount) }}</strong>
        </span>
        <el-button v-if="selectedEntries.length" type="danger" plain size="small" @click="handleBatchDelete">
          批量删除所选 {{ selectedEntries.length }} 条
        </el-button>
      </div>
      <el-table :data="entries" v-loading="loading" stripe style="width: 100%" row-key="id" @selection-change="onSelectionChange">
        <el-table-column type="selection" width="46" fixed="left" reserve-selection />
        <el-table-column prop="date" label="日期" width="110" />
        <el-table-column prop="store_name" label="门店" min-width="170" show-overflow-tooltip />
        <el-table-column prop="category_name" label="分类" width="120" />
        <el-table-column prop="subcategory_name" label="子分类" min-width="120">
          <template #default="{ row }">{{ row.subcategory_name || '—' }}</template>
        </el-table-column>
        <el-table-column label="金额" width="110" align="right">
          <template #default="{ row }"><b :class="amountClass(row.amount)">{{ formatAmount(row.amount) }}</b></template>
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
      <div v-if="recordTotal > 0" class="records-pagination">
        <span>当前第 {{ detailPage }} 页</span>
        <el-pagination v-model:current-page="detailPage" v-model:page-size="detailPageSize" :page-sizes="[20, 50, 100, 200]" :total="recordTotal" layout="total, sizes, prev, pager, next" background @current-change="loadData" @size-change="handleDetailPageSizeChange" />
      </div>
    </el-card>

    <!-- 分类汇总模式：按当前筛选范围内的大类和小类汇总，不按日期拆分 -->
    <el-card v-else class="records-card" shadow="never">
      <div class="card-head">
        <span class="card-title">📊 分类汇总</span>
        <span class="card-total">
          合计：<strong :class="amountClass(sumSummaryAmount)">{{ formatAmount(sumSummaryAmount) }}</strong>
        </span>
      </div>
      <el-table :data="summaryRows" v-loading="loading" stripe style="width: 100%">
        <el-table-column prop="category_name" label="大类" min-width="220" />
        <el-table-column prop="subcategory_name" label="小类" min-width="240">
          <template #default="{ row }">{{ row.subcategory_name || '未分类' }}</template>
        </el-table-column>
        <el-table-column label="汇总金额" min-width="180" align="right">
          <template #default="{ row }"><span :class="amountClass(row.total_amount)">{{ formatAmount(row.total_amount) }}</span></template>
        </el-table-column>
        <el-table-column label="记录笔数" width="150" align="center">
          <template #default="{ row }">{{ row.entry_count ?? 0 }}</template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无汇总数据" :image-size="80" />
        </template>
      </el-table>
    </el-card>

    <el-dialog v-model="quickEntryVisible" title="快捷录入记账数据" width="900px" destroy-on-close class="quick-entry-dialog">
      <div class="quick-entry-lead">
        <span>粘贴“序号、门店名称、大类、小类、金额”五列数据即可；支持 Markdown 表格和 Excel 复制的制表符文本。</span>
        <el-tag type="warning" effect="plain">所有数据将归属到同一天</el-tag>
      </div>
      <div class="quick-entry-controls">
        <el-date-picker v-model="quickDate" :clearable="false" type="date" value-format="YYYY-MM-DD" placeholder="选择归属日期" @change="clearQuickPreview" />
        <el-button type="primary" plain :loading="quickLoading" @click="previewQuickEntry">解析并预览</el-button>
      </div>
      <el-input
        v-model="quickText"
        type="textarea"
        :rows="12"
        resize="vertical"
        class="quick-entry-textarea"
        placeholder="将表格直接粘贴在这里，例如：\n1\t鹅太公烧鹅（保利上城店）\t销售收入\t堂食/外带\t+4,259.11"
        @input="clearQuickPreview"
      />
      <template v-if="quickPreviewRows.length || quickErrors.length">
        <div class="quick-preview-head">
          <div><b>{{ quickPreviewRows.length }}</b> 条可录入数据 <span v-if="quickErrors.length" class="error-count">· {{ quickErrors.length }} 处问题</span></div>
          <span>合计 {{ formatAmount(quickPreviewTotal) }}</span>
        </div>
        <el-alert v-if="quickErrors.length" type="error" :closable="false" show-icon>
          <template #title>请修正以下内容后重新解析</template>
          <ul class="quick-error-list"><li v-for="(error, index) in quickErrors" :key="index">第 {{ error.line || '—' }} 行：{{ error.message }}</li></ul>
        </el-alert>
        <el-table :data="quickPreviewRows" max-height="260" size="small" stripe class="quick-preview-table">
          <el-table-column prop="line" label="行" width="70" />
          <el-table-column prop="store_name" label="门店" min-width="210" show-overflow-tooltip />
          <el-table-column prop="category_name" label="大类" min-width="140" />
          <el-table-column prop="subcategory_name" label="小类" min-width="160" />
          <el-table-column label="金额" width="140" align="right"><template #default="{ row }"><span :class="amountClass(row.amount)">{{ formatAmount(row.amount) }}</span></template></el-table-column>
        </el-table>
      </template>
      <template #footer>
        <el-button @click="quickEntryVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!quickPreviewRows.length || quickErrors.length" :loading="quickSubmitting" @click="commitQuickEntry">确认录入 {{ quickPreviewRows.length }} 条</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { getBookkeepingEntries, deleteBookkeepingEntry, batchDeleteBookkeepingEntries, getBookkeepingCategories, getBookkeepingSubcategories, getStores, previewBookkeepingQuickEntry, commitBookkeepingQuickEntry } from '@/api'
import { useAuthStore } from '@/stores/auth'
import BookkeepingHeader from './BookkeepingHeader.vue'
import StoreRegionSelect from '@/components/StoreRegionSelect.vue'

const authStore = useAuthStore()

const maxThumbs = 3

const canSelectStore = computed(() => !authStore.user?.store_id)
const selectedStoreLabel = computed(() => {
  if (!canSelectStore.value) return authStore.user?.store_name || '当前门店'
  if (!filters.store_ids.length) return '全部门店'
  if (filters.store_ids.length === 1) return stores.value.find(store => store.id === filters.store_ids[0])?.store_name || '单店'
  return `已选 ${filters.store_ids.length} 家门店`
})

const mode = ref('detail')
const loading = ref(false)
const entries = ref([])
const selectedEntries = ref([])
const summaryRows = ref([])
const categories = ref([])
const subcategories = ref([])
const stores = ref([])
const recordTotal = ref(0)
const detailPage = ref(1)
const detailPageSize = ref(50)
const quickEntryVisible = ref(false)
const quickText = ref('')
const quickDate = ref(new Date().toISOString().slice(0, 10))
const quickPreviewRows = ref([])
const quickErrors = ref([])
const quickLoading = ref(false)
const quickSubmitting = ref(false)

const filters = reactive({
  date_from: '',
  date_to: '',
  category_id: null,
  subcategory_id: null,
  store_ids: []
})

const sumAmount = computed(() =>
  entries.value.reduce((acc, e) => acc + (Number(e.amount) || 0), 0)
)

const sumSummaryAmount = computed(() =>
  summaryRows.value.reduce((acc, r) => acc + (Number(r.total_amount) || 0), 0)
)

const quickPreviewTotal = computed(() =>
  quickPreviewRows.value.reduce((total, row) => total + (Number(row.amount) || 0), 0)
)

function formatAmount(value) {
  const n = Number(value) || 0
  return `¥${n.toFixed(2)}`
}

function amountClass(value) {
  return Number(value) >= 0 ? 'amount-income' : 'amount-expense'
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
  if (filters.subcategory_id != null && filters.subcategory_id !== '') {
    params.subcategory_id = filters.subcategory_id
  }
  if (canSelectStore.value && filters.store_ids.length) {
    params.store_ids = filters.store_ids.join(',')
  } else if (authStore.user?.store_id != null) {
    params.store_id = authStore.user.store_id
  }
  if (mode.value === 'summary') params.aggregate = 'summary'
  else {
    params.page = detailPage.value
    params.page_size = detailPageSize.value
  }
  return params
}

async function loadData() {
  loading.value = true
  selectedEntries.value = []
  try {
    if (mode.value === 'summary') {
      const data = await getBookkeepingEntries(buildParams())
      summaryRows.value = data?.rows || []
      entries.value = []
      recordTotal.value = summaryRows.value.length
    } else {
      const data = await getBookkeepingEntries(buildParams())
      entries.value = data?.entries || []
      summaryRows.value = []
      recordTotal.value = Number(data?.total) || 0
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

async function loadSubcategories() {
  if (!filters.category_id) {
    subcategories.value = []
    return
  }
  try {
    const data = await getBookkeepingSubcategories({ category_id: filters.category_id })
    subcategories.value = data?.subcategories || []
  } catch (e) {
    subcategories.value = []
    ElMessage.error('加载子分类失败')
  }
}

async function loadStores() {
  if (!canSelectStore.value) return
  try {
    const data = await getStores({ page: 1, page_size: 200 })
    stores.value = data?.stores || []
  } catch (e) {
    ElMessage.error('加载门店列表失败')
  }
}

function handleFilter() {
  detailPage.value = 1
  loadData()
}

async function handleCategoryChange() {
  filters.subcategory_id = null
  await loadSubcategories()
  handleFilter()
}

function resetFilters() {
  filters.date_from = ''
  filters.date_to = ''
  filters.category_id = null
  filters.subcategory_id = null
  subcategories.value = []
  filters.store_ids = []
  detailPage.value = 1
  loadData()
}

function handleDetailPageSizeChange() {
  detailPage.value = 1
  loadData()
}

function openQuickEntry() {
  quickText.value = ''
  quickPreviewRows.value = []
  quickErrors.value = []
  quickEntryVisible.value = true
}

function clearQuickPreview() {
  quickPreviewRows.value = []
  quickErrors.value = []
}

async function previewQuickEntry() {
  if (!quickDate.value) return ElMessage.warning('请选择归属日期')
  if (!quickText.value.trim()) return ElMessage.warning('请先粘贴数据')
  quickLoading.value = true
  try {
    const data = await previewBookkeepingQuickEntry({ text: quickText.value })
    quickPreviewRows.value = data?.rows || []
    quickErrors.value = data?.errors || []
    if (quickErrors.value.length) ElMessage.warning('发现数据问题，请修正后重新解析')
    else ElMessage.success(`已解析 ${quickPreviewRows.value.length} 条数据`)
  } catch (error) {
    ElMessage.error(error.message || '解析失败')
  } finally { quickLoading.value = false }
}

async function commitQuickEntry() {
  quickSubmitting.value = true
  try {
    const data = await commitBookkeepingQuickEntry({ date: quickDate.value, text: quickText.value })
    ElMessage.success(`已录入 ${data?.inserted || quickPreviewRows.value.length} 条数据`)
    quickEntryVisible.value = false
    await Promise.all([loadCategories(), loadData()])
  } catch (error) {
    const duplicates = error?.response?.data?.duplicates
    if (error?.response?.status === 409 && duplicates?.length) {
      const hit = duplicates[0]
      try {
        await ElMessageBox.confirm(
          `检测到 ${duplicates.length} 条与已有记账重复，例如 ${hit.date} ${hit.store_name || ''} ${hit.category_name || ''} / ${hit.subcategory_name || ''} 金额 ${Number(hit.amount).toFixed(2)}。确认仍要录入吗？`,
          '重复记录提示',
          { type: 'warning', confirmButtonText: '仍要录入', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' }
        )
      } catch { return }
      quickSubmitting.value = true
      try {
        const data2 = await commitBookkeepingQuickEntry({ date: quickDate.value, text: quickText.value, force: true })
        ElMessage.success(`已录入 ${data2?.inserted || quickPreviewRows.value.length} 条数据`)
        quickEntryVisible.value = false
        await Promise.all([loadCategories(), loadData()])
      } catch (e2) {
        ElMessage.error(e2?.response?.data?.message || e2?.message || '录入失败')
      } finally { quickSubmitting.value = false }
    } else {
      ElMessage.error(error?.response?.data?.message || error?.message || '录入失败')
    }
  } finally { quickSubmitting.value = false }
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

function onSelectionChange(rows) { selectedEntries.value = rows || [] }

async function handleBatchDelete() {
  const ids = (selectedEntries.value || []).map(row => row.id).filter(Boolean)
  if (!ids.length) return
  try {
    await ElMessageBox.confirm(
      `确定删除所选 ${ids.length} 条记账记录吗？此操作不可恢复。`,
      '批量删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' }
    )
  } catch { return }
  try {
    const res = await batchDeleteBookkeepingEntries(ids)
    ElMessage.success(`已删除 ${res.deleted || ids.length} 条记录`)
    selectedEntries.value = []
    loadData()
  } catch (e) {
    ElMessage.error(e?.response?.data?.message || e?.message || '批量删除失败')
  }
}

watch(mode, () => {
  detailPage.value = 1
  loadData()
})

onMounted(() => {
  loadCategories()
  loadStores()
  loadData()
})
</script>

<style scoped>
.bookkeeping-records {
  padding: 16px;
}

.records-overview {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}

.overview-label,
.records-overview strong,
.records-overview small {
  display: block;
}

.overview-label {
  color: #8a97a8;
  font-size: 11px;
}

.records-overview strong {
  margin-top: 4px;
  color: #1f3653;
  font-size: 17px;
}

.records-overview small {
  margin-top: 5px;
  color: #8a97a8;
  font-size: 11px;
}

.overview-count {
  padding: 6px 10px;
  border-radius: 16px;
  background: #eef5ff;
  color: #3d76bb;
  font-size: 12px;
  white-space: nowrap;
}

.records-card {
  border-radius: 8px;
  margin-bottom: 16px;
}

.filters {
  display: grid;
  grid-template-columns: minmax(400px, 1.45fr) minmax(200px, .9fr) 165px 165px 205px auto;
  align-items: flex-end;
  gap: 12px;
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid #edf0f4;
}

.filter-field {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.date-filter { min-width: 300px; }

.date-range { display: flex; min-width: 0; align-items: center; gap: 8px; }
.date-range :deep(.el-date-editor) { min-width: 0; flex: 1; }

.filter-label {
  font-size: 13px;
  color: #606266;
  white-space: nowrap;
}

.filter-sep {
  color: #909399;
}

.filter-actions {
  justify-content: flex-end;
  white-space: nowrap;
}

.view-filter :deep(.el-radio-group) { display: inline-flex; height: 34px; flex: 0 0 auto; flex-wrap: nowrap; vertical-align: middle; }
.view-filter :deep(.el-radio-button) { display: flex; }
.view-filter :deep(.el-radio-button__inner) { display: flex; min-height: 34px; align-items: center; padding: 0 13px; border-color: #d9e2ef; color: #61708a; font-size: 13px; font-weight: 500; line-height: 1; white-space: nowrap; box-shadow: none; }
.view-filter :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) { border-color: #2f6fed; background: #2f6fed; color: #fff; box-shadow: -1px 0 0 0 #2f6fed; }

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

.amount-income { color: #16865a; }
.amount-expense { color: #d65262; }

.records-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 14px;
  color: #7f8999;
  font-size: 12px;
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

.quick-entry-lead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
  color: #61708a;
  font-size: 13px;
  line-height: 1.6;
}

.quick-entry-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.quick-entry-textarea :deep(textarea) {
  font-family: Consolas, "Microsoft YaHei", monospace;
  font-size: 13px;
  line-height: 1.65;
  background: #fafcff;
}

.quick-preview-head {
  display: flex;
  justify-content: space-between;
  margin: 18px 0 10px;
  color: #65738a;
  font-size: 13px;
}

.quick-preview-head b { color: #2168c5; font-size: 16px; }
.error-count { color: #d65262; }
.quick-error-list { margin: 6px 0 0; padding-left: 18px; line-height: 1.8; }
.quick-preview-table { margin-top: 12px; border: 1px solid #edf1f7; border-radius: 8px; overflow: hidden; }

@media (max-width: 1280px) {
  .filters { grid-template-columns: minmax(300px, 1.4fr) repeat(2, minmax(160px, 1fr)); }
  .filter-actions { justify-content: flex-start; }
}

@media (max-width: 760px) {
  .filters { grid-template-columns: 1fr; }
  .filter-field, .date-range { align-items: stretch; flex-wrap: wrap; }
  .date-range { width: 100%; }
  .date-range :deep(.el-date-editor) { min-width: 130px; }
  .records-overview, .records-pagination { align-items: flex-start; flex-direction: column; }
  .quick-entry-lead, .quick-entry-controls, .quick-preview-head { align-items: flex-start; flex-direction: column; }
}
</style>
