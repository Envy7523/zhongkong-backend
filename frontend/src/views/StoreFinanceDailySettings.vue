<template>
  <section class="finance-daily">
    <header class="finance-heading"><div><span class="eyebrow">门店日报 · 预览与核对</span><h2>门店财务日报</h2><p>选择门店、业务日期和费用来源，生成后核对数据与样式。</p></div></header>
    <section class="generate-card">
      <div class="query-fields"><label class="store-field"><span>日报门店</span><StoreRegionSelect v-model="storeId" :stores="stores" restrict-to-stores include-closed placeholder="选择日报门店或搜索区域" input-width="100%" :disabled="sending"/></label><label><span>业务日期</span><el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" placeholder="业务日期" aria-label="日报业务日期" :disabled="sending"/></label><el-button type="primary" :loading="loading" :disabled="!storeId || !date || sending || costLoading" @click="generate">{{ preview ? '重新生成' : '生成预览' }}</el-button></div>
      <div v-if="storeId" class="cost-sources" v-loading="costLoading"><div class="section-title"><h3>费用来源</h3><span>参考月份随业务日期自动确定</span></div><div class="cost-grid"><label v-for="item in fixedItems" :key="item.key"><span>{{ item.label }}</span><el-select v-model="costSources[item.key]" :disabled="costLoading || sending" :aria-label="item.label+'数据来源'"><el-option label="记账本数据" value="bookkeeping"/><el-option :label="'运营成本 · 上月（'+previousMonth+'）'" value="operating_previous"/><el-option :label="'运营成本 · 本月（'+reportMonth+'）'" value="operating_current"/></el-select><small>取 {{ sourceMonth(costSources[item.key]) }} 数据</small></label></div><p class="source-note">选择来源后点击生成即可应用。固定费用按日报月份分摊，记账本实支按发生日计入。</p></div>
    </section>
    <template v-if="preview">
      <el-alert v-if="preview.offline_payment_fee?.estimated_days" type="warning" :closable="false" title="扫码及会员本金手续费为测算，赠金不收费，不代表实际提现扣款。" />
      <div v-if="preview.problems.length" class="issues" role="status"><strong>待核对数据</strong><ul><li v-for="p in preview.problems" :key="p">{{ p }}</li></ul></div>
      <p class="audit-hint">堂食／外带不含会员卡消费；会员卡消费含本金及赠金，赠金单列扣减，会员本金手续费并入手续费合计，仅扣一次。鼠标移到数值可查看构成。</p>
      <div class="image-wrap"><div class="audit-sheet"><img :src="preview.image_data_url" :alt="`${preview.store_name} ${preview.business_date} 财务日报预览`" /><template v-if="preview.image_layout"><template v-for="(row,rowIndex) in preview.rows" :key="row.key"><FinanceValueBreakdown v-for="(detail,columnIndex) in row.breakdowns || []" :key="columnIndex" :detail="detail" :label="row.label" :rate="row.rate" :style="cellPosition(rowIndex,columnIndex)" @open="openAudit" /></template></template></div></div>
      <p v-for="item in preview.fixed_cost_details || []" :key="item.key" class="cost-basis">{{ fixedItems.find(x=>x.key===item.key)?.label }}：参考 {{ item.reference_month }}，月度金额 {{ item.monthly_amount === null ? '未登记' : item.monthly_amount.toFixed(2) }}，按 {{ item.days_in_month }} 天分摊</p>
      <el-collapse v-if="preview.fee_details?.length" class="fee-review"><el-collapse-item title="当日费用分类核对（原始名称）" name="fees"><el-table :data="preview.fee_details" size="small"><el-table-column prop="platform" label="平台" /><el-table-column prop="label" label="原始项目" /><el-table-column label="分类"><template #default="{row}">{{ ({third_party:'第三方手续费',promotion:'推广费',member_gift:'会员赠金扣减',member_fee:'会员本金手续费（测算）',refund_adjustment:'退款/赔付调整',unconfirmed:'待确认'})[row.category] }}</template></el-table-column><el-table-column prop="amount" label="费用金额" /></el-table></el-collapse-item></el-collapse>
      <section class="send-card"><div class="section-title"><div><h3>发送日报</h3><p>通过所选机器人发送；发送前请自行核对其配置的接收群。</p></div><el-tag v-if="selectedBots.length" type="info">已选择 {{ selectedBots.length }} 个机器人</el-tag></div><el-checkbox v-model="allowIncompleteTest" :disabled="sending">测试发送：允许待核对项目留空，图片标注“测试日报”</el-checkbox><div class="send-actions"><label class="bot-field"><span>发送机器人</span><el-select v-model="botIds" multiple collapse-tags collapse-tags-tooltip :disabled="sending" placeholder="选择一个或多个发送机器人" aria-label="发送机器人"><el-option v-for="item in bots" :key="item.id" :label="item.name+(item.configured?'':'（未配置或已停用）')" :value="item.id" :disabled="!item.configured"/></el-select></label><el-button type="primary" :loading="sending" :disabled="!approved || (!preview.ready && !allowIncompleteTest) || !botsConfigured || loading || sent || (sendResults.length>0 && !sendResults.some(r=>r.status==='failed'))" @click="send">{{ sent ? '已发送日报' : sendResults.length ? '重试失败目标' : '发送日报 · '+selectedBots.length+' 个机器人' }}</el-button></div><el-checkbox v-model="approved" :disabled="sending">我已核对日报样式、数据及留空项，并确认所选机器人的接收群</el-checkbox><div v-if="sendResults.length" class="send-results"><div v-for="item in sendResults" :key="item.bot_id"><strong>{{ item.name }}</strong><el-tag :type="item.ok?'success':item.status==='failed'?'danger':'warning'">{{ item.ok ? (item.skipped?'已发送，本次跳过':'发送成功') : item.status==='failed'?'发送失败':'结果待确认' }}</el-tag><span>{{ item.reason || '' }}</span></div></div></section>
    </template>
    <el-empty v-else description="选择门店和日期，生成财务日报预览" />
    <el-drawer v-model="auditVisible" :title="auditSelection ? `${auditSelection.detail.title} · ${auditSelection.label} · 数据构成` : '数据构成'" size="min(720px, 95vw)">
      <template v-if="auditSelection"><p>{{ auditSelection.detail.from }} 至 {{ auditSelection.detail.to }}</p><p>{{ auditSelection.detail.formula }}</p><p v-for="note in auditSelection.detail.notes || []" :key="note">{{ note }}</p>
      <el-table :data="auditPageItems" size="small" stripe><el-table-column v-if="auditSelection.detail.delivery_structure || auditSelection.detail.promotion_structure" type="expand"><template #default="{row}"><el-table :data="row.children || []" size="small" empty-text="无来源记录"><el-table-column prop="date" label="日期" /><el-table-column prop="label" label="原始项目" min-width="180" /><el-table-column label="金额" align="right"><template #default="{row:entry}">{{ auditMoney(entry.amount) }}</template></el-table-column><el-table-column label="记录 / 批次"><template #default="{row:entry}">{{ entry.record_id ? '#'+entry.record_id : '—' }} / {{ entry.batch_id || '—' }}</template></el-table-column></el-table></template></el-table-column><el-table-column prop="date" label="日期" width="105" /><el-table-column prop="label" label="计算项 / 原始项目" min-width="170" /><el-table-column prop="source" label="来源" min-width="130" /><el-table-column label="金额" align="right" width="100"><template #default="{row}">{{ auditMoney(row.amount) }}</template></el-table-column><el-table-column label="记录 / 批次" min-width="100"><template #default="{row}">{{ row.record_id ? '#'+row.record_id : '—' }} / {{ row.batch_id || '—' }}</template></el-table-column></el-table>
      <el-pagination v-if="auditItems.length > 30" v-model:current-page="auditPage" :page-size="30" :total="auditItems.length" layout="prev, pager, next, total" />
      <el-empty v-if="!auditItems.length" description="没有可用来源记录，请查看计算说明和缺失提示" /></template>
    </el-drawer>
  </section>
