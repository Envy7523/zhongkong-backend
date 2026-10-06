<template><StoreEmployees v-if="ownOnly" /><StaffEmployees v-else-if="auth.can('staff.view')" /></template>
<script setup>
import {computed} from 'vue'
import {useAuthStore} from '@/stores/auth'
import StaffEmployees from './StaffEmployees.vue'
import StoreEmployees from './StoreEmployees.vue'
const auth=useAuthStore()
const ownOnly=computed(()=>!auth.isAdmin && auth.can('staff.store.edit'))
</script>
