<template>
  <div class="daily-summary-page">
    <section class="summary-hero">
      <div>
        <span>GROUP BUY · DAILY CLOSE</span>
        <h2>点亮 &amp; 打卡&amp; 评价每日任务</h2>
        <p>看板默认昨天、单日、全部门店；选好日期与门店后点「查询」看历史。数据一律只读，录入请点右上角「今日汇报」。</p>
      </div>
      <div class="hero-side">
        <div class="hero-date">{{ rangeLabel }}</div>
        <el-button type="primary" plain @click="openReportDialog">今日汇报</el-button>
      </div>
    </section>

    <section class="summary-toolbar">
      <div class="toolbar-main">
        <el-date-picker v-model="dateRange" type="daterange" value-format="YYYY-MM-DD" format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" :clearable="false" style="width:250px" />
        <StoreRegionSelect
          v-model="selectedStoreIds"
          :stores="stores"
          :multiple="!isMultiDay"
          :filterable="false"
          :show-hint="false"
          show-selection-actions
          input-width="250px"
          :placeholder="isMultiDay ? '选择门店（多天视图限单选）' : '选择门店（可多选、可全选、不选即全部）'"
        />
        <el-button-group>
          <el-button @click="applyQuickRange('today')">今天</el-button>
          <el-button @click="applyQuickRange('month')">本月</el-button>
        </el-button-group>
        <el-button type="primary" :loading="loading" @click="loadRows">查询</el-button>
        <el-button type="success" plain :disabled="!rows.length" :loading="batchSending" @click="syncCurrentRows">一键同步</el-button>
        <el-button plain :disabled="!rows.length" @click="exportCurrentRows">导出 Excel</el-button>
      </div>
      <div class="toolbar-actions">
        <span class="target-hint">{{ toolbarHint }}</span>
      </div>
    </section>

    <section class="summary-table-card" v-loading="loading">
      <header class="table-heading">
        <div><span>数据看板</span><h3>{{ rangeLabel }}</h3></div>
        <p>{{ isMultiDay ? '多天视图：一行一天，请选定单一门店。' : '单日视图：一行一门店。' }}灰色为自动计算，只读；录入请用右上角「今日汇报」。</p>
      </header>
      <el-table :data="rows" class="summary-table" border row-key="rowKey" :scroll-shadow="false" :max-height="tableHeight" empty-text="暂无可展示数据">
        <el-table-column fixed="left" :label="isMultiDay ? '日期' : '门店'" width="196" header-align="center">
          <template #default="{row}">
            <div class="store-cell">
              <b>{{ isMultiDay ? row.biz_date : row.store_name }}</b>
              <small v-if="isMultiDay">{{ row.store_name }}</small>
              <small v-else>{{ row.target_source_date ? `目标取自 ${row.target_source_date}` : '前一日无记录，今日目标未设' }}</small>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="点亮有礼" align="center">
          <el-table-column label="点亮任务目标数" width="118" align="center"><template #default="{row}"><span class="calculated">{{ targetText(row,'lighting') }}</span></template></el-table-column>
          <el-table-column label="点亮实际达成数" width="126" align="center"><template #default="{row}"><b class="actual">{{ row.lighting_actual }}</b></template></el-table-column>
          <el-table-column label="今日达成率" width="104" align="center"><template #default="{row}"><b :class="rateClass(row,'lighting')">{{ rateText(row,'lighting') }}</b></template></el-table-column>
        </el-table-column>

        <el-table-column label="收藏打卡" align="center">
          <el-table-column label="打卡任务目标数" width="118" align="center"><template #default="{row}"><span class="calculated">{{ targetText(row,'checkin') }}</span></template></el-table-column>
          <el-table-column label="打卡实际达成数" width="126" align="center"><template #default="{row}"><b class="actual">{{ row.checkin_actual }}</b></template></el-table-column>
          <el-table-column label="今日达成率" width="104" align="center"><template #default="{row}"><b :class="rateClass(row,'checkin')">{{ rateText(row,'checkin') }}</b></template></el-table-column>
        </el-table-column>

        <el-table-column label="好评引导" align="center">
          <el-table-column label="抖音" align="center">
            <el-table-column label="评价任务目标数" width="118" align="center"><template #default="{row}"><span class="calculated">{{ targetText(row,'douyin_review') }}</span></template></el-table-column>
            <el-table-column label="实际达成数" width="112" align="center"><template #default="{row}"><b class="actual">{{ row.douyin_review_actual }}</b></template></el-table-column>
            <el-table-column label="今日达成率" width="104" align="center"><template #default="{row}"><b :class="rateClass(row,'douyin_review')">{{ rateText(row,'douyin_review') }}</b></template></el-table-column>
          </el-table-column>
          <el-table-column label="美团" align="center">
            <el-table-column label="评价任务目标数" width="118" align="center"><template #default="{row}"><span class="calculated">{{ targetText(row,'meituan_review') }}</span></template></el-table-column>
            <el-table-column label="实际达成数" width="112" align="center"><template #default="{row}"><b class="actual">{{ row.meituan_review_actual }}</b></template></el-table-column>
            <el-table-column label="今日达成率" width="104" align="center"><template #default="{row}"><b :class="rateClass(row,'meituan_review')">{{ rateText(row,'meituan_review') }}</b></template></el-table-column>
          </el-table-column>
        </el-table-column>

        <el-table-column label="每日差评" align="center">
          <el-table-column label="美团" align="center">
            <el-table-column label="星级" width="92" align="center"><template #default="{row}"><span class="calculated">{{ row.meituan_rating == null ? '—' : row.meituan_rating }}</span></template></el-table-column>
            <el-table-column label="今日差评" width="100" align="center"><template #default="{row}"><b class="actual">{{ row.meituan_negative_reviews }}</b></template></el-table-column>
            <el-table-column label="差评原因" min-width="180" header-align="center"><template #default="{row}"><el-tooltip v-if="row.meituan_negative_reason" :content="row.meituan_negative_reason" placement="top"><span class="reason-text">{{ row.meituan_negative_reason }}</span></el-tooltip><span v-else class="muted">—</span></template></el-table-column>
          </el-table-column>
          <el-table-column label="抖音" align="center">
            <el-table-column label="星级" width="92" align="center"><template #default="{row}"><span class="calculated">{{ row.douyin_rating == null ? '—' : row.douyin_rating }}</span></template></el-table-column>
            <el-table-column label="今日差评" width="100" align="center"><template #default="{row}"><b class="actual">{{ row.douyin_negative_reviews }}</b></template></el-table-column>
            <el-table-column label="差评原因" min-width="180" header-align="center"><template #default="{row}"><el-tooltip v-if="row.douyin_negative_reason" :content="row.douyin_negative_reason" placement="top"><span class="reason-text">{{ row.douyin_negative_reason }}</span></el-tooltip><span v-else class="muted">—</span></template></el-table-column>
          </el-table-column>
        </el-table-column>

        <el-table-column label="明日任务目标（今晚填写，次日执行）" align="center">
          <el-table-column label="点亮" width="100" align="center"><template #default="{row}"><b class="actual">{{ row.next_lighting_target }}</b></template></el-table-column>
          <el-table-column label="打卡" width="100" align="center"><template #default="{row}"><b class="actual">{{ row.next_checkin_target }}</b></template></el-table-column>
          <el-table-column label="抖音好评" width="110" align="center"><template #default="{row}"><b class="actual">{{ row.next_douyin_review_target }}</b></template></el-table-column>
          <el-table-column label="美团好评" width="110" align="center"><template #default="{row}"><b class="actual">{{ row.next_meituan_review_target }}</b></template></el-table-column>
        </el-table-column>
        <el-table-column fixed="right" label="日报推送" width="92" align="center" header-align="center">
          <template #default="{row}">
            <el-button link type="primary" :loading="sendingRowKey === row.rowKey" @click="pushRow(row)">推送</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <GroupBuyDailyReportDialog
      v-model="reportVisible"
      :stores="stores"
      :store-ids="selectedStoreIds"
      :initial-date="asDate(new Date())"
      @saved="handleReportSaved"
    />
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as XLSX from 'xlsx'
import StoreRegionSelect from '@/components/StoreRegionSelect.vue'
import GroupBuyDailyReportDialog from '@/views/analysis/GroupBuyDailyReportDialog.vue'
import { getAllGroupBuyDailySummaries, getGroupBuyDailySummary, getStores, sendGroupBuyDailyPush } from '@/api'

