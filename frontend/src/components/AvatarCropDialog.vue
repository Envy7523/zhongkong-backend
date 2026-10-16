<template>
  <el-dialog :model-value="modelValue" title="调整头像" width="min(620px,94vw)" class="person-avatar-crop" append-to-body :close-on-click-modal="false" :close-on-press-escape="!busy" :before-close="close" @closed="clear">
    <p class="crop-description">拖动图片调整位置，放大或缩小后保存。</p>
    <el-alert v-if="localError||error" :title="localError||error" type="error" :closable="false" show-icon/>
    <div v-loading="loading" class="crop-layout">
      <div class="crop-workspace">
        <div class="crop-stage">
          <canvas ref="canvas" width="512" height="512" tabindex="0" role="group" aria-label="头像裁剪区域，可拖动或使用方向键移动图片" :class="{dragging}" @pointerdown="startDrag" @pointermove="drag" @pointerup="endDrag" @pointercancel="endDrag" @lostpointercapture="dragging=false" @keydown="moveWithKeys"/>
          <div class="crop-grid" aria-hidden="true"/>
        </div>
        <div class="zoom-controls"><span>缩放</span><el-slider v-model="zoom" :min="1" :max="4" :step="0.01" :disabled="!image||busy" aria-label="缩放比例" :format-tooltip="v=>Math.round(v*100)+'%'"/><span>{{Math.round(zoom*100)}}%</span></div>
        <span class="crop-hint">也可聚焦图片后，用方向键微调位置</span>
      </div>
      <aside class="crop-preview"><span>头像预览</span><img v-if="preview" :src="preview" alt="裁剪后的头像预览"/><div v-else class="preview-placeholder"/><small>保存为 512 × 512 像素</small><el-button :disabled="busy||!image" @click="reset">重置位置</el-button><el-upload :auto-upload="false" :show-file-list="false" accept="image/png,image/jpeg,image/webp" :disabled="busy" :on-change="f=>loadFile(f.raw)"><el-button :disabled="busy">重新选图</el-button></el-upload></aside>
    </div>
    <template #footer><el-button :disabled="busy" @click="close()">取消</el-button><el-button type="primary" :disabled="!image||loading||!!localError" :loading="busy" @click="save">保存头像</el-button></template>
  </el-dialog>
</template>

<script setup>
import {nextTick,onBeforeUnmount,ref,shallowRef,watch} from 'vue'
import {cropGeometry} from '@/utils/avatar-crop.mjs'
const props=defineProps({modelValue:Boolean,file:Object,busy:Boolean,error:{type:String,default:''}})
const emit=defineEmits(['update:modelValue','save'])
const canvas=ref(null),image=shallowRef(null),zoom=ref(1),preview=ref(''),loading=ref(false),localError=ref(''),dragging=ref(false)
let pan={x:0,y:0},pointer=null,request=0,objectUrl='',previewCanvas=null
function revoke(){if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=''}}
function clear(){request++;revoke();image.value=null;preview.value='';localError.value='';loading.value=false;dragging.value=false;pointer=null}
function close(done){if(props.busy)return;emit('update:modelValue',false);if(typeof done==='function')done()}
async function loadFile(file){
  if(!file||props.busy)return
  clear()
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>10*1024*1024){localError.value='请选择10MB以内的 PNG、JPEG 或 WebP 图片';return}
  const current=++request;loading.value=true;const url=URL.createObjectURL(file);objectUrl=url
  try{
    const decoded=new Image();decoded.src=url;await decoded.decode()
    if(current!==request||!props.modelValue)return
    if(!decoded.naturalWidth||!decoded.naturalHeight||decoded.naturalWidth*decoded.naturalHeight>40000000)throw Error('图片尺寸过大，请选择4000万像素以内的图片')
    image.value=decoded;zoom.value=1;pan={x:0,y:0};await nextTick();draw()
  }catch(e){if(current===request)localError.value=e.message?.includes('像素')?e.message:'无法读取这张图片，请重新选择'}
  finally{URL.revokeObjectURL(url);if(objectUrl===url)objectUrl='';if(current===request)loading.value=false}
}
function draw(){
  if(!image.value||!canvas.value)return
  const g=cropGeometry(image.value.naturalWidth,image.value.naturalHeight,zoom.value,pan.x,pan.y);pan={x:g.panX,y:g.panY}
  const ctx=canvas.value.getContext('2d');ctx.clearRect(0,0,512,512);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(image.value,g.sx,g.sy,g.size,g.size,0,0,512,512)
  if(!previewCanvas){previewCanvas=document.createElement('canvas');previewCanvas.width=96;previewCanvas.height=96}
  const previewContext=previewCanvas.getContext('2d');previewContext.clearRect(0,0,96,96);previewContext.drawImage(canvas.value,0,0,96,96)
  preview.value=previewCanvas.toDataURL('image/png')
}
function reset(){zoom.value=1;pan={x:0,y:0};draw()}
function startDrag(e){if(!image.value||props.busy||e.isPrimary===false||e.button!==0)return;e.preventDefault();canvas.value.focus();canvas.value.setPointerCapture(e.pointerId);pointer={id:e.pointerId,x:e.clientX,y:e.clientY};dragging.value=true}
function drag(e){if(!dragging.value||pointer?.id!==e.pointerId||props.busy)return;const ratio=320/canvas.value.getBoundingClientRect().width;pan.x+=(e.clientX-pointer.x)*ratio;pan.y+=(e.clientY-pointer.y)*ratio;pointer={id:e.pointerId,x:e.clientX,y:e.clientY};draw()}
function endDrag(e){if(pointer?.id!==e.pointerId)return;if(canvas.value?.hasPointerCapture(e.pointerId))canvas.value.releasePointerCapture(e.pointerId);dragging.value=false;pointer=null}
function moveWithKeys(e){const directions={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]},d=directions[e.key];if(!d||!image.value||props.busy)return;e.preventDefault();const step=e.shiftKey?24:6;pan.x+=d[0]*step;pan.y+=d[1]*step;draw()}
function save(){if(props.busy||!image.value||!canvas.value)return;draw();emit('save',canvas.value.toDataURL('image/png'))}
watch(zoom,draw)
watch(()=>[props.modelValue,props.file],([open,file])=>{if(open&&file)loadFile(file);else if(!open)clear()},{immediate:true})
onBeforeUnmount(clear)
</script>

