<template>
  <WorkspacePageNav :group="group" :current-index="current?.index" />
</template>
<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { systemPageForPath, visibleSystemGroups } from '@/navigation/system.mjs'
import WorkspacePageNav from './WorkspacePageNav.vue'
const route = useRoute(), auth = useAuthStore()
const current = computed(() => systemPageForPath(route.path))
const group = computed(() => visibleSystemGroups(auth.permissions).find(group => group.pages.some(page => page.index === current.value?.index)))
</script>
