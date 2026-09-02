<template>
  <main class="collab-list-page">
    <section class="collab-hero">
      <div>
        <p class="eyebrow">TEAMWORK · 事项协作</p>
        <h1>协同事项</h1>
        <p class="subtitle">集中安排、跟进并闭环每一件团队事项。</p>
      </div>
      <el-button type="primary" size="large" :icon="Plus" @click="openCreate">发起事项</el-button>
    </section>

    <section class="summary-grid" aria-label="事项概览">
      <button v-for="item in summaries" :key="item.key" class="summary-card" :class="{ active: filterStatus === item.key }" @click="selectStatus(item.key)">
        <span>{{ item.label }}</span><strong>{{ item.count }}</strong><i :class="item.tone"></i>
      </button>
    </section>

    <section class="toolbar">
      <div class="filter-group"><el-segmented v-model="phase" :options="phaseOptions" @change="onFilterChange" /></div>
      <div class="toolbar-search">
        <el-button :icon="Refresh" :loading="loading" @click="fetchList">刷新</el-button>
        <el-input v-model="keyword" clearable placeholder="搜索事项标题" :prefix-icon="Search" @keyup.enter="onFilterChange" @clear="onFilterChange" />
        <el-button :icon="Search" @click="onFilterChange">搜索</el-button>
      </div>
    </section>

    <section v-loading="loading" class="issue-panel">
      <div v-if="list.length" class="card-grid">
        <article v-for="item in list" :key="item.id" class="issue-card" tabindex="0" @click="goDetail(item.id)" @keydown.enter="goDetail(item.id)">
          <header>
            <span class="issue-no">{{ item.issue_no }}</span>
            <el-tag round size="small" :type="statusTagType(displayStatus(item))">{{ displayStatus(item) }}</el-tag>
          </header>
          <div class="participants">
            <el-avatar :size="26" class="creator-avatar">{{ firstChar(item.created_by_name) }}</el-avatar>
            <span>{{ item.created_by_name || '未命名发起人' }}</span>
          </div>
          <h2>{{ item.title }}</h2>
          <p class="description">{{ item.description || '暂未填写事项说明' }}</p>
          <div class="participants collaborators">{{ item.participants_name?.join('、') || '未指定协作成员' }}</div>
          <footer>
            <span><el-icon><Calendar /></el-icon> {{ formatDate(item.created_at) }}</span>
            <span v-if="item.deadline" :class="{ overdue: isOverdue(item) }"><el-icon><AlarmClock /></el-icon> 截止 {{ item.deadline }}</span>
            <el-button v-if="isCreator(item)" class="delete-card" text circle :icon="Delete" title="删除项目" @click.stop="removeIssue(item)" />
          </footer>
        </article>
      </div>
      <el-empty v-else :image-size="92" :description="phase === 'archived' ? '暂无归档事项' : '暂无匹配事项'">
        <template v-if="phase !== 'archived'">
        <el-button type="primary" @click="openCreate">发起第一件事项</el-button>
        </template>
      </el-empty>
    </section>

    <div v-if="total > pageSize" class="pagination-wrap">
      <el-pagination v-model:current-page="page" background layout="total, prev, pager, next" :total="total" :page-size="pageSize" @current-change="fetchList" />
    </div>

    <el-dialog v-model="dialogVisible" title="发起协同事项" width="min(640px, calc(100vw - 32px))" :close-on-click-modal="false" @closed="resetForm">
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
        <el-form-item label="事项标题" prop="title"><el-input v-model="form.title" maxlength="100" show-word-limit placeholder="例如：确认新店开业物料" /></el-form-item>
        <el-form-item label="事项说明"><el-input v-model="form.description" type="textarea" :rows="4" maxlength="1000" show-word-limit placeholder="说明背景、目标或需要协作的内容" /></el-form-item>
        <div class="form-dates">
          <el-form-item label="计划开始" prop="start_time"><el-date-picker v-model="form.start_time" :clearable="false" type="date" value-format="YYYY-MM-DD" placeholder="可选" /></el-form-item>
          <el-form-item label="截止日期" prop="deadline"><el-date-picker v-model="form.deadline" :clearable="false" type="date" value-format="YYYY-MM-DD" placeholder="可选" /></el-form-item>
        </div>
        <el-form-item label="协作成员"><el-select v-model="form.participants" multiple filterable clearable placeholder="选择需要参与的成员" @change="syncParticipantNames"><el-option v-for="user in selectableUsers" :key="user.id" :label="`${user.display_name || user.username} · ${user.role}`" :value="user.id" /></el-select><p class="form-tip">你会自动作为项目发起人参与，无需重复选择。</p></el-form-item>
      </el-form>
      <template #footer><el-button @click="dialogVisible = false">取消</el-button><el-button type="primary" :loading="submitting" @click="handleCreate">确认发起</el-button></template>
    </el-dialog>
  </main>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { AlarmClock, Calendar, Delete, Plus, Refresh, Search } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { createCollabIssue, deleteCollabIssue, getCollabIssues, getCollabUsers } from '@/api'
