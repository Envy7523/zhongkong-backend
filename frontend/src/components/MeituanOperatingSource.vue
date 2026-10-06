<template>
  <section class="operating-source" v-loading="loading">
    <header><div><h3>美团外卖营业表明细</h3><p>显示平台原表的全部 15 个字段。金额和订单空值显示为 —；单店单日转化率保留平台原值。</p></div><el-button @click="load">刷新明细</el-button></header>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <p v-if="lastRun" class="run-status">机器人业务日：{{ lastRun.business_date }} · {{ lastRun.status === 'completed' ? '已完成导入和逐字段核验' : '导入尚未核验通过' }} · 核验 {{ lastRun.verified_row_count }} 条 · 批次 {{ lastRun.batch_id || '—' }}。下表同时保留其他人工导入批次。</p>
    <el-table :data="rows" border empty-text="当前范围尚未导入美团外卖营业表" max-height="520">
      <el-table-column v-for="field in fields" :key="field" :label="field" :prop="field" :fixed="field === '日期' || field === '门店名称' ? 'left' : false" :min-width="field === '门店名称' ? 230 : 118" :align="numericFields.includes(field) ? 'right' : 'left'" header-align="center">
        <template #default="{ row }">{{ format(row[field], field) }}</template>
      </el-table-column>
      <el-table-column label="门店归属" min-width="120"><template #default="{ row }"><el-tag :type="row.match_status === 'matched' ? 'success' : 'danger'">{{ row.match_status === 'matched' ? '已关联' : '未关联' }}</el-tag></template></el-table-column>
      <el-table-column label="导入批次" prop="batch_id" min-width="100" />
    </el-table>
    <footer><span>共 {{ total }} 条店日记录</span><el-pagination v-model:current-page="page" :page-size="100" :total="total" layout="prev, pager, next" @current-change="load" /></footer>
  </section>
</template>
<script setup>
import { ref, watch } from 'vue'
import { getMeituanOperatingSource } from '@/api'
const props = defineProps({ params: { type: Object, required: true } })
const fields = ref([]), rows = ref([]), total = ref(0), page = ref(1), loading = ref(false), error = ref(''), lastRun = ref(null)
const numericFields = ['营业收入', '优惠前总额', '有效订单', '曝光人数', '入店人数', '入店转化率', '下单转化率', '下单人数', '综合体验分']
let sequence = 0
function format(value, field) {
  if (value == null || ['', '--', '—', '-'].includes(String(value).trim())) return '—'
  if (field.endsWith('转化率')) return String(value).endsWith('%') ? value : `${(Number(value) * 100).toFixed(2)}%`
  if (['营业收入', '优惠前总额'].includes(field)) return Number(String(value).replaceAll(',', '')).toFixed(2)
  if (field === '综合体验分') return Number(value).toFixed(1)
  return value
}
async function load() {
  const current = ++sequence
  loading.value = true; error.value = ''
  try {
    const result = await getMeituanOperatingSource({ ...props.params, page: page.value })
    if (current !== sequence) return
    fields.value = result.fields; rows.value = result.rows; total.value = result.total; lastRun.value = result.last_run
  } catch (e) { if (current === sequence) { error.value = e.message; rows.value = []; total.value = 0 } }
  finally { if (current === sequence) loading.value = false }
}
watch(() => props.params, () => { page.value = 1; load() }, { deep: true, immediate: true })
</script>
<style scoped>
.operating-source{margin:20px 0;padding:20px;background:var(--el-bg-color);border:1px solid var(--el-border-color-light);border-radius:12px}.operating-source header,.operating-source footer{display:flex;align-items:center;justify-content:space-between;gap:16px}.operating-source h3{margin:0 0 8px}.operating-source p,.operating-source footer{font-size:13px;color:var(--el-text-color-secondary)}.operating-source footer{margin-top:12px}.operating-source .el-alert{margin-bottom:12px}
</style>
