<template>
  <div class="cost-page">
    <div class="page-intro">
      <div>
        <span class="eyebrow">STORE COST</span>
        <h2>门店成本</h2>
        <p>维护各门店的固定月度成本；工资请在“运营成本”中按月份记录。</p>
      </div>
      <el-tag type="info" effect="plain">当前仅开放维护，无审批流程</el-tag>
    </div>

    <el-card class="cost-card" shadow="never">
      <div class="toolbar">
        <el-select v-model="storeId" filterable placeholder="选择门店后维护成本" style="width:280px" @change="loadData">
          <el-option v-for="store in stores" :key="store.id" :label="store.store_name" :value="store.id" />
        </el-select>
        <span v-if="storeId" class="total-text">月度固定成本合计：<strong>¥{{ totalAmount.toFixed(2) }}</strong></span>
      </div>

      <template v-if="storeId">
        <div class="quick-add">
          <span>新增成本</span>
          <el-input v-model="form.cost_type" placeholder="项目，如房租、水电" maxlength="30" style="width:220px" />
          <el-input-number v-model="form.amount" :min="0" :precision="2" :controls="false" placeholder="金额" style="width:150px" />
          <el-button type="primary" :loading="saving" @click="addCost">保存</el-button>
        </div>
        <el-table :data="costs" v-loading="loading" stripe style="width:100%">
          <el-table-column prop="cost_type" label="成本项目" min-width="240">
            <template #default="{ row }"><el-input v-model="row.cost_type" /></template>
          </el-table-column>
          <el-table-column label="金额" width="220" align="right">
            <template #default="{ row }"><el-input-number v-model="row.amount" :min="0" :precision="2" :controls="false" style="width:150px" /></template>
          </el-table-column>
          <el-table-column prop="period" label="周期" width="120"><template #default="{ row }">{{ row.period || '月度' }}</template></el-table-column>
          <el-table-column label="操作" width="170" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="saveCost(row)">保存</el-button>
              <el-button link type="danger" @click="removeCost(row)">删除</el-button>
            </template>
          </el-table-column>
          <template #empty><el-empty description="该门店暂未录入固定成本" :image-size="72" /></template>
        </el-table>
      </template>
      <el-empty v-else description="请先选择需要维护的门店" :image-size="90" />
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { createFixedCost, deleteFixedCost, getFixedCosts, getStores, updateFixedCost } from '@/api'

const stores = ref([])
const storeId = ref(null)
const costs = ref([])
const loading = ref(false)
const saving = ref(false)
const form = reactive({ cost_type: '', amount: undefined })
const totalAmount = computed(() => costs.value.reduce((total, item) => total + (Number(item.amount) || 0), 0))

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
    const data = await getFixedCosts(storeId.value)
    costs.value = data.costs || []
  } catch (error) { ElMessage.error(error.message || '成本加载失败') } finally { loading.value = false }
}

async function addCost() {
  if (!form.cost_type.trim()) return ElMessage.warning('请填写成本项目')
  if (form.amount === undefined || form.amount === null) return ElMessage.warning('请填写金额')
  saving.value = true
  try {
    await createFixedCost(storeId.value, { cost_type: form.cost_type, amount: form.amount, period: '月度' })
    form.cost_type = ''
    form.amount = undefined
    await loadData()
    ElMessage.success('已保存')
  } catch (error) { ElMessage.error(error.message || '保存失败') } finally { saving.value = false }
}

async function saveCost(row) {
  if (!row.cost_type?.trim()) return ElMessage.warning('成本项目不能为空')
  try {
    await updateFixedCost(row.id, { cost_type: row.cost_type, amount: row.amount })
    ElMessage.success('已更新')
    await loadData()
  } catch (error) { ElMessage.error(error.message || '更新失败') }
}

async function removeCost(row) {
  try { await ElMessageBox.confirm(`确定删除“${row.cost_type}”吗？`, '删除成本', { type: 'warning' }) } catch { return }
  try { await deleteFixedCost(row.id); await loadData(); ElMessage.success('已删除') } catch (error) { ElMessage.error(error.message || '删除失败') }
}
</script>

<style scoped>
.cost-page { max-width: 1280px; margin: 0 auto; }
.page-intro { display:flex; align-items:center; justify-content:space-between; gap:24px; padding:6px 4px 18px; }
.eyebrow { color:#5d88d7; font-size:11px; font-weight:700; letter-spacing:1.4px; }
h2 { margin:4px 0 6px; color:#1e3658; font-size:22px; }
p { margin:0; color:#8390a1; font-size:13px; }
.cost-card { border-radius:14px; border:1px solid #e7edf6; }
.toolbar, .quick-add { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.toolbar { padding-bottom:18px; border-bottom:1px solid #edf1f6; margin-bottom:18px; }
.total-text { margin-left:auto; color:#718096; font-size:13px; }
.total-text strong { color:#e67e22; font-size:18px; }
.quick-add { padding:14px 16px; margin-bottom:16px; background:#f6f9fe; border:1px dashed #bcd0ef; border-radius:10px; color:#38577f; font-size:13px; font-weight:600; }
@media (max-width: 720px) { .page-intro { align-items:flex-start; flex-direction:column; gap:10px; } .total-text { margin-left:0; } }
</style>
