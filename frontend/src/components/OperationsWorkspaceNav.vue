<template>
  <WorkspacePageNav class="operations-workspace-nav" :group="group" :current-index="current?.index" />
</template>
<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { operationPageForPath, visibleOperationGroups } from '@/navigation/operations.mjs'
import WorkspacePageNav from './WorkspacePageNav.vue'
const route = useRoute(), auth = useAuthStore()
const current = computed(() => operationPageForPath(route.path))
const group = computed(() => visibleOperationGroups(auth.permissions).find(group => group.pages.some(page => page.index === current.value?.index)))
</script>
<style scoped>
.operations-workspace-nav {
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
  min-width: 0;
  padding: 6px 20px;
  overflow-x: auto;
  scrollbar-width: thin;
  background: var(--el-fill-color-extra-light);
}
.operations-workspace-nav :deep(a) {
  flex: 0 0 auto;
  min-height: 34px;
  padding: 0 14px;
  border: 0;
  border-radius: 5px;
  font-size: 13px;
}
.operations-workspace-nav :deep(a.is-current) {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}
@media (max-width: 760px) {
  .operations-workspace-nav { padding: 6px 12px; gap: 2px; }
  .operations-workspace-nav :deep(a) { min-height: 36px; padding: 0 12px; }
}
</style>
