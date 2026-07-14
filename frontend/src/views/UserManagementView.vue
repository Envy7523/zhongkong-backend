<template>
  <div>
    <div class="card-compact">
      <div class="card-header">👥 权限设置</div>
      <el-space style="margin-bottom:16px;">
        <el-button type="primary" @click="showAddDialog">➕ 添加用户</el-button>
        <el-button @click="loadUsers">🔄 刷新</el-button>
      </el-space>
      <el-table :data="users" style="width:100%;">
        <el-table-column prop="username" label="用户名" />
        <el-table-column prop="role" label="角色" />
        <el-table-column prop="display_name" label="显示名称" />
        <el-table-column prop="created_at" label="创建时间" />
      </el-table>
    </div>

    <el-dialog v-model="dialogVisible" title="添加用户" width="400px">
      <el-form label-width="80px">
        <el-form-item label="用户名">
          <el-input v-model="newUser.username" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="newUser.password" type="password" show-password />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="newUser.role" style="width:100%;">
            <el-option label="客服" value="客服" />
            <el-option label="督导" value="督导" />
            <el-option label="管理员" value="管理员" />
          </el-select>
        </el-form-item>
        <el-form-item label="显示名称">
          <el-input v-model="newUser.display_name" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="addUser">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { getUsers, createUser } from '@/api'
import { ElMessage } from 'element-plus'

const users = ref([])
const dialogVisible = ref(false)
const newUser = reactive({ username: '', password: '', role: '客服', display_name: '' })

onMounted(() => loadUsers())

async function loadUsers() {
  try {
    const data = await getUsers()
    users.value = data.users || []
  } catch (e) {
    ElMessage.error('加载失败: ' + e.message)
  }
}

function showAddDialog() {
  newUser.username = ''; newUser.password = ''; newUser.role = '客服'; newUser.display_name = ''
  dialogVisible.value = true
}

async function addUser() {
  if (!newUser.username || !newUser.password) { ElMessage.warning('用户名和密码不能为空'); return }
  try {
    await createUser({ ...newUser })
    dialogVisible.value = false
    loadUsers()
    ElMessage.success('添加成功')
  } catch (e) {
    ElMessage.error('添加失败: ' + e.message)
  }
}
</script>
