<template>
  <div class="people-page">
    <section class="people-hero">
      <div>
        <span class="people-eyebrow">TEAM & ACCESS</span>
        <h2>人员管理</h2>
        <p>统一管理后台登录账号、成员资料和系统权限。</p>
      </div>
      <div class="people-summary">
        <div><strong>{{ users.length }}</strong><span>成员总数</span></div>
        <div><strong>{{ adminCount }}</strong><span>管理员</span></div>
        <el-button type="primary" size="large" round @click="openCreateDialog">添加成员</el-button>
      </div>
    </section>

    <section class="people-card">
      <header class="people-toolbar">
        <div>
          <h3>账号目录</h3>
          <span>成员头像、登录信息与权限设置</span>
        </div>
        <div class="people-toolbar-actions">
          <el-input v-model="keyword" clearable placeholder="搜索用户名、名称或手机号" class="people-search">
            <template #prefix>⌕</template>
          </el-input>
          <el-button :loading="loading" @click="loadUsers">刷新</el-button>
        </div>
      </header>

      <el-table
        v-loading="loading"
        :data="filteredUsers"
        class="people-table"
        row-key="id"
        empty-text="暂无成员"
      >
        <el-table-column label="头像" width="92" align="center">
          <template #default="{ row }">
            <label class="avatar-uploader" :title="row.avatar_url ? '更换头像' : '上传头像'">
              <img v-if="row.avatar_url" :src="row.avatar_url" :alt="`${row.display_name || row.username}的头像`" />
              <span v-else class="default-avatar" :style="{ background: avatarColor(row) }">
                {{ avatarLetter(row) }}
              </span>
              <span class="avatar-overlay">更换</span>
              <input type="file" accept="image/png,image/jpeg,image/webp" @change="event => uploadAvatar(event, row)" />
            </label>
          </template>
        </el-table-column>

        <el-table-column prop="username" min-width="170">
          <template #header>
            <span class="column-title">用户名 <small>登录账号</small></span>
          </template>
          <template #default="{ row }">
            <div class="account-cell">
              <b>{{ row.username }}</b>
              <span v-if="row.id === auth.user?.id">当前账号</span>
            </div>
          </template>
        </el-table-column>

        <el-table-column prop="display_name" min-width="160">
          <template #header>
            <span class="column-title">名称 <small>Name</small></span>
          </template>
          <template #default="{ row }">
            <span class="name-cell">{{ row.display_name || '—' }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="role" label="权限" width="130">
          <template #default="{ row }">
            <span class="role-badge" :class="roleClass(row.role)">
              <i></i>{{ row.role || '客服' }}
            </span>
          </template>
        </el-table-column>

        <el-table-column prop="phone" label="手机号" min-width="165">
          <template #default="{ row }">
            <span :class="['phone-cell', { empty: !row.phone }]">{{ row.phone || '未填写' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="280" fixed="right" align="right">
          <template #default="{ row }">
            <div class="row-actions">
              <el-button link type="primary" @click="openEditDialog(row)">编辑</el-button>
              <el-button link @click="openPasswordDialog(row)">修改密码</el-button>
              <el-button
                link
                type="danger"
                :disabled="row.id === auth.user?.id"
                @click="removeUser(row)"
              >删除</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <footer class="people-footer">
        <span>共 {{ filteredUsers.length }} 位成员</span>
        <span>头像支持 PNG、JPEG、WebP，大小不超过 2MB</span>
      </footer>
    </section>

    <el-dialog
      v-model="profileDialogVisible"
      :title="profileMode === 'create' ? '添加成员' : '编辑成员'"
      width="520px"
      align-center
      class="people-dialog"
      @closed="resetProfileForm"
    >
      <div class="dialog-intro">
        <span class="dialog-avatar" :style="{ background: avatarColor(profileForm) }">
          {{ avatarLetter(profileForm) }}
        </span>
        <div>
          <b>{{ profileMode === 'create' ? '创建新的登录账号' : profileForm.display_name || profileForm.username }}</b>
          <span>{{ profileMode === 'create' ? '设置账号资料和初始权限' : '更新该成员的账号资料' }}</span>
        </div>
      </div>

      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="用户名（登录账号）" required>
            <el-input v-model="profileForm.username" maxlength="50" placeholder="请输入登录账号" />
          </el-form-item>
          <el-form-item label="名称（Name）" required>
            <el-input v-model="profileForm.display_name" maxlength="30" placeholder="请输入成员名称" />
          </el-form-item>
        </div>
        <div class="form-grid">
          <el-form-item label="权限" required>
            <el-select v-model="profileForm.role" style="width:100%;">
              <el-option v-for="role in roleOptions" :key="role" :label="role" :value="role" />
            </el-select>
          </el-form-item>
          <el-form-item label="手机号">
            <el-input v-model="profileForm.phone" maxlength="30" placeholder="请输入手机号" />
          </el-form-item>
        </div>
        <template v-if="profileMode === 'create'">
          <div class="form-grid">
            <el-form-item label="初始密码" required>
              <el-input v-model="profileForm.password" type="password" show-password placeholder="至少 6 位" />
            </el-form-item>
            <el-form-item label="确认密码" required>
              <el-input v-model="profileForm.confirmPassword" type="password" show-password placeholder="再次输入密码" />
            </el-form-item>
          </div>
        </template>
        <div v-else class="avatar-management">
          <span>个人头像</span>
          <div>
            <label class="upload-text-button">
              上传新头像
              <input type="file" accept="image/png,image/jpeg,image/webp" @change="event => uploadAvatar(event, editingUser)" />
            </label>
            <el-button v-if="editingUser?.avatar_url" link type="danger" @click="removeAvatar(editingUser)">恢复默认头像</el-button>
          </div>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="profileDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveProfile">
          {{ profileMode === 'create' ? '创建成员' : '保存修改' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="passwordDialogVisible"
      title="修改密码"
      width="430px"
      align-center
      class="people-dialog"
      @closed="resetPasswordForm"
    >
      <div class="password-target">
        <span class="dialog-avatar small" :style="{ background: avatarColor(passwordTarget || {}) }">
          {{ avatarLetter(passwordTarget || {}) }}
        </span>
        <div>
          <b>{{ passwordTarget?.display_name || passwordTarget?.username }}</b>
          <span>登录账号：{{ passwordTarget?.username }}</span>
        </div>
      </div>
      <el-form label-position="top">
        <el-form-item label="新密码" required>
          <el-input v-model="passwordForm.password" type="password" show-password placeholder="至少 6 位" />
        </el-form-item>
        <el-form-item label="确认新密码" required>
          <el-input v-model="passwordForm.confirmPassword" type="password" show-password placeholder="再次输入新密码" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="passwordDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="savingPassword" @click="savePassword">确认修改</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import {
  createUser,
  deleteUser,
  deleteUserAvatar,
  getUsers,
  updateUser,
  updateUserPassword,
  uploadUserAvatar,
} from '@/api'
import { useAuthStore } from '@/stores/auth'
import { ElMessage, ElMessageBox } from 'element-plus'

const auth = useAuthStore()
const users = ref([])
const keyword = ref('')
const loading = ref(false)
const saving = ref(false)
const savingPassword = ref(false)
const profileDialogVisible = ref(false)
const passwordDialogVisible = ref(false)
const profileMode = ref('create')
const editingUser = ref(null)
const passwordTarget = ref(null)
const roleOptions = ['管理员', '负责人', '团购', '外卖', '督导', '专员', '客服']
const avatarPalette = ['#4F7CFF', '#7B61E8', '#1FA98C', '#E29036', '#D65C76', '#337FAF', '#596579', '#8B6F47']

const emptyProfile = () => ({
  id: null,
  username: '',
  display_name: '',
  role: '客服',
  phone: '',
  password: '',
  confirmPassword: '',
})
const profileForm = reactive(emptyProfile())
const passwordForm = reactive({ password: '', confirmPassword: '' })

const filteredUsers = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  if (!query) return users.value
  return users.value.filter(user =>
    [user.username, user.display_name, user.phone, user.role]
      .some(value => String(value || '').toLowerCase().includes(query))
  )
})
const adminCount = computed(() => users.value.filter(user => user.role === '管理员').length)

onMounted(loadUsers)

async function loadUsers() {
  loading.value = true
  try {
    const data = await getUsers()
    users.value = data.users || []
  } catch (error) {
    ElMessage.error('加载失败：' + error.message)
  } finally {
    loading.value = false
  }
}

function avatarLetter(user) {
  const text = String(user?.display_name || user?.username || '用').trim()
  return (text.slice(0, 1) || '用').toUpperCase()
}

function avatarColor(user) {
  const text = String(user?.display_name || user?.username || 'user')
  let hash = 0
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) - hash) + text.charCodeAt(index)
  return avatarPalette[Math.abs(hash) % avatarPalette.length]
}

