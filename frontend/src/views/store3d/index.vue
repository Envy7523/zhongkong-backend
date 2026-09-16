<template>
  <div class="store3d-page">
    <section class="store3d-header">
      <div><span class="eyebrow">STORE PREPARATION</span><h2>{{ previewing ? `${previewStore?.store_name || '门店'} · 门店渲染` : '门店渲染' }}</h2><p>{{ previewing ? `正在浏览 ${modelFileName}${previewFromCache ? '（读取本机缓存，未重复下载）' : ''}，可使用右侧工具栏调整模型视角。` : '先选择筹建门店，再上传该门店对应的 GLB 模型文件；模型保存在服务器，随时可查看。' }}</p></div>
      <el-button v-if="previewing" plain class="back-button" @click="backToSetup"><el-icon><Back /></el-icon>返回选择</el-button>
      <el-tag v-else type="info" effect="light"><el-icon><Files /></el-icon> 模型存于服务器</el-tag>
    </section>

    <section v-if="!previewing" class="model-directory">
      <header class="directory-header">
        <div><span class="section-kicker">MODEL DIRECTORY</span><h3>门店档案</h3><p>模型上传后保存在服务器，刷新页面或换台电脑都能直接查看；再次打开同一模型会优先读本机缓存，不重复下载。</p></div>
        <div class="directory-actions">
          <span v-if="cacheInfo.count" class="cache-chip" :title="cacheTitle"><el-icon><Coin /></el-icon>本机已缓存 {{ cacheInfo.count }} 个 · {{ fileSize(cacheInfo.bytes) }}</span>
          <el-button v-if="cacheInfo.count" plain size="small" @click="clearLocalCache">清除本机缓存</el-button>
          <el-button plain @click="resetFilters">重置筛选</el-button>
        </div>
      </header>
      <div class="directory-filters">
        <el-input v-model="keyword" clearable placeholder="搜索门店名称" @keyup.enter="queryStores" />
        <el-select v-model="statusFilter" clearable placeholder="全部状态"><el-option v-for="item in statusOptions" :key="item" :label="item" :value="item" /></el-select>
        <el-select v-model="typeFilter" clearable placeholder="全部店型"><el-option v-for="item in storeTypes" :key="item" :label="item" :value="item" /></el-select>
        <el-button type="primary" @click="queryStores">查询</el-button>
      </div>

      <div v-if="uploadState" class="upload-panel">
        <el-icon class="spin"><Loading /></el-icon>
        <div class="upload-info"><b>{{ uploadState.fileName }}</b><small>{{ uploadState.stageText }}</small></div>
        <el-progress class="upload-bar" :percentage="uploadState.percent" :stroke-width="8" :show-text="false" />
        <span class="upload-pct">{{ uploadState.percent }}%</span>
        <el-button link type="danger" @click="cancelUpload">取消</el-button>
      </div>

      <el-table :data="pagedStores" v-loading="storesLoading" stripe class="model-table" empty-text="暂无匹配的门店">
        <el-table-column type="index" label="#" width="58" :index="tableIndex" />
        <el-table-column prop="store_name" label="门店名称" min-width="210" fixed="left" show-overflow-tooltip />
        <el-table-column prop="status" label="状态" width="104"><template #default="{ row }"><el-tag :type="statusTag(row.status)" effect="plain" size="small">{{ row.status || '—' }}</el-tag></template></el-table-column>
        <el-table-column prop="store_type" label="店型" width="94" />
        <el-table-column label="所在地区" min-width="170" show-overflow-tooltip><template #default="{ row }">{{ regionOf(row) }}</template></el-table-column>
        <el-table-column label="GLB 模型文件" min-width="286" show-overflow-tooltip>
          <template #default="{ row }">
            <div v-if="modelFor(row)" class="model-file">
              <el-icon><Document /></el-icon>
              <div class="model-meta">
                <span class="model-name">{{ modelFor(row).file_name }} <small>{{ fileSize(modelFor(row).bytes) }}</small></span>
                <span class="model-sub">
                  <el-tag size="small" effect="plain" type="info">v{{ modelFor(row).version }}</el-tag>
                  <span>{{ (modelFor(row).created_at || '').slice(0, 16) || '—' }}</span>
                  <span v-if="modelFor(row).uploaded_by_name">· {{ modelFor(row).uploaded_by_name }}</span>
                  <el-tag v-if="cachedShas.has(modelFor(row).sha256)" size="small" effect="plain" type="success">本机已缓存</el-tag>
                </span>
              </div>
            </div>
            <span v-else class="empty-model">尚未上传模型</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link :disabled="Boolean(uploadState)" @click="pickModel(row)">{{ modelFor(row) ? '更换模型' : '上传 GLB' }}</el-button>
            <el-button type="primary" link :disabled="!modelFor(row)" :loading="previewLoadingStoreId === row.id" @click="openPreview(row)">查看模型</el-button>
            <el-button v-if="modelFor(row)" type="danger" link @click="removeModel(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination v-if="filteredStores.length > pageSize" v-model:current-page="page" :page-size="pageSize" :total="filteredStores.length" layout="total, prev, pager, next" class="pagination" />
    </section>

    <section v-else class="preview-wrap">
      <div v-if="previewLoading" class="preview-loading">
        <el-progress type="circle" :percentage="previewLoading.percent" :width="96" :stroke-width="8" />
        <b>正在从服务器下载模型…</b>
        <small>{{ fileSize(previewLoading.loaded) }} / {{ fileSize(previewLoading.total) }} · 下载完成后会自动缓存到本机，下次打开秒开</small>
      </div>
      <div v-else class="twin-workspace">
        <aside class="twin-sidebar twin-overview">
          <span class="panel-kicker">STORE TWIN</span>
          <h3>{{ previewStore?.store_name }}</h3>
          <p>{{ regionOf(previewStore || {}) || '门店空间档案' }}</p>
          <div class="twin-mode-switch" aria-label="渲染模式">
            <button v-for="mode in renderModes" :key="mode.key" :class="{ active: renderProfile === mode.key }" @click="renderProfile = mode.key">
              <el-icon><component :is="mode.icon" /></el-icon>{{ mode.label }}
            </button>
          </div>
          <div class="twin-health">
            <div><span>模型状态</span><b>可预览</b></div>
            <div><span>空间标注</span><b>{{ annotations.length }} 个已保存</b></div>
            <div><span>版本</span><b>v{{ modelFor(previewStore || {})?.version || '—' }}</b></div>
          </div>
          <section class="twin-section">
            <header><span>空间导航</span><small>点击切换检查重点</small></header>
            <button v-for="zone in zones" :key="zone.key" class="zone-button" :class="{ active: activeZone.key === zone.key }" @click="selectZone(zone)">
              <i :class="`zone-dot ${zone.status}`" /><span>{{ zone.name }}</span><small>{{ zone.note }}</small>
            </button>
          </section>
          <section v-if="annotations.length" class="twin-section saved-annotations">
            <header><span>已标注位置</span><small>{{ annotations.length }} 个</small></header>
            <button v-for="annotation in annotations" :key="annotation.id" class="annotation-list-item" :class="{ active: selectedAnnotation?.id === annotation.id }" @click="selectAnnotation(annotation)">
              <i class="zone-dot" :class="{ ready: annotation.status === '已完成' }" /><span>{{ annotation.title }}</span><small>{{ annotation.status }}</small>
            </button>
          </section>
        </aside>

        <main class="twin-stage">
          <div class="twin-stage-header">
            <div><span class="panel-kicker">DIGITAL TWIN · {{ activeZone.name }}</span><b>{{ activeZone.headline }}</b></div>
            <div class="twin-shots">
              <button @click="setStandardView('top')">鸟瞰</button><button @click="setStandardView('front')">正面</button><button @click="setStandardView('left')">侧面</button>
              <button class="annotation-toggle" :class="{ active: annotationMode }" @click="annotationMode = !annotationMode">{{ annotationMode ? '退出标注' : '标注空间' }}</button>
            </div>
          </div>
          <div v-if="annotationMode" class="annotation-tip">标注模式已开启：请直接点击模型上的实际位置</div>
          <Store3DViewer ref="viewerRef" :key="modelUrl" :model-url="modelUrl" :model-name="modelFileName" :render-profile="renderProfile" :annotations="annotations" :annotation-mode="annotationMode" @annotation-picked="onAnnotationPicked" @annotation-selected="selectAnnotation" />
        </main>

        <aside class="twin-sidebar twin-detail">
          <span class="panel-kicker">INSPECTION FOCUS</span>
          <template v-if="selectedAnnotation">
            <h3>{{ selectedAnnotation.title }}</h3>
            <p>{{ selectedAnnotation.description || '暂未填写说明' }}</p>
            <div class="detail-status"><i class="zone-dot" :class="{ ready: selectedAnnotation.status === '已完成' }" />{{ selectedAnnotation.status }}</div>
            <section class="twin-section annotation-meta"><header><span>模型定位</span><small>已保存</small></header><div><span>节点</span><b>{{ selectedAnnotation.node_name || '未命名节点' }}</b></div><div><span>坐标</span><b>{{ Number(selectedAnnotation.position_x).toFixed(2) }}, {{ Number(selectedAnnotation.position_y).toFixed(2) }}, {{ Number(selectedAnnotation.position_z).toFixed(2) }}</b></div><div><span>创建人</span><b>{{ selectedAnnotation.created_by_name || '当前用户' }}</b></div></section>
            <button class="return-zone" @click="selectedAnnotation = null">返回区域检查模板</button>
          </template>
          <template v-else>
            <h3>{{ activeZone.name }}</h3>
            <p>{{ activeZone.description }}</p>
            <div class="detail-status"><i :class="`zone-dot ${activeZone.status}`" />{{ activeZone.status === 'ready' ? '已具备检查条件' : '待补充空间标注' }}</div>
          <section class="twin-section checklist">
            <header><span>筹建 / 巡店清单</span><small>{{ activeZone.tasks.length }} 项</small></header>
            <label v-for="task in activeZone.tasks" :key="task"><input type="checkbox" /> <span>{{ task }}</span></label>
          </section>
          <div class="twin-next">
            <el-icon><WarningFilled /></el-icon>
            <div><b>下一步：精确标注模型</b><span>将区域绑定到 GLB 节点后，可在模型上直接点选并记录整改。</span></div>
          </div>
          </template>
        </aside>
      </div>
    </section>

    <input ref="fileInput" type="file" accept=".glb,model/gltf-binary" class="hidden-file" @change="onFilePicked" />
    <el-dialog v-model="annotationDialog" title="保存空间标注" width="480px" destroy-on-close>
      <div class="annotation-dialog-note">已从三维模型读取位置与节点信息；这些数据会保存到服务器，并绑定当前模型版本。</div>
      <el-form label-position="top" class="annotation-form">
        <el-form-item label="空间名称" required><el-input v-model="annotationForm.title" placeholder="例如：外卖取餐台" /></el-form-item>
        <div class="annotation-form-grid"><el-form-item label="空间类型"><el-select v-model="annotationForm.zone_key"><el-option v-for="zone in zones" :key="zone.key" :label="zone.name" :value="zone.key" /></el-select></el-form-item><el-form-item label="状态"><el-select v-model="annotationForm.status"><el-option label="待完善" value="待完善" /><el-option label="已完成" value="已完成" /></el-select></el-form-item></div>
        <el-form-item label="模型节点"><el-input :model-value="annotationForm.node_name" disabled /></el-form-item>
        <el-form-item label="说明"><el-input v-model="annotationForm.description" type="textarea" :rows="3" placeholder="例如：取餐柜、外卖货架和堂食动线均在此区域" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="annotationDialog = false">取消</el-button><el-button type="primary" :loading="annotationSaving" @click="saveAnnotation">保存标注</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onActivated, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { Back, Coin, Document, Files, Loading, MoonNight, Sunny, View, WarningFilled } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  getStores, listStoreModels, initStoreModelUpload, getStoreModelUploadState,
  uploadStoreModelChunk, completeStoreModelUpload, abortStoreModelUpload, deleteStoreModel,
  getStoreModelAnnotations, createStoreModelAnnotation,
} from '@/api'
import Store3DViewer from '@/components/Store3DViewer/index.vue'
import {
  supportsModelCache, hasCachedModel, readCachedModel, writeCachedModel, removeCachedModel,
  clearModelCache, modelCacheInfo, canCacheSize, requestPersistentCache, readResponseWithProgress,
} from '@/utils/model-cache'

