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

        <el-table-column prop="position_name" label="岗位" min-width="150">
          <template #default="{ row }">
            <span :class="['position-badge', { empty: !row.position_name }]">{{ row.position_name || '未分配岗位' }}</span>
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

    <section class="people-card" style="padding:24px;margin-top:24px">
      <header class="people-toolbar"><div><h3>微信登录绑定审核</h3><span>核实申请编号与本人身份后，选择后台人员；绑定沿用该人员权限。</span></div><el-button :loading="bindingsLoading" @click="loadBindings">刷新申请</el-button></header>
      <el-table :data="wechatBindings" v-loading="bindingsLoading" empty-text="暂无微信绑定申请">
        <el-table-column prop="name" label="申请姓名" min-width="110" />
        <el-table-column prop="contact" label="联系方式" min-width="130" />
        <el-table-column prop="verification" label="申请编号" min-width="150" />
        <el-table-column label="状态" width="100"><template #default="{row}">{{ bindingStatus[row.status] || row.status }}</template></el-table-column>
        <el-table-column label="后台人员" min-width="220"><template #default="{row}">
          <el-select v-if="row.status === 'pending'" v-model="bindingTargets[row.id]" filterable placeholder="核实后选择人员" :disabled="reviewingId !== null">
            <el-option v-for="user in users" :key="user.id" :value="user.id" :label="`${user.display_name || user.username}（${user.username}）`" />
          </el-select><span v-else>{{ row.display_name || row.username || '—' }}</span>
        </template></el-table-column>
        <el-table-column label="操作" width="180"><template #default="{row}">
          <template v-if="row.status === 'pending'"><el-button link type="primary" :disabled="!bindingTargets[row.id] || reviewingId !== null" @click="reviewBinding(row, 'approve')">批准</el-button><el-button link type="danger" :disabled="reviewingId !== null" @click="reviewBinding(row, 'reject')">拒绝</el-button></template>
          <el-button v-if="row.status === 'approved'" link type="danger" :disabled="reviewingId !== null" @click="reviewBinding(row, 'revoke')">解除绑定</el-button>
        </template></el-table-column>
      </el-table>
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
          <span>{{ profileMode === 'create' ? '设置账号资料和所属岗位' : '更新该成员的账号资料' }}</span>
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
        <el-form-item label="岗位权限（可多选）" required>
          <div class="selected-position-field">
            <div class="selected-position-tags">
              <el-tag v-for="position in selectedPositions" :key="position.id" closable @close="removeSelectedPosition(position.id)">{{ position.name }}</el-tag>
              <span v-if="!selectedPositions.length" class="position-empty">尚未选择权限</span>
            </div>
            <el-button type="primary" plain @click="openPositionPicker">{{ selectedPositions.length ? '修改权限' : '选择权限' }}</el-button>
          </div>
        </el-form-item>
        <el-form-item label="绑定门店" :required="requiresStore"><el-select v-model="profileForm.store_id" filterable clearable placeholder="选择账号所属门店" style="width:100%"><el-option v-for="store in stores" :key="store.id" :label="store.store_name" :value="store.id" /></el-select><div class="position-form-hint">使用“店长（员工与工资）”岗位时必填；店长只能访问绑定门店。</div></el-form-item>
        <div class="form-grid form-grid-single">
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

    <el-dialog v-model="positionPickerVisible" title="选择岗位权限" width="min(720px, 94vw)" align-center append-to-body class="position-picker-dialog">
      <div class="position-picker-layout">
        <nav class="position-category-nav" aria-label="权限分类">
          <button v-for="category in positionCategories" :key="category.id" type="button" :class="{ active: positionCategory === category.id }" :aria-pressed="positionCategory === category.id" @click="positionCategory = category.id">
            <span>{{ category.name }}</span><small>{{ draftCategoryCount(category.id) }} 已选</small>
          </button>
        </nav>
        <section class="position-options">
          <el-input v-model="positionSearch" clearable placeholder="搜索岗位名称" aria-label="搜索岗位名称" />
          <div class="position-options-heading"><b>{{ positionCategory === 'group' ? '集团权限' : '门店权限' }}</b><span>可多选</span></div>
          <el-checkbox-group v-model="draftPositionIds" class="position-option-list" aria-label="可选岗位权限">
            <el-checkbox v-for="position in visiblePositions" :key="position.id" :label="position.id" class="position-option-row">
              <span>{{ position.name }}</span><small>{{ position.permissions?.includes('*') ? '全部权限' : `${position.permissions?.length || 0} 项权限` }}</small>
            </el-checkbox>
          </el-checkbox-group>
          <el-empty v-if="!visiblePositions.length" description="没有匹配的岗位" :image-size="60" />
        </section>
      </div>
      <div class="position-picker-summary"><span>已选 {{ draftPositionIds.length }} 项</span><div><el-tag v-for="position in draftSelectedPositions" :key="position.id" closable @close="draftPositionIds = draftPositionIds.filter(id => id !== position.id)">{{ position.name }}</el-tag><span v-if="!draftPositionIds.length" class="position-empty">请选择需要的权限</span></div></div>
      <template #footer><el-button @click="positionPickerVisible = false">取消</el-button><el-button type="primary" @click="confirmPositionPicker">确定</el-button></template>
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
  getWechatBindings,
  reviewWechatBinding,
  getStores,
  getPositions,
  updateUser,
  updateUserPassword,
  uploadUserAvatar,
} from '@/api'
import { useAuthStore } from '@/stores/auth'
import { ElMessage, ElMessageBox } from 'element-plus'

