<template>
  <main class="enterprise-settings">
    <aside class="settings-nav" aria-label="企业设置导航">
      <div class="settings-nav__brand">企业设置</div>
      <button class="settings-nav__item active" type="button">
        <span class="settings-nav__icon">◉</span>
        <span>
          <b>机器人设置</b>
          <small>企业微信长连接与对话</small>
        </span>
      </button>
      <div class="settings-nav__hint">人员权限将待项目测试完成后，再统一配置。</div>
    </aside>

    <section class="settings-main">
      <header class="settings-hero">
        <div>
          <p class="eyebrow">WECHAT WORK · BOT CONSOLE</p>
          <h1>机器人设置</h1>
          <p>管理企业微信连接与项目对话入口。密钥仅保存在后端，页面不会回显完整内容。</p>
        </div>
        <div class="hero-actions">
          <el-button :loading="loading" @click="loadSettings">刷新状态</el-button>
          <el-button type="primary" :loading="reconnecting" :disabled="!botStatus.configured" @click="reconnect">
            重新连接
          </el-button>
        </div>
      </header>

      <section class="status-grid" aria-label="机器人状态">
        <article class="status-card" :class="botStatus.authenticated ? 'healthy' : 'warning'">
          <span class="status-card__dot"></span>
          <div>
            <small>机器人长连接</small>
            <strong>{{ botStatus.authenticated ? '已认证并在线' : '等待连接' }}</strong>
            <p>{{ botStatus.authenticated ? '企业微信消息可送达本项目' : (botStatus.lastError || '请检查 Bot ID 与密钥') }}</p>
          </div>
        </article>
        <article class="status-card" :class="config.botConfigured ? 'healthy' : 'warning'">
          <span class="status-card__dot"></span>
          <div>
            <small>机器人凭据</small>
            <strong>{{ config.botConfigured ? '已配置' : '未配置' }}</strong>
            <p>{{ config.botIdMasked || '需要在企业微信后台填写 Bot ID 与密钥' }}</p>
          </div>
        </article>
        <article class="status-card" :class="config.configured ? 'healthy' : 'warning'">
          <span class="status-card__dot"></span>
          <div>
            <small>企业 API</small>
            <strong>{{ config.configured ? '已配置' : '未配置' }}</strong>
            <p>用于读取企业微信业务数据和后续资料检索</p>
          </div>
        </article>
        <article class="status-card" :class="config.aiEnabled && config.aiConfigured ? 'healthy' : 'neutral'">
          <span class="status-card__dot"></span>
          <div>
            <small>AI 思考模式</small>
            <strong>{{ config.aiEnabled && config.aiConfigured ? '已启用' : '默认规则' }}</strong>
            <p>{{ config.aiEnabled && config.aiConfigured ? `当前：${config.activeAiProfileName}` : '本地计算并生成稳定回答，不调用外部模型' }}</p>
          </div>
        </article>
      </section>

      <el-alert v-if="notice.text" :type="notice.type" :closable="false" class="notice">
        {{ notice.text }}
      </el-alert>

      <section class="settings-card">
        <div class="section-heading">
          <div>
            <p class="eyebrow">CONNECTION CREDENTIALS</p>
            <h2>企业微信连接配置</h2>
          </div>
          <span class="section-badge">安全保存</span>
        </div>

        <el-form label-position="top" class="robot-form">
          <div class="form-group">
            <div class="form-group__title">企业 API</div>
            <div class="form-grid">
              <el-form-item label="CorpID（企业 ID）">
                <el-input v-model="form.corpid" placeholder="ww..." />
              </el-form-item>
              <el-form-item label="CorpSecret（企业应用密钥）">
                <el-input v-model="form.corpsecret" type="password" show-password placeholder="留空则不修改" autocomplete="new-password" />
              </el-form-item>
            </div>
            <p class="form-help">供企业微信 API 调用使用。已保存密钥不会返回到浏览器。</p>
          </div>

          <div class="form-group form-group--featured">
            <div class="form-group__title">智能机器人长连接</div>
            <div class="form-grid">
              <el-form-item label="Bot ID">
                <el-input v-model="form.botId" :placeholder="config.botIdMasked ? `当前：${config.botIdMasked}（留空则不修改）` : '在企业微信智能机器人 API 模式中获取'" />
              </el-form-item>
              <el-form-item label="Bot Secret">
                <el-input v-model="form.botSecret" type="password" show-password placeholder="留空则不修改" autocomplete="new-password" />
              </el-form-item>
            </div>
            <p class="form-help">保存新机器人凭据后，系统会自动断开旧连接并重新建立长连接。</p>
          </div>

          <div class="form-group form-group--ai">
            <div class="form-group__title form-group__title--switch">
              <span>AI 思考（可选）</span>
              <el-switch v-model="form.aiEnabled" active-text="启用思考" inactive-text="默认规则" />
            </div>
            <div class="ai-profile-controls">
              <el-select v-model="form.activeAiProfileId" :disabled="!form.aiEnabled" placeholder="选择模型配置">
                <el-option label="本地模拟解读（无需 API）" value="local-simulation" />
                <el-option v-for="profile in config.aiProfiles" :key="profile.id" :label="profile.name" :value="profile.id" />
              </el-select>
              <el-button :disabled="!form.aiEnabled || !selectedAiProfile || selectedAiProfile.local" @click="openEditProfileDialog">编辑当前配置</el-button>
              <el-button :disabled="!form.aiEnabled" @click="openProfileDialog">新增模型配置</el-button>
            </div>
            <div v-if="selectedAiProfile" class="ai-profile-summary">
              <b>{{ selectedAiProfile.name }}</b>
              <span>{{ selectedAiProfile.local ? '仅基于项目数据生成本地模拟解读，不调用外部 API。' : `${selectedAiProfile.model} · ${selectedAiProfile.baseUrl}` }}</span>
            </div>
            <p class="form-help">暂时可选择“本地模拟解读”测试完整流程。后续每个 API 模型会保存成独立配置；切换后点击“保存配置”才会对机器人生效，旧配置不会被覆盖。</p>
          </div>

          <details class="advanced-settings">
            <summary>通知机器人（可选）</summary>
            <div class="form-grid advanced-settings__content">
              <el-form-item label="Webhook 地址"><el-input v-model="form.webhook" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?..." /></el-form-item>
              <el-form-item label="机器人名称"><el-input v-model="form.webhookName" placeholder="经营通知机器人" /></el-form-item>
            </div>
          </details>

          <div class="form-actions">
            <el-button type="primary" :loading="saving" @click="save">保存配置</el-button>
            <el-button :loading="testingApi" @click="testApi">测试企业 API</el-button>
          </div>
        </el-form>
      </section>

      <section class="settings-card dialogue-card">
        <div class="section-heading">
          <div>
            <p class="eyebrow">DIALOGUE ROADMAP</p>
            <h2>企微对话接入状态</h2>
          </div>
        </div>
        <div class="dialogue-flow">
          <div class="flow-step done"><b>1</b><span>企业微信消息进入<br><small>长连接已建立</small></span></div>
          <i>→</i>
          <div class="flow-step done"><b>2</b><span>机器人返回消息<br><small>欢迎语与文本回执</small></span></div>
          <i>→</i>
          <div class="flow-step done"><b>3</b><span>识别经营问题<br><small>规则识别已启用</small></span></div>
          <i>→</i>
          <div class="flow-step done"><b>4</b><span>查询本项目数据<br><small>营业数据查询已启用</small></span></div>
        </div>
        <div class="message-diagnostics" aria-label="企业微信收发诊断">
          <div>
            <small>最后收到企微消息</small>
            <strong>{{ botStatus.lastInboundAt ? `${formatTime(botStatus.lastInboundAt)} · ${botStatus.lastInboundType}` : '尚未收到' }}</strong>
          </div>
          <div>
            <small>最后发送机器人回复</small>
            <strong>{{ botStatus.lastReplyAt ? formatTime(botStatus.lastReplyAt) : '尚未发送' }}</strong>
          </div>
          <div :class="{ error: botStatus.lastReplyError }">
            <small>回复状态</small>
            <strong>{{ botStatus.lastReplyError || '等待下一条消息验证' }}</strong>
          </div>
        </div>
        <div class="question-preview">
          <label for="bot-question">本地问答测试</label>
          <div class="question-preview__input">
            <el-input id="bot-question" v-model="testQuestion" @keyup.enter="previewQuestion" placeholder="例如：查询 2026年7月全门店营业额" />
            <el-button type="primary" :loading="previewing" @click="previewQuestion">测试回答</el-button>
          </div>
          <pre v-if="previewReply" class="question-preview__reply">{{ previewReply }}</pre>
        </div>
        <p class="dialogue-note">当前不在此处设置员工权限；测试阶段可先用已授权账号验证机器人收发消息。支持营业额、实收、订单量、优惠金额和客单价，以及总数据、团购、外卖的日/周/月/自定义时间查询。</p>
      </section>

      <el-dialog v-model="profileDialogVisible" :title="editingProfileId ? '编辑 AI 模型配置' : '新增 AI 模型配置'" width="520px" :close-on-click-modal="false">
        <el-alert type="info" :closable="false" show-icon>{{ editingProfileId ? 'API Key 留空则保留原密钥；本次修改只影响当前这条模型配置。' : '保存后会新增一条模型配置，不会覆盖已有模型或密钥。' }}</el-alert>
        <el-form label-position="top" class="ai-profile-form">
          <el-form-item label="配置名称"><el-input v-model="newProfile.name" placeholder="例如：运营分析模型" /></el-form-item>
          <el-form-item label="API Base URL（OpenAI 兼容）"><el-input v-model="newProfile.baseUrl" placeholder="例如：https://api.openai.com/v1" /></el-form-item>
          <el-form-item label="模型名称"><el-input v-model="newProfile.model" placeholder="例如：gpt-4.1-mini" /></el-form-item>
          <el-form-item label="API Key"><el-input v-model="newProfile.apiKey" type="password" show-password :placeholder="editingProfileId ? '留空则保留原密钥' : '仅安全保存在后端'" autocomplete="new-password" /></el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="profileDialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="creatingProfile" @click="saveProfile">{{ editingProfileId ? '保存修改' : '保存为新配置' }}</el-button>
        </template>
      </el-dialog>
    </section>
  </main>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { createEnterpriseAiProfile, getBotStatus, getConfig, getToken, previewEnterpriseBotQuestion, reconnectEnterpriseRobot, saveConfig, updateEnterpriseAiProfile } from '@/api'

