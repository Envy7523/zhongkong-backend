<template>
  <el-dialog
    :model-value="modelValue"
    title="今日汇报"
    class="daily-report-dialog"
    width="94vw"
    top="5vh"
    :close-on-click-modal="false"
    @update:model-value="value => emit('update:modelValue', value)"
  >
    <div class="report-toolbar">
      <span class="toolbar-label">汇报日期</span>
      <el-date-picker v-model="bizDate" type="date" value-format="YYYY-MM-DD" format="YYYY-MM-DD" :clearable="false" style="width:150px" @change="loadRecords" />
      <span class="toolbar-label">汇报门店</span>
      <StoreRegionSelect
        v-model="selectedStoreIds"
        :stores="stores"
        multiple
        :filterable="false"
        :show-hint="false"
        show-selection-actions
        input-width="240px"
        placeholder="选择门店（可多选、可全选）"
        @update:model-value="loadRecords"
      />
      <el-button size="small" :loading="loading" @click="loadRecords">刷新</el-button>
      <span class="report-tip">一行一家门店，横向滚动查看全部字段；灰色为自动带入的目标值。</span>
    </div>

    <el-table v-loading="loading" :data="rows" border row-key="storeId" class="report-table" :max-height="tableHeight" :scroll-shadow="false" empty-text="请选择要汇报的门店">
      <el-table-column fixed="left" label="门店" prop="store_name" width="180" header-align="center">
        <template #default="{row}">
          <div class="store-cell">
            <b>{{ row.store_name }}</b>
            <small>{{ row.target_source_date ? `目标取自 ${row.target_source_date}` : '前一日无记录，目标未设' }}</small>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="点亮有礼" align="center" label-class-name="douyin-header">
        <el-table-column label="实际达成数" width="130" align="center" label-class-name="douyin-header">
          <template #default="{row}"><el-input-number v-model="row.form.lighting_actual" :min="0" :controls="false" size="small" /></template>
        </el-table-column>
        <el-table-column label="明日目标" width="130" align="center" label-class-name="douyin-header">
          <template #default="{row}"><el-input-number v-model="row.form.next_lighting_target" :min="0" :controls="false" size="small" /></template>
        </el-table-column>
      </el-table-column>

      <el-table-column label="收藏打卡" align="center" label-class-name="meituan-header">
        <el-table-column label="实际达成数" width="130" align="center" label-class-name="meituan-header">
          <template #default="{row}"><el-input-number v-model="row.form.checkin_actual" :min="0" :controls="false" size="small" /></template>
        </el-table-column>
        <el-table-column label="明日目标" width="130" align="center" label-class-name="meituan-header">
          <template #default="{row}"><el-input-number v-model="row.form.next_checkin_target" :min="0" :controls="false" size="small" /></template>
        </el-table-column>
      </el-table-column>

      <el-table-column label="好评引导 · 抖音" align="center" label-class-name="douyin-header">
        <el-table-column label="实际达成数" width="130" align="center" label-class-name="douyin-header">
          <template #default="{row}"><el-input-number v-model="row.form.douyin_review_actual" :min="0" :controls="false" size="small" /></template>
        </el-table-column>
        <el-table-column label="明日目标" width="130" align="center" label-class-name="douyin-header">
          <template #default="{row}"><el-input-number v-model="row.form.next_douyin_review_target" :min="0" :controls="false" size="small" /></template>
        </el-table-column>
      </el-table-column>

      <el-table-column label="好评引导 · 美团" align="center" label-class-name="meituan-header">
        <el-table-column label="实际达成数" width="130" align="center" label-class-name="meituan-header">
          <template #default="{row}"><el-input-number v-model="row.form.meituan_review_actual" :min="0" :controls="false" size="small" /></template>
        </el-table-column>
        <el-table-column label="明日目标" width="130" align="center" label-class-name="meituan-header">
          <template #default="{row}"><el-input-number v-model="row.form.next_meituan_review_target" :min="0" :controls="false" size="small" /></template>
        </el-table-column>
      </el-table-column>

      <el-table-column label="每日差评 · 美团" align="center" label-class-name="meituan-header">
        <el-table-column label="今日差评" width="112" align="center" label-class-name="meituan-header">
          <template #default="{row}"><el-input-number v-model="row.form.meituan_negative_reviews" :min="0" :controls="false" size="small" /></template>
        </el-table-column>
        <el-table-column label="差评原因" min-width="200" header-align="center" label-class-name="meituan-header">
          <template #default="{row}"><el-input v-model.trim="row.form.meituan_negative_reason" maxlength="300" size="small" placeholder="简要原因" /></template>
        </el-table-column>
      </el-table-column>

      <el-table-column label="每日差评 · 抖音" align="center" label-class-name="douyin-header">
        <el-table-column label="今日差评" width="112" align="center" label-class-name="douyin-header">
          <template #default="{row}"><el-input-number v-model="row.form.douyin_negative_reviews" :min="0" :controls="false" size="small" /></template>
        </el-table-column>
        <el-table-column label="差评原因" min-width="200" header-align="center" label-class-name="douyin-header">
          <template #default="{row}"><el-input v-model.trim="row.form.douyin_negative_reason" maxlength="300" size="small" placeholder="简要原因" /></template>
        </el-table-column>
      </el-table-column>

      <el-table-column fixed="right" label="操作" width="76" align="center">
        <template #default="{row}"><el-button link type="danger" size="small" @click="removeRow(row.storeId)">移除</el-button></template>
      </el-table-column>
    </el-table>

    <template #footer>
      <span class="footer-note">{{ rows.length ? `共 ${rows.length} 家门店，已修改 ${dirtyRows.length} 家` : '未选择门店' }}</span>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!dirtyRows.length" @click="submit">保存汇报</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import StoreRegionSelect from '@/components/StoreRegionSelect.vue'
