<template>
  <section class="attachment-board" :class="{ empty: !items.length }">
    <header class="attachment-board__head">
      <div>
        <b>材料预览</b>
        <small v-if="items.length">共 {{ items.length }} 份，默认折叠，点击标题展开预览</small>
        <small v-else>暂无已上传材料</small>
      </div>
      <el-button v-if="items.length > 1" link size="small" @click="toggleAll">{{ expandedCount === items.length ? '全部收起' : '全部展开' }}</el-button>
    </header>
    <div v-if="items.length" class="attachment-board__list">
      <article v-for="item in allItems" :key="item.key" class="attachment-card" :class="{ open: isOpen(item.key) }">
        <button type="button" class="attachment-card__head" @click="toggle(item)">
          <span class="attachment-card__icon">{{ iconOf(item) }}</span>
          <span class="attachment-card__name" :title="displayName(item)">{{ displayName(item) }}</span>
          <small class="attachment-card__meta">{{ metaOf(item) }}</small>
          <span class="attachment-card__chevron">{{ isOpen(item.key) ? '收起' : '展开' }}</span>
        </button>
        <div v-if="isOpen(item.key)" class="attachment-card__body">
          <div v-if="loading[item.key]" class="attachment-card__hint">正在加载预览…</div>
          <div v-else-if="errors[item.key]" class="attachment-card__error">
            {{ errors[item.key] }}
            <el-button link type="primary" size="small" @click="openInNewTab(item)">在新窗口打开</el-button>
          </div>
          <template v-else-if="urls[item.key]">
            <img v-if="item.kind === 'image'" :src="urls[item.key]" class="attachment-card__image" :alt="displayName(item)" />
            <iframe v-else-if="item.kind === 'pdf'" :src="urls[item.key]" class="attachment-card__frame" :title="displayName(item)" />
            <div v-else-if="item.kind === 'other'" class="attachment-card__hint">
              该类型无法内嵌预览，请
              <el-button link type="primary" size="small" @click="openInNewTab(item)">在新窗口打开</el-button>
            </div>
          </template>
          <footer class="attachment-card__actions">
            <el-button link type="primary" size="small" @click="openInNewTab(item)">新窗口打开</el-button>
            <el-button link size="small" @click="download(item)">下载</el-button>
          </footer>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'

const props = defineProps({
  // 传送门：{ url, name } 或它们的数组
  items: { type: Array, default: () => [] },
  // 编辑态下本次新选、尚未保存的材料（没有受保护 url，需要本地预览）
  pending: { type: Array, default: () => [] },
})

const openKeys = ref(new Set())
const urls = reactive({})
const errors = reactive({})
const loading = reactive({})
// 本地临时文件生成的 objectURL 需要回收，避免内存泄漏
const objectUrls = []

function extensionOf(name) {
  const matched = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''))
  return matched ? matched[1].toLowerCase() : ''
}
function isImage(name, type = '') {
  return String(type).startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(extensionOf(name))
}
function isPdf(name, type = '') { return String(type) === 'application/pdf' || extensionOf(name) === 'pdf' }
function displayName(item) {
  // 名称必须是后端返回的原始文件名；历史乱码在这里兜底还原一次
  return item.name || '未命名材料'
}
function metaOf(item) {
  const ext = extensionOf(item.name)
  return ext ? ext.toUpperCase() : '文件'
}
function iconOf(item) { return item.kind === 'image' ? '图' : item.kind === 'pdf' ? 'PDF' : '档' }

const allItems = computed(() => {
  const list = []
  ;(props.items || []).forEach((item, index) => {
    if (!item?.url) return
    list.push({ key: `saved-${index}-${item.url}`, url: item.url, name: item.name || '', kind: isImage(item.name) ? 'image' : isPdf(item.name) ? 'pdf' : 'other', local: false })
  })
  ;(props.pending || []).forEach((item, index) => {
    if (!item?.file && !item?.url) return
    const name = item.name || item.file?.name || ''
    list.push({ key: `pending-${index}`, url: item.url || '', name, kind: isImage(name, item.file?.type) ? 'image' : isPdf(name, item.file?.type) ? 'pdf' : 'other', local: Boolean(item.file) })
  })
  return list
})
const expandedCount = computed(() => allItems.value.filter(item => openKeys.value.has(item.key)).length)

