<template>
  <el-card shadow="never" class="review-board" v-loading="loading">
    <template #header><div class="board-header"><strong>记账本 · 历史明细复核</strong><el-button :loading="loading" size="small" @click="load">刷新复核状态</el-button></div></template>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <template v-if="data">
      <p class="schedule">每天 {{ data.settings.run_time }}（北京时间）检查前七个完整业务日；每月一日增加上月整月复核。计划{{ data.settings.enabled ? '已开启' : '已关闭' }}。</p>
      <div class="review-cards">
        <section v-for="item in cards" :key="item.key" class="review-summary">
          <div class="board-header"><h3>{{ item.title }}</h3><el-tag :type="tone(item.value.status)">{{ label(item.value.status) }}</el-tag></div>
          <p>{{ item.value.from }} 至 {{ item.value.to }}</p>
          <strong class="progress">{{ item.value.completed }} / {{ item.value.expected }} 天已复核</strong>
          <p>发现变化 {{ item.value.changed_days }} 天 · 差异 {{ item.value.differences }} 项 · 失败 {{ item.value.failed }} 天</p>
          <p>最近确认：{{ time(item.value.last_checked_at) }}</p>
          <el-alert v-if="item.value.warning" :title="item.value.warning" type="warning" :closable="false" />
          <el-button link type="primary" @click="selected = item.key">查看逐日结果</el-button>
        </section>
      </div>
      <p class="note">以机器人复核批次和落库记录确认执行；普通导入或已有明细不算完成复核。发现差异后更新收银来源记录，保留人工记账。</p>
      <el-radio-group v-model="selected" size="small"><el-radio-button value="daily">今日七天复核</el-radio-button><el-radio-button value="monthly">上月整月复核</el-radio-button></el-radio-group>
      <el-table :data="data[selected].details" size="small" max-height="380" class="details">
        <el-table-column prop="date" label="业务日期" width="130" />
        <el-table-column label="复核结果" min-width="130"><template #default="{row}"><el-tag :type="tone(row.status)" size="small">{{ row.status === 'success' ? (row.changed ? '完成，有变化' : '完成，无变化') : label(row.status) }}</el-tag></template></el-table-column>
        <el-table-column prop="row_count" label="明细笔数" width="110" />
        <el-table-column prop="differences" label="差异项数" width="110" />
        <el-table-column label="检查时间" min-width="170"><template #default="{row}">{{ time(row.checked_at) }}</template></el-table-column>
        <el-table-column prop="reason" label="异常说明" min-width="220" />
      </el-table>
      <h4>最近七次每日复核</h4>
      <el-table :data="data.history" size="small">
        <el-table-column prop="run_date" label="计划执行日" width="130" />
        <el-table-column label="检查范围" min-width="240"><template #default="{row}">{{ row.from }} 至 {{ row.to }}</template></el-table-column>
        <el-table-column label="完成天数" width="110"><template #default="{row}">{{ row.completed }} / {{ row.expected }}</template></el-table-column>
        <el-table-column label="状态" width="140"><template #default="{row}"><el-tag :type="tone(row.status)" size="small">{{ label(row.status) }}</el-tag></template></el-table-column>
        <el-table-column label="完成时间" min-width="170"><template #default="{row}">{{ time(row.finished_at) }}</template></el-table-column>
      </el-table>
    </template>
  </el-card>
</template>
<script setup>
import { ref, computed, onMounted } from 'vue'
import { getBookkeepingReviewDashboard } from '@/api'
const data = ref(null), loading = ref(false), error = ref(''), selected = ref('daily')
const cards = computed(() => data.value ? [{ key: 'daily', title: '今日前七天复核', value: data.value.daily }, { key: 'monthly', title: '本月一日 · 上月整月复核', value: data.value.monthly }] : [])
const label = status => ({ success: '已完成', partial: '未全部完成', failed: '失败', running: '执行中', missing: '暂无复核记录', pending: '尚未到执行时间', disabled: '计划已关闭', unknown: '状态无法确认' }[status] || status)
const tone = status => ({ success: 'success', partial: 'warning', failed: 'danger', running: 'primary', unknown: 'warning' }[status] || 'info')
const time = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'
async function load() {
  loading.value = true; error.value = ''
  try { data.value = await getBookkeepingReviewDashboard() }
  catch (e) { data.value = null; error.value = e.message || '复核状态加载失败' }
  finally { loading.value = false }
}
onMounted(load)
</script>
<style scoped>
.review-board{margin:16px 12px}.board-header{display:flex;align-items:center;justify-content:space-between;gap:12px}.schedule,.note{color:var(--el-text-color-secondary);line-height:1.7}.review-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.review-summary{border:1px solid var(--el-border-color-light);border-radius:8px;padding:18px}.review-summary h3{margin:0;font-size:16px}.review-summary p{color:var(--el-text-color-secondary);font-size:13px}.progress{font-size:24px}.details{margin-top:12px}@media(max-width:700px){.review-cards{grid-template-columns:1fr}.board-header{flex-wrap:wrap}}
</style>
