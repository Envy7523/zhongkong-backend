<template>
  <div class="menu-module-page">
    <MenuModuleHeader
      title="菜品效期管理"
      description="集中维护菜品保质期，优先处理短效期和未配置项目。"
      active="menu-management-expiry"
      :metrics="heroMetrics"
    />

    <section class="metric-strip">
      <div class="metric-card"><span>极短效期</span><strong>{{ criticalCount }}</strong><small>3 天以内</small></div>
      <div class="metric-card"><span>短效期</span><strong>{{ warningCount }}</strong><small>4–7 天</small></div>
      <div class="metric-card"><span>常规效期</span><strong>{{ normalCount }}</strong><small>超过 7 天</small></div>
      <div class="metric-card"><span>待完善</span><strong>{{ unsetCount }}</strong><small>尚未设置保质期</small></div>
    </section>

    <section class="menu-panel">
      <header class="menu-panel-header">
        <div class="menu-panel-title"><h3>效期档案</h3><span>按风险等级排序，短效期菜品优先显示</span></div>
        <div class="menu-filters">
          <el-input v-model="search" clearable placeholder="搜索菜品名称" class="wide-filter" />
          <el-select v-model="categoryFilter" clearable placeholder="全部分类">
            <el-option v-for="category in categories" :key="category" :label="category" :value="category" />
          </el-select>
          <el-select v-model="riskFilter" clearable placeholder="全部效期">
            <el-option label="3 天以内" value="critical" />
            <el-option label="4–7 天" value="warning" />
            <el-option label="7 天以上" value="normal" />
            <el-option label="未设置" value="unset" />
          </el-select>
        </div>
      </header>

      <el-table v-loading="loading" :data="paginatedItems" class="menu-data-table" row-key="id">
        <el-table-column label="菜品" min-width="220">
          <template #default="{ row }">
            <div class="dish-name"><span class="dish-monogram">{{ String(row.name || '菜').slice(0,1) }}</span><div><b>{{ row.name }}</b><small>{{ row.method && row.method !== '/' ? row.method : '标准做法' }}</small></div></div>
          </template>
        </el-table-column>
        <el-table-column label="分类" min-width="140">
          <template #default="{ row }"><span class="menu-category">{{ row.category || '未分类' }}</span></template>
        </el-table-column>
        <el-table-column label="规格" min-width="130">
          <template #default="{ row }">{{ specification(row) }}</template>
        </el-table-column>
        <el-table-column label="保质期" width="130" align="center">
          <template #default="{ row }">
            <span :class="['expiry-pill', expiryTone(row.expiry_days)]">
              {{ row.expiry_days ? `${row.expiry_days} 天` : '未设置' }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="风险等级" width="120">
          <template #default="{ row }">
            <div :class="['risk-label', expiryTone(row.expiry_days)]"><i></i>{{ expiryLabel(row.expiry_days) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="销售状态" width="100" align="center">
          <template #default="{ row }"><span :class="['status-pill', row.status === '停售' ? 'off' : 'on']">{{ row.status || '在售' }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="105" fixed="right" align="right">
          <template #default="{ row }"><el-button link type="primary" @click="openDialog(row)">设置效期</el-button></template>
        </el-table-column>
      </el-table>
      <div v-if="!loading && !filteredItems.length" class="menu-empty">没有符合条件的菜品</div>
      <footer class="menu-pagination-footer">
        <span>共 {{ totalItems }} 个菜品 · 建议优先完善未设置效期的菜品</span>
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50]"
          :total="totalItems"
          layout="total, sizes, prev, pager, next"
          background
        />
      </footer>
    </section>

    <el-dialog v-model="dialogVisible" title="设置菜品效期" width="470px" align-center class="menu-dialog">
      <div v-if="editingItem" class="expiry-dialog-summary">
        <span class="dish-monogram">{{ String(editingItem.name || '菜').slice(0,1) }}</span>
        <div><b>{{ editingItem.name }}</b><small>{{ specification(editingItem) }}</small></div>
      </div>
      <el-form label-position="top">
        <el-form-item label="保质期（天）">
          <el-input-number v-model="expiryDays" :min="0" :max="365" style="width:100%;" />
        </el-form-item>
        <el-form-item label="销售状态">
          <el-segmented v-model="saleStatus" :options="['在售', '停售']" />
        </el-form-item>
        <div :class="['expiry-preview', expiryTone(expiryDays)]">
          <span>当前效期等级</span><strong>{{ expiryLabel(expiryDays) }}</strong>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveExpiry">保存设置</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { getMenuItems, updateMenuItem } from '@/api'
import { ElMessage } from 'element-plus'
import MenuModuleHeader from './MenuModuleHeader.vue'
import { useMenuPagination } from './useMenuPagination'
import './menu-theme.css'

const items = ref([])
const loading = ref(false)
const saving = ref(false)
const search = ref('')
const categoryFilter = ref('')
const riskFilter = ref('')
const dialogVisible = ref(false)
const editingItem = ref(null)
const expiryDays = ref(0)
const saleStatus = ref('在售')

const categories = computed(() => [...new Set(items.value.map(item => item.category).filter(Boolean))].sort())
function riskGroup(days) {
  const value = Number(days) || 0
  if (!value) return 'unset'
  if (value <= 3) return 'critical'
  if (value <= 7) return 'warning'
  return 'normal'
}
function expiryTone(days) { return riskGroup(days) }
function expiryLabel(days) {
  return { critical: '极短效期', warning: '短效期', normal: '常规效期', unset: '待完善' }[riskGroup(days)]
}
function specification(row) {
  const parts = [row.spec_unit, row.spec_weight].filter(Boolean)
  return parts.length ? parts.join(' / ') : '未设置规格'
}
const sortedItems = computed(() => [...items.value].sort((a, b) => {
  const rank = { critical: 0, warning: 1, unset: 2, normal: 3 }
  const groupDiff = rank[riskGroup(a.expiry_days)] - rank[riskGroup(b.expiry_days)]
  if (groupDiff) return groupDiff
  return (Number(a.expiry_days) || 9999) - (Number(b.expiry_days) || 9999)
}))
const filteredItems = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return sortedItems.value.filter(item => {
    if (keyword && !String(item.name || '').toLowerCase().includes(keyword)) return false
    if (categoryFilter.value && item.category !== categoryFilter.value) return false
    if (riskFilter.value && riskGroup(item.expiry_days) !== riskFilter.value) return false
    return true
  })
})
const { currentPage, pageSize, totalItems, paginatedItems } = useMenuPagination(filteredItems)
const criticalCount = computed(() => items.value.filter(item => riskGroup(item.expiry_days) === 'critical').length)
const warningCount = computed(() => items.value.filter(item => riskGroup(item.expiry_days) === 'warning').length)
const normalCount = computed(() => items.value.filter(item => riskGroup(item.expiry_days) === 'normal').length)
const unsetCount = computed(() => items.value.filter(item => riskGroup(item.expiry_days) === 'unset').length)
const heroMetrics = computed(() => [
  { label: '短效期预警', value: criticalCount.value + warningCount.value, tone: criticalCount.value ? 'danger' : 'warning' },
  { label: '待完善', value: unsetCount.value, tone: unsetCount.value ? 'warning' : 'success' },
])
function openDialog(row) {
  editingItem.value = row
  expiryDays.value = Number(row.expiry_days) || 0
  saleStatus.value = row.status || '在售'
  dialogVisible.value = true
}
async function saveExpiry() {
  saving.value = true
  try {
    await updateMenuItem(editingItem.value.id, {
      expiry_days: expiryDays.value || null,
      status: saleStatus.value,
    })
    dialogVisible.value = false
    await loadData()
    ElMessage.success('效期设置已更新')
  } catch (error) { ElMessage.error('保存失败：' + error.message) }
  finally { saving.value = false }
}
async function loadData() {
  loading.value = true
  try {
    const data = await getMenuItems({ page: 1, page_size: 500 })
    items.value = data.items || []
  } catch (error) { ElMessage.error('加载失败：' + error.message) }
  finally { loading.value = false }
}
onMounted(loadData)
</script>

