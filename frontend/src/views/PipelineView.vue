<template>
  <div>
    <div class="card-compact">
      <div class="card-header">📤 读取数据 → 推送到群</div>
      <el-alert type="info" :closable="false" style="margin-bottom:16px;">
        选择数据源，系统会自动读取数据并通过 Webhook 推送到企业微信群聊。
        使用前请确保「中控绑定」中的 corpid、corpsecret 和 Webhook 均已正确填写。
      </el-alert>

      <el-form label-width="120px" style="max-width:600px;">
        <el-form-item label="数据源">
          <el-select v-model="api" style="width:100%;">
            <el-option label="📋 部门列表" value="department_list" />
            <el-option label="👥 成员列表" value="user_list" />
          </el-select>
        </el-form-item>
        <el-form-item label="部门ID" v-if="api === 'user_list'">
          <el-input v-model="deptId" placeholder="1" />
        </el-form-item>
        <el-form-item label="消息格式">
          <el-select v-model="msgType" style="width:100%;">
            <el-option label="Markdown（推荐）" value="markdown" />
            <el-option label="纯文本" value="text" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-space>
            <el-button type="primary" @click="doPipeline" :loading="loading">🚀 读取并推送到群</el-button>
          </el-space>
        </el-form-item>
      </el-form>
      <div v-if="result.text" style="margin-top:12px;">
        <el-alert :type="result.type" :closable="false">{{ result.text }}</el-alert>
      </div>
    </div>

    <div class="card-compact">
      <div class="card-header">⚡ 快捷操作</div>
      <el-space>
        <el-button @click="quickPush('department_list')">📋 推送部门列表</el-button>
        <el-button @click="quickPush('user_list')">👥 推送成员列表</el-button>
        <el-button @click="testWebhook">🧪 发送测试消息</el-button>
      </el-space>
    </div>

    <div class="card-compact">
      <div class="card-header">✏️ 自定义消息</div>
      <el-form label-width="120px" style="max-width:600px;">
        <el-form-item label="消息类型">
          <el-select v-model="customMsgtype" style="width:100%;">
            <el-option label="纯文本" value="text" />
            <el-option label="Markdown" value="markdown" />
            <el-option label="图文消息" value="news" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题" v-if="customMsgtype === 'news'">
          <el-input v-model="customTitle" placeholder="图文消息标题" />
        </el-form-item>
        <el-form-item label="文案内容">
          <el-input v-model="customContent" type="textarea" :rows="4" placeholder="输入要发送的文字内容..." />
        </el-form-item>
        <el-form-item label="跳转链接" v-if="customMsgtype === 'news'">
          <el-input v-model="customUrl" placeholder="https://example.com/article" />
        </el-form-item>
        <el-form-item label="图片链接">
          <el-input v-model="customPicurl" placeholder="https://example.com/image.png（可选）" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="sendCustom" :loading="sending">📨 发送自定义消息</el-button>
        </el-form-item>
      </el-form>
      <div v-if="customResult.text" style="margin-top:12px;">
        <el-alert :type="customResult.type" :closable="false">{{ customResult.text }}</el-alert>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'
import { runPipeline, sendWebhook } from '@/api'

const api = ref('department_list')
const deptId = ref('1')
const msgType = ref('markdown')
const loading = ref(false)
const result = reactive({ type: 'info', text: '' })

const customMsgtype = ref('text')
const customTitle = ref('')
const customContent = ref('')
const customUrl = ref('')
const customPicurl = ref('')
const sending = ref(false)
const customResult = reactive({ type: 'info', text: '' })

async function doPipeline() {
  loading.value = true
  result.text = '⏳ 正在读取数据并推送到群...'; result.type = 'info'
  try {
    const params = {}
    if (api.value === 'user_list') params.department_id = parseInt(deptId.value) || 1
    const data = await runPipeline({ api: api.value, params, msgtype: msgType.value })
    result.type = 'success'; result.text = `✅ ${data.message}`
  } catch (e) {
    result.type = 'error'; result.text = '推送失败：' + e.message
  } finally { loading.value = false }
}

async function quickPush(apiName) {
  loading.value = true
  result.type = 'info'; result.text = `⏳ 正在推送...`
  try {
    const data = await runPipeline({ api: apiName, params: apiName === 'user_list' ? { department_id: 1 } : {}, msgtype: 'markdown' })
    result.type = 'success'; result.text = `✅ ${data.message}`
  } catch (e) {
    result.type = 'error'; result.text = '推送失败：' + e.message
  } finally { loading.value = false }
}

async function testWebhook() {
  sending.value = true
  customResult.type = 'info'; customResult.text = '⏳ 正在发送...'
  try {
    await sendWebhook({ msgtype: 'text', content: `✅ 测试消息\n时间：${new Date().toLocaleString()}` })
    customResult.type = 'success'; customResult.text = '✅ 测试消息已发送'
  } catch (e) {
    customResult.type = 'error'; customResult.text = '发送失败：' + e.message
  } finally { sending.value = false }
}

async function sendCustom() {
  if (!customContent.value) { customResult.type = 'error'; customResult.text = '请输入文案内容'; return }
  if (customMsgtype.value === 'news' && !customUrl.value) { customResult.type = 'error'; customResult.text = '图文消息必须填写链接'; return }
  sending.value = true
  customResult.type = 'info'; customResult.text = '⏳ 正在发送...'
  try {
    const body = { msgtype: customMsgtype.value, content: customContent.value }
    if (customMsgtype.value === 'news') {
      body.title = customTitle.value || undefined
      body.url = customUrl.value
      body.picurl = customPicurl.value || undefined
    }
    const data = await sendWebhook(body)
    customResult.type = 'success'; customResult.text = '✅ ' + data.message
    customContent.value = ''; customTitle.value = ''; customUrl.value = ''; customPicurl.value = ''
  } catch (e) {
    customResult.type = 'error'; customResult.text = '发送失败：' + e.message
  } finally { sending.value = false }
}
</script>