const stores = ref([])
const rows = ref([])
const loading = ref(false)
const reportVisible = ref(false)
const sendingRowKey = ref('')
const batchSending = ref(false)
const tableHeight = 'calc(100vh - 300px)'

const today = new Date()
const asDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
// 看板默认「昨天」：数据通常当天已导入；当天要录入时点右上角「今日汇报」。
const dateRange = ref([asDate(yesterday), asDate(yesterday)])
const selectedStoreIds = ref([])

const isMultiDay = computed(() => dateRange.value?.length === 2 && dateRange.value[0] !== dateRange.value[1])
// 多天视图必须锁定单一门店：选好范围后再选门店，点「查询」才执行；这里只做提示，不弹错误。
const toolbarHint = computed(() => isMultiDay.value && selectedStoreIds.value.length !== 1
  ? '多天查询请先选定一家门店，再点「查询」'
  : '今日目标 = 该门店前一个自然日填写的「明日目标」；选好日期与门店后点「查询」')
const rangeLabel = computed(() => {
  const range = dateRange.value || []
  if (range.length !== 2) return '未选择日期'
  return range[0] === range[1] ? range[0] : `${range[0]} 至 ${range[1]}`
})

const zero = value => Number(value || 0)

function toRow(store, record = {}) {
  const bizDate = record.biz_date || dateRange.value?.[0] || ''
  return {
    rowKey: `${bizDate}:${Number(store.id)}`,
    store_id: Number(store.id),
    store_name: record.store_name || store.store_name || '',
    biz_date: bizDate,
    targets: record.targets || {},
    target_source_date: record.target_source_date || '',
    lighting_actual: zero(record.lighting_actual), checkin_actual: zero(record.checkin_actual),
    douyin_review_actual: zero(record.douyin_review_actual), meituan_review_actual: zero(record.meituan_review_actual),
    meituan_rating: record.meituan_rating == null ? null : Number(record.meituan_rating),
    meituan_negative_reviews: zero(record.meituan_negative_reviews), meituan_negative_reason: record.meituan_negative_reason || '',
    douyin_rating: record.douyin_rating == null ? null : Number(record.douyin_rating),
    douyin_negative_reviews: zero(record.douyin_negative_reviews), douyin_negative_reason: record.douyin_negative_reason || '',
    next_lighting_target: zero(record.next_lighting_target), next_checkin_target: zero(record.next_checkin_target),
    next_douyin_review_target: zero(record.next_douyin_review_target), next_meituan_review_target: zero(record.next_meituan_review_target),
  }
}

