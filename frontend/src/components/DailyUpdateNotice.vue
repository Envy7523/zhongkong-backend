<template>
 <button class="daily-health-trigger" :class="{attention:needsAttention}" :title="ackSaveError || '查看每日数据更新情况'" @click="openManually"><el-icon><DataLine /></el-icon><span>每日更新</span><b v-if="needsAttention">{{data?.failures||'!'}}</b></button>
 <NotificationDialog :model-value="visible" @update:model-value="onVisibilityChange" title="每日数据更新核验" subtitle="关闭即记为今日已读，仍可从顶栏手动查看。" :tone="needsAttention?'warning':'success'" width="min(780px,96vw)">
  <div v-loading="loading" class="notice-body">
   <el-alert v-if="error" type="error" :closable="false" :title="error" description="暂不能确认更新结果，可稍后从顶栏重新检测。"/>
   <template v-if="data">
    <div class="notice-summary"><span>营业日 <b>{{data.business_date}}</b></span><span>已通过 <b>{{data.passed}} / {{data.enabled}}</b></span><span>近7天需关注 <b>{{data.failures}}</b> 项</span><el-button link type="primary" @click="showAll=!showAll">{{showAll?'只看需关注':'查看全部项目'}}</el-button></div>
    <el-empty v-if="!groups.length" :image-size="48" description="昨日没有需关注项目" />
    <section v-for="group in groups" :key="group.key" class="source-section">
     <h3>{{group.name}}</h3>
     <div v-for="r in group.rows" :key="r.type" class="source-row">
      <div class="report-name">{{r.name}}<small v-if="showAll">计划 {{r.planned_time||'未配置'}} 更新</small></div>
      <span class="health-state" :class="r.status">{{labels[r.status]||'待核验'}}</span>
      <div class="check-reason" :title="r.reason">{{r.reason}}<template v-if="showAll"><div v-if="r.unmatched_stores?.length" class="missing-stores">待匹配来源：{{r.unmatched_stores.join('、')}}</div><div v-if="r.missing?.length" class="missing-stores">缺少：{{r.missing.map(s=>s.store_name).join('、')}}</div><small v-if="r.records!=null">{{r.storage==='snapshot'?'已保存':'库中'}} {{r.records}} 条<template v-if="r.expected!=null"> · {{r.actual}} / {{r.expected}} 家门店</template></small><small v-if="r.updated_at">最近记录 {{format(r.updated_at)}}</small></template></div>
      <el-button link type="primary" @click="inspect(r)">检查</el-button>
     </div>
    </section>
    <el-collapse v-if="history.length" class="history-check"><el-collapse-item :title="'较早日期待核对（'+history.length+'项）'" name="history"><div v-for="r in history" :key="r.business_date+r.type" class="historical-row"><div><b>{{r.business_date}} · {{r.name}}</b><p>{{r.reason}}</p><p v-if="r.missing?.length">缺少：{{r.missing.map(s=>s.store_name).join('、')}}</p></div><span class="health-state" :class="r.status">{{labels[r.status]}}</span><el-button link type="primary" @click="inspect(r)">检查</el-button></div></el-collapse-item></el-collapse>
    <p class="notice-note">只核验数据更新，不代表日报已发送；已读不会解决数据异常。</p>
   </template>
  </div>
  <template #footer><el-button :icon="Refresh" :loading="loading" @click="check(true)">重新检测</el-button><el-button @click="inspect()">采集记录</el-button><el-button type="primary" @click="ack">关闭，今日不再提示</el-button></template>
 </NotificationDialog>
