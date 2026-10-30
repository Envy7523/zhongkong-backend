<template>
  <div class="menu-module-page">
    <MenuModuleHeader title="菜品成本" description="维护菜品配方、通用食材标准与包材，统一计算各渠道成本。" active="menu-management-cost" />
    <MenuRecipeWorkbench />
  </div>
</template>
<script setup>
import MenuModuleHeader from './MenuModuleHeader.vue'
import MenuRecipeWorkbench from './MenuRecipeWorkbench.vue'
import './menu-theme.css'
</script>
