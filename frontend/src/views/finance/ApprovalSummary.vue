<template>
 <div class="ledger-page">
  <section class="card-compact">
   <h2>请款审批清单</h2><p>统一查看各平台的请款／报销摘要。财务核实款项付清、上传付款凭证后确认完成。历史已通过单据尚未核实付款，不据此认定未付款。</p>
   <div class="ledger-tools">
    <el-date-picker v-model="period" type="month" value-format="YYYY-MM" :clearable="false" :disabled="loading" @change="criteriaChanged"/>
    <el-select v-model="platform" :disabled="loading" aria-label="来源平台筛选" placeholder="全部已接通平台" clearable style="width:170px" @change="criteriaChanged"><el-option v-for="p in platforms" :key="p.value" :value="p.value" :label="p.label+(p.imported===false?'（暂无导入）':'')"/></el-select>
    <el-select v-model="storeId" aria-label="发起门店筛选" :disabled="loading||!stores.length" :placeholder="stores.length?'全部发起门店':'查询后可选择门店'" clearable filterable style="width:220px" @change="criteriaChanged"><el-option v-for="s in stores" :key="s.id" :value="s.id" :label="s.store_name"/></el-select>
    <el-select v-model="storeMatch" :disabled="loading" aria-label="门店对应状态筛选" placeholder="全部对应状态" clearable style="width:165px" @change="criteriaChanged"><el-option label="已对应门店" value="matched"/><el-option label="待核对" value="unmatched"/><el-option label="同名冲突" value="ambiguous"/><el-option label="总部／非门店" value="non_store"/><el-option label="门店档案缺失" value="missing_store"/></el-select>
    <el-input v-model="q" :disabled="loading" placeholder="查单号、申请人、门店或事由" clearable style="width:270px" @input="criteriaChanged"/><el-button type="primary" :loading="loading" @click="queryApprovals">查询／更新</el-button>
   </div>
   <p>发起门店按原申请部门对应后台档案，不等同于费用归属门店；跨店、总部申请保留原部门和事由。</p>
   <p v-if="hasQueried&&latest">平台数据最近读取 {{platformName(latest.platform)}} · 范围 {{latest.date_from}} 至 {{latest.date_to}} · 最后读取 {{localTime(latest.fetched_at)}}</p><p v-if="hasQueried&&queriedAt">本次查询时间 {{localTime(queriedAt)}} · 已先同步钉钉最新审批</p><p v-if="hasQueried&&syncNotice">{{syncNotice}}</p><p v-if="loading" class="query-prompt" role="status">{{syncMessage}}，请稍候…</p><p v-if="!hasQueried&&!loading" class="query-prompt" role="status">{{queryPrompt}}</p><p v-if="error" role="alert" class="ledger-error">{{error}}</p>
  </section>
  <section class="card-compact">
   <div class="summary-tabs" role="group" aria-label="审批状态筛选"><button v-for="(label,key) in mainStates" :key="key" type="button" :class="{active:state===key}" :aria-pressed="state===key" :disabled="loading" @click="filter(key)">{{label}} <span>{{hasQueried?(key?counts[key]||0:totalCount):'—'}}</span></button></div>
   <p v-if="hasQueried&&exceptionCount">另有 {{exceptionCount}} 条撤销或待核对记录。<el-button link @click="filter('withdrawn')">已撤销 {{counts.withdrawn||0}}</el-button><el-button link @click="filter('review')">变更待核对 {{counts.review||0}}</el-button><el-button v-if="counts.unknown" link @click="filter('unknown')">状态待核 {{counts.unknown}}</el-button></p>
   <el-table :data="items" v-loading="loading" :empty-text="loading?'正在查询…':hasQueried?'当前范围暂无审批记录':'请点击上方“查询／更新”加载记录'">
    <el-table-column prop="platform_label" label="来源平台" width="100"/><el-table-column prop="business_no" label="审批单号" min-width="180" show-overflow-tooltip/>
    <el-table-column label="申请人" width="100"><template #default="{row}">{{row.applicant_name||'待匹配姓名'}}</template></el-table-column>
    <el-table-column label="发起门店／原部门" min-width="215"><template #default="{row}"><span :title="matchLabel(row.store_match)">{{row.store_match.store_name}}</span><small class="store-match-hint" :title="row.department">{{row.department||'未提供原部门'}}</small></template></el-table-column>
    <el-table-column label="金额" width="125"><template #default="{row}">{{row.amount_cents===null?'待核金额':yuan(row.amount_cents)}}</template></el-table-column><el-table-column label="状态" width="125"><template #default="{row}"><el-tag :type="tones[row.state]||'info'">{{row.state_label}}</el-tag></template></el-table-column>
    <el-table-column label="事由" min-width="220" show-overflow-tooltip><template #default="{row}">{{row.reason||row.title}}</template></el-table-column>
    <el-table-column label="申请时间（源记录）" min-width="165"><template #default="{row}">{{sourceTime(row.source_created_at)}}</template></el-table-column>
    <el-table-column label="操作" width="120" fixed="right"><template #default="{row}"><el-button link type="primary" @click="ask(row,canConfirm(row)?'complete':'details')">{{canConfirm(row)?'确认款项':'查看详情'}}</el-button></template></el-table-column>
   </el-table><el-pagination :disabled="loading" :current-page="page" :page-size="50" :total="total" layout="total,prev,pager,next" @current-change="changePage"/>
  </section>
  <ApprovalPaymentDialog v-model="dialog" :row="selected" :mode="action" @saved="paymentSaved"/>
 </div>
