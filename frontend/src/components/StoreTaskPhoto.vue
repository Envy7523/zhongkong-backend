<template><div class="task-evidence-photo"><button class="thumb" type="button" @click="open"><img v-if="thumb" :src="thumb" alt="任务照片缩略图" loading="lazy"/><span v-else>{{error?'点击重试':'加载预览…'}}</span><small>查看原图</small></button><el-dialog v-model="opened" append-to-body title="任务照片 · 原图" width="min(1000px,95vw)" destroy-on-close @closed="clearOriginal"><div v-loading="loading" class="original"><el-alert v-if="error" :title="error" type="error"/><el-image v-if="original" :src="original" :preview-src-list="[original]" fit="contain" :initial-index="0"/><p>点击图片可放大查看</p></div></el-dialog></div></template>
<script setup>
import {ref,watch,onBeforeUnmount} from 'vue'
import {storeTaskApi} from '@/api'
const props=defineProps({path:String});const thumb=ref(''),original=ref(''),opened=ref(false),loading=ref(false),error=ref('');let version=0
function release(){for(const url of [thumb.value,original.value])if(url)URL.revokeObjectURL(url);thumb.value='';original.value=''}
function clearOriginal(){if(original.value)URL.revokeObjectURL(original.value);original.value=''}
watch(()=>props.path,async path=>{const v=++version;release();error.value='';try{const r=await storeTaskApi.photo(path,'thumb');if(v===version)thumb.value=r.data;else URL.revokeObjectURL(r.data)}catch(e){if(v===version)error.value=e.message}},{immediate:true})
async function open(){opened.value=true;if(original.value||loading.value)return;const v=version;loading.value=true;error.value='';try{const r=await storeTaskApi.photo(props.path,'original');if(v===version&&opened.value)original.value=r.data;else URL.revokeObjectURL(r.data)}catch(e){error.value=e.message}finally{loading.value=false}}
onBeforeUnmount(()=>{version++;release()})
</script>
<style scoped>.task-evidence-photo{display:inline-block;margin:8px 10px 8px 0}.thumb{width:145px;padding:0;border:1px solid var(--el-border-color-light);border-radius:8px;overflow:hidden;background:var(--el-fill-color-light);cursor:zoom-in}.thumb img{width:145px;height:108px;object-fit:cover;display:block}.thumb span{display:block;height:108px;line-height:108px;font-size:12px}.thumb small{display:block;padding:6px;color:var(--el-text-color-secondary)}.original{min-height:160px;text-align:center}.original .el-image{max-height:70vh;width:100%}.original p{font-size:12px;color:var(--el-text-color-secondary)}</style>
