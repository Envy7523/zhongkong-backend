<template>
  <div class="menu-module-page">
    <MenuModuleHeader
      title="菜品档案库"
      description="统一维护菜品、规格与销售价格；每一条规格档案都是平台绑定和经营分析的唯一依据。"
      active="menu-management-overview"
      :metrics="heroMetrics"
    />

    <div class="menu-archive-layout">
      <!-- 左：分类栏（点分类即筛右侧明细） -->
      <aside class="menu-category-rail">
        <div class="rail-head">
          <span>菜品分类</span>
          <el-button link type="primary" @click="goCategoryPage">管理分类</el-button>
        </div>
        <button type="button" class="rail-item" :class="{ active: !categoryFilter }" @click="selectCategory('')">
          <span class="rail-name">全部分类</span>
          <span class="rail-count">{{ items.length }}</span>
        </button>
        <button
          v-for="group in categoryStats" :key="group.name" type="button" class="rail-item"
          :class="{ active: categoryFilter === group.name, empty: !group.count }" @click="selectCategory(group.name)"
        >
          <span class="rail-name">{{ group.name }}</span>
          <span class="rail-count">{{ group.count }}</span>
        </button>
        <div class="rail-foot">
          <div><span>在售档案</span><b>{{ activeCount }}</b></div>
          <div><span>多规格菜品</span><b>{{ multiSpecDishCount }}</b></div>
          <div><span>标准规格</span><b :class="{ warn: specMissingCount > 0 }">{{ specMissingCount }}</b></div>
        </div>
      </aside>

      <!-- 右：菜品明细 -->
      <section class="menu-panel menu-archive-panel">
        <header class="menu-panel-header">
          <div class="menu-panel-title menu-archive-title">
            <div>
              <h3>{{ categoryFilter || '全部菜品' }}</h3>
              <span>共 {{ filteredItems.length }} 条规格档案 · 在售 {{ filteredActiveCount }} · 套餐 {{ filteredComboCount }}</span>
            </div>
          </div>
          <div class="menu-filters">
            <el-input v-model="search" clearable placeholder="搜索菜品名称、做法、编码" class="wide-filter" @keyup.enter="currentPage = 1" />
            <el-segmented v-model="statusFilter" :options="statusOptions" class="archive-status-switch" />
            <el-button plain @click="resetFilters">重置</el-button>
            <el-button :loading="loading" @click="loadData">刷新</el-button>
            <el-button type="primary" @click="openCreateDialog">＋ 新增菜品</el-button>
          </div>
        </header>

        <el-table v-loading="loading" :data="paginatedItems" class="menu-data-table archive-flat-table" row-key="id">
          <el-table-column label="序号" width="54" align="center">
            <template #default="{ $index }">{{ rowNumber($index) }}</template>
          </el-table-column>
          <el-table-column label="菜品名称" min-width="200">
            <template #default="{ row }">
              <div class="archive-name-cell">
                <b>{{ row.name }}</b>
                <span v-if="row.item_type !== 'combo' && rowVariants(row).length > 1" class="spec-chip-list">
                  <span v-for="variant in rowVariants(row).slice(0, 3)" :key="variant.id" class="spec-chip">{{ specification(variant) }}</span>
                  <span v-if="rowVariants(row).length > 3" class="spec-chip muted">+{{ rowVariants(row).length - 3 }}</span>
                </span>
                <span v-else-if="row.item_type !== 'combo' && specification(row) !== '标准规格'" class="spec-chip">{{ specification(row) }}</span>
                <span v-else-if="row.item_type === 'combo'" class="spec-chip soft">套餐</span>
                <small v-if="row.method && row.method !== '/'">{{ row.method }}</small>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="菜品分类" min-width="96">
            <template #default="{ row }"><span class="menu-category">{{ row.category || '未分类' }}</span></template>
          </el-table-column>
          <el-table-column label="菜品类型" width="84" align="center">
            <template #default="{ row }"><span :class="['type-pill', row.item_type === 'combo' ? 'combo' : 'dish']">{{ row.item_type === 'combo' ? '套餐' : '普通菜' }}</span></template>
          </el-table-column>
          <el-table-column label="价格" width="106" align="right">
            <template #default="{ row }"><span class="menu-price">{{ groupPrice(row) }}</span></template>
          </el-table-column>
          <el-table-column label="系统菜品编码" width="124">
            <template #default="{ row }"><span class="code-cell">{{ row.spuid || '—' }}</span></template>
          </el-table-column>
          <el-table-column label="系统菜品规格编码" width="126">
            <template #default="{ row }"><span class="code-cell" :title="groupSkuCodeTitle(row)">{{ groupSkuCode(row) }}</span></template>
          </el-table-column>
          <el-table-column label="会员价" width="96" align="right">
            <template #default="{ row }"><span class="menu-price muted">{{ groupPrice(row, 'member') }}</span></template>
          </el-table-column>
          <el-table-column label="菜品状态" width="96" align="center">
            <template #default="{ row }"><span :class="['status-pill', statusLabel(row) === '停售' ? 'off' : (statusLabel(row) === '部分停售' ? 'part' : 'on')]">{{ statusLabel(row) }}</span></template>
          </el-table-column>
          <el-table-column label="操作" width="168" fixed="right" align="right">
            <template #default="{ row }">
              <div class="row-actions">
                <el-button link type="primary" @click="openEditDialog(row)">编辑</el-button>
                <el-button link :type="statusLabel(row) === '停售' ? 'success' : 'warning'" @click="toggleStatus(row)">{{ statusLabel(row) === '停售' ? '开售' : '停售' }}</el-button>
                <el-dropdown trigger="click" @command="command => handleRowCommand(command, row)">
                  <el-button link type="primary">更多<el-icon class="more-caret"><ArrowDown /></el-icon></el-button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item v-if="row.item_type === 'combo'" command="combo">查看套餐内容</el-dropdown-item>
                      <el-dropdown-item v-else-if="rowVariants(row).length > 1" command="specs">查看全部规格（{{ rowVariants(row).length }}）</el-dropdown-item>
                      <el-dropdown-item divided command="delete">删除{{ rowVariants(row).length > 1 ? '整个菜品' : '' }}</el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
            </template>
          </el-table-column>
        </el-table>
        <div v-if="!loading && filteredItems.length === 0" class="menu-empty">没有符合条件的菜品</div>
        <footer class="menu-pagination-footer">
          <span>共 {{ filteredItems.length }} 条记录</span>
          <el-pagination
            v-model:current-page="currentPage"
            v-model:page-size="pageSize"
            :page-sizes="[10, 20, 50, 100]"
            :total="totalItems"
            layout="total, sizes, prev, pager, next"
            background
          />
        </footer>
      </section>
    </div>

    <!-- 「更多」里的查看弹窗：套餐内容 / 同菜品其他规格 -->
    <el-dialog v-model="peekVisible" :title="peekTitle" width="min(760px, calc(100vw - 32px))" align-center class="menu-dialog">
      <div v-if="peekKind === 'combo'" v-loading="peekLoading" class="peek-body">
        <template v-if="peekComboRows">
          <div v-if="fixedComboComponents(peekRow).length" class="combo-detail-section">
            <b>固定组成</b>
            <span v-for="component in fixedComboComponents(peekRow)" :key="component.id" class="combo-detail-chip">{{ componentLabel(component) }} × {{ component.quantity }}</span>
          </div>
          <div v-for="group in choiceComboGroups(peekRow)" :key="group.id" class="combo-detail-section choice">
            <b>{{ choiceGroupRuleLabel(group) }}</b>
            <span v-for="component in group.items" :key="component.id" class="combo-detail-chip choice-chip">{{ componentLabel(component) }} × {{ component.quantity }}</span>
          </div>
          <div v-if="!peekComboRows.length" class="variant-detail-single">尚未配置套餐内容。</div>
        </template>
        <div v-else class="variant-detail-single">加载中…</div>
      </div>
      <div v-else class="peek-body">
        <div class="peek-spec-hint">同一菜品「{{ peekRow && peekRow.name }}」在 {{ peekRow && peekRow.category }} 下的全部规格：</div>
        <el-table :data="siblingSpecs(peekRow)" size="small" border>
          <el-table-column label="规格" min-width="110"><template #default="{ row }">{{ specification(row) }}</template></el-table-column>
          <el-table-column label="价格" width="96" align="right"><template #default="{ row }">¥ {{ formatPrice(row.dine_in_price || row.price) }}</template></el-table-column>
          <el-table-column label="规格编码" min-width="140"><template #default="{ row }">{{ row.skuid || '—' }}</template></el-table-column>
          <el-table-column label="状态" width="80" align="center"><template #default="{ row }">{{ row.status || '在售' }}</template></el-table-column>
          <el-table-column label="操作" width="90" align="center"><template #default="{ row }"><el-button link type="primary" @click="peekVisible = false; openEditDialog(row)">编辑</el-button></template></el-table-column>
        </el-table>
      </div>
      <template #footer><el-button @click="peekVisible = false">关闭</el-button></template>
    </el-dialog>

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
import { useRoute, useRouter } from 'vue-router'
import { ArrowDown } from '@element-plus/icons-vue'
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
const router = useRouter()
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
const peekVisible = ref(false)
const peekKind = ref('combo')
const peekRow = ref(null)
const peekLoading = ref(false)

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
/**
 * 档案按「菜品」聚合展示：同分类同名的多个规格合并成一条（规格在名称旁直接可见、
 * 也可点「更多 → 查看全部规格」或「编辑」维护）；套餐各自独立一条。
 * 注意：合并只影响**展示**，每个规格仍是独立档案，绑定平台菜品时照旧按「菜品—规格」选。
 */
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
      groupKey: ordered.length > 1 ? `group:${primary.category || ''}:${primary.name}` : `item:${primary.id}`,
      representative: primary,
      variants: ordered,
      isGroup: ordered.length > 1,
    }
  })
})
const { currentPage, pageSize, totalItems, paginatedItems } = useMenuPagination(groupedItems, 20)

