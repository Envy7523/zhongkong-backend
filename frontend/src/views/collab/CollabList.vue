<template>
  <div class="collab-list-page">
    <!-- 顶部标题栏 -->
    <div class="list-header">
      <div>
        <h2>📋 协同事项管理</h2>
        <p class="subtitle">团队事项跟进与追踪</p>
      </div>
      <el-button type="primary" @click="dialogVisible = true">➕ 发起事项</el-button>
    </div>

    <!-- 筛选栏 -->
    <div class="filter-bar">
      <el-select v-model="filterStatus" placeholder="全部状态" style="width: 140px" @change="fetchList">
        <el-option label="全部状态" value="" />
        <el-option label="待开始" value="待开始" />
        <el-option label="进行中" value="进行中" />
        <el-option label="已完成" value="已完成" />
        <el-option label="未完成" value="未完成" />
      </el-select>
      <el-input
        v-model="keyword"
        placeholder="搜索事项标题..."
        clearable
        style="width: 280px"
        @keyup.enter="fetchList"
        @clear="fetchList"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <el-button @click="fetchList">搜索</el-button>
    </div>

    <!-- 卡片列表 -->
    <div v-if="loading" class="loading-wrap">
      <el-skeleton :rows="4" animated />
    </div>
    <template v-else-if="list.length">
      <div class="card-grid">
        <div
          v-for="item in list"
          :key="item.id"
          class="issue-card"
          @click="goDetail(item.id)"
        >
          <div class="card-top">
            <span class="issue-no">{{ item.issue_no }}</span>
            <el-tag :type="statusTagType(item.status_display || item.status)" size="small" effect="dark">
              {{ item.status_display || item.status }}
            </el-tag>
          </div>
          <h3 class="card-title">{{ item.title }}</h3>
          <div class="card-meta">
            <span>👤 {{ item.created_by_name || '—' }}</span>
            <span v-if="item.participants_name && item.participants_name.length">
              → {{ item.participants_name.join('、') }}
            </span>
          </div>
          <div class="card-footer">
            <span class="card-time">📅 {{ item.created_at?.slice(0, 10) || '—' }}</span>
            <span v-if="item.deadline" class="card-deadline" :class="{ overdue: isOverdue(item) }">
              ⏰ {{ item.deadline }}
            </span>
          </div>
        </div>
      </div>

      <!-- 分页 -->
      <div class="pagination-wrap" v-if="total > pageSize">
        <el-pagination
          background
          layout="prev, pager, next"
          :total="total"
          :page-size="pageSize"
          :current-page="page"
          @current-change="onPageChange"
        />
      </div>
    </template>
    <el-empty v-else description="暂无事项，点击上方「发起事项」创建第一条" />

    <!-- 发起事项弹窗 -->
    <el-dialog v-model="dialogVisible" title="发起新事项" width="640px" :close-on-click-modal="false">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="事项标题" prop="title">
          <el-input v-model="form.title" placeholder="请输入事项标题（必填）" maxlength="100" show-word-limit />
        </el-form-item>
        <el-form-item label="事项描述">
          <el-input v-model="form.description" type="textarea" :rows="4" placeholder="请输入事项描述" />
        </el-form-item>
        <el-form-item label="开始时间">
          <el-date-picker v-model="form.start_time" type="date" placeholder="可选，不填则手动推进" value-format="YYYY-MM-DD" style="width:100%" />
        </el-form-item>
        <el-form-item label="截止日期">
          <el-date-picker v-model="form.deadline" type="date" placeholder="选择截止日期" value-format="YYYY-MM-DD" style="width:100%" />
        </el-form-item>
        <el-form-item label="参与人">
          <el-select v-model="form.participants" placeholder="选择参与人（可多选）" multiple clearable style="width:100%" @change="onParticipantsChange">
            <el-option v-for="u in userList" :key="u.id" :label="`${u.display_name || u.username} (${u.role})`" :value="u.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleCreate">确认发起</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { getCollabIssues, createCollabIssue, getCollabUsers } from '@/api'

const router = useRouter()

// 列表
const loading = ref(false)
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(12)
const filterStatus = ref('')
const keyword = ref('')

// 发起事项
const dialogVisible = ref(false)
const submitting = ref(false)
const formRef = ref(null)
const userList = ref([])
const form = reactive({
  title: '',
  description: '',
  start_time: null,
  deadline: null,
  participants: [],
  participants_name: [],
})
const rules = {
  title: [{ required: true, message: '事项标题不能为空', trigger: 'blur' }],
}

function onParticipantsChange(ids) {
  form.participants_name = ids.map(id => {
    const u = userList.value.find(x => x.id === id)
    return u ? (u.display_name || u.username) : ''
  })
}

async function fetchUsers() {
  try {
    const res = await getCollabUsers()
    userList.value = res.users || []
  } catch {}
}

async function fetchList() {
  loading.value = true
  try {
    const res = await getCollabIssues({
      status: filterStatus.value || undefined,
      keyword: keyword.value || undefined,
      page: page.value,
      pageSize: pageSize.value,
    })
    list.value = res.rows || []
    total.value = res.total || 0
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

function onPageChange(p) {
  page.value = p
  fetchList()
}

function isOverdue(item) {
  const status = item.status_display || item.status
  if (status === '已完成' || status === '未完成' || !item.deadline) return false
  return new Date(item.deadline) < new Date()
}

function statusTagType(status) {
  const map = { '待开始': 'info', '进行中': 'warning', '已完成': 'success', '未完成': 'danger' }
  return map[status] || 'info'
}

function goDetail(id) {
  router.push(`/collab/${id}`)
}

async function handleCreate() {
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    const res = await createCollabIssue({
      title: form.title,
      description: form.description,
      start_time: form.start_time,
      deadline: form.deadline,
      participants: form.participants,
      participants_name: form.participants_name,
    })
    ElMessage.success(`事项 ${res.issue.issue_no} 已发起`)
    dialogVisible.value = false
    // 重置表单
    Object.assign(form, { title: '', description: '', start_time: null, deadline: null, participants: [], participants_name: [] })
    page.value = 1
    fetchList()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  fetchUsers()
  fetchList()
})
</script>

<style scoped>
.collab-list-page {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px 20px 60px;
}

.list-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
}
.list-header h2 { margin: 0 0 4px; font-size: 22px; }
.subtitle { margin: 0; color: #909399; font-size: 13px; }

.filter-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
  align-items: center;
}

.loading-wrap { padding: 40px 0; }

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 16px;
}

.issue-card {
  background: #fff;
  border: 1px solid #ebeef5;
  border-radius: 10px;
  padding: 18px 20px;
  cursor: pointer;
  transition: box-shadow .2s, transform .2s;
}
.issue-card:hover {
  box-shadow: 0 4px 16px rgba(0,0,0,.08);
  transform: translateY(-2px);
}

.card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.issue-no { font-size: 12px; color: #909399; font-family: monospace; }
.card-title {
  margin: 0 0 10px;
  font-size: 16px;
  font-weight: 600;
  color: #303133;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-meta {
  display: flex;
  gap: 8px;
  font-size: 13px;
  color: #606266;
  margin-bottom: 12px;
}
.card-footer {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #909399;
}
.overdue { color: #F56C6C; font-weight: 600; }

.pagination-wrap {
  display: flex;
  justify-content: center;
  margin-top: 24px;
}
</style>
