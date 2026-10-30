<template>
  <main class="reports-page">
    <header><h1>问题申报</h1><p>维护门店问题处理流程，跟进回执、关联协作与门店确认。</p></header>
    <StoreReports />
  </main>
</template>
<script setup>
import StoreReports from '@/components/StoreReports.vue'
</script>
<style scoped>
.reports-page{padding:24px;max-width:1500px;margin:auto}
header{margin-bottom:20px}h1{font-size:20px;margin:0 0 8px;color:var(--el-text-color-primary)}p{font-size:13px;margin:0;color:var(--el-text-color-secondary);line-height:1.6}
@media(max-width:768px){.reports-page{padding:16px}}
</style>
