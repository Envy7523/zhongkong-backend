<template>
  <div class="menu-module-page">
    <MenuModuleHeader
      title="菜品模板"
      description="为不同门店或地域创建独立菜单模板，自定义菜品名称、价格与分类。"
      active="menu-management-template"
      :metrics="heroMetrics"
    />

    <div class="template-layout">
      <!-- 左侧：模板列表 -->
      <aside class="template-sidebar">
        <header>
          <h4>模板列表</h4>
          <el-button type="primary" size="small" round @click="openCreateTemplate">新建模板</el-button>
        </header>
        <div v-loading="templateLoading" class="template-list">
          <div v-if="templates.length === 0 && !templateLoading" class="template-empty">暂无模板，点击上方按钮创建</div>
          <button
            v-for="tpl in templates"
            :key="tpl.id"
            :class="['template-card', { active: selectedId === tpl.id }]"
            @click="selectTemplate(tpl)"
          >
            <strong>{{ tpl.name }}</strong>
            <small>{{ tpl.remark || '暂无备注' }}</small>
            <time>{{ formatDate(tpl.updated_at) }}</time>
          </button>
        </div>
      </aside>

      <!-- 右侧：模板详情 -->
      <section class="template-detail">
        <template v-if="!selectedTemplate && !detailLoading">
          <div class="template-placeholder">
            <div class="placeholder-icon">📋</div>
            <p>选择一个模板查看和编辑其菜品</p>
          </div>
        </template>

        <template v-if="selectedTemplate">
          <header class="detail-header">
            <div>
              <h3>{{ selectedTemplate.name }}</h3>
              <span>{{ selectedTemplate.remark || '暂无备注' }}</span>
            </div>
            <div class="detail-actions">
              <el-button text @click="openEditTemplate">重命名</el-button>
              <el-button text type="danger" @click="removeTemplate">删除模板</el-button>
            </div>
          </header>

          <div class="metric-strip">
            <div class="metric-card"><span>菜品数量</span><strong>{{ items.length }}</strong><small>{{ categoryCount }} 个分类</small></div>
            <div class="metric-card"><span>堂食均价</span><strong>¥{{ avgPrice('dine_in_price') }}</strong><small>模板定价</small></div>
            <div class="metric-card"><span>会员均价</span><strong>¥{{ avgPrice('member_price') }}</strong><small>模板定价</small></div>
            <div class="metric-card"><span>外卖均价</span><strong>¥{{ avgPrice('takeout_price') }}</strong><small>模板定价</small></div>
          </div>

          <section class="menu-panel">
            <header class="menu-panel-header">
              <div class="menu-panel-title"><h3>模板菜品</h3><span>编辑菜品名称、渠道价格与分类，成本取自系统当前数据（不可编辑）</span></div>
              <el-button type="primary" round @click="openCreateItem">新增菜品</el-button>
            </header>

            <el-table v-loading="detailLoading" :data="items" class="menu-data-table" row-key="id">
              <el-table-column label="菜品" min-width="180">
                <template #default="{ row }">
                  <div class="dish-name"><span class="dish-monogram">{{ String(row.name || '菜').slice(0,1) }}</span><div><b>{{ row.name }}</b></div></div>
                </template>
              </el-table-column>
              <el-table-column label="分类" min-width="110">
                <template #default="{ row }"><span class="menu-category">{{ row.category || '未分类' }}</span></template>
              </el-table-column>
              <el-table-column label="堂食价" width="100" align="right">
                <template #default="{ row }"><span class="menu-price">¥{{ fmt(row.dine_in_price) }}</span></template>
              </el-table-column>
              <el-table-column label="会员价" width="100" align="right">
                <template #default="{ row }"><span class="menu-price member">¥{{ fmt(row.member_price) }}</span></template>
              </el-table-column>
              <el-table-column label="外卖价" width="100" align="right">
                <template #default="{ row }"><span class="menu-price takeout">¥{{ fmt(row.takeout_price) }}</span></template>
              </el-table-column>
              <el-table-column label="系统成本" width="100" align="right">
                <template #default="{ row }"><span class="menu-price cost">¥{{ fmt(row.system_cost) }}</span></template>
              </el-table-column>
              <el-table-column label="操作" width="130" fixed="right" align="right">
                <template #default="{ row }">
                  <div class="row-actions">
                    <el-button link type="primary" @click="openEditItem(row)">编辑</el-button>
                    <el-button link type="danger" @click="removeItem(row)">删除</el-button>
                  </div>
                </template>
              </el-table-column>
            </el-table>
            <div v-if="!detailLoading && items.length === 0" class="menu-empty">模板暂无菜品，点击「新增菜品」添加</div>
          </section>
        </template>
      </section>
    </div>

    <!-- 模板创建/编辑弹窗 -->
    <el-dialog v-model="templateDialogVisible" :title="editingTemplateId ? '编辑模板' : '新建模板'" width="460px" align-center class="menu-dialog">
      <el-form label-position="top">
        <el-form-item label="模板名称" required><el-input v-model="templateForm.name" maxlength="50" placeholder="例如：华南地区标准菜单" /></el-form-item>
        <el-form-item label="备注说明"><el-input v-model="templateForm.remark" type="textarea" :rows="2" maxlength="200" placeholder="可选，说明模板适用门店或地域" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="templateDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveTemplate">保存</el-button>
      </template>
    </el-dialog>

    <!-- 菜品创建/编辑弹窗 -->
    <el-dialog v-model="itemDialogVisible" :title="editingItemId ? '编辑菜品' : '新增菜品'" width="600px" align-center class="menu-dialog">
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="菜品名称" required><el-input v-model="itemForm.name" maxlength="50" placeholder="请输入菜品名称" /></el-form-item>
          <el-form-item label="菜品分类" required>
            <el-select v-model="itemForm.category" placeholder="选择分类" style="width:100%">
              <el-option v-for="cat in categories" :key="cat" :label="cat" :value="cat" />
            </el-select>
          </el-form-item>
        </div>
        <div class="form-section-label">渠道价格</div>
        <div class="form-grid three">
          <el-form-item label="堂食价"><el-input-number v-model="itemForm.dine_in_price" :min="0" :precision="2" :controls="false" style="width:100%" /></el-form-item>
          <el-form-item label="会员价"><el-input-number v-model="itemForm.member_price" :min="0" :precision="2" :controls="false" style="width:100%" /></el-form-item>
          <el-form-item label="外卖价"><el-input-number v-model="itemForm.takeout_price" :min="0" :precision="2" :controls="false" style="width:100%" /></el-form-item>
        </div>
        <div class="form-tip">成本取自系统当前数据，模板中不单独设置</div>
      </el-form>
      <template #footer>
        <el-button @click="itemDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveItem">保存菜品</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, reactive } from 'vue'
