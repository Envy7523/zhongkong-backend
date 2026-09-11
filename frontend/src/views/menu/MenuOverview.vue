<template>
  <div class="menu-module-page">
    <MenuModuleHeader
      title="菜品档案库"
      description="统一维护菜品、规格与销售价格；每一条规格档案都是平台绑定和经营分析的唯一依据。"
      active="menu-management-overview"
      :metrics="heroMetrics"
    />

    <section class="metric-strip menu-health-strip">
      <div class="metric-card metric-main"><span>全部菜品</span><strong>{{ items.length }}</strong><small>{{ categories.length }} 个分类 · {{ comboCount }} 个套餐</small></div>
      <div class="metric-card"><span>在售档案</span><strong class="metric-success">{{ activeCount }}</strong><small>当前可用于销售和绑定</small></div>
      <div class="metric-card"><span>多规格菜品</span><strong class="metric-success">{{ multiSpecDishCount }}</strong><small>同菜品下维护 2 个及以上规格</small></div>
      <div class="metric-card"><span>标准规格</span><strong :class="specMissingCount ? 'metric-warning' : 'metric-success'">{{ specMissingCount }}</strong><small>尚未细分规格的菜品</small></div>
    </section>

    <section class="menu-panel">
      <header class="menu-panel-header">
        <div class="menu-panel-title menu-archive-title">
          <div>
            <h3>菜品档案</h3>
            <span>名称与规格是各平台菜品绑定和销售分析的唯一依据</span>
          </div>
        </div>
        <div class="menu-filters">
          <el-input v-model="search" clearable placeholder="搜索菜品名称、做法、SKU" class="wide-filter" @keyup.enter="currentPage = 1" />
          <el-select v-model="categoryFilter" clearable placeholder="全部分类">
            <el-option v-for="category in categories" :key="category" :label="category" :value="category" />
          </el-select>
          <el-segmented v-model="statusFilter" :options="statusOptions" class="archive-status-switch" />
          <el-button plain @click="resetFilters">重置</el-button>
          <el-button :loading="loading" @click="loadData">刷新</el-button><el-button type="primary" @click="openCreateDialog">＋ 新增菜品</el-button>
        </div>
      </header>

      <el-table v-loading="loading" :data="paginatedItems" class="menu-data-table grouped-menu-table" row-key="id" @expand-change="loadRowExpansion">
        <el-table-column type="expand" width="46">
          <template #default="{ row }">
            <div v-if="row.isGroup" class="variant-detail-panel">
              <div class="variant-detail-heading"><span>规格明细</span><small>{{ row.variants.length }} 个独立规格，各自对应 SKU 与销售价格</small></div>
              <div v-for="variant in row.variants" :key="variant.id" class="variant-detail-row">
                <b>{{ specification(variant) }}</b><span>SKU：{{ variant.skuid || '未设置' }}</span><span>堂食 ¥{{ formatPrice(variant.dine_in_price || variant.price) }}</span><span>会员 ¥{{ formatPrice(variant.member_price) }}</span>
                <el-button link type="primary" @click="openEditDialog(variant)">编辑该规格</el-button>
              </div>
            </div>
            <div v-else-if="row.item_type === 'combo'" class="combo-detail-panel" v-loading="comboExpandLoading[row.id]">
              <template v-if="comboExpansion[row.id]">
                <div class="variant-detail-heading"><span>套餐内容</span><small>固定组成与按规则可选的菜品</small></div>
                <div v-if="fixedComboComponents(row).length" class="combo-detail-section"><b>固定组成</b><span v-for="component in fixedComboComponents(row)" :key="component.id" class="combo-detail-chip">{{ componentLabel(component) }} × {{ component.quantity }}</span></div>
                <div v-for="group in choiceComboGroups(row)" :key="group.id" class="combo-detail-section choice"><b>{{ choiceGroupRuleLabel(group) }}</b><span v-for="component in group.items" :key="component.id" class="combo-detail-chip choice-chip">{{ componentLabel(component) }} × {{ component.quantity }}</span></div>
                <div v-if="!comboExpansion[row.id].length" class="variant-detail-single">尚未配置套餐内容。</div>
              </template>
              <div v-else class="variant-detail-single">展开后加载套餐内容…</div>
            </div>
            <div v-else class="variant-detail-single">当前菜品仅有一个规格，可通过“编辑”直接添加更多规格。</div>
          </template>
        </el-table-column>
        <el-table-column label="菜品" min-width="230">
          <template #default="{ row }"><div class="dish-name"><span :class="['dish-monogram', row.item_type === 'combo' ? 'combo-avatar' : '']">{{ dishLetter(row) }}</span><div><b>{{ row.name }}</b><small>{{ row.isGroup ? `${row.variants.length} 个规格 · 点击左侧展开查看` : (row.method && row.method !== '/' ? row.method : '标准做法') }}</small></div></div></template>
        </el-table-column>
        <el-table-column label="分类 / SKU" min-width="170"><template #default="{ row }"><span class="menu-category">{{ row.category || '未分类' }}</span><small class="sku-code">{{ row.isGroup ? `${row.variants.length} 个独立 SKU` : (row.skuid || '未设置 SKU') }}</small></template></el-table-column>
        <el-table-column label="规格" min-width="220"><template #default="{ row }"><div v-if="row.isGroup" class="spec-chip-list"><span v-for="variant in row.variants.slice(0, 4)" :key="variant.id" class="spec-chip">{{ specification(variant) }}</span><span v-if="row.variants.length > 4" class="spec-chip muted">+{{ row.variants.length - 4 }}</span></div><span v-else>{{ specification(row) }}</span></template></el-table-column>
        <el-table-column label="类型" width="86" align="center"><template #default="{ row }"><span :class="['type-pill', row.item_type === 'combo' ? 'combo' : 'dish']">{{ row.item_type === 'combo' ? '套餐' : '菜品' }}</span></template></el-table-column>
        <el-table-column label="销售价格" min-width="175" align="right"><template #default="{ row }"><div class="price-stack"><span>堂食 <b>{{ groupPrice(row, 'dine') }}</b></span><span>会员 <b>{{ groupPrice(row, 'member') }}</b></span></div></template></el-table-column>
        <el-table-column label="状态" width="100" align="center"><template #default="{ row }"><span :class="['status-pill', statusLabel(row) === '停售' ? 'off' : 'on']">{{ statusLabel(row) }}</span></template></el-table-column>
        <el-table-column label="操作" width="145" fixed="right" align="right"><template #default="{ row }"><div class="row-actions"><el-button link type="primary" @click="openEditDialog(row)">编辑</el-button><el-button link type="danger" @click="removeItem(row)">删除</el-button></div></template></el-table-column>
      </el-table>
      <div v-if="!loading && groupedItems.length === 0" class="menu-empty">没有符合条件的菜品</div>
      <footer class="menu-pagination-footer">
        <span>筛选结果 {{ totalItems }} 个菜品组 / {{ filteredItems.length }} 个规格档案</span>
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

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑菜品档案' : '新增菜品档案'" width="min(820px, calc(100vw - 32px))" align-center class="menu-dialog menu-item-dialog">
      <el-form label-position="top">
        <div class="form-section-label">基础档案</div>
        <div class="form-grid">
          <el-form-item label="菜品名称" required><el-input v-model="form.name" maxlength="50" placeholder="例如：招牌烧鹅、烧鹅濑粉" /></el-form-item>
          <el-form-item label="菜品分类" required><el-select v-model="form.category" filterable allow-create placeholder="选择或输入分类" style="width:100%;"><el-option v-for="category in categories" :key="category" :label="category" :value="category" /></el-select></el-form-item>
        </div>
        <div class="form-grid form-grid-type">
          <el-form-item label="类型"><el-segmented v-model="form.item_type" :options="[{ label: '菜品', value: 'dish' }, { label: '套餐', value: 'combo' }]" /></el-form-item>
          <el-form-item label="销售状态"><el-segmented v-model="form.status" :options="[{ label: '在售', value: '在售' }, { label: '停售', value: '停售' }]" /></el-form-item>
          <el-form-item v-if="form.item_type === 'dish'" label="做法"><el-input v-model="form.method" placeholder="例如：切件、不切" /></el-form-item>
        </div>

        <section v-if="form.item_type === 'dish'" class="variant-builder">
          <div class="variant-builder-heading"><div><b>规格与价格</b><small>同一菜品可在此直接维护多个规格；每个规格都有独立 SKU、堂食价和会员价。</small></div><el-button type="primary" plain @click="addVariant">＋ 添加规格</el-button></div>
          <div class="variant-row variant-header"><span>规格名称</span><span>菜品编码（SKU）</span><span>堂食价</span><span>会员价</span><span></span></div>
          <div v-for="(variant, index) in form.variants" :key="variant.localKey" class="variant-row">
            <el-input v-model="variant.spec" maxlength="40" :placeholder="index === 0 ? '例如：上庄、烧鹅濑粉' : '规格名称'" />
            <el-input v-model="variant.skuid" placeholder="选填" />
            <el-input-number v-model="variant.dine_in_price" :min="0" :precision="2" :controls="false" />
            <el-input-number v-model="variant.member_price" :min="0" :precision="2" :controls="false" />
            <el-button link type="danger" :disabled="form.variants.length === 1" @click="removeVariant(index)">移除</el-button>
          </div>
          <p class="variant-builder-note">例如：招牌烧鹅可录入“上庄”和“下庄”；烧鹅濑粉可录入“烧鹅濑粉”和“烧鹅面”。保存后分别作为独立规格参与绑定与成本核算。</p>
        </section>

        <section v-else class="combo-builder combo-builder-first">
          <div class="combo-builder-heading"><div><b>固定组成（1 + 1）</b><small>这些菜品会固定包含在套餐中。</small></div><el-button type="primary" plain @click="addComponent">＋ 添加固定菜品</el-button></div>
          <div v-if="!form.components.length" class="combo-component-empty">尚未添加固定组成菜品。</div>
          <div v-for="(comp, index) in form.components" :key="`fixed-${index}`" class="combo-component-row">
            <div class="component-order">{{ index + 1 }}</div>
            <template v-if="comp.menu_item_id || !comp.ingredient_name"><el-tree-select v-model="comp.menu_item_id" :data="componentTreeOptions" filterable check-strictly default-expand-all :render-after-expand="false" node-key="value" :props="treeSelectProps" placeholder="按分类、菜品、规格选择" class="component-picker" @change="() => syncComponent(comp)" /></template>
            <template v-else><div class="legacy-component"><b>{{ comp.ingredient_name || '未选择菜品' }}</b><small>该组成项由成本分析维护</small></div></template>
            <el-input-number v-model="comp.quantity" :min="0.5" :step="0.5" :precision="1" controls-position="right" class="component-quantity" />
            <span class="component-unit">份</span><el-button link type="danger" @click="removeComponent(index)">移除</el-button>
          </div>

          <div class="choice-groups-heading"><div><b>任选菜品（可配置单选或多选）</b><small>为每一组设定顾客最少和最多可选数量，例如 4 选 2 或 4 选 3。</small></div><el-button plain type="primary" @click="addChoiceGroup">＋ 添加选择组</el-button></div>
          <div v-if="!form.choiceGroups.length" class="choice-groups-empty">暂无任选菜品配置；如套餐可选米饭或面，可添加一个选择组并设置可选数量。</div>
          <div v-for="(group, groupIndex) in form.choiceGroups" :key="group.id" class="choice-group-card">
            <div class="choice-group-card-head"><div><b>选择组 {{ groupIndex + 1 }}</b><small>{{ choiceRuleLabel(group) }}</small></div><div class="choice-rule-controls"><span>顾客可选</span><el-input-number v-model="group.min_select" :min="1" :max="group.options.length" :precision="0" controls-position="right" @change="normalizeChoiceRule(group, 'min')" /><span>至</span><el-input-number v-model="group.max_select" :min="1" :max="group.options.length" :precision="0" controls-position="right" @change="normalizeChoiceRule(group, 'max')" /><span>项</span><el-button link type="danger" @click="removeChoiceGroup(groupIndex)">删除选择组</el-button></div></div>
            <div v-for="(option, optionIndex) in group.options" :key="option.localKey" class="combo-component-row choice-option-row">
              <div class="choice-marker">选</div>
              <el-tree-select v-model="option.menu_item_id" :data="componentTreeOptions" filterable check-strictly default-expand-all :render-after-expand="false" node-key="value" :props="treeSelectProps" placeholder="选择可替换菜品或规格" class="component-picker" @change="() => syncComponent(option)" />
              <el-input-number v-model="option.quantity" :min="0.5" :step="0.5" :precision="1" controls-position="right" class="component-quantity" />
              <span class="component-unit">份</span><el-button link type="danger" :disabled="group.options.length <= 2" @click="removeChoiceOption(groupIndex, optionIndex)">移除</el-button>
            </div>
            <el-button link type="primary" class="add-choice-option" @click="addChoiceOption(groupIndex)">＋ 添加备选菜品</el-button>
          </div>
        </section>

        <div v-if="form.item_type === 'combo'" class="form-section-label">套餐销售价格</div>
        <div v-if="form.item_type === 'combo'" class="form-grid price-form-grid"><el-form-item label="堂食价"><el-input-number v-model="form.dine_in_price" :min="0" :precision="2" :controls="false" style="width:100%;" /></el-form-item><el-form-item label="会员价"><el-input-number v-model="form.member_price" :min="0" :precision="2" :controls="false" style="width:100%;" /></el-form-item></div>
        <p v-if="form.item_type === 'combo'" class="cost-edit-note">外卖价格由平台商品绑定和平台数据管理；成本请在「成本分析」维护。</p>
      </el-form>
      <template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveItem">{{ form.item_type === 'combo' ? '保存套餐' : '保存菜品' }}</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  createMenuItem,
  deleteMenuItem,
  deleteMenuCostComponents,
  getMenuCostComponents,
  getMenuCategories,
  getMenuItems,
  saveMenuCostComponents,
  updateMenuItem,
} from '@/api'
import { ElMessage, ElMessageBox } from 'element-plus'
import MenuModuleHeader from './MenuModuleHeader.vue'
import { useMenuPagination } from './useMenuPagination'
import './menu-theme.css'

