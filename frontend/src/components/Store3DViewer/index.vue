<template>
  <section class="viewer-shell" :class="{ fullscreen: isFullscreen }">
    <div ref="host" class="viewer-canvas" aria-label="门店三维模型预览" />
    <div v-if="loading || error" class="viewer-overlay">
      <el-progress v-if="loading" type="circle" :percentage="progress" :width="78" :stroke-width="7" />
      <el-icon v-else size="28" color="#d35b5b"><WarningFilled /></el-icon>
      <b>{{ error || statusText }}</b>
      <small v-if="error">{{ modelUrl }}</small>
    </div>
    <div class="viewer-status"><i :class="{ loading }" />{{ statusText }}</div>
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
import { onMounted, ref } from 'vue'
import { WarningFilled, RefreshRight, Top, View, Back, Right, Grid, Refresh, Position, FullScreen } from '@element-plus/icons-vue'
import { useThreeViewer } from './useThreeViewer'

const props = defineProps({ modelUrl: { type: String, required: true } })
const host = ref(null)
const viewer = useThreeViewer()
const { loading, progress, error, statusText, isGridVisible, isAutoRotate, isRoaming, isFullscreen, init, resetView, setView, setGridVisible, setAutoRotate, enterRoam, exitRoam, toggleFullscreen } = viewer
onMounted(() => init(host.value, props.modelUrl))
</script>

<style scoped>
.viewer-shell{position:relative;min-height:560px;height:calc(100vh - 246px);overflow:hidden;border:1px solid #dfe8f4;border-radius:16px;background:#f4f7fb;box-shadow:0 16px 34px rgba(45,73,117,.09)}.viewer-shell.fullscreen{height:100vh;border:0;border-radius:0}.viewer-canvas{width:100%;height:100%;touch-action:none}.viewer-canvas :deep(canvas){display:block;width:100%!important;height:100%!important;outline:none}.viewer-overlay{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:13px;background:rgba(244,247,251,.76);backdrop-filter:blur(2px);color:#43516a}.viewer-overlay b{font-size:13px}.viewer-overlay small{max-width:72%;overflow:hidden;color:#8794a7;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.viewer-status{position:absolute;top:14px;left:16px;display:flex;align-items:center;gap:7px;padding:7px 10px;border:1px solid rgba(209,222,240,.8);border-radius:8px;background:rgba(255,255,255,.84);box-shadow:0 4px 14px rgba(44,67,104,.08);color:#53647d;font-size:11px;backdrop-filter:blur(8px)}.viewer-status i{width:7px;height:7px;border-radius:50%;background:#38b985}.viewer-status i.loading{background:#4f86f7;animation:pulse 1s infinite}.viewer-actions{position:absolute;top:15px;right:15px;z-index:3;display:flex;flex-direction:column;gap:7px;padding:8px;border:1px solid rgba(209,222,240,.9);border-radius:12px;background:rgba(255,255,255,.9);box-shadow:0 10px 22px rgba(38,64,101,.12);backdrop-filter:blur(10px)}.viewer-actions :deep(.el-button){margin:0;border-color:#e4ebf4;color:#49617f}.viewer-actions :deep(.el-button--primary){color:#fff}.viewer-actions :deep(.el-divider--horizontal){margin:1px 0;border-color:#e5ebf3}.viewer-hint{position:absolute;bottom:14px;left:16px;display:flex;flex-wrap:wrap;gap:7px;padding:8px 10px;border-radius:8px;background:rgba(25,42,70,.78);color:#e7effa;font-size:10px;backdrop-filter:blur(8px)}.viewer-hint span+span{padding-left:7px;border-left:1px solid rgba(255,255,255,.18)}@keyframes pulse{50%{opacity:.3}}@media(max-width:900px){.viewer-shell{height:calc(100vh - 210px);min-height:420px}.viewer-hint{max-width:calc(100% - 32px)}.viewer-actions{right:10px;top:10px}}
</style>
