<template>
  <main class="pos-automation">
    <header class="project-header">
      <div>
        <p class="eyebrow">收银系统 · 综合营业统计</p>
        <h1>自动导报表</h1>
        <p>与“收银系统数据”手工上传使用同一导入接口和入库规则；美团管家仅是当前报表的采集站点。</p>
      </div>
      <el-button @click="router.push('/data-import/pos')">手工导入</el-button>
    </header>
    <nav class="project-nav" aria-label="收银系统自动导报表导航">
      <button type="button" :class="{ active: section === 'runs' }" :aria-current="section === 'runs' ? 'page' : undefined" @click="router.push('/data-import/pos/automation')">运行记录</button>
      <button v-if="canManageSchedule" type="button" :class="{ active: section === 'schedule' }" :aria-current="section === 'schedule' ? 'page' : undefined" @click="router.push('/data-import/pos/automation/schedule')">同步与日报时间</button>
      <button v-if="canManageSchedule" type="button" :class="{ active: section === 'daily-report' }" :aria-current="section === 'daily-report' ? 'page' : undefined" @click="router.push('/data-import/pos/automation/daily-report')">日报预览与机器人</button>
    </nav>
    <SyncRuns v-if="section === 'runs'" />
    <ScheduleSettingsPanel v-else-if="section === 'schedule'" />
    <PosDailySettings v-else />
  </main>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import SyncRuns from '@/views/analysis/SyncRuns.vue'
import ScheduleSettingsPanel from '@/views/ScheduleSettingsPanel.vue'
import PosDailySettings from '@/views/PosDailySettings.vue'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const canManageSchedule = computed(() => auth.can('enterprise-settings.manage'))
const section = computed(() => route.meta.automationSection || 'runs')
</script>

<style scoped>
.pos-automation { padding: 12px; }
.project-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 20px 24px; border: 1px solid var(--el-border-color-light); border-radius: 10px; background: var(--el-bg-color); }
.project-header .eyebrow { margin: 0 0 6px; color: var(--el-color-primary); font-size: 12px; font-weight: 700; }
.project-header h1 { margin: 0; font-size: 22px; }
.project-header p:last-child { margin: 8px 0 0; color: var(--el-text-color-secondary); font-size: 13px; }
.project-nav { display: flex; gap: 6px; margin: 14px 0 2px; border-bottom: 1px solid var(--el-border-color-light); }
.project-nav button { padding: 10px 16px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--el-text-color-secondary); cursor: pointer; font: inherit; }
.project-nav button.active { border-bottom-color: var(--el-color-primary); color: var(--el-color-primary); font-weight: 700; }
.project-nav button:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
@media (max-width: 700px) { .project-header { flex-direction: column; } }
</style>
