<template>
  <div class="menu-overview">
    <!-- 统计卡片 -->
    <div class="stat-row" v-if="items.length">
      <div class="stat-card">
        <div class="stat-icon">🍽️</div>
        <div class="stat-body">
          <div class="stat-num">{{ items.length }}</div>
          <div class="stat-label">菜品总数</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">📂</div>
        <div class="stat-body">
          <div class="stat-num">{{ categories.length }}</div>
          <div class="stat-label">分类数</div>
        </div>
      </div>
      <div class="stat-card price-card">
        <div class="stat-body">
          <div class="stat-num dine">¥{{ avgDineIn }}</div>
          <div class="stat-label">堂食均价</div>
        </div>
      </div>
      <div class="stat-card price-card">
        <div class="stat-body">
          <div class="stat-num member">¥{{ avgMember }}</div>
          <div class="stat-label">会员均价</div>
        </div>
      </div>
      <div class="stat-card price-card">
        <div class="stat-body">
          <div class="stat-num takeout">¥{{ avgTakeout }}</div>
          <div class="stat-label">外卖均价</div>
        </div>
      </div>
    </div>

    <!-- 工具栏 -->
    <div class="toolbar">
      <el-select
        v-model="storeFilter"
        placeholder="全部门店"
        clearable
        filterable
        size="small"
        style="width:180px;"
        @change="onStoreFilterChange"
      >
        <el-option label="🏢 全部门店" :value="null" />
        <el-option v-for="s in storeList" :key="s.id" :label="s.store_name" :value="s.id" />
      </el-select>
      <el-input
        v-model="search"
        placeholder="搜索菜品…"
        clearable
        :prefix-icon="Search"
        size="small"
        style="width:200px;"
      />
      <div class="cat-tags">
        <el-tag
          v-for="cat in categories"
          :key="cat"
          :type="selectedCats.has(cat) ? 'primary' : 'info'"
          :effect="selectedCats.has(cat) ? 'dark' : 'plain'"
          class="cat-tag"
          size="small"
          @click="toggleCat(cat)"
        >
          {{ cat }} <small>({{ countByCat(cat) }})</small>
        </el-tag>
      </div>
      <div class="toolbar-right">
        <el-button text size="small" @click="expandAll">全部展开</el-button>
        <el-button text size="small" @click="collapseAll">全部收起</el-button>
        <el-button type="primary" size="small" @click="showAddDialog">+ 新增菜品</el-button>
      </div>
    </div>

    <!-- 分组折叠表格 -->
    <div v-if="filteredGroups.length" v-loading="loading" class="menu-groups">
      <el-collapse v-model="activeGroups">
        <el-collapse-item
          v-for="group in filteredGroups"
          :key="group.category"
          :name="group.category"
        >
          <template #title>
            <div class="group-title">
              <span class="group-name">{{ group.category }}</span>
              <el-tag size="small" round effect="plain">{{ group.items.length }} 个</el-tag>
              <span class="group-avg">
                堂食 ¥{{ groupAvg(group, 'dine_in_price') }} &nbsp; 会员 ¥{{ groupAvg(group, 'member_price') }}
              </span>
            </div>
          </template>

          <el-table :data="group.items" size="small" stripe style="width:100%;">
            <!-- 名称 -->
            <el-table-column prop="name" label="菜品名称" min-width="130" />

            <!-- 做法 -->
            <el-table-column label="做法" width="85" align="center">
              <template #default="{ row }">
                <span v-if="row.method && row.method !== '/'" class="method-text">{{ row.method }}</span>
                <span v-else class="text-muted">—</span>
              </template>
            </el-table-column>

            <!-- 规格 -->
            <el-table-column label="规格" width="110" align="center">
              <template #default="{ row }">
                <span class="spec-text" v-if="row.spec_unit">
                  {{ row.spec_unit }}<template v-if="row.spec_weight">&nbsp;/&nbsp;{{ row.spec_weight }}</template>
                </span>
                <span v-else class="text-muted">—</span>
              </template>
            </el-table-column>

            <!-- 堂食价 -->
            <el-table-column label="堂食价" width="90" sortable prop="dine_in_price" align="right">
              <template #default="{ row }">
                <span class="price-tag dine" v-if="(row.dine_in_price || row.price)">
                  ¥{{ (row.dine_in_price || row.price || 0).toFixed(2) }}
                </span>
                <span v-else class="text-muted">—</span>
              </template>
            </el-table-column>

            <!-- 会员价 -->
            <el-table-column label="会员价" width="90" sortable prop="member_price" align="right">
              <template #default="{ row }">
                <span class="price-tag member" v-if="row.member_price">
                  ¥{{ row.member_price.toFixed(2) }}
                </span>
                <span v-else class="text-muted">—</span>
              </template>
            </el-table-column>

            <!-- 外卖价 -->
            <el-table-column label="外卖价" width="90" sortable prop="takeout_price" align="right">
              <template #default="{ row }">
                <span class="price-tag takeout" v-if="row.takeout_price">
                  ¥{{ row.takeout_price.toFixed(2) }}
                </span>
                <span v-else class="text-muted">—</span>
              </template>
            </el-table-column>

            <!-- 状态 -->
            <el-table-column label="状态" width="72" align="center">
              <template #default="{ row }">
                <el-tag
                  :type="row.status === '在售' ? 'success' : 'info'"
                  size="small"
                  effect="plain"
                >
                  {{ row.status || '在售' }}
                </el-tag>
              </template>
            </el-table-column>

            <!-- 操作 -->
            <el-table-column label="操作" width="130" align="center" fixed="right">
              <template #default="{ row }">
                <el-button text type="primary" size="small" @click="editItem(row)">编辑</el-button>
                <el-popconfirm title="确定删除该菜品？" @confirm="deleteItem(row)">
                  <template #reference>
                    <el-button text type="danger" size="small">删除</el-button>
                  </template>
                </el-popconfirm>
              </template>
            </el-table-column>
          </el-table>
        </el-collapse-item>
      </el-collapse>
    </div>

    <p v-else-if="!loading" class="empty-hint">
      {{ items.length ? '没有符合筛选条件的菜品' : '暂无菜品数据，请先导入或新增' }}
    </p>

    <!-- 编辑 / 新增弹窗 -->
    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑菜品' : '新增菜品'"
      width="480px"
      :close-on-click-modal="false"
      destroy-on-close
    >
      <el-form :model="form" label-width="56px" size="small" class="menu-form">
        <!-- 基本信息 -->
        <div class="form-section">
          <div class="form-section-title">基本信息</div>
          <el-form-item label="名称">
            <el-input v-model="form.name" placeholder="菜品名称" />
          </el-form-item>
          <el-row :gutter="12">
            <el-col :span="12">
              <el-form-item label="门店">
                <el-select v-model="form.store_id" placeholder="选择门店" filterable style="width:100%;">
                  <el-option v-for="s in storeList" :key="s.id" :label="s.store_name" :value="s.id" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="分类">
                <el-select v-model="form.category" placeholder="选择分类" filterable allow-create style="width:100%;">
                  <el-option v-for="c in allCategories" :key="c" :label="c" :value="c" />
                </el-select>
              </el-form-item>
            </el-col>
          </el-row>
          <el-form-item label="做法">
            <el-input v-model="form.method" placeholder="如：切、不切" />
          </el-form-item>
        </div>

        <!-- 规格 -->
        <div class="form-section">
          <div class="form-section-title">规格信息</div>
          <el-row :gutter="12">
            <el-col :span="10">
              <el-form-item label="单位">
                <el-select v-model="form.spec_unit" placeholder="单位" filterable allow-create style="width:100%;">
                  <el-option v-for="u in specUnits" :key="u" :label="u" :value="u" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="14">
              <el-form-item label="净含量">
                <el-input v-model="form.spec_weight" placeholder="如：100g" />
              </el-form-item>
            </el-col>
          </el-row>
        </div>

        <!-- 价格 -->
        <div class="form-section">
          <div class="form-section-title">价格体系</div>
          <el-row :gutter="12">
            <el-col :span="8">
              <el-form-item label="堂食价" label-width="56px">
                <el-input-number v-model="form.dine_in_price" :min="0" :precision="2" :controls="false" style="width:100%;" />
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="会员价" label-width="56px">
                <el-input-number v-model="form.member_price" :min="0" :precision="2" :controls="false" style="width:100%;" />
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="外卖价" label-width="56px">
                <el-input-number v-model="form.takeout_price" :min="0" :precision="2" :controls="false" style="width:100%;" />
              </el-form-item>
            </el-col>
          </el-row>
        </div>

        <el-form-item label="状态">
          <el-radio-group v-model="form.status">
            <el-radio value="在售">在售</el-radio>
            <el-radio value="停售">停售</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveItem" :loading="saving">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { Search } from '@element-plus/icons-vue'
