<template>
  <main class="platform-page">
    <section class="platform-hero">
      <div><span class="eyebrow">PLATFORM ID DIRECTORY</span><h2>第三方平台</h2><p>门店与外卖、团购平台的 ID 档案。平台数据导入后，系统可按“平台名称 + 平台 ID”准确匹配到本地门店。</p></div>
      <div class="hero-metrics"><span><b>{{ stores.length }}</b><small>门店总数</small></span><span><b>{{ onlineCount }}</b><small>已上线账号</small></span><span><b>{{ fullCoverageCount }}</b><small>五平台齐全</small></span></div>
    </section>

    <section class="platform-card">
      <header class="directory-header"><div><span class="section-kicker">BINDING DIRECTORY</span><h3>门店平台档案</h3><p>从列表选择门店编辑。已上线的平台必须保存平台 ID；未上线平台无需填写。</p></div><div class="header-guide"><b>5</b><span>个标准平台</span></div></header>
      <div class="filter-panel"><label><span>门店名称</span><el-input v-model="keyword" clearable placeholder="搜索门店名称" /></label><label><span>区域 / 门店</span><StoreRegionSelect v-model="selectedStoreId" :stores="stores" clearable placeholder="按区域选择门店" /></label><label><span>建号状态</span><el-select v-model="statusFilter" clearable placeholder="全部状态"><el-option v-for="item in statusOptions" :key="item" :label="item" :value="item" /></el-select></label><div class="filter-actions"><el-button plain @click="resetFilters">重置</el-button><span>显示 {{ filteredStores.length }} 家</span></div></div>
      <el-table :data="pagedStores" v-loading="loading" stripe class="platform-table" empty-text="暂无门店档案">
        <el-table-column prop="store_name" label="门店名称" min-width="230" fixed="left" show-overflow-tooltip />
        <el-table-column label="外卖建号状态" min-width="350"><template #default="{ row }"><div class="platform-strip"><span v-for="platform in deliveryPlatforms" :key="platform.name" :class="statusClass(recordFor(row.id, platform.name))"><i></i>{{ platform.short }}<small>{{ statusText(recordFor(row.id, platform.name)) }}</small></span></div></template></el-table-column>
        <el-table-column label="团购建号状态" min-width="260"><template #default="{ row }"><div class="platform-strip"><span v-for="platform in groupPlatforms" :key="platform.name" :class="statusClass(recordFor(row.id, platform.name))"><i></i>{{ platform.short }}<small>{{ statusText(recordFor(row.id, platform.name)) }}</small></span></div></template></el-table-column>
        <el-table-column label="覆盖率" width="115" align="center"><template #default="{ row }"><span class="coverage" :class="{ complete: onlineForStore(row.id) === 5 }">{{ onlineForStore(row.id) }} / 5</span></template></el-table-column>
        <el-table-column label="操作" width="110" fixed="right" align="center"><template #default="{ row }"><el-button type="primary" link @click="openEditor(row)">编辑</el-button></template></el-table-column>
      </el-table>
      <el-pagination v-if="filteredStores.length > pageSize" v-model:current-page="page" :page-size="pageSize" :total="filteredStores.length" layout="total, prev, pager, next" class="pagination" />
    </section>

    <el-dialog v-model="editorVisible" :title="`平台档案 · ${editingStore?.store_name || ''}`" width="min(980px, calc(100vw - 28px))" destroy-on-close class="platform-dialog">
      <div class="dialog-intro"><b>平台 ID 是数据匹配唯一键</b><span>平台处于“已上线”时需填写 ID。上线日期如暂不清楚可留空，后续可继续补充。</span></div>
      <el-table :data="allPlatforms" class="editor-table" border>
        <el-table-column label="平台" width="150"><template #default="{ row }"><b>{{ row.name }}</b><small class="platform-type">{{ row.group === 'delivery' ? '外卖平台' : '团购平台' }}</small></template></el-table-column>
        <el-table-column label="建号状态" width="175"><template #default="{ row }"><el-select v-model="drafts[row.name].setup_status"><el-option v-for="item in statusOptions" :key="item" :label="item" :value="item" /></el-select></template></el-table-column>
        <el-table-column label="上线时间" width="190"><template #default="{ row }"><el-date-picker v-model="drafts[row.name].online_date" :clearable="false" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" :disabled="drafts[row.name].setup_status !== '已上线'" /></template></el-table-column>
        <el-table-column label="平台 ID" min-width="300"><template #default="{ row }"><el-input v-model="drafts[row.name].platform_id" placeholder="请输入平台后台 ID" :disabled="drafts[row.name].setup_status !== '已上线'" /></template></el-table-column>
      </el-table>
      <template #footer><el-button @click="editorVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="savePlatforms">保存平台档案</el-button></template>
    </el-dialog>
  </main>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { getStorePlatforms, getStores, saveStorePlatforms } from '@/api'