</template>
<script setup>
import {computed,inject,onActivated,onDeactivated,ref} from 'vue'
import {businessLedgerApi} from '@/api'
import ApprovalPaymentDialog from '@/components/ApprovalPaymentDialog.vue'
import '@/styles/business-ledger.css'
const api=inject('approvalSummaryApi',businessLedgerApi)
const period=ref(new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(new Date())),q=ref(''),state=ref(''),page=ref(1),items=ref([]),counts=ref({}),total=ref(0),latest=ref(null),loading=ref(false),error=ref('')
const platform=ref(''),storeId=ref(''),storeMatch=ref(''),platforms=ref([{value:'dingtalk',label:'钉钉'},{value:'wecom',label:'企业微信'}]),stores=ref([]),dialog=ref(false),selected=ref(null),action=ref('complete')
const mainStates={'':'全部',in_progress:'进行中',rejected:'已驳回',approved:'已通过',completed:'已完成'},tones={in_progress:'info',rejected:'danger',approved:'warning',completed:'success',review:'danger'}
const totalCount=computed(()=>Object.values(counts.value).reduce((s,n)=>s+n,0)),exceptionCount=computed(()=>(counts.value.withdrawn||0)+(counts.value.unknown||0)+(counts.value.review||0))
const yuan=v=>'￥'+(v/100).toFixed(2),localTime=v=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—',sourceTime=v=>v?String(v).replace('T',' ').replace(/Z$/,''):'—',platformName=v=>({dingtalk:'钉钉',wecom:'企业微信'})[v]||v
const matchLabel=m=>m.status==='matched'?(m.method==='confirmed'?'管理员已核对':'名称唯一对应'):({ambiguous:'存在同名档案',missing_store:'原对应门店档案缺失',unmatched:'需核对名称或部门归属',non_store:'管理员已核对'})[m.status]
const hasQueried=ref(false),queriedAt=ref(''),syncMessage=ref(''),syncNotice=ref(''),queryPrompt=ref('请设置查询条件，点击“查询／更新”获取数据。')
let generation=0
function invalidate(message,{keepTotal=false}={}){generation++;loading.value=false;items.value=[];counts.value={};if(!keepTotal)total.value=0;hasQueried.value=false;error.value='';queriedAt.value='';queryPrompt.value=message;syncMessage.value='';syncNotice.value=''}
async function queryApprovals(){
 if(loading.value)return
 const n=++generation,params={period:period.value,q:q.value,state:state.value,page:page.value,platform:platform.value,store_id:storeId.value,store_match:storeMatch.value}
 loading.value=true;error.value='';items.value=[];hasQueried.value=false
 try{
  syncMessage.value='正在连接审批平台';let job=(await api.startApprovalQuery(params)).job
  while(n===generation&&job.status==='running'){syncMessage.value=job.progress.phase+(job.progress.total?`（${job.progress.done}/${job.progress.total}）`:'');await new Promise(resolve=>setTimeout(resolve,1000));if(n!==generation)return;job=(await api.approvalQuery(job.id)).job}
  if(n!==generation)return
  if(job.status!=='succeeded')throw new Error(job.error||'平台同步未完成，请重试')
  const r=job.result||((await api.approvalQuery(job.id)).job.result);if(n===generation){items.value=r.items;counts.value=r.counts;total.value=r.total;latest.value=r.latest;platforms.value=r.platforms;stores.value=r.stores;queriedAt.value=r.queried_at;syncNotice.value=r.sync.notice;hasQueried.value=true}}
 catch(e){if(n===generation){error.value=e.message;counts.value={};total.value=0;queryPrompt.value='查询未完成，请点击“查询／更新”重试。'}}finally{if(n===generation)loading.value=false}
}
function criteriaChanged(){page.value=1;invalidate('查询条件已改变，请点击“查询／更新”加载结果。')}
function filter(key){state.value=key;criteriaChanged()}
function changePage(value){if(!total.value||value===page.value)return;page.value=value;invalidate(`已选择第${value}页，请点击“查询／更新”加载本页。`,{keepTotal:true})}
function paymentSaved(){invalidate('款项记录已更新，请点击“查询／更新”查看最新结果。')}

const canConfirm=row=>row.source_status==='COMPLETED'&&row.source_result==='agree'&&(!row.completed_at||row.needs_review)
function ask(row,kind){selected.value=row;action.value=kind;dialog.value=true}
onActivated(()=>{page.value=1;invalidate('请设置查询条件，点击“查询／更新”获取数据。')});onDeactivated(()=>{dialog.value=false;generation++;loading.value=false})
</script>
<style scoped>
.query-prompt{padding:10px 12px;border-radius:6px;background:var(--el-color-primary-light-9);color:var(--el-color-primary);font-size:13px;line-height:1.8}
.summary-tabs{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:16px}.summary-tabs button{border:1px solid var(--el-border-color);border-radius:6px;background:var(--el-bg-color);color:var(--el-text-color-regular);padding:10px 16px;font:inherit;cursor:pointer}.summary-tabs button.active{background:var(--el-color-primary-light-9);border-color:var(--el-color-primary);color:var(--el-color-primary)}.summary-tabs button span{margin-left:8px;font-size:12px}.summary-tabs button:focus-visible{outline:2px solid var(--el-color-primary);outline-offset:2px}.store-match-hint{display:block;color:var(--el-text-color-secondary)}
</style>
