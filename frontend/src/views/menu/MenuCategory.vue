<template>
  <div class="menu-module-page">
    <MenuModuleHeader
      title="菜品分类"
      description="集中维护菜品分类；拖动排序会实时影响所有菜品选择器。"
      active="menu-management-category"
      :metrics="heroMetrics"
    >
      <template #action>
        <el-button type="primary" plain @click="openCreate">＋ 新增分类</el-button>
      </template>
    </MenuModuleHeader>

    <section class="metric-strip">
      <div class="metric-card"><span>全部分类</span><strong>{{ totalCount }}</strong><small>已收录 {{ managedCount }} 个</small></div>
      <div class="metric-card"><span>在用分类</span><strong>{{ inUseCount }}</strong><small>当前关联了菜品</small></div>
      <div class="metric-card"><span>关联菜品</span><strong>{{ dishTotal }}</strong><small>按分类统计的在售菜品</small></div>
      <div class="metric-card"><span>待收录</span><strong :style="orphanCount ? 'color:#df8b2d' : ''">{{ orphanCount }}</strong><small>菜单中已使用但未建分类</small></div>
    </section>

    <section class="menu-panel">
      <header class="menu-panel-header">
        <div class="menu-panel-title"><h3>分类档案</h3><span>直接拖动分类名称调整实际显示顺序；该顺序会同步到菜品总览、套餐选菜和平台绑定。</span></div>
        <div class="menu-filters">
          <el-input v-model="search" clearable placeholder="搜索分类名称" class="wide-filter" />
        </div>
      </header>

      <el-table v-loading="loading" :data="filteredCategories" class="menu-data-table" row-key="id">
        <el-table-column label="分类名称" min-width="220">
          <template #default="{ row }">
            <div class="dish-name category-name-cell" :class="{ 'is-drop-target': dragOverId === row.id, 'is-draggable': !row.orphan && !search.trim() }" :draggable="!row.orphan && !search.trim()" @dragstart="startCategoryDrag(row, $event)" @dragover.prevent="dragOverCategory(row)" @drop.prevent="dropCategory(row)" @dragend="endCategoryDrag">
              <span class="category-order-index">{{ row.orphan ? '—' : categoryPosition(row) }}</span>
              <span class="dish-monogram">{{ String(row.name || '分').slice(0, 1) }}</span>
              <div>
                <b>{{ row.name }}</b>
                <small v-if="row.orphan" style="color:#d88928;">菜单中已使用 · 尚未收录为分类</small>
                <small v-else>{{ row.remark || '暂无备注' }}</small>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="关联菜品" width="120" align="center">
          <template #default="{ row }">
            <span :class="['status-pill', row.dish_count ? 'on' : 'off']">{{ row.dish_count || 0 }} 个</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="160">
          <template #default="{ row }">{{ row.created_at || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right" align="right">
          <template #default="{ row }">
            <div class="row-actions">
              <el-button v-if="row.orphan" link type="primary" @click="adoptCategory(row)">收录</el-button>
              <template v-else>
                <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
                <el-button link type="danger" @click="removeCategory(row)">删除</el-button>
              </template>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!loading && !filteredCategories.length" class="menu-empty">还没有分类，点击右上角「新增分类」创建第一个</div>
      <footer class="menu-pagination-footer">
        <span>共 {{ filteredCategories.length }} 个分类 · 分类名修改后会自动同步到该分类下的所有菜品</span>
      </footer>
    </section>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑分类' : '新增分类'" width="460px" align-center class="menu-dialog">
      <el-form label-position="top">
        <el-form-item label="分类名称" required>
          <el-input v-model="form.name" maxlength="20" show-word-limit placeholder="例如：烧腊、快餐、粉面" />
        </el-form-item>
        
        <el-form-item label="备注">
          <el-input v-model="form.remark" maxlength="100" show-word-limit type="textarea" :rows="2" placeholder="选填" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveCategory">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  getMenuCategoryList,
  createMenuCategory,
  updateMenuCategory,
  reorderMenuCategories,
  deleteMenuCategory,
  adoptMenuCategory,
} from '@/api'
import MenuModuleHeader from './MenuModuleHeader.vue'
import './menu-theme.css'

const categories = ref([])
const loading = ref(false)
const saving = ref(false)
const search = ref('')
const dialogVisible = ref(false)
const editingId = ref(null)
const form = reactive({ name: '', remark: '' })
const ordering = ref(false)
const draggingId = ref(null)
const dragOverId = ref(null)

const filteredCategories = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  if (!keyword) return categories.value
  return categories.value.filter(c => String(c.name || '').toLowerCase().includes(keyword))
})
const managedCount = computed(() => categories.value.filter(c => !c.orphan).length)
const orphanCount = computed(() => categories.value.filter(c => c.orphan).length)
const inUseCount = computed(() => categories.value.filter(c => c.dish_count > 0).length)
const dishTotal = computed(() => categories.value.reduce((sum, c) => sum + (Number(c.dish_count) || 0), 0))
const totalCount = computed(() => categories.value.length)
const heroMetrics = computed(() => [
  { label: '分类总数', value: totalCount.value, tone: 'success' },
  { label: '在用分类', value: inUseCount.value, tone: '' },
  { label: '关联菜品', value: dishTotal.value, tone: '' },
  { label: '待收录', value: orphanCount.value, tone: orphanCount.value ? 'warning' : 'success' },
])

