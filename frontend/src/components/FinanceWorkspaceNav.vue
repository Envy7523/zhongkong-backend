<template><WorkspacePageNav :group="group" :current-index="current?.index"/></template>
<script setup>
import {computed} from 'vue'
import {useRoute} from 'vue-router'
import WorkspacePageNav from './WorkspacePageNav.vue'
const route=useRoute()
const group={label:'财务工作台',pages:[{index:'finance-approvals',path:'/finance/approvals',label:'请款审批清单'}]}
const current=computed(()=>group.pages.find(p=>p.path===route.path))
</script>
