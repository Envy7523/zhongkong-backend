<template>
  <div class="store-manager-page">
    <section class="manager-hero">
      <div>
        <span class="eyebrow">STORE MANAGEMENT</span>
        <h2>门店管理</h2>
        <p>为每间门店绑定一位在职店长。员工档案中的归属店长会自动读取此处的绑定结果。</p>
      </div>
      <el-tag type="info" effect="plain">{{ boundCount }} / {{ stores.length }} 已绑定</el-tag>
    </section>

    <section class="card-compact">
      <div class="manager-toolbar">
        <el-input v-model="keyword" clearable placeholder="搜索门店或店长" style="max-width:300px" />
        <span>店长绑定按员工档案保存；解除绑定不会修改员工资料。</span>
      </div>

      <el-table :data="filteredStores" v-loading="loading" stripe>
        <el-table-column prop="store_name" label="门店" min-width="240" />
        <el-table-column label="当前店长" min-width="180">
          <template #default="{ row }">
            <div v-if="row.manager_name" class="manager-person">
              <b>{{ row.manager_name }}</b><small>{{ row.manager_position || '未填写岗位' }}{{ row.manager_phone ? ` · ${row.manager_phone}` : '' }}</small>
            </div>
            <span v-else class="unbound">暂未绑定</span>
          </template>
        </el-table-column>
        <el-table-column label="分配店长" min-width="320">
          <template #default="{ row }">
            <el-select v-model="row.draft_manager_id" filterable clearable placeholder="选择在职员工" style="width:100%" @change="save(row)">
              <el-option v-for="employee in candidates" :key="employee.id" :value="employee.id" :label="employeeLabel(employee)">
                <div class="employee-option"><b>{{ employee.name }}</b><span>{{ employee.position || '未填写岗位' }}{{ employee.store_name ? ` · ${employee.store_name}` : '' }}</span></div>
              </el-option>
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="106">
          <template #default="{ row }"><el-tag :type="row.manager_id ? 'success' : 'info'" size="small">{{ row.manager_id ? '已绑定' : '待分配' }}</el-tag></template>
        </el-table-column>
      </el-table>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { getStaffStoreManagers, saveStaffStoreManager } from '@/api'

const stores = ref([])
const candidates = ref([])
const loading = ref(false)
const keyword = ref('')
const boundCount = computed(() => stores.value.filter(item => item.manager_id).length)
const filteredStores = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  if (!key) return stores.value
  return stores.value.filter(item => `${item.store_name} ${item.manager_name}`.toLowerCase().includes(key))
})

function employeeLabel(employee) {
  return `${employee.name}${employee.position ? ` · ${employee.position}` : ''}${employee.store_name ? ` · ${employee.store_name}` : ''}`
}

async function load() {
  loading.value = true
  try {
    const data = await getStaffStoreManagers()
    stores.value = (data.stores || []).map(item => ({ ...item, draft_manager_id: item.manager_id || null }))
    candidates.value = data.candidates || []
  } catch (error) {
    ElMessage.error('门店管理加载失败：' + (error.message || ''))
  } finally { loading.value = false }
}

async function save(row) {
  const previous = row.manager_id || null
  try {
    const data = await saveStaffStoreManager(row.id, row.draft_manager_id || null)
    row.manager_id = data.manager?.id || null
    row.manager_name = data.manager?.name || ''
    row.manager_phone = data.manager?.phone || ''
    row.manager_position = data.manager?.position || ''
    ElMessage.success(row.manager_id ? '店长绑定已更新' : '已解除店长绑定')
  } catch (error) {
    row.draft_manager_id = previous
    ElMessage.error('保存失败：' + (error.message || ''))
  }
}

onMounted(load)
</script>

<style scoped>
.store-manager-page { display:grid; gap:16px; }
.manager-hero { display:flex; align-items:flex-start; justify-content:space-between; gap:18px; padding:18px 20px; border:1px solid #dbe7f7; border-radius:12px; background:linear-gradient(135deg,#f8fbff,#fff); }
.manager-hero h2 { margin:4px 0 6px; font-size:20px; color:#173b6c; }
.manager-hero p { margin:0; color:#71839e; font-size:13px; }
.manager-toolbar { display:flex; justify-content:space-between; align-items:center; gap:14px; margin-bottom:14px; color:#8492a6; font-size:12px; }
.manager-person { display:grid; gap:3px; }.manager-person b { color:#243b5a; }.manager-person small { color:#8291a7; }.unbound { color:#a0acbc; }
.employee-option { display:flex; justify-content:space-between; gap:12px; }.employee-option span { color:#8492a6; font-size:12px; }
@media (max-width: 760px) { .manager-hero,.manager-toolbar { align-items:flex-start; flex-direction:column; } }
</style>
