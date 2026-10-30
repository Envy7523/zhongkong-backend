<template><WorkspacePageNav :group="PERSONAL_GROUP" :current-index="personalPageForPath(route.path)?.index"/></template>
<script setup>
import {useRoute} from 'vue-router'
import WorkspacePageNav from './WorkspacePageNav.vue'
import {PERSONAL_GROUP,personalPageForPath} from '@/navigation/business-workspaces.mjs'
const route=useRoute()
</script>
