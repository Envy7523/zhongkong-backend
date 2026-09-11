<template>
  <div class="login-container">
    <div class="login-orb orb-one"></div><div class="login-orb orb-two"></div>
    <main class="login-layout">
      <section class="brand-panel" aria-label="鹅太公中控品牌介绍">
        <div class="brand-title"><h1>鹅太公中控</h1><span>V0.4</span></div>
        <p>以科技赋能供应链，用专业守护每一份品质</p>
        <div class="data-illustration" aria-hidden="true"><img src="/images/login-data-illustration-transparent.png" alt="" /></div>
        <small>深圳鹅太公餐饮连锁发展有限公司</small>
      </section>
      <section class="login-card">
      <div class="login-header"><span class="login-kicker">WELCOME BACK</span><h2>登录中控后台</h2><p>请输入账号与密码继续</p></div>
      <el-form ref="formRef" :model="form" :rules="rules" size="large" @submit.prevent="handleLogin">
        <el-form-item prop="username">
          <el-input v-model="form.username" placeholder="用户名" prefix-icon="User" />
        </el-form-item>
        <el-form-item prop="password">
          <el-input v-model="form.password" type="password" placeholder="密码" prefix-icon="Lock" show-password
            @keyup.enter="handleLogin" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" native-type="submit" :loading="loading" class="login-submit">
            {{ loading ? '登录中...' : '登录' }}
          </el-button>
        </el-form-item>
      </el-form>
      <div v-if="error" class="login-error">{{ error }}</div>
      </section>
    </main>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()
const loading = ref(false)
const error = ref('')
const formRef = ref(null)

const form = reactive({
  username: '',
  password: '',
})

const rules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
}

