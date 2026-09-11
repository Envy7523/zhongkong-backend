<template>
  <div class="store3d-page">
    <section class="store3d-header">
      <div><span class="eyebrow">STORE PREPARATION</span><h2>{{ previewing ? `${selectedStore?.store_name || '门店'} · 门店渲染` : '门店渲染' }}</h2><p>{{ previewing ? `正在浏览 ${modelFileName}，可使用右侧工具栏调整模型视角。` : '先选择筹建门店，再选择该门店对应的 GLB 模型文件。' }}</p></div>
      <el-button v-if="previewing" plain class="back-button" @click="backToSetup"><el-icon><Back /></el-icon>返回选择</el-button>
      <el-tag v-else type="info" effect="light"><el-icon><Files /></el-icon> GLB 在线预览</el-tag>
    </section>

    <section v-if="!previewing" class="model-directory">
      <header class="directory-header">
        <div><span class="section-kicker">MODEL DIRECTORY</span><h3>门店档案</h3><p>选择门店对应的 GLB 文件后即可在线预览。文件仅在本次浏览器会话中使用。</p></div>
        <el-button plain @click="resetFilters">重置筛选</el-button>
      </header>
      <div class="directory-filters">
        <el-input v-model="keyword" clearable placeholder="搜索门店名称" @keyup.enter="queryStores" />
        <el-select v-model="statusFilter" clearable placeholder="全部状态"><el-option v-for="item in statusOptions" :key="item" :label="item" :value="item" /></el-select>
        <el-select v-model="typeFilter" clearable placeholder="全部店型"><el-option v-for="item in storeTypes" :key="item" :label="item" :value="item" /></el-select>
        <el-button type="primary" @click="queryStores">查询</el-button>
      </div>
      <el-table :data="pagedStores" v-loading="storesLoading" stripe class="model-table" empty-text="暂无匹配的门店">
        <el-table-column type="index" label="#" width="58" :index="tableIndex" />
        <el-table-column prop="store_name" label="门店名称" min-width="210" fixed="left" show-overflow-tooltip />
        <el-table-column prop="status" label="状态" width="104"><template #default="{ row }"><el-tag :type="statusTag(row.status)" effect="plain" size="small">{{ row.status || '—' }}</el-tag></template></el-table-column>
        <el-table-column prop="store_type" label="店型" width="94" />
        <el-table-column label="所在地区" min-width="170" show-overflow-tooltip><template #default="{ row }">{{ regionOf(row) }}</template></el-table-column>
        <el-table-column label="GLB 模型文件" min-width="250" show-overflow-tooltip><template #default="{ row }"><span v-if="modelFor(row)" class="model-file"><el-icon><Document /></el-icon>{{ modelFor(row).name }} <small>{{ fileSize(modelFor(row).size) }}</small></span><span v-else class="empty-model">尚未选择模型</span></template></el-table-column>
        <el-table-column label="操作" width="174" fixed="right"><template #default="{ row }"><el-upload class="inline-upload" :auto-upload="false" :show-file-list="false" accept=".glb,model/gltf-binary" :on-change="file => chooseModel(file, row)"><el-button type="primary" link>上传 GLB</el-button></el-upload><el-button type="primary" link :disabled="!modelFor(row)" @click="openPreview(row)">查看模型</el-button></template></el-table-column>
      </el-table>
      <el-pagination v-if="filteredStores.length > pageSize" v-model:current-page="page" :page-size="pageSize" :total="filteredStores.length" layout="total, prev, pager, next" class="pagination" />
    </section>

    <Store3DViewer v-else :key="modelUrl" :model-url="modelUrl" />
  </div>
</template>

<script setup>
import { computed, onActivated, onBeforeUnmount, onMounted, ref } from 'vue'
import { Back, Document, Files } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { getStores } from '@/api'
import Store3DViewer from '@/components/Store3DViewer/index.vue'

const stores = ref([])
const storesLoading = ref(false)
const selectedStoreId = ref(null)
const selectedFile = ref(null)
const modelFiles = ref({})
const keyword = ref('')
const statusFilter = ref('')
const typeFilter = ref('')
const page = ref(1)
const pageSize = 10
const modelUrl = ref('')
const modelFileName = ref('')
const previewing = ref(false)
let temporaryUrl = ''