import {
  getMenuTemplates, createMenuTemplate, updateMenuTemplate, deleteMenuTemplate,
  getMenuTemplateDetail, createTemplateItem, updateTemplateItem, deleteTemplateItem,
  getMenuCategories,
} from '@/api'
import { ElMessage, ElMessageBox } from 'element-plus'
import MenuModuleHeader from './MenuModuleHeader.vue'
import './menu-theme.css'

// ===== 状态 =====
const templates = ref([])
const categories = ref([])
const templateLoading = ref(false)
const detailLoading = ref(false)
const saving = ref(false)
const selectedId = ref(null)
const selectedTemplate = ref(null)
const items = ref([])

// 模板弹窗
const templateDialogVisible = ref(false)
const editingTemplateId = ref(null)
const templateForm = reactive({ name: '', remark: '' })

// 菜品弹窗
const itemDialogVisible = ref(false)
const editingItemId = ref(null)
const emptyItemForm = () => ({ name: '', category: '', dine_in_price: 0, member_price: 0, takeout_price: 0 })
const itemForm = reactive(emptyItemForm())

// ===== 计算属性 =====
const heroMetrics = computed(() => [
  { label: '模板总数', value: templates.value.length, tone: 'success' },
  { label: '菜品总数', value: items.value.length },
])
const categoryCount = computed(() => new Set(items.value.map(i => i.category).filter(Boolean)).size)

