<template>
  <main class="push-hub">
    <header class="hub-hero"><h1>日报管理</h1><p>当前收银日报是发往管理群的全店汇总。门店群日报需要逐店绑定和独立的单店内容。</p></header>
    <nav class="hub-tabs" aria-label="日报类型">
      <button type="button" :class="{ active: section === 'group-buy' }" :aria-current="section === 'group-buy' ? 'page' : undefined" @click="router.push('/pipeline/group-buy-daily')">团购日报推送</button>
      <button v-if="canManage" type="button" :class="{ active: section === 'pos' }" :aria-current="section === 'pos' ? 'page' : undefined" @click="router.push('/pipeline/pos-daily')">收银全店汇总</button>
      <button v-if="canManage" type="button" :class="{ active: section === 'pos-schedule' }" :aria-current="section === 'pos-schedule' ? 'page' : undefined" @click="router.push('/pipeline/pos-daily/schedule')">汇总自动发送</button>
      <button v-if="canManage" type="button" :class="{ active: section === 'pos-store' }" :aria-current="section === 'pos-store' ? 'page' : undefined" @click="router.push('/pipeline/pos-store-daily')">门店群机器人</button>
    </nav>
    <PipelineView v-if="section === 'group-buy'" />
    <PosDailySettings v-else-if="section === 'pos' && canManage" />
    <ScheduleSettingsPanel v-else-if="section === 'pos-schedule' && canManage" />
    <PosStoreBotOverview v-else-if="section === 'pos-store' && canManage" />
  </main>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import PipelineView from './PipelineView.vue'
import PosDailySettings from './PosDailySettings.vue'
import ScheduleSettingsPanel from './ScheduleSettingsPanel.vue'
import PosStoreBotOverview from './PosStoreBotOverview.vue'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const section = computed(() => route.meta.pushSection || 'group-buy')
const canManage = computed(() => auth.can('enterprise-settings.manage'))
</script>

<style scoped>
.push-hub{display:grid;gap:16px;max-width:1500px;padding-bottom:24px}.hub-hero{padding:23px 27px;border-radius:16px;color:#fff;background:linear-gradient(115deg,#17375c,#216f7e)}.hub-hero h1{margin:0 0 8px;font-size:25px}.hub-hero p{margin:0;color:#e0f2f1;font-size:13px}.hub-tabs{display:flex;flex-wrap:wrap;gap:7px;padding:8px;border:1px solid var(--el-border-color-light);border-radius:12px;background:var(--el-bg-color)}.hub-tabs button{padding:9px 16px;border:0;border-radius:8px;background:transparent;color:var(--el-text-color-regular);font:inherit;font-size:13px;cursor:pointer}.hub-tabs button.active{background:#e7f4f4;color:#126b72;font-weight:700}.hub-tabs button:focus-visible{outline:2px solid var(--el-color-primary);outline-offset:2px}
</style>
