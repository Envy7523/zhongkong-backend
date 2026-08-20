<template>
  <div class="menu-module-page">
    <MenuModuleHeader
      title="菜品成本管理"
      description="按材料明细核算单份成本，并联动渠道售价分析毛利表现。"
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
        <div class="menu-panel-title"><h3>成本构成与毛利</h3><span>维护材料明细，按渠道比较实际毛利表现</span></div>
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
          <template #default="{ row }">
            <div class="cost-cell"><span class="menu-price">¥{{ money(row.cost) }}</span><small>{{ row.cost_component_count ? `${row.cost_component_count} 项构成` : '待拆分' }}</small></div>
          </template>
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
          <template #default="{ row }"><el-button link type="primary" @click="openCostDialog(row)">成本明细</el-button></template>
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

    <el-dialog v-model="dialogVisible" title="录入菜品成本构成" width="min(920px, calc(100vw - 32px))" align-center class="menu-dialog cost-builder-dialog">
      <div v-if="editingItem" class="cost-dialog-summary">
        <span class="dish-monogram">{{ String(editingItem.name || '菜').slice(0,1) }}</span>
        <div><b>{{ editingItem.name }}</b><small>{{ editingItem.category || '未分类' }} · 当前堂食价 ¥{{ money(editingItem.dine_in_price || editingItem.price) }}</small></div>
        <div class="current-cost"><small>当前成本</small><strong>¥{{ money(editingItem.cost) }}</strong></div>
      </div>
      <div class="cost-builder" v-loading="componentLoading">
        <div class="builder-heading">
          <div><b>材料明细</b><small>每项小计 = 用量 × 单位成本，总和自动成为该菜品单份成本。</small></div>
          <el-button plain type="primary" @click="addComponent">+ 添加材料</el-button>
        </div>
        <div class="component-table" role="table" aria-label="菜品材料成本明细">
          <div class="component-row component-header" role="row">
            <span>材料名称</span><span>用量</span><span>单位</span><span>单位成本</span><span>小计</span><span></span>
          </div>
          <div v-for="(component, index) in costComponents" :key="component.localId" class="component-row" role="row">
            <el-input v-model="component.ingredient_name" :placeholder="index === 0 ? '如：烧鹅肉' : '材料名称'" maxlength="40" />
            <el-input-number v-model="component.quantity" :min="0.001" :precision="3" :controls="false" />
            <el-select v-model="component.unit" filterable allow-create default-first-option>
              <el-option v-for="unit in materialUnits" :key="unit" :label="unit" :value="unit" />
            </el-select>
            <el-input-number v-model="component.unit_cost" :min="0" :precision="4" :controls="false" />
            <strong class="component-subtotal">¥{{ money(componentSubtotal(component)) }}</strong>
            <el-button link type="danger" :disabled="costComponents.length === 1" @click="removeComponent(index)">删除</el-button>
          </div>
        </div>
        <div v-if="!componentLoading && !costComponents.length" class="component-empty">尚未添加材料明细</div>
        <div class="cost-preview-grid">
          <div><span>材料项</span><strong>{{ costComponents.length }}</strong></div>
          <div><span>单份总成本</span><strong class="total-cost">¥{{ money(costValue) }}</strong></div>
          <div><span>调整后堂食毛利率</span><strong :class="marginTone(previewMargin)">{{ previewMargin }}%</strong></div>
        </div>
      </div>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="componentLoading" @click="saveCost">保存成本明细</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, defineComponent, h, onMounted, ref } from 'vue'
import { getMenuCostComponents, getMenuItems, saveMenuCostComponents } from '@/api'
import { ElMessage } from 'element-plus'
import MenuModuleHeader from './MenuModuleHeader.vue'
import { useMenuPagination } from './useMenuPagination'
import './menu-theme.css'

