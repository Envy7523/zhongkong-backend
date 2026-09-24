<template>
  <div class="staff-dispatch-page">
    <section class="dispatch-hero">
      <div><span>人事管理 · 跨店支援</span><h1>员工调岗</h1><p>原归属、岗位和薪资不变；仅将实际支援日期的工资归集到被支援门店。</p></div>
      <el-button type="primary" @click="openCreate">安排支援</el-button>
    </section>
    <section class="dispatch-filter card">
      <el-date-picker v-model="period" type="month" value-format="YYYY-MM" format="YYYY 年 MM 月" :clearable="false" @change="load" />
      <span>派遣记录按实际日期归集。连续派遣按起止日期计算，指定日期可间隔安排。</span>
    </section>
    <section class="card dispatch-table-card">
      <header><div><b>支援安排</b><small>{{ dispatches.length }} 条有效记录</small></div></header>
      <el-table :data="dispatches" v-loading="loading" stripe>
        <el-table-column prop="employee_name" label="员工" min-width="100" /><el-table-column prop="position" label="岗位" min-width="100" />
        <el-table-column prop="origin_store_name" label="原归属门店" min-width="160" /><el-table-column prop="support_store_name" label="被支援门店" min-width="160" />
        <el-table-column label="派遣方式" width="110"><template #default="{ row }"><el-tag :type="row.dispatch_mode === 'selected' ? 'warning' : 'primary'" effect="light">{{ row.dispatch_mode === 'selected' ? '指定日期' : '连续派遣' }}</el-tag></template></el-table-column>
        <el-table-column prop="date_summary" label="支援日期" min-width="260" show-overflow-tooltip /><el-table-column prop="support_days" label="归集天数" width="100"><template #default="{row}">{{ row.support_days }} 天</template></el-table-column>
        <el-table-column prop="reason" label="安排说明" min-width="160" show-overflow-tooltip />
        <el-table-column label="操作" width="150" fixed="right"><template #default="{row}"><a v-if="row.attachment_url" class="attachment-link" :href="row.attachment_url" target="_blank">附件</a><el-button link type="danger" @click="cancel(row)">取消</el-button></template></el-table-column>
      </el-table>
      <el-empty v-if="!loading && !dispatches.length" description="该月份暂无跨店支援安排" :image-size="68" />
    </section>
    <el-dialog v-model="visible" title="安排跨店支援" width="720px" class="dispatch-dialog" @closed="reset">
      <el-alert type="info" :closable="false" show-icon title="派遣不会修改员工原归属、岗位和薪资。工资表按支援日期将相应工资部分归集至被支援门店。" />
      <el-form label-position="top" class="dispatch-form">
        <el-row :gutter="16"><el-col :span="12"><el-form-item label="员工" required><el-select v-model="form.employee_id" filterable placeholder="选择门店员工" style="width:100%"><el-option v-for="item in storeEmployees" :key="item.id" :label="`${item.name} · ${item.store_name}`" :value="item.id" /></el-select></el-form-item></el-col><el-col :span="12"><el-form-item label="被支援门店" required><StoreRegionSelect v-model="form.support_store_id" :stores="stores" placeholder="选择被支援门店" :show-group="false" /></el-form-item></el-col></el-row>
        <el-form-item label="派遣方式" required><el-radio-group v-model="form.dispatch_mode"><el-radio-button value="continuous">连续派遣</el-radio-button><el-radio-button value="selected">指定日期</el-radio-button></el-radio-group></el-form-item>
        <el-form-item v-if="form.dispatch_mode === 'continuous'" label="支援起止日期" required><el-date-picker v-model="continuousRange" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" style="width:100%" /></el-form-item>
        <el-form-item v-else label="支援日期" required><el-date-picker v-model="form.dispatch_dates" type="dates" value-format="YYYY-MM-DD" placeholder="可选择 9 月 1、3、5 等间隔日期" style="width:100%" /></el-form-item>
        <el-form-item label="安排说明" required><el-input v-model="form.reason" type="textarea" :rows="3" placeholder="说明支援原因或工作安排" /></el-form-item>
        <el-form-item label="佐证附件"><div class="attachment-row"><el-upload :auto-upload="false" :show-file-list="false" accept="image/*,.pdf,application/pdf" :on-change="pickAttachment"><el-button plain :loading="uploading">上传任命书 / 安排单</el-button></el-upload><a v-if="form.attachment_url" :href="form.attachment_url" target="_blank">{{ form.attachment_name || '查看附件' }}</a></div></el-form-item>
      </el-form>
      <template #footer><el-button @click="visible=false">取消</el-button><el-button type="primary" :loading="saving" @click="save">确认安排</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import StoreRegionSelect from '@/components/StoreRegionSelect.vue'
