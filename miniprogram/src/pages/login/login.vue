<template>
  <view class="login-page">
    <view class="hero">
      <view class="logo">鹅</view>
      <view class="hero-title">鹅太公中控</view>
      <view class="hero-sub">协同事项 · 门店日报 · 经营看板</view>
    </view>

    <view class="form-card">
      <view v-if="hasWechat" class="wechat-section">
        <button class="mp-btn mp-btn--primary" :disabled="loading" @tap="wechatLogin">{{ loading ? '处理中…' : '微信登录' }}</button>
        <view class="alt-hint">首次使用需管理员审核，绑定后无需账号密码。</view>
        <view v-if="binding" class="binding-info">
          <text>{{ binding.status === 'pending' ? '申请已提交，等待管理员审核' : binding.status === 'rejected' ? '申请未通过，可核实信息后重新提交' : '原绑定已解除，可重新申请' }}</text>
          <text>申请编号：{{ binding.verification }}</text>
          <text>请将编号告知管理员核实身份。审核通过后点击微信登录。</text>
        </view>
        <view v-if="bindingTicket && binding?.status !== 'pending'">
          <view class="field"><text class="label">真实姓名</text><input v-model="bindingForm.name" class="input" maxlength="30" placeholder="填写姓名供管理员核实" :disabled="loading" /></view>
          <view class="field"><text class="label">联系方式（选填）</text><input v-model="bindingForm.contact" class="input" maxlength="60" placeholder="手机号或其他联系方式" :disabled="loading" /></view>
          <button class="mp-btn mp-btn--primary" :disabled="loading" @tap="applyBinding">提交绑定申请</button>
        </view>
        <view class="alt-login" @tap="showPassword = !showPassword">{{ showPassword ? '收起账号密码登录' : '管理员 / 账号密码登录' }}</view>
      </view>
      <view v-if="!hasWechat || showPassword">
      <view class="field">
        <text class="label">账号</text>
        <input
          v-model="form.username"
          class="input"
          type="text"
          placeholder="请输入用户名"
          placeholder-class="ph"
          :disabled="loading"
          @confirm="doLogin"
        />
      </view>
      <view class="field">
        <text class="label">密码</text>
        <input
          v-model="form.password"
          class="input"
          password
          placeholder="请输入密码"
          placeholder-class="ph"
          :disabled="loading"
          @confirm="doLogin"
        />
      </view>

      <view class="mp-btn" :class="canSubmit ? 'mp-btn--primary' : 'mp-btn--primary mp-btn--disabled'" @tap="doLogin">
        {{ loading ? '登录中…' : '登 录' }}
      </view>
      </view>

      <!-- 服务器不通时的明确提示，避免用户误以为是账号问题 -->
      <view v-if="serverIssue" class="server-issue">
        <text class="server-issue-title">⚠️ 连不上小程序接口</text>
        <text class="server-issue-msg">{{ serverIssue }}</text>
      </view>

      <!-- 企业阶段才出现：企业微信免登 / 微信授权 + 邀请码 -->
      <view v-if="hasWxwork" class="alt-login" @tap="wxworkLogin">
        <text>企业微信免登（当前环境已启用）</text>
      </view>
      <view v-else-if="!hasWechat" class="alt-hint">
        微信登录尚未启用，请暂用账号密码登录。
      </view>
    </view>

    <!-- 服务器地址设置：真机调试改这里，免重新编译 -->
    <view v-if="cloudChannel" class="form-card server-card">
      <view class="server-title">云端连接</view>
      <view class="server-tip">已使用云通道连接中控后台，无需填写服务器地址。</view>
      <view class="server-actions">
        <view class="mini-btn" @tap="testConn">测试连接</view>
      </view>
    </view>
    <view v-else class="form-card server-card">
      <view class="mp-between" @tap="showServer = !showServer">
        <text class="server-title">服务器地址</text>
        <text class="server-value mp-ellipsis">{{ baseUrl }}</text>
      </view>
      <view v-if="showServer" class="server-body">
        <input
          v-model="baseUrlInput"
          class="input server-input"
          type="text"
          placeholder="http://192.168.1.8:3456"
          placeholder-class="ph"
        />
        <view class="server-actions">
          <view class="mini-btn" @tap="saveServer">保存</view>
          <view class="mini-btn mini-btn--ghost" @tap="testConn">测试连接</view>
          <view class="mini-btn mini-btn--ghost" @tap="resetServer">恢复默认</view>
        </view>
        <view class="server-tip">
          真机调试填电脑的局域网 IP（如 http://192.168.1.8:3456），并确认防火墙已放行 3456 端口；
          开发者工具用 localhost 即可。
        </view>
      </view>
    </view>

    <!-- 演示账号：正式上线前删除（含 common/config.js 的 DEMO_ACCOUNTS） -->
    <view v-if="!hasWechat" class="demo-card">
      <text class="demo-title">演示账号</text>
      <view v-for="acc in demoAccounts" :key="acc.username" class="demo-row" @tap="fillDemo(acc)">
        <text class="demo-acc">{{ acc.username }} / {{ acc.password }}</text>
        <text class="mp-muted">{{ acc.label }}</text>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import api from '../../common/api'