const loading = ref(false)
const saving = ref(false)
const reconnecting = ref(false)
const testingApi = ref(false)
const previewing = ref(false)
const testQuestion = ref('查询 2026年7月全门店营业额、实收、订单量和优惠金额')
const previewReply = ref('')
const profileDialogVisible = ref(false)
const creatingProfile = ref(false)
const editingProfileId = ref('')
const newProfile = reactive({ name: '', baseUrl: '', model: '', apiKey: '' })
const config = reactive({ configured: false, webhookConfigured: false, botConfigured: false, botIdMasked: '', aiConfigured: false, aiEnabled: false, activeAiProfileId: '', activeAiProfileName: '', aiProfiles: [] })
const botStatus = reactive({ configured: false, connected: false, authenticated: false, businessQueryEnabled: false, lastError: '', startedAt: null, lastInboundAt: null, lastInboundType: '', lastReplyAt: null, lastReplyError: null })
const form = reactive({ corpid: '', corpsecret: '', botId: '', botSecret: '', webhook: '', webhookName: '', aiEnabled: false, activeAiProfileId: '' })
const notice = reactive({ type: 'info', text: '' })
const selectedAiProfile = computed(() => {
  if (form.activeAiProfileId === 'local-simulation') return { name: '本地模拟解读', local: true }
  return config.aiProfiles.find(profile => profile.id === form.activeAiProfileId)
})

