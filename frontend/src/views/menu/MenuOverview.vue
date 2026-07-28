<template>
  <div class="menu-module-page">
    <MenuModuleHeader
      title="菜品总览"
      description="统一维护菜品档案、规格、多渠道价格与销售状态。"
      active="menu-management-overview"
      :metrics="heroMetrics"
    >
      <template #action>
        <el-button type="primary" size="large" round @click="openCreateDialog">新增菜品</el-button>
      </template>
    </MenuModuleHeader>

    <section class="metric-strip">
      <div class="metric-card"><span>菜品总数</span><strong>{{ items.length }}</strong><small>{{ categories.length }} 个分类</small></div>
      <div class="metric-card"><span>堂食均价</span><strong>¥{{ average('dine_in_price') }}</strong><small>基于有效价格</small></div>
      <div class="metric-card"><span>会员均价</span><strong>¥{{ average('member_price') }}</strong><small>会员价格体系</small></div>
      <div class="metric-card"><span>外卖均价</span><strong>¥{{ average('takeout_price') }}</strong><small>第三方平台价格</small></div>
    </section>

    <section class="menu-panel">
      <header class="menu-panel-header">
        <div class="menu-panel-title">
          <h3>菜品档案</h3>
          <span>维护名称、分类、规格、价格与成本信息</span>
        </div>
        <div class="menu-filters">
          <el-select v-model="storeFilter" clearable filterable placeholder="全部门店" @change="loadData">
            <el-option v-for="store in storeList" :key="store.id" :label="store.store_name" :value="store.id" />
          </el-select>
          <el-input v-model="search" clearable placeholder="搜索菜品名称" class="wide-filter" />
          <el-select v-model="categoryFilter" clearable placeholder="全部分类">
            <el-option v-for="category in categories" :key="category" :label="category" :value="category" />
          </el-select>
          <el-select v-model="statusFilter" clearable placeholder="全部状态">
            <el-option label="在售" value="在售" />
            <el-option label="停售" value="停售" />
          </el-select>
        </div>
      </header>

      <el-table v-loading="loading" :data="paginatedItems" class="menu-data-table" row-key="id">
        <el-table-column label="菜品" min-width="210">
          <template #default="{ row }">
            <div class="dish-name">
              <span class="dish-monogram">{{ dishLetter(row) }}</span>
              <div><b>{{ row.name }}</b><small>{{ row.method && row.method !== '/' ? row.method : '标准做法' }}</small></div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="分类" min-width="130">
          <template #default="{ row }"><span class="menu-category">{{ row.category || '未分类' }}</span></template>
        </el-table-column>
        <el-table-column label="规格" min-width="120">
          <template #default="{ row }">{{ specification(row) }}</template>
        </el-table-column>
        <el-table-column label="堂食价" width="100" align="right">
          <template #default="{ row }"><span class="menu-price">¥{{ formatPrice(row.dine_in_price || row.price) }}</span></template>
        </el-table-column>
        <el-table-column label="会员价" width="100" align="right">
          <template #default="{ row }"><span class="menu-price member">¥{{ formatPrice(row.member_price) }}</span></template>
        </el-table-column>
        <el-table-column label="外卖价" width="100" align="right">
          <template #default="{ row }"><span class="menu-price takeout">¥{{ formatPrice(row.takeout_price) }}</span></template>
        </el-table-column>
        <el-table-column label="成本" width="95" align="right">
          <template #default="{ row }"><span class="menu-price">¥{{ formatPrice(row.cost) }}</span></template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }"><span :class="['status-pill', row.status === '停售' ? 'off' : 'on']">{{ row.status || '在售' }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="145" fixed="right" align="right">
          <template #default="{ row }">
            <div class="row-actions">
              <el-button link type="primary" @click="openEditDialog(row)">编辑</el-button>
              <el-button link type="danger" @click="removeItem(row)">删除</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!loading && filteredItems.length === 0" class="menu-empty">没有符合条件的菜品</div>
      <footer class="menu-pagination-footer">
        <span>筛选结果 {{ totalItems }} / {{ items.length }} 个菜品</span>
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

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑菜品' : '新增菜品'" width="650px" align-center class="menu-dialog">
      <el-form label-position="top">
        <div class="form-section-label">基本信息</div>
        <div class="form-grid">
          <el-form-item label="菜品名称" required><el-input v-model="form.name" maxlength="50" placeholder="请输入菜品名称" /></el-form-item>
          <el-form-item label="菜品分类" required>
            <el-select v-model="form.category" filterable allow-create placeholder="选择或输入分类" style="width:100%;">
              <el-option v-for="category in categories" :key="category" :label="category" :value="category" />
            </el-select>
          </el-form-item>
        </div>
        <div class="form-grid">
          <el-form-item label="做法"><el-input v-model="form.method" placeholder="例如：切件、不切" /></el-form-item>
          <el-form-item label="销售状态">
            <el-segmented v-model="form.status" :options="['在售', '停售']" />
          </el-form-item>
        </div>

        <div class="form-section-label">规格与效期</div>
        <div class="form-grid three">
          <el-form-item label="单位">
            <el-select v-model="form.spec_unit" filterable allow-create style="width:100%;">
              <el-option v-for="unit in specUnits" :key="unit" :label="unit" :value="unit" />
            </el-select>
          </el-form-item>
          <el-form-item label="净含量"><el-input v-model="form.spec_weight" placeholder="例如：100g" /></el-form-item>
          <el-form-item label="保质期（天）"><el-input-number v-model="form.expiry_days" :min="0" :max="365" style="width:100%;" /></el-form-item>
        </div>

        <div class="form-section-label">价格与成本</div>
        <div class="form-grid three">
          <el-form-item label="堂食价"><el-input-number v-model="form.dine_in_price" :min="0" :precision="2" :controls="false" style="width:100%;" /></el-form-item>
          <el-form-item label="会员价"><el-input-number v-model="form.member_price" :min="0" :precision="2" :controls="false" style="width:100%;" /></el-form-item>
          <el-form-item label="外卖价"><el-input-number v-model="form.takeout_price" :min="0" :precision="2" :controls="false" style="width:100%;" /></el-form-item>
        </div>
        <el-form-item label="单份成本"><el-input-number v-model="form.cost" :min="0" :precision="2" :controls="false" style="width:200px;" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveItem">保存菜品</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { createMenuItem, deleteMenuItem, getMenuItems, getStores, updateMenuItem } from '@/api'