// ===== 格式化 =====
function fmt(v) { return (Number(v) || 0).toFixed(2) }
function formatDate(v) { return v ? String(v).slice(0, 10) : '' }
function avgPrice(field) {
  const vals = items.value.map(i => Number(i[field]) || 0).filter(v => v > 0)
  return vals.length ? (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2) : '0.00'
}

// ===== 模板 CRUD =====
async function loadTemplates() {
  templateLoading.value = true
  try { const res = await getMenuTemplates(); templates.value = res.templates || [] }
  catch (e) { ElMessage.error('加载模板失败：' + e.message) }
  finally { templateLoading.value = false }
}

function openCreateTemplate() {
  editingTemplateId.value = null
  templateForm.name = ''
  templateForm.remark = ''
  templateDialogVisible.value = true
}

function openEditTemplate() {
  if (!selectedTemplate.value) return
  editingTemplateId.value = selectedTemplate.value.id
  templateForm.name = selectedTemplate.value.name
  templateForm.remark = selectedTemplate.value.remark || ''
  templateDialogVisible.value = true
}

async function saveTemplate() {
  const name = templateForm.name.trim()
  if (!name) return ElMessage.warning('模板名称不能为空')
  saving.value = true
  try {
    if (editingTemplateId.value) {
      await updateMenuTemplate(editingTemplateId.value, { name, remark: templateForm.remark })
      ElMessage.success('模板已更新')
    } else {
      await createMenuTemplate({ name, remark: templateForm.remark })
      ElMessage.success('模板已创建')
    }
    templateDialogVisible.value = false
    await loadTemplates()
    if (editingTemplateId.value && selectedId.value === editingTemplateId.value) {
      await selectTemplate(templates.value.find(t => t.id === editingTemplateId.value))
    }
  } catch (e) { ElMessage.error(e.message) }
  finally { saving.value = false }
}

async function removeTemplate() {
  if (!selectedTemplate.value) return
  try {
    await ElMessageBox.confirm(`删除模板「${selectedTemplate.value.name}」后，其下所有菜品将被移除。`, '删除模板', { type: 'error', confirmButtonText: '删除' })
    await deleteMenuTemplate(selectedTemplate.value.id)
    ElMessage.success('模板已删除')
    selectedId.value = null
    selectedTemplate.value = null
    items.value = []
    await loadTemplates()
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(e.message)
  }
}

async function selectTemplate(tpl) {
  if (!tpl) return
  selectedId.value = tpl.id
  detailLoading.value = true
  try {
    const res = await getMenuTemplateDetail(tpl.id)
    selectedTemplate.value = res.template
    items.value = res.items || []
  } catch (e) { ElMessage.error('加载模板详情失败：' + e.message) }
  finally { detailLoading.value = false }
}

// ===== 菜品 CRUD =====
function openCreateItem() {
  editingItemId.value = null
  Object.assign(itemForm, emptyItemForm())
  itemDialogVisible.value = true
}

function openEditItem(row) {
  editingItemId.value = row.id
  itemForm.name = row.name
  itemForm.category = row.category || ''
  itemForm.dine_in_price = Number(row.dine_in_price) || 0
  itemForm.member_price = Number(row.member_price) || 0
  itemForm.takeout_price = Number(row.takeout_price) || 0
  itemDialogVisible.value = true
}