import { getMenuItems, createMenuItem, updateMenuItem, deleteMenuItem, getStores } from '@/api'
import { ElMessage } from 'element-plus'

const items = ref([])
const storeList = ref([])
const loading = ref(false)
const activeGroups = ref([])
const search = ref('')
const storeFilter = ref(null)
const selectedCats = ref(new Set())
const dialogVisible = ref(false)
const editingId = ref(null)
const saving = ref(false)

const specUnits = ['份', '杯', '个', '碗', '碟', '盅', '煲', '笼', '盘', '扎']

const CATEGORY_ORDER = [
  '招牌双拼饭', '港式滑蛋饭', '太公烧味饭', '至尊腿饭',
  '烧鹅濑粉', '开心加料', '来杯特饮', '烧味例牌',
]

const emptyForm = () => ({
  store_id: null,
  name: '',
  category: '',
  method: '',
  spec_unit: '份',
  spec_weight: '',
  dine_in_price: 0,
  member_price: 0,
  takeout_price: 0,
  status: '在售',
})
const form = ref(emptyForm())

// === 计算属性 ===
const categories = computed(() => {
  const set = new Set(items.value.map(i => i.category).filter(Boolean))
  const ordered = CATEGORY_ORDER.filter(c => set.has(c))
  const rest = [...set].filter(c => !CATEGORY_ORDER.includes(c)).sort()
  return [...ordered, ...rest]
})

