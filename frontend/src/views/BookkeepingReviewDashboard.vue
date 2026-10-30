<template>
  <el-card shadow="never" class="review-board" v-loading="loading">
    <template #header><div class="board-header"><strong>记账本 · 历史明细复核</strong><el-button :loading="loading" size="small" @click="load">刷新复核状态</el-button></div></template>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <template v-if="data">
      <p class="schedule">每日 {{ data.settings.run_time }} · 北京时间 · 前七个完整业务日；每月一日加查上月。计划{{ data.settings.enabled ? '已开启' : '已关闭' }}。</p>
      <div class="review-cards">
        <section v-for="item in cards" :key="item.key" class="review-summary">
          <div class="summary-heading"><h3>{{ item.title }}</h3><el-tag size="small" :type="tone(item.value.status)">{{ label(item.value.status) }}</el-tag><strong class="progress">{{ item.value.completed }} / {{ item.value.expected }}<small> 天</small></strong></div>
          <div class="summary-meta"><span>{{ item.value.from }} 至 {{ item.value.to }}</span><span>变化 <b>{{ item.value.changed_days }}</b> 天 · 差异 <b>{{ item.value.differences }}</b> 项 · 失败 <b>{{ item.value.failed }}</b> 天</span></div>
          <div class="summary-footer"><span>最近确认 {{ time(item.value.last_checked_at) }}</span><el-button link size="small" type="primary" @click="selected = item.key">逐日结果</el-button></div>
          <el-alert v-if="item.value.warning" :title="item.value.warning" type="warning" :closable="false" />
        </section>
      </div>
      <div class="results-toolbar"><el-radio-group v-model="selected" size="small"><el-radio-button value="daily">今日七天复核</el-radio-button><el-radio-button value="monthly">上月整月复核</el-radio-button></el-radio-group><el-tooltip content="以机器人批次和落库记录确认执行；普通导入或已有明细不算完成复核。发现差异后更新收银来源记录，保留人工记账。"><span class="note" tabindex="0">按复核批次确认 · 保留人工记账 ⓘ</span></el-tooltip></div>
      <el-table :data="data[selected].details" size="small" max-height="380" class="details">
        <el-table-column prop="date" label="业务日期" width="116" />
        <el-table-column label="复核结果" width="155"><template #default="{row}"><el-tag :type="row.changed && row.status === 'success' ? 'warning' : tone(row.status)" size="small">{{ row.status === 'success' ? (row.changed ? '完成，有变化' : '完成，无变化') : label(row.status) }}</el-tag></template></el-table-column>
        <el-table-column prop="row_count" label="明细笔数" width="92" align="center" />
        <el-table-column prop="differences" label="差异项数" width="92" align="center" />
        <el-table-column label="检查时间" width="174"><template #default="{row}">{{ time(row.checked_at) }}</template></el-table-column>
        <el-table-column prop="reason" label="异常说明" min-width="180" show-overflow-tooltip />
      </el-table>
      <el-collapse v-model="expanded" class="history"><el-collapse-item name="history"><template #title><span class="history-title">最近七次每日复核 <small>{{ data.history.length }} 次记录</small></span></template>
      <el-table :data="data.history" size="small" max-height="280">
        <el-table-column prop="run_date" label="计划执行日" width="130" />
        <el-table-column label="检查范围" min-width="240"><template #default="{row}">{{ row.from }} 至 {{ row.to }}</template></el-table-column>
        <el-table-column label="完成天数" width="110" align="center"><template #default="{row}">{{ row.completed }} / {{ row.expected }}</template></el-table-column>
        <el-table-column label="状态" width="140"><template #default="{row}"><el-tag :type="tone(row.status)" size="small">{{ label(row.status) }}</el-tag></template></el-table-column>
        <el-table-column label="完成时间" min-width="170"><template #default="{row}">{{ time(row.finished_at) }}</template></el-table-column>
      </el-table>
      </el-collapse-item></el-collapse>
    </template>
  </el-card>
</template>
<script setup>
import { ref, computed, onMounted } from 'vue'
import { getBookkeepingReviewDashboard } from '@/api'
const data = ref(null), loading = ref(false), error = ref(''), selected = ref('daily')
const expanded = ref([])
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
.review-board{margin:12px;min-width:0}.review-board :deep(.el-card__header){padding:12px 16px}.review-board :deep(.el-card__body){padding:12px 16px}.board-header{display:flex;align-items:center;justify-content:space-between;gap:12px}.schedule,.note{color:var(--el-text-color-secondary);font-size:12px;line-height:1.5}.schedule{margin:0 0 10px}.review-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.review-summary{min-width:0;border:1px solid var(--el-border-color-light);border-radius:8px;padding:10px 12px;background:var(--el-fill-color-extra-light)}.summary-heading{display:flex;align-items:center;gap:8px}.review-summary h3{margin:0;font-size:13px;font-weight:600}.progress{margin-left:auto;font-size:20px;white-space:nowrap;color:var(--el-text-color-primary)}.progress small{font-size:12px;font-weight:400;color:var(--el-text-color-secondary)}.summary-meta,.summary-footer{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:4px 12px;color:var(--el-text-color-secondary);font-size:12px;line-height:1.5}.summary-meta{margin-top:6px}.summary-meta b{font-weight:600;color:var(--el-text-color-regular)}.summary-footer{margin-top:4px}.results-toolbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-top:12px}.note{cursor:help}.details{margin-top:8px}.review-board :deep(.el-table .el-table__cell){padding:5px 0}.history{margin-top:10px;border-bottom:0}.history-title{font-size:13px;font-weight:600}.history-title small{margin-left:8px;font-size:12px;font-weight:400;color:var(--el-text-color-secondary)}.history :deep(.el-collapse-item__header){height:36px;line-height:36px;border-bottom:0}.history :deep(.el-collapse-item__content){padding-bottom:0}.history :deep(.el-collapse-item__wrap){border-bottom:0}@media(max-width:900px){.review-cards{grid-template-columns:1fr}}@media(max-width:600px){.review-board{margin:8px 0}.summary-heading{flex-wrap:wrap}.board-header{flex-wrap:wrap}.review-board :deep(.el-card__body){padding:10px}.results-toolbar .note{display:none}}
</style>