const TOKEN_KEY = 'etaigong_token'
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024

const stores = ref([])
const storesLoading = ref(false)
const modelsByStore = ref({})
const limits = ref({})
const keyword = ref('')
const statusFilter = ref('')
const typeFilter = ref('')
const page = ref(1)
const pageSize = 10
const fileInput = ref(null)
const pendingStore = ref(null)
const uploadState = ref(null)
const uploadAbort = ref(false)

const previewing = ref(false)
const previewStore = ref(null)
const previewFromCache = ref(false)
const previewLoading = ref(null)
const previewLoadingStoreId = ref(null)
const modelUrl = ref('')
const modelFileName = ref('')
const viewerRef = ref(null)
const renderProfile = ref('day')
const annotations = ref([])
const annotationMode = ref(false)
const annotationDialog = ref(false)
const annotationSaving = ref(false)
const selectedAnnotation = ref(null)
const annotationForm = reactive({ title: '', zone_key: 'facade', description: '', node_name: '', position_x: null, position_y: null, position_z: null, normal_x: 0, normal_y: 1, normal_z: 0, status: '待完善' })
const renderModes = [
  { key: 'day', label: '日间', icon: Sunny },
  { key: 'night', label: '夜间', icon: MoonNight },
  { key: 'inspection', label: '巡检', icon: View },
]
const zones = [
  { key: 'facade', name: '门头与等候区', note: '形象 / 动线', status: 'ready', view: 'front', headline: '第一眼体验与等候动线', description: '检查招牌、灯箱、等候区、取餐动线是否清晰且符合品牌规范。', tasks: ['门头与灯箱完成验收', '等候区导视已摆放', '取餐动线无交叉'] },
  { key: 'cashier', name: '收银与取餐区', note: '效率 / 外卖', status: 'pending', view: 'front', headline: '收银、取餐与外卖交接', description: '后续可绑定收银机、取餐台和外卖出餐点，观察高峰期的交接效率。', tasks: ['收银设备已通电', '取餐台标识清晰', '外卖货架与堂食分流'] },
  { key: 'dining', name: '就餐区', note: '容量 / 体验', status: 'pending', view: 'top', headline: '座位布局与顾客体验', description: '后续将叠加桌位数量、客流峰值和巡店照片，形成就餐体验档案。', tasks: ['桌椅布局符合图纸', '通道宽度检查', '清洁与灯光验收'] },
  { key: 'kitchen', name: '后厨与出餐', note: '安全 / 品控', status: 'pending', view: 'left', headline: '后厨设备与出餐安全', description: '后续可绑定灶台、冰柜、消杀设备与食品安全巡检项。', tasks: ['设备到货并定位', '消防设施齐备', '出餐台与洗消动线检查'] },
]
const activeZoneKey = ref('facade')
const activeZone = computed(() => zones.find(zone => zone.key === activeZoneKey.value) || zones[0])