import { DEMO_ACCOUNTS } from '../../common/config'
import { getBaseUrl, setBaseUrl, saveSession, request, usesCloudChannel } from '../../common/request'

const form = ref({ username: '', password: '' })
const cloudChannel = usesCloudChannel()
const loading = ref(false)
const providers = ref([])
const showPassword = ref(false)
const bindingTicket = ref('')
const binding = ref(null)
const bindingForm = ref({ name: '', contact: '' })
const hasWechat = computed(() => cloudChannel && providers.value.some(p => p.key === 'openid' && p.enabled))
const serverIssue = ref('')
const showServer = ref(false)
const baseUrl = ref(getBaseUrl())
const baseUrlInput = ref(getBaseUrl())
const demoAccounts = DEMO_ACCOUNTS

const canSubmit = computed(() => form.value.username.trim() && form.value.password && !loading.value)
const hasWxwork = computed(() => providers.value.some(p => p.key === 'wxwork' && p.enabled))

onLoad(async () => {
  await probeServer()
})

/** 探测后端：区分"服务没起来"、"地址不对"、"后端是旧版本" */
async function probeServer() {
  serverIssue.value = ''
  try {
    const res = await api.providers()
    providers.value = res.providers || []
  } catch (e) {
    serverIssue.value = e.message
  }
}

function fillDemo(acc) {
  form.value.username = acc.username
  form.value.password = acc.password
}

async function wechatLogin() {
  if (loading.value) return
  loading.value = true
  try {
    const result = await new Promise((resolve, reject) => uni.login({ provider: 'weixin', success: resolve, fail: reject }))
    const res = await api.loginOpenid(result.code)
    if (res.bindingRequired) {
      bindingTicket.value = res.ticket
      binding.value = res.binding
      return
    }
    saveSession(res.token, res.user)
    bindingTicket.value = ''
    uni.reLaunch({ url: '/pages/home/index' })
  } catch (e) {
    uni.showModal({ title: '微信登录失败', content: e.message || e.errMsg || '请稍后重试', showCancel: false })
  } finally { loading.value = false }
}

async function applyBinding() {
  if (loading.value) return
  if (!bindingForm.value.name.trim()) {
    uni.showToast({ title: '请填写真实姓名', icon: 'none' })
    return
  }
  loading.value = true
  try {
    const res = await api.applyWechat({ ticket: bindingTicket.value, ...bindingForm.value })
    binding.value = res.binding
    uni.showModal({ title: '申请已提交', content: `申请编号：${res.binding.verification}。请联系管理员审核。`, showCancel: false })
  } catch (e) {
    uni.showModal({ title: '提交失败', content: e.message, showCancel: false })
  } finally { loading.value = false }
}

async function doLogin() {
  if (!canSubmit.value) {
    if (!loading.value) uni.showToast({ title: '请输入账号和密码', icon: 'none' })
    return
  }
  loading.value = true
  serverIssue.value = ''
  try {
    const res = await api.loginPassword(form.value.username.trim(), form.value.password)
    saveSession(res.token, res.user)
    serverIssue.value = ''
    uni.showToast({ title: '登录成功', icon: 'success' })
    setTimeout(() => uni.reLaunch({ url: '/pages/home/index' }), 300)
  } catch (e) {
    // 连接类错误（而不是账号密码错误）时，直接摆到横幅上，避免用户以为是密码问题
    if (/连不上|服务端未响应|云通道|域名|超时|timeout/i.test(e.message || '')) {
      serverIssue.value = e.message
    }
  } finally {
    loading.value = false
  }
}

function wxworkLogin() {
  // #ifdef MP-WEIXIN
  if (!(typeof wx !== 'undefined' && wx.qy && wx.qy.login)) {
    uni.showToast({ title: '当前不在企业微信环境，请用账号密码登录', icon: 'none' })
    return
  }
  wx.qy.login({
    success: async (res) => {
      try {
        const r = await api.loginWxwork(res.code)
        saveSession(r.token, r.user)
        uni.reLaunch({ url: '/pages/home/index' })
      } catch (e) { /* 已提示 */ }
    },
    fail: () => uni.showToast({ title: '企业微信免登失败，请用账号密码登录', icon: 'none' }),
  })
  // #endif
}

