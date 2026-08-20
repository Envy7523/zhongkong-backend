<template>
  <div>
    <BookkeepingHeader active="categories" />

    <div class="category-layout">
      <!-- 左栏：大类 -->
      <section class="card-compact category-panel">
        <header class="panel-header">
          <div>
            <div class="panel-title">品类大类</div>
            <span class="panel-subtitle">共 {{ categories.length }} 个分类</span>
          </div>
          <el-button type="primary" size="small" @click="openCategoryDialog()">＋ 新建大类</el-button>
        </header>

        <div v-loading="loadingCategories" class="category-list">
          <div
            v-for="cat in categories"
            :key="cat.id"
            class="category-item"
            :class="{ selected: selectedCategory?.id === cat.id }"
            @click="selectCategory(cat)"
          >
            <span
              class="category-tag"
              :style="{ background: cat.color || '#409eff', borderColor: cat.color || '#409eff' }"
            ></span>
            <span class="category-name">{{ cat.name }}</span>
            <span class="category-count">{{ cat.subcategory_count ?? 0 }} 小类</span>
            <span class="category-actions" @click.stop>
              <el-button link type="primary" size="small" @click="openCategoryDialog(cat)">编辑</el-button>
              <el-popconfirm
                :title="`确定删除大类「${cat.name}」吗？`"
                width="240"
                confirm-button-text="删除"
                cancel-button-text="取消"
                confirm-button-type="danger"
                @confirm="removeCategory(cat)"
              >
                <template #reference>
                  <el-button link type="danger" size="small">删除</el-button>
                </template>
              </el-popconfirm>
            </span>
          </div>

          <el-empty v-if="!loadingCategories && categories.length === 0" description="暂无大类，点击右上角新建" />
        </div>
      </section>

      <!-- 右栏：小类 -->
      <section class="card-compact category-panel">
        <header class="panel-header">
          <div>
            <div class="panel-title">小类管理</div>
            <span class="panel-subtitle">
              {{ selectedCategory ? `「${selectedCategory.name}」下共 ${subcategories.length} 个小类` : '请先在大类中选择一个分类' }}
            </span>
          </div>
          <el-button
            type="primary"
            size="small"
            :disabled="!selectedCategory"
            @click="openSubcategoryDialog()"
          >＋ 新建小类</el-button>
        </header>

        <div v-loading="loadingSubcategories" class="category-list">
          <div
            v-for="sub in subcategories"
            :key="sub.id"
            class="category-item subcategory"
          >
            <span class="category-tag" :style="{ background: selectedCategory?.color || '#409eff' }"></span>
            <span class="category-name">{{ sub.name }}</span>
            <span class="category-actions" @click.stop>
              <el-button link type="primary" size="small" @click="openSubcategoryDialog(sub)">编辑</el-button>
              <el-popconfirm
                :title="`确定删除小类「${sub.name}」吗？`"
                width="240"
                confirm-button-text="删除"
                cancel-button-text="取消"
                confirm-button-type="danger"
                @confirm="removeSubcategory(sub)"
              >
                <template #reference>
                  <el-button link type="danger" size="small">删除</el-button>
                </template>
              </el-popconfirm>
            </span>
          </div>

          <el-empty v-if="!loadingSubcategories && subcategories.length === 0" :description="selectedCategory ? '暂无小类，点击右上角新建' : '请在左侧选择大类'" />
        </div>
      </section>
    </div>

    <!-- 大类新增 / 编辑 -->
    <el-dialog
      v-model="categoryDialogVisible"
      :title="categoryForm.id ? '编辑大类' : '新建大类'"
      width="440px"
      align-center
      class="category-dialog"
      @closed="resetCategoryForm"
    >
      <el-form label-position="top">
        <el-form-item label="大类名称" required>
          <el-input v-model="categoryForm.name" maxlength="30" placeholder="请输入大类名称" />
        </el-form-item>
        <el-form-item label="标签颜色">
          <div class="color-picker">
            <span
              v-for="c in colorOptions"
              :key="c"
              class="color-dot"
              :class="{ active: categoryForm.color === c }"
              :style="{ background: c }"
              @click="categoryForm.color = c"
            ></span>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="categoryDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="savingCategory" @click="saveCategory">
          {{ categoryForm.id ? '保存修改' : '创建大类' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 小类新增 / 编辑 -->
    <el-dialog
      v-model="subcategoryDialogVisible"
      :title="subcategoryForm.id ? '编辑小类' : '新建小类'"
      width="440px"
      align-center
      class="category-dialog"
      @closed="resetSubcategoryForm"
    >
      <el-form label-position="top">
        <el-form-item label="所属大类" required>
          <el-input :model-value="selectedCategory?.name" disabled placeholder="请先在左侧选择大类" />
        </el-form-item>
        <el-form-item label="小类名称" required>
          <el-input v-model="subcategoryForm.name" maxlength="30" placeholder="请输入小类名称" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="subcategoryDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="savingSubcategory" @click="saveSubcategory">
          {{ subcategoryForm.id ? '保存修改' : '创建小类' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  getBookkeepingCategories,
  createBookkeepingCategory,
  updateBookkeepingCategory,
  deleteBookkeepingCategory,
  getBookkeepingSubcategories,
  createBookkeepingSubcategory,
  updateBookkeepingSubcategory,
  deleteBookkeepingSubcategory
} from '@/api'
import BookkeepingHeader from './BookkeepingHeader.vue'

const colorOptions = ['#409eff', '#67c23a', '#e6a23c', '#f56c6c', '#909399', '#9c27b0', '#00bcd4', '#ff7043']

const categories = ref([])
const selectedCategory = ref(null)
const subcategories = ref([])
const loadingCategories = ref(false)
const loadingSubcategories = ref(false)

const categoryDialogVisible = ref(false)
const categoryForm = ref({ id: null, name: '', color: colorOptions[0] })
const savingCategory = ref(false)

const subcategoryDialogVisible = ref(false)
const subcategoryForm = ref({ id: null, name: '' })
const savingSubcategory = ref(false)

onMounted(loadCategories)

async function loadCategories() {
  loadingCategories.value = true
  try {
    const data = await getBookkeepingCategories()
    categories.value = data?.categories || data || []
    // 保持当前选中分类的有效性
    if (selectedCategory.value) {
      const current = categories.value.find(c => c.id === selectedCategory.value.id)
      if (current) {
        selectedCategory.value = current
      } else {
        selectedCategory.value = null
      }
    }
  } catch (e) {
    ElMessage.error('加载大类失败：' + (e?.message || '网络错误'))
  } finally {
    loadingCategories.value = false
  }
}

async function loadSubcategories(categoryId) {
  loadingSubcategories.value = true
  subcategories.value = []
  try {
    const data = await getBookkeepingSubcategories({ category_id: categoryId })
    subcategories.value = data?.subcategories || data || []
  } catch (e) {
    ElMessage.error('加载小类失败：' + (e?.message || '网络错误'))
  } finally {
    loadingSubcategories.value = false
  }
}

function selectCategory(cat) {
  selectedCategory.value = cat
  loadSubcategories(cat.id)
}

function openCategoryDialog(cat) {
  if (cat) {
    categoryForm.value = { id: cat.id, name: cat.name, color: cat.color || colorOptions[0] }
  } else {
    categoryForm.value = { id: null, name: '', color: colorOptions[0] }
  }
  categoryDialogVisible.value = true
}

function resetCategoryForm() {
  categoryForm.value = { id: null, name: '', color: colorOptions[0] }
}

async function saveCategory() {
  const { id, name, color } = categoryForm.value
  if (!name || !name.trim()) {
    ElMessage.warning('请输入大类名称')
    return
  }
  savingCategory.value = true
  try {
    if (id) {
      await updateBookkeepingCategory(id, { name: name.trim(), color })
      ElMessage.success('大类已更新')
    } else {
      await createBookkeepingCategory({ name: name.trim(), color })
      ElMessage.success('大类已创建')
    }
    categoryDialogVisible.value = false
    await loadCategories()
  } catch (e) {
    ElMessage.error('保存失败：' + (e?.message || '网络错误'))
  } finally {
    savingCategory.value = false
  }
}

async function removeCategory(cat) {
  try {
    await deleteBookkeepingCategory(cat.id)
    ElMessage.success('大类已删除')
    if (selectedCategory.value?.id === cat.id) {
      selectedCategory.value = null
      subcategories.value = []
    }
    await loadCategories()
  } catch (e) {
    ElMessage.error('删除失败：' + (e?.message || '网络错误'))
  }
}

function openSubcategoryDialog(sub) {
  if (!selectedCategory.value) {
    ElMessage.warning('请先在左侧选择大类')
    return
  }
  if (sub) {
    subcategoryForm.value = { id: sub.id, name: sub.name }
  } else {
    subcategoryForm.value = { id: null, name: '' }
  }
  subcategoryDialogVisible.value = true
}

function resetSubcategoryForm() {
  subcategoryForm.value = { id: null, name: '' }
}

async function saveSubcategory() {
  const { id, name } = subcategoryForm.value
  if (!name || !name.trim()) {
    ElMessage.warning('请输入小类名称')
    return
  }
  if (!selectedCategory.value) {
    ElMessage.warning('请先在左侧选择大类')
    return
  }
  savingSubcategory.value = true
  try {
    if (id) {
      await updateBookkeepingSubcategory(id, { name: name.trim() })
      ElMessage.success('小类已更新')
    } else {
      await createBookkeepingSubcategory({ name: name.trim(), category_id: selectedCategory.value.id })
      ElMessage.success('小类已创建')
    }
    subcategoryDialogVisible.value = false
    await loadSubcategories(selectedCategory.value.id)
    await loadCategories()
  } catch (e) {
    ElMessage.error('保存失败：' + (e?.message || '网络错误'))
  } finally {
    savingSubcategory.value = false
  }
}

async function removeSubcategory(sub) {
  try {
    await deleteBookkeepingSubcategory(sub.id)
    ElMessage.success('小类已删除')
    if (selectedCategory.value) {
      await loadSubcategories(selectedCategory.value.id)
      await loadCategories()
    }
  } catch (e) {
    ElMessage.error('删除失败：' + (e?.message || '网络错误'))
  }
}

watch(selectedCategory, (cat) => {
  if (!cat) {
    subcategories.value = []
  }
})
</script>

<style scoped>
.category-layout {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  align-items: start;
}

.card-compact {
  background: #fff;
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #f0f0f0;
}

.panel-title {
  font-size: 16px;
  font-weight: 600;
  color: #1f2d3d;
}

.panel-subtitle {
  font-size: 12px;
  color: #909399;
}

.category-list {
  min-height: 240px;
  max-height: 520px;
  overflow-y: auto;
}

.category-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.category-item:hover {
  background: #f5f7fa;
}

.category-item.selected {
  background: #ecf5ff;
}

.category-item.subcategory {
  cursor: default;
}

.category-tag {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 3px;
  border: 1px solid transparent;
}

.category-name {
  flex: 1;
  font-size: 14px;
  color: #303133;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.category-count {
  flex: none;
  font-size: 12px;
  color: #909399;
  background: #f5f7fa;
  border-radius: 12px;
  padding: 2px 8px;
}

.category-actions {
  flex: none;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.category-item:hover .category-actions {
  opacity: 1;
}

.color-picker {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.color-dot {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  cursor: pointer;
  border: 2px solid transparent;
  transition: transform 0.1s ease;
}

.color-dot:hover {
  transform: scale(1.1);
}

.color-dot.active {
  border-color: #fff;
  box-shadow: 0 0 0 2px #409eff;
}

@media (max-width: 900px) {
  .category-layout {
    grid-template-columns: 1fr;
  }
}
</style>
