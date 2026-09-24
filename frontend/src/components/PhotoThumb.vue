<template>
   <!-- 空态可选择图片；已有图片时仅支持放大预览。移除后才恢复上传入口。 -->
  <el-upload
    v-if="clickable && !hasImage"
    class="photo-box-host"
    :show-file-list="false"
    accept="image/*"
    :before-upload="onPick"
  >
    <div class="photo-box" :class="{ 'is-busy': busy, 'is-empty': !hasImage, 'photo-box--empty': !hasImage }">
      <span v-if="busy" class="photo-box__status">读取中…</span>
      <template v-else-if="hasImage">
        <el-image
          :src="objectUrl"
          fit="cover"
          class="photo-box__img"
          :preview-src-list="[objectUrl]"
          :initial-index="0"
          preview-teleported
          hide-on-click-modal
          :zoom-rate="1.2"
          :max-scale="7"
          :min-scale="0.5"
        >
          <template #error><span class="photo-box__status">图片无法显示</span></template>
        </el-image>
        <span class="photo-box__preview" @click.stop><el-icon><ZoomIn /></el-icon>预览</span>
      </template>
      <span v-else class="photo-box__status">{{ hint }}</span>
    </div>
  </el-upload>
  <div v-else class="photo-box" :class="{ 'is-busy': busy, 'is-empty': !hasImage, 'photo-box--empty': !hasImage }">
    <span v-if="busy" class="photo-box__status">读取中…</span>
    <template v-else-if="hasImage">
      <el-image :src="objectUrl" fit="cover" class="photo-box__img" :preview-src-list="[objectUrl]" :initial-index="0" preview-teleported hide-on-click-modal :zoom-rate="1.2" :max-scale="7" :min-scale="0.5">
        <template #error><span class="photo-box__status">图片无法显示</span></template>
      </el-image>
      <span class="photo-box__preview" @click.stop><el-icon><ZoomIn /></el-icon>预览</span>
    </template>
    <span v-else class="photo-box__status">{{ hint }}</span>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({
  // 后端存的受保护地址，如 /api/staff/photos/xxx.png；也兼容外部 http(s)/data 地址
  src: { type: String, default: '' },
  hint: { type: String, default: '点击上传图片' },
  // 是否允许点击选图（编辑态用；只读展示时传 false）
  clickable: { type: Boolean, default: true },
})
const emit = defineEmits(['picked', 'loaded'])

const objectUrl = ref('')
const busy = ref(false)
const failed = ref(false)
let currentBlobUrl = ''

const hasImage = computed(() => Boolean(objectUrl.value) && !failed.value)

function release() {
  if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = '' }
  objectUrl.value = ''
  failed.value = false
}

// 受保护图片不能直接写进 <img src>：img 不会带 Authorization 头，会被后端 401。
// 因此带 token 拉成 blob，再用 object URL 交给 el-image 显示与放大。
// blob URL 不在切换时提前释放——预览层仍引用它，只在本组件卸载或换图时回收。
async function load() {
  release()
  const value = String(props.src || '').trim()
  if (!value) return
  if (/^(https?:|data:|blob:)/i.test(value)) { objectUrl.value = value; return }
  busy.value = true
  try {
    const token = localStorage.getItem('etaigong_token')
    const response = await fetch(value, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const blob = await response.blob()
    if (!blob.size) throw new Error('空文件')
    currentBlobUrl = URL.createObjectURL(blob)
    objectUrl.value = currentBlobUrl
    emit('loaded', { url: value, bytes: blob.size })
  } catch (error) {
    failed.value = true
    emit('loaded', { url: value, error: error.message })
  } finally { busy.value = false }
}

function onPick(file) { emit('picked', file); return false }

watch(() => props.src, load, { immediate: true })
onBeforeUnmount(release)
</script>

<style scoped>
.photo-box-host { display:block !important; width:100% !important; min-width:100%; }
/* 所有证件照使用同一完整尺寸；空态只保留轻背景，不显示抢眼边线。 */
/* 空态占满整张照片区域，避免只出现一条窄小的文字占位。 */
.photo-box { position: relative; display: flex; width: 100%; height: 140px; align-items: center; justify-content: center; overflow: hidden; border: 0; border-radius: 10px; background: #f4f6f8; transition: background .18s ease; }
.photo-box.is-empty, .photo-box--empty { width:100%; min-width:100%; background: #f4f6f8; }
.photo-box-host:hover .photo-box.is-empty { background: #eef2f6; }
.photo-box__img { width: 100%; height: 100%; cursor: zoom-in; }
.photo-box__status { position:relative; z-index:1; padding:0 12px; color: #9baabd; font-size: 13px; text-align: center; }
/* 预览按钮：有图后才出现，点击它放大；点格子其他位置仍是重新选图 */
.photo-box__preview { position: absolute; right: 6px; bottom: 6px; display: inline-flex; align-items: center; gap: 3px; padding: 2px 8px; border-radius: 8px; background: rgba(22, 42, 72, .58); color: #fff; font-size: 11px; cursor: pointer; opacity: 0; transition: opacity .18s ease; }
.photo-box-host:hover .photo-box__preview { opacity: 1; }
</style>