const auth = useAuthStore()
const users = ref([])
const wechatBindings = ref([])
const bindingsLoading = ref(false)
const bindingTargets = reactive({})
const reviewingId = ref(null)
const bindingStatus = { pending: '待审核', approved: '已绑定', rejected: '已拒绝', revoked: '已解除' }
async function loadBindings() {
  bindingsLoading.value = true
  try { wechatBindings.value = (await getWechatBindings()).requests || [] }
  catch (e) { ElMessage.error('绑定申请加载失败：' + e.message) }
  finally { bindingsLoading.value = false }
}
async function reviewBinding(row, action) {
  const user = users.value.find(u => u.id === bindingTargets[row.id])
  const message = action === 'approve' ? `确认已核实申请编号 ${row.verification}，将此微信绑定到 ${user?.display_name || user?.username}（${user?.username}）？` : action === 'reject' ? '确认拒绝此申请？' : '确认解除微信绑定？已登录的微信会话也会失效。'
  try { await ElMessageBox.confirm(message, '微信绑定审核', { type: 'warning' }) }
  catch { return }
  reviewingId.value = row.id
  try {
    await reviewWechatBinding(row.id, { action, user_id: bindingTargets[row.id] })
    ElMessage.success('已处理')
    await loadBindings()
  } catch (e) { ElMessage.error(e.message) }
  finally { reviewingId.value = null }
}
const positions = ref([])
const stores = ref([])
const requiresStore = computed(() => {const permissions=positions.value.filter(position=>profileForm.position_ids.includes(position.id)).flatMap(position=>position.permissions || []);return permissions.includes('staff.store.edit') && !permissions.includes('*')})
const selectedPositions = computed(() => positions.value.filter(position => profileForm.position_ids.includes(position.id)))
const positionPickerVisible = ref(false)
const draftPositionIds = ref([])
const positionCategory = ref('group')
const positionSearch = ref('')
const positionCategories = [{ id: 'group', name: '集团权限' }, { id: 'store', name: '门店权限' }]
// 分类仅帮助选择现有岗位；授权仍由岗位权限并集和账号绑定门店执行。
function positionGroup(position) {
  return position.permissions?.includes('staff.store.edit') || /店长/.test(position.name) ? 'store' : 'group'
}
const visiblePositions = computed(() => positions.value.filter(position => positionGroup(position) === positionCategory.value && position.name.toLowerCase().includes(positionSearch.value.trim().toLowerCase())))
const draftSelectedPositions = computed(() => positions.value.filter(position => draftPositionIds.value.includes(position.id)))
function draftCategoryCount(category) { return draftSelectedPositions.value.filter(position => positionGroup(position) === category).length }
function openPositionPicker() {
  draftPositionIds.value = [...profileForm.position_ids]
  positionCategory.value = 'group'
  positionSearch.value = ''
  positionPickerVisible.value = true
}
function confirmPositionPicker() {
  if (!draftPositionIds.value.length) { ElMessage.warning('请至少选择一个岗位权限'); return }
  if (draftPositionIds.value.length > 10) { ElMessage.warning('最多选择10个岗位权限'); return }
  profileForm.position_ids = [...draftPositionIds.value]
  positionPickerVisible.value = false
}
function removeSelectedPosition(id) { profileForm.position_ids = profileForm.position_ids.filter(value => value !== id) }
const keyword = ref('')
const loading = ref(false)
const saving = ref(false)
const savingPassword = ref(false)
const profileDialogVisible = ref(false)
const passwordDialogVisible = ref(false)
const profileMode = ref('create')
const editingUser = ref(null)
const passwordTarget = ref(null)
const avatarPalette = ['#4F7CFF', '#7B61E8', '#1FA98C', '#E29036', '#D65C76', '#337FAF', '#596579', '#8B6F47']

