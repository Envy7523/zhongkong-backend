<template>
  <div v-if="text||images.length" class="task-instructions">
    <p v-if="text" class="instruction-text">{{text}}</p>
    <div v-if="images.length" class="instruction-images"><button v-for="(path,i) in images" :key="path" type="button" :aria-label="`查看说明图片 ${i+1}`" @click="show(path)"><img v-if="data[path]" :src="data[path]" :alt="`说明图片 ${i+1}`" loading="lazy" /><span v-else>{{errors[path]?'图片加载失败，点击重试':'说明图片加载中…'}}</span></button></div>
    <el-dialog v-model="opened" append-to-body title="题目说明图片" width="min(820px,95vw)"><img v-if="selected" :src="selected" alt="题目说明图片大图" class="instruction-full" /></el-dialog>
  </div>
</template>
<script setup>
import {reactive,ref,watch} from 'vue'
import {storeTaskApi} from '@/api'
const props=defineProps({text:{type:String,default:''},images:{type:Array,default:()=>[]}})
const data=reactive({}),errors=reactive({}),opened=ref(false),selected=ref('')
async function fetchImage(path){try{data[path]=(await storeTaskApi.photo(path)).data;delete errors[path]}catch{errors[path]=true}}
watch(()=>[...props.images],images=>images.forEach(p=>{if(!data[p])fetchImage(p)}),{immediate:true})
async function show(path){if(!data[path])await fetchImage(path);if(data[path]){selected.value=data[path];opened.value=true}}
</script>
<style scoped>
.task-instructions{width:100%;margin:0 0 16px;font-weight:400}.instruction-text{white-space:pre-wrap;font-size:13px;line-height:1.8;color:var(--el-text-color-secondary);margin:0 0 10px}.instruction-images{display:flex;flex-wrap:wrap;gap:10px}.instruction-images button{width:150px;height:112px;padding:0;border:1px solid var(--el-border-color-light);border-radius:6px;overflow:hidden;cursor:zoom-in;background:var(--el-fill-color-light);color:var(--el-text-color-secondary);font-size:12px}.instruction-images img{width:100%;height:100%;object-fit:contain}.instruction-full{width:100%;max-height:75vh;object-fit:contain}
</style>