import { useAuthStore } from '@/stores/auth'

const router = useRouter(); const auth = useAuthStore(); const loading = ref(false); const list = ref([]); const total = ref(0); const page = ref(1); const pageSize = 12
const keyword = ref(''); const phase = ref('active'); const dialogVisible = ref(false); const submitting = ref(false); const formRef = ref(); const userList = ref([])
const form = reactive({ title: '', description: '', start_time: null, deadline: null, participants: [], participants_name: [], visibility: 'public' })
const phaseOptions = [{ label: '全部', value: 'active' }, { label: '待开始', value: 'pending' }, { label: '进行中', value: 'progress' }, { label: '已结束', value: 'ended' }, { label: '归档', value: 'archived' }]
const selectableUsers = computed(() => userList.value.filter(user => Number(user.id) !== Number(auth.user?.id)))
const rules = { title: [{ required: true, message: '请填写事项标题', trigger: 'blur' }], deadline: [{ validator: (_, value, done) => (!value || !form.start_time || value >= form.start_time) ? done() : done(new Error('截止日期不能早于开始日期')), trigger: 'change' }] }
const summaries = computed(() => [{ key: 'active', label: '当前结果', count: total.value, tone: 'blue' }, { key: 'pending', label: '待开始', count: list.value.filter(item => displayStatus(item) === '待开始').length, tone: 'slate' }, { key: 'progress', label: '进行中', count: list.value.filter(item => displayStatus(item) === '进行中').length, tone: 'amber' }, { key: 'ended', label: '已结束', count: list.value.filter(item => ['已完成','未完成','已终止'].includes(displayStatus(item))).length, tone: 'green' }, { key: 'archived', label: '归档', count: list.value.filter(item => item.archived_at).length, tone: 'blue' }])
function displayStatus(item) { return item.status_display || item.status }
function statusTagType(status) { return ({ '待开始': 'info', '进行中': 'warning', '已完成': 'success', '未完成': 'danger' })[status] || 'info' }
function formatDate(value) { return value ? String(value).slice(0, 10) : '—' }
function firstChar(name) { return (name || '协').trim().slice(0, 1) }
function isCreator(item) { return Number(item.created_by) === Number(auth.user?.id) }
function isOverdue(item) { return !!item.deadline && !['已完成', '未完成'].includes(displayStatus(item)) && item.deadline < new Date().toISOString().slice(0, 10) }
async function fetchList() { loading.value = true; try { const status = phase.value === 'pending' ? '待开始' : phase.value === 'progress' ? '进行中' : undefined; const res = await getCollabIssues({ status, phase: ['active','ended','archived'].includes(phase.value) ? phase.value : undefined, keyword: keyword.value || undefined, page: page.value, pageSize }); list.value = res.rows || []; total.value = res.total || 0 } catch (error) { ElMessage.error(error.message || '事项加载失败') } finally { loading.value = false } }
async function fetchUsers() { try { const res = await getCollabUsers(); userList.value = res.users || [] } catch { ElMessage.warning('成员列表加载失败') } }
function onFilterChange() { page.value = 1; fetchList() }; function selectStatus(status) { phase.value = status; onFilterChange() }; function goDetail(id) { router.push({ name: 'collab-detail', params: { id } }) }; function openCreate() { dialogVisible.value = true }
async function removeIssue(item) { try { await ElMessageBox.confirm(`删除“${item.title}”后，其所有动态不可恢复。`, '删除项目', { type: 'error', confirmButtonText: '删除' }); await deleteCollabIssue(item.id); ElMessage.success('项目已删除'); fetchList() } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message || '删除失败') } }
function syncParticipantNames(ids) { form.participants_name = ids.map(id => { const user = userList.value.find(item => item.id === id); return user?.display_name || user?.username || '' }).filter(Boolean) }
function resetForm() { Object.assign(form, { title: '', description: '', start_time: null, deadline: null, participants: [], participants_name: [], visibility: 'public' }); formRef.value?.clearValidate() }
async function handleCreate() { if (!(await formRef.value.validate().catch(() => false))) return; submitting.value = true; try { const res = await createCollabIssue({ ...form }); ElMessage.success(`事项 ${res.issue.issue_no} 已发起`); dialogVisible.value = false; page.value = 1; fetchList() } catch (error) { ElMessage.error(error.message || '发起失败') } finally { submitting.value = false } }
onMounted(() => { fetchUsers(); fetchList() })
</script>