import { ElMessage, ElMessageBox } from 'element-plus'
import MenuModuleHeader from './MenuModuleHeader.vue'
import { useMenuPagination } from './useMenuPagination'
import './menu-theme.css'

const items = ref([])
const storeList = ref([])
const loading = ref(false)
const saving = ref(false)
const search = ref('')
const storeFilter = ref(null)
const categoryFilter = ref('')
const statusFilter = ref('')
const dialogVisible = ref(false)
const editingId = ref(null)
const specUnits = ['份', '杯', '个', '碗', '碟', '盅', '煲', '笼', '盘', '扎']

const emptyForm = () => ({
  name: '', category: '', method: '', spec_unit: '份', spec_weight: '',
  dine_in_price: 0, member_price: 0, takeout_price: 0, cost: 0,
  expiry_days: null, status: '在售',
})
const form = ref(emptyForm())

const categories = computed(() => [...new Set(items.value.map(item => item.category).filter(Boolean))].sort())
const filteredItems = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return items.value.filter(item => {
    if (keyword && !String(item.name || '').toLowerCase().includes(keyword)) return false
    if (categoryFilter.value && item.category !== categoryFilter.value) return false
    if (statusFilter.value && (item.status || '在售') !== statusFilter.value) return false
    return true
  })
})
const heroMetrics = computed(() => [
  { label: '在售菜品', value: items.value.filter(item => (item.status || '在售') === '在售').length, tone: 'success' },
  { label: '停售菜品', value: items.value.filter(item => item.status === '停售').length },
])
const { currentPage, pageSize, totalItems, paginatedItems } = useMenuPagination(filteredItems)

function average(field) {
  const values = items.value.map(item => Number(item[field]) || 0).filter(value => value > 0)
  if (!values.length) return '0.00'
  return (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)
}
function formatPrice(value) { return (Number(value) || 0).toFixed(2) }
function dishLetter(row) { return String(row.name || '菜').slice(0, 1) }
function specification(row) {
  const parts = [row.spec_unit, row.spec_weight].filter(Boolean)
  return parts.length ? parts.join(' / ') : '—'
}
function openCreateDialog() {
  editingId.value = null
  form.value = emptyForm()
  dialogVisible.value = true
}
function openEditDialog(row) {
  editingId.value = row.id
  form.value = {
    name: row.name || '',
    category: row.category || '',
    method: row.method || '',
    spec_unit: row.spec_unit || '份',
    spec_weight: row.spec_weight || '',
    dine_in_price: Number(row.dine_in_price || row.price) || 0,
    member_price: Number(row.member_price) || 0,
    takeout_price: Number(row.takeout_price) || 0,
    cost: Number(row.cost) || 0,
    expiry_days: row.expiry_days == null ? null : Number(row.expiry_days),
    status: row.status || '在售',
  }
  dialogVisible.value = true
}
async function saveItem() {
  if (!form.value.name.trim() || !form.value.category.trim()) {
    ElMessage.warning('请填写菜品名称和分类')
    return
  }
  saving.value = true
  try {
    if (editingId.value) await updateMenuItem(editingId.value, form.value)
    else await createMenuItem(form.value)
    dialogVisible.value = false
    await loadData()
    ElMessage.success(editingId.value ? '菜品已更新' : '菜品已创建')
  } catch (error) {
    ElMessage.error('保存失败：' + error.message)
  } finally { saving.value = false }
}
async function removeItem(row) {
  try {
    await ElMessageBox.confirm(`确定删除「${row.name}」？`, '删除菜品', { type: 'warning', confirmButtonText: '确认删除' })
    await deleteMenuItem(row.id)
    await loadData()
    ElMessage.success('菜品已删除')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error('删除失败：' + error.message)
  }
}
async function loadData() {
  loading.value = true
  try {
    const params = { page: 1, page_size: 500 }
    if (storeFilter.value) params.store_id = storeFilter.value
    const data = await getMenuItems(params)
    items.value = data.items || []
  } catch (error) {
    ElMessage.error('加载失败：' + error.message)
  } finally { loading.value = false }
}
onMounted(async () => {
  try {
    const stores = await getStores({ page: 1, page_size: 500 })
    storeList.value = stores.items || stores.data || stores || []
  } catch {}
  await loadData()
})
</script>