const cacheInfo = ref({ count: 0, bytes: 0, entries: [], supports: true, persisted: false, usage: 0, quota: 0 })
const cachedShas = ref(new Set())
let temporaryUrl = ''

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
const cacheTitle = computed(() => cacheInfo.value.entries.map(item => `${item.name} · ${fileSize(item.bytes)}`).join('\n') || '本机暂无模型缓存')

function fileSize(bytes) {
  const value = Number(bytes) || 0
  if (value >= 1073741824) return `${(value / 1073741824).toFixed(2)} GB`
  return value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`
}
function modelFor(store) { return modelsByStore.value[store.id] || null }
function regionOf(store) { return [store.province, store.city, store.district].filter(Boolean).join(' / ') || '—' }
function tableIndex(index) { return (page.value - 1) * pageSize + index + 1 }
function statusTag(value) { return ({ '正常营业': 'success', '筹建中': 'warning', '已闭店': 'info', '迁址': 'danger' })[value] || '' }
function setStandardView(view) { viewerRef.value?.setView?.(view) }
function selectZone(zone) { activeZoneKey.value = zone.key; selectedAnnotation.value = null; setStandardView(zone.view) }
function selectAnnotation(annotation) { selectedAnnotation.value = annotation; viewerRef.value?.focusPoint?.(annotation) }
function onAnnotationPicked(point) {
  Object.assign(annotationForm, point, { title: '', zone_key: activeZone.value.key, description: '', status: '待完善' })
  annotationDialog.value = true
}
async function saveAnnotation() {
  const model = modelFor(previewStore.value || {})
  if (!model) return
  if (!annotationForm.title.trim()) { ElMessage.warning('请填写空间名称'); return }
  annotationSaving.value = true
  try {
    const result = await createStoreModelAnnotation(model.id, { ...annotationForm, title: annotationForm.title.trim() })
    annotations.value = [...annotations.value, result.annotation]
    selectedAnnotation.value = result.annotation
    annotationDialog.value = false
    ElMessage.success('空间标注已保存到服务器')
  } catch (error) { ElMessage.error(`保存空间标注失败：${error.message}`) }
  finally { annotationSaving.value = false }
}
function authHeader() { return { Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) || ''}` } }