function saveServer() {
  baseUrl.value = setBaseUrl(baseUrlInput.value)
  baseUrlInput.value = baseUrl.value
  uni.showToast({ title: '已保存', icon: 'success' })
}

function resetServer() {
  baseUrl.value = setBaseUrl('')
  baseUrlInput.value = baseUrl.value
  uni.showToast({ title: '已恢复默认', icon: 'none' })
}

async function testConn() {
  if (!cloudChannel) saveServer()
  uni.showLoading({ title: '连接中' })
  try {
    const res = await request({ url: '/api/mp/health', auth: false, silent: true })
    uni.hideLoading()
    uni.showModal({
      title: '连接成功',
      content: `${res.service} v${res.version}\n服务器时间：${res.time}`,
      showCancel: false,
    })
  } catch (e) {
    uni.hideLoading()
    uni.showModal({ title: '连接失败', content: e.message, showCancel: false })
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  padding: 0 40rpx 60rpx;
  box-sizing: border-box;
}

.hero {
  padding: 180rpx 0 60rpx;
  text-align: center;
}
.logo {
  width: 128rpx;
  height: 128rpx;
  margin: 0 auto 28rpx;
  border-radius: 32rpx;
  background: var(--brand);
  color: #fff;
  font-size: 64rpx;
  font-weight: 700;
  line-height: 128rpx;
  text-align: center;
  box-shadow: 0 12rpx 32rpx rgba(217, 79, 43, 0.28);
}
.hero-title {
  font-size: 44rpx;
  font-weight: 700;
  letter-spacing: 2rpx;
}
.hero-sub {
  margin-top: 12rpx;
  font-size: 24rpx;
  color: var(--text-3);
}

.form-card {
  background: #fff;
  border-radius: 24rpx;
  padding: 40rpx 36rpx;
  margin-bottom: 24rpx;
  box-shadow: 0 4rpx 20rpx rgba(31, 35, 41, 0.05);
}

.field {
  margin-bottom: 32rpx;
}
.binding-info { margin: 24rpx 0; padding: 24rpx; background: #f7f8fa; border-radius: 14rpx; display: flex; flex-direction: column; gap: 14rpx; font-size: 26rpx; line-height: 1.6; }
.wechat-section { margin-bottom: 32rpx; }
.label {
  display: block;
  font-size: 24rpx;
  color: var(--text-3);
  margin-bottom: 12rpx;
}
.input {
  height: 88rpx;
  background: #f7f8fa;
  border-radius: 14rpx;
  padding: 0 24rpx;
  font-size: 30rpx;
}
.ph {
  color: #c9cdd4;
  font-size: 28rpx;
}

.alt-login {
  margin-top: 28rpx;
  text-align: center;
  color: var(--brand);
  font-size: 26rpx;
}

.server-issue {
  margin-top: 24rpx;
  padding: 20rpx 24rpx;
  border-radius: 14rpx;
  background: #fff5f5;
  border: 2rpx solid #ffd4d4;
  display: flex;
  flex-direction: column;
}
.server-issue-title {
  font-size: 26rpx;
  font-weight: 600;
  color: #f53f3f;
  margin-bottom: 8rpx;
}
.server-issue-msg {
  font-size: 23rpx;
  color: #a0554f;
  line-height: 1.6;
}
.alt-hint {
  margin-top: 28rpx;
  text-align: center;
  color: var(--text-3);
  font-size: 22rpx;
  line-height: 1.6;
}

.server-card {
  padding: 28rpx 36rpx;
}
.server-title {
  font-size: 28rpx;
  color: var(--text-2);
}
.server-value {
  max-width: 380rpx;
  font-size: 24rpx;
  color: var(--text-3);
}
.server-body {
  margin-top: 24rpx;
}
.server-input {
  font-size: 26rpx;
}
.server-actions {
  display: flex;
  gap: 16rpx;
  margin-top: 20rpx;
}
.mini-btn {
  flex: 1;
  height: 68rpx;
  border-radius: 12rpx;
  background: var(--brand);
  color: #fff;
  font-size: 26rpx;
  line-height: 68rpx;
  text-align: center;
}
.mini-btn--ghost {
  background: #f2f3f5;
  color: var(--text-2);
}
.server-tip {
  margin-top: 20rpx;
  font-size: 22rpx;
  color: var(--text-3);
  line-height: 1.7;
}

.demo-card {
  background: #fffdf8;
  border: 2rpx dashed #ffd9a8;
  border-radius: 20rpx;
  padding: 24rpx 32rpx;
}
.demo-title {
  font-size: 22rpx;
  color: #b8752a;
}
.demo-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14rpx 0;
}
.demo-acc {
  font-size: 26rpx;
  color: var(--text-2);
}
</style>
