<template>
  <div>
    <div class="card-compact">
      <div class="card-header">🔑 企业微信 API 配置</div>
      <el-alert type="info" :closable="false" style="margin-bottom:16px;">
        在这里配置企业微信的 <strong>corpid</strong> 和 <strong>corpsecret</strong>，后端才能调用企业微信 API 读取数据。
        这些凭据<strong>只存在后端</strong>，不会暴露到浏览器。
      </el-alert>

      <el-form label-width="140px" style="max-width:600px;">
        <el-form-item label="CorpID（企业ID）">
          <el-input v-model="form.corpid" placeholder="ww..." />
          <div class="el-form-tip">在企业微信管理后台 → 我的企业 → 企业信息 中获取</div>
        </el-form-item>
        <el-form-item label="CorpSecret（密钥）">
          <el-input v-model="form.secret" type="password" show-password placeholder="输入 corpsecret（留空则不修改）" />
          <div class="el-form-tip">已保存的密钥不会回显完整内容。如需修改，填入新值后保存</div>
        </el-form-item>
        <el-divider />
        <el-form-item label="Webhook 地址">
          <el-input v-model="form.webhook" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." />
        </el-form-item>
        <el-form-item label="机器人名称">
          <el-input v-model="form.webhookName" placeholder="中控通知机器人" />
        </el-form-item>
        <el-form-item>
          <el-space>
            <el-button type="primary" @click="save" :loading="saving">💾 保存配置</el-button>
            <el-button @click="testToken" :loading="testingToken">🔑 测试 API 连接</el-button>
            <el-button @click="testWebhook" :loading="testingWebhook">🔗 测试 Webhook</el-button>
          </el-space>
        </el-form-item>
      </el-form>

      <div v-if="result.text" style="margin-top:12px;">
        <el-alert :type="result.type" :closable="false">{{ result.text }}</el-alert>
      </div>
    </div>

    <div class="card-compact">
      <div class="card-header">📖 说明</div>
      <div style="color:#666;line-height:2;">
        <p><strong>CorpID</strong> 和 <strong>CorpSecret</strong> 获取方式：</p>
        <ol style="padding-left:20px;">
          <li>登录 <a href="https://work.weixin.qq.com/" target="_blank">企业微信管理后台</a></li>
          <li>进入「应用管理」→ 选择一个自建应用</li>
          <li>在应用详情中可以看到 CorpID、AgentId 和 Secret</li>
        </ol>
        <p style="margin-top:12px;">⚠️ 注意：不同的 API 可能需要不同的 Secret 类型（通讯录、客户联系等），请确保 Secret 有对应权限。</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { getConfig, saveConfig, getToken, sendWebhook } from '@/api'

const form = reactive({ corpid: '', secret: '', webhook: '', webhookName: '' })
const result = reactive({ type: 'info', text: '' })
const saving = ref(false)
const testingToken = ref(false)
const testingWebhook = ref(false)

onMounted(async () => {
  try {
    const cfg = await getConfig()
    form.corpid = cfg.corpid || ''
    form.webhook = cfg.webhook || ''
    form.webhookName = cfg.webhookName || ''
  } catch (e) {
    result.type = 'error'
    result.text = '无法加载配置：' + e.message
  }
})

async function save() {
  if (!form.corpid) { result.type = 'error'; result.text = '请输入 CorpID'; return }
  saving.value = true
  try {
    const body = { corpid: form.corpid, webhook: form.webhook, webhookName: form.webhookName }
    if (form.secret) body.corpsecret = form.secret
    const data = await saveConfig(body)
    form.secret = ''
    result.type = 'success'
    result.text = `配置已保存 · API:${data.configured ? '已配置' : '未配置'} · Webhook:${data.webhookConfigured ? '已配置' : '未配置'}`
  } catch (e) {
    result.type = 'error'; result.text = '保存失败：' + e.message
  } finally { saving.value = false }
}

async function testToken() {
  testingToken.value = true
  result.type = 'info'; result.text = '⏳ 正在获取 access_token...'
  try {
    const data = await getToken()
    result.type = 'success'
    result.text = `Token 获取成功！来源：${data.cached ? '缓存' : '新获取'} · 有效期：${data.expires_in}秒`
  } catch (e) {
    result.type = 'error'; result.text = '获取失败：' + e.message
  } finally { testingToken.value = false }
}

async function testWebhook() {
  testingWebhook.value = true
  result.type = 'info'; result.text = '⏳ 正在发送测试消息...'
  try {
    await sendWebhook({ msgtype: 'text', content: `✅ 中控后台连接测试成功！\n时间：${new Date().toLocaleString()}` })
    result.type = 'success'; result.text = '测试消息已发送到群聊！'
  } catch (e) {
    result.type = 'error'; result.text = '发送失败：' + e.message
  } finally { testingWebhook.value = false }
}
</script>

<style scoped>
.el-form-tip { font-size: 12px; color: #999; line-height: 1.4; margin-top: 4px; }
</style>