/** 左侧分类栏：托管分类在前（按管理顺序），档案里出现但未托管的分类追加在后 */
const categoryStats = computed(() => {
  const counts = new Map()
  items.value.forEach(item => {
    const name = item.category || '未分类'
    counts.set(name, (counts.get(name) || 0) + 1)
  })
  return categories.value.map(name => ({ name, count: counts.get(name) || 0 }))
})
const filteredActiveCount = computed(() => filteredItems.value.filter(item => (item.status || '在售') === '在售').length)
const filteredComboCount = computed(() => filteredItems.value.filter(item => item.item_type === 'combo').length)

/** 序号连续（跨页累加），一行 = 一个菜品（多规格合并为一行） */
function rowNumber(index) { return (currentPage.value - 1) * pageSize.value + index + 1 }
function selectCategory(name) {
  categoryFilter.value = name
  currentPage.value = 1
}
function goCategoryPage() { router.push('/menu-management/category') }
/** 该行包含的规格列表（套餐只有自己一条） */
function rowVariants(row) { return (row && row.variants) || (row ? [row] : []) }
/** 同分类同名的其他规格（「更多 → 查看全部规格」用） */
function siblingSpecs(row) {
  if (!row || row.item_type === 'combo') return row ? [row] : []
  return items.value.filter(item => item.item_type !== 'combo' && item.name === row.name && (item.category || '') === (row.category || ''))
}
/** 价格：多规格价格不同时显示区间 */
function groupPrice(row, field = 'dine') {
  const values = rowVariants(row).map(item => Number(field === 'dine' ? (item.dine_in_price || item.price) : item.member_price) || 0)
  if (!values.length) return '—'
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (field === 'member' && max === 0) return '—'
  return min === max ? `¥ ${formatPrice(min)}` : `¥ ${formatPrice(min)}–${formatPrice(max)}`
}
/** 状态：整组一致时显示该状态，混合时显示「部分停售」 */
function statusLabel(row) {
  const statuses = rowVariants(row).map(item => item.status || '在售')
  return new Set(statuses).size === 1 ? statuses[0] : '部分停售'
}
/** 规格编码：单规格直接显示；多规格显示个数，鼠标悬停列出全部 */
function groupSkuCode(row) {
  const codes = rowVariants(row).map(item => String(item.skuid || '').trim()).filter(Boolean)
  if (!codes.length) return '—'
  if (codes.length === 1) return codes[0]
  return `${codes.length} 个规格编码`
}
function groupSkuCodeTitle(row) {
  const codes = rowVariants(row).filter(item => String(item.skuid || '').trim())
  return codes.map(item => `${specification(item)}：${item.skuid}`).join('\n')
}
async function toggleStatus(row) {
  const targets = rowVariants(row)
  const next = statusLabel(row) === '停售' ? '在售' : '停售'
  try {
    for (const target of targets) await updateMenuItem(target.id, { status: next })
    await loadData()
    const suffix = targets.length > 1 ? `（${targets.length} 个规格）` : ''
    ElMessage.success(`「${row.name}」${suffix}已${next === '停售' ? '停售' : '开售'}`)
  } catch (error) { ElMessage.error('状态修改失败：' + error.message) }
}
function handleRowCommand(command, row) {
  if (command === 'delete') return removeItem(row)
  if (command === 'combo') return openComboPeek(row)
  if (command === 'specs') { peekKind.value = 'specs'; peekRow.value = row; peekVisible.value = true }
}
async function openComboPeek(row) {
  peekKind.value = 'combo'
  peekRow.value = row
  peekVisible.value = true
  if (comboExpansion.value[row.id]) return
  peekLoading.value = true
  try {
    const result = await getMenuCostComponents(row.id)
    comboExpansion.value = { ...comboExpansion.value, [row.id]: result.components || [] }
  } catch (error) {
    ElMessage.error('套餐内容加载失败：' + error.message)
  } finally { peekLoading.value = false }
}
const peekComboRows = computed(() => (peekRow.value ? comboExpansion.value[peekRow.value.id] : null))
const peekTitle = computed(() => {
  if (peekKind.value === 'specs') return `${peekRow.value ? peekRow.value.name : ''} · 全部规格`
  return `套餐内容 · ${peekRow.value ? peekRow.value.name : ''}`
})

