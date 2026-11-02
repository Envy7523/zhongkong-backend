<template>
  <section class="viewer-shell" :class="{ fullscreen: isFullscreen }">
    <div ref="host" class="viewer-canvas" :class="{ 'annotation-mode': annotationMode }" aria-label="门店三维模型预览" @click="onCanvasClick" />
    <div v-if="!loading && !annotationMode" class="hotspot-layer" :class="{ 'motion-paused': !motionEnabled }" aria-label="空间示例点位">
      <button v-for="point in hotspots.filter(item => item.visible)" :key="point.id" class="spatial-hotspot" :class="{ selected: selectedPointId === point.id }" :style="{ left: `${point.x}px`, top: `${point.y}px` }" :aria-label="`定位${point.title}（示例）`" :aria-pressed="selectedPointId === point.id" @click="emit('annotation-selected', point)">
        <span class="hotspot-beacon" aria-hidden="true"><i /></span><span class="hotspot-label">{{ point.title }}<small>示例</small></span>
      </button>
    </div>
    <div v-if="loading || error" class="viewer-overlay">
      <el-progress v-if="loading" type="circle" :percentage="progress" :width="78" :stroke-width="7" />
      <el-icon v-else size="28" color="#d35b5b"><WarningFilled /></el-icon>
      <b>{{ error || statusText }}</b>
      <small v-if="error">{{ modelName || modelUrl }}</small>
    </div>
    <div class="viewer-status" role="status"><i :class="{ loading }" />{{ isFlying ? '视角转移中 · 拖动可接管' : statusText }}</div>
    <div class="viewer-profile"><span>渲染</span><b>{{ profileLabel }}</b></div>
    <div class="viewer-actions" aria-label="三维视图工具栏">
      <el-tooltip content="重置视角" placement="left"><el-button circle @click="resetView"><el-icon><RefreshRight /></el-icon></el-button></el-tooltip>
      <el-divider />
      <el-tooltip content="顶视图" placement="left"><el-button circle @click="setView('top')"><el-icon><Top /></el-icon></el-button></el-tooltip>
      <el-tooltip content="正视图" placement="left"><el-button circle @click="setView('front')"><el-icon><View /></el-icon></el-button></el-tooltip>
      <el-tooltip content="左视图" placement="left"><el-button circle @click="setView('left')"><el-icon><Back /></el-icon></el-button></el-tooltip>
      <el-tooltip content="右视图" placement="left"><el-button circle @click="setView('right')"><el-icon><Right /></el-icon></el-button></el-tooltip>
      <el-divider />
      <el-tooltip :content="isGridVisible ? '隐藏网格' : '显示网格'" placement="left"><el-button circle :type="isGridVisible ? 'primary' : 'default'" @click="setGridVisible()"><el-icon><Grid /></el-icon></el-button></el-tooltip>
      <el-tooltip :content="isAutoRotate ? '关闭自动旋转' : '开启自动旋转'" placement="left"><el-button circle :type="isAutoRotate ? 'primary' : 'default'" @click="setAutoRotate()"><el-icon><Refresh /></el-icon></el-button></el-tooltip>
      <el-tooltip :content="isRoaming ? '退出漫游（Esc）' : '进入漫游模式'" placement="left"><el-button circle :type="isRoaming ? 'warning' : 'default'" @click="isRoaming ? exitRoam() : enterRoam()"><el-icon><Position /></el-icon></el-button></el-tooltip>
      <el-tooltip :content="isFullscreen ? '退出全屏' : '全屏预览'" placement="left"><el-button circle @click="toggleFullscreen"><el-icon><FullScreen /></el-icon></el-button></el-tooltip>
    </div>
    <div class="viewer-hint"><span>左键旋转</span><span>右键平移</span><span>滚轮缩放</span><span>WASD 漫游</span><span>ESC 退出</span></div>
  </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { WarningFilled, RefreshRight, Top, View, Back, Right, Grid, Refresh, Position, FullScreen } from '@element-plus/icons-vue'
import { useThreeViewer } from './useThreeViewer'

// modelName 只用于错误提示：模型现在是 fetch→blob 拿到的，出错时显示 blob: 地址对用户毫无意义
const props = defineProps({
  modelUrl: { type: String, required: true },
  modelName: { type: String, default: '' },
  renderProfile: { type: String, default: 'day' },
  annotations: { type: Array, default: () => [] },
  annotationMode: { type: Boolean, default: false },
})
const emit = defineEmits(['annotation-picked', 'annotation-selected', 'model-ready'])
const host = ref(null)
const viewer = useThreeViewer()
const { loading, progress, error, statusText, modelInfo, hotspots, selectedPointId, motionEnabled, isFlying, setMotionEnabled, setSelectedPoint, createDemoPoints, focusOverview, isGridVisible, isAutoRotate, isRoaming, isFullscreen, init, resetView, setView, setGridVisible, setAutoRotate, setRenderProfile, setAnnotations, pickAt, pickAnnotationAt, focusPoint, enterRoam, exitRoam, toggleFullscreen } = viewer
const profileLabel = computed(() => ({ day: '日间', night: '夜间', inspection: '巡检' })[props.renderProfile] || '日间')
watch(() => props.renderProfile, value => setRenderProfile(value), { immediate: true })
watch(() => props.annotations, value => setAnnotations(value), { deep: true, immediate: true })
watch(loading, value => { if (!value && !error.value && modelInfo.value) emit('model-ready') })
onMounted(() => init(host.value, props.modelUrl))
function onCanvasClick(event) {
  if (props.annotationMode) {
    const point = pickAt(event.clientX, event.clientY)
    if (point) emit('annotation-picked', point)
    return
  }
  const annotation = pickAnnotationAt(event.clientX, event.clientY)
  if (annotation) emit('annotation-selected', annotation)
}
defineExpose({ resetView, setView, focusPoint, setSelectedPoint, setMotionEnabled, createDemoPoints, focusOverview, setGridVisible, setAutoRotate, enterRoam, exitRoam, toggleFullscreen })
</script>