import { getAllGroupBuyDailySummaries, saveGroupBuyDailySummary } from '@/api'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  stores: { type: Array, default: () => [] },
  storeIds: { type: Array, default: () => [] },
  initialDate: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue', 'saved'])

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const bizDate = ref(props.initialDate || today())
const selectedStoreIds = ref([])
const rows = ref([])
const loading = ref(false)
const saving = ref(false)
const tableHeight = 'calc(100vh - 300px)'

const zero = value => Number(value || 0)

// 星级是自动抓取的：本弹窗不展示也不让填；保存时沿用库里的值，新记录留空由抓取回填。
const formFields = ['lighting_actual', 'checkin_actual', 'douyin_review_actual', 'meituan_review_actual',
  'meituan_negative_reviews', 'meituan_negative_reason', 'douyin_negative_reviews', 'douyin_negative_reason',
  'next_lighting_target', 'next_checkin_target', 'next_douyin_review_target', 'next_meituan_review_target']

function toForm(record = {}) {
  const form = {}
  for (const key of formFields) form[key] = key.endsWith('_reason') ? (record[key] || '') : zero(record[key])
  return form
}
const snapshot = form => JSON.stringify(formFields.map(key => form[key]))
const rowChanged = row => snapshot(row.form) !== row.saved
const dirtyRows = computed(() => rows.value.filter(rowChanged))

async function loadRecords() {
  const ids = selectedStoreIds.value.map(Number).filter(Number.isFinite)
  if (!ids.length || !bizDate.value) { rows.value = []; return }
  loading.value = true
  try {
    // 一次取回所选门店当天的全部记录，避免逐店往返。
    const result = await getAllGroupBuyDailySummaries({ date_from: bizDate.value, date_to: bizDate.value })
    const byId = new Map((result.records || []).map(record => [Number(record.store_id), record]))
    rows.value = ids.map(id => {
      const store = props.stores.find(item => Number(item.id) === id) || { id, store_name: `门店 ${id}` }
      const record = byId.get(id) || {}
      const form = toForm(record)
      return {
        storeId: id,
        store_name: record.store_name || store.store_name || `门店 ${id}`,
        targets: record.targets || {},
        target_source_date: record.target_source_date || '',
        ratings: { meituan_rating: record.meituan_rating ?? null, douyin_rating: record.douyin_rating ?? null },
        form,
        saved: snapshot(form),
      }
    })
  } catch (error) { ElMessage.error(`读取汇报数据失败：${error.message}`) }
  finally { loading.value = false }
}

function removeRow(storeId) {
  selectedStoreIds.value = selectedStoreIds.value.filter(id => Number(id) !== Number(storeId))
  rows.value = rows.value.filter(row => row.storeId !== Number(storeId))
}