const allCategories = computed(() => categories.value)

function avgByField(field) {
  const list = items.value.filter(i => (i[field] || 0) > 0)
  if (!list.length) return '—'
  const sum = list.reduce((s, i) => s + (i[field] || 0), 0)
  return (sum / list.length).toFixed(2)
}
const avgDineIn = computed(() => avgByField('dine_in_price'))
const avgMember = computed(() => avgByField('member_price'))
const avgTakeout = computed(() => avgByField('takeout_price'))

const filteredItems = computed(() => {
  let list = items.value
  if (search.value) {
    const kw = search.value.toLowerCase()
    list = list.filter(i => i.name.toLowerCase().includes(kw))
  }
  if (selectedCats.value.size > 0) {
    list = list.filter(i => selectedCats.value.has(i.category))
  }
  return list
})

const filteredGroups = computed(() => {
  const map = new Map()
  for (const item of filteredItems.value) {
    const cat = item.category || '未分类'
    if (!map.has(cat)) map.set(cat, [])
    map.get(cat).push(item)
  }
  const order = categories.value.filter(c => map.has(c))
  const rest = [...map.keys()].filter(c => !order.includes(c)).sort()
  return [...order, ...rest].map(cat => ({
    category: cat,
    items: map.get(cat),
  }))
})

function countByCat(cat) {
  return items.value.filter(i => i.category === cat).length
}
function groupAvg(group, field) {
  if (!group.items.length) return '—'
  const valid = group.items.filter(i => (i[field] || 0) > 0)
  if (!valid.length) return '—'
  const sum = valid.reduce((s, i) => s + (i[field] || 0), 0)
  return (sum / valid.length).toFixed(2)
}

// === 筛选 ===
function toggleCat(cat) {
  const next = new Set(selectedCats.value)
  if (next.has(cat)) next.delete(cat)
  else next.add(cat)
  selectedCats.value = next
  const visibleCats = filteredGroups.value.map(g => g.category)
  activeGroups.value = visibleCats
}

function expandAll() {
  activeGroups.value = filteredGroups.value.map(g => g.category)
}
function collapseAll() {
  activeGroups.value = []
}

async function onStoreFilterChange() {
  await loadData()
}

// === CRUD ===
function showAddDialog() {
  editingId.value = null
  form.value = emptyForm()
  if (storeFilter.value) form.value.store_id = storeFilter.value
  dialogVisible.value = true
}