function roleClass(role) {
  return {
    管理员: 'admin',
    负责人: 'supervisor',
    团购: 'specialist',
    外卖: 'service',
    督导: 'supervisor',
    专员: 'specialist',
    客服: 'service',
  }[role] || 'service'
}

function openCreateDialog() {
  profileMode.value = 'create'
  editingUser.value = null
  Object.assign(profileForm, emptyProfile())
  profileDialogVisible.value = true
}

function openEditDialog(user) {
  profileMode.value = 'edit'
  editingUser.value = user
  Object.assign(profileForm, emptyProfile(), {
    id: user.id,
    username: user.username,
    display_name: user.display_name || '',
    role: user.role || '客服',
    phone: user.phone || '',
  })
  profileDialogVisible.value = true
}

function resetProfileForm() {
  Object.assign(profileForm, emptyProfile())
  editingUser.value = null
}

function validPhone(phone) {
  return !phone || /^[+\d][\d\s-]{5,29}$/.test(phone)
}

async function saveProfile() {
  const username = profileForm.username.trim()
  const displayName = profileForm.display_name.trim()
  const phone = profileForm.phone.trim()
  if (!username || !displayName) {
    ElMessage.warning('请填写用户名和名称')
    return
  }
  if (!validPhone(phone)) {
    ElMessage.warning('请输入正确的手机号')
    return
  }
  if (profileMode.value === 'create') {
    if (profileForm.password.length < 6) {
      ElMessage.warning('初始密码至少需要 6 位')
      return
    }
    if (profileForm.password !== profileForm.confirmPassword) {
      ElMessage.warning('两次输入的密码不一致')
      return
    }
  }

  saving.value = true
  try {
    const payload = {
      username,
      display_name: displayName,
      role: profileForm.role,
      phone,
    }
    if (profileMode.value === 'create') {
      await createUser({ ...payload, password: profileForm.password })
      ElMessage.success('成员已创建')
    } else {
      await updateUser(profileForm.id, payload)
      ElMessage.success('成员资料已更新')
    }
    profileDialogVisible.value = false
    await loadUsers()
  } catch (error) {
    ElMessage.error((profileMode.value === 'create' ? '创建失败：' : '保存失败：') + error.message)
  } finally {
    saving.value = false
  }
}