const items = ref([])
const loading = ref(false)
const saving = ref(false)
const componentLoading = ref(false)
const search = ref('')
const categoryFilter = ref('')
const marginFilter = ref('')
const dialogVisible = ref(false)
const editingItem = ref(null)
const costComponents = ref([])
const materialUnits = ['克', '千克', '个', '只', '份', '片', '毫升', '升', '勺', '包']
let componentSeed = 0

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
const costValue = computed(() => Math.round(costComponents.value.reduce((sum, component) => sum + componentSubtotal(component), 0) * 100) / 100)
const previewMargin = computed(() => {
  if (!editingItem.value) return 0
  const price = Number(editingItem.value.dine_in_price || editingItem.value.price) || 0
  return price > 0 ? Math.round(((price - costValue.value) / price) * 100) : 0
})
function money(value) { return (Number(value) || 0).toFixed(2) }
function newComponent(values = {}) {
  return { localId: ++componentSeed, ingredient_name: '', quantity: 1, unit: '份', unit_cost: 0, ...values }
}
function componentSubtotal(component) {
  return Math.round((Number(component.quantity) || 0) * (Number(component.unit_cost) || 0) * 100) / 100
}
function addComponent() { costComponents.value.push(newComponent()) }
function removeComponent(index) { if (costComponents.value.length > 1) costComponents.value.splice(index, 1) }
async function openCostDialog(row) {
  editingItem.value = row
  dialogVisible.value = true
  componentLoading.value = true
  try {
    const result = await getMenuCostComponents(row.id)
    costComponents.value = (result.components || []).map(component => newComponent({
      ingredient_name: component.ingredient_name,
      quantity: Number(component.quantity) || 1,
      unit: component.unit || '份',
      unit_cost: Number(component.unit_cost) || 0,
    }))
    if (!costComponents.value.length) {
      const legacyCost = Number(row.cost) || 0
      costComponents.value = [newComponent({ ingredient_name: legacyCost ? '现有单份成本（待拆分）' : '', quantity: 1, unit: '份', unit_cost: legacyCost })]
    }
  } catch (error) {
    ElMessage.error('成本明细加载失败：' + error.message)
    dialogVisible.value = false
  } finally { componentLoading.value = false }
}
async function saveCost() {
  const invalidIndex = costComponents.value.findIndex(component => !component.ingredient_name.trim() || Number(component.quantity) <= 0 || Number(component.unit_cost) < 0)
  if (invalidIndex >= 0) {
    ElMessage.warning(`请完整填写第 ${invalidIndex + 1} 条材料明细`)
    return
  }
  saving.value = true
  try {
    await saveMenuCostComponents(editingItem.value.id, costComponents.value.map(component => ({
      ingredient_name: component.ingredient_name.trim(),
      quantity: Number(component.quantity),
      unit: component.unit,
      unit_cost: Number(component.unit_cost),
    })))
    dialogVisible.value = false
    await loadData()
    ElMessage.success('成本明细与总成本已更新')
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
.current-cost{margin-left:auto;text-align:right}.current-cost strong{display:block;margin-top:3px;color:#263247;font-size:18px}
.cost-cell{display:flex;align-items:flex-end;flex-direction:column}.cost-cell small{margin-top:3px;color:#98a2b3;font-size:9px}
.cost-builder{min-height:260px}.builder-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px}.builder-heading b,.builder-heading small{display:block}.builder-heading b{color:#344054;font-size:13px}.builder-heading small{margin-top:4px;color:#8a94a6;font-size:10px}
.component-table{overflow:hidden;border:1px solid #e5e9f0;border-radius:12px;background:#fff}.component-row{display:grid;grid-template-columns:minmax(180px,1.6fr) 110px 105px 130px 100px 54px;align-items:center;gap:9px;padding:9px 11px;border-top:1px solid #edf0f4}.component-row:first-child{border-top:0}.component-header{padding-top:8px;padding-bottom:8px;background:#f7f9fc;color:#8490a3;font-size:10px;font-weight:700}.component-row :deep(.el-input-number){width:100%}.component-subtotal{color:#263247;text-align:right;font-size:12px}.component-empty{padding:38px;text-align:center;color:#98a2b3;font-size:12px}
.cost-preview-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:13px}.cost-preview-grid>div{padding:12px 14px;border-radius:10px;background:#f3f5f8}.cost-preview-grid span,.cost-preview-grid strong{display:block}.cost-preview-grid span{color:#7d8797;font-size:10px}.cost-preview-grid strong{margin-top:5px;font-size:17px}.cost-preview-grid .total-cost{color:#2563b8}
@media(max-width:760px){.component-table{overflow-x:auto}.component-row{min-width:760px}.cost-preview-grid{grid-template-columns:1fr}.builder-heading{align-items:flex-start;flex-direction:column}.builder-heading :deep(.el-button){width:100%}}
</style>
