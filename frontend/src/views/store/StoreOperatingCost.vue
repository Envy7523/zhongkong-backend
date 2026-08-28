<template>
  <div class="operating-page">
    <div class="page-intro">
      <div>
        <span class="eyebrow">MONTHLY WAGE</span>
        <h2>运营成本</h2>
        <p>先按门店、月份记录工资；同一门店同一个月保存时会直接更新，不会重复新增。</p>
      </div>
      <el-tag type="success" effect="light">可直接编辑</el-tag>
    </div>

    <el-card class="wage-card" shadow="never">
      <div class="wage-form">
        <div class="form-block">
          <span>门店</span>
          <el-select v-model="storeId" filterable placeholder="选择门店" style="width:280px" @change="loadData">
            <el-option v-for="store in stores" :key="store.id" :label="store.store_name" :value="store.id" />
          </el-select>
        </div>
        <div class="form-block">
          <span>工资月份</span>
          <el-date-picker v-model="month" type="month" value-format="YYYY-MM" placeholder="选择月份" style="width:160px" @change="syncWageAmount" />
        </div>
        <div class="form-block">
          <span>工资金额</span>
          <el-input-number v-model="wageAmount" :min="0" :precision="2" :controls="false" placeholder="请输入金额" style="width:180px" />
        </div>
        <el-button type="primary" :disabled="!storeId || !month" :loading="saving" @click="saveWage">保存本月工资</el-button>
      </div>
      <div class="form-tip">保存后，可在下方查看每月工资记录；需要更正时，选择相同门店和月份后重新保存即可。</div>
    </el-card>

    <el-card class="history-card" shadow="never">
      <div class="history-head">
        <span>工资记录</span>
        <strong v-if="storeId">累计 ¥{{ wageTotal.toFixed(2) }}</strong>
      </div>
      <el-table :data="wageRows" v-loading="loading" stripe style="width:100%">
        <el-table-column label="月份" min-width="220"><template #default="{ row }">{{ formatMonth(row.date) }}</template></el-table-column>
        <el-table-column label="工资金额" min-width="200" align="right"><template #default="{ row }"><span class="wage-value">¥{{ Number(row.amount || 0).toFixed(2) }}</span></template></el-table-column>
        <el-table-column label="操作" width="120" align="center"><template #default="{ row }"><el-button link type="danger" @click="removeWage(row)">删除</el-button></template></el-table-column>
        <template #empty><el-empty :description="storeId ? '该门店暂未录入工资' : '请选择门店查看工资记录'" :image-size="80" /></template>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { deleteOperatingCost, getOperatingCosts, getStores, saveMonthlyWage } from '@/api'

const stores = ref([])
const storeId = ref(null)
const month = ref(new Date().toISOString().slice(0, 7))
const wageAmount = ref(undefined)
const costs = ref([])
const loading = ref(false)
const saving = ref(false)
const wageRows = computed(() => costs.value.filter(item => item.item === '月度工资'))
const wageTotal = computed(() => wageRows.value.reduce((total, item) => total + (Number(item.amount) || 0), 0))

onMounted(async () => {
  try {
    const data = await getStores({ page: 1, page_size: 200 })
    stores.value = data.stores || []
  } catch { ElMessage.error('门店列表加载失败') }
})

async function loadData() {
  if (!storeId.value) return
  loading.value = true
  try {
    const data = await getOperatingCosts(storeId.value)
    costs.value = data.costs || []
    syncWageAmount()
  } catch (error) { ElMessage.error(error.message || '工资记录加载失败') } finally { loading.value = false }
}

function syncWageAmount() {
  const current = wageRows.value.find(item => String(item.date || '').startsWith(month.value))
  wageAmount.value = current ? Number(current.amount) : undefined
}

async function saveWage() {
  if (wageAmount.value === undefined || wageAmount.value === null) return ElMessage.warning('请填写工资金额')
  saving.value = true
  try {
    await saveMonthlyWage(storeId.value, { month: month.value, amount: wageAmount.value })
    await loadData()
    ElMessage.success('本月工资已保存')
  } catch (error) { ElMessage.error(error.message || '保存失败') } finally { saving.value = false }
}

async function removeWage(row) {
  try { await ElMessageBox.confirm(`确定删除 ${formatMonth(row.date)} 的工资记录吗？`, '删除工资', { type: 'warning' }) } catch { return }
  try { await deleteOperatingCost(row.id); await loadData(); ElMessage.success('已删除') } catch (error) { ElMessage.error(error.message || '删除失败') }
}

function formatMonth(value) { return String(value || '').slice(0, 7) || '—' }
</script>

<style scoped>
.operating-page { max-width:1280px; margin:0 auto; }
.page-intro { display:flex; align-items:center; justify-content:space-between; gap:24px; padding:6px 4px 18px; }
.eyebrow { color:#44a580; font-size:11px; font-weight:700; letter-spacing:1.4px; }
h2 { margin:4px 0 6px; color:#1e3658; font-size:22px; }
p { margin:0; color:#8390a1; font-size:13px; }
.wage-card, .history-card { border:1px solid #e7edf6; border-radius:14px; margin-bottom:16px; }
.wage-form { display:flex; align-items:end; gap:16px; flex-wrap:wrap; }
.form-block { display:flex; flex-direction:column; gap:8px; color:#61708a; font-size:13px; font-weight:600; }
.form-tip { margin-top:16px; padding-top:14px; border-top:1px solid #eef2f7; color:#8b98a9; font-size:12px; }
.history-head { display:flex; justify-content:space-between; align-items:center; padding-bottom:16px; color:#243b5a; font-size:15px; font-weight:700; }
.history-head strong { color:#e67e22; font-size:17px; }
.wage-value { color:#e67e22; font-weight:700; }
@media (max-width: 720px) { .page-intro { align-items:flex-start; flex-direction:column; gap:10px; } }
</style>
