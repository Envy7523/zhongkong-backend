<template>
  <section v-if="group" class="staff-workspace-nav" aria-label="人事功能导航">
    <div class="staff-workspace-heading"><b>{{ group.label }}</b><span>{{ group.description }}</span></div>
    <nav :aria-label="group.label + '功能'">
      <RouterLink v-for="page in group.pages" :key="page.id" :to="page.path" :aria-current="route.path === page.path ? 'page' : undefined" :class="{ 'is-current': route.path === page.path }">{{ page.label }}</RouterLink>
    </nav>
  </section>
</template>
<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { staffPageForPath, visibleStaffGroups } from '@/navigation/staff.mjs'
const route = useRoute(), auth = useAuthStore()
const group = computed(() => {
  const page = staffPageForPath(route.path)
  return visibleStaffGroups(auth.permissions).find(group => group.pages.some(item => item.id === page?.id))
})
</script>
<style scoped>
.staff-workspace-nav{max-width:1560px;margin:0 auto 22px;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px 24px;flex-wrap:wrap;border:1px solid var(--el-border-color-light);border-radius:12px;background:var(--el-bg-color);color:var(--el-text-color-primary)}
.staff-workspace-heading{display:grid;gap:5px;min-width:0}.staff-workspace-heading b{font-size:15px;font-weight:650}.staff-workspace-heading span{font-size:12px;color:var(--el-text-color-regular);line-height:1.5}
nav{display:flex;gap:6px;flex-wrap:wrap}a{display:flex;align-items:center;justify-content:center;min-height:44px;padding:0 14px;border-radius:8px;color:var(--el-text-color-regular);text-decoration:none;font-size:13px;font-weight:500;transition:background .16s,color .16s}a:hover{background:var(--el-fill-color-light);color:var(--el-color-primary)}a.is-current{color:var(--el-color-primary);background:var(--el-color-primary-light-9);font-weight:650}a:focus-visible{outline:2px solid var(--el-color-primary);outline-offset:2px}
@media(max-width:600px){.staff-workspace-nav{padding:14px;gap:12px;margin-bottom:18px}nav{width:100%;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}a{padding:0 8px}}
@media(prefers-reduced-motion:reduce){a{transition:none}}
</style>
