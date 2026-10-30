<template><main class="workflow-center"><header><div><small>流程中心</small><h1>审批流程</h1><p>自己设计申请表单与审批顺序，发布后即可使用。正在处理的申请保留原版本。</p></div></header><template v-if="legacy"><el-button class="back" @click="legacy=''">返回流程中心</el-button><LegacyWorkflowRecords :initial-business="legacy"/></template><CustomWorkflowCenter v-else @builtin="legacy=$event"/></main></template>
<script setup>
import {ref} from 'vue';import CustomWorkflowCenter from '@/components/CustomWorkflowCenter.vue';import LegacyWorkflowRecords from '@/components/LegacyWorkflowRecords.vue';const legacy=ref('');
</script>
<style scoped>.workflow-center{padding:28px;max-width:1500px;margin:auto}.workflow-center>header{margin-bottom:24px}h1{font-size:26px;margin:8px 0}small,p{color:var(--el-text-color-secondary);font-size:13px;line-height:1.7}.back{margin-bottom:16px}.workflow-center :deep(.workflow){padding:0}</style>
