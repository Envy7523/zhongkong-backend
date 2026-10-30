<template>
  <NotificationDialog :model-value="modelValue" :title="mode==='edit'?'编辑库存物料':mode==='preview'?'核对供应商导入':'物料档案'" :subtitle="mode==='list'?'按供应商管理共用物料，营业与员工餐分别保存库存数量。':''" width="min(1100px,96vw)" :close-on-click-modal="false" @update:model-value="emit('update:modelValue',$event)">
    <div class="materials-manager">
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <el-alert v-if="message" :title="message" type="success" :closable="false" show-icon />
      <template v-if="mode==='list'">
        <div class="supplier-groups" role="group" aria-label="物料供应商分组">
          <button v-for="s in suppliers" :key="s.id" :disabled="loading" :class="{selected:selected===s.id}" :aria-pressed="selected===s.id" @click="selectSupplier(s.id)"><strong>{{s.name}}</strong><span>{{s.item_count}} 项物料</span><small>{{s.status}}{{s.observed_date?' · '+s.observed_date:''}}</small></button>
          <button :disabled="loading" :class="{selected:selected==='all'}" :aria-pressed="selected==='all'" @click="selectSupplier('all')"><strong>全部物料</strong><span>{{items.length}} 项</span><small>包含手工建档及未分组物料</small></button>
        </div>
        <div class="materials-toolbar"><el-input v-model="search" clearable placeholder="搜索名称、规格或本地编码" aria-label="搜索物料档案" @input="page=1" /><div><el-button :disabled="loading" @click="edit()">新建物料</el-button><el-upload v-if="selected==='lcx'" :show-file-list="false" :auto-upload="false" accept=".json,application/json" :on-change="readImport"><el-button type="primary" :loading="loading">导入绿春翔报价</el-button></el-upload></div></div>
        <p v-if="selected==='lcx'" class="catalog-note">报价为采集时的账号展示快照，日期与适用门店需分别核对。物料按原计价单位建档，不自动换算包装，也不更新成本卡或库存数量；本地编码不代表官方商品编号。</p>
        <el-alert v-if="selected==='yhc'&&!catalog.length" title="粤宏潮待导入：尚未提供源目录和报价，不填入占位价格或库存数量。" type="info" :closable="false" />
        <el-table v-loading="loading" :data="pageRows" empty-text="暂无物料档案。可新建物料，或导入已有供应商资料。">
          <el-table-column label="物料 / 规格" min-width="220"><template #default="{row}"><strong>{{row.name}}</strong><small>{{row.code}}</small></template></el-table-column>
          <el-table-column label="供应商" min-width="120"><template #default="{row}">{{row.supplier_names?.join('、')||'未分组'}}</template></el-table-column>
          <el-table-column prop="unit" label="库存单位" width="85" />
          <el-table-column v-if="selected==='lcx'" label="采集报价" min-width="145"><template #default="{row}"><template v-if="quotes[row.id]">¥ {{quotes[row.id].quoted_price}} / {{quotes[row.id].source_unit}}<small>{{quotes[row.id].observed_date}} 观察</small></template><span v-else>暂无报价</span></template></el-table-column>
          <el-table-column label="状态" width="80"><template #default="{row}">{{row.active?'启用':'停用'}}</template></el-table-column>
          <el-table-column label="操作" width="85"><template #default="{row}"><el-button link type="primary" @click="edit(row)">编辑</el-button></template></el-table-column>
        </el-table>
        <el-pagination v-if="filtered.length>20" v-model:current-page="page" :page-size="20" :total="filtered.length" layout="total, prev, pager, next" />
      </template>
      <template v-else-if="mode==='edit'">
        <el-form label-position="top" class="material-editor"><el-form-item label="供应商分组"><el-select v-model="form.supplier_ids" multiple placeholder="选择供应商"><el-option v-for="s in suppliers" :key="s.id" :value="s.id" :label="s.name" /></el-select></el-form-item><el-form-item label="本地唯一物料编码"><el-input v-model="form.code" maxlength="50" /></el-form-item><el-form-item label="物料名称与规格"><el-input v-model="form.name" maxlength="100" /></el-form-item><el-form-item label="库存基础单位"><el-select v-model="form.unit"><el-option v-for="u in units" :key="u" :value="u" :label="u" /></el-select></el-form-item><p class="catalog-note">基础单位建账后不可直接修改。供应商按件、包或桶报价时，未经规格核对不自动换算成斤、升或个。</p><div v-if="quotes[form.id]" class="source-reference"><strong>绿春翔原报价资料</strong><p>{{quotes[form.id].source_name}} · ¥ {{quotes[form.id].quoted_price}} / {{quotes[form.id].source_unit}}</p><p>商品说明：{{quotes[form.id].metadata?.descriptions?.join('；')||'源页面未提供'}}</p><p>起订说明：{{quotes[form.id].metadata?.minimum_orders?.join('；')||'源页面未提供'}}</p><p>采集日期 {{quotes[form.id].observed_date}} · 官方商品编号 {{quotes[form.id].supplier_sku_id||'未取得'}}</p></div><el-checkbox v-if="form.id" v-model="form.active">启用此物料</el-checkbox></el-form>
      </template>
      <template v-else-if="preview">
        <div class="import-summary"><strong>绿春翔 · {{preview.count}} 条报价观察记录</strong><span>采集日期 {{preview.observed_date}}</span><span>新增物料 {{preview.new_items}} 项 · 已存在 {{preview.existing_items}} 项</span></div>
        <el-alert :title="preview.replayed?'此文件已导入，重复确认不会新增物料或报价。':'仅导入物料档案和报价快照，不生成入库、期初数量或成本卡改价。'" type="info" :closable="false" show-icon />
        <p class="catalog-note">{{preview.scope.all_catalog_complete?'文件声明目录已采集完成。':'本文件仅为首批采样，未覆盖全部供应商目录。'}}官方商品编号及报价适用门店尚未确认。原报价单位直接作为初始库存单位，整件规格仍需核对。</p>
        <el-table :data="preview.sample"><el-table-column prop="name" label="物料 / 规格（前12条）" min-width="210" /><el-table-column prop="unit" label="报价 / 初始库存单位" min-width="145" /><el-table-column prop="quoted_price" label="采集报价（元）" min-width="130" /></el-table>
      </template>
    </div>
    <template #footer><template v-if="mode==='edit'"><el-button @click="mode='list';error=''">返回列表</el-button><el-button type="primary" :loading="loading" @click="save">保存物料</el-button></template><template v-else-if="mode==='preview'"><el-button @click="mode='list';error=''">返回列表</el-button><el-button type="primary" :loading="loading" @click="commitImport">确认导入</el-button></template><el-button v-else @click="emit('update:modelValue',false)">关闭</el-button></template>
  </NotificationDialog>