function openPasswordDialog(user) {
  passwordTarget.value = user
  resetPasswordForm()
  passwordDialogVisible.value = true
}

function resetPasswordForm() {
  passwordForm.password = ''
  passwordForm.confirmPassword = ''
}

async function savePassword() {
  if (passwordForm.password.length < 6) {
    ElMessage.warning('密码至少需要 6 位')
    return
  }
  if (passwordForm.password !== passwordForm.confirmPassword) {
    ElMessage.warning('两次输入的密码不一致')
    return
  }
  savingPassword.value = true
  try {
    await updateUserPassword(passwordTarget.value.id, passwordForm.password)
    passwordDialogVisible.value = false
    ElMessage.success('密码已修改')
  } catch (error) {
    ElMessage.error('修改失败：' + error.message)
  } finally {
    savingPassword.value = false
  }
}

async function removeUser(user) {
  if (user.id === auth.user?.id) return
  try {
    await ElMessageBox.confirm(
      `删除后「${user.display_name || user.username}」将无法登录，是否继续？`,
      '删除成员',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    )
    await deleteUser(user.id)
    await loadUsers()
    ElMessage.success('成员已删除')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error('删除失败：' + error.message)
  }
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}

async function uploadAvatar(event, user) {
  const input = event.target
  const file = input.files?.[0]
  input.value = ''
  if (!file || !user?.id) return
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    ElMessage.warning('仅支持 PNG、JPEG 或 WebP 图片')
    return
  }
  if (file.size > 2 * 1024 * 1024) {
    ElMessage.warning('头像大小不能超过 2MB')
    return
  }
  try {
    const data = await readAsDataUrl(file)
    await uploadUserAvatar(user.id, data)
    await loadUsers()
    if (editingUser.value?.id === user.id) {
      editingUser.value = users.value.find(item => item.id === user.id) || null
    }
    ElMessage.success('头像已更新')
  } catch (error) {
    ElMessage.error('头像上传失败：' + error.message)
  }
}

