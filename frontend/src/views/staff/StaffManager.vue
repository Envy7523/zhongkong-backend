<template>
  <!-- 统计卡片 -->
  <div class="dash-stat-grid">
    <div class="dash-stat-card">
      <div class="dash-stat-icon" style="background:#e8f8e8;"><el-icon size="22"><UserFilled /></el-icon></div>
      <div class="dash-stat-body">
        <div class="dash-stat-value success">{{ stats.total ?? '—' }}</div>
        <div class="dash-stat-label">店长总数</div>
      </div>
    </div>
    <div class="dash-stat-card">
      <div class="dash-stat-icon" style="background:#e8f4ff;"><el-icon size="22"><CircleCheckFilled /></el-icon></div>
      <div class="dash-stat-body">
        <div class="dash-stat-value primary">{{ stats.active ?? '—' }}</div>
        <div class="dash-stat-label">在职店长</div>
      </div>
    </div>
    <div class="dash-stat-card">
      <div class="dash-stat-icon" style="background:#fff0f0;"><el-icon size="22"><CircleCloseFilled /></el-icon></div>
      <div class="dash-stat-body">
        <div class="dash-stat-value danger">{{ stats.inactive ?? '—' }}</div>
        <div class="dash-stat-label">离职店长</div>
      </div>
    </div>
  </div>

  <!-- 搜索区 -->
  <div class="card-compact">
    <div class="card-header">🔍 搜索店长</div>
    <el-row :gutter="12" style="margin-bottom:0;">
      <el-col :span="6">
        <el-input v-model="keyword" placeholder="姓名" clearable />
      </el-col>
      <el-col :span="4">
        <el-select v-model="status" placeholder="状态" clearable style="width:100%;">
          <el-option label="在职" value="在职" />
          <el-option label="离职" value="离职" />
        </el-select>
      </el-col>
      <el-col :span="6">
        <el-input v-model="storeName" placeholder="所属门店" clearable />
      </el-col>
      <el-col :span="4">
        <el-button type="primary" @click="search">🔍 查询</el-button>
      </el-col>
    </el-row>
  </div>

  <!-- 表格 -->
  <div class="card-compact">
    <div class="card-header">👤 店长列表（共 {{ total }} 人）</div>
    <el-table :data="list" style="width:100%;" v-loading="loading" stripe>
      <el-table-column prop="name" label="姓名" min-width="120" fixed="left" />
      <el-table-column prop="phone" label="手机号" width="130" />
      <el-table-column prop="store_name" label="所属门店" min-width="160" show-overflow-tooltip />
      <el-table-column prop="gender" label="性别" width="70" />
      <el-table-column prop="age" label="年龄" width="70" />
      <el-table-column prop="entry_date" label="入职日期" width="110" />
      <el-table-column prop="status" label="状态" width="80">
        <template #default="{ row }">
          <el-tag :type="row.status === '在职' ? 'success' : 'info'" size="small">{{ row.status || '—' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="remark" label="备注" min-width="140" show-overflow-tooltip />
      <el-table-column label="操作" width="80" fixed="right">
        <template #default="{ row }">
          <el-button size="small" @click="openEdit(row)">编辑</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination
      v-if="total > pageSize"
      style="margin-top:16px;justify-content:flex-end;"
      v-model:current-page="page"
      :page-size="pageSize"
      :total="total"
      layout="total, prev, pager, next"
      @current-change="loadData"
    />
  </div>

  <!-- 编辑弹窗 -->
  <el-dialog v-model="editVisible" :title="'编辑店长 — ' + editForm.name" width="600px">
    <el-form label-width="100px">
      <el-row :gutter="12">
        <el-col :span="12"><el-form-item label="姓名"><el-input v-model="editForm.name" /></el-form-item></el-col>
        <el-col :span="12"><el-form-item label="手机号"><el-input v-model="editForm.phone" /></el-form-item></el-col>
      </el-row>
      <el-row :gutter="12">
        <el-col :span="12">
          <el-form-item label="性别">
            <el-select v-model="editForm.gender" style="width:100%;">
              <el-option label="男" value="男" />
              <el-option label="女" value="女" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="12"><el-form-item label="年龄"><el-input v-model="editForm.age" /></el-form-item></el-col>
      </el-row>
      <el-row :gutter="12">
        <el-col :span="12"><el-form-item label="所属门店"><el-input v-model="editForm.store_name" /></el-form-item></el-col>
        <el-col :span="12">
          <el-form-item label="状态">
            <el-select v-model="editForm.status" style="width:100%;">
              <el-option label="在职" value="在职" />
              <el-option label="离职" value="离职" />
            </el-select>
          </el-form-item>
        </el-col>
      </el-row>
      <el-form-item label="入职日期"><el-input v-model="editForm.entry_date" placeholder="YYYY-MM-DD" /></el-form-item>
      <el-form-item label="备注"><el-input v-model="editForm.remark" type="textarea" :rows="2" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="editVisible = false">取消</el-button>
      <el-button type="primary" @click="saveEdit" :loading="saving">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { getStaffList, getStaffStats, updateStaff } from '@/api'

const stats = ref({ total: 0, active: 0, inactive: 0 })
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const loading = ref(false)
const keyword = ref('')
const status = ref('')
const storeName = ref('')

const editVisible = ref(false)
const saving = ref(false)
const editForm = reactive({})

function search() { page.value = 1; loadData() }

async function loadData() {
  loading.value = true
  try {
    const params = { page: page.value, page_size: pageSize.value, role: '店长' }
    if (keyword.value) params.keyword = keyword.value
    if (status.value) params.status = status.value
    if (storeName.value) params.store_name = storeName.value
    const data = await getStaffList(params)
    list.value = data.list || []
    total.value = data.total || 0
  } catch (e) {
    ElMessage.error('加载失败: ' + e.message)
  } finally { loading.value = false }
}

async function loadStats() {
  try {
    const data = await getStaffStats({ role: '店长' })
    if (data.stats) stats.value = data.stats
  } catch {}
}

onMounted(() => {
  loadData()
  loadStats()
})

function openEdit(row) {
  Object.assign(editForm, row)
  editVisible.value = true
}

async function saveEdit() {
  if (!editForm.name) { ElMessage.warning('姓名不能为空'); return }
  saving.value = true
  try {
    await updateStaff(editForm.id, {
      name: editForm.name,
      phone: editForm.phone,
      gender: editForm.gender,
      age: editForm.age,
      store_name: editForm.store_name,
      status: editForm.status,
      entry_date: editForm.entry_date,
      remark: editForm.remark || '',
      role: '店长',
    })
    editVisible.value = false
    loadData()
    loadStats()
    ElMessage.success('保存成功，正在同步到企微表格...')
  } catch (e) {
    ElMessage.error('保存失败: ' + e.message)
  } finally { saving.value = false }
}
</script>
