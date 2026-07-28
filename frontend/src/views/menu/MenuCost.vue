<template>
  <div class="menu-module-page">
    <MenuModuleHeader
      title="菜品成本分析"
      description="对比菜品成本与渠道售价，快速识别低毛利和异常定价。"
      active="menu-management-cost"
      :metrics="heroMetrics"
    />

    <section class="metric-strip">
      <div class="metric-card"><span>平均单份成本</span><strong>¥{{ avgCost }}</strong><small>全部有效成本菜品</small></div>
      <div class="metric-card"><span>平均堂食毛利</span><strong>{{ avgMargin }}%</strong><small>堂食价格口径</small></div>
      <div class="metric-card"><span>健康毛利菜品</span><strong>{{ healthyCount }}</strong><small>毛利率 ≥ 60%</small></div>
      <div class="metric-card"><span>低毛利预警</span><strong>{{ riskCount }}</strong><small>毛利率低于 40%</small></div>
    </section>

    <section class="menu-panel">
      <header class="menu-panel-header">
        <div class="menu-panel-title"><h3>成本与毛利</h3><span>按渠道比较实际毛利表现</span></div>
        <div class="menu-filters">
          <el-input v-model="search" clearable placeholder="搜索菜品名称" class="wide-filter" />
          <el-select v-model="categoryFilter" clearable placeholder="全部分类">
            <el-option v-for="category in categories" :key="category" :label="category" :value="category" />
          </el-select>
          <el-select v-model="marginFilter" clearable placeholder="全部毛利">
            <el-option label="健康（≥60%）" value="healthy" />
            <el-option label="关注（40%-59%）" value="medium" />
            <el-option label="预警（<40%）" value="risk" />
          </el-select>
        </div>
      </header>

      <el-table v-loading="loading" :data="paginatedItems" class="menu-data-table" row-key="id">
        <el-table-column label="菜品" min-width="200">
          <template #default="{ row }">
            <div class="dish-name"><span class="dish-monogram">{{ String(row.name || '菜').slice(0,1) }}</span><div><b>{{ row.name }}</b><small>{{ row.category || '未分类' }}</small></div></div>
          </template>
        </el-table-column>
        <el-table-column label="单份成本" width="115" align="right">
          <template #default="{ row }"><span class="menu-price">¥{{ money(row.cost) }}</span></template>
        </el-table-column>
        <el-table-column label="堂食价" width="100" align="right">
          <template #default="{ row }"><span class="menu-price">¥{{ money(row.dine_in_price || row.price) }}</span></template>
        </el-table-column>
        <el-table-column label="堂食毛利" min-width="145">
          <template #default="{ row }"><MarginCell :value="margin(row, 'dine_in_price')" /></template>
        </el-table-column>
        <el-table-column label="会员毛利" min-width="145">
          <template #default="{ row }"><MarginCell :value="margin(row, 'member_price')" /></template>
        </el-table-column>
        <el-table-column label="外卖毛利" min-width="145">
          <template #default="{ row }"><MarginCell :value="margin(row, 'takeout_price')" /></template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right" align="right">
          <template #default="{ row }"><el-button link type="primary" @click="openCostDialog(row)">调整成本</el-button></template>
        </el-table-column>
      </el-table>
      <div v-if="!loading && !filteredItems.length" class="menu-empty">没有符合条件的菜品</div>
      <footer class="menu-pagination-footer">
        <span>共 {{ totalItems }} 个菜品 · 毛利率 =（售价 - 成本）/ 售价</span>
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

    <el-dialog v-model="dialogVisible" title="调整菜品成本" width="460px" align-center class="menu-dialog">
      <div v-if="editingItem" class="cost-dialog-summary">
        <span class="dish-monogram">{{ String(editingItem.name || '菜').slice(0,1) }}</span>
        <div><b>{{ editingItem.name }}</b><small>当前堂食价 ¥{{ money(editingItem.dine_in_price || editingItem.price) }}</small></div>
      </div>
      <el-form label-position="top">
        <el-form-item label="单份成本">
          <el-input-number v-model="costValue" :min="0" :precision="2" :controls="false" style="width:100%;" />
        </el-form-item>
        <div class="cost-preview">
          调整后堂食毛利率
          <strong :class="marginTone(previewMargin)">{{ previewMargin }}%</strong>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveCost">保存成本</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, defineComponent, h, onMounted, ref } from 'vue'
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
const marginFilter = ref('')
const dialogVisible = ref(false)
const editingItem = ref(null)
const costValue = ref(0)