function applyConfig(data) {
  Object.assign(config, data)
  form.corpid = data.corpid || ''
  form.webhook = data.webhook || ''
  form.webhookName = data.webhookName || ''
  form.aiEnabled = Boolean(data.aiEnabled)
  form.activeAiProfileId = data.activeAiProfileId || ''
}

function applyBotStatus(data) {
  Object.assign(botStatus, data)
}

function formatTime(value) {
  if (!value) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
}

async function loadSettings() {
  loading.value = true
  try {
    const [cfg, status] = await Promise.all([getConfig(), getBotStatus()])
    applyConfig(cfg)
    applyBotStatus(status)
  } catch (error) {
    notice.type = 'error'
    notice.text = `无法读取机器人设置：${error.message}`
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  notice.type = 'info'
  notice.text = ''
  try {
    const body = { corpid: form.corpid, webhook: form.webhook, webhookName: form.webhookName, aiEnabled: form.aiEnabled, activeAiProfileId: form.activeAiProfileId }
    if (form.corpsecret) body.corpsecret = form.corpsecret
    if (form.botId) body.botId = form.botId
    if (form.botSecret) body.botSecret = form.botSecret
    const result = await saveConfig(body)
    form.corpsecret = ''
    form.botSecret = ''
    form.botId = ''
    notice.type = 'success'
    notice.text = result.reconnecting ? '配置已保存，机器人正在重新建立长连接，请稍后刷新状态确认。' : '配置已安全保存。'
    await loadSettings()
  } catch (error) {
    notice.type = 'error'
    notice.text = `保存失败：${error.message}`
  } finally {
    saving.value = false
  }
}

function openProfileDialog() {
  editingProfileId.value = ''
  Object.assign(newProfile, { name: '', baseUrl: '', model: '', apiKey: '' })
  profileDialogVisible.value = true
}

function openEditProfileDialog() {
  if (!selectedAiProfile.value?.id) return
  editingProfileId.value = selectedAiProfile.value.id
  Object.assign(newProfile, { name: selectedAiProfile.value.name, baseUrl: selectedAiProfile.value.baseUrl, model: selectedAiProfile.value.model, apiKey: '' })
  profileDialogVisible.value = true
}

async function saveProfile() {
  creatingProfile.value = true
  try {
    const isEditing = Boolean(editingProfileId.value)
    const result = isEditing
      ? await updateEnterpriseAiProfile(editingProfileId.value, newProfile)
      : await createEnterpriseAiProfile(newProfile)
    profileDialogVisible.value = false
    await loadSettings()
    form.activeAiProfileId = result.profile.id
    notice.type = 'success'
    notice.text = isEditing ? '模型配置已更新；当前已选中该配置时，机器人会从下一次提问开始使用新设置。' : '新模型配置已保存。点击“保存配置”后将切换机器人使用的模型。'
  } catch (error) {
    notice.type = 'error'
    notice.text = `保存模型配置失败：${error.message}`
  } finally {
    creatingProfile.value = false
  }
}

async function reconnect() {
  reconnecting.value = true
  try {
    await reconnectEnterpriseRobot()
    notice.type = 'success'
    notice.text = '已发起重新连接，系统正在认证企业微信机器人。'
    window.setTimeout(loadSettings, 1000)
  } catch (error) {
    notice.type = 'error'
    notice.text = `重新连接失败：${error.message}`
  } finally {
    reconnecting.value = false
  }
}

async function testApi() {
  testingApi.value = true
  try {
    const data = await getToken()
    notice.type = 'success'
    notice.text = `企业 API 连通，凭据${data.cached ? '来自缓存' : '已重新验证'}。`
  } catch (error) {
    notice.type = 'error'
    notice.text = `企业 API 不可用：${error.message}`
  } finally {
    testingApi.value = false
  }
}

async function previewQuestion() {
  if (!testQuestion.value.trim()) return
  previewing.value = true
  try {
    const result = await previewEnterpriseBotQuestion(testQuestion.value)
    previewReply.value = result.reply || '未获得回答'
  } catch (error) {
    notice.type = 'error'
    notice.text = `问答测试失败：${error.message}`
  } finally {
    previewing.value = false
  }
}

onMounted(loadSettings)
</script>

<style scoped>
.enterprise-settings { display: grid; grid-template-columns: 232px minmax(0, 1fr); gap: 22px; max-width: 1500px; margin: 0 auto; padding: 24px; color: #16243a; }
.settings-nav { align-self: start; position: sticky; top: 16px; padding: 14px; border: 1px solid #e6ebf4; border-radius: 16px; background: #fff; box-shadow: 0 9px 24px rgba(22, 41, 76, .05); }
.settings-nav__brand { padding: 8px 10px 16px; font-weight: 800; color: #20365b; letter-spacing: .02em; }
.settings-nav__item { display: flex; width: 100%; gap: 10px; align-items: flex-start; padding: 12px; color: #fff; text-align: left; border: 0; border-radius: 12px; background: linear-gradient(135deg, #2363d9, #4f8dfa); cursor: pointer; }
.settings-nav__item b, .settings-nav__item small { display: block; }.settings-nav__item small { margin-top: 3px; color: rgba(255,255,255,.72); font-size: 11px; }.settings-nav__icon { padding-top: 1px; color: #bcd7ff; }.settings-nav__hint { margin: 18px 8px 5px; color: #8a98ab; font-size: 12px; line-height: 1.7; }
.settings-main { min-width: 0; }.settings-hero { display: flex; justify-content: space-between; gap: 24px; align-items: center; padding: 25px 28px; color: #fff; border-radius: 18px; background: radial-gradient(circle at 88% 0%, rgba(123, 175, 255, .55), transparent 30%), linear-gradient(118deg, #152f65, #2364c9); box-shadow: 0 14px 28px rgba(35, 85, 170, .18); }.eyebrow { margin: 0 0 7px; color: #7f96bb; font-size: 10px; font-weight: 800; letter-spacing: .14em; }.settings-hero .eyebrow { color: #b8d1fb; }.settings-hero h1 { margin: 0; font-size: 26px; letter-spacing: .02em; }.settings-hero p:not(.eyebrow) { margin: 8px 0 0; color: #d5e4ff; font-size: 13px; }.hero-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; }.hero-actions :deep(.el-button:not(.el-button--primary)) { color: #eaf2ff; border-color: rgba(255,255,255,.4); background: rgba(255,255,255,.1); }
.status-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 16px 0; }.status-card { display: flex; gap: 10px; min-height: 112px; padding: 17px; border: 1px solid #e9edf4; border-radius: 14px; background: #fff; box-shadow: 0 6px 18px rgba(26, 47, 84, .04); }.status-card__dot { flex: 0 0 8px; width: 8px; height: 8px; margin-top: 5px; border-radius: 50%; background: #a8b4c5; }.status-card.healthy .status-card__dot { background: #22b573; box-shadow: 0 0 0 4px #e0f8ed; }.status-card.warning .status-card__dot { background: #f4a62a; box-shadow: 0 0 0 4px #fff3dc; }.status-card small, .status-card strong, .status-card p { display: block; }.status-card small { color: #8090a6; font-size: 12px; }.status-card strong { margin-top: 6px; color: #243b62; font-size: 15px; }.status-card p { margin: 7px 0 0; color: #8a98ab; font-size: 11px; line-height: 1.45; }.notice { margin: 0 0 16px; }
.settings-card { margin-top: 16px; padding: 24px 26px; border: 1px solid #e6ebf4; border-radius: 16px; background: #fff; box-shadow: 0 9px 24px rgba(22, 41, 76, .045); }.section-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding-bottom: 18px; border-bottom: 1px solid #edf0f5; }.section-heading h2 { margin: 0; color: #1c3154; font-size: 17px; }.section-badge { padding: 4px 9px; color: #2770d8; font-size: 11px; border-radius: 99px; background: #ebf3ff; }.robot-form { margin-top: 18px; }.form-group { padding: 17px; border: 1px solid #edf0f5; border-radius: 12px; }.form-group + .form-group { margin-top: 14px; }.form-group--featured { border-color: #cfe0ff; background: linear-gradient(110deg, #f8fbff, #f2f7ff); }.form-group--ai { border-color: #d8d5ff; background: linear-gradient(110deg, #faf9ff, #f4f2ff); }.form-group__title { margin-bottom: 13px; color: #24436f; font-size: 13px; font-weight: 800; }.form-group__title--switch { display: flex; justify-content: space-between; align-items: center; }.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }.ai-profile-controls { display: flex; gap: 10px; align-items: center; }.ai-profile-controls :deep(.el-select) { flex: 1; }.ai-profile-summary { display: flex; gap: 7px; flex-wrap: wrap; align-items: baseline; margin: 12px 0 10px; padding: 10px 12px; color: #596d8c; font-size: 12px; border: 1px solid #dddafc; border-radius: 9px; background: rgba(255,255,255,.6); }.ai-profile-summary b { color: #5045a6; }.form-help { margin: -3px 0 0; color: #8a98ab; font-size: 12px; }.ai-profile-form { margin-top: 18px; }.advanced-settings { margin-top: 14px; color: #587092; font-size: 13px; }.advanced-settings summary { cursor: pointer; }.advanced-settings__content { margin-top: 15px; }.form-actions { display: flex; gap: 10px; margin-top: 20px; }
.dialogue-flow { display: grid; grid-template-columns: 1fr auto 1fr auto 1fr auto 1fr; gap: 9px; align-items: center; padding: 23px 0 16px; }.dialogue-flow > i { color: #b9c4d3; font-style: normal; }.flow-step { display: flex; gap: 9px; align-items: center; min-height: 58px; padding: 10px; border: 1px dashed #d5dce7; border-radius: 11px; color: #77889e; font-size: 12px; line-height: 1.4; }.flow-step b { display: grid; flex: 0 0 24px; width: 24px; height: 24px; place-items: center; color: #7a8ca3; border-radius: 50%; background: #edf1f6; }.flow-step small { color: #9aa7b8; font-size: 10px; }.flow-step.done { color: #255fa8; border-style: solid; border-color: #cbe0ff; background: #f5f9ff; }.flow-step.done b { color: #fff; background: #3d7de2; }.dialogue-note { margin: 0; color: #7d8da1; font-size: 12px; line-height: 1.7; }
.message-diagnostics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0 0 15px; border: 1px solid #e1e9f4; border-radius: 11px; overflow: hidden; }.message-diagnostics > div { min-height: 70px; padding: 13px; background: #fbfcfe; }.message-diagnostics > div + div { border-left: 1px solid #e1e9f4; }.message-diagnostics small, .message-diagnostics strong { display: block; }.message-diagnostics small { margin-bottom: 6px; color: #8391a5; font-size: 11px; }.message-diagnostics strong { overflow: hidden; color: #30486d; font-size: 12px; line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }.message-diagnostics .error strong { color: #d44747; }
.question-preview { margin: 2px 0 15px; padding: 15px; border: 1px solid #dce8fb; border-radius: 12px; background: #f8fbff; }.question-preview > label { display: block; margin-bottom: 9px; color: #2a4c7e; font-size: 12px; font-weight: 800; }.question-preview__input { display: flex; gap: 10px; }.question-preview__reply { margin: 12px 0 0; padding: 12px; white-space: pre-wrap; color: #244169; font: 12px/1.65 ui-monospace, SFMono-Regular, Menlo, monospace; border-radius: 8px; background: #fff; }
@media (max-width: 1100px) { .enterprise-settings { grid-template-columns: 1fr; }.settings-nav { position: static; }.settings-nav__hint { display: none; }.status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 680px) { .enterprise-settings { padding: 14px; }.settings-hero { align-items: flex-start; flex-direction: column; }.hero-actions { justify-content: flex-start; }.status-grid, .form-grid, .message-diagnostics { grid-template-columns: 1fr; }.ai-profile-controls, .question-preview__input { align-items: stretch; flex-direction: column; }.message-diagnostics > div + div { border-top: 1px solid #e1e9f4; border-left: 0; }.dialogue-flow { grid-template-columns: 1fr; }.dialogue-flow > i { display: none; }.settings-card { padding: 19px; } }
</style>
