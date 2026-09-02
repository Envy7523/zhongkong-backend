<template>
  <div class="bookkeeping-entry">
    <BookkeepingHeader active="entry" />

    <el-card class="entry-card" shadow="never">
      <div class="store-info">
        <span class="label">门店：{{ storeName }}</span>
      </div>

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="90px"
        label-position="right"
        class="entry-form"
      >
        <el-form-item label="日期" prop="date">
          <el-date-picker
            v-model="form.date"
            :clearable="false"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="选择日期"
            style="width: 100%"
          />
        </el-form-item>

        <el-form-item label="分类" prop="category_id">
          <el-select
            v-model="form.category_id"
            placeholder="请选择分类"
            style="width: 100%"
            @change="handleCategoryChange"
          >
            <el-option
              v-for="cat in categories"
              :key="cat.id"
              :label="cat.name"
              :value="cat.id"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="子分类" prop="subcategory_id">
          <el-select
            v-model="form.subcategory_id"
            placeholder="请先选择分类"
            :disabled="!form.category_id"
            style="width: 100%"
          >
            <el-option
              v-for="sub in subcategories"
              :key="sub.id"
              :label="sub.name"
              :value="sub.id"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="金额" prop="amount">
          <el-input-number
            v-model="form.amount"
            :precision="2"
            :min="0"
            :controls="false"
            style="width: 100%"
            placeholder="请输入金额"
          />
        </el-form-item>

        <el-form-item label="图片" prop="images">
          <el-upload
            v-model:file-list="fileList"
            action="#"
            list-type="picture-card"
            :limit="5"
            accept="image/*"
            :auto-upload="false"
            :on-change="handleImageChange"
            :on-remove="handleImageRemove"
            :on-exceed="handleImageExceed"
          >
            <el-icon><Plus /></el-icon>
          </el-upload>
          <div class="el-upload__tip">最多上传 5 张图片</div>
        </el-form-item>

        <el-form-item label="备注" prop="remark">
          <el-input
            v-model="form.remark"
            type="textarea"
            :rows="3"
            placeholder="请输入备注"
          />
        </el-form-item>

        <el-form-item>
          <el-button type="primary" :loading="submitting" @click="handleSubmit">
            提交
          </el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { getBookkeepingCategories, getBookkeepingSubcategories, createBookkeepingEntry } from '@/api'
import { useAuthStore } from '@/stores/auth'
import BookkeepingHeader from './BookkeepingHeader.vue'

const authStore = useAuthStore()

const storeName = computed(() => {
  return authStore.user?.store_name || ''
})

const formRef = ref(null)
const categories = ref([])
const subcategories = ref([])
const fileList = ref([])
const submitting = ref(false)

const form = reactive({
  date: getToday(),
  category_id: null,
  category_name: '',
  subcategory_id: null,
  subcategory_name: '',
  amount: null,
  images: [],
  remark: ''
})

const rules = {
  date: [{ required: true, message: '请选择日期', trigger: 'change' }],
  category_id: [{ required: true, message: '请选择分类', trigger: 'change' }],
  subcategory_id: [{ required: true, message: '请选择子分类', trigger: 'change' }],
  amount: [{ required: true, message: '请输入金额', trigger: 'change' }]
}

function getToday() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

async function loadCategories() {
  try {
    const res = await getBookkeepingCategories()
    categories.value = res?.data || res || []
  } catch (e) {
    ElMessage.error('加载分类失败')
  }
}

async function loadSubcategories(categoryId) {
  subcategories.value = []
  form.subcategory_id = null
  form.subcategory_name = ''
  if (!categoryId) return
  try {
    const res = await getBookkeepingSubcategories(categoryId)
    subcategories.value = res?.data || res || []
  } catch (e) {
    ElMessage.error('加载子分类失败')
  }
}

function handleCategoryChange(categoryId) {
  const cat = categories.value.find((c) => c.id === categoryId)
  form.category_name = cat?.name || ''
  form.subcategory_id = null
  form.subcategory_name = ''
  loadSubcategories(categoryId)
}

function handleImageChange(file, fileListArr) {
  if (file && file.raw) {
    const reader = new FileReader()
    reader.onload = (e) => {
      file.url = e.target.result
      syncImages()
    }
    reader.readAsDataURL(file.raw)
  }
}

function handleImageRemove() {
  syncImages()
}

function handleImageExceed(files) {
  ElMessage.warning('最多只能上传 5 张图片')
}

function syncImages() {
  form.images = fileList.value
    .map((f) => f.url)
    .filter((url) => !!url)
}

async function handleSubmit() {
  const valid = await formRef.value.validate()
  if (!valid) return

  const payload = {
    date: form.date,
    category_id: form.category_id,
    category_name: form.category_name,
    subcategory_id: form.subcategory_id,
    subcategory_name: form.subcategory_name,
    amount: form.amount,
    images: form.images,
    remark: form.remark
  }

  submitting.value = true
  try {
    await createBookkeepingEntry(payload)
    ElMessage.success('记账成功')
    resetForm()
  } catch (e) {
    ElMessage.error(e?.response?.data?.message || '提交失败，请稍后再试')
  } finally {
    submitting.value = false
  }
}

function handleReset() {
  resetForm()
  formRef.value?.clearValidate()
}

function resetForm() {
  form.date = getToday()
  form.category_id = null
  form.category_name = ''
  form.subcategory_id = null
  form.subcategory_name = ''
  form.amount = null
  form.images = []
  form.remark = ''
  fileList.value = []
  subcategories.value = []
}

onMounted(() => {
  loadCategories()
})
</script>

<style scoped>
.bookkeeping-entry {
  padding: 16px;
}

.store-info {
  display: flex;
  align-items: center;
  font-size: 14px;
  color: #303133;
  margin-bottom: 16px;
}

.store-info .label {
  font-weight: 600;
}

.entry-card {
  max-width: 640px;
  border-radius: 8px;
}

.entry-form {
  padding: 8px 0;
}

:deep(.el-upload-list--picture-card .el-upload-list__item) {
  width: 80px;
  height: 80px;
}

:deep(.el-upload--picture-card) {
  width: 80px;
  height: 80px;
}

.el-upload__tip {
  width: 100%;
  font-size: 12px;
  color: #909399;
  margin-top: 8px;
}
</style>