const selectedStore = computed(() => stores.value.find(store => store.id === selectedStoreId.value) || null)
const statusOptions = computed(() => [...new Set(stores.value.map(store => store.status).filter(Boolean))])
const storeTypes = computed(() => [...new Set(stores.value.map(store => store.store_type).filter(Boolean))])
const orderedStores = computed(() => [...stores.value].sort((left, right) => {
  const leftPlanning = left.status === '筹建中' ? 0 : 1
  const rightPlanning = right.status === '筹建中' ? 0 : 1
  return leftPlanning - rightPlanning || Number(right.id) - Number(left.id)
}))
const filteredStores = computed(() => orderedStores.value.filter(store => {
  const matchesKeyword = !keyword.value || String(store.store_name || '').toLowerCase().includes(keyword.value.trim().toLowerCase())
  return matchesKeyword && (!statusFilter.value || store.status === statusFilter.value) && (!typeFilter.value || store.store_type === typeFilter.value)
}))
const pagedStores = computed(() => filteredStores.value.slice((page.value - 1) * pageSize, page.value * pageSize))
function fileSize(bytes) { return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB` }
function modelFor(store) { return modelFiles.value[store.id] || null }
function regionOf(store) { return [store.province, store.city, store.district].filter(Boolean).join(' / ') || '—' }
function tableIndex(index) { return (page.value - 1) * pageSize + index + 1 }
function statusTag(value) { return ({ '正常营业': 'success', '筹建中': 'warning', '已闭店': 'info', '迁址': 'danger' })[value] || '' }

async function loadStores() {
  storesLoading.value = true
  try {
    const result = await getStores({ page: 1, page_size: 100 })
    stores.value = result.stores || []
  } catch (error) { ElMessage.error(`门店列表加载失败：${error.message}`) }
  finally { storesLoading.value = false }
}

function chooseModel(uploadFile, store) {
  const file = uploadFile?.raw
  if (!file) return
  if (!/\.glb$/i.test(file.name)) {
    ElMessage.warning('请选择 .glb 格式的模型文件')
    return
  }
  modelFiles.value = { ...modelFiles.value, [store.id]: file }
  ElMessage.success(`已选择 ${store.store_name} 的模型文件`)
}

function queryStores() { page.value = 1 }
function resetFilters() { keyword.value = ''; statusFilter.value = ''; typeFilter.value = ''; page.value = 1 }

function openPreview(store) {
  const file = modelFor(store)
  if (!file) return
  selectedStoreId.value = store.id
  selectedFile.value = file
  if (temporaryUrl) URL.revokeObjectURL(temporaryUrl)
  temporaryUrl = URL.createObjectURL(file)
  modelUrl.value = temporaryUrl
  modelFileName.value = file.name
  previewing.value = true
}

function backToSetup() {
  previewing.value = false
  if (temporaryUrl) {
    URL.revokeObjectURL(temporaryUrl)
    temporaryUrl = ''
  }
  modelUrl.value = ''
}

onMounted(loadStores)
onActivated(loadStores)
onBeforeUnmount(() => { if (temporaryUrl) URL.revokeObjectURL(temporaryUrl) })
</script>

<style scoped>
.store3d-page{min-width:0;max-width:1480px;margin:0 auto;color:#1d2b43}.store3d-header{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:15px;padding:23px 28px;border-radius:17px;color:#fff;background:radial-gradient(circle at 88% 15%,rgba(123,190,255,.38),transparent 28%),linear-gradient(120deg,#142c5c,#21559d 62%,#3682dc);box-shadow:0 14px 32px rgba(35,75,141,.18)}.eyebrow,.section-kicker{display:block;font-size:10px;font-weight:800;letter-spacing:.16em}.eyebrow{color:#b9d7ff}.section-kicker{color:#5b86ce}.store3d-header h2{margin:7px 0 5px;font-size:25px;letter-spacing:.01em}.store3d-header p{margin:0;color:rgba(255,255,255,.78);font-size:12px}.store3d-header :deep(.el-tag),.back-button{display:flex;align-items:center;gap:4px;border-color:rgba(255,255,255,.38);background:rgba(239,255,248,.94);color:#157658}.back-button{background:rgba(255,255,255,.14);color:#fff}.model-directory{padding:21px;border:1px solid #e1e8f1;border-radius:13px;background:#fff;box-shadow:0 8px 22px rgba(31,62,106,.05)}.directory-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-bottom:17px;border-bottom:1px solid #e8edf4}.directory-header h3{margin:5px 0;color:#273f62;font-size:20px}.directory-header p{margin:0;color:#8b99aa;font-size:12px}.directory-filters{display:grid;grid-template-columns:minmax(220px,1.5fr) minmax(140px,.82fr) minmax(140px,.82fr) auto;gap:11px;padding:17px 0}.model-table{width:100%;overflow:hidden;border:1px solid #e4eaf2;border-radius:8px}.model-file{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;color:#42617f;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.model-file>.el-icon{flex:none;color:#4381da}.model-file small{color:#93a0b1;font-size:10px}.empty-model{color:#a0abb9;font-size:12px}.inline-upload{display:inline-flex;margin-right:10px}.pagination{justify-content:flex-end;margin-top:16px}@media(max-width:820px){.store3d-header{align-items:flex-start;flex-direction:column;padding:20px}.store3d-header h2{font-size:20px}.model-directory{padding:16px}.directory-filters{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:560px){.directory-header{align-items:flex-start;flex-direction:column}.directory-filters{grid-template-columns:1fr}.directory-filters :deep(.el-button){width:max-content}}
</style>