function isOpen(key) { return openKeys.value.has(key) }
// 直接接收 item：key 会随源数据重算，用 key 反查容易查不到（曾导致展开后不出图）
async function toggle(item) {
  if (!item) return
  const next = new Set(openKeys.value)
  if (next.has(item.key)) next.delete(item.key)
  else { next.add(item.key); await ensureUrl(item) }
  openKeys.value = next
}
async function toggleAll() {
  if (expandedCount.value === allItems.value.length) { openKeys.value = new Set(); return }
  const next = new Set(allItems.value.map(item => item.key))
  openKeys.value = next
  await Promise.all(allItems.value.map(item => ensureUrl(item)))
}
async function authToken() { return localStorage.getItem('etaigong_token') || '' }
// 受登录保护的附件必须带 Authorization 取回，再转成 blob URL 才能内嵌渲染
async function ensureUrl(item) {
  if (!item || urls[item.key]) return
  if (item.local) {
    if (item.file) { const url = URL.createObjectURL(item.file); objectUrls.push(url); urls[item.key] = url }
    return
  }
  loading[item.key] = true
  try {
    const token = await authToken()
    const response = await fetch(item.url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (!response.ok) throw new Error(`读取失败（${response.status}）`)
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    objectUrls.push(url)
    urls[item.key] = url
  } catch (error) {
    errors[item.key] = error.message || '预览加载失败'
  } finally { loading[item.key] = false }
}
async function openInNewTab(item) {
  try {
    if (!urls[item.key]) await ensureUrl(item)
    if (urls[item.key]) window.open(urls[item.key], '_blank', 'noopener')
  } catch { /* 忽略：错误已展示在卡片内 */ }
}
async function download(item) {
  try {
    if (!urls[item.key]) await ensureUrl(item)
    if (!urls[item.key]) return
    const link = document.createElement('a')
    link.href = urls[item.key]
    link.download = displayName(item)
    document.body.appendChild(link)
    link.click()
    link.remove()
  } catch { /* 忽略 */ }
}
// 材料增删后清理旧的 objectURL，避免残留
watch(allItems, () => {
  const alive = new Set(allItems.value.map(item => item.key))
  Object.keys(urls).forEach(key => { if (!alive.has(key)) delete urls[key] })
  openKeys.value = new Set([...openKeys.value].filter(key => alive.has(key)))
})
</script>

<style scoped>
.attachment-board { margin:12px 0 16px; border:1px solid #e4ecf6; border-radius:12px; background:#fbfdff; }
.attachment-board.empty { background:#fafbfd; }
.attachment-board__head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:11px 14px; border-bottom:1px solid #edf2f8; }
.attachment-board__head b { display:block; color:#2c476a; font-size:13px; }
.attachment-board__head small { color:#8b9aad; font-size:11px; }
.attachment-board__list { display:grid; gap:8px; padding:12px 14px; }
.attachment-card { overflow:hidden; border:1px solid #e6edf6; border-radius:10px; background:#fff; }
.attachment-card.open { border-color:#bcd5f5; box-shadow:0 4px 12px rgba(38,78,139,.08); }
.attachment-card__head { display:flex; align-items:center; gap:10px; width:100%; padding:10px 12px; border:0; background:transparent; cursor:pointer; text-align:left; }
.attachment-card__head:hover { background:#f7fbff; }
.attachment-card__icon { flex:none; min-width:34px; padding:2px 6px; border-radius:7px; color:#3568b0; background:#eef5ff; font-size:10px; font-weight:700; text-align:center; }
.attachment-card__name { flex:1; overflow:hidden; color:#2b4664; font-size:13px; text-overflow:ellipsis; white-space:nowrap; }
.attachment-card__meta { flex:none; color:#93a2b4; font-size:11px; }
.attachment-card__chevron { flex:none; color:#5b83bb; font-size:11px; }
.attachment-card__body { padding:0 12px 12px; border-top:1px dashed #e8eff8; }
.attachment-card__image { display:block; width:100%; max-height:420px; margin-top:12px; border:1px solid #eaf0f7; border-radius:8px; object-fit:contain; background:#f7f9fc; }
.attachment-card__frame { width:100%; height:460px; margin-top:12px; border:1px solid #eaf0f7; border-radius:8px; background:#fff; }
.attachment-card__hint { padding:14px 0; color:#8b9aad; font-size:12px; }
.attachment-card__error { padding:12px 0; color:#c0504d; font-size:12px; }
.attachment-card__actions { display:flex; gap:8px; margin-top:10px; }
</style>
