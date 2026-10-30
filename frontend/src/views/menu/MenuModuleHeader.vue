<template>
  <header class="menu-workspace-header">
    <div><h2>{{ title }}</h2><p>{{ description }}</p></div>
    <div v-if="metrics.length || $slots.action" class="menu-header-right"><span v-for="m in metrics" :key="m.label" class="menu-header-metric">{{ m.label }}<b>{{ m.value }}</b></span><slot name="action" /></div>
  </header>
</template>
<script setup>
defineProps({ title: { type: String, required: true }, description: { type: String, default: '' }, active: { type: String, default: '' }, metrics: { type: Array, default: () => [] } })
</script>
<style scoped>
.menu-workspace-header{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:22px;padding-bottom:20px;border-bottom:1px solid #e3e8ef;min-width:0}.menu-workspace-header h2{margin:0;font-size:22px;font-weight:600;color:#233751;line-height:1.4}.menu-workspace-header p{margin:7px 0 0;font-size:13px;color:#7d8b9f;line-height:1.8}.menu-header-right{display:flex;align-items:center;gap:20px;flex-shrink:0}.menu-header-metric{display:flex;align-items:center;gap:8px;color:#7b8ba0;font-size:12px}.menu-header-metric b{color:#3d5f88;font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}@media(max-width:800px){.menu-workspace-header{align-items:flex-start;flex-direction:column;gap:12px;margin-bottom:18px}.menu-workspace-header h2{font-size:20px}.menu-header-right{flex-wrap:wrap}}
</style>