const route = useRoute()
const items = ref([])
const categoryNames = ref([])
const loading = ref(false)
const saving = ref(false)
const search = ref('')
const categoryFilter = ref('')
const statusFilter = ref('')
const dialogVisible = ref(false)
const editingId = ref(null)
const hadComponents = ref(false)
const comboExpansion = ref({})
const comboExpandLoading = ref({})

let variantSequence = 0
function newVariant(data = {}) {
  variantSequence += 1
  return {
    localKey: data.localKey || `variant-${variantSequence}`,
    sourceId: data.sourceId || null,
    spec: data.spec || '',
    skuid: data.skuid || '',
    dine_in_price: Number(data.dine_in_price) || 0,
    member_price: Number(data.member_price) || 0,
  }
}
const emptyForm = () => ({
  name: '', category: '', method: '', spec_unit: '份', spec_weight: '',
  dine_in_price: 0, member_price: 0,
  status: '在售', item_type: 'dish', components: [], choiceGroups: [], variants: [newVariant()], removedVariantIds: [],
})
const form = ref(emptyForm())
const treeSelectProps = { value: 'value', label: 'label', children: 'children', disabled: 'disabled' }

const categories = computed(() => {
  const used = [...new Set(items.value.map(item => item.category).filter(Boolean))]
  const managed = categoryNames.value.filter(name => used.includes(name) || name)
  return [...managed, ...used.filter(name => !managed.includes(name))]
})
const categoryRank = computed(() => new Map(categories.value.map((name, index) => [name, index])))
const activeCount = computed(() => items.value.filter(item => (item.status || '在售') === '在售').length)
const comboCount = computed(() => items.value.filter(item => item.item_type === 'combo').length)
const specMissingCount = computed(() => items.value.filter(item => (item.status || '在售') === '在售' && specification(item) === '标准规格').length)
const multiSpecDishCount = computed(() => {
  const grouped = new Map()
  items.value.filter(item => item.item_type !== 'combo').forEach(item => {
    const key = `${item.category || ''}::${item.name || ''}`
    grouped.set(key, (grouped.get(key) || 0) + 1)
  })
  return [...grouped.values()].filter(count => count > 1).length
})
const statusOptions = [{ label: '全部', value: '' }, { label: '在售', value: '在售' }, { label: '停售', value: '停售' }]
const filteredItems = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return items.value.filter(item => {
    const searchable = [item.name, item.method, item.spec, item.skuid, item.category].join(' ').toLowerCase()
    if (keyword && !searchable.includes(keyword)) return false
    if (categoryFilter.value && item.category !== categoryFilter.value) return false
    if (statusFilter.value && (item.status || '在售') !== statusFilter.value) return false
    return true
  })
})
const heroMetrics = computed(() => [
  { label: '在售菜品', value: activeCount.value, tone: 'success' },
  { label: '多规格', value: multiSpecDishCount.value, tone: 'success' },
])
const groupedItems = computed(() => {
  const groups = new Map()
  filteredItems.value.forEach(item => {
    const key = item.item_type === 'combo' ? `combo:${item.id}` : `dish:${item.category || ''}:${item.name || ''}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  })
  return [...groups.values()].map(variants => {
    const ordered = [...variants].sort((a, b) => specification(a).localeCompare(specification(b), 'zh-CN'))
    const primary = ordered[0]
    return {
      ...primary,
      id: ordered.length > 1 ? `group:${primary.category || ''}:${primary.name}` : primary.id,
      representative: primary,
      variants: ordered,
      isGroup: ordered.length > 1,
    }
  })
})
const { currentPage, pageSize, totalItems, paginatedItems } = useMenuPagination(groupedItems)

function resetFilters() {
  search.value = ''
  categoryFilter.value = ''
  statusFilter.value = ''
  currentPage.value = 1
}
function formatPrice(value) { return (Number(value) || 0).toFixed(2) }
function dishLetter(row) {
  const cleanName = String(row.name || '')
    .replace(/^\s*[【\[].*?[】\]]\s*/, '')
    .replace(/^\s*套餐\s*[·：:]?\s*/, '')
  return (cleanName.match(/[\u4e00-\u9fffA-Za-z0-9]/) || ['菜'])[0]
}
function specification(row) {
  const spec = String(row.spec || '').trim()
  if (spec && !['标准', '常规', '份'].includes(spec)) return spec
  const weight = String(row.spec_weight || '').trim()
  return weight || '标准规格'
}
function statusLabel(row) {
  const statuses = (row.variants || [row]).map(item => item.status || '在售')
  if (new Set(statuses).size === 1) return statuses[0]
  return '部分停售'
}
function groupPrice(row, field) {
  const values = (row.variants || [row]).map(item => Number(field === 'dine' ? (item.dine_in_price || item.price) : item.member_price) || 0)
  const min = Math.min(...values), max = Math.max(...values)
  return min === max ? `¥${formatPrice(min)}` : `¥${formatPrice(min)}–${formatPrice(max)}`
}
function openCreateDialog() {
  editingId.value = null
  hadComponents.value = false
  form.value = emptyForm()
  dialogVisible.value = true
}
function addVariant() { form.value.variants.push(newVariant()) }
function removeVariant(index) {
  if (form.value.variants.length <= 1) return
  const removed = form.value.variants[index]
  if (removed?.sourceId) form.value.removedVariantIds.push(removed.sourceId)
  form.value.variants.splice(index, 1)
}
const componentOptions = computed(() => items.value
  .filter(item => (item.status || '在售') === '在售' && Number(item.id) !== Number(editingId.value))
  .map(item => ({
    id: item.id,
    label: `${item.name}${specification(item) !== '标准规格' ? ` · ${specification(item)}` : ''}${item.item_type === 'combo' ? '（套餐）' : ''}`,
    name: item.name,
    category: item.category || '未分类',
    spec: specification(item),
    dineInPrice: Number(item.dine_in_price || item.price) || 0,
    cost: Number(item.cost) || 0,
  }))
  .sort((a, b) => (categoryRank.value.get(a.category) ?? 999999) - (categoryRank.value.get(b.category) ?? 999999) || a.name.localeCompare(b.name, 'zh-CN') || a.spec.localeCompare(b.spec, 'zh-CN')))
const componentTreeOptions = computed(() => {
  const categoryMap = new Map()
  componentOptions.value.forEach(option => {
    if (!categoryMap.has(option.category)) categoryMap.set(option.category, new Map())
    const dishMap = categoryMap.get(option.category)
    if (!dishMap.has(option.name)) dishMap.set(option.name, [])
    dishMap.get(option.name).push(option)
  })
  return [...categoryMap.entries()].map(([category, dishMap]) => ({
    value: `category:${category}`,
    label: category,
    disabled: true,
    children: [...dishMap.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN')).map(([name, options]) => ({
      value: `dish:${category}:${name}`,
      label: `${name}（${options.length} 个规格）`,
      disabled: true,
      children: options.map(option => ({
        value: option.id,
        label: `${option.name} · ${option.spec} · 堂食 ¥${formatPrice(option.dineInPrice)}`,
      })),
    })),
  }))
})
function syncComponent(comp) {
  const src = componentOptions.value.find(o => Number(o.id) === Number(comp.menu_item_id))
  comp.ingredient_name = src ? src.name : (comp.ingredient_name || '')
  comp.unit_cost = src ? src.cost : (comp.unit_cost || 0)
}
function newChoiceOption() { return { localKey: `choice-${Date.now()}-${Math.random()}`, menu_item_id: null, ingredient_name: '', unit_cost: 0, quantity: 1 } }
function addComponent() {
  form.value.components.push({ menu_item_id: null, ingredient_name: '', unit_cost: 0, quantity: 1 })
}
function removeComponent(index) { form.value.components.splice(index, 1) }
function addChoiceGroup() {
  form.value.choiceGroups.push({ id: `choice-group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, min_select: 1, max_select: 1, options: [newChoiceOption(), newChoiceOption()] })
}
function removeChoiceGroup(index) { form.value.choiceGroups.splice(index, 1) }
function addChoiceOption(groupIndex) {
  const group = form.value.choiceGroups[groupIndex]
  group.options.push(newChoiceOption())
  normalizeChoiceRule(group)
}
function removeChoiceOption(groupIndex, optionIndex) {
  const group = form.value.choiceGroups[groupIndex]
  if (group.options.length <= 2) return
  group.options.splice(optionIndex, 1)
  normalizeChoiceRule(group)
}
function normalizeChoiceRule(group, changed = '') {
  const count = Math.max(1, group.options.length)
  let min = Math.min(count, Math.max(1, Math.floor(Number(group.min_select) || 1)))
  let max = Math.min(count, Math.max(1, Math.floor(Number(group.max_select) || 1)))
  if (changed === 'min' && max < min) max = min
  if (changed === 'max' && min > max) min = max
  group.min_select = min
  group.max_select = max
}
function choiceRuleLabel(group) {
  const count = (group.options || []).length
  const min = Math.max(1, Number(group.min_select) || 1)
  const max = Math.max(min, Number(group.max_select) || min)
  return min === max ? `从以下 ${count} 个菜品中选 ${min} 项` : `从以下 ${count} 个菜品中可选 ${min} 至 ${max} 项`
}
function choiceGroupRuleLabel(group) {
  const min = Math.max(1, Number(group.min_select) || 1)
  const max = Math.max(min, Number(group.max_select) || min)
  return min === max ? `任选 ${min} 项` : `任选 ${min} 至 ${max} 项`
}
function componentLabel(component) {
  const name = component.component_name || component.ingredient_name || '未命名菜品'
  const spec = String(component.component_spec || '').trim()
  return spec && !['标准', '常规', '份'].includes(spec) ? `${name} · ${spec}` : name
}
function fixedComboComponents(row) {
  return (comboExpansion.value[row.id] || []).filter(component => !component.choice_group)
}
function choiceComboGroups(row) {
  const groups = new Map()
  ;(comboExpansion.value[row.id] || []).filter(component => component.choice_group).forEach(component => {
    if (!groups.has(component.choice_group)) groups.set(component.choice_group, [])
    groups.get(component.choice_group).push(component)
  })
  return [...groups.entries()].map(([id, items]) => ({ id, items, min_select: Number(items[0]?.choice_min) || 1, max_select: Number(items[0]?.choice_max) || Number(items[0]?.choice_min) || 1 }))
}
async function loadRowExpansion(row, expandedRows) {
  if (row.item_type !== 'combo' || !expandedRows.some(item => item.id === row.id) || comboExpansion.value[row.id]) return
  comboExpandLoading.value = { ...comboExpandLoading.value, [row.id]: true }
  try {
    const result = await getMenuCostComponents(row.id)
    comboExpansion.value = { ...comboExpansion.value, [row.id]: result.components || [] }
  } catch (error) {
    ElMessage.error('套餐内容加载失败：' + error.message)
  } finally {
    comboExpandLoading.value = { ...comboExpandLoading.value, [row.id]: false }
  }
}
async function loadComponents(itemId) {
  hadComponents.value = false
  try {
    const comps = (await getMenuCostComponents(itemId)).components || []
    hadComponents.value = comps.length > 0
    const groups = new Map()
    form.value.components = comps.filter(c => !c.choice_group).map(c => ({
      menu_item_id: c.component_menu_item_id || null, ingredient_name: c.ingredient_name || '',
      unit_cost: Number(c.unit_cost) || 0, quantity: Number(c.quantity) || 1,
    }))
    comps.filter(c => c.choice_group).forEach(c => {
      if (!groups.has(c.choice_group)) groups.set(c.choice_group, [])
      groups.get(c.choice_group).push({
        localKey: `choice-${c.id}`, menu_item_id: c.component_menu_item_id || null,
        ingredient_name: c.ingredient_name || '', unit_cost: Number(c.unit_cost) || 0, quantity: Number(c.quantity) || 1,
      })
    })
    form.value.choiceGroups = [...groups.entries()].map(([id, options]) => ({ id, min_select: Number(options[0]?.choice_min) || 1, max_select: Number(options[0]?.choice_max) || Number(options[0]?.choice_min) || 1, options }))
  } catch (error) {
    ElMessage.error('套餐构成加载失败：' + error.message)
  }
}
function openEditDialog(row) {
  const source = row.representative || row
  const isCombo = source.item_type === 'combo'
  const sameDishVariants = isCombo ? [] : items.value.filter(item =>
    item.item_type !== 'combo' && item.name === source.name && item.category === source.category
  )
  editingId.value = source.id
  form.value = {
    name: source.name || '',
    category: source.category || '',
    method: source.method || '',
    spec_unit: source.spec_unit || '份',
    spec_weight: source.spec_weight || '',
    dine_in_price: Number(source.dine_in_price || source.price) || 0,
    member_price: Number(source.member_price) || 0,
    status: source.status || '在售',
    item_type: isCombo ? 'combo' : 'dish',
    components: [],
    choiceGroups: [],
    variants: isCombo ? [] : (sameDishVariants.length ? sameDishVariants : [row]).map(item => newVariant({
      sourceId: item.id, spec: item.spec, skuid: item.skuid,
      dine_in_price: item.dine_in_price || item.price, member_price: item.member_price,
    })),
    removedVariantIds: [],
  }
  dialogVisible.value = true
  if (isCombo) loadComponents(source.id)
}
function menuPayload(variant = null) {
  const f = form.value
  const pricing = variant || f
  return {
    name: f.name.trim(),
    category: f.category,
    method: f.item_type === 'dish' ? (f.method || '') : '',
    spec: f.item_type === 'dish' ? (pricing.spec || '') : '',
    skuid: String(f.item_type === 'dish' ? (pricing.skuid || '') : '').trim(),
    price: Number(pricing.dine_in_price) || 0,
    dine_in_price: Number(pricing.dine_in_price) || 0,
    member_price: Number(pricing.member_price) || 0,
    spec_unit: f.spec_unit || '份',
    spec_weight: f.spec_weight || '',
    status: f.status || '在售',
    item_type: f.item_type === 'combo' ? 'combo' : 'dish',
  }
}
async function saveItem() {
  if (!form.value.name.trim() || !form.value.category.trim()) {
    ElMessage.warning('请填写菜品名称和分类')
    return
  }
  const validComps = (form.value.components || []).filter(c => Number(c.quantity) > 0 && (c.menu_item_id || c.ingredient_name))
  const choiceGroups = (form.value.choiceGroups || []).map(group => ({
    ...group,
    options: (group.options || []).filter(option => Number(option.quantity) > 0 && (option.menu_item_id || option.ingredient_name)),
  }))
  if (form.value.item_type === 'dish' && !form.value.variants.length) {
    ElMessage.warning('请至少保留一个菜品规格')
    return
  }
  if (form.value.item_type === 'combo' && !validComps.length && !choiceGroups.length) {
    ElMessage.warning('请添加固定组成或任选其一的选择组')
    return
  }
  if (form.value.item_type === 'combo' && choiceGroups.some(group => group.options.length < 2)) {
    ElMessage.warning('每个任选菜品组至少需要 2 个选项')
    return
  }
  if (form.value.item_type === 'combo') {
    for (const group of choiceGroups) {
      normalizeChoiceRule(group)
      if (group.min_select > group.options.length || group.max_select > group.options.length || group.min_select > group.max_select) {
        ElMessage.warning('请检查选择组的最少和最多可选数量')
        return
      }
    }
  }
  saving.value = true
  try {
    if (form.value.item_type === 'dish') {
      for (const variant of form.value.variants) {
        const payload = menuPayload(variant)
        if (variant.sourceId) await updateMenuItem(variant.sourceId, payload)
        else variant.sourceId = (await createMenuItem(payload)).id
      }
      for (const id of form.value.removedVariantIds) await deleteMenuItem(id)
    } else {
      const payload = menuPayload()
      let id = editingId.value
      if (id) await updateMenuItem(id, payload)
      else id = (await createMenuItem(payload)).id
      const componentPayload = [
        ...validComps.map(c => ({
          component_menu_item_id: c.menu_item_id || null, ingredient_name: c.ingredient_name || '',
          unit_cost: Number(c.unit_cost) || 0, quantity: Number(c.quantity) || 1, unit: '份', choice_group: '',
        })),
        ...choiceGroups.flatMap(group => group.options.map(option => ({
          component_menu_item_id: option.menu_item_id || null, ingredient_name: option.ingredient_name || '',
          unit_cost: Number(option.unit_cost) || 0, quantity: Number(option.quantity) || 1, unit: '份', choice_group: group.id, choice_min: group.min_select, choice_max: group.max_select,
        }))),
      ]
      await saveMenuCostComponents(id, componentPayload)
      hadComponents.value = true
    }
    dialogVisible.value = false
    editingId.value = null
    await loadData()
    ElMessage.success(form.value.item_type === 'combo' ? '套餐构成已保存，成本请在成本分析中维护' : `已保存 ${form.value.variants.length} 个规格`)
  } catch (error) {
    ElMessage.error('保存失败：' + error.message)
  } finally { saving.value = false }
}
async function removeItem(row) {
  const targets = row.variants || [row]
  const targetText = row.isGroup ? `「${row.name}」及其 ${targets.length} 个规格` : `「${row.name}」`
  try {
    await ElMessageBox.confirm(`确定删除${targetText}？`, '删除菜品', { type: 'warning', confirmButtonText: '确认删除' })
    for (const target of targets) await deleteMenuItem(target.id)
    await loadData()
    ElMessage.success(row.isGroup ? '菜品及其规格已删除' : '菜品已删除')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error('删除失败：' + error.message)
  }
}
async function loadData() {
  loading.value = true
  try {
    const [data, categoryData] = await Promise.all([
      getMenuItems({ page: 1, page_size: 500 }),
      getMenuCategories(),
    ])
    items.value = data.items || []
    categoryNames.value = categoryData.categories || []
    await nextTick()
    openRequestedMenuItem()
  } catch (error) {
    ElMessage.error('加载失败：' + error.message)
  } finally { loading.value = false }
}
function openRequestedMenuItem() {
  const menuItemId = Number(route.query.menu_item_id)
  if (!menuItemId) return
  const item = items.value.find(row => Number(row.id) === menuItemId)
  if (!item) return
  search.value = item.name || ''
  categoryFilter.value = item.category || ''
  statusFilter.value = ''
  currentPage.value = 1
  openEditDialog(item)
}
const refreshMenuCategoryOrder = () => loadData()
onMounted(() => {
  window.addEventListener('menu-category-order-changed', refreshMenuCategoryOrder)
  loadData()
})
watch(() => route.query.menu_item_id, () => {
  if (items.value.length) openRequestedMenuItem()
})
onBeforeUnmount(() => window.removeEventListener('menu-category-order-changed', refreshMenuCategoryOrder))
</script>

<style scoped>
.type-pill { display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 650; }
.type-pill.dish { background: #eef4ff; color: #3164c8; }
.type-pill.combo { background: #fff1df; color: #b86910; }
.dish-monogram.combo-avatar { background: linear-gradient(135deg, #fff2df, #ffe3bd); color: #b8670c; }
.price-stack { grid-template-columns: repeat(2, auto); }
.spec-chip-list { display: flex; flex-wrap: wrap; gap: 6px; }
.spec-chip { padding: 4px 8px; border-radius: 5px; background: #f0f5ff; color: #3d66ae; font-size: 12px; }
.spec-chip.muted { background: #f4f6f9; color: #7d899b; }
.variant-detail-panel { padding: 12px 18px 14px 48px; background: #fbfcff; }
.variant-detail-heading { display: flex; gap: 9px; align-items: baseline; margin-bottom: 9px; color: #274b81; font-size: 13px; font-weight: 700; }
.variant-detail-heading small { color: #8492a7; font-size: 11px; font-weight: 400; }
.variant-detail-row { display: grid; grid-template-columns: minmax(90px, 1fr) minmax(130px, 1.2fr) 125px 125px auto; gap: 12px; align-items: center; padding: 9px 12px; border: 1px solid #e9eef7; border-radius: 7px; background: #fff; color: #65758d; font-size: 12px; }
.variant-detail-row + .variant-detail-row { margin-top: 7px; }
.variant-detail-row b { color: #263d62; font-size: 13px; }
.variant-detail-single { padding: 12px 18px 12px 48px; color: #8794a7; font-size: 12px; background: #fbfcff; }
.combo-detail-panel { padding: 12px 18px 14px 48px; background: #fbfcff; }
.combo-detail-section { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
.combo-detail-section > b { min-width: 60px; color: #3a557e; font-size: 12px; }
.combo-detail-chip { padding: 5px 9px; border-radius: 5px; background: #edf4ff; color: #3e638f; font-size: 12px; }
.combo-detail-section.choice > b { color: #6746bd; }
.combo-detail-chip.choice-chip { background: #f1edff; color: #6746bd; }
.grouped-menu-table :deep(.el-table__expand-icon) { color: #3f6fd0; }
.cost-cell { font-variant-numeric: tabular-nums; color: #344054; }
.cost-cell i { margin-top: 2px; font-style: normal; font-size: 11px; color: #98a2b3; }
.spec-guidance { display: flex; gap: 9px; margin: -1px 0 16px; padding: 10px 12px; border: 1px solid #dbe8ff; border-radius: 8px; background: #f6f9ff; color: #64748b; font-size: 12px; line-height: 1.65; }
.spec-guidance b { flex: 0 0 auto; color: #2764ca; }
.cost-edit-note { margin: -4px 0 18px; color: #8592a7; font-size: 12px; }
.price-form-grid { max-width: 500px; }
.variant-builder { margin-top: 4px; padding: 16px; border: 1px solid #d7e5fb; border-radius: 10px; background: linear-gradient(145deg, #f8fbff, #fff); }
.variant-builder-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding-bottom: 12px; border-bottom: 1px solid #e8eef7; }
.variant-builder-heading b, .variant-builder-heading small { display: block; }
.variant-builder-heading b { color: #1c3c6b; font-size: 14px; }
.variant-builder-heading small { margin-top: 4px; color: #7787a0; font-size: 12px; }
.variant-row { display: grid; grid-template-columns: 1.25fr 1.25fr .75fr .75fr auto; gap: 9px; align-items: center; padding: 10px 0; border-bottom: 1px solid #eef2f7; }
.variant-row:last-of-type { border-bottom: 0; }
.variant-row :deep(.el-input-number) { width: 100%; }
.variant-header { padding: 10px 0 7px; color: #7888a1; font-size: 11px; font-weight: 650; }
.variant-builder-note { margin: 11px 0 0; color: #74839b; font-size: 12px; line-height: 1.55; }
.combo-builder-first { margin-top: 4px; }
.combo-builder { margin-top: 4px; padding: 16px; border: 1px solid #d9e5f7; border-radius: 10px; background: linear-gradient(145deg, #f9fbff, #fff); }
.combo-builder-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding-bottom: 13px; border-bottom: 1px solid #e8eef7; }
.combo-builder-heading b, .combo-builder-heading small { display: block; }
.combo-builder-heading b { color: #1c3c6b; font-size: 14px; }
.combo-builder-heading small { max-width: 455px; margin-top: 5px; color: #7787a0; font-size: 12px; line-height: 1.5; }
.combo-component-empty { padding: 20px 12px; color: #8794a9; font-size: 12px; text-align: center; }
.combo-component-row { display: grid; grid-template-columns: 26px minmax(0, 1fr) 118px 24px auto; align-items: center; gap: 9px; padding: 11px 0; border-bottom: 1px solid #edf1f7; }
.combo-component-row:last-child { border-bottom: 0; }
.choice-groups-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-top: 16px; padding: 15px 0 11px; border-top: 1px dashed #d6e1f0; }
.choice-groups-heading b, .choice-groups-heading small { display: block; }
.choice-groups-heading b { color: #6b46c1; font-size: 14px; }
.choice-groups-heading small { margin-top: 4px; color: #7d8ba1; font-size: 12px; }
.choice-groups-empty { padding: 15px 12px; border: 1px dashed #ddd8f4; border-radius: 8px; color: #8c85a7; font-size: 12px; text-align: center; }
.choice-group-card { margin-top: 10px; padding: 12px 14px; border: 1px solid #ded8fa; border-radius: 9px; background: #fcfbff; }
.choice-group-card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 3px; }
.choice-group-card-head b { color: #5b3ab5; font-size: 13px; }
.choice-group-card-head small { margin-left: 8px; color: #8b84a4; font-size: 11px; }
.choice-rule-controls { display: flex; align-items: center; gap: 6px; color: #6d7890; font-size: 12px; white-space: nowrap; }
.choice-rule-controls :deep(.el-input-number) { width: 78px; }
.choice-rule-controls :deep(.el-input__wrapper) { min-height: 28px; }
.choice-option-row { padding: 8px 0; }
.choice-marker { display: grid; width: 24px; height: 24px; place-items: center; border-radius: 50%; background: #eeeaff; color: #6746bd; font-size: 11px; font-weight: 700; }
.add-choice-option { margin-top: 6px; }
.component-order { display: grid; width: 24px; height: 24px; place-items: center; border-radius: 50%; background: #eaf1ff; color: #376cc9; font-size: 11px; font-weight: 700; }
.component-picker { width: 100%; }
.component-quantity { width: 118px; }
.component-unit { color: #79879e; font-size: 12px; }
.legacy-component { min-width: 0; padding: 7px 10px; border: 1px dashed #d8e1ee; border-radius: 7px; background: #fff; }
.legacy-component b, .legacy-component small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.legacy-component b { color: #53647b; font-size: 12px; }
.legacy-component small { margin-top: 2px; color: #97a3b4; font-size: 11px; }
@media (max-width: 680px) {
  .form-grid-type { grid-template-columns: 1fr; }
  .combo-builder-heading { flex-direction: column; }
  .variant-builder-heading { flex-direction: column; }
  .variant-row { grid-template-columns: 1fr 1fr; }
  .variant-detail-panel { padding-left: 20px; }
  .variant-detail-row { grid-template-columns: 1fr 1fr; }
  .variant-header { display: none; }
.variant-row .el-button { justify-self: end; }
  .choice-group-card-head { align-items: flex-start; gap: 10px; }
  .choice-rule-controls { flex-wrap: wrap; justify-content: flex-end; }
  .combo-component-row { grid-template-columns: 24px minmax(0, 1fr) 90px auto; }
  .component-unit { display: none; }
}
</style>