async function loadStores() {
  storesLoading.value = true
  try {
    const result = await getStores({ page: 1, page_size: 100 })
    stores.value = result.stores || []
  } catch (error) { ElMessage.error(`门店列表加载失败：${error.message}`) }
  finally { storesLoading.value = false }
}

/** 门店模型清单：一次拿全（25 家门店不必发 25 个请求），顺带核对本机缓存命中情况 */
async function loadModels() {
  try {
    const [list, info] = await Promise.all([listStoreModels(), modelCacheInfo()])
    const map = {}
    for (const model of list.models || []) map[model.store_id] = model
    modelsByStore.value = map
    limits.value = list.limits || {}
    cacheInfo.value = info
    if (supportsModelCache()) {
      const hits = await Promise.all((list.models || []).map(async model => (await hasCachedModel(model.sha256)) ? model.sha256 : null))
      cachedShas.value = new Set(hits.filter(Boolean))
    }
  } catch (error) { ElMessage.error(`模型列表加载失败：${error.message}`) }
}

function queryStores() { page.value = 1 }
function resetFilters() { keyword.value = ''; statusFilter.value = ''; typeFilter.value = ''; page.value = 1 }

// ===== 上传（分片 + 断点续传）=====

function pickModel(store) {
  if (uploadState.value) { ElMessage.warning('已有模型正在上传，请等待完成或先取消'); return }
  pendingStore.value = store
  if (fileInput.value) { fileInput.value.value = ''; fileInput.value.click() }
}

async function onFilePicked(event) {
  const file = event.target.files?.[0]
  const store = pendingStore.value
  if (!file || !store) return
  if (!/\.glb$/i.test(file.name)) { ElMessage.warning('请选择 .glb 格式的模型文件'); return }
  const maxBytes = Number(limits.value.max_bytes) || DEFAULT_MAX_BYTES
  if (file.size > maxBytes) {
    ElMessage.error(`模型不能超过 ${fileSize(maxBytes)}，当前文件 ${fileSize(file.size)}`)
    return
  }
  await startUpload(store, file)
}