// 目标为 null（前一日无记录）= 未设，显示「—」；目标为 0 说明填过 0，按 0 计并给出 0.0%。
function targetText(row, type) {
  const value = row.targets?.[type]
  return value == null || value === '' ? '—' : value
}
function rateValue(row, type) {
  const target = Number(row.targets?.[type])
  return target > 0 ? zero(row[`${type}_actual`]) / target : 0
}
function rateText(row, type) { return `${(rateValue(row, type) * 100).toFixed(1)}%` }
function rateClass(row, type) { return rateValue(row, type) >= 1 ? 'rate-good' : 'rate-warning' }
function exportTarget(row, type) {
  const value = row.targets?.[type]
  return value == null || value === '' ? '' : Number(value)
}

function applyQuickRange(kind) {
  const now = new Date()
  if (kind === 'today') dateRange.value = [asDate(now), asDate(now)]
  else dateRange.value = [asDate(new Date(now.getFullYear(), now.getMonth(), 1)), asDate(new Date(now.getFullYear(), now.getMonth() + 1, 0))]
}

async function loadRows() {
  const range = dateRange.value || []
  if (range.length !== 2 || !range[0] || !range[1]) { rows.value = []; return }
  // 多天视图只有一行一天一种排法，必须锁定单一门店；这里不再弹错误，
  // 由工具栏提示引导用户改选门店（提示见 toolbarHint）。
  if (isMultiDay.value && selectedStoreIds.value.length !== 1) { rows.value = []; return }
  loading.value = true
  try {
    let loaded
    if (isMultiDay.value) {
      // 单店多天：每行一天，按天铺满区间（没有记录的天也显示，便于发现漏录）。
      const result = await getAllGroupBuyDailySummaries({ store_id: selectedStoreIds.value[0], date_from: range[0], date_to: range[1] })
      const store = stores.value.find(item => Number(item.id) === Number(selectedStoreIds.value[0])) || { id: selectedStoreIds.value[0], store_name: '' }
      const byDate = new Map((result.records || []).map(record => [record.biz_date, record]))
      loaded = []
      for (const cursor = new Date(`${range[0]}T12:00:00`), end = new Date(`${range[1]}T12:00:00`); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
        const date = asDate(cursor)
        loaded.push(toRow(store, byDate.get(date) || { biz_date: date, store_id: Number(store.id) }))
      }
      loaded.reverse() // 最新的日期排在最上面
    } else if (selectedStoreIds.value.length) {
      // 单日 + 选定门店：逐店取回，没记录的门店也显示成 0 行。
      const results = await Promise.all(selectedStoreIds.value.map(id => getGroupBuyDailySummary({ store_id: id, date: range[0] })))
      loaded = selectedStoreIds.value.map((id, index) => {
        const store = stores.value.find(item => Number(item.id) === Number(id)) || { id, store_name: `门店 ${id}` }
        return toRow(store, results[index].record || { biz_date: range[0], store_id: Number(id) })
      })
    } else {
      // 单日 + 全部门店：一次请求取回。
      const result = await getAllGroupBuyDailySummaries({ date_from: range[0], date_to: range[0] })
      const byId = new Map((result.records || []).map(record => [Number(record.store_id), record]))
      loaded = stores.value.map(store => toRow(store, byId.get(Number(store.id)) || { biz_date: range[0], store_id: Number(store.id) }))
    }
    rows.value = loaded
  } catch (error) {
    ElMessage.error(`加载每日总结失败：${error.message}`)
  } finally { loading.value = false }
}