<style scoped>
.expiry-pill {
  display: inline-block;
  min-width: 58px;
  padding: 5px 9px;
  border-radius: 14px;
  font-size: 12px;
  font-weight: 650;
}
.expiry-pill.critical { color: #ca4744; background: #fff0ef; }
.expiry-pill.warning { color: #bd772a; background: #fff5e7; }
.expiry-pill.normal { color: #218767; background: #eaf8f3; }
.expiry-pill.unset { color: #7f8999; background: #f0f2f5; }
.risk-label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #7f8999;
  font-size: 12px;
}
.risk-label i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.risk-label.critical { color: #d95350; }
.risk-label.warning { color: #d98a2e; }
.risk-label.normal { color: #269473; }
.expiry-dialog-summary {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-bottom: 18px;
  padding: 12px;
  border: 1px solid #e7eaf0;
  border-radius: 11px;
  background: #f8f9fb;
}
.expiry-dialog-summary b,
.expiry-dialog-summary small { display: block; }
.expiry-dialog-summary b { color: #344054; font-size: 14px; }
.expiry-dialog-summary small { margin-top: 3px; color: #7f899a; font-size: 11px; }
.expiry-preview {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px 12px;
  border-radius: 9px;
  color: #7d8797;
  background: #f3f5f8;
  font-size: 12px;
}
.expiry-preview.critical strong { color: #ca4744; }
.expiry-preview.warning strong { color: #bd772a; }
.expiry-preview.normal strong { color: #218767; }
</style>
