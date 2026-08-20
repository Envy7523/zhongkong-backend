<template>
  <nav class="perspective-nav" aria-label="经营分析视角">
    <div class="perspective-copy">
      <span>经营分析</span>
      <small>统一数据口径，按业务视角查看</small>
    </div>
    <div class="perspective-links">
      <router-link
        v-for="item in perspectives"
        :key="item.scope"
        :to="`${item.base}/${currentSection}`"
        :class="{ active: currentScope === item.scope }"
      >
        <span>{{ item.label }}</span>
        <small>{{ item.hint }}</small>
      </router-link>
    </div>
  </nav>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const pathScope = computed(() => ({ group: 'overview', 'group-buy': 'group-buy', delivery: 'delivery' })[route.params.perspective] || route.meta.analyticsScope || 'overview')
const currentScope = computed(() => pathScope.value)
const currentSection = computed(() => route.meta.analyticsSection || 'operations')
const perspectives = [
  { scope: 'overview', label: '集团总视角', hint: '全部门店与渠道', base: '/analysis/business/group' },
  { scope: 'group-buy', label: '团购视角', hint: '美团 / 抖音 / 免费试', base: '/analysis/business/group-buy' },
  { scope: 'delivery', label: '外卖视角', hint: '美团 / 淘宝 / 京东', base: '/analysis/business/delivery' },
]
</script>

<style scoped>
.perspective-nav{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:14px;padding:10px 12px 10px 18px;border:1px solid #e5e9f0;border-radius:15px;background:#fff;box-shadow:0 6px 18px rgba(33,48,78,.05)}
.perspective-copy span,.perspective-copy small{display:block}.perspective-copy span{color:#263247;font-size:12px;font-weight:800}.perspective-copy small{margin-top:3px;color:#929cad;font-size:9px}
.perspective-links{display:grid;grid-template-columns:repeat(3,minmax(138px,1fr));gap:6px}.perspective-links a{display:block;padding:9px 15px;border:1px solid transparent;border-radius:10px;color:#69758a;text-decoration:none;transition:.18s}.perspective-links a:hover{background:#f7f9fc;color:#344054}.perspective-links a.active{border-color:#cbdcfb;background:#eef5ff;color:#2563b8;box-shadow:0 3px 9px rgba(59,130,246,.09)}.perspective-links span,.perspective-links small{display:block}.perspective-links span{font-size:11px;font-weight:750}.perspective-links small{margin-top:3px;color:#98a2b3;font-size:8px}.perspective-links a.active small{color:#7296c9}
@media(max-width:900px){.perspective-nav{align-items:stretch;flex-direction:column}.perspective-links{width:100%}}
@media(max-width:620px){.perspective-links{grid-template-columns:1fr}.perspective-links a{padding:8px 11px}}
</style>
