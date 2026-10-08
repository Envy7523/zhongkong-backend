<template><view v-if="text||images.length" class="instructions"><view v-if="text" class="text">{{text}}</view><view v-if="images.length" class="label">说明图片（参考标准）</view><view class="images"><view v-for="path in images" :key="path" @click="$emit('photo',path)"><image v-if="loaded[path]" :src="loaded[path]" mode="aspectFit"/><text v-else>点击查看说明图片</text></view></view></view></template>
<script setup>
import {reactive,watch} from 'vue'
import api from '../common/api'
const props=defineProps({text:{type:String,default:''},images:{type:Array,default:()=>[]}})
defineEmits(['photo'])
const loaded=reactive({})
watch(()=>[...props.images],paths=>{for(const path of paths)if(!loaded[path])api.taskPhoto(path).then(r=>loaded[path]=r.data).catch(()=>{})},{immediate:true})
</script>
<style scoped>.instructions{margin:16rpx 0 24rpx}.text{font-size:25rpx;color:#697687;line-height:1.8;white-space:pre-wrap}.label{font-size:22rpx;color:#8b949c;margin:12rpx 0}.images{display:flex;flex-wrap:wrap;gap:14rpx}.images view{width:180rpx;min-height:132rpx;background:#f5f6f8;border-radius:10rpx;display:flex;align-items:center;justify-content:center}.images image{width:180rpx;height:132rpx}.images text{font-size:23rpx;color:#d94f2b;padding:12rpx}</style>
