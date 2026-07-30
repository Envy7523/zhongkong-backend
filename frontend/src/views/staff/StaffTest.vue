<template>
  <!-- 统计卡片 -->
  <div class="dash-stat-grid">
    <div class="dash-stat-card">
      <div class="dash-stat-icon" style="background:#f0e6ff;"><el-icon size="22"><DataAnalysis /></el-icon></div>
      <div class="dash-stat-body">
        <div class="dash-stat-value" style="color:#7c3aed;">{{ stats.total ?? '—' }}</div>
        <div class="dash-stat-label">测试员工总数</div>
      </div>
    </div>
    <div class="dash-stat-card">
      <div class="dash-stat-icon" style="background:#e8f8e8;"><el-icon size="22"><UserFilled /></el-icon></div>
      <div class="dash-stat-body">
        <div class="dash-stat-value success">{{ stats.managers ?? '—' }}</div>
        <div class="dash-stat-label">店长</div>
      </div>
    </div>
    <div class="dash-stat-card">
      <div class="dash-stat-icon" style="background:#e8f4ff;"><el-icon size="22"><User /></el-icon></div>
      <div class="dash-stat-body">
        <div class="dash-stat-value primary">{{ stats.clerks ?? '—' }}</div>
        <div class="dash-stat-label">店员</div>
      </div>
    </div>
    <div class="dash-stat-card">
      <div class="dash-stat-icon" style="background:#fff7e6;"><el-icon size="22"><Shop /></el-icon></div>
      <div class="dash-stat-body">
        <div class="dash-stat-value warning">{{ stats.stores ?? '—' }}</div>
        <div class="dash-stat-label">覆盖门店</div>
      </div>
    </div>
  </div>

  <!-- 操作栏 -->
  <div class="card-compact">
    <div class="card-header">🛠 测试数据管理</div>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
      <el-button type="primary" @click="handleReseed" :loading="seeding">
        🔄 重新生成测试数据
      </el-button>
      <el-button @click="showWebhook = !showWebhook">
        {{ showWebhook ? '📡 收起企微测试' : '📡 企微 Webhook 测试' }}
      </el-button>
      <el-button @click="showBotTest = !showBotTest">
        {{ showBotTest ? '🤖 收起 Bot 测试' : '🤖 Bot 连接测试' }}
      </el-button>
      <el-button type="success" @click="handleSyncPull" :loading="syncing">
        🔄 从企微同步
      </el-button>
      <span style="color:#909399;font-size:13px;">
        当前共 <b>{{ stats.total || 0 }}</b> 条测试员工数据，
        覆盖 <b>{{ stats.stores || 0 }}</b> 家门店
      </span>
      <span v-if="syncMsg" :style="{ color: syncOk ? '#27ae60' : '#e74c3c', fontSize: '13px' }">
        {{ syncMsg }}
      </span>
    </div>
  </div>

  <!-- 企微 Webhook 测试（可折叠） -->
  <div class="card-compact" v-if="showWebhook">
    <div class="card-header">📡 企微智能表格 Webhook 测试</div>
    <el-form label-width="100px" style="max-width:800px;">
      <el-form-item label="Webhook URL">
        <el-input v-model="webhookUrl" placeholder="企微智能表格 webhook 地址" />
      </el-form-item>
      <el-divider content-position="left">📋 表单字段</el-divider>
      <el-row :gutter="12">
        <el-col :span="12">
          <el-form-item label="文本">
            <el-input v-model="form.text" placeholder="请输入文本内容" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="单选">
            <el-select v-model="form.singleSelect" placeholder="请选择" style="width:100%;">
              <el-option v-for="o in selectOptions" :key="o" :label="o" :value="o" />
            </el-select>
          </el-form-item>
        </el-col>
      </el-row>
      <el-row :gutter="12">
        <el-col :span="8">
          <el-form-item label="人员"><el-input v-model="form.userId" placeholder="user_id" /></el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="数字"><el-input-number v-model="form.number" :min="0" style="width:100%;" /></el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="日期">
            <el-date-picker v-model="form.date" type="date" placeholder="选择日期" value-format="x" style="width:100%;" />
          </el-form-item>
        </el-col>
      </el-row>
      <el-form-item>
        <el-button type="primary" @click="sendRequest" :loading="sending">🚀 发送到企微智能表格</el-button>
        <el-button @click="resetForm">重置</el-button>
      </el-form-item>
      <el-form-item label="Payload" v-if="showWebhook">
        <el-input v-model="payloadJson" type="textarea" :rows="10" readonly style="font-family:monospace;font-size:12px;" />
      </el-form-item>
    </el-form>
    <div v-if="result" style="margin-top:12px;">
      <div :style="{ color: result.error ? '#e74c3c' : '#27ae60', fontWeight: 'bold', marginBottom: '8px' }">
        {{ result.error ? '❌ 请求失败' : '✅ 请求成功' }}
      </div>
      <pre class="result-block">{{ resultJson }}</pre>
    </div>
  </div>

  <!-- 🤖 Bot 连接测试（可折叠） -->
  <div class="card-compact" v-if="showBotTest">
    <div class="card-header">🤖 Bot 连接测试（bot id + secret 数据互通）</div>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
      <el-button type="primary" @click="handleBotTest" :loading="botTesting">
        🔌 测试 Bot 连接
      </el-button>
      <el-select v-model="botQueryApi" placeholder="查询类型" style="width:160px;">
        <el-option label="部门列表" value="department_list" />
        <el-option label="成员列表" value="user_list" />
        <el-option label="成员详情" value="user_info" />
      </el-select>
      <el-input v-if="botQueryApi === 'user_list' || botQueryApi === 'user_info'"
        v-model="botQueryDeptId" placeholder="部门ID（默认1）" style="width:120px;" />
      <el-input v-if="botQueryApi === 'user_info'"
        v-model="botQueryUserId" placeholder="userid" style="width:160px;" />
      <el-button type="success" @click="handleBotQuery" :loading="botQuerying">
        📡 执行查询
      </el-button>
      <span style="color:#909399;font-size:12px;">
        Bot ID: <code>{{ botConfig.botId || '未配置' }}</code>
      </span>
    </div>
    <!-- Bot 测试结果 -->
    <div v-if="botResult" style="margin-top:8px;">
      <div :style="{ color: botResultOk ? '#27ae60' : '#e74c3c', fontWeight: 'bold', marginBottom: '8px' }">
        {{ botResultOk ? '✅ 操作成功' : '❌ 操作失败' }}
      </div>
      <div v-if="botResult.message" style="color:#27ae60;margin-bottom:4px;">{{ botResult.message }}</div>
      <div v-if="botResult.token_preview" style="color:#909399;font-size:12px;margin-bottom:4px;">Token: {{ botResult.token_preview }}</div>
      <pre class="result-block">{{ botResultJson }}</pre>
    </div>
  </div>

  <!-- 员工列表 -->
  <div class="card-compact">
    <div class="card-header">📋 测试员工列表（按门店分组）</div>
    <el-table :data="allStaff" style="width:100%;" v-loading="loading" stripe max-height="600">
      <el-table-column prop="store_name" label="所属门店" min-width="160" fixed="left" show-overflow-tooltip />
      <el-table-column prop="name" label="姓名" width="100" />
      <el-table-column prop="role" label="角色" width="70">
        <template #default="{ row }">
          <el-tag :type="row.role === '店长' ? 'warning' : 'info'" size="small">{{ row.role }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="phone" label="手机号" width="130" />
      <el-table-column prop="gender" label="性别" width="60" />
      <el-table-column prop="age" label="年龄" width="60" />
      <el-table-column prop="position" label="职位" width="90" />
      <el-table-column prop="entry_date" label="入职日期" width="110" />
      <el-table-column prop="status" label="状态" width="70">
        <template #default="{ row }">
          <el-tag :type="row.status === '在职' ? 'success' : 'info'" size="small">{{ row.status || '—' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="remark" label="备注" min-width="120" show-overflow-tooltip />
    </el-table>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { getStaffList, seedStaff, sendSmartSheet, syncPullStaff, botTest, botQuery } from '@/api'
import { ElMessage, ElMessageBox } from 'element-plus'

const stats = ref({ total: 0, managers: 0, clerks: 0, stores: 0 })
const allStaff = ref([])
const loading = ref(false)
const seeding = ref(false)
const syncing = ref(false)
const syncMsg = ref('')
const syncOk = ref(true)
const showWebhook = ref(false)

// ===== 加载测试数据 =====
async function loadData() {
  loading.value = true
  try {
    const data = await getStaffList({ page: 1, page_size: 200 })
    allStaff.value = data.list || []
    // 计算统计
    const total = data.total || 0
    const managers = allStaff.value.filter(r => r.role === '店长').length
    const clerks = total - managers
    const storeSet = new Set(allStaff.value.map(r => r.store_name).filter(Boolean))
    stats.value = { total, managers, clerks, stores: storeSet.size }
  } catch (e) {
    ElMessage.error('加载失败: ' + e.message)
  } finally { loading.value = false }
}

// ===== 重新生成测试数据 =====
async function handleReseed() {
  try {
    await ElMessageBox.confirm(
      '将删除所有现有员工数据，重新生成 8 家门店共 30 条测试员工数据。确定继续？',
      '确认重新生成',
      { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' }
    )
  } catch { return }

  seeding.value = true
  try {
    const res = await seedStaff()
    ElMessage.success(res.message || `已重新生成 ${res.count} 条测试数据`)
    await loadData()
  } catch (e) {
    ElMessage.error('生成失败: ' + e.message)
  } finally { seeding.value = false }
}

// ===== 从企微同步员工数据 =====
async function handleSyncPull() {
  syncing.value = true
  syncMsg.value = ''
  try {
    const res = await syncPullStaff()
    syncOk.value = true
    syncMsg.value = res.message || '同步完成'
    ElMessage.success(res.message || '同步完成')
    await loadData()
    // 5秒后清除消息
    setTimeout(() => { syncMsg.value = '' }, 5000)
  } catch (e) {
    syncOk.value = false
    syncMsg.value = '同步失败: ' + e.message
    ElMessage.error('同步失败: ' + e.message)
  } finally { syncing.value = false }
}

onMounted(loadData)

// ===== 企微 Webhook 测试 =====
const webhookUrl = ref('https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/webhook?key=2tJ2YXXfaSZh89o9jNRgnIX4xzBDPA4i8sGlO5PSZfOGZh2rXz6O5X3FtMmtospaIhaew2iIfeaUqgKpf1qSWTbldvyVFEiVVqTDMVd5Wmsz')
const selectOptions = ['测试选项']
const form = reactive({ text: '', singleSelect: '', userId: '', number: 1, date: '' })
const sending = ref(false)
const result = ref(null)

const payload = computed(() => {
  const values = {}
  if (form.text) values['f04Gwj'] = form.text
  if (form.singleSelect) values['ftQMc5'] = [{ text: form.singleSelect }]
  if (form.userId) values['ftk5Tx'] = [{ user_id: form.userId }]
  if (form.number != null) values['ffFwIh'] = form.number
  if (form.date) values['fn8TJd'] = String(form.date)
  return {
    schema: {
      f04Gwj: { title: '文本', type: 'text' },
      ftQMc5: { title: '单选', type: 'single_select', enum: selectOptions },
      ftk5Tx: { title: '人员', type: 'user' },
      ffFwIh: { title: '数字', type: 'number' },
      fn8TJd: { title: '日期', type: 'date_time' },
    },
    add_records: [{ values }],
  }
})
const payloadJson = computed(() => JSON.stringify(payload.value, null, 2))
const resultJson = computed(() => result.value ? JSON.stringify(result.value, null, 2) : '')

async function sendRequest() {
  if (!webhookUrl.value) { ElMessage.warning('请输入 Webhook URL'); return }
  result.value = null
  sending.value = true
  try {
    const data = await sendSmartSheet({ url: webhookUrl.value, payload: payload.value })
    result.value = data
    if (data.data?.errcode === 0) ElMessage.success('发送成功！')
    else ElMessage.warning('响应已返回，请查看详情')
  } catch (e) {
    result.value = { error: e.message }
    ElMessage.error('发送失败: ' + e.message)
  } finally { sending.value = false }
}

function resetForm() {
  form.text = ''; form.singleSelect = ''; form.userId = ''; form.number = 1; form.date = ''
  result.value = null
}

// ===== Bot 连接测试 =====
const showBotTest = ref(false)
const botTesting = ref(false)
const botQuerying = ref(false)
const botQueryApi = ref('department_list')
const botQueryDeptId = ref('1')
const botQueryUserId = ref('')
const botResult = ref(null)
const botResultOk = ref(true)

// Bot 配置（从 config.json 读取）
const botConfig = reactive({ botId: 'aibVkWwbErL3jbKbyDWOtAJvTbZy0oKFFvM' })

const botResultJson = computed(() => {
  if (!botResult.value) return ''
  const { token_preview, message, ...rest } = botResult.value
  return JSON.stringify(rest, null, 2)
})

async function handleBotTest() {
  botResult.value = null
  botTesting.value = true
  try {
    const data = await botTest()
    botResult.value = data
    botResultOk.value = true
    ElMessage.success(data.message || 'Bot 连接成功！')
  } catch (e) {
    botResult.value = { ok: false, error: e.message }
    botResultOk.value = false
    ElMessage.error('Bot 连接失败: ' + e.message)
  } finally { botTesting.value = false }
}

async function handleBotQuery() {
  botResult.value = null
  botQuerying.value = true
  try {
    const params = {}
    if (botQueryApi.value === 'user_list' || botQueryApi.value === 'user_info') {
      params.department_id = botQueryDeptId.value || '1'
    }
    if (botQueryApi.value === 'user_info') {
      params.userid = botQueryUserId.value
    }
    const data = await botQuery({ api: botQueryApi.value, params })
    botResult.value = data
    botResultOk.value = true
    const count = data.data?.department?.length || data.data?.userlist?.length || 0
    ElMessage.success(`查询成功，返回 ${count} 条数据`)
  } catch (e) {
    botResult.value = { ok: false, error: e.message }
    botResultOk.value = false
    ElMessage.error('查询失败: ' + e.message)
  } finally { botQuerying.value = false }
}
</script>

<style scoped>
.result-block {
  background: #1e1e2e;
  color: #cdd6f4;
  padding: 16px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
  white-space: pre-wrap;
  margin: 0;
}
</style>