async function pushRow(row) {
  sendingRowKey.value = row.rowKey
  try {
    const result = await sendGroupBuyDailyPush({ biz_date: row.biz_date, store_ids: [row.store_id] })
    ElMessage.success(result.message)
  } catch (error) {
    ElMessage.error(`${row.store_name} 推送失败：${error.message}`)
  } finally { sendingRowKey.value = '' }
}

async function syncCurrentRows() {
  if (!rows.value.length) return
  try {
    await ElMessageBox.confirm(`将按当前查询结果逐店发送 ${rows.value.length} 条日报；未完成今日汇报的门店会自动跳过。`, '一键同步当前日报', { confirmButtonText: '开始同步', cancelButtonText: '取消', type: 'warning' })
  } catch { return }
  batchSending.value = true
  let succeeded = 0
  const failed = []
  for (const row of rows.value) {
    try {
      await sendGroupBuyDailyPush({ biz_date: row.biz_date, store_ids: [row.store_id] })
      succeeded += 1
    } catch (error) { failed.push(row.store_name || row.biz_date) }
  }
  batchSending.value = false
  if (failed.length) ElMessage.warning(`已同步 ${succeeded}/${rows.value.length} 条；${failed.join('、')} 尚未保存日报或推送失败。`)
  else ElMessage.success(`已逐店同步 ${succeeded} 条日报`)
}