async function saveItem() {
  const name = itemForm.name.trim()
  if (!name) return ElMessage.warning('菜品名称不能为空')
  if (!itemForm.category) return ElMessage.warning('请选择分类')
  saving.value = true
  try {
    const data = {
      name,
      category: itemForm.category,
      dine_in_price: Number(itemForm.dine_in_price) || 0,
      member_price: Number(itemForm.member_price) || 0,
      takeout_price: Number(itemForm.takeout_price) || 0,
    }
    if (editingItemId.value) {
      await updateTemplateItem(selectedId.value, editingItemId.value, data)
      ElMessage.success('菜品已更新')
    } else {
      await createTemplateItem(selectedId.value, data)
      ElMessage.success('菜品已添加')
    }
    itemDialogVisible.value = false
    // 重新加载模板详情
    await selectTemplate(templates.value.find(t => t.id === selectedId.value))
  } catch (e) { ElMessage.error(e.message) }
  finally { saving.value = false }
}

async function removeItem(row) {
  try {
    await ElMessageBox.confirm(`确定从模板中移除「${row.name}」？`, '删除菜品', { type: 'warning', confirmButtonText: '移除' })
    await deleteTemplateItem(selectedId.value, row.id)
    ElMessage.success('菜品已移除')
    await selectTemplate(templates.value.find(t => t.id === selectedId.value))
    await loadTemplates()
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(e.message)
  }
}

async function refreshMenuCategories() {
  try { const res = await getMenuCategories(); categories.value = res.categories || [] }
  catch { /* 保留当前分类 */ }
}
const refreshMenuCategoryOrder = () => refreshMenuCategories()
// ===== 初始化 =====
onMounted(async () => {
  window.addEventListener('menu-category-order-changed', refreshMenuCategoryOrder)
  await loadTemplates()
  await refreshMenuCategories()
})
onBeforeUnmount(() => window.removeEventListener('menu-category-order-changed', refreshMenuCategoryOrder))
</script>

<style scoped>
.template-layout {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 20px;
  align-items: start;
}

.template-sidebar {
  border: 1px solid #e3e9f1;
  border-radius: 12px;
  background: #fff;
  overflow: hidden;
  box-shadow: 0 4px 12px rgba(16,24,40,.03);
}
.template-sidebar header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid #eef1f5;
}
.template-sidebar header h4 { margin: 0; font-size: 15px; color: #25354d; }
.template-list { padding: 8px; min-height: 120px; max-height: calc(100vh - 260px); overflow-y: auto; }
.template-empty { padding: 32px 16px; text-align: center; color: #98a2b3; font-size: 13px; }

.template-card {
  display: block;
  width: 100%;
  padding: 12px 14px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: #fff;
  text-align: left;
  cursor: pointer;
  transition: border-color .15s, background .15s;
  margin-bottom: 6px;
}
.template-card:hover { border-color: #cddbea; background: #f8fafc; }
.template-card.active { border-color: #409eff; background: #eef7ff; }
.template-card strong { display: block; font-size: 14px; color: #25354d; margin-bottom: 3px; }
.template-card small { display: block; font-size: 12px; color: #8492a6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.template-card time { display: block; font-size: 11px; color: #a1acba; margin-top: 5px; }

.template-detail { min-height: 400px; }
.template-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 350px;
  border: 2px dashed #dbe4ed;
  border-radius: 12px;
  color: #98a2b3;
}
.placeholder-icon { font-size: 48px; margin-bottom: 12px; }

.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid #eef1f5;
}
.detail-header h3 { margin: 0 0 4px; font-size: 20px; color: #25354d; }
.detail-header span { font-size: 13px; color: #8492a6; }
.detail-actions { display: flex; gap: 4px; flex-shrink: 0; }

.member { color: #48a572; }
.takeout { color: #e6a23c; }
.cost { color: #8492a6; }

@media (max-width: 860px) {
  .template-layout { grid-template-columns: 1fr; }
  .template-sidebar { max-height: 220px; }
}
</style>