function editItem(row) {
  editingId.value = row.id
  form.value = {
    store_id: row.store_id,
    name: row.name,
    category: row.category || '',
    method: row.method || '',
    spec_unit: row.spec_unit || '份',
    spec_weight: row.spec_weight || '',
    dine_in_price: row.dine_in_price || row.price || 0,
    member_price: row.member_price || 0,
    takeout_price: row.takeout_price || 0,
    status: row.status || '在售',
  }
  dialogVisible.value = true
}

async function saveItem() {
  if (!form.value.name.trim()) {
    ElMessage.warning('请输入菜品名称')
    return
  }
  saving.value = true
  try {
    if (editingId.value) {
      await updateMenuItem(editingId.value, form.value)
      ElMessage.success('已更新')
    } else {
      await createMenuItem(form.value)
      ElMessage.success('已添加')
    }
    dialogVisible.value = false
    await loadData()
  } catch (e) {
    ElMessage.error(e.message || '保存失败')
  } finally {
    saving.value = false
  }
}

async function deleteItem(row) {
  try {
    await deleteMenuItem(row.id)
    ElMessage.success('已删除')
    await loadData()
  } catch (e) {
    ElMessage.error(e.message || '删除失败')
  }
}

// === 数据加载 ===
async function loadData() {
  loading.value = true
  try {
    const params = { page: 1, page_size: 500 }
    if (storeFilter.value) params.store_id = storeFilter.value
    const data = await getMenuItems(params)
    items.value = data.items || []
  } catch {} finally { loading.value = false }
}

onMounted(async () => {
  try {
    const stores = await getStores()
    storeList.value = stores.items || stores || []
  } catch {}
  await loadData()
  expandAll()
})
</script>

<style scoped>
.menu-overview {
  /* 微调整体间距 */
}

/* ===== 统计卡片 ===== */
.stat-row {
  display: flex;
  gap: 10px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.stat-card {
  flex: 1;
  min-width: 110px;
  display: flex;
  align-items: center;
  gap: 10px;
  background: #f8f9fb;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 12px 14px;
  transition: box-shadow 0.2s;
}
.stat-card:hover {
  box-shadow: 0 1px 6px rgba(0,0,0,.06);
}
.stat-icon {
  font-size: 22px;
  line-height: 1;
  opacity: 0.7;
}
.stat-body {
  min-width: 0;
}
.stat-num {
  font-size: 20px;
  font-weight: 700;
  color: #303133;
  line-height: 1.3;
  white-space: nowrap;
}
.stat-num.dine  { color: #303133; }
.stat-num.member { color: #e6a23c; }
.stat-num.takeout { color: #409eff; }
.stat-label {
  font-size: 11px;
  color: #909399;
  margin-top: 1px;
}

/* ===== 工具栏 ===== */
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.cat-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  flex: 1;
}
.cat-tag {
  cursor: pointer;
  user-select: none;
  transition: opacity 0.2s;
}
.cat-tag:hover {
  opacity: 0.85;
}
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

/* ===== 分组表格 ===== */
.menu-groups {
  margin-top: 2px;
}
.group-title {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}
.group-name {
  font-weight: 600;
  font-size: 14px;
}
.group-avg {
  font-size: 12px;
  color: #909399;
  margin-left: auto;
  margin-right: 12px;
}

/* 做法 */
.method-text {
  font-size: 12px;
  color: #606266;
}

/* 规格 */
.spec-text {
  font-size: 12px;
  color: #606266;
}

/* 价格标签 */
.price-tag {
  font-weight: 700;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.price-tag.dine    { color: #303133; }
.price-tag.member  { color: #e6a23c; }
.price-tag.takeout { color: #409eff; }

.text-muted {
  color: #c0c4cc;
  font-size: 12px;
}

/* ===== 空态 ===== */
.empty-hint {
  color: #909399;
  padding: 40px;
  text-align: center;
}

/* ===== 编辑弹窗 ===== */
.menu-form {
  max-height: 60vh;
  overflow-y: auto;
  padding-right: 4px;
}
.form-section {
  margin-bottom: 4px;
}
.form-section-title {
  font-size: 12px;
  font-weight: 600;
  color: #606266;
  margin-bottom: 8px;
  padding-left: 2px;
  border-left: 3px solid #409eff;
  padding-left: 8px;
  line-height: 1.2;
}
</style>