function exportCurrentRows() {
  if (!rows.value.length) return
  const data = rows.value.map(row => ({
    日期: row.biz_date,
    门店: row.store_name,
    美团收藏打卡目标: exportTarget(row, 'checkin'),
    美团收藏打卡实际达成: row.checkin_actual,
    美团收藏打卡达成率: rateValue(row, 'checkin'),
    美团评价引导目标: exportTarget(row, 'meituan_review'),
    美团评价引导实际达成: row.meituan_review_actual,
    美团评价引导达成率: rateValue(row, 'meituan_review'),
    美团门店星级: row.meituan_rating == null ? '' : row.meituan_rating,
    美团今日差评: row.meituan_negative_reviews,
    美团差评原因: row.meituan_negative_reason,
    抖音点亮有礼目标: exportTarget(row, 'lighting'),
    抖音点亮有礼实际达成: row.lighting_actual,
    抖音点亮有礼达成率: rateValue(row, 'lighting'),
    抖音评价引导目标: exportTarget(row, 'douyin_review'),
    抖音评价引导实际达成: row.douyin_review_actual,
    抖音评价引导达成率: rateValue(row, 'douyin_review'),
    抖音门店星级: row.douyin_rating == null ? '' : row.douyin_rating,
    抖音今日差评: row.douyin_negative_reviews,
    抖音差评原因: row.douyin_negative_reason,
    美团明日收藏打卡目标: row.next_checkin_target,
    美团明日评价引导目标: row.next_meituan_review_target,
    抖音明日点亮有礼目标: row.next_lighting_target,
    抖音明日评价引导目标: row.next_douyin_review_target,
  }))
  const sheet = XLSX.utils.json_to_sheet(data)
  sheet['!cols'] = [
    { wch: 13 }, { wch: 24 }, ...Array.from({ length: 20 }, () => ({ wch: 18 })), { wch: 30 }, { wch: 30 },
  ]
  // 达成率保留为数值，Excel 中仍以百分比展示，便于后续筛选与汇总。
  for (let rowIndex = 1; rowIndex <= data.length; rowIndex += 1) {
    for (const columnIndex of [4, 7, 13, 16]) {
      const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })]
      if (cell) cell.z = '0.0%'
    }
  }
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, '每日总结')
  XLSX.writeFile(workbook, `点亮_打卡_评价每日任务_${rangeLabel.value.replaceAll(' ', '')}.xlsx`)
  ElMessage.success(`已导出 ${data.length} 条每日任务数据`)
}

function openReportDialog() { reportVisible.value = true }
async function handleReportSaved({ bizDate }) {
  // 汇报的日期若落在当前查询范围内，顺带刷新看板，省一次手动点击。
  const range = dateRange.value || []
  if (range.length === 2 && bizDate >= range[0] && bizDate <= range[1]) await loadRows()
}

onMounted(async () => {
  try {
    const result = await getStores({ page: 1, page_size: 500 })
    stores.value = (result.stores || result.rows || []).map(store => ({ ...store, id: Number(store.id) }))
    await loadRows()
  } catch (error) { ElMessage.error(`门店加载失败：${error.message}`) }
})
</script>

