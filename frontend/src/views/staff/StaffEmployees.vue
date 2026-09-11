<template>
  <div>
    <!-- 统计卡片 -->
    <div class="dash-stat-grid">
      <div class="dash-stat-card">
        <div class="dash-stat-icon" style="background:#e8f8e8;"><el-icon size="22"><UserFilled /></el-icon></div>
        <div class="dash-stat-body">
          <div class="dash-stat-value success">{{ stats.total ?? '—' }}</div>
          <div class="dash-stat-label">员工总数</div>
        </div>
      </div>
      <div class="dash-stat-card">
        <div class="dash-stat-icon" style="background:#e8f4ff;"><el-icon size="22"><CircleCheckFilled /></el-icon></div>
        <div class="dash-stat-body">
          <div class="dash-stat-value primary">{{ stats.active ?? '—' }}</div>
          <div class="dash-stat-label">在职员工</div>
        </div>
      </div>
      <div class="dash-stat-card">
        <div class="dash-stat-icon" style="background:#fff0f0;"><el-icon size="22"><CircleCloseFilled /></el-icon></div>
        <div class="dash-stat-body">
          <div class="dash-stat-value danger">{{ stats.inactive ?? '—' }}</div>
          <div class="dash-stat-label">离职员工</div>
        </div>
      </div>
    </div>

    <!-- 工具栏：查询 + 同步企微表格 -->
    <div class="card-compact">
      <div class="card-header" style="display:flex;align-items:center;justify-content:space-between;">
        <span>🔍 员工档案查询 <small style="font-weight:400;color:#8492a6;">企业微信为主数据源，本地仅缓存档案</small></span>
        <span style="display:flex;gap:8px;align-items:center;">
          <el-upload :auto-upload="false" :show-file-list="false" :on-change="onFilePicked" accept=".xlsx,.xls,.csv" style="display:inline-block;">
            <el-button size="small" :loading="importing">📥 导入表格</el-button>
          </el-upload>
          <el-button size="small" :loading="syncing" @click="syncFromSheet">↻ 从企微智能表格同步</el-button>
          <el-button size="small" type="primary" @click="openCreate">＋ 新增员工</el-button>
        </span>
      </div>
      <el-row :gutter="12" style="margin-bottom:0;">
        <el-col :span="6"><el-input v-model="keyword" placeholder="姓名 / 手机号" clearable /></el-col>
        <el-col :span="4">
          <el-select v-model="status" placeholder="状态" clearable style="width:100%;">
            <el-option label="在职" value="在职" />
            <el-option label="离职" value="离职" />
          </el-select>
        </el-col>
        <el-col :span="8"><el-input v-model="storeName" placeholder="所属门店" clearable /></el-col>
        <el-col :span="6"><el-button type="primary" @click="search">🔍 查询</el-button></el-col>
      </el-row>
      <div style="margin-top:10px;color:#98a3b4;font-size:12px;">
        提示：也可以把员工表格（Excel / CSV）直接发给企业微信机器人，机器人会自动导入并回复「新增 / 更新」结果。
      </div>
    </div>

    <!-- 员工表格（按企业微信智能表格字段维护） -->
    <div class="card-compact">
      <div class="card-header">👤 员工列表（共 {{ total }} 人）</div>
      <el-table :data="list" style="width:100%;" v-loading="loading" stripe>
        <el-table-column prop="name" label="姓名" min-width="110" fixed="left" />
        <el-table-column prop="phone" label="手机号" width="130" />
        <el-table-column prop="gender" label="性别" width="64" />
        <el-table-column prop="age" label="年龄" width="64" />
        <el-table-column prop="store_name" label="所属门店" min-width="150" show-overflow-tooltip />
        <el-table-column prop="position" label="职位" width="130" show-overflow-tooltip>
          <template #default="{ row }">{{ row.position || '—' }}</template>
        </el-table-column>
        <el-table-column prop="entry_date" label="入职日期" width="112" />
        <el-table-column prop="onboarding_status" label="入职状态" width="90" />
        <el-table-column prop="status" label="在职状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === '在职' ? 'success' : 'info'" size="small">{{ row.status || '—' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="130" show-overflow-tooltip />
        <el-table-column label="操作" width="150" fixed="right">
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

    <el-dialog v-model="editVisible" :title="(editingId ? '编辑员工 · ' : '新增员工 · ') + (editForm.name || '未命名')" width="820px" class="staff-profile-dialog">
      <header class="current-level-heading" :class="`current-${profileLevel.toLowerCase()}`">
        <span>{{ profileLevel }}</span><div><b>{{ profileMeta[profileLevel].title }}</b><small>{{ profileMeta[profileLevel].description }}</small></div>
      </header>
      <el-tabs v-model="profileLevel" class="profile-level-tabs" stretch>
        <el-tab-pane name="A"><template #label><span class="level-label level-a"><b>A</b><span>基础资料<small>日常管理</small></span></span></template>
          <section class="profile-section">
            <el-form label-position="top"><div class="identity-row"><el-avatar :size="68" :src="editForm.photo_url" class="profile-avatar">{{ editForm.name?.slice(0,1) || '员' }}</el-avatar><el-form-item label="个人照片" class="photo-field"><el-input v-model="editForm.photo_url" placeholder="企业微信附件或图片地址" clearable /></el-form-item></div>
              <el-row :gutter="16"><el-col :span="12"><el-form-item label="姓名" required><el-input v-model="editForm.name" /></el-form-item></el-col><el-col :span="12"><el-form-item label="手机号"><el-input v-model="editForm.phone" /></el-form-item></el-col></el-row>
              <el-row :gutter="16"><el-col :span="6"><el-form-item label="性别"><el-select v-model="editForm.gender" style="width:100%"><el-option label="男" value="男" /><el-option label="女" value="女" /></el-select></el-form-item></el-col><el-col :span="6"><el-form-item label="年龄"><el-input v-model="editForm.age" readonly placeholder="身份证识别" /></el-form-item></el-col><el-col :span="6"><el-form-item label="在职状态"><el-select v-model="editForm.status" style="width:100%"><el-option label="在职" value="在职" /><el-option label="离职" value="离职" /></el-select></el-form-item></el-col><el-col :span="6"><el-form-item label="入职状态"><el-select v-model="editForm.onboarding_status" style="width:100%"><el-option label="待入职" value="待入职" /><el-option label="已入职" value="已入职" /><el-option label="已取消" value="已取消" /></el-select></el-form-item></el-col></el-row>
              <el-row :gutter="16"><el-col :span="12"><el-form-item label="所属门店"><el-select v-model="editForm.store_name" filterable placeholder="选择门店" style="width:100%"><el-option v-for="store in stores" :key="store.id" :label="store.store_name" :value="store.store_name" /></el-select></el-form-item></el-col><el-col :span="12"><el-form-item label="岗位"><el-input v-model="editForm.position" placeholder="如：烧腊师傅 / 收银 / 店助" /></el-form-item></el-col></el-row>
              <el-row :gutter="16"><el-col :span="12"><el-form-item label="入职日期"><el-input v-model="editForm.entry_date" placeholder="YYYY-MM-DD" /></el-form-item></el-col><el-col :span="12"><el-form-item label="紧急联系人"><el-input v-model="editForm.emergency_contact" /></el-form-item></el-col></el-row>
              <el-form-item label="紧急联系电话"><el-input v-model="editForm.emergency_phone" /></el-form-item><el-form-item label="备注"><el-input v-model="editForm.remark" type="textarea" :rows="2" /></el-form-item>
            </el-form>
          </section>
        </el-tab-pane>
        <el-tab-pane name="B"><template #label><span class="level-label level-b"><b>B</b><span>证件健康<small>受限资料</small></span></span></template>
          <section class="profile-section">
            <el-form label-position="top"><el-row :gutter="16"><el-col :span="16"><el-form-item label="身份证号码"><el-input v-model="editForm.id_card_number" @input="refreshAge" placeholder="填写后自动计算年龄" /></el-form-item></el-col><el-col :span="8"><el-form-item label="已识别年龄"><el-input v-model="editForm.age" readonly /></el-form-item></el-col></el-row>
              <el-row :gutter="16"><el-col :span="12"><el-form-item label="身份证正面照片"><el-input v-model="editForm.id_card_front_url" placeholder="企业微信附件或受保护文件地址" /></el-form-item></el-col><el-col :span="12"><el-form-item label="身份证反面照片"><el-input v-model="editForm.id_card_back_url" placeholder="企业微信附件或受保护文件地址" /></el-form-item></el-col></el-row>
              <el-row :gutter="16"><el-col :span="12"><el-form-item label="健康证照片"><el-input v-model="editForm.health_certificate_url" placeholder="企业微信附件或受保护文件地址" /></el-form-item></el-col><el-col :span="12"><el-form-item label="健康证失效时间"><el-input v-model="editForm.health_certificate_expiry" placeholder="YYYY-MM-DD" /></el-form-item></el-col></el-row>
            </el-form>
          </section>
        </el-tab-pane>
        <el-tab-pane name="C"><template #label><span class="level-label level-c"><b>C</b><span>薪酬账户<small>高度保密</small></span></span></template>
          <section class="profile-section sensitive-section">
            <el-form label-position="top"><el-row :gutter="16"><el-col :span="8"><el-form-item label="用工类型"><el-select v-model="editForm.hire_type" style="width:100%"><el-option label="全职" value="全职" /><el-option label="兼职" value="兼职" /></el-select></el-form-item></el-col><el-col :span="8"><el-form-item :label="editForm.hire_type === '兼职' ? '兼职时薪（元/时）' : '员工工资（元/月）'"><el-input v-model="editForm.salary" type="number" min="0" /></el-form-item></el-col><el-col :span="8"><el-form-item label="转正时间"><el-input v-model="editForm.probation_date" placeholder="YYYY-MM-DD" /></el-form-item></el-col></el-row>
              <el-row :gutter="16"><el-col :span="12"><el-form-item label="开户银行"><el-input v-model="editForm.bank_name" /></el-form-item></el-col><el-col :span="12"><el-form-item label="开户银行支行"><el-input v-model="editForm.bank_branch" /></el-form-item></el-col></el-row>
              <el-row :gutter="16"><el-col :span="12"><el-form-item label="银行卡姓名"><el-input v-model="editForm.bank_account_name" /></el-form-item></el-col><el-col :span="12"><el-form-item label="银行卡卡号"><el-input v-model="editForm.bank_card_number" /></el-form-item></el-col></el-row>
              <el-form-item label="离职时间"><el-input v-model="editForm.leave_date" placeholder="YYYY-MM-DD" /></el-form-item>
            </el-form>
          </section>
        </el-tab-pane>
      </el-tabs>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button v-if="profileLevel === 'C'" @click="previousLevel">上一页</el-button>
        <el-button v-if="profileLevel !== 'C'" type="primary" @click="nextLevel">下一页</el-button>
        <el-button v-else type="primary" @click="saveEdit" :loading="saving">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { createStaff, getStaffList, getStaffStats, getStores, importStaffWorkbook, syncStaffFromWecom, updateStaff } from '@/api'

const stats = ref({ total: 0, active: 0, inactive: 0 })
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const loading = ref(false)
const syncing = ref(false)
const importing = ref(false)
const keyword = ref('')
const status = ref('')
const storeName = ref('')
const stores = ref([])

const editVisible = ref(false)
const saving = ref(false)
const editingId = ref(null)
const profileLevel = ref('A')
const profileMeta = {
  A: { title: 'A 级 · 基础资料', description: '日常管理资料，用于排班、门店联系与员工识别' },
  B: { title: 'B 级 · 证件健康', description: '受限资料，用于合规建档与健康证管理' },
  C: { title: 'C 级 · 薪酬账户', description: '高度保密，仅限获授权的人事与财务维护' },
}
const emptyForm = () => ({
  name: '', photo_url: '', phone: '', gender: '', age: '', store_name: '',
  onboarding_status: '已入职', status: '在职', position: '', entry_date: '',
  hire_type: '全职', salary: '', probation_date: '', leave_date: '',
  id_card_number: '', id_card_front_url: '', id_card_back_url: '',
  bank_name: '', bank_branch: '', bank_account_name: '', bank_card_number: '',
  emergency_contact: '', emergency_phone: '', health_certificate_url: '',
  health_certificate_expiry: '', remark: ''
})
const editForm = reactive(emptyForm())

function search() { page.value = 1; loadData() }

async function loadData() {
  loading.value = true
  try {
    const params = { page: page.value, page_size: pageSize.value }
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

async function loadStores() {
  try {
    const data = await getStores({ page: 1, page_size: 500 })
    stores.value = data.stores || []
  } catch {}
}

async function loadStats() {
  try {
    const data = await getStaffStats({})
    if (data.stats) stats.value = data.stats
  } catch {}
}

function openCreate() {
  editingId.value = null
  Object.assign(editForm, emptyForm())
  profileLevel.value = 'A'
  editVisible.value = true
}

function openEdit(row) {
  editingId.value = row.id
  Object.assign(editForm, emptyForm(), {
    name: row.name || '', photo_url: row.photo_url || '', phone: row.phone || '', gender: row.gender || '', age: row.age || '',
    store_name: row.store_name || '',
    onboarding_status: row.onboarding_status || '已入职', status: row.status || '在职',
    position: row.position || '', entry_date: row.entry_date || '', hire_type: row.hire_type || '全职',
    salary: row.salary ?? '', probation_date: row.probation_date || '', leave_date: row.leave_date || '',
    id_card_number: row.id_card_number || '', id_card_front_url: row.id_card_front_url || '', id_card_back_url: row.id_card_back_url || '',
    bank_name: row.bank_name || '', bank_branch: row.bank_branch || '', bank_account_name: row.bank_account_name || '', bank_card_number: row.bank_card_number || '',
    emergency_contact: row.emergency_contact || '', emergency_phone: row.emergency_phone || '',
    health_certificate_url: row.health_certificate_url || '', health_certificate_expiry: row.health_certificate_expiry || '', remark: row.remark || '',
  })
  refreshAge()
  profileLevel.value = 'A'
  editVisible.value = true
}

function refreshAge() {
  const match = String(editForm.id_card_number || '').trim().match(/^\d{6}(\d{4})(\d{2})(\d{2})\d{3}[0-9Xx]$/)
  if (!match) { editForm.age = ''; return }
  const birthday = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (birthday.getFullYear() !== Number(match[1]) || birthday.getMonth() !== Number(match[2]) - 1 || birthday.getDate() !== Number(match[3])) { editForm.age = ''; return }
  const today = new Date()
  let age = today.getFullYear() - birthday.getFullYear()
  if (today.getMonth() < birthday.getMonth() || (today.getMonth() === birthday.getMonth() && today.getDate() < birthday.getDate())) age -= 1
  editForm.age = age >= 0 && age <= 130 ? age : ''
}

function nextLevel() {
  profileLevel.value = profileLevel.value === 'A' ? 'B' : 'C'
}

function previousLevel() {
  profileLevel.value = profileLevel.value === 'C' ? 'B' : 'A'
}

async function saveEdit() {
  if (!editForm.name.trim()) { ElMessage.warning('姓名不能为空'); return }
  saving.value = true
  try {
    const payload = {
      name: editForm.name.trim(),
      photo_url: editForm.photo_url || '',
      phone: editForm.phone || '',
      gender: editForm.gender || '',
      store_name: editForm.store_name || '',
      onboarding_status: editForm.onboarding_status || '已入职',
      status: editForm.status || '在职',
      position: editForm.position || '',
      entry_date: editForm.entry_date || '',
      hire_type: editForm.hire_type || '全职',
      salary: Number(editForm.salary) || 0,
      probation_date: editForm.probation_date || '',
      leave_date: editForm.leave_date || '',
      id_card_number: editForm.id_card_number || '',
      id_card_front_url: editForm.id_card_front_url || '',
      id_card_back_url: editForm.id_card_back_url || '',
      bank_name: editForm.bank_name || '',
      bank_branch: editForm.bank_branch || '',
      bank_account_name: editForm.bank_account_name || '',
      bank_card_number: editForm.bank_card_number || '',
      emergency_contact: editForm.emergency_contact || '',
      emergency_phone: editForm.emergency_phone || '',
      health_certificate_url: editForm.health_certificate_url || '',
      health_certificate_expiry: editForm.health_certificate_expiry || '',
      remark: editForm.remark || '',
    }
    if (editingId.value) await updateStaff(editingId.value, payload)
    else await createStaff(payload)
    editVisible.value = false
    loadData(); loadStats()
    ElMessage.success('保存成功（如已配置企微智能表格将同步）')
  } catch (e) {
    ElMessage.error('保存失败: ' + e.message)
  } finally { saving.value = false }
}

async function syncFromSheet() {
  try {
    await ElMessageBox.confirm('以企业微信机器人身份读取「门店员工管理」智能表格，并同步到本地员工档案？（按企微记录标识去重，重复执行只更新不重复新增）', '从企微同步', { confirmButtonText: '开始同步', cancelButtonText: '取消', type: 'info' })
  } catch { return }
  syncing.value = true
  try {
    const res = await syncStaffFromWecom()
    ElMessage.success(res.message || `同步完成：新增 ${res.created || 0} 人，更新 ${res.updated || 0} 人`)
    await loadData(); await loadStats()
  } catch (e) {
    ElMessage.error('同步失败：' + (e.message || '') + '（请确认已安装 wecom-cli 且完成授权，并已配置企微文档 ID）')
  } finally { syncing.value = false }
}

// 导入本地表格文件（Excel/CSV）：字段自动识别，按 姓名+手机号 去重
function onFilePicked(uploadFile) {
  const file = uploadFile?.raw
  if (!file) return
  importing.value = true
  const reader = new FileReader()
  reader.onload = async () => {
    try {
      const res = await importStaffWorkbook({ filename: file.name, data: String(reader.result || '') })
      ElMessage.success(`导入完成：新增 ${res.created || 0} 人，更新 ${res.updated || 0} 人，跳过 ${res.skipped || 0} 行`)
      await loadData(); await loadStats()
    } catch (e) {
      ElMessage.error('导入失败：' + (e.message || ''))
    } finally { importing.value = false }
  }
  reader.onerror = () => { importing.value = false; ElMessage.error('文件读取失败') }
  reader.readAsDataURL(file)
}

onMounted(() => { loadData(); loadStats(); loadStores() })
</script>

<style scoped>
.current-level-heading { display:flex; justify-content:center; align-items:center; gap:11px; margin:0 0 18px; padding:14px 18px; border:1px solid #dde8f7; border-radius:16px; background:#f8fbff; text-align:left; }.current-level-heading>span { display:grid; place-items:center; width:31px; height:31px; border-radius:50%; color:#fff; background:#3778e7; font-weight:800; }.current-level-heading div { display:grid; gap:3px; }.current-level-heading b { color:#25476f; font-size:15px; }.current-level-heading small { color:#8291a7; font-size:12px; }.current-b>span { background:#13a58a; }.current-c { border-color:#e6dafa; background:#fcfaff; }.current-c>span { background:#8b61d9; }
.profile-level-tabs :deep(.el-tabs__header) { display:none; }
.profile-level-tabs :deep(.el-tab-pane) { animation: profile-pane-in .28s cubic-bezier(.2,.8,.2,1); }
.level-label { display:flex; justify-content:center; align-items:center; gap:9px; height:100%; text-align:left; }.level-label b { display:grid; place-items:center; width:27px; height:27px; border-radius:50%; color:#fff; font-size:13px; }.level-label span { display:grid; gap:2px; color:#304766; font-weight:600; line-height:1.1; }.level-label small { color:#94a1b4; font-size:11px; font-weight:400; }.level-a b { background:#3778e7; }.level-b b { background:#13a58a; }.level-c b { background:#8b61d9; }
.profile-section { padding:22px 22px 5px; border:1px solid #e2e9f3; border-radius:18px; background:#fff; box-shadow:0 10px 30px rgba(41,73,117,.04); }.sensitive-section { border-color:#e5dcfa; background:linear-gradient(145deg,#fff,#fbf9ff); }
.identity-row { display:flex; align-items:center; gap:16px; margin-bottom:9px; padding:14px; border-radius:14px; background:#f8fbff; }.profile-avatar { flex:none; background:#e9f1ff; color:#3f72cb; font-weight:700; }.photo-field { flex:1; margin-bottom:0; }
@keyframes profile-pane-in { from { opacity:0; transform:translateY(10px) scale(.99); } to { opacity:1; transform:translateY(0) scale(1); } }
@media (max-width: 720px) { .profile-section { padding:16px 14px 2px; }.identity-row { align-items:stretch; flex-direction:column; }.current-level-heading { align-items:flex-start; justify-content:flex-start; } }
</style>