function margin(row, field) {
  const price = Number(row[field] || (field === 'dine_in_price' ? row.price : 0)) || 0
  const cost = Number(row.cost) || 0
  return price > 0 ? Math.round(((price - cost) / price) * 100) : 0
}
function marginTone(value) {
  if (value >= 60) return 'good'
  if (value >= 40) return 'medium'
  return 'low'
}
const MarginCell = defineComponent({
  props: { value: { type: Number, default: 0 } },
  setup(props) {
    return () => h('div', { class: ['margin-value', marginTone(props.value)] }, [
      h('span', `${props.value}%`),
      h('div', { class: 'margin-track' }, [h('i', { style: { width: `${Math.max(0, Math.min(100, props.value))}%` } })]),
    ])
  },
})
const categories = computed(() => [...new Set(items.value.map(item => item.category).filter(Boolean))].sort())
const filteredItems = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return items.value.filter(item => {
    if (keyword && !String(item.name || '').toLowerCase().includes(keyword)) return false
    if (categoryFilter.value && item.category !== categoryFilter.value) return false
    const value = margin(item, 'dine_in_price')
    if (marginFilter.value === 'healthy' && value < 60) return false
    if (marginFilter.value === 'medium' && (value < 40 || value >= 60)) return false
    if (marginFilter.value === 'risk' && value >= 40) return false
    return true
  })
})
const { currentPage, pageSize, totalItems, paginatedItems } = useMenuPagination(filteredItems)
const avgCost = computed(() => {
  const values = items.value.map(item => Number(item.cost) || 0).filter(Boolean)
  return values.length ? (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2) : '0.00'
})
const avgMargin = computed(() => items.value.length ? Math.round(items.value.reduce((sum, item) => sum + margin(item, 'dine_in_price'), 0) / items.value.length) : 0)
const healthyCount = computed(() => items.value.filter(item => margin(item, 'dine_in_price') >= 60).length)
const riskCount = computed(() => items.value.filter(item => margin(item, 'dine_in_price') < 40).length)
const heroMetrics = computed(() => [
  { label: '平均毛利', value: `${avgMargin.value}%`, tone: avgMargin.value >= 60 ? 'success' : 'warning' },
  { label: '预警菜品', value: riskCount.value, tone: riskCount.value ? 'danger' : 'success' },
])
const previewMargin = computed(() => {
  if (!editingItem.value) return 0
  const price = Number(editingItem.value.dine_in_price || editingItem.value.price) || 0
  return price > 0 ? Math.round(((price - costValue.value) / price) * 100) : 0
})
function money(value) { return (Number(value) || 0).toFixed(2) }
function openCostDialog(row) {
  editingItem.value = row
  costValue.value = Number(row.cost) || 0
  dialogVisible.value = true
}
async function saveCost() {
  saving.value = true
  try {
    await updateMenuItem(editingItem.value.id, { cost: costValue.value })
    dialogVisible.value = false
    await loadData()
    ElMessage.success('菜品成本已更新')
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
.cost-dialog-summary {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-bottom: 18px;
  padding: 12px;
  border: 1px solid #e7eaf0;
  border-radius: 11px;
  background: #f8f9fb;
}
.cost-dialog-summary b,
.cost-dialog-summary small { display: block; }
.cost-dialog-summary b { color: #344054; font-size: 14px; }
.cost-dialog-summary small { margin-top: 3px; color: #7f899a; font-size: 11px; }
.cost-preview {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px 12px;
  border-radius: 9px;
  background: #f3f5f8;
  color: #7d8797;
  font-size: 12px;
}
.cost-preview strong { font-size: 17px; }
</style>
