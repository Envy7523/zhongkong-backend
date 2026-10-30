<template>
 <el-dialog v-bind="$attrs" :model-value="modelValue" :title="title" :width="width" class="app-notification-dialog" :class="'notification-tone-'+tone" @update:model-value="$emit('update:modelValue',$event)">
  <template #header="{titleId}"><div class="app-notification-heading"><div class="app-notification-icon"><el-icon><component :is="icons[tone]||Bell"/></el-icon></div><div class="app-notification-heading-copy"><h2 :id="titleId">{{title}}</h2><p v-if="subtitle">{{subtitle}}</p></div><span v-if="badge" class="app-notification-badge">{{badge}}</span></div></template>
  <div class="app-notification-content"><slot/></div>
  <template v-if="$slots.footer" #footer><div class="app-notification-footer"><slot name="footer"/></div></template>
 </el-dialog>
</template>
<script setup>
import {Bell,CircleCheck,Warning,CircleClose} from '@element-plus/icons-vue'
import '../styles/notification-dialog.css'
defineOptions({inheritAttrs:false})
defineProps({modelValue:Boolean,title:{type:String,required:true},subtitle:{type:String,default:''},badge:{type:String,default:''},tone:{type:String,default:'info',validator:v=>['info','success','warning','danger'].includes(v)},width:{type:String,default:'min(680px,96vw)'}})
defineEmits(['update:modelValue'])
const icons={info:Bell,success:CircleCheck,warning:Warning,danger:CircleClose}
</script>