</template>
<script setup>
import NotificationDialog from './NotificationDialog.vue'
import {ref,computed,onMounted,onBeforeUnmount} from 'vue'
import {useRouter} from 'vue-router'
import {DataLine,Refresh} from '@element-plus/icons-vue'
import {dailyUpdateHealthApi as api} from '@/api'
const props=defineProps({previewReport:{type:Object,default:null},userId:{type:[Number,String],default:''}}),emit=defineEmits(['preview-inspect'])
const router=useRouter(),visible=ref(false),data=ref(null),error=ref(''),loading=ref(false),showAll=ref(false),ackSaveError=ref('')
const labels={passed:'通过',failed:'失败',waiting_human:'待人工处理',missing:'数据缺失',unverified:'待核验',unconfigured:'未配置',disabled:'未启用',running:'执行中',delayed:'执行超时',pending:'待执行'}
const groups=computed(()=>[{key:'cashier',name:'收银系统'},{key:'douyin',name:'抖音'},{key:'meituan',name:'美团'},{key:'taobao_flash',name:'淘宝闪购'},{key:'jd_delivery',name:'京东外卖'},{key:'staff',name:'人事每日任务'}].map(g=>({...g,rows:(data.value?.rows||[]).filter(r=>r.group===g.key&&r.business_date===data.value.business_date&&(showAll.value||r.enabled&&r.status!=='passed'||r.status==='unconfigured'))})).filter(g=>g.rows.length))
const history=computed(()=>(data.value?.rows||[]).filter(r=>r.business_date!==data.value.business_date))
const format=v=>new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})
const needsAttention=computed(()=>!!error.value||!data.value||data.value.failures>0||!data.value.enabled||data.value.rows.some(r=>r.business_date===data.value.business_date&&r.status==='unconfigured'))
const today=()=>new Date(Date.now()+28800000).toISOString().slice(0,10)
const storageKey=()=>props.userId?'daily-update-read:'+props.userId:''
let timer,lastErrorDay='',lastChecked=0,inspectingFingerprint='',dismissedDay=''
function wasRead(day){if(dismissedDay===day)return true;try{return !!storageKey()&&localStorage.getItem(storageKey())===day}catch{return false}}
function rememberRead(day){dismissedDay=day;try{if(storageKey())localStorage.setItem(storageKey(),day)}catch{/* Memory and server acknowledgement still work. */}}
async function check(force=false){
 if(props.previewReport){data.value=props.previewReport;error.value='';visible.value=true;return}
 if(loading.value||!force&&(wasRead(today())||Date.now()-lastChecked<30000))return
 loading.value=true;lastChecked=Date.now()
 try{const result=await api.get();data.value=result;error.value='';if(force||result.should_popup&&!wasRead(today())&&result.fingerprint!==inspectingFingerprint)visible.value=true}
 catch(e){error.value=e.message||'未能读取每日数据更新结果';const day=today();if(force||!wasRead(day)&&day!==lastErrorDay){visible.value=true;lastErrorDay=day}}
 finally{loading.value=false}
}
function openManually(){visible.value=true;check(true)}
function onFocus(){if(document.visibilityState==='visible')check()}
function onStorage(event){if(event.key===storageKey()&&event.newValue===today()){dismissedDay=event.newValue;visible.value=false}}
function onVisibilityChange(value){if(value)visible.value=true;else ack()}
async function ack(){
 visible.value=false
 if(props.previewReport)return
 const day=today();rememberRead(day);if(data.value)data.value.should_popup=false
 ackSaveError.value=''
 try{await api.ack({check_day:day,fingerprint:data.value?.fingerprint||''})}
 catch{ackSaveError.value='今日已在本设备记为已读；服务器同步未完成。'}
}
function inspect(row){if(props.previewReport){visible.value=false;emit('preview-inspect',row);return}inspectingFingerprint=data.value?.fingerprint||'';ack();if(row?.type==='dingtalk_attendance'){router.push('/staff-management/daily-tasks');return}router.push({path:'/data-import/pos/automation',query:{...(row?{report_type:row.type,business_date:row.business_date}:data.value?{business_date:data.value.business_date}:{})}})}
onMounted(()=>{check();if(props.previewReport)return;timer=setInterval(()=>{if(document.visibilityState==='visible')check()},60000);window.addEventListener('focus',onFocus);window.addEventListener('storage',onStorage);document.addEventListener('visibilitychange',onFocus)})
onBeforeUnmount(()=>{clearInterval(timer);window.removeEventListener('focus',onFocus);window.removeEventListener('storage',onStorage);document.removeEventListener('visibilitychange',onFocus)})
</script>
<style scoped>
.daily-health-trigger{display:flex;align-items:center;gap:7px;border:1px solid var(--el-border-color-light);background:var(--el-bg-color);border-radius:8px;padding:6px 10px;min-height:34px;font-size:12px;color:var(--el-text-color-regular);cursor:pointer;white-space:nowrap}.daily-health-trigger>.el-icon{font-size:16px}.daily-health-trigger.attention{color:#b36e24;border-color:#eed9bb;background:#fffbf4}.daily-health-trigger b{font-size:10px;background:#d88232;color:white;min-width:16px;line-height:16px;border-radius:5px;text-align:center;padding:0 3px}
.notice-body{max-height:52vh;overflow:auto;padding-right:6px}.notice-summary{display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px;font-size:12px;padding:0 0 14px;color:var(--el-text-color-secondary)}.notice-summary b{color:var(--el-text-color-primary)}.notice-summary .el-button{margin-left:auto}.source-section{margin-bottom:12px;border:1px solid var(--el-border-color-lighter);border-radius:8px;overflow:hidden}.source-section h3{font-size:13px;margin:0;padding:9px 12px;background:var(--el-fill-color-light)}.source-row{display:grid;grid-template-columns:minmax(120px,1fr) 78px minmax(120px,1.5fr) 36px;gap:10px;align-items:start;padding:10px 12px;border-top:1px solid var(--el-border-color-lighter);font-size:12px;line-height:1.6}.report-name{font-weight:500}.report-name small,.check-reason small{display:block;font-size:11px;color:var(--el-text-color-secondary);font-weight:400}.check-reason{color:var(--el-text-color-secondary);overflow-wrap:anywhere}.health-state{font-size:11px;width:fit-content;padding:2px 6px;border-radius:4px;background:var(--el-fill-color-light);color:var(--el-text-color-secondary);white-space:nowrap}.health-state.passed{background:#eff8f2;color:#4b8d66}.health-state.failed,.health-state.missing,.health-state.delayed{background:#fff1ec;color:#b85839}.health-state.waiting_human,.health-state.unverified,.health-state.unconfigured{background:#fff7e9;color:#a77c3a}.missing-stores{color:#b85839;font-size:11px}.history-check{margin-top:12px}.historical-row{display:grid;grid-template-columns:1fr 78px 36px;gap:10px;padding:10px 0;border-bottom:1px solid var(--el-border-color-lighter);font-size:12px}.historical-row p{font-size:11px;color:var(--el-text-color-secondary);margin:5px 0}.notice-note{font-size:11px;color:var(--el-text-color-secondary);margin:12px 0 0;line-height:1.6}@media(max-width:600px){.source-row{grid-template-columns:1fr 74px 36px}.check-reason{grid-row:2;grid-column:1/-1}.source-row>.el-button{grid-column:3;grid-row:1}.notice-summary .el-button{margin-left:0}.historical-row{grid-template-columns:1fr 66px 32px}}
</style>