async function removeAvatar(user) {
  try {
    await deleteUserAvatar(user.id)
    await loadUsers()
    editingUser.value = users.value.find(item => item.id === user.id) || null
    ElMessage.success('已恢复默认头像')
  } catch (error) {
    ElMessage.error('操作失败：' + error.message)
  }
}
</script>

<style scoped>
.people-page {
  --people-blue: #4f7cff;
  --people-ink: #1d2939;
  --people-muted: #7b8798;
  color: var(--people-ink);
}
.people-hero {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 28px;
  margin-bottom: 18px;
  padding: 26px 30px;
  border-radius: 18px;
  color: #fff;
  background:
    radial-gradient(circle at 78% 0%, rgba(146,178,255,.32), transparent 32%),
    linear-gradient(125deg, #172b66, #3156b9 62%, #4f7cff);
  box-shadow: 0 18px 40px rgba(34,66,150,.16);
}
.people-eyebrow {
  color: #aec5ff;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .2em;
}
.people-hero h2 { margin: 7px 0 4px; font-size: 26px; }
.people-hero p { margin: 0; color: rgba(255,255,255,.7); font-size: 13px; }
.people-summary {
  display: flex;
  align-items: center;
  gap: 12px;
}
.people-summary > div {
  min-width: 82px;
  padding: 9px 12px;
  border: 1px solid rgba(255,255,255,.15);
  border-radius: 11px;
  background: rgba(255,255,255,.08);
}
.people-summary strong,
.people-summary span { display: block; }
.people-summary strong { font-size: 20px; }
.people-summary span { margin-top: 2px; color: rgba(255,255,255,.6); font-size: 9px; }
.people-summary .el-button { margin-left: 5px; }

.people-card {
  overflow: hidden;
  border: 1px solid #e7eaf0;
  border-radius: 18px;
  background: #fff;
  box-shadow: 0 10px 30px rgba(27,39,67,.06);
}
.people-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 20px 22px;
  border-bottom: 1px solid #edf0f4;
}
.people-toolbar h3 { margin: 0 0 4px; font-size: 16px; }
.people-toolbar > div > span { color: #8a94a4; font-size: 10px; }
.people-toolbar-actions { display: flex; gap: 9px; }
.people-search { width: 250px; }
.people-search :deep(.el-input__wrapper) { border-radius: 9px; }
.people-table { width: 100%; }
.people-table :deep(th.el-table__cell) {
  height: 48px;
  background: #fafbfc;
  color: #707b8d;
  font-size: 11px;
  font-weight: 650;
}
.people-table :deep(td.el-table__cell) {
  height: 68px;
  border-bottom-color: #f0f2f5;
}
.people-table :deep(.el-table__row) { transition: background-color .18s ease; }
.people-table :deep(.el-table__row:hover > td.el-table__cell) { background: #f8faff; }
.column-title { display: inline-flex; align-items: center; gap: 5px; }
.column-title small { color: #a8b0bd; font-size: 9px; font-weight: 500; }
.avatar-uploader {
  position: relative;
  display: inline-grid;
  width: 40px;
  height: 40px;
  overflow: hidden;
  place-items: center;
  border-radius: 12px;
  cursor: pointer;
  box-shadow: 0 0 0 1px rgba(28,39,59,.08);
}
.avatar-uploader img,
.default-avatar {
  width: 100%;
  height: 100%;
}
.avatar-uploader img { object-fit: cover; }
.default-avatar {
  display: grid;
  place-items: center;
  color: #fff;
  font-size: 15px;
  font-weight: 700;
}
.avatar-overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(17,24,39,.6);
  color: #fff;
  font-size: 9px;
  opacity: 0;
  transition: opacity .18s ease;
}
.avatar-uploader:hover .avatar-overlay { opacity: 1; }
.avatar-uploader input,
.upload-text-button input { display: none; }
.account-cell b { display: inline-block; color: #344054; font-size: 12px; }
.account-cell span {
  display: inline-block;
  margin-left: 7px;
  padding: 2px 6px;
  border-radius: 12px;
  background: #eef3ff;
  color: var(--people-blue);
  font-size: 8px;
}
.name-cell { color: #536074; font-size: 12px; }
.phone-cell { color: #536074; font-variant-numeric: tabular-nums; }
.phone-cell.empty { color: #b1b8c3; }
.role-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  border-radius: 16px;
  font-size: 10px;
  font-weight: 600;
}
.role-badge i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.role-badge.admin { color: #7146d3; background: #f2edff; }
.role-badge.supervisor { color: #be7723; background: #fff4e5; }
.role-badge.specialist { color: #2877c4; background: #eaf4ff; }
.role-badge.service { color: #288a70; background: #e9f8f3; }
.row-actions { white-space: nowrap; }
.row-actions .el-button + .el-button { margin-left: 13px; }
.people-footer {
  display: flex;
  justify-content: space-between;
  padding: 13px 22px;
  border-top: 1px solid #edf0f4;
  background: #fafbfc;
  color: #929baa;
  font-size: 9px;
}

.dialog-intro,
.password-target {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
  padding: 13px 14px;
  border: 1px solid #e7eaf0;
  border-radius: 11px;
  background: #f8f9fb;
}
.dialog-avatar {
  display: grid;
  flex: 0 0 auto;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: 12px;
  color: #fff;
  font-size: 15px;
  font-weight: 700;
}
.dialog-avatar.small { width: 36px; height: 36px; border-radius: 10px; }
.dialog-intro b,
.dialog-intro span,
.password-target b,
.password-target span { display: block; }
.dialog-intro b,
.password-target b { color: #344054; font-size: 12px; }
.dialog-intro span,
.password-target span { margin-top: 3px; color: #8b95a5; font-size: 10px; }
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.avatar-management {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0 2px;
  border-top: 1px solid #edf0f4;
  color: #606b7d;
  font-size: 11px;
}
.avatar-management > div { display: flex; align-items: center; gap: 12px; }
.upload-text-button { color: var(--people-blue); cursor: pointer; font-weight: 600; }

@media (max-width: 900px) {
  .people-hero { align-items: flex-start; flex-direction: column; }
  .people-toolbar { align-items: flex-start; flex-direction: column; }
  .people-toolbar-actions { width: 100%; }
  .people-search { flex: 1; width: auto; }
}
</style>