/**
 * 分片上传。断点续传的两个关键点：
 * ① 断点记录（upload_id）存在 localStorage，键含文件名/大小/修改时间，换文件自动失效；
 * ② 服务端以磁盘上的 .part 文件为准列出缺哪几片，所以进程重启后照样能续。
 */
async function startUpload(store, file) {
  const resumeKey = `store3d-upload:${store.id}|${file.name}|${file.size}|${file.lastModified}`
  uploadAbort.value = false
  uploadState.value = {
    storeId: store.id, storeName: store.store_name, fileName: file.name,
    bytes: file.size, percent: 0, stageText: '正在建立上传会话…', uploadId: '',
  }
  try {
    let session = null
    const saved = localStorage.getItem(resumeKey)
    if (saved) {
      try {
        const previous = JSON.parse(saved)
        session = await getStoreModelUploadState(previous.upload_id)
      } catch {
        // 会话已过期（服务端重启 / 中间态被清理）：丢掉断点记录，重新开一个
        localStorage.removeItem(resumeKey)
      }
    }
    if (!session) {
      session = await initStoreModelUpload({ store_id: store.id, file_name: file.name, bytes: file.size, fingerprint: resumeKey })
      localStorage.setItem(resumeKey, JSON.stringify({ upload_id: session.upload_id }))
    }

    uploadState.value.uploadId = session.upload_id
    const { upload_id: uploadId, chunk_size: chunkSize, total_chunks: totalChunks } = session
    const missing = [...(session.missing || [])]
    let done = totalChunks - missing.length

    if (done > 0) ElMessage.info(`检测到未完成的上传，从第 ${done + 1}/${totalChunks} 片继续`)

    for (const index of missing) {
      if (uploadAbort.value) throw new Error('已取消上传')
      const start = index * chunkSize
      const blob = file.slice(start, Math.min(start + chunkSize, file.size))
      uploadState.value.stageText = `正在上传第 ${done + 1}/${totalChunks} 片 · 每片 ${fileSize(chunkSize)}，中断后可续传`
      uploadState.value.percent = Math.floor(done / totalChunks * 100)
      await uploadStoreModelChunk(uploadId, index, blob, event => {
        const withinChunk = event.total ? event.loaded / event.total : 0
        uploadState.value && (uploadState.value.percent = Math.min(99, Math.floor((done + withinChunk) / totalChunks * 100)))
      })
      done += 1
      if (uploadState.value) uploadState.value.percent = Math.floor(done / totalChunks * 100)
    }

    if (uploadAbort.value) throw new Error('已取消上传')
    uploadState.value.stageText = '上传完毕，服务端正在校验并保存（合并分片 + 计算内容哈希）…'
    uploadState.value.percent = 100
    const result = await completeStoreModelUpload(uploadId)
    localStorage.removeItem(resumeKey)
    uploadState.value = null
    await loadModels()
    ElMessage.success(`${result.message || '模型已保存'}${result.deduped ? '（该文件已存在，直接复用服务器上的副本）' : ''}，点「查看模型」即可预览`)
  } catch (error) {
    if (/已取消上传/.test(String(error?.message))) return
    // 只有"会话失效"才清断点记录；网络类失败要留着，下次点上传才能接着传
    if (/上传会话不存在|已过期/.test(String(error?.message))) localStorage.removeItem(resumeKey)
    uploadState.value = null
    ElMessage.error(`上传失败：${error.message}`)
  }
}

async function cancelUpload() {
  const state = uploadState.value
  uploadAbort.value = true
  uploadState.value = null
  if (state?.uploadId) { try { await abortStoreModelUpload(state.uploadId) } catch { /* 清不掉也不影响下次重传 */ } }
  ElMessage.info('已取消上传')
}

// ===== 预览（优先本机缓存）=====

/**
 * 拿到可交给 three.js 的模型地址。
 * 命中本机缓存就直接用，否则带 token 下载完再缓存——注意下载走的是 JWT 接口，
 * 所以不能把 URL 直接丢给 GLTFLoader（它不会带上 Authorization 头）。
 */
async function resolveModelUrl(model) {
  const cached = await readCachedModel(model.sha256)
  if (cached) {
    previewFromCache.value = true
    return URL.createObjectURL(cached.blob)
  }

  previewFromCache.value = false
  previewLoading.value = { loaded: 0, total: model.bytes, percent: 0 }
  const response = await fetch(`/api/store-models/${model.id}/file`, { headers: authHeader() })
  if (!response.ok) {
    let detail = ''
    try { detail = (await response.json()).error || '' } catch { /* 非 JSON 错误体 */ }
    throw new Error(detail || `服务端返回 ${response.status}`)
  }
  const blob = await readResponseWithProgress(response, progress => {
    if (previewLoading.value) previewLoading.value = { ...progress }
  })

  if (supportsModelCache()) {
    const room = await canCacheSize(blob.size)
    if (!room.ok) ElMessage.warning(room.reason)
    else {
      await requestPersistentCache()
      if (await writeCachedModel(model.sha256, blob, { fileName: model.file_name })) {
        cachedShas.value = new Set([...cachedShas.value, model.sha256])
        cacheInfo.value = await modelCacheInfo()
      }
    }
  }
  return URL.createObjectURL(blob)
}

