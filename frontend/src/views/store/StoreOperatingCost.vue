<template>
  <main class="operating-page">
    <section class="page-hero">
      <div><span class="eyebrow">MONTHLY OPERATING COSTS</span><h2>运营成本</h2><p>按门店、月份录入工资、房租/物业和水电费。三项数据可直接作为月经营看板的日均沉淀成本来源。</p></div>
      <el-tag type="success" effect="light">月度台账</el-tag>
    </section>

    <section class="entry-card">
      <header><div><span class="section-kicker">COST ENTRY</span><h3>录入月度关键费用</h3><p>选择相同门店和月份再次保存，会更新对应费用，不会重复新增。</p></div></header>
      <div class="entry-filter"><label><span>门店</span><StoreRegionSelect v-model="storeId" :stores="stores" placeholder="选择门店" @update:model-value="loadData" /></label><label><span>费用月份</span><el-date-picker v-model="month" :clearable="false" type="month" value-format="YYYY-MM" placeholder="选择月份" @change="syncAmounts" /></label></div>
      <div class="cost-entry-grid">
        <article v-for="cost in costFields" :key="cost.key" :class="`cost-card ${cost.tone}`"><div class="cost-card-head"><span>{{ cost.label }}</span><small>{{ cost.hint }}</small></div><el-input-number v-model="amounts[cost.key]" :min="0" :precision="2" :controls="false" :disabled="!storeId" placeholder="请输入金额" /><p>{{ cost.note }}</p></article>
      </div>
      <footer class="entry-footer"><span>未填写的费用不会覆盖已有记录；填 0 可明确记录为零。</span><el-button type="primary" :disabled="!storeId || !month" :loading="saving" @click="saveCosts">保存本月关键费用</el-button></footer>
    </section>

    <section class="history-card">
      <header class="history-head"><div><span class="section-kicker">MONTHLY LEDGER</span><h3>月度费用记录</h3></div><strong v-if="storeId">累计 {{ money(grandTotal) }}</strong></header>
      <el-table :data="monthlyRows" v-loading="loading" stripe class="cost-table">
        <el-table-column label="月份" min-width="150"><template #default="{ row }">{{ row.month }}</template></el-table-column>
        <el-table-column label="工资" min-width="170" align="right"><template #default="{ row }"><span class="wage-value">{{ money(row.wage) }}</span></template></el-table-column>
        <el-table-column label="房租 / 物业" min-width="170" align="right"><template #default="{ row }"><span class="rent-value">{{ money(row.rent) }}</span></template></el-table-column>
        <el-table-column label="水电费" min-width="160" align="right"><template #default="{ row }"><span class="utility-value">{{ money(row.utilities) }}</span></template></el-table-column>
        <el-table-column label="三项合计" min-width="175" align="right"><template #default="{ row }"><b class="total-value">{{ money(row.total) }}</b></template></el-table-column>
        <el-table-column label="操作" width="150" fixed="right"><template #default="{ row }"><el-button type="primary" link @click="editMonth(row)">编辑</el-button><el-button type="danger" link @click="removeMonth(row)">删除</el-button></template></el-table-column>
        <template #empty><el-empty :description="storeId ? '该门店暂未录入关键费用' : '请选择门店查看运营成本记录'" :image-size="84" /></template>
      </el-table>
    </section>
  </main>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { deleteOperatingCost, getOperatingCosts, getStores, saveMonthlyOperatingCost } from '@/api'
import StoreRegionSelect from '@/components/StoreRegionSelect.vue'

const costFields = [
  { key: 'wage', item: '月度工资', label: '工资', hint: '人工及福利', note: '店长、员工工资及社保等月度人工成本', tone: 'wage' },
  { key: 'rent', item: '月度房租及物业', label: '房租 / 物业', hint: '场地成本', note: '房租、物业管理费等固定场地支出', tone: 'rent' },
  { key: 'utilities', item: '月度水电费', label: '水电费', hint: '能耗成本', note: '水费、电费、燃气等门店能耗支出', tone: 'utilities' },
]
const stores = ref([])
const storeId = ref(null)
const month = ref(new Date().toISOString().slice(0, 7))
const costs = ref([])
const loading = ref(false)
const saving = ref(false)
const amounts = reactive({ wage: undefined, rent: undefined, utilities: undefined })

const monthlyRows = computed(() => {
  const grouped = new Map()
  costs.value.forEach(cost => {
    const key = String(cost.date || '').slice(0, 7)
    if (!key) return
    if (!grouped.has(key)) grouped.set(key, { month: key, wage: undefined, rent: undefined, utilities: undefined, ids: [] })
    const row = grouped.get(key)
    const field = costFields.find(item => item.item === cost.item)
    if (!field) return
    row[field.key] = Number(cost.amount || 0)
    row.ids.push(cost.id)
  })
  return [...grouped.values()].map(row => ({ ...row, total: ['wage', 'rent', 'utilities'].reduce((sum, key) => sum + Number(row[key] || 0), 0) })).sort((a, b) => b.month.localeCompare(a.month))
})
const grandTotal = computed(() => monthlyRows.value.reduce((sum, row) => sum + Number(row.total || 0), 0))

