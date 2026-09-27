<template>
  <main class="push-hub">
    <header class="hub-hero"><div><p>DATA DELIVERY · CONTROL CENTER</p><h1>一键推送 · 同步与消息中心</h1><span>在同一入口管理采集内容、采集时间、日报内容、发送机器人和发送时间；采集入库与群消息发送仍是两条独立流程。</span></div></header>
    <nav class="hub-tabs" aria-label="推送中心模块">
      <button v-for="item in visibleTabs" :key="item.key" type="button" :class="{ active: tab === item.key }" :aria-current="tab === item.key ? 'page' : undefined" @click="tab = item.key">{{ item.label }}</button>
    </nav>
    <section v-if="tab === 'overview'" class="overview">
      <div class="overview-heading"><h2>当前配置关系</h2><p>分别保存、分别验收；修改某项不会自动改变另一项，也不会立即补跑或发群消息。</p></div>
      <div v-if="canManage" class="overview-grid">
        <button type="button" @click="tab = 'collection'"><small>01 · 数据入库</small><strong>报表采集</strong><span>选择要同步的报表、开关与每日时间。机器人只交付数据。</span></button>
        <button type="button" @click="tab = 'content'"><small>02 · 内容审批</small><strong>收银日报</strong><span>设置门店范围、预览总览图，并审批样式与目标群。</span></button>
        <button type="button" @click="tab = 'robots'"><small>03 · 消息路由</small><strong>发送机器人</strong><span>为每类日报选择企微机器人；登记与密钥仍统一管理。</span></button>
        <button type="button" @click="tab = 'timing'"><small>04 · 独立时间</small><strong>日报发送</strong><span>中控按已入库数据和安全闸门执行，不依赖采集机器人发消息。</span></button>
      </div>
      <el-alert v-else title="当前岗位可以使用团购日报推送；报表计划、机器人分配和自动日报设置需企业设置管理权限。" type="info" :closable="false" show-icon />
      <el-alert title="目前只有收银系统的三份报表接入自动采集计划；团购每日总结有独立的人工预览与推送。其他平台尚未接入，不会在此伪装成已可同步。" type="info" :closable="false" show-icon />
    </section>
    <ReportSyncPlans v-else-if="tab === 'collection'" />
    <PosDailySettings v-else-if="tab === 'content'" />
    <PushRobotAssignments v-else-if="tab === 'robots'" />
    <ScheduleSettingsPanel v-else-if="tab === 'timing'" />
    <PipelineView v-else-if="tab === 'group-buy'" />
  </main>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import PipelineView from './PipelineView.vue'
import PosDailySettings from './PosDailySettings.vue'
import PushRobotAssignments from './PushRobotAssignments.vue'
import ReportSyncPlans from './ReportSyncPlans.vue'
import ScheduleSettingsPanel from './ScheduleSettingsPanel.vue'

const auth = useAuthStore()
const tabs = [
  { key: 'overview', label: '总览' },
  { key: 'collection', label: '报表同步内容与时间', manage: true },
  { key: 'content', label: '收银日报内容', manage: true },
  { key: 'robots', label: '发送机器人', manage: true },
  { key: 'timing', label: '日报发送时间', manage: true },
  { key: 'group-buy', label: '团购日报推送' },
]
const canManage = computed(() => auth.can('enterprise-settings.manage'))
const visibleTabs = computed(() => tabs.filter(item => !item.manage || canManage.value))
const tab = ref('overview')
</script>

<style scoped>
.push-hub{display:grid;gap:16px;max-width:1500px;padding-bottom:24px;color:var(--el-text-color-primary)}.hub-hero{padding:26px 28px;border-radius:16px;color:#fff;background:linear-gradient(115deg,#17375c,#216f7e)}.hub-hero p{margin:0;color:#a9e7e2;font-size:10px;font-weight:800;letter-spacing:.15em}.hub-hero h1{margin:8px 0;font-size:25px}.hub-hero span{color:#e0f2f1;font-size:13px}.hub-tabs{display:flex;flex-wrap:wrap;gap:7px;padding:8px;border:1px solid var(--el-border-color-light);border-radius:12px;background:var(--el-bg-color)}.hub-tabs button{padding:9px 13px;border:0;border-radius:8px;background:transparent;color:var(--el-text-color-regular);font:inherit;font-size:13px;cursor:pointer}.hub-tabs button.active{background:#e7f4f4;color:#126b72;font-weight:700}.hub-tabs button:focus-visible,.overview-grid button:focus-visible{outline:2px solid var(--el-color-primary);outline-offset:2px}.overview{padding:22px;border:1px solid var(--el-border-color-light);border-radius:14px;background:var(--el-bg-color)}.overview-heading h2{margin:0;font-size:20px}.overview-heading p{margin:6px 0 0;color:var(--el-text-color-secondary);font-size:12px}.overview-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:20px 0}.overview-grid button{display:grid;align-content:start;gap:9px;min-height:150px;padding:19px;text-align:left;border:1px solid var(--el-border-color-light);border-radius:12px;background:var(--el-fill-color-lighter);color:inherit;cursor:pointer}.overview-grid small{color:#16808a;font-size:10px;font-weight:800;letter-spacing:.1em}.overview-grid strong{font-size:17px}.overview-grid span{color:var(--el-text-color-secondary);font-size:12px;line-height:1.6}@media(max-width:1000px){.overview-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:640px){.overview-grid{grid-template-columns:1fr}.hub-hero{padding:22px}.hub-tabs button{flex:1 1 45%}}
</style>
