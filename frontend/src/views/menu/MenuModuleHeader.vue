<template>
  <section class="menu-module-hero">
    <div class="menu-hero-copy">
      <span class="menu-eyebrow">菜品管理</span>
      <h2>{{ title }}</h2>
      <p>{{ description }}</p>
    </div>
    <div class="menu-hero-metrics">
      <div v-for="metric in metrics" :key="metric.label">
        <strong :class="metric.tone">{{ metric.value }}</strong>
        <span>{{ metric.label }}</span>
      </div>
      <slot name="action"></slot>
    </div>
    <nav class="menu-module-nav" aria-label="菜品管理导航">
      <button
        v-for="item in navItems"
        :key="item.id"
        :class="{ active: active === item.id }"
        @click="store.openTabFromId(item.id)"
      >
        {{ item.label }}
      </button>
    </nav>
  </section>
</template>

<script setup>
import { useAppStore } from '@/stores/app'

defineProps({
  title: { type: String, required: true },
  description: { type: String, required: true },
  active: { type: String, required: true },
  metrics: { type: Array, default: () => [] },
})

const store = useAppStore()
const navItems = [
  { id: 'menu-management-overview', label: '菜品总览' },
  { id: 'menu-management-category', label: '菜品分类' },
  { id: 'menu-management-template', label: '菜品模板' },
  { id: 'menu-management-cost', label: '成本分析' },
  { id: 'menu-management-expiry', label: '效期管理' },
  // 菜品核算：暂挂「菜品管理」下，功能打通后迁往「成本核算」时改成 cost-accounting-accounting
  { id: 'menu-management-accounting', label: '菜品核算' },
]
</script>