const emptyProfile = () => ({
  id: null,
  username: '',
  display_name: '',
  phone: '',
  position_ids: [],
  store_id: null,
  password: '',
  confirmPassword: '',
})
const profileForm = reactive(emptyProfile())
const passwordForm = reactive({ password: '', confirmPassword: '' })

const filteredUsers = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  if (!query) return users.value
  return users.value.filter(user =>
    [user.username, user.display_name, user.phone, user.role, user.position_name]
      .some(value => String(value || '').toLowerCase().includes(query))
  )
})
const adminCount = computed(() => users.value.filter(user => user.position_permissions?.includes('*')).length)

onMounted(() => Promise.all([loadUsers(), loadPositions(), loadStores(), loadBindings()]))

async function loadStores(){try{stores.value=(await getStores({page:1,page_size:500})).stores || []}catch(error){ElMessage.error('门店加载失败：'+error.message)}}

async function loadPositions() {
  try {
    const data = await getPositions()
    positions.value = data.positions || []
  } catch (error) {
    ElMessage.error('岗位加载失败：' + error.message)
  }
}

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
    phone: user.phone || '',
    position_ids: user.position_ids || (user.position_id?[user.position_id]:[]),
    store_id: user.store_id ?? null,
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
  if (!profileForm.position_ids.length) {
    ElMessage.warning('请为成员选择岗位')
    return
  }
  if (requiresStore.value && !profileForm.store_id) {ElMessage.warning('店长账号必须选择绑定门店');return}
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
      phone,
      position_ids: profileForm.position_ids,
      store_id: profileForm.store_id,
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
.position-badge {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 5px 9px;
  overflow: hidden;
  border: 1px solid #d9e4ff;
  border-radius: 16px;
  background: #f2f6ff;
  color: #3863bd;
  font-size: 10px;
  font-weight: 650;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.position-badge.empty { border-color: #e7eaf0; background: #fafbfc; color: #a0a8b5; font-weight: 500; }
.position-form-hint { margin-top: 7px; color: #8a95a8; font-size: 10px; line-height: 1.55; }
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
.form-grid-single { grid-template-columns: 1fr; }
.selected-position-field { display:flex;align-items:center;gap:12px;width:100%;padding:12px;border:1px solid #dce5f3;border-radius:8px;box-sizing:border-box; }
.selected-position-tags { display:flex;flex:1;flex-wrap:wrap;gap:8px;min-width:0; }
.position-empty { color:#7b879b;font-size:13px; }
.position-picker-layout { display:grid;grid-template-columns:160px minmax(0,1fr);min-height:300px; }
.position-category-nav { padding:0 16px 0 0;border-right:1px solid #e7edf5; }
.position-category-nav button { display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:48px;margin-bottom:8px;padding:10px 12px;background:transparent;border:0;border-radius:6px;color:#43536d;cursor:pointer; }
.position-category-nav button.active { color:#245eea;background:#eef4ff;font-weight:600; }
.position-category-nav small { font-size:12px;font-weight:400; }
.position-options { padding-left:20px; }
.position-options-heading { display:flex;justify-content:space-between;margin:16px 0 4px;padding:10px 12px;background:#f5f7fb;color:#43536d; }
.position-options-heading span { color:#7b879b;font-size:12px; }
.position-option-list { display:flex;flex-direction:column;max-height:300px;overflow:auto; }
.position-option-row { margin:0;min-height:46px;height:auto;padding:10px 12px;border-bottom:1px solid #edf1f7;box-sizing:border-box;white-space:normal; }
.position-option-row :deep(.el-checkbox__label) { display:flex;flex:1;justify-content:space-between;gap:12px;line-height:1.5; }
.position-option-row small { color:#7b879b;font-size:12px;flex-shrink:0; }
.position-picker-summary { display:flex;gap:16px;align-items:flex-start;border-top:1px solid #e7edf5;margin-top:20px;padding-top:16px;font-size:13px; }
.position-picker-summary > span { white-space:nowrap;color:#526580;line-height:24px; }
.position-picker-summary > div { display:flex;gap:8px;flex-wrap:wrap; }
@media (max-width:560px) {
  .position-picker-layout { grid-template-columns:1fr; }
  .position-category-nav { display:flex;gap:8px;padding:0;border-right:0; }
  .position-options { padding-left:0; }
  .selected-position-field { align-items:flex-start; }
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