async function openPreview(store) {
  const model = modelFor(store)
  if (!model) return
  previewLoadingStoreId.value = store.id
  previewStore.value = store
  modelFileName.value = model.file_name
  try {
    const [url, annotationResult] = await Promise.all([resolveModelUrl(model), getStoreModelAnnotations(model.id)])
    if (temporaryUrl) URL.revokeObjectURL(temporaryUrl)
    temporaryUrl = url
    modelUrl.value = url
    annotations.value = annotationResult.annotations || []
    annotationMode.value = false
    selectedAnnotation.value = null
    previewing.value = true
  } catch (error) {
    previewLoading.value = null
    ElMessage.error(`模型加载失败：${error.message}`)
  } finally {
    previewLoadingStoreId.value = null
    previewLoading.value = null
  }
}

function backToSetup() {
  previewing.value = false
  previewFromCache.value = false
  if (temporaryUrl) {
    URL.revokeObjectURL(temporaryUrl)
    temporaryUrl = ''
  }
  modelUrl.value = ''
}

// ===== 删除与缓存管理 =====

async function removeModel(store) {
  const model = modelFor(store)
  if (!model) return
  try {
    await ElMessageBox.confirm(
      `确定删除「${store.store_name}」的模型「${model.file_name}」(v${model.version})？删除后该门店会回退到上一版本（如有），服务器上的文件与历史记录仍保留。`,
      '删除门店模型',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch { return }

  try {
    const result = await deleteStoreModel(model.id)
    // 同一份文件可能被别的门店共用（内容哈希去重），还有人用就不动本机缓存
    const shared = Object.values(modelsByStore.value).some(item => item.id !== model.id && item.sha256 === model.sha256)
    if (!shared && await removeCachedModel(model.sha256)) {
      cachedShas.value = new Set([...cachedShas.value].filter(sha => sha !== model.sha256))
      cacheInfo.value = await modelCacheInfo()
    }
    await loadModels()
    ElMessage.success(result.fallback ? `已删除，该门店已回退到 v${result.fallback.version}` : '已删除，该门店暂无模型')
  } catch (error) { ElMessage.error(`删除失败：${error.message}`) }
}

async function clearLocalCache() {
  try {
    await ElMessageBox.confirm(
      `清除本机缓存的 ${cacheInfo.value.count} 个模型（共 ${fileSize(cacheInfo.value.bytes)}）？服务器上的模型不受影响，下次查看会重新下载。`,
      '清除本机模型缓存',
      { type: 'warning', confirmButtonText: '清除', cancelButtonText: '取消' }
    )
  } catch { return }
  const removed = await clearModelCache()
  cachedShas.value = new Set()
  cacheInfo.value = await modelCacheInfo()
  ElMessage.success(`已清除 ${removed} 个本机模型缓存`)
}

onMounted(() => { loadStores(); loadModels() })
onActivated(() => { loadStores(); loadModels() })
onBeforeUnmount(() => { if (temporaryUrl) URL.revokeObjectURL(temporaryUrl) })
</script>

<style scoped>
.store3d-page{min-width:0;max-width:1480px;margin:0 auto;color:#1d2b43}.store3d-header{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:15px;padding:23px 28px;border-radius:17px;color:#fff;background:radial-gradient(circle at 88% 15%,rgba(123,190,255,.38),transparent 28%),linear-gradient(120deg,#142c5c,#21559d 62%,#3682dc);box-shadow:0 14px 32px rgba(35,75,141,.18)}.eyebrow,.section-kicker{display:block;font-size:10px;font-weight:800;letter-spacing:.16em}.eyebrow{color:#b9d7ff}.section-kicker{color:#5b86ce}.store3d-header h2{margin:7px 0 5px;font-size:25px;letter-spacing:.01em}.store3d-header p{margin:0;color:rgba(255,255,255,.78);font-size:12px}.store3d-header :deep(.el-tag),.back-button{display:flex;align-items:center;gap:4px;border-color:rgba(255,255,255,.38);background:rgba(239,255,248,.94);color:#157658}.back-button{background:rgba(255,255,255,.14);color:#fff}.model-directory{padding:21px;border:1px solid #e1e8f1;border-radius:13px;background:#fff;box-shadow:0 8px 22px rgba(31,62,106,.05)}.directory-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-bottom:17px;border-bottom:1px solid #e8edf4}.directory-header h3{margin:5px 0;color:#273f62;font-size:20px}.directory-header p{margin:0;color:#8b99aa;font-size:12px}.directory-filters{display:grid;grid-template-columns:minmax(220px,1.5fr) minmax(140px,.82fr) minmax(140px,.82fr) auto;gap:11px;padding:17px 0}.model-table{width:100%;overflow:hidden;border:1px solid #e4eaf2;border-radius:8px}.model-file{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;color:#42617f;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.model-file>.el-icon{flex:none;color:#4381da}.model-file small{color:#93a0b1;font-size:10px}.empty-model{color:#a0abb9;font-size:12px}.inline-upload{display:inline-flex;margin-right:10px}.pagination{justify-content:flex-end;margin-top:16px}@media(max-width:820px){.store3d-header{align-items:flex-start;flex-direction:column;padding:20px}.store3d-header h2{font-size:20px}.model-directory{padding:16px}.directory-filters{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:560px){.directory-header{align-items:flex-start;flex-direction:column}.directory-filters{grid-template-columns:1fr}.directory-filters :deep(.el-button){width:max-content}}
@keyframes sm-spin{to{transform:rotate(360deg)}}
.directory-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:9px}
.cache-chip{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border:1px solid #cfe4d8;border-radius:999px;background:#f1fbf6;color:#157658;font-size:11px;white-space:nowrap}
.upload-panel{display:flex;align-items:center;gap:12px;margin-bottom:14px;padding:11px 15px;border:1px solid #d6e4f7;border-radius:10px;background:linear-gradient(90deg,#f4f8ff,#fbfdff)}
.upload-panel .spin{flex:none;color:#4381da;font-size:16px;animation:sm-spin 1.1s linear infinite}
.upload-info{display:flex;flex:0 1 320px;flex-direction:column;gap:2px;min-width:0}
.upload-info b{overflow:hidden;color:#2b4467;font-size:12px;text-overflow:ellipsis;white-space:nowrap}
.upload-info small{color:#8b99aa;font-size:10px}
.upload-bar{flex:1 1 auto;min-width:120px}
.upload-pct{flex:none;width:40px;color:#4381da;font-size:12px;font-weight:700;text-align:right}
.hidden-file{display:none}
/* 覆盖上方 .model-file：模型信息现在是两行（文件名/大小 + 版本/时间/缓存标记），不能再 nowrap 截断 */
.model-file{display:flex;align-items:flex-start;gap:7px;min-width:0;overflow:visible;white-space:normal;text-overflow:clip;line-height:1.35}
.model-file>.el-icon{flex:none;margin-top:2px;color:#4381da}
.model-meta{display:flex;flex-direction:column;gap:3px;min-width:0}
.model-name{overflow:hidden;color:#42617f;font-size:12px;text-overflow:ellipsis;white-space:nowrap}
.model-name small{color:#93a0b1;font-size:10px}
.model-sub{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:#9aa7b8;font-size:10px}
.preview-wrap{position:relative}
.preview-loading{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;min-height:560px;height:calc(100vh - 246px);border:1px solid #dfe8f4;border-radius:16px;background:#f4f7fb;color:#43516a;box-shadow:0 16px 34px rgba(45,73,117,.09)}
.preview-loading b{font-size:13px}
.preview-loading small{color:#8794a7;font-size:11px}
.twin-workspace{display:grid;grid-template-columns:236px minmax(0,1fr) 250px;gap:14px;align-items:stretch}.twin-sidebar{padding:17px;border:1px solid #dfe8f4;border-radius:16px;background:linear-gradient(155deg,#fff,#f7faff);box-shadow:0 10px 28px rgba(42,70,112,.06)}.panel-kicker{display:block;color:#5c82bf;font-size:10px;font-weight:800;letter-spacing:.13em}.twin-sidebar h3{margin:7px 0 4px;color:#203b61;font-size:16px;line-height:1.35}.twin-sidebar>p{margin:0;color:#8493a7;font-size:11px;line-height:1.55}.twin-mode-switch{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin:16px 0 13px;padding:4px;border-radius:10px;background:#edf3fb}.twin-mode-switch button,.twin-shots button{display:flex;align-items:center;justify-content:center;gap:3px;border:0;border-radius:7px;background:transparent;color:#64758c;font-size:11px;line-height:28px;cursor:pointer}.twin-mode-switch button.active{background:#fff;color:#286cc3;font-weight:750;box-shadow:0 2px 6px rgba(45,92,154,.12)}.twin-health{display:grid;grid-template-columns:1fr;gap:8px;padding:12px 0 15px;border-bottom:1px solid #e7edf5}.twin-health div{display:flex;justify-content:space-between;gap:8px;font-size:11px}.twin-health span{color:#8d9aab}.twin-health b{color:#3e628e;font-weight:700}.twin-section{margin-top:15px}.twin-section header{display:flex;justify-content:space-between;gap:8px;margin-bottom:9px}.twin-section header span{color:#3b587c;font-size:12px;font-weight:800}.twin-section header small{color:#96a4b5;font-size:10px}.zone-button{display:grid;grid-template-columns:9px minmax(0,1fr) auto;align-items:center;gap:7px;width:100%;margin:3px 0;padding:9px 7px;border:1px solid transparent;border-radius:9px;background:transparent;color:#536a87;text-align:left;cursor:pointer}.zone-button:hover,.zone-button.active{border-color:#d8e6fb;background:#edf5ff}.zone-button span{overflow:hidden;color:#395675;font-size:12px;font-weight:700;text-overflow:ellipsis;white-space:nowrap}.zone-button small{color:#97a5b6;font-size:10px}.zone-dot{display:block;width:7px;height:7px;border-radius:50%;background:#f1a128;box-shadow:0 0 0 3px rgba(241,161,40,.13)}.zone-dot.ready{background:#27a578;box-shadow:0 0 0 3px rgba(39,165,120,.13)}.twin-stage{min-width:0}.twin-stage-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 9px;padding:0 3px}.twin-stage-header b{display:block;margin-top:3px;color:#294667;font-size:13px}.twin-shots{display:flex;gap:5px}.twin-shots button{padding:0 10px;border:1px solid #d8e4f4;background:#fff;color:#527093;line-height:28px}.twin-shots button:hover{border-color:#91b7ed;color:#2466bb}.twin-detail{background:linear-gradient(160deg,#fff,#fcfbff)}.detail-status{display:flex;align-items:center;gap:8px;margin:16px 0 0;padding:10px;border:1px solid #ece4fb;border-radius:9px;background:#faf8ff;color:#755ca8;font-size:11px}.checklist label{display:flex;align-items:flex-start;gap:7px;margin:9px 0;color:#62758d;font-size:11px;line-height:1.35}.checklist input{width:13px;height:13px;margin:0;accent-color:#2a78d4}.twin-next{display:flex;gap:8px;margin-top:18px;padding:11px;border-radius:10px;background:#fff6e8;color:#916121}.twin-next>.el-icon{flex:none;margin-top:1px;font-size:15px}.twin-next b,.twin-next span{display:block}.twin-next b{font-size:11px}.twin-next span{margin-top:4px;color:#9a7b52;font-size:10px;line-height:1.45}@media(max-width:1180px){.twin-workspace{grid-template-columns:210px minmax(0,1fr)}.twin-detail{display:none}}@media(max-width:820px){.twin-workspace{grid-template-columns:1fr}.twin-overview{order:2}.twin-stage{order:1}.twin-mode-switch{max-width:310px}.zone-button{display:inline-grid;width:calc(50% - 4px);margin-right:4px}.twin-stage-header{align-items:flex-start;flex-direction:column}.twin-shots{width:100%}.twin-shots button{flex:1}}
.annotation-toggle.active{border-color:#4d8fee!important;background:#eaf3ff!important;color:#1c63ba!important;font-weight:800}.annotation-tip{position:absolute;z-index:4;top:62px;left:50%;padding:7px 12px;border:1px solid #b8d4fa;border-radius:999px;background:rgba(238,247,255,.96);box-shadow:0 5px 16px rgba(36,92,162,.12);color:#2764ad;font-size:11px;transform:translateX(-50%);pointer-events:none}.twin-stage{position:relative}.annotation-dialog-note{margin:-5px 0 14px;padding:10px 12px;border:1px solid #d9e9fb;border-radius:9px;background:#f5faff;color:#6d819b;font-size:12px;line-height:1.55}.annotation-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.annotation-form :deep(.el-select){width:100%}
.saved-annotations{padding-top:13px;border-top:1px solid #e7edf5}.annotation-list-item{display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:center;gap:7px;width:100%;margin:3px 0;padding:8px 7px;border:1px solid transparent;border-radius:8px;background:transparent;color:#536a87;text-align:left;cursor:pointer}.annotation-list-item:hover,.annotation-list-item.active{border-color:#d8e6fb;background:#edf5ff}.annotation-list-item span{overflow:hidden;color:#395675;font-size:11px;font-weight:700;text-overflow:ellipsis;white-space:nowrap}.annotation-list-item small{color:#8a9ab0;font-size:10px}.annotation-meta{padding:11px;border:1px solid #e5edf7;border-radius:10px;background:#f9fbfe}.annotation-meta div{display:flex;justify-content:space-between;gap:10px;margin-top:8px}.annotation-meta span{color:#91a0b2;font-size:10px}.annotation-meta b{max-width:145px;overflow:hidden;color:#4a6383;font-size:10px;font-weight:700;text-align:right;text-overflow:ellipsis;white-space:nowrap}.return-zone{width:100%;margin-top:14px;padding:8px;border:1px solid #d8e5f5;border-radius:8px;background:#fff;color:#49709a;font-size:11px;cursor:pointer}.return-zone:hover{border-color:#8fb6e9;color:#2366bc}
@media(max-width:820px){.directory-actions{justify-content:flex-start}.upload-info{flex:1 1 140px}.upload-bar{display:none}}
</style>