<style scoped>
.hotspot-layer{position:absolute;inset:0;z-index:2;pointer-events:none;overflow:hidden}.spatial-hotspot{position:absolute;display:flex;align-items:center;gap:6px;min-height:44px;padding:0;border:0;background:transparent;transform:translate(-16px,-50%);color:#123e55;cursor:pointer;pointer-events:auto}.hotspot-beacon{position:relative;display:grid;place-items:center;width:32px;height:32px;flex:none;border:1px solid #0891b2;border-radius:50%;background:rgba(240,253,250,.92);box-shadow:0 0 0 5px rgba(8,145,178,.14)}.hotspot-beacon i{width:10px;height:10px;border-radius:50%;background:#0891b2}.hotspot-label{display:flex;gap:7px;align-items:center;padding:7px 10px;border:1px solid #8acbd6;border-radius:7px;background:rgba(255,255,255,.95);box-shadow:0 3px 12px #123e5520;font-size:12px;font-weight:700;white-space:nowrap}.hotspot-label small{font-size:10px;font-weight:400;color:#626f7c}.selected .hotspot-beacon:before{content:'';position:absolute;inset:-15px;border:2px solid #0891b2;border-radius:50%;box-shadow:0 0 20px #22d3ee88;animation:spatial-breathe 4.2s ease-in-out infinite}.selected .hotspot-label{background:#e7f9fc;border-color:#0891b2}.spatial-hotspot:focus-visible{outline:3px solid #1d4ed8;outline-offset:6px;border-radius:6px}.motion-paused .selected .hotspot-beacon:before{animation:none;opacity:.6}@keyframes spatial-breathe{0%,100%{transform:scale(.72);opacity:.25}50%{transform:scale(1.16);opacity:.9}}@media(prefers-reduced-motion:reduce){.selected .hotspot-beacon:before{animation:none;opacity:.6}}
.viewer-shell{position:relative;min-height:560px;height:calc(100vh - 246px);overflow:hidden;border:1px solid #dfe8f4;border-radius:16px;background:#f4f7fb;box-shadow:0 16px 34px rgba(45,73,117,.09)}.viewer-shell.fullscreen{height:100vh;border:0;border-radius:0}.viewer-canvas{width:100%;height:100%;touch-action:none}.viewer-canvas.annotation-mode{cursor:crosshair}.viewer-canvas :deep(canvas){display:block;width:100%!important;height:100%!important;outline:none}.viewer-overlay{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:13px;background:rgba(244,247,251,.76);backdrop-filter:blur(2px);color:#43516a}.viewer-overlay b{font-size:13px}.viewer-overlay small{max-width:72%;overflow:hidden;color:#8794a7;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.viewer-status,.viewer-profile{position:absolute;z-index:2;display:flex;align-items:center;gap:7px;padding:7px 10px;border:1px solid rgba(209,222,240,.8);border-radius:8px;background:rgba(255,255,255,.84);box-shadow:0 4px 14px rgba(44,67,104,.08);color:#53647d;font-size:11px;backdrop-filter:blur(8px)}.viewer-status{top:14px;left:16px}.viewer-profile{top:14px;left:132px}.viewer-profile span{color:#8997aa}.viewer-profile b{color:#286cc3;font-size:11px}.viewer-status i{width:7px;height:7px;border-radius:50%;background:#38b985}.viewer-status i.loading{background:#4f86f7;animation:pulse 1s infinite}.viewer-actions{position:absolute;top:15px;right:15px;z-index:3;display:flex;flex-direction:column;gap:7px;padding:8px;border:1px solid rgba(209,222,240,.9);border-radius:12px;background:rgba(255,255,255,.9);box-shadow:0 10px 22px rgba(38,64,101,.12);backdrop-filter:blur(10px)}.viewer-actions :deep(.el-button){margin:0;border-color:#e4ebf4;color:#49617f}.viewer-actions :deep(.el-button--primary){color:#fff}.viewer-actions :deep(.el-divider--horizontal){margin:1px 0;border-color:#e5ebf3}.viewer-hint{position:absolute;bottom:14px;left:16px;display:flex;flex-wrap:wrap;gap:7px;padding:8px 10px;border-radius:8px;background:rgba(25,42,70,.78);color:#e7effa;font-size:10px;backdrop-filter:blur(8px)}.viewer-hint span+span{padding-left:7px;border-left:1px solid rgba(255,255,255,.18)}@keyframes pulse{50%{opacity:.3}}@media(max-width:900px){.viewer-shell{height:calc(100vh - 210px);min-height:420px}.viewer-hint{max-width:calc(100% - 32px)}.viewer-actions{right:10px;top:10px}.viewer-profile{display:none}}
</style>