import StoreRegionSelect from '@/components/StoreRegionSelect.vue'

const deliveryPlatforms = [{ name: '美团外卖', short: '美团' }, { name: '淘宝闪购', short: '淘宝' }, { name: '京东外卖', short: '京东' }]
const groupPlatforms = [{ name: '美团团购', short: '美团' }, { name: '抖音团购', short: '抖音' }]
const allPlatforms = [...deliveryPlatforms.map(item => ({ ...item, group: 'delivery' })), ...groupPlatforms.map(item => ({ ...item, group: 'group' }))]
const statusOptions = ['已上线', '未上线', '筹备中']
const stores = ref([]), platformRows = ref([]), loading = ref(false), saving = ref(false), keyword = ref(''), selectedStoreId = ref(null), statusFilter = ref(''), page = ref(1), editorVisible = ref(false), editingStore = ref(null)
const pageSize = 10
const drafts = reactive({})
const platformMap = computed(() => new Map(platformRows.value.map(row => [`${row.store_id}-${row.platform_name}`, row])))
const filteredStores = computed(() => stores.value.filter(store => (!selectedStoreId.value || Number(store.id) === Number(selectedStoreId.value)) && (!keyword.value || store.store_name.includes(keyword.value.trim())) && (!statusFilter.value || allPlatforms.some(platform => recordFor(store.id, platform.name)?.setup_status === statusFilter.value))))
const pagedStores = computed(() => filteredStores.value.slice((page.value - 1) * pageSize, page.value * pageSize))
const onlineCount = computed(() => platformRows.value.filter(row => row.setup_status === '已上线').length)
const fullCoverageCount = computed(() => stores.value.filter(store => onlineForStore(store.id) === 5).length)
function recordFor(storeId, platformName) { return platformMap.value.get(`${storeId}-${platformName}`) || null }
function statusText(record) { return record?.setup_status === '已上线' ? '已上线' : record?.setup_status === '筹备中' ? '筹备中' : '未上线' }
function statusClass(record) { return record?.setup_status === '已上线' ? 'online' : record?.setup_status === '筹备中' ? 'pending' : 'offline' }
function onlineForStore(storeId) { return allPlatforms.filter(platform => recordFor(storeId, platform.name)?.setup_status === '已上线').length }
function resetFilters() { keyword.value = ''; selectedStoreId.value = null; statusFilter.value = ''; page.value = 1 }
function emptyDraft(platformName) { const record = recordFor(editingStore.value?.id, platformName); return { platform_name: platformName, setup_status: record?.setup_status || '未上线', online_date: record?.online_date || null, platform_id: record?.platform_id || '' } }
function openEditor(store) { editingStore.value = store; allPlatforms.forEach(platform => { drafts[platform.name] = emptyDraft(platform.name) }); editorVisible.value = true }
async function loadData() { loading.value = true; try { const [storeData, platformData] = await Promise.all([getStores({ page: 1, page_size: 500 }), getStorePlatforms()]); stores.value = storeData.stores || []; platformRows.value = platformData.platforms || [] } catch (error) { ElMessage.error(error.message || '平台档案加载失败') } finally { loading.value = false } }
async function savePlatforms() { if (!editingStore.value) return; const payload = allPlatforms.map(platform => ({ ...drafts[platform.name], online_date: drafts[platform.name].setup_status === '已上线' ? drafts[platform.name].online_date : null, platform_id: drafts[platform.name].setup_status === '已上线' ? drafts[platform.name].platform_id : '' })); const missingId = payload.find(row => row.setup_status === '已上线' && !String(row.platform_id || '').trim()); if (missingId) return ElMessage.warning(`请填写${missingId.platform_name}的平台 ID`); saving.value = true; try { await saveStorePlatforms(editingStore.value.id, payload); await loadData(); editorVisible.value = false; ElMessage.success('平台档案已保存') } catch (error) { ElMessage.error(error.message || '保存失败') } finally { saving.value = false } }
watch([keyword, selectedStoreId, statusFilter], () => { page.value = 1 })
onMounted(loadData)
</script>