<style scoped>
.daily-summary-page{color:#263b53;padding-bottom:4px}.summary-hero{position:relative;display:flex;align-items:center;justify-content:space-between;gap:24px;padding:25px 28px;margin-bottom:14px;overflow:hidden;border:1px solid rgba(107,223,188,.15);border-radius:16px;color:#fff;background:radial-gradient(circle at 86% -18%,rgba(137,239,204,.29),transparent 38%),linear-gradient(120deg,#123a59,#146f68);box-shadow:0 12px 30px rgba(19,91,91,.13)}.summary-hero:after{position:absolute;right:-52px;bottom:-78px;width:200px;height:200px;border:1px solid rgba(184,255,229,.16);border-radius:50%;content:''}.summary-hero>div{position:relative;z-index:1}.summary-hero span,.table-heading span{font-size:10px;letter-spacing:.15em;font-weight:800}.summary-hero span{color:#a8efd8}.summary-hero h2{margin:7px 0 5px;font-size:24px;letter-spacing:.01em}.summary-hero p{max-width:720px;margin:0;color:rgba(255,255,255,.76);font-size:12px;line-height:1.65}.hero-side{display:flex;align-items:center;gap:10px;flex-shrink:0}.hero-date{padding:9px 12px;border:1px solid rgba(255,255,255,.22);border-radius:9px;background:rgba(5,38,56,.18);font-size:12px;font-weight:700;white-space:nowrap}.hero-side :deep(.el-button--primary.is-plain){height:34px;border-color:rgba(201,255,236,.68);color:#0d675e;background:#e0fff3;font-weight:700;box-shadow:0 5px 13px rgba(4,40,50,.18)}.hero-side :deep(.el-button--primary.is-plain:hover){border-color:#fff;color:#fff;background:rgba(255,255,255,.16)}
.summary-toolbar,.summary-table-card{border:1px solid #e1e9ef;border-radius:14px;background:#fff;box-shadow:0 7px 22px rgba(22,53,79,.045)}.summary-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;margin-bottom:14px;flex-wrap:wrap}.toolbar-main,.toolbar-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.toolbar-main{padding-right:16px;border-right:1px solid #edf1f4}.toolbar-actions{min-height:32px}.toolbar-label,.target-hint{color:#71849a;font-size:12px}.target-hint:before{display:inline-block;width:6px;height:6px;margin-right:6px;border-radius:50%;background:#26a886;content:'';vertical-align:1px}
.table-heading{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:15px 18px;border-bottom:1px solid #edf1f4;background:linear-gradient(90deg,#fff,#fbfdfd)}.table-heading span{color:#168672}.table-heading h3{margin:4px 0 0;font-size:15px}.table-heading p{margin:0;color:#8191a3;font-size:11px;line-height:1.55}.summary-table-card{overflow:hidden}
.summary-table{width:100%;font-size:12px}.summary-table :deep(.el-table__header-wrapper th){padding:10px 0;background:#f5f8fb;color:#506a83;font-size:11px;font-weight:700}.summary-table :deep(.el-table__body tr:hover>td.el-table__cell){background:#f8fcfb}.summary-table :deep(.el-table__cell){padding:8px 0}.summary-table :deep(.el-table__border-left-patch),.summary-table :deep(.el-table__fixed-right-patch){display:none}.summary-table :deep([class*="table-fixed-column--"].is-last-column),.summary-table :deep([class*="table-fixed-column--"].is-first-column){box-shadow:none!important}.summary-table :deep(.el-table-fixed-column--left.is-last-column){border-right:1px solid #dbe7e8}.summary-table :deep(.el-table-fixed-column--left){background:#fff}.summary-table :deep(.el-table__body tr:hover .el-table-fixed-column--left){background:#f8fcfb}
.store-cell{display:flex;flex-direction:column;gap:4px;padding:1px 7px;line-height:1.35}.store-cell b{overflow:hidden;color:#26455c;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.store-cell small{color:#8d9bab;font-size:10px}.calculated{display:inline-block;min-width:44px;padding:3px 7px;border:1px solid #e4ebf0;border-radius:7px;background:#f2f5f8;color:#7086a0;font-weight:700}.actual{color:#26455c}.rate-good{color:#12907a}.rate-warning{color:#d18729}.muted{color:#a9b6c4}.reason-text{display:inline-block;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#5b7690}
@media(max-width:1040px){.toolbar-main{padding-right:0;border-right:0}.target-hint{display:none}}@media(max-width:760px){.summary-hero{align-items:flex-start;flex-direction:column;padding:21px}.summary-hero h2{font-size:21px}.hero-side{width:100%;justify-content:space-between}.summary-toolbar{align-items:stretch}.toolbar-main{align-items:stretch;flex-direction:column}.toolbar-main :deep(.el-date-editor),.toolbar-main :deep(.store-region-select),.toolbar-main :deep(.el-button-group),.toolbar-main :deep(.el-button){width:100%!important}.toolbar-main :deep(.el-button-group){display:flex}.toolbar-main :deep(.el-button-group .el-button){flex:1}.table-heading{align-items:flex-start;flex-direction:column}.table-heading p{display:none}}
</style>