onMounted(async () => { try { const data = await getStores({ page: 1, page_size: 200 }); stores.value = data.stores || [] } catch { ElMessage.error('门店列表加载失败') } })
watch(month, syncAmounts)

function money(value) { return `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }
function syncAmounts() { const row = monthlyRows.value.find(item => item.month === month.value); costFields.forEach(cost => { amounts[cost.key] = row?.[cost.key] }) }
async function loadData() { if (!storeId.value) { costs.value = []; return }; loading.value = true; try { const data = await getOperatingCosts(storeId.value); costs.value = data.costs || []; syncAmounts() } catch (error) { ElMessage.error(error.message || '运营成本记录加载失败') } finally { loading.value = false } }
async function saveCosts() { const filledCosts = costFields.filter(cost => amounts[cost.key] !== undefined && amounts[cost.key] !== null); if (!filledCosts.length) return ElMessage.warning('请至少填写一项费用'); saving.value = true; try { await Promise.all(filledCosts.map(cost => saveMonthlyOperatingCost(storeId.value, { month: month.value, item: cost.item, amount: amounts[cost.key] }))); await loadData(); ElMessage.success('月度关键费用已保存') } catch (error) { ElMessage.error(error.message || '保存失败') } finally { saving.value = false } }
function editMonth(row) { month.value = row.month; costFields.forEach(cost => { amounts[cost.key] = row[cost.key] }); window.scrollTo({ top: 0, behavior: 'smooth' }) }
async function removeMonth(row) { try { await ElMessageBox.confirm(`确定删除 ${row.month} 的工资、房租/物业和水电记录吗？`, '删除月度记录', { type: 'warning' }) } catch { return } try { await Promise.all(row.ids.map(id => deleteOperatingCost(id))); await loadData(); ElMessage.success('该月关键费用已删除') } catch (error) { ElMessage.error(error.message || '删除失败') } }
</script>

<style scoped>
.operating-page { max-width:1280px; margin:0 auto; }.page-hero { display:flex; align-items:center; justify-content:space-between; gap:24px; padding:23px 28px; border-radius:16px; background:linear-gradient(120deg,#12476c,#1c908b 64%,#55ba9e); color:#fff; }.eyebrow,.section-kicker { display:block; font-size:11px; font-weight:800; letter-spacing:1.5px; }.eyebrow { color:#b9f1e5; }.page-hero h2 { margin:6px 0; font-size:25px; }.page-hero p { margin:0; color:#d7f6ef; font-size:13px; }.entry-card,.history-card { margin-top:16px; padding:21px; border:1px solid #e1e9ef; border-radius:13px; background:#fff; box-shadow:0 7px 20px rgba(31,75,95,.05); }.entry-card header h3,.history-card h3 { margin:5px 0; color:#294761; font-size:19px; }.entry-card header p { margin:0; color:#8998a8; font-size:12px; }.section-kicker { color:#4d9b91; }.entry-filter { display:grid; grid-template-columns:minmax(240px,1.2fr) minmax(160px,.7fr); gap:14px; margin:21px 0 14px; }.entry-filter label { display:flex; flex-direction:column; gap:7px; color:#61748b; font-size:13px; font-weight:650; }.entry-filter :deep(.el-select),.entry-filter :deep(.el-date-editor) { width:100%; }.cost-entry-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:13px; }.cost-card { min-height:160px; padding:17px; border:1px solid #e4ebf1; border-top:3px solid #6f9eea; border-radius:10px; background:#fbfdff; }.cost-card.rent { border-top-color:#e2a34b; }.cost-card.utilities { border-top-color:#43ae9a; }.cost-card-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; margin-bottom:16px; }.cost-card-head span { color:#365270; font-size:15px; font-weight:750; }.cost-card-head small { color:#8b9aac; font-size:11px; }.cost-card :deep(.el-input-number) { width:100%; }.cost-card p { margin:13px 0 0; color:#8796a7; font-size:12px; line-height:1.55; }.entry-footer { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-top:17px; padding-top:16px; border-top:1px solid #edf1f5; color:#8493a5; font-size:12px; }.history-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:17px; }.history-head h3 { margin-bottom:0; }.history-head strong { color:#e0782f; font-size:17px; }.cost-table { overflow:hidden; border:1px solid #e5ebf2; border-radius:8px; }.wage-value { color:#5c82ca; font-weight:700; }.rent-value { color:#cf8730; font-weight:700; }.utility-value { color:#259b85; font-weight:700; }.total-value { color:#2b496b; }@media (max-width:800px) { .page-hero,.entry-footer { align-items:flex-start; flex-direction:column; }.entry-filter,.cost-entry-grid { grid-template-columns:1fr; }.entry-footer button { width:100%; } }
</style>
