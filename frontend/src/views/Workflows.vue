<template><main class="workflow-center"><header><div><h1>审批申请</h1><p>自己设计申请表单与审批顺序，发布后即可使用。正在处理的申请保留原版本。</p></div></header><template v-if="legacy"><el-button class="back" @click="legacy=''">返回审批申请</el-button><LegacyWorkflowRecords :initial-business="legacy"/></template><CustomWorkflowCenter v-else @builtin="openBuiltin"/></main></template>
<script setup>
import {ref} from 'vue';import {useRouter} from 'vue-router';const router=useRouter();import CustomWorkflowCenter from '@/components/CustomWorkflowCenter.vue';import LegacyWorkflowRecords from '@/components/LegacyWorkflowRecords.vue';const legacy=ref('');
function openBuiltin(value){if(value==='store-report')router.push('/operations/reports');else legacy.value=value}
</script>
<style scoped>.workflow-center{padding:24px;max-width:1500px;margin:auto}.workflow-center>header{margin-bottom:24px}h1{font-size:20px;margin:0 0 8px}small,p{color:var(--el-text-color-secondary);font-size:13px;line-height:1.7}.back{margin-bottom:16px}.workflow-center :deep(.workflow){padding:0}</style>