</template>
<script setup>
import {ref,computed,watch} from 'vue'
import NotificationDialog from '@/components/NotificationDialog.vue'
const props=defineProps({modelValue:Boolean,api:{type:Object,required:true}}),emit=defineEmits(['update:modelValue','updated'])
const mode=ref('list'),items=ref([]),suppliers=ref([]),catalog=ref([]),selected=ref('lcx'),search=ref(''),page=ref(1),loading=ref(false),error=ref(''),message=ref(''),form=ref({}),preview=ref(null),importFile=ref(null)
const units=['克','千克','斤','毫升','升','只','个','包','袋','瓶','桶','罐','盒','板','件']
const quotes=computed(()=>Object.fromEntries(catalog.value.map(q=>[q.item_id,q])))
const filtered=computed(()=>{const q=search.value.trim().toLowerCase();return items.value.filter(i=>(selected.value==='all'||i.supplier_ids?.includes(selected.value))&&(!q||`${i.name} ${i.code}`.toLowerCase().includes(q))).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'))})
const pageRows=computed(()=>filtered.value.slice((page.value-1)*20,page.value*20))
async function load(){loading.value=true;error.value='';try{const [i,s]=await Promise.all([props.api.items(),props.api.suppliers()]);items.value=i.items;suppliers.value=s.items;catalog.value=selected.value==='all'?[]:(await props.api.supplierCatalog(selected.value)).items}catch(e){error.value=e.message}finally{loading.value=false}}
async function selectSupplier(id){selected.value=id;page.value=1;search.value='';message.value='';await load()}
function edit(row){error.value='';message.value='';form.value=row?JSON.parse(JSON.stringify(row)):{code:'',name:'',unit:'斤',active:true,supplier_ids:selected.value==='all'?[]:[selected.value]};mode.value='edit'}
async function save(){if(!form.value.supplier_ids?.length){error.value='请选择至少一个供应商分组';return}loading.value=true;error.value='';try{await props.api.saveItem(form.value);mode.value='list';await load();emit('updated');message.value='物料已保存，库存数量未改变。'}catch(e){error.value=e.message}finally{loading.value=false}}
async function readImport(file){loading.value=true;error.value='';message.value='';try{if(!file.raw||file.raw.size>1500000)throw new Error('请选择不超过1.5MB的报价JSON文件');importFile.value={source_name:file.name,data:await file.raw.text()};preview.value=(await props.api.previewSupplierImport('lcx',importFile.value)).preview;mode.value='preview'}catch(e){error.value=e.message}finally{loading.value=false}}
async function commitImport(){loading.value=true;error.value='';try{const {result}=await props.api.importSupplierCatalog('lcx',importFile.value);mode.value='list';selected.value='lcx';page.value=1;search.value='';await load();emit('updated');message.value=result.replayed?`此文件已导入，保留现有 ${result.count} 条记录，未重复创建。`:`已导入 ${result.count} 条报价，新增 ${result.new_items} 项物料；库存数量未改变。`;preview.value=null;importFile.value=null}catch(e){error.value=e.message}finally{loading.value=false}}
watch(()=>props.modelValue,visible=>{if(visible){mode.value='list';message.value='';search.value='';page.value=1;preview.value=null;importFile.value=null;load()}},{immediate:true})
</script>
<style scoped>
.source-reference{padding:12px 14px;margin-bottom:16px;border:1px solid var(--el-border-color-light);border-radius:6px;background:var(--el-fill-color-extra-light);font-size:12px;line-height:1.8;color:var(--el-text-color-regular)}.source-reference strong{font-size:13px;font-weight:500}.source-reference p{margin:5px 0 0}
</style>
<style scoped>
.materials-manager{min-width:0}.materials-manager>.el-alert{margin-bottom:14px}.supplier-groups{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:18px}.supplier-groups button{display:grid;gap:5px;padding:14px;text-align:left;border:1px solid var(--el-border-color-light);border-radius:7px;background:var(--el-bg-color);color:var(--el-text-color-primary);cursor:pointer}.supplier-groups strong{font-size:15px;font-weight:600}.supplier-groups span{font-size:13px}.supplier-groups small{font-size:11px;line-height:1.6;color:var(--el-text-color-secondary)}.supplier-groups .selected{border-color:var(--el-color-primary);background:var(--el-color-primary-light-9)}.materials-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap}.materials-toolbar>.el-input{width:280px}.materials-toolbar>div{display:flex;gap:8px;flex-wrap:wrap}.materials-toolbar :deep(.el-upload){display:flex}.catalog-note{margin:10px 0 16px;font-size:12px;line-height:1.8;color:var(--el-text-color-secondary)}.materials-manager :deep(td small){display:block;font-size:11px;color:var(--el-text-color-secondary);line-height:1.7}.materials-manager :deep(td strong){font-size:13px;font-weight:500}.el-pagination{margin-top:16px}.material-editor{max-width:600px;margin:auto}.material-editor .el-select{width:100%}.import-summary{display:flex;flex-wrap:wrap;align-items:center;gap:10px 20px;margin:4px 0 18px;font-size:13px}.import-summary strong{font-size:17px}.import-summary span{color:var(--el-text-color-regular)}button:focus-visible{outline:2px solid var(--el-color-primary);outline-offset:2px}@media(max-width:640px){.supplier-groups{gap:7px}.supplier-groups button{padding:10px 8px}.supplier-groups strong{font-size:13px}.supplier-groups small{font-size:10px}.materials-toolbar>.el-input{width:100%}}
</style>
