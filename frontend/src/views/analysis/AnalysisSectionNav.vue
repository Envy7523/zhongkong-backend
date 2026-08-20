<template>
  <nav class="section-nav" aria-label="经营分析业务页面">
    <router-link v-for="item in sections" :key="item.key" :to="`${basePath}/${item.key}`" :class="{ active: currentSection === item.key }">
      <b>{{ item.label }}</b><small>{{ item.hint }}</small>
    </router-link>
  </nav>
</template>
<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
const route = useRoute()
const perspective = computed(() => route.params.perspective || ({ overview: 'group', 'group-buy': 'group-buy', delivery: 'delivery' }[route.meta.analyticsScope] || 'group'))
const basePath = computed(() => `/analysis/business/${perspective.value}`)
const currentSection = computed(() => route.meta.analyticsSection || 'operations')
const sections = [
  { key: 'operations', label: '营业数据', hint: '收入、费用与推广费' },
  { key: 'products', label: '商品销售数据', hint: '销量、成本与毛利' },
  { key: 'mappings', label: '菜品关联', hint: '平台商品绑定标准菜品' },
]
</script>
<style scoped>
.section-nav{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:-4px 0 14px;padding:7px;border:1px solid #e5e9f0;border-radius:13px;background:#f7f9fc}.section-nav a{padding:10px 14px;border-radius:9px;color:#68758a;text-decoration:none}.section-nav a:hover{background:#fff}.section-nav a.active{background:#fff;color:#2563b8;box-shadow:0 3px 10px rgba(35,55,88,.1)}.section-nav b,.section-nav small{display:block}.section-nav b{font-size:11px}.section-nav small{margin-top:3px;color:#98a2b3;font-size:8px}@media(max-width:620px){.section-nav{grid-template-columns:1fr}}
</style>