<style scoped>
.collab-list-page{max-width:1320px;margin:0 auto;padding:24px 28px 56px;color:#25354d}.collab-hero{position:relative;display:flex;justify-content:space-between;align-items:center;min-height:138px;padding:24px 29px;overflow:hidden;border-radius:14px;background:linear-gradient(112deg,#143968,#245a9f 64%,#3b86cf);box-shadow:0 12px 28px rgba(24,71,130,.17);color:#fff}.collab-hero:after{content:'';position:absolute;right:-68px;top:-125px;width:300px;height:300px;border:40px solid rgba(255,255,255,.08);border-radius:50%}.collab-hero>div,.collab-hero :deep(.el-button){position:relative;z-index:1}.eyebrow{display:block;margin:0 0 5px;color:#b9d8f8;font-size:11px;font-weight:750;letter-spacing:.13em}.collab-hero h1{margin:0;font-size:28px;font-weight:750}.subtitle{margin:7px 0 0;color:#d8eafa;font-size:14px}.collab-hero :deep(.el-button--primary){border-color:#fff;background:#fff;color:#1d559b;font-weight:750;box-shadow:0 5px 14px rgba(0,0,0,.1)}.summary-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:11px;margin:14px 0}.summary-card{position:relative;padding:14px 16px;border:1px solid #e3e9f1;border-radius:11px;background:#fff;text-align:left;cursor:pointer;box-shadow:0 4px 12px rgba(16,24,40,.03);transition:border-color .18s,box-shadow .18s}.summary-card:hover,.summary-card.active{border-color:#8ab7e9;box-shadow:0 7px 16px #2e609514}.summary-card span{display:block;color:#7d8ca1;font-size:12px}.summary-card strong{display:block;margin-top:5px;font-size:22px;line-height:1.1}.summary-card i{position:absolute;right:15px;top:18px;width:8px;height:8px;border-radius:50%}.blue{background:#409eff}.slate{background:#909399}.amber{background:#e6a23c}.green{background:#48a572}.red{background:#e66f6f}.toolbar{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:14px 0;margin-bottom:14px;border-bottom:1px solid #e8edf3}.filter-group{display:flex;align-items:center;gap:9px}.filter-group :deep(.el-button){height:31px;padding:0 11px;border-color:#dbe4ed;color:#64748b;font-size:12px}.filter-group :deep(.el-button.active){border-color:#7bb5ee;background:#eef7ff;color:#2375be;font-weight:700}.toolbar-search{display:flex;gap:8px;width:min(420px,100%)}.issue-panel{min-height:220px}.card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}.issue-card{display:flex;min-height:194px;flex-direction:column;padding:18px;border:1px solid #e3e9f1;border-radius:12px;background:#fff;cursor:pointer;box-shadow:0 4px 12px rgba(16,24,40,.03);transition:border-color .18s,box-shadow .18s}.issue-card:hover{border-color:#8cb8e8;box-shadow:0 10px 22px rgba(24,71,130,.1)}.issue-card header,.issue-card footer{display:flex;justify-content:space-between;gap:10px;align-items:center}.issue-no{font:11px ui-monospace,monospace;color:#8492a6}.participants{display:flex;align-items:center;gap:7px;margin:13px 0 0;color:#516178;font-size:12px}.creator-avatar{background:#e7f0ff;color:#2765a9;font-weight:700}.participant-more{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8492a6}.issue-card h2{margin:12px 0 7px;font-size:17px;line-height:1.4}.description{display:-webkit-box;margin:0;color:#667085;font-size:13px;line-height:1.6;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.issue-card footer{margin-top:auto;padding-top:10px;border-top:1px solid #eef1f5;color:#8492a6;font-size:11px}.issue-card footer span{display:flex;align-items:center;gap:4px}.overdue{color:#db6161!important;font-weight:600}.pagination-wrap{display:flex;justify-content:flex-end;margin-top:20px}.form-dates{display:grid;grid-template-columns:1fr 1fr;gap:14px}.form-dates :deep(.el-date-editor){width:100%}@media(max-width:760px){.collab-list-page{padding:18px 16px 44px}.collab-hero{padding:22px;align-items:flex-start;gap:14px}.collab-hero h1{font-size:23px}.summary-grid{grid-template-columns:repeat(2,1fr)}.toolbar{align-items:stretch;flex-direction:column}.filter-group{justify-content:space-between}.toolbar-search{width:100%}.form-dates{grid-template-columns:1fr}.pagination-wrap{justify-content:center}}
 .description{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;-webkit-line-clamp:unset}.delete-card{margin-left:auto;color:#a1acba}.delete-card:hover{color:#dc5555;background:#fff1f1}
</style>
<style scoped>
.collaborators{min-height:18px;margin-top:10px;color:#8492a6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.form-tip{margin:6px 0 0;color:#98a2b3;font-size:12px}
.issue-card{height:230px;min-height:230px;box-sizing:border-box}.issue-card header{height:22px}.issue-card>.participants:not(.collaborators){height:28px;margin:10px 0 0}.issue-card h2{height:24px;margin:9px 0 5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.issue-card .description{height:21px;margin:0;line-height:21px}.issue-card .collaborators{height:20px;min-height:20px;margin:7px 0 0;line-height:20px}.issue-card footer{min-height:20px;margin-top:auto}.issue-card .collaborators:empty{visibility:hidden}
</style>