async function handleLogin() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  loading.value = true
  error.value = ''
  try {
    await auth.login(form.username, form.password)
    router.replace('/')
  } catch (e) {
    error.value = e.message || '登录失败'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-container {
  position:relative;overflow:hidden;padding:42px;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background:linear-gradient(135deg,#dffaff 0%,#cef2ff 48%,#e5faff 100%);
}
.login-orb{position:absolute;border-radius:50%;pointer-events:none}.orb-one{width:720px;height:720px;left:-80px;bottom:-280px;background:radial-gradient(circle at 50% 42%,rgba(67,163,255,.82),rgba(71,165,255,.22) 52%,transparent 71%)}.orb-two{width:520px;height:520px;left:170px;top:50px;background:radial-gradient(circle,rgba(172,226,255,.76),transparent 68%)}
.login-layout{position:relative;z-index:1;display:grid;grid-template-columns:minmax(470px,1.15fr) minmax(380px,.85fr);align-items:center;width:min(1500px,100%);gap:clamp(56px,8vw,160px)}
.brand-panel{position:relative;min-height:660px;display:flex;flex-direction:column;justify-content:center;padding-left:clamp(14px,4vw,76px);color:#0a0d14}.brand-title{display:flex;align-items:center;gap:18px}.brand-title h1{margin:0;font-size:clamp(46px,5vw,76px);font-weight:900;letter-spacing:-.07em;line-height:1}.brand-title span{padding:6px 18px 8px;border-radius:18px;background:linear-gradient(110deg,#0758f6,#8bc4ff);box-shadow:0 8px 20px rgba(28,105,235,.24);color:#fff;font-size:clamp(22px,2.5vw,38px);font-weight:800;line-height:1}.brand-panel>p{margin:18px 0 0;color:#4b5f72;font-size:clamp(16px,1.5vw,23px)}.brand-panel>small{position:absolute;bottom:14px;left:clamp(14px,4vw,76px);color:#8194a6;font-size:14px}
.data-illustration{position:relative;width:590px;height:390px;margin:48px 0 0 10px;filter:drop-shadow(0 22px 24px rgba(51,135,218,.19))}.dashboard-sheet{position:absolute;left:156px;top:42px;width:318px;height:247px;border:12px solid rgba(255,255,255,.72);border-radius:16px;background:linear-gradient(145deg,#e7efff,#fff)}.dashboard-sheet:before{content:'';display:block;width:108px;height:13px;margin:28px;border-radius:3px;background:#7aa5f5;box-shadow:148px 0 #8faef0,148px 28px #aec9f7,148px 56px #8baaf1,0 52px #d3e1fa,0 78px #d3e1fa}.dashboard-sheet i{position:absolute;bottom:24px;width:55px;height:64px;border-radius:7px 7px 2px 2px;background:#cfddfb}.dashboard-sheet i:nth-child(1){left:28px;height:44px}.dashboard-sheet i:nth-child(2){left:94px;height:82px}.dashboard-sheet i:nth-child(3){left:160px;height:59px}.dashboard-sheet i:nth-child(4){left:226px;height:104px;background:#86aff9}.phone-frame{position:absolute;z-index:2;left:142px;top:0;width:218px;height:350px;padding:42px 22px;border:11px solid #f7fbff;border-radius:26px;background:linear-gradient(150deg,#dce9ff,#accaff)}.phone-frame>b{position:absolute;top:-3px;left:67px;width:74px;height:20px;border-radius:0 0 11px 11px;background:#f7fbff}.phone-line{height:13px;margin:10px 0;border-radius:3px;background:#fff;box-shadow:0 25px #e4edff}.phone-line.short{width:62%;margin-top:46px}.phone-chart{display:flex;align-items:flex-end;gap:10px;height:85px;margin-top:30px;padding:9px;border-radius:10px;background:rgba(255,255,255,.42)}.phone-chart em{width:20px;border-radius:4px 4px 1px 1px;background:#3981ff}.phone-chart em:nth-child(1){height:42px}.phone-chart em:nth-child(2){height:61px}.phone-chart em:nth-child(3){height:34px}.phone-chart em:nth-child(4){height:71px}.identity-chip{position:absolute;z-index:4;left:20px;top:125px;display:grid;grid-template-columns:35px 1fr;gap:9px;width:152px;padding:11px;border-radius:7px;background:#2878f6;box-shadow:0 8px 17px rgba(19,95,232,.37)}.identity-chip span{width:35px;height:35px;border-radius:5px;background:#dcecff}.identity-chip i{height:9px;border-radius:3px;background:#fff}.identity-chip i:last-child{grid-column:2;width:68%;margin-top:-13px}.chart-card{position:absolute;z-index:4;left:314px;bottom:3px;display:flex;align-items:flex-end;gap:11px;width:156px;height:121px;padding:20px;border-radius:12px;background:linear-gradient(145deg,#075ae9,#196be9);box-shadow:0 13px 25px rgba(11,81,207,.38)}.chart-card span{position:absolute;left:20px;right:20px;bottom:28px;border-top:1px solid rgba(255,255,255,.34)}.chart-card i{z-index:1;width:19px;border-radius:3px 3px 0 0;background:#fff}.chart-card i:nth-child(1){height:50px}.chart-card i:nth-child(2){height:76px}.chart-card i:nth-child(3){height:38px}.chart-card i:nth-child(4){height:62px}
.login-card {
  width:100%;max-width:480px;padding:58px 54px 46px;border:1px solid rgba(255,255,255,.72);border-radius:24px;background:rgba(255,255,255,.94);box-shadow:0 24px 70px rgba(61,129,175,.16);backdrop-filter:blur(18px)
}
.login-header {
  margin-bottom:34px;
}
.login-kicker{display:block;margin-bottom:9px;color:#4d87ee;font-size:11px;font-weight:800;letter-spacing:.16em}.login-header h2{margin:0;color:#152440;font-size:28px;letter-spacing:-.03em}.login-header p{margin:9px 0 0;color:#8a98aa;font-size:13px}.login-card :deep(.el-form-item){margin-bottom:20px}.login-card :deep(.el-input__wrapper){min-height:48px;padding:1px 14px;border-radius:10px;background:#f7faff;box-shadow:0 0 0 1px #e2e9f4 inset}.login-card :deep(.el-input__wrapper.is-focus){background:#fff;box-shadow:0 0 0 1px #3b82f6 inset,0 0 0 4px rgba(59,130,246,.09)}.login-submit{width:100%;height:48px;margin-top:5px;border:0;border-radius:10px;background:linear-gradient(100deg,#1465ec,#4996ff);font-weight:700;letter-spacing:.12em;box-shadow:0 10px 20px rgba(30,111,239,.23)}.login-error{margin-top:-8px;color:#d95762;font-size:13px;text-align:center}.data-illustration{margin-top:36px;filter:drop-shadow(0 22px 24px rgba(51,135,218,.13))}.data-illustration img{display:block;width:100%;height:100%;object-fit:contain}@media(max-width:980px){.login-container{padding:28px}.login-layout{grid-template-columns:1fr;max-width:540px;gap:20px}.brand-panel{display:none}.login-card{max-width:none}}@media(max-width:520px){.login-container{padding:18px}.login-card{padding:42px 28px 32px;border-radius:19px}.login-header h2{font-size:25px}}
.login-container{padding:0;background:#d9f7fb}.login-layout{width:100%;max-width:none;min-height:100vh;grid-template-columns:54.3% 45.7%;gap:0}.brand-panel{min-height:100vh;padding-left:9.1vw;justify-content:flex-start;padding-top:16.4vh}.brand-title h1{font-size:clamp(52px,5.35vw,110px)}.brand-title span{padding:7px 20px 9px;border-radius:18px;font-size:clamp(25px,2.55vw,52px)}.brand-panel>p{margin-top:22px;font-size:clamp(17px,1.62vw,32px)}.data-illustration{width:min(40vw,820px);height:min(30vw,600px);margin:44px 0 0 -34px}.data-illustration img{display:block;width:100%;height:100%;object-fit:contain}.brand-panel>small{bottom:12.5vh;left:9.1vw}.login-card{justify-self:center;align-self:center;width:min(38.1vw,780px);max-width:none;min-height:min(77.3vh,890px);padding:72px 64px;border-radius:25px}.login-header{margin-top:24px}.login-kicker{font-size:12px}.login-header h2{font-size:32px}.login-header p{font-size:14px}.login-card :deep(.el-form){margin-top:54px}.login-card :deep(.el-input__wrapper){min-height:54px}.login-submit{height:54px}.login-orb{background:#72c3f3;opacity:.46;filter:none;animation:none!important}.orb-one{width:56vw;height:56vw;left:-10vw;bottom:-31vw}.orb-two{width:36vw;height:36vw;left:8vw;top:5vw;background:transparent;border:1px solid rgba(74,169,228,.18);opacity:1}@media(max-width:980px){.login-container{padding:28px}.login-layout{grid-template-columns:1fr;min-height:auto;max-width:540px;gap:20px}.brand-panel{display:none}.login-card{width:100%;min-height:0;max-width:none;padding:58px 54px}}@media(max-width:520px){.login-container{padding:18px}.login-card{padding:42px 28px 32px;border-radius:19px}.login-header h2{font-size:25px}}
</style>