function resetFilters() {
  search.value = ''
  categoryFilter.value = ''
  statusFilter.value = ''
  currentPage.value = 1
}
function formatPrice(value) { return (Number(value) || 0).toFixed(2) }
function specification(row) {
  const spec = String(row.spec || '').trim()
  if (spec && !['标准', '常规', '份'].includes(spec)) return spec
  const weight = String(row.spec_weight || '').trim()
  return weight || '标准规格'
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
  const spec = specification(row)
  const targetText = row.isGroup
    ? `「${row.name}」及其 ${targets.length} 个规格`
    : (spec !== '标准规格' ? `「${row.name} · ${spec}」这个规格` : `「${row.name}」`)
  try {
    await ElMessageBox.confirm(`确定删除${targetText}？`, '删除菜品', { type: 'warning', confirmButtonText: '确认删除' })
    for (const target of targets) await deleteMenuItem(target.id)
    await loadData()
    ElMessage.success(row.isGroup || spec !== '标准规格' ? '菜品及其规格已删除' : '菜品已删除')
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

/* ===== 菜品档案：左侧分类栏 + 右侧明细 ===== */
.menu-archive-layout { display: grid; grid-template-columns: 208px minmax(0, 1fr); gap: 14px; align-items: start; }
.menu-category-rail {
  padding: 12px 10px 10px;
  border: 1px solid #e8ecf3;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 8px 22px rgba(23, 43, 77, .04);
  position: sticky;
  top: 12px;
  max-height: calc(100vh - 150px);
  overflow: auto;
}
.rail-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 6px 10px; border-bottom: 1px solid #f0f2f6; }
.rail-head span { color: #344054; font-size: 13px; font-weight: 700; }
.rail-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  margin-top: 3px;
  padding: 8px 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: #4b5768;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background .15s, color .15s;
}
.rail-item:hover { background: #f5f8ff; color: #2764ca; }
.rail-item.active { background: #eef4ff; color: #2764ca; font-weight: 700; }
.rail-item.empty { color: #b0b8c4; }
.rail-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-count { flex: 0 0 auto; min-width: 26px; padding: 1px 7px; border-radius: 9px; background: #f2f4f8; color: #7e899a; font-size: 11px; font-weight: 650; text-align: center; font-variant-numeric: tabular-nums; }
.rail-item.active .rail-count { background: #fff; color: #2764ca; }
.rail-foot { margin-top: 10px; padding: 10px 8px 2px; border-top: 1px solid #f0f2f6; display: grid; gap: 6px; }
.rail-foot > div { display: flex; align-items: center; justify-content: space-between; color: #8b95a5; font-size: 12px; }
.rail-foot b { color: #344054; font-size: 13px; font-variant-numeric: tabular-nums; }
.rail-foot b.warn { color: #d98b16; }
.menu-archive-panel { min-width: 0; }
.archive-flat-table .el-table__cell { height: 56px; }
.archive-name-cell { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.archive-name-cell b { color: #344054; font-size: 14px; }
.archive-name-cell small { color: #9aa4b2; font-size: 11px; }
.spec-chip.soft { background: #f4f6fa; color: #8b95a5; }
.code-cell { color: #61708a; font-size: 12px; font-variant-numeric: tabular-nums; letter-spacing: .2px; }
.menu-price.muted { color: #9aa4b2; font-weight: 500; }
.more-caret { margin-left: 2px; }
.peek-body { min-height: 60px; }
.peek-spec-hint { margin-bottom: 10px; color: #6b7a90; font-size: 13px; }
@media (max-width: 900px) {
  .menu-archive-layout { grid-template-columns: 1fr; }
  .menu-category-rail { position: static; max-height: none; }
}
</style>