</template>
<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import FinanceValueBreakdown from '@/components/FinanceValueBreakdown.vue'
import { filterFinanceItems } from '@/utils/finance-breakdown-items.mjs'
import { createRequestId } from '@/utils/request-id.mjs'
import StoreRegionSelect from '@/components/StoreRegionSelect.vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { getStoreFinanceDailyOptions, previewStoreFinanceDaily, sendStoreFinanceDailyTest, getStoreFinanceCostSources } from '@/api'
const stores=ref([]),storeId=ref(null),date=ref(''),bots=ref([]),botIds=ref([]),preview=ref(null)
const selectedBots=computed(()=>bots.value.filter(r=>botIds.value.includes(r.id)))
const botsConfigured=computed(()=>selectedBots.value.length>0&&selectedBots.value.length===botIds.value.length&&selectedBots.value.every(r=>r.configured))
const sendResults=ref([])
const allowIncompleteTest=ref(false)
const loading=ref(false),sending=ref(false),approved=ref(false),sent=ref(false)
const costSources=ref({rent:'bookkeeping',utilities:'bookkeeping',salary:'bookkeeping'}),costLoading=ref(false)
const reportMonth=computed(()=>date.value?.slice(0,7)||'—')
const previousMonth=computed(()=>{if(!date.value)return '—';const [year,month]=date.value.split('-').map(Number);return new Date(Date.UTC(year,month-2,1)).toISOString().slice(0,7)})
const sourceMonth=source=>source==='operating_previous'?previousMonth.value:reportMonth.value
const fixedItems=[{key:'rent',label:'房租/物业'},{key:'utilities',label:'水电'},{key:'salary',label:'工资'}]
const auditVisible=ref(false),auditSelection=ref(null),auditPage=ref(1)
const auditItems=computed(()=>filterFinanceItems(auditSelection.value?.detail.items||[]))
const auditPageItems=computed(()=>auditItems.value.slice((auditPage.value-1)*30,auditPage.value*30))
const auditMoney=value=>value===null||value===undefined?'未取得':Number(value).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})
function openAudit(selection){auditSelection.value=selection;auditPage.value=1;auditVisible.value=true}
function cellPosition(row,column){const layout=preview.value.image_layout,width=layout.column_widths[column+2],x=layout.column_widths.slice(0,column+2).reduce((sum,w)=>sum+w,0);return{left:`${x/layout.width*100}%`,top:`${(layout.body_y+row*layout.row_height)/layout.height*100}%`,width:`${width/layout.width*100}%`,height:`${layout.row_height/layout.height*100}%`}}
watch(preview,()=>{allowIncompleteTest.value=false;auditVisible.value=false;auditSelection.value=null})
let generation=0, requestId=null
const now=new Date();now.setDate(now.getDate()-1);date.value=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
watch([storeId,date],()=>{generation++;preview.value=null;approved.value=false;sent.value=false;sendResults.value=[];requestId=null})
watch(costSources,()=>{generation++;preview.value=null;approved.value=false;sent.value=false;sendResults.value=[];requestId=null},{deep:true,flush:'sync'})
watch(storeId,async id=>{if(!id)return;costLoading.value=true;try{const result=await getStoreFinanceCostSources(id);if(storeId.value===id){costSources.value=Object.fromEntries(fixedItems.map(item=>[item.key,result.cost_sources[item.key]]))}}catch(e){ElMessage.error(e.message)}finally{if(storeId.value===id)costLoading.value=false}})
async function generate() {
  const token=++generation;loading.value=true;approved.value=false;preview.value=null;sent.value=false;sendResults.value=[];requestId=null
  try {const result=await previewStoreFinanceDaily(storeId.value,date.value,{...costSources.value});if(token===generation)preview.value=result}
  catch(e){ElMessage.error(e.message)}finally{loading.value=false}
}
async function send() {
  const checked=preview.value,targets=[...selectedBots.value]
  if(!checked || !approved.value || sending.value || !botsConfigured.value)return
  try {await ElMessageBox.confirm(`将 ${checked.business_date}「${checked.store_name}」${allowIncompleteTest.value?'测试日报（含待核对/留空项）':'财务日报'}通过 ${targets.map(r=>'「'+r.name+'」').join('、')} 发送。请确认这些机器人的接收群，是否发送？`,'发送日报',{confirmButtonText:'确认发送',cancelButtonText:'取消',type:'warning',customClass:'app-notification-messagebox'})}catch{return}
  if(checked!==preview.value || JSON.stringify(targets.map(r=>r.id))!==JSON.stringify(selectedBots.value.map(r=>r.id)) || !approved.value)return
  sending.value=true
  try {requestId ||= createRequestId();const result=await sendStoreFinanceDailyTest({store_id:checked.store_id,business_date:checked.business_date,bot_ids:targets.map(r=>r.id),cost_sources:checked.cost_sources,fingerprint:checked.fingerprint,request_id:requestId,confirm_template_approved:true,confirm_target_verified:true,confirm_data_reviewed:true,allow_incomplete_test:allowIncompleteTest.value===true});sendResults.value=result.results || [];sent.value=result.ok;requestId=null;if(result.ok)ElMessage.success('所选机器人均已发送');else ElMessage.warning('部分目标未成功，请查看各机器人的发送结果')}
  catch(e){ElMessage.error(e.message)}finally{sending.value=false}
}
watch(botIds,()=>{approved.value=false;sent.value=false;sendResults.value=[];requestId=null},{deep:true})
onMounted(async()=>{try{const result=await getStoreFinanceDailyOptions();stores.value=result.stores;bots.value=result.bots || [];botIds.value=result.bot?.id ? [result.bot.id] : []}catch(e){ElMessage.error(e.message)}})
</script>
<style scoped>
.audit-sheet{position:relative;width:100%;min-width:900px;max-width:1500px;margin:auto}.audit-sheet img{margin:0!important}.audit-hint{font-size:13px;color:var(--el-text-color-secondary)}
.finance-daily{padding:24px;border:1px solid var(--el-border-color-light);border-radius:12px;background:var(--el-bg-color)}h2{margin:0 0 8px;font-size:20px}header p{margin:0;color:var(--el-text-color-secondary);font-size:13px}.tools,.approval{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin:20px 0}.tools .el-select{width:280px}.issues{padding:14px 18px;margin-bottom:20px;border-radius:8px;background:var(--el-color-warning-light-9);font-size:13px;line-height:1.8}.issues ul{margin:6px 0 0;padding-left:20px}.image-wrap{overflow:auto;border:1px solid var(--el-border-color-light);background:#f5f6f7}.image-wrap img{display:block;width:100%;min-width:900px;max-width:1500px;margin:auto}.approval{border-top:1px solid var(--el-border-color-light);padding-top:18px}.approval .el-checkbox{white-space:normal;height:auto}@media(max-width:650px){.finance-daily{padding:16px}.tools .el-select{width:100%}.approval{align-items:flex-start;flex-direction:column}}
.finance-daily{padding:0;border:0;background:transparent}.finance-heading{margin:4px 0 20px}.eyebrow{display:block;color:var(--el-color-primary);font-size:12px;font-weight:600;margin-bottom:8px}.finance-heading h2{font-size:25px}.generate-card,.send-card{border:1px solid var(--el-border-color-light);background:var(--el-bg-color);border-radius:12px;padding:22px;margin:18px 0}.query-fields{display:grid;grid-template-columns:minmax(260px,1.5fr) minmax(210px,1fr) auto;gap:18px;align-items:end;max-width:1040px}.query-fields label>span,.cost-grid label>span,.bot-field>span{display:block;font-size:13px;color:var(--el-text-color-regular);margin-bottom:9px}.query-fields .el-date-editor{width:100%}.cost-sources{border-top:1px solid var(--el-border-color-lighter);margin-top:22px;padding-top:20px}.section-title{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.section-title h3{font-size:16px;margin:0}.section-title>span,.section-title p,.source-note{font-size:12px;color:var(--el-text-color-secondary);line-height:1.8}.section-title p{margin:6px 0 0}.cost-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px}.cost-grid .el-select{width:100%}.cost-grid small{display:block;font-size:12px;margin-top:8px;color:var(--el-text-color-secondary)}.source-note{margin:14px 0 0}.send-actions{display:flex;align-items:end;gap:18px;margin-bottom:20px}.bot-field{width:280px}.bot-field .el-select{width:100%}.send-card .el-checkbox{white-space:normal;height:auto;align-items:flex-start}.send-card :deep(.el-checkbox__label){white-space:normal;line-height:1.6}.send-card :deep(.el-checkbox__input){margin-top:4px}.cost-basis{display:inline-block;margin:10px 20px 0 0;font-size:12px;color:var(--el-text-color-secondary)}@media(max-width:850px){.query-fields{grid-template-columns:1fr 1fr}.query-fields>.el-button{justify-self:start}.cost-grid{grid-template-columns:1fr}.section-title{align-items:flex-start;flex-direction:column}.send-actions{align-items:stretch;flex-direction:column}.bot-field{width:100%}}@media(max-width:550px){.query-fields{grid-template-columns:1fr}.generate-card,.send-card{padding:18px}}
.bot-field{width:min(500px,100%)}.send-results{display:grid;gap:12px;border-top:1px solid var(--el-border-color-lighter);margin-top:20px;padding-top:16px}.send-results>div{display:flex;align-items:center;flex-wrap:wrap;gap:12px;font-size:13px}.send-results span{color:var(--el-text-color-secondary)}
</style>