async function submit() {
  const dirty = dirtyRows.value
  if (!dirty.length) return ElMessage.info('没有需要保存的修改')
  saving.value = true
  try {
    await Promise.all(dirty.map(row => saveGroupBuyDailySummary({
      store_id: row.storeId,
      biz_date: bizDate.value,
      ...row.form,
      ...row.ratings,
    })))
    ElMessage.success(`已保存 ${dirty.length} 家门店的今日汇报`)
    emit('saved', { bizDate: bizDate.value, storeIds: dirty.map(row => row.storeId) })
    emit('update:modelValue', false)
  } catch (error) { ElMessage.error(`保存汇报失败：${error.message}`) }
  finally { saving.value = false }
}

// 打开时沿用页面已选门店；未选则默认全部门店，方便一次录完。
watch(() => props.modelValue, visible => {
  if (!visible) return
  bizDate.value = props.initialDate || today()
  const ids = props.storeIds.map(Number).filter(Number.isFinite)
  selectedStoreIds.value = ids.length ? [...new Set(ids)] : props.stores.map(store => Number(store.id))
  loadRecords()
})
</script>

<style scoped>
:deep(.daily-report-dialog){max-width:1560px;border-radius:16px;overflow:hidden;box-shadow:0 22px 60px rgba(22,46,72,.2)}:deep(.daily-report-dialog .el-dialog__header){padding:18px 22px 15px;margin-right:0;border-bottom:1px solid #e8eff1;background:linear-gradient(105deg,#f9fffd,#f6f9ff)}:deep(.daily-report-dialog .el-dialog__title){color:#24465e;font-size:17px;font-weight:750}:deep(.daily-report-dialog .el-dialog__headerbtn){top:18px;right:20px}:deep(.daily-report-dialog .el-dialog__body){padding:16px 22px 12px}:deep(.daily-report-dialog .el-dialog__footer){padding:13px 22px;border-top:1px solid #e8eff1;background:#fbfcfd}
.report-toolbar{display:flex;align-items:center;gap:9px;padding:11px 12px;margin-bottom:13px;border:1px solid #e6edf0;border-radius:10px;background:#fbfdfd;flex-wrap:wrap}.toolbar-label{color:#58718a;font-size:12px;font-weight:700}.report-tip{margin-left:auto;color:#8b9daf;font-size:11px}.report-table{width:100%;font-size:12px}.report-table :deep(.el-table__border-left-patch),.report-table :deep(.el-table__fixed-right-patch){display:none}.report-table :deep([class*="table-fixed-column--"].is-last-column),.report-table :deep([class*="table-fixed-column--"].is-first-column){box-shadow:none!important}.report-table :deep(.el-table-fixed-column--left.is-last-column){border-right:1px solid #dce7e9}.report-table :deep(.el-table__header-wrapper th){padding:10px 0;background:#f4f8f9;color:#506a83;font-size:11px;font-weight:700}.report-table :deep(.el-table__header-wrapper th.meituan-header){background:#fff4cf!important;color:#93611a!important}.report-table :deep(.el-table__header-wrapper th.douyin-header){background:#e7f1ff!important;color:#2766a8!important}.report-table :deep(.el-table__body tr:hover>td.el-table__cell){background:#f7fcfb}.report-table :deep(.el-table__cell){padding:7px 0}.report-table :deep(.el-table-fixed-column--left){background:#fff}.report-table :deep(.el-table__body tr:hover .el-table-fixed-column--left){background:#f7fcfb}.report-table :deep(.el-input-number){width:100px}.report-table :deep(.el-input-number .el-input__inner){text-align:left}.report-table :deep(.el-input__wrapper){box-shadow:0 0 0 1px #dce6ed inset}.report-table :deep(.el-input__wrapper:hover){box-shadow:0 0 0 1px #8ab9ae inset}.store-cell{display:flex;flex-direction:column;gap:4px;padding:1px 7px;line-height:1.35}.store-cell b{overflow:hidden;color:#26455c;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.store-cell small{color:#8d9bab;font-size:10px}.footer-note{float:left;color:#71879f;font-size:12px;line-height:32px}.footer-note:before{display:inline-block;width:6px;height:6px;margin-right:6px;border-radius:50%;background:#28a982;content:'';vertical-align:1px}@media(max-width:900px){:deep(.daily-report-dialog){width:96vw!important}:deep(.daily-report-dialog .el-dialog__body){padding:13px}.report-tip{width:100%;margin-left:0}.footer-note{display:none}}@media(max-width:640px){:deep(.daily-report-dialog){top:2vh!important}.report-toolbar{align-items:stretch;flex-direction:column}.report-toolbar :deep(.el-date-editor),.report-toolbar :deep(.store-region-select),.report-toolbar :deep(.el-button){width:100%!important}}
</style>