<style scoped>
.crop-description{margin:0 0 20px;font-size:13px;color:#66758a;line-height:1.7}.crop-layout{display:grid;grid-template-columns:minmax(0,1fr) 132px;gap:24px;margin-top:20px}.crop-workspace{min-width:0}.crop-stage{position:relative;aspect-ratio:1;max-width:320px;background:repeating-conic-gradient(#edf0f5 0% 25%,#fff 0% 50%) 0/16px 16px;border:1px solid #dce4ef;border-radius:12px;overflow:hidden}.crop-stage canvas{display:block;width:100%;height:100%;cursor:grab;touch-action:none}.crop-stage canvas.dragging{cursor:grabbing}.crop-stage:focus-within{outline:2px solid #4f7cff;outline-offset:3px}.crop-grid{position:absolute;inset:0;pointer-events:none;background:linear-gradient(90deg,transparent 33.1%,#ffffff65 33.1%,#ffffff65 33.5%,transparent 33.5%,transparent 66.4%,#ffffff65 66.4%,#ffffff65 66.8%,transparent 66.8%),linear-gradient(transparent 33.1%,#ffffff65 33.1%,#ffffff65 33.5%,transparent 33.5%,transparent 66.4%,#ffffff65 66.4%,#ffffff65 66.8%,transparent 66.8%)}.zoom-controls{display:flex;align-items:center;gap:16px;font-size:12px;color:#53657d;margin-top:12px}.zoom-controls .el-slider{flex:1;min-width:0}.zoom-controls>span:last-child{min-width:36px;text-align:right;font-variant-numeric:tabular-nums}.crop-hint{font-size:11px;color:#6c7d91}.crop-preview{display:flex;flex-direction:column;align-items:center;gap:14px;font-size:13px;color:#52627b}.crop-preview img,.preview-placeholder{width:96px;height:96px;border-radius:22px;border:1px solid #e3e9f2;object-fit:cover;background:#f4f7fb}.crop-preview small{font-size:11px;white-space:nowrap}.crop-preview .el-button{margin:0}.el-alert{margin:12px 0}@media(max-width:540px){.crop-layout{grid-template-columns:minmax(0,1fr);gap:20px}.crop-stage{margin:auto}.crop-preview{flex-direction:row;flex-wrap:wrap;justify-content:center;gap:10px}.crop-preview img{width:48px;height:48px;border-radius:12px}.crop-preview small{display:none}}
</style>