<style scoped>
.platform-page { max-width:1440px; margin:0 auto; }.platform-hero { display:flex; align-items:center; justify-content:space-between; gap:24px; padding:22px 28px; border-radius:16px; background:linear-gradient(118deg,#163563,#376bbd 61%,#7185d8); color:#fff; }.eyebrow,.section-kicker { display:block; font-size:11px; font-weight:800; letter-spacing:1.5px; }.eyebrow { color:#c8d9ff; }.platform-hero h2 { margin:5px 0; font-size:25px; }.platform-hero p { max-width:760px; margin:0; color:#dce6ff; font-size:13px; line-height:1.55; }.hero-metrics { display:flex; gap:9px; }.hero-metrics span { min-width:94px; padding:9px 12px; border:1px solid rgba(255,255,255,.23); border-radius:9px; background:rgba(255,255,255,.1); text-align:center; }.hero-metrics b { display:block; color:#fff; font-size:21px; line-height:1.15; }.hero-metrics small { display:block; margin-top:3px; color:#d8e3ff; font-size:11px; }.platform-card { margin-top:16px; padding:20px; border:1px solid #e1e8f1; border-radius:13px; background:#fff; box-shadow:0 8px 22px rgba(31,62,106,.05); }.directory-header { display:flex; align-items:flex-start; justify-content:space-between; gap:18px; padding-bottom:15px; border-bottom:1px solid #e8edf4; }.section-kicker { color:#6179c8; }.directory-header h3 { margin:5px 0; color:#284363; font-size:20px; }.directory-header p { margin:0; color:#8a98aa; font-size:12px; }.header-guide { display:flex; align-items:center; gap:7px; padding:8px 11px; border:1px solid #dce6fa; border-radius:8px; background:#f7f9fe; color:#7183a5; font-size:12px; white-space:nowrap; }.header-guide b { color:#506bc2; font-size:18px; }.filter-panel { display:grid; grid-template-columns:minmax(200px,1.1fr) minmax(220px,1.1fr) minmax(150px,.75fr) auto; gap:11px; align-items:end; padding:16px 0; }.filter-panel label { display:flex; flex-direction:column; gap:6px; color:#748399; font-size:12px; font-weight:650; }.filter-actions { display:flex; align-items:center; gap:10px; min-height:32px; color:#8a98aa; font-size:12px; white-space:nowrap; }.platform-table { width:100%; overflow:hidden; border:1px solid #e4eaf2; border-radius:8px; }.pagination { justify-content:flex-end; margin-top:16px; }.platform-strip { display:flex; flex-wrap:wrap; gap:6px; }.platform-strip span { display:inline-flex; align-items:center; gap:5px; padding:4px 7px; border-radius:5px; font-size:11px; }.platform-strip i { width:6px; height:6px; border-radius:50%; background:currentColor; }.platform-strip small { color:inherit; font-size:11px; }.platform-strip .online { background:#edf9f4; color:#23855d; }.platform-strip .pending { background:#fff7e8; color:#bf7e24; }.platform-strip .offline { background:#f3f5f8; color:#8b99a8; }.coverage { display:inline-block; min-width:43px; padding:4px 7px; border-radius:999px; background:#f2f5fb; color:#5b6f90; font-weight:700; font-size:12px; }.coverage.complete { background:#eaf8f2; color:#21865a; }.dialog-intro { display:flex; flex-direction:column; gap:4px; margin:-1px 0 17px; padding:12px 14px; border:1px solid #dce6ff; border-radius:8px; background:#f6f8ff; color:#7385a5; font-size:12px; }.dialog-intro b { color:#425ea5; font-size:14px; }.editor-table { width:100%; }.editor-table :deep(.el-table__cell) { padding:10px 8px; }.editor-table :deep(.el-select),.editor-table :deep(.el-date-editor) { width:100%; }.platform-type { display:block; margin-top:3px; color:#909eb0; font-size:11px; font-weight:400; }@media (max-width:900px) { .filter-panel { grid-template-columns:repeat(2,minmax(0,1fr)); }.filter-actions { grid-column:span 2; } }@media (max-width:620px) { .platform-hero,.directory-header { align-items:flex-start; flex-direction:column; }.hero-metrics { width:100%; }.hero-metrics span { flex:1; }.filter-panel { grid-template-columns:1fr; }.filter-actions { grid-column:auto; }.platform-card { padding:15px; } }
</style>
