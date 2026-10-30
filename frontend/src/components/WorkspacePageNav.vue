<template>
  <nav v-if="group" class="workspace-page-nav" :aria-label="group.label + '功能'">
    <RouterLink v-for="page in group.pages" :key="page.index" :to="page.path" :aria-current="currentIndex === page.index ? 'page' : undefined" :class="{ 'is-current': currentIndex === page.index }">{{ page.label }}</RouterLink>
  </nav>
</template>
<script setup>
defineProps({ group: Object, currentIndex: String })
</script>
<style scoped>
.workspace-page-nav{display:flex;align-items:stretch;gap:8px;flex-wrap:wrap;min-width:0;padding:0 20px;border-bottom:1px solid var(--el-border-color-light);background:var(--el-bg-color);color:var(--el-text-color-primary)}
a{display:flex;align-items:center;justify-content:center;min-height:48px;padding:0 16px;border-bottom:2px solid transparent;box-sizing:border-box;color:var(--el-text-color-regular);text-decoration:none;font-size:14px;font-weight:500;line-height:1.5;transition:background .15s,color .15s}a:hover{background:var(--el-fill-color-light);color:var(--el-color-primary)}a.is-current{color:var(--el-color-primary);border-bottom-color:var(--el-color-primary);font-weight:600}a:focus-visible{outline:2px solid var(--el-color-primary);outline-offset:-3px}
@media(max-width:540px){.workspace-page-nav{padding:0 12px;gap:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}a{min-height:44px;padding:0 8px;font-size:13px}}
@media(prefers-reduced-motion:reduce){a{transition:none}}
</style>
