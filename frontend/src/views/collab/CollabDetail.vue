<template>
  <div class="collab-detail-page" v-loading="loading">
    <!-- 顶部导航 -->
    <div class="detail-topbar">
      <el-button text @click="$router.push('/collab/list')">
        <el-icon><ArrowLeft /></el-icon> 返回列表
      </el-button>
    </div>

    <template v-if="issue">
      <!-- 事项信息区 -->
      <div class="info-card">
        <div class="info-header">
          <h2>{{ issue.title }}</h2>
          <div class="info-actions">
            <el-tag :type="statusTagType(issue.status_display || issue.status)" size="large" effect="dark">
              {{ issue.status_display || issue.status }}
            </el-tag>
            <!-- 推进进度按钮（仅发起人可见） -->
            <template v-if="isCreator && canAdvance.length">
              <el-button
                v-for="opt in canAdvance"
                :key="opt.status"
                :type="opt.type"
                @click="openAdvanceDialog(opt.status)"
              >
                {{ opt.label }}
              </el-button>
            </template>
          </div>
        </div>

        <div class="info-grid">
          <div class="info-item">
            <span class="info-label">事项编号</span>
            <span class="info-value">{{ issue.issue_no }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">发起人</span>
            <span class="info-value">👤 {{ issue.created_by_name || '—' }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">参与人</span>
            <span class="info-value">{{ issue.participants_name && issue.participants_name.length ? issue.participants_name.join('、') : '未指定' }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">创建时间</span>
            <span class="info-value">{{ issue.created_at || '—' }}</span>
          </div>
          <div class="info-item" v-if="issue.start_time">
            <span class="info-label">开始时间</span>
            <span class="info-value">{{ issue.start_time }}</span>
          </div>
          <div class="info-item" v-if="issue.deadline">
            <span class="info-label">截止日期</span>
            <span class="info-value" :class="{ overdue: isOverdue }">{{ issue.deadline }}</span>
          </div>
          <div class="info-item" v-if="issue.status === '已完成'">
            <span class="info-label">完成时间</span>
            <span class="info-value">{{ issue.completed_at || '—' }}</span>
          </div>
        </div>

        <div v-if="issue.description" class="info-desc">
          <span class="info-label">事项描述</span>
          <pre class="desc-text">{{ issue.description }}</pre>
        </div>

        <div v-if="issue.status === '已完成' && issue.completion_note" class="info-desc completion-note">
          <span class="info-label">✅ 完成说明</span>
          <pre class="desc-text">{{ issue.completion_note }}</pre>
        </div>
      </div>

      <!-- 跟进时间线 -->
      <div class="timeline-section">
        <h3>📝 跟进时间线 <span class="reply-count">({{ replies.length }} 条)</span></h3>

        <el-timeline v-if="replies.length">
          <el-timeline-item
            v-for="r in replies"
            :key="r.id"
            :timestamp="r.created_at"
            placement="top"
          >
            <div class="reply-card">
              <div class="reply-user">👤 {{ r.user_name || `用户 ${r.user_id}` }}</div>
              <div class="reply-content">{{ r.content }}</div>
              <div v-if="r.images && r.images.length" class="reply-images">
                <el-image
                  v-for="(img, i) in r.images"
                  :key="i"
                  :src="img"
                  fit="cover"
                  class="reply-thumb"
                  :preview-src-list="r.images"
                  :initial-index="i"
                />
              </div>
            </div>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else description="暂无跟进记录" :image-size="60" />
      </div>

      <!-- 回复输入区 -->
      <div v-if="issue.status === '进行中' || issue.status === '待开始'" class="reply-input-section">
        <h3>💬 添加回复</h3>
        <div class="reply-images-preview" v-if="uploadImages.length">
          <div v-for="(img, i) in uploadImages" :key="i" class="img-preview-wrap">
            <img :src="img" />
            <span class="remove-img" @click="removeImage(i)">✕</span>
          </div>
        </div>
        <div class="reply-input-row">
          <el-input
            v-model="replyContent"
            type="textarea"
            :rows="3"
            placeholder="输入回复内容..."
            maxlength="2000"
            show-word-limit
          />
          <div class="reply-actions">
            <label class="upload-btn">
              <el-icon><Picture /></el-icon> 上传图片
              <input
                type="file"
                accept="image/*"
                multiple
                :disabled="uploadImages.length >= 3"
                @change="onFileChange"
                style="display:none"
              />
            </label>
            <span class="upload-hint">最多3张</span>
            <el-button type="primary" :loading="replying" @click="handleReply" :disabled="!replyContent.trim()">
              发送回复
            </el-button>
          </div>
        </div>
      </div>
      <div v-else class="reply-closed">
        <el-alert title="该事项已结束，不再接收新回复" type="info" :closable="false" show-icon />
      </div>
    </template>

    <!-- 推进进度弹窗 -->
    <el-dialog v-model="advanceDialog.visible" :title="advanceDialog.title" width="500px" :close-on-click-modal="false">
      <el-form :model="advanceForm" :rules="advanceRules" ref="advanceFormRef" label-width="90px">
        <el-form-item label="推进说明" prop="note">
          <el-input
            v-model="advanceForm.note"
            type="textarea"
            :rows="4"
            :placeholder="advanceDialog.placeholder"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="advanceDialog.visible = false">取消</el-button>
        <el-button :type="advanceDialog.btnType" :loading="advancing" @click="handleAdvance">
          {{ advanceDialog.btnText }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft, Picture } from '@element-plus/icons-vue'
import { getCollabIssue, replyCollabIssue, advanceCollabIssue } from '@/api'

const route = useRoute()
const router = useRouter()

const currentUserId = computed(() => {
  try {
    const token = localStorage.getItem('etaigong_token')
    if (!token) return null
    const payload = JSON.parse(atob(token.split('.')[1]))
    return payload.id
  } catch { return null }
})

const loading = ref(true)
const issue = ref(null)
const replies = ref([])

// 发起人判断
const isCreator = computed(() => currentUserId.value === issue.value?.created_by)

// 可推进的状态选项
const canAdvance = computed(() => {
  if (!issue.value) return []
  const status = issue.value.status_display || issue.value.status
  const opts = {
    '待开始': [
      { status: '进行中', label: '▶ 开始进行', type: 'primary' },
      { status: '已完成', label: '✅ 直接完成', type: 'success' },
    ],
    '进行中': [
      { status: '已完成', label: '✅ 完成事项', type: 'success' },
      { status: '未完成', label: '❌ 标记未完成', type: 'danger' },
    ],
    '未完成': [
      { status: '已完成', label: '✅ 标记为已完成', type: 'success' },
    ],
    '已完成': [],
  }
  return opts[status] || []
})

// 回复
const replyContent = ref('')
const uploadImages = ref([])
const replying = ref(false)

// 推进弹窗
const advancing = ref(false)
const advanceFormRef = ref(null)
const advanceForm = ref({ note: '' })
const advanceRules = { note: [{ required: true, message: '推进说明不能为空', trigger: 'blur' }] }
const advanceDialog = reactive({
  visible: false,
  title: '',
  placeholder: '',
  btnText: '',
  btnType: 'primary',
  targetStatus: '',
})

const ADVANCE_CONFIG = {
  '进行中': { title: '开始进行', placeholder: '请填写推进说明（必填）', btnText: '确认开始', btnType: 'primary' },
  '已完成': { title: '完成事项', placeholder: '请填写完成说明（必填），如：已与客户确认方案、已修复上线等', btnText: '确认完成', btnType: 'success' },
  '未完成': { title: '标记未完成', placeholder: '请填写未完成原因（必填）', btnText: '确认标记', btnType: 'danger' },
}

function openAdvanceDialog(targetStatus) {
  const cfg = ADVANCE_CONFIG[targetStatus] || { title: '推进进度', placeholder: '请填写说明', btnText: '确认', btnType: 'primary' }
  advanceDialog.title = cfg.title
  advanceDialog.placeholder = cfg.placeholder
  advanceDialog.btnText = cfg.btnText
  advanceDialog.btnType = cfg.btnType
  advanceDialog.targetStatus = targetStatus
  advanceDialog.visible = true
  advanceForm.value.note = ''
}

const isOverdue = computed(() => {
  if (!issue.value || !issue.value.deadline) return false
  const status = issue.value.status_display || issue.value.status
  if (status === '已完成' || status === '未完成') return false
  return new Date(issue.value.deadline) < new Date()
})

function statusTagType(status) {
  const map = { '待开始': 'info', '进行中': 'warning', '已完成': 'success', '未完成': 'danger' }
  return map[status] || 'info'
}

async function fetchDetail() {
  loading.value = true
  try {
    const id = route.params.id
    const res = await getCollabIssue(id)
    issue.value = res.issue
    replies.value = res.replies || []
  } catch (e) {
    ElMessage.error(e.message)
    router.push('/collab/list')
  } finally {
    loading.value = false
  }
}

function onFileChange(e) {
  const files = Array.from(e.target.files)
  const remaining = 3 - uploadImages.value.length
  const toAdd = files.slice(0, remaining)
  toAdd.forEach(file => {
    const reader = new FileReader()
    reader.onload = () => {
      uploadImages.value.push(reader.result)
    }
    reader.readAsDataURL(file)
  })
  e.target.value = ''
  if (files.length > remaining) {
    ElMessage.warning(`最多上传3张，已自动截取前${remaining}张`)
  }
}

function removeImage(i) {
  uploadImages.value.splice(i, 1)
}

async function handleReply() {
  if (!replyContent.value.trim()) return
  replying.value = true
  try {
    const res = await replyCollabIssue(issue.value.id, {
      content: replyContent.value,
      images: uploadImages.value,
    })
    replyContent.value = ''
    uploadImages.value = []
    issue.value = res.issue
    replies.value.push(res.reply)
    ElMessage.success('回复成功')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    replying.value = false
  }
}

async function handleAdvance() {
  const valid = await advanceFormRef.value.validate().catch(() => false)
  if (!valid) return
  advancing.value = true
  try {
    const res = await advanceCollabIssue(issue.value.id, {
      status: advanceDialog.targetStatus,
      note: advanceForm.value.note,
    })
    issue.value = res.issue
    advanceDialog.visible = false
    ElMessage.success('状态已更新')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    advancing.value = false
  }
}

onMounted(fetchDetail)
</script>

<style scoped>
.collab-detail-page {
  max-width: 900px;
  margin: 0 auto;
  padding: 20px 20px 60px;
}

.detail-topbar {
  margin-bottom: 16px;
}

.info-card {
  background: #fff;
  border: 1px solid #ebeef5;
  border-radius: 12px;
  padding: 24px 28px;
  margin-bottom: 24px;
}

.info-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
  gap: 16px;
}
.info-header h2 { margin: 0; font-size: 20px; flex: 1; }
.info-actions { display: flex; gap: 10px; align-items: center; flex-shrink: 0; }

.info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px 24px;
  margin-bottom: 16px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.info-label { font-size: 12px; color: #909399; }
.info-value { font-size: 14px; color: #303133; font-weight: 500; }
.info-value.overdue { color: #F56C6C; }

.info-desc {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #ebeef5;
}
.completion-note {
  background: #f0f9eb;
  border-radius: 8px;
  padding: 14px 16px;
  border: 1px solid #e1f3d8;
}
.desc-text {
  margin: 8px 0 0;
  font-size: 14px;
  color: #606266;
  white-space: pre-wrap;
  line-height: 1.6;
  font-family: inherit;
}

/* 时间线 */
.timeline-section {
  background: #fff;
  border: 1px solid #ebeef5;
  border-radius: 12px;
  padding: 24px 28px;
  margin-bottom: 24px;
}
.timeline-section h3 { margin: 0 0 16px; font-size: 16px; }
.reply-count { font-weight: 400; color: #909399; font-size: 13px; }

.reply-card {
  background: #fafafa;
  border-radius: 8px;
  padding: 14px 16px;
  border: 1px solid #f0f0f0;
}
.reply-user { font-size: 13px; color: #409EFF; font-weight: 600; margin-bottom: 6px; }
.reply-content { font-size: 14px; color: #303133; line-height: 1.6; white-space: pre-wrap; }
.reply-images { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.reply-thumb { width: 100px; height: 100px; border-radius: 6px; object-fit: cover; }

/* 回复输入区 */
.reply-input-section {
  background: #fff;
  border: 1px solid #ebeef5;
  border-radius: 12px;
  padding: 24px 28px;
}
.reply-input-section h3 { margin: 0 0 12px; font-size: 16px; }

.reply-images-preview {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.img-preview-wrap {
  position: relative;
  width: 80px;
  height: 80px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid #dcdfe6;
}
.img-preview-wrap img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.remove-img {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 20px;
  height: 20px;
  background: rgba(0,0,0,.55);
  color: #fff;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  cursor: pointer;
  line-height: 1;
}

.reply-input-row {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.reply-actions {
  display: flex;
  gap: 12px;
  align-items: center;
}
.upload-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: #606266;
  cursor: pointer;
  padding: 6px 12px;
  border: 1px dashed #dcdfe6;
  border-radius: 6px;
  transition: border-color .2s;
}
.upload-btn:hover { border-color: #409EFF; color: #409EFF; }
.upload-hint { font-size: 12px; color: #c0c4cc; }

.reply-closed { margin-top: 8px; }
</style>
