<template>
  <!-- 统计卡片 -->
  <div class="dash-stat-grid">
    <div class="dash-stat-card">
      <div class="dash-stat-icon" style="background:#e8f8e8;"><el-icon size="22"><Shop /></el-icon></div>
      <div class="dash-stat-body">
        <div class="dash-stat-value success">{{ stats.open_count ?? '—' }}</div>
        <div class="dash-stat-label">已开业</div>
      </div>
    </div>
    <div class="dash-stat-card">
      <div class="dash-stat-icon" style="background:#fff7e8;"><el-icon size="22"><Clock /></el-icon></div>
      <div class="dash-stat-body">
        <div class="dash-stat-value warning">{{ stats.planning_count ?? '—' }}</div>
        <div class="dash-stat-label">筹建中</div>
      </div>
    </div>
    <div class="dash-stat-card">
      <div class="dash-stat-icon" style="background:#e8f4ff;"><el-icon size="22"><OfficeBuilding /></el-icon></div>
      <div class="dash-stat-body">
        <div class="dash-stat-value primary">{{ stats.direct_count ?? '—' }}</div>
        <div class="dash-stat-label">直营门店</div>
      </div>
    </div>
    <div class="dash-stat-card">
      <div class="dash-stat-icon" style="background:#f0e8ff;"><el-icon size="22"><Connection /></el-icon></div>
      <div class="dash-stat-body">
        <div class="dash-stat-value" style="color:#7c5ce7;">{{ stats.joint_count ?? '—' }}</div>
        <div class="dash-stat-label">联营门店</div>
      </div>
    </div>
    <div class="dash-stat-card">
      <div class="dash-stat-icon" style="background:#fff0f0;"><el-icon size="22"><UserFilled /></el-icon></div>
      <div class="dash-stat-body">
        <div class="dash-stat-value danger">{{ stats.franchise_count ?? '—' }}</div>
        <div class="dash-stat-label">加盟门店</div>
      </div>
    </div>
  </div>

  <!-- 搜索区 -->
  <div class="card-compact">
    <div class="card-header">🔍 搜索门店</div>
    <el-row :gutter="12" style="margin-bottom:0;">
      <el-col :span="6">
        <el-input v-model="keyword" placeholder="门店名称" clearable />
      </el-col>
      <el-col :span="4">
        <el-select v-model="status" placeholder="状态" clearable style="width:100%;">
          <el-option label="正常营业" value="正常营业" />
          <el-option label="筹建中" value="筹建中" />
          <el-option label="迁址" value="迁址" />
          <el-option label="已闭店" value="已闭店" />
        </el-select>
      </el-col>
      <el-col :span="4">
        <el-select v-model="storeType" placeholder="店型" clearable style="width:100%;">
          <el-option label="直营店" value="直营店" />
          <el-option label="加盟店" value="加盟店" />
          <el-option label="联营店" value="联营店" />
        </el-select>
      </el-col>
      <el-col :span="6">
        <el-input v-model="legalPerson" placeholder="法人" clearable />
      </el-col>
      <el-col :span="4">
        <el-button type="primary" @click="search">🔍 查询</el-button>
      </el-col>
    </el-row>
  </div>

  <!-- 表格 -->
  <div class="card-compact">
    <div class="card-header">🏪 门店基本信息（共 {{ total }} 家）</div>
    <el-table :data="stores" style="width:100%;" v-loading="loading" stripe>
      <el-table-column prop="store_name" label="门店名称" min-width="180" fixed="left" />
      <el-table-column prop="status" label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="statusTag(row.status)" size="small">{{ row.status || '—' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="store_type" label="店型" width="80" />
      <el-table-column prop="legal_person" label="法人" width="90" />
      <el-table-column prop="payment_type" label="收款性质" width="100" />
      <el-table-column label="所在地区" min-width="150">
        <template #default="{ row }">{{ [row.province, row.city, row.district].filter(Boolean).join(' ') || '—' }}</template>
      </el-table-column>
      <el-table-column prop="address" label="详细地址" min-width="180" show-overflow-tooltip />
      <el-table-column prop="phone" label="电话" width="120" />
      <el-table-column prop="business_hours" label="营业时间" width="130" />
      <el-table-column prop="opening_date" label="开业日期" width="110" />
      <el-table-column prop="store_size" label="面积(㎡)" width="85" />
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
  <el-dialog v-model="editVisible" :title="'编辑门店 — ' + editForm.store_name" width="650px">
    <el-form label-width="100px">
      <el-form-item label="门店名称"><el-input v-model="editForm.store_name" /></el-form-item>
      <el-row :gutter="12">
        <el-col :span="8">
          <el-form-item label="状态">
            <el-select v-model="editForm.status" style="width:100%;">
              <el-option v-for="s in ['正常营业','筹建中','迁址','已闭店']" :key="s" :label="s" :value="s" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="店型">
            <el-select v-model="editForm.store_type" style="width:100%;">
              <el-option v-for="t in ['直营店','加盟店','联营店']" :key="t" :label="t" :value="t" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="面积(㎡)"><el-input v-model="editForm.store_size" /></el-form-item>
        </el-col>
      </el-row>
      <el-row :gutter="12">
        <el-col :span="12"><el-form-item label="法人"><el-input v-model="editForm.legal_person" /></el-form-item></el-col>
        <el-col :span="12"><el-form-item label="收款性质"><el-input v-model="editForm.payment_type" /></el-form-item></el-col>
      </el-row>
      <el-row :gutter="12">
        <el-col :span="8"><el-form-item label="省"><el-input v-model="editForm.province" /></el-form-item></el-col>
        <el-col :span="8"><el-form-item label="市"><el-input v-model="editForm.city" /></el-form-item></el-col>
        <el-col :span="8"><el-form-item label="区"><el-input v-model="editForm.district" /></el-form-item></el-col>
      </el-row>
      <el-form-item label="详细地址"><el-input v-model="editForm.address" /></el-form-item>
      <el-row :gutter="12">
        <el-col :span="12"><el-form-item label="电话"><el-input v-model="editForm.phone" /></el-form-item></el-col>
        <el-col :span="12"><el-form-item label="营业时间"><el-input v-model="editForm.business_hours" /></el-form-item></el-col>
      </el-row>
      <el-form-item label="开业日期"><el-input v-model="editForm.opening_date" placeholder="YYYY-MM-DD" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="editVisible = false">取消</el-button>
      <el-button type="primary" @click="saveEdit" :loading="saving">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { getStores, getStoreById, updateStore, getStoreStats } from '@/api'
import { ElMessage } from 'element-plus'

const stats = ref({})
const stores = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const loading = ref(false)
const keyword = ref('')
const status = ref('')
const storeType = ref('')
const legalPerson = ref('')

const editVisible = ref(false)
const saving = ref(false)
const editForm = reactive({})

onMounted(() => { loadStats(); loadData() })

function statusTag(s) {
  if (s === '正常营业') return 'success'
  if (s === '筹建中') return 'warning'
  if (s === '已闭店') return 'info'
  if (s === '迁址') return 'danger'
  return ''
}

async function loadStats() {
  try {
    const data = await getStoreStats()
    if (data.stats) stats.value = data.stats
  } catch {}
}

async function loadData() {
  loading.value = true
  try {
    const params = { page: page.value, page_size: pageSize.value }
    if (keyword.value) params.keyword = keyword.value
    if (status.value) params.status = status.value
    if (storeType.value) params.store_type = storeType.value
    if (legalPerson.value) params.legal_person = legalPerson.value
    const data = await getStores(params)
    stores.value = data.stores || []
    total.value = data.total || 0
  } catch (e) {
    ElMessage.error('加载失败: ' + e.message)
  } finally { loading.value = false }
}

function search() { page.value = 1; loadData() }

async function openEdit(store) {
  try {
    const data = await getStoreById(store.id)
    Object.assign(editForm, data.store)
    editVisible.value = true
  } catch (e) {
    ElMessage.error('加载门店信息失败')
  }
}

async function saveEdit() {
  if (!editForm.store_name) { ElMessage.warning('门店名称不能为空'); return }
  saving.value = true
  try {
    await updateStore(editForm.id, editForm)
    editVisible.value = false
    loadData()
    loadStats()
    ElMessage.success('保存成功')
  } catch (e) {
    ElMessage.error('保存失败: ' + e.message)
  } finally { saving.value = false }
}
</script>
