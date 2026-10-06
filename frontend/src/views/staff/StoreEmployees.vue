<template>
  <section class="store-staff">
    <header><div><h2>{{ storeName }} · 员工信息</h2><p>只显示本店员工。固定薪酬、调店及离职流程由人事维护。</p></div><el-button type="primary" @click="edit()">录入员工</el-button></header>
    <el-table :data="employees" border v-loading="loading">
      <el-table-column prop="name" label="姓名" /><el-table-column prop="position" label="职务" /><el-table-column prop="phone" label="手机号" /><el-table-column prop="entry_date" label="入职日期" /><el-table-column prop="hire_type" label="用工类型" /><el-table-column prop="status" label="状态" />
      <el-table-column label="操作" width="90"><template #default="{row}"><el-button link type="primary" @click="edit(row)">编辑</el-button></template></el-table-column>
    </el-table>
    <el-dialog v-model="visible" :title="editingId?'编辑员工':'录入员工'" width="min(720px,95vw)" destroy-on-close>
      <el-form label-width="90px" class="employee-form">
        <el-form-item v-for="field in fields" :key="field.key" :label="field.label">
          <el-select v-if="field.options" v-model="form[field.key]"><el-option v-for="value in field.options" :key="value" :label="value" :value="value" /></el-select>
          <el-date-picker v-else-if="field.key==='entry_date'" v-model="form.entry_date" value-format="YYYY-MM-DD" type="date" />
          <el-input v-else v-model="form[field.key]" :maxlength="field.key==='remark'?1000:200" :type="field.key==='remark'?'textarea':'text'" />
        </el-form-item>
      </el-form>
      <template #footer><el-button @click="visible=false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存信息</el-button></template>
    </el-dialog>
  </section>
</template>
<script setup>
import {onMounted,reactive,ref} from 'vue'
import {ElMessage} from 'element-plus'
import {getStoreStaff,createStoreStaff,updateStoreStaff} from '@/api'
const employees=ref([]),storeName=ref('本店'),loading=ref(false),saving=ref(false),visible=ref(false),editingId=ref(null),form=reactive({})
const fields=[{key:'name',label:'姓名'},{key:'phone',label:'手机号'},{key:'gender',label:'性别',options:['男','女','']},{key:'entry_date',label:'入职日期'},{key:'hire_type',label:'用工类型',options:['全职','兼职']},{key:'position',label:'职务'},{key:'id_card_number',label:'身份证号'},{key:'bank_name',label:'开户银行'},{key:'bank_branch',label:'开户支行'},{key:'bank_account_name',label:'开户姓名'},{key:'bank_card_number',label:'银行卡号'},{key:'emergency_contact',label:'紧急联系人'},{key:'emergency_phone',label:'联系电话'},{key:'contact_address',label:'联系地址'},{key:'remark',label:'备注'}]
async function load(){loading.value=true;try{const result=await getStoreStaff();employees.value=result.employees;storeName.value=result.store_name}catch(error){ElMessage.error(error.message)}finally{loading.value=false}}
function edit(row){editingId.value=row?.id || null;for(const field of fields)form[field.key]=row?.[field.key] || (field.key==='hire_type'?'全职':'');form.updated_at=row?.updated_at || '';visible.value=true}
async function save(){saving.value=true;try{if(editingId.value)await updateStoreStaff(editingId.value,{...form});else await createStoreStaff({...form});visible.value=false;await load();ElMessage.success('员工信息已保存')}catch(error){ElMessage.error(error.message)}finally{saving.value=false}}
onMounted(load)
</script>
<style scoped>
.store-staff{padding:20px;background:#fff;border:1px solid #e2e8f0;border-radius:12px}.store-staff header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}.store-staff h2{margin:0;font-size:20px}.store-staff p{color:#64748b;font-size:13px}.employee-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 16px}.employee-form :deep(.el-select),.employee-form :deep(.el-date-editor){width:100%}@media(max-width:600px){.employee-form{grid-template-columns:1fr}}
</style>
