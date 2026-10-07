<template>
  <main class="store-manager-page">
    <header class="manager-header"><div><h2>门店管理</h2><p>为门店分配在职店长，选择后自动保存。</p></div><el-button :loading="loading" @click="load">刷新列表</el-button></header>
    <section class="directory-card">
      <div class="manager-toolbar">
        <el-input v-model="keyword" clearable placeholder="搜索门店、店长、岗位或手机号" class="search-input" aria-label="搜索门店或店长" />
        <el-radio-group v-model="statusFilter" class="status-filter"><el-radio-button value="all">全部 {{ stores.length }}</el-radio-button><el-radio-button value="bound">已绑定 {{ boundCount }}</el-radio-button><el-radio-button value="pending">待分配 {{ unboundCount }}</el-radio-button></el-radio-group>
        <span class="result-count">共 {{ filteredStores.length }} 家</span>
      </div>
      <el-table v-loading="loading" :data="filteredStores" row-key="id" max-height="calc(100vh - 280px)" empty-text="没有符合当前条件的门店" class="manager-table">
        <el-table-column type="index" label="序号" width="65" />
        <el-table-column prop="store_name" label="门店" min-width="260" sortable />
        <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="row.manager_id ? 'success' : 'warning'" effect="light">{{ row.manager_id ? '已绑定' : '待分配' }}</el-tag></template></el-table-column>
        <el-table-column prop="manager_name" label="店长" width="110" sortable><template #default="{ row }">{{ row.manager_name || '未分配' }}</template></el-table-column>
        <el-table-column prop="manager_position" label="岗位" min-width="140"><template #default="{ row }">{{ row.manager_position || '—' }}</template></el-table-column>
        <el-table-column prop="manager_phone" label="手机号" width="145"><template #default="{ row }">{{ row.manager_phone || '—' }}</template></el-table-column>
        <el-table-column label="分配／变更店长" min-width="260" fixed="right"><template #default="{ row }"><el-select v-model="row.draft_manager_id" filterable clearable :disabled="row.saving" :loading="row.saving" placeholder="选择店长" style="width:100%" @change="save(row)"><el-option v-for="employee in candidates" :key="employee.id" :value="employee.id" :label="employeeLabel(employee)" /></el-select></template></el-table-column>
      </el-table>
      <footer class="directory-footer">可选择在职的店长层级员工；解除绑定不会修改员工归属、岗位或其他档案。</footer>
    </section>
  </main>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { getStaffStoreManagers, saveStaffStoreManager } from '@/api'

const stores = ref([])
const candidates = ref([])
const loading = ref(false)
const keyword = ref('')
const statusFilter = ref('all')
const boundCount = computed(() => stores.value.filter(item => item.manager_id).length)
const unboundCount = computed(() => Math.max(0, stores.value.length - boundCount.value))
const filteredStores = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  return stores.value.filter(item => {
    const statusMatches = statusFilter.value === 'all' || (statusFilter.value === 'bound' ? item.manager_id : !item.manager_id)
    return statusMatches && (!key || `${item.store_name} ${item.manager_name} ${item.manager_position} ${item.manager_phone || ''}`.toLowerCase().includes(key))
  })
})
function employeeLabel(employee) { return `${employee.name}${employee.position ? ` · ${employee.position}` : ' · 店长岗位'}${employee.job_level ? ` · ${employee.job_level}` : ''}${employee.store_name ? ` · ${employee.store_name}` : ''}` }
async function load() { loading.value = true; try { const data = await getStaffStoreManagers(); stores.value = (data.stores || []).map(item => ({ ...item, draft_manager_id: item.manager_id || null })); candidates.value = data.candidates || [] } catch (error) { ElMessage.error('门店管理加载失败：' + (error.message || '')) } finally { loading.value = false } }
async function save(row) { if (row.saving) return; row.saving = true; const previous = row.manager_id || null; try { const data = await saveStaffStoreManager(row.id, row.draft_manager_id || null); row.manager_id = data.manager?.id || null; row.manager_name = data.manager?.name || ''; row.manager_phone = data.manager?.phone || ''; row.manager_position = data.manager?.position || ''; ElMessage.success(row.manager_id ? `已绑定 ${row.manager_name} 为店长` : '已解除店长绑定') } catch (error) { row.draft_manager_id = previous; ElMessage.error('保存失败：' + (error.message || '')) } finally { row.saving = false } }
onMounted(load)
</script>

<style scoped>
.store-manager-page { padding:4px 0 24px;color:#263a57; }
.manager-header { display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px; }
.manager-header h2 { margin:0 0 6px;font-size:22px; }
.manager-header p { margin:0;color:#73839a;font-size:13px; }
.directory-card { padding:20px;border:1px solid #e3ebf4;border-radius:12px;background:#fff; }
.manager-toolbar { display:flex;align-items:center;flex-wrap:wrap;gap:16px;margin-bottom:18px; }
.search-input { width:320px;max-width:100%; }
.result-count { margin-left:auto;color:#73839a;font-size:13px; }
.manager-table :deep(.el-table__header th) { background:#f6f8fc;color:#526580; }
.manager-table :deep(.el-table__cell) { padding:12px 0; }
.directory-footer { margin-top:14px;color:#73839a;font-size:12px;line-height:1.6; }
@media(max-width:640px) { .directory-card { padding:12px; }.manager-toolbar { gap:12px; }.search-input { width:100%; }.status-filter { max-width:100%;overflow:auto; }.result-count { margin-left:0; } }
</style>
