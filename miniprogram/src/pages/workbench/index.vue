<template><view class="page"><view class="heading">工作台</view><view class="hint">把门店每天的工作做好</view><view class="grid"><view v-for="item in entries" :key="item.title" class="card" @click="open(item)"><view class="icon">{{ item.icon }}</view><view class="title">{{ item.title }}</view><view class="hint">{{ item.description }}</view></view></view><view v-if="can('collab.manage')" class="card secondary" @click="uni.navigateTo({url:'/pages/collab/list'})">协同事项 <text class="hint">临时事项与跨部门协作 →</text></view><view v-if="!entries.length" class="card hint">当前岗位暂未开放功能，请联系管理员配置权限。</view></view></template>
<script setup>
import { ref,computed } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import api from '../../common/api'
import { getToken } from '../../common/request'
const user=ref({}), can=p=>(user.value.position_permissions||[]).some(v=>v==='*'||v===p)
const entries=computed(()=>[
 {title:'申报',icon:'✓',description:'共同完成门店检查与填报',permission:'store-tasks.execute',url:'/pages/tasks/list'},
 {title:'营业数据查询',icon:'¥',description:'按日、周、月及自定义查询',permission:'analysis.view',report:'revenue'},
 {title:'记账本查询',icon:'≡',description:'查看门店收支和原始明细',permission:'bookkeeping.manage',report:'ledger'},
 {title:'任务进度',icon:'◷',description:'执行进度、审核结果与意见',permission:['store-tasks.execute','store-tasks.review','store-tasks.manage'],url:'/pages/tasks/list'}
].filter(i=>Array.isArray(i.permission)?i.permission.some(can):can(i.permission)))
function open(i){if(i.report){uni.setStorageSync('mp_report_type',i.report);uni.switchTab({url:'/pages/reports/index'})}else uni.navigateTo({url:i.url})}
onShow(async()=>{if(!getToken())return uni.reLaunch({url:'/pages/login/login'});try{user.value=(await api.me()).user}catch{}})
</script>
<style scoped>.page{padding:36rpx}.heading{font-size:44rpx;font-weight:700;margin-bottom:12rpx}.hint{color:#89939b;font-size:25rpx;line-height:1.7}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24rpx;margin-top:36rpx}.card{background:#fff;border-radius:24rpx;padding:30rpx}.icon{font-size:42rpx;color:#d94f2b;margin-bottom:24rpx}.title{font-size:30rpx;font-weight:600;margin-bottom:12rpx}.secondary{margin-top:24rpx;display:flex;justify-content:space-between}</style>