function resetForm() {
  form.name = ''
  form.remark = ''
  editingId.value = null
}

function openCreate() {
  resetForm()
  dialogVisible.value = true
}

function openEdit(row) {
  editingId.value = row.id
  form.name = row.name
  form.remark = row.remark || ''
  dialogVisible.value = true
}

async function saveCategory() {
  const name = form.name.trim()
  if (!name) return ElMessage.warning('请填写分类名称')
  saving.value = true
  try {
    if (editingId.value) {
      await updateMenuCategory(editingId.value, { name, remark: form.remark.trim() })
      ElMessage.success('分类已更新')
    } else {
      await createMenuCategory({ name, remark: form.remark.trim() })
      ElMessage.success('分类已创建')
    }
    dialogVisible.value = false
    await loadData()
  } catch (error) {
    ElMessage.error('保存失败：' + error.message)
  } finally {
    saving.value = false
  }
}

function managedCategories() { return categories.value.filter(category => !category.orphan) }
function categoryPosition(row) {
  const index = managedCategories().findIndex(category => Number(category.id) === Number(row.id))
  return index < 0 ? '—' : index + 1
}
function startCategoryDrag(row, event) {
  if (row.orphan || search.value.trim()) return
  draggingId.value = row.id
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', String(row.id))
}
function dragOverCategory(row) {
  if (!draggingId.value || row.orphan || Number(row.id) === Number(draggingId.value)) return
  dragOverId.value = row.id
}
function endCategoryDrag() {
  draggingId.value = null
  dragOverId.value = null
}
async function dropCategory(target) {
  const sourceId = Number(draggingId.value)
  endCategoryDrag()
  if (!sourceId || target.orphan || search.value.trim() || Number(target.id) === sourceId) return
  const ordered = managedCategories()
  const sourceIndex = ordered.findIndex(category => Number(category.id) === sourceId)
  const targetIndex = ordered.findIndex(category => Number(category.id) === Number(target.id))
  if (sourceIndex < 0 || targetIndex < 0) return
  const next = [...ordered]
  const [moved] = next.splice(sourceIndex, 1)
  next.splice(targetIndex, 0, moved)
  const orphans = categories.value.filter(category => category.orphan)
  categories.value = [...next.map((category, index) => ({ ...category, sort_order: (index + 1) * 10 })), ...orphans]
  ordering.value = true
  try {
    await reorderMenuCategories(next.map(category => category.id))
    window.dispatchEvent(new CustomEvent('menu-category-order-changed'))
    ElMessage.success('分类顺序已更新，所有菜品选择器将按此顺序显示')
  } catch (error) {
    ElMessage.error('排序保存失败：' + error.message)
    await loadData()
  } finally {
    ordering.value = false
  }
}
async function adoptCategory(row) {
  try {
    await adoptMenuCategory(row.name)
    ElMessage.success(`分类「${row.name}」已收录`)
    await loadData()
  } catch (error) {
    ElMessage.error('收录失败：' + error.message)
  }
}

async function removeCategory(row) {
  const tip = row.dish_count
    ? `删除分类「${row.name}」后，该分类下 ${row.dish_count} 个菜品将变为「未分类」，确定删除吗？`
    : `确定删除分类「${row.name}」吗？`
  try {
    await ElMessageBox.confirm(tip, '删除分类', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch { return }
  try {
    const res = await deleteMenuCategory(row.id)
    ElMessage.success(res.clearedDishes ? `分类已删除，${res.clearedDishes} 个菜品已变为未分类` : '分类已删除')
    await loadData()
  } catch (error) {
    ElMessage.error('删除失败：' + error.message)
  }
}

async function loadData() {
  loading.value = true
  try {
    const res = await getMenuCategoryList()
    categories.value = res.categories || []
  } catch (error) {
    ElMessage.error('加载失败：' + error.message)
  } finally {
    loading.value = false
  }
}

onMounted(loadData)
</script>

<style scoped>
.category-name-cell { border-radius: 7px; transition: background .15s ease, transform .15s ease; }
.category-name-cell.is-draggable { cursor: grab; }
.category-name-cell.is-draggable:active { cursor: grabbing; }
.category-name-cell.is-drop-target { background: #edf4ff; transform: translateX(4px); }
.category-order-index { display: inline-grid; width: 22px; height: 22px; place-items: center; flex: 0 0 auto; border-radius: 5px; background: #f1f5fb; color: #6b7e97; font-size: 12px; font-variant-numeric: tabular-nums; }
.category-name-cell.is-drop-target .category-order-index { background: #dceaff; color: #2563d8; }
</style>