import { cancelStaffDispatch, createStaffDispatch, getStaffDispatches, getStaffList, getStores } from '@/api'
const period=ref(new Date().toISOString().slice(0,7)), dispatches=ref([]), stores=ref([]), employees=ref([]), loading=ref(false), visible=ref(false), saving=ref(false), uploading=ref(false), continuousRange=ref([])
const form=reactive({employee_id:null,support_store_id:null,dispatch_mode:'continuous',dispatch_dates:[],reason:'',attachment_url:'',attachment_name:''})
const storeEmployees=computed(()=>employees.value.filter(item=>item.store_id && item.status==='在职'))
async function load(){loading.value=true;try{dispatches.value=(await getStaffDispatches({period:period.value})).dispatches||[]}catch(e){ElMessage.error('读取派遣记录失败：'+e.message)}finally{loading.value=false}}
async function loadOptions(){const [s,e]=await Promise.all([getStores({page:1,page_size:500}),getStaffList({page:1,page_size:100})]);stores.value=s.stores||[];employees.value=e.list||[]}
function reset(){Object.assign(form,{employee_id:null,support_store_id:null,dispatch_mode:'continuous',dispatch_dates:[],reason:'',attachment_url:'',attachment_name:''});continuousRange.value=[]}
function openCreate(){visible.value=true}
async function pickAttachment(uploadFile){const file=uploadFile?.raw;if(!file)return;if(!(file.type==='application/pdf'||String(file.type).startsWith('image/'))){ElMessage.warning('仅支持图片或 PDF');return}if(file.size>10*1024*1024){ElMessage.warning('附件不能超过 10 MB');return}uploading.value=true;try{const token=localStorage.getItem('etaigong_token');const res=await fetch('/api/staff/attachments',{method:'POST',headers:{'Content-Type':file.type,'X-File-Name':encodeURIComponent(file.name),...(token?{Authorization:`Bearer ${token}`}:{})},body:file});const body=await res.json();if(!res.ok)throw new Error(body.error);Object.assign(form,{attachment_url:body.url,attachment_name:body.name||file.name});ElMessage.success('附件已上传')}catch(e){ElMessage.error(e.message||'附件上传失败')}finally{uploading.value=false}}
async function save(){const [start_date,end_date]=continuousRange.value||[];if(!form.employee_id||!form.support_store_id||!form.reason.trim()){ElMessage.warning('请完整填写员工、被支援门店和安排说明');return}if(form.dispatch_mode==='continuous'&&(!start_date||!end_date)){ElMessage.warning('请选择连续派遣起止日期');return}if(form.dispatch_mode==='selected'&&!form.dispatch_dates.length){ElMessage.warning('请选择至少一个支援日期');return}saving.value=true;try{await createStaffDispatch({...form,start_date,end_date,reason:form.reason.trim()});ElMessage.success('跨店支援已安排，工资归集天数已生成');visible.value=false;await load()}catch(e){ElMessage.error(e.message||'安排失败')}finally{saving.value=false}}
async function cancel(row){try{await ElMessageBox.confirm(`取消 ${row.employee_name} 到 ${row.support_store_name} 的支援安排？`,'取消派遣',{type:'warning'});await cancelStaffDispatch(row.id);ElMessage.success('已取消派遣');await load()}catch(e){if(e!=='cancel'&&e?.message)ElMessage.error(e.message)}}
onMounted(async()=>{await Promise.all([load(),loadOptions()])})
</script>
<style scoped>
.staff-dispatch-page{max-width:1440px;margin:0 auto;padding:4px 0 34px;color:#263750}.dispatch-hero{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:16px;padding:22px 26px;border:1px solid #dbe8fb;border-radius:18px;background:linear-gradient(120deg,#f5f9ff,#eef7ff);box-shadow:0 10px 28px rgba(38,93,168,.06)}.dispatch-hero span{color:#5b82b9;font-size:12px;font-weight:700;letter-spacing:.08em}.dispatch-hero h1{margin:5px 0;color:#213b61;font-size:22px}.dispatch-hero p{margin:0;color:#8191a8;font-size:13px}.card{margin-bottom:16px;padding:20px 22px;border:1px solid #e4ebf4;border-radius:18px;background:#fff;box-shadow:0 8px 24px rgba(32,68,112,.045)}.dispatch-filter{display:flex;align-items:center;gap:14px;color:#7d8da2;font-size:13px}.dispatch-table-card header{margin-bottom:16px}.dispatch-table-card header div{display:flex;align-items:baseline;gap:8px}.dispatch-table-card header b{color:#294c76;font-size:17px}.dispatch-table-card header small{color:#8795a9}.attachment-link,.attachment-row a{margin-right:10px;color:#2e6fc7;font-size:12px;text-decoration:none}.dispatch-form{margin-top:18px}.attachment-row{display:flex;align-items:center;gap:12px}@media(max-width:700px){.dispatch-hero,.dispatch-filter{align-items:flex-start;flex-direction:column}.dispatch-hero{padding:18px}.card{padding:16px}}
</style>