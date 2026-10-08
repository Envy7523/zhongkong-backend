<template>
  <div class="instruction-editor">
    <label>说明文字<textarea :value="content.text||''" maxlength="500" rows="3" aria-label="说明文字" placeholder="填写检查标准或操作步骤" @input="update({text:$event.target.value})" /></label>
    <p>说明图片 {{images.length}} / 3</p>
    <StoreTaskInstructions :images="images" />
    <div v-for="(path,i) in images" :key="path" class="image-actions"><span>图片 {{i+1}}</span><button type="button" :disabled="busy||i===0" :aria-label="`上移说明图片 ${i+1}`" @click="move(i)">上移</button><button type="button" :disabled="busy" :aria-label="`移除说明图片 ${i+1}`" @click="update({images:images.filter(p=>p!==path)})">移除</button></div>
    <label class="add-guide" :class="{disabled:busy||images.length>=3}">{{busy?'正在上传…':'＋ 添加说明图片'}}<input type="file" accept="image/jpeg,image/png,image/webp" :disabled="busy||images.length>=3" aria-label="添加说明图片" @change="upload" /></label>
    <small>每题最多3张，每张4MB以内。用于说明标准，不计入员工现场照片数量。</small>
  </div>
</template>
<script setup>
import {computed,ref,onBeforeUnmount} from 'vue'
import {ElMessage} from 'element-plus'
import {storeTaskApi} from '@/api'
import StoreTaskInstructions from './StoreTaskInstructions.vue'
const props=defineProps({modelValue:Object}),emit=defineEmits(['update:modelValue'])
const content=computed(()=>props.modelValue?.props||{}),images=computed(()=>content.value.images||[]),busy=ref(false);let alive=true
function update(part){emit('update:modelValue',{type:'TaskInstructions',props:{text:content.value.text||'',images:[...images.value],...part}})}
function move(i){const next=[...images.value];[next[i-1],next[i]]=[next[i],next[i-1]];update({images:next})}
async function upload(event){const file=event.target.files?.[0];event.target.value='';if(!file)return;busy.value=true;try{if(file.size>4*1024*1024)throw new Error('说明图片每张最多4MB');if(images.value.length>=3)throw new Error('每题最多3张说明图片');const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file)});const result=await storeTaskApi.guideUpload(data);if(alive)update({images:[...images.value,result.path]})}catch(e){ElMessage.error(e.message||'说明图片上传失败')}finally{busy.value=false}}
onBeforeUnmount(()=>alive=false)
</script>
<style scoped>
.instruction-editor{width:100%;min-width:0}.instruction-editor label,.instruction-editor p{font-size:13px;line-height:1.7}.instruction-editor textarea{width:100%;box-sizing:border-box;padding:8px;resize:vertical;font:inherit;border:1px solid #dce3ef;border-radius:4px;display:block;margin-top:8px}.image-actions{display:flex;gap:8px;align-items:center;margin:8px 0;font-size:12px}.image-actions span{margin-right:auto}.image-actions button{border:0;background:none;color:#2864e8;cursor:pointer}.image-actions button:disabled{opacity:.4;cursor:default}.add-guide{display:block;padding:8px;text-align:center;border:1px dashed #b4c6e7;border-radius:6px;cursor:pointer;color:#2864e8}.add-guide input{display:block;font-size:11px;width:100%;margin-top:4px}.disabled{opacity:.5;cursor:default}.instruction-editor small{display:block;font-size:11px;line-height:1.8;color:#8490a3;margin-top:10px}
</style>
