<template>
  <section class="order-insights" aria-label="订单走势与菜品销售">
    <header class="insights-heading"><div><h3>订单走势与菜品销售</h3><p>独立选择日期、每日时段和平台，查看已导入的下单记录。单次最多 93 天。</p></div><span class="source-badge">按下单时间</span></header>
    <form class="insights-filters" @submit.prevent="query()">
      <label class="date-field"><span>营业日期</span><el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" range-separator="至" :clearable="false" /></label>
      <div class="clock-field"><span>每日时段</span><div><el-select v-model="timeFrom" aria-label="开始时刻"><el-option v-for="t in startClocks" :key="t" :value="t" :label="t"/></el-select><span>至</span><el-select v-model="timeTo" aria-label="结束时刻"><el-option v-for="t in endClocks" :key="t" :value="t" :label="t"/></el-select></div></div>
      <label class="platform-field"><span>平台／渠道</span><el-select v-model="channels" multiple collapse-tags collapse-tags-tooltip clearable placeholder="全部平台／渠道"><el-option v-for="p in platformOptions" :key="p.key" :value="p.key" :label="p.label"/></el-select></label>
      <el-button type="primary" native-type="submit" :loading="loading">查询／更新</el-button>
    </form>
    <p v-if="error" class="query-error" role="alert">{{error}}</p>
    <div v-if="result" class="insights-results" :aria-busy="loading">
      <div class="result-toolbar"><div><strong>{{number(result.totals.orders)}} <small>单</small></strong><span>{{appliedPeriod}}</span><p v-if="dirty" class="pending-filter">筛选条件已更改，点击“查询／更新”后生效。</p></div><el-radio-group v-model="granularity" size="small" aria-label="订单统计粒度"><el-radio-button value="hourly">按小时</el-radio-button><el-radio-button value="daily">按日</el-radio-button></el-radio-group></div>
      <div v-if="showChart" ref="chartElement" class="orders-chart" role="img" :aria-label="'订单走势图：'+appliedPeriod"/>
      <el-empty v-else :description="granularity==='hourly'&&result.totals.untimed_orders?'这些订单缺少下单时刻，请切换按日查看':result.coverage.source_days?'所选时段暂无可统计订单，请检查时段和下单时刻覆盖情况':'所选范围尚无可统计的下单记录'" :image-size="64"/>
      <div class="coverage-note"><p>{{result.coverage.source}}。{{result.notes[2]}}</p><p v-if="result.coverage.untimed_lines || result.coverage.unidentified_lines">原范围有 {{number(result.coverage.untimed_lines)}} 条明细缺少有效下单时刻，{{number(result.coverage.unidentified_lines)}} 条缺少订单号。时段统计不将这些明细估算为订单。</p><p v-if="result.coverage.unknown_days.length">{{result.coverage.unknown_days.length}} 天没有可核实订单数据，按日图保留空白。</p><p v-if="result.coverage.missing_store_days">有 {{result.coverage.missing_store_days}} 个门店营业日缺少品项明细或明确零订单记录，结果仅含可取得部分。</p><p>{{result.notes[0]}} {{result.notes[1]}}</p></div>
      <div class="dish-heading"><div><h4>菜品销售明细</h4><p>与上方已查询的日期、时段和平台一致；按原菜品及规格展示。</p></div><form class="dish-search" @submit.prevent="query(true)"><el-input v-model="keyword" clearable placeholder="搜索菜品名称／编码" aria-label="搜索菜品"/><el-button native-type="submit" :disabled="loading">搜索</el-button></form></div>
      <el-table :data="result.dishes.rows" stripe class="insights-table" empty-text="所选范围暂无菜品销售记录">
        <el-table-column prop="channel_label" label="平台／渠道" min-width="130"/>
        <el-table-column prop="product_name" label="菜品" min-width="180" show-overflow-tooltip/>
        <el-table-column prop="spec" label="规格" min-width="110"/>
        <el-table-column prop="product_code" label="原编码" min-width="120" show-overflow-tooltip/>
        <el-table-column label="净销售数量" min-width="110" align="right"><template #default="{row}">{{number(row.quantity)}}</template></el-table-column>
        <el-table-column label="销售全额" min-width="120" align="right"><template #default="{row}">{{money(row.sales_amount)}}</template></el-table-column>
      </el-table>
      <div class="dish-footer"><p>{{result.notes[3]}}</p><el-pagination :current-page="result.dishes.page" :page-size="result.dishes.page_size" :total="result.dishes.total" layout="prev, pager, next" :pager-count="5" :disabled="loading" @current-change="page=>query(true,page)"/></div>
    </div>
    <el-empty v-else description="选择查询范围，点击“查询／更新”查看订单和菜品销售" :image-size="64"/>
  </section>
</template>
<script setup>
import {computed,ref,watch,nextTick,onBeforeUnmount} from 'vue'
import * as echarts from 'echarts'
import {getOrderSalesInsights} from '@/api'

const props=defineProps({reportRange:{type:Array,default:()=>[]},storeScope:{type:Object,default:()=>({})}})
const range=ref([...props.reportRange]),timeFrom=ref('00:00'),timeTo=ref('24:00'),channels=ref([]),keyword=ref(''),granularity=ref('hourly')
const loading=ref(false),error=ref(''),result=ref(null),chartElement=ref(null),applied=ref(null),appliedKeyword=ref('')
const defaults=[['store_sales','店内销售'],['pickup','自提销售'],['meituan_group','美团团购'],['douyin_group','抖音团购'],['meituan_delivery','美团外卖'],['taobao_flash','淘宝闪购'],['jd_delivery','京东外卖']]
const platformOptions=computed(()=>[...new Map([...defaults.map(([key,label])=>({key,label})),...(result.value?.platforms||[])].map(p=>[p.key,p])).values()])
const allClocks=Array.from({length:49},(_,i)=>String(Math.floor(i/2)).padStart(2,'0')+':'+(i%2?'30':'00'))
const startClocks=allClocks.slice(0,-1),endClocks=allClocks
const number=v=>Number(v||0).toLocaleString('zh-CN',{maximumFractionDigits:3}),money=v=>Number(v||0).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})
const draft=()=>({...props.storeScope,date_from:range.value?.[0],date_to:range.value?.[1],time_from:timeFrom.value,time_to:timeTo.value,channels:[...channels.value].sort().join(',')})
const dirty=computed(()=>applied.value&&JSON.stringify(draft())!==JSON.stringify(applied.value))
const appliedPeriod=computed(()=>!result.value?'':`${result.value.period.date_from} 至 ${result.value.period.date_to} · 每日 ${result.value.period.time_from}–${result.value.period.time_to} · ${applied.value?.channels?applied.value.channels.split(',').map(c=>platformOptions.value.find(p=>p.key===c)?.label||c).join('、'):'全部平台／渠道'}`)
const showChart=computed(()=>result.value?.[granularity.value].some(row=>row.total!==null))
let sequence=0,chart=null,observer=null
watch(()=>props.reportRange,v=>{if(!applied.value)range.value=[...v]},{deep:true})
watch(()=>JSON.stringify(props.storeScope),()=>{sequence++;loading.value=false;result.value=null;applied.value=null;error.value='';dispose()})
async function query(reuse=false,page=1){
  const params=reuse?applied.value:draft()
  if(!params?.date_from||!params?.date_to){error.value='请先选择开始和结束日期';return}
  const ticket=++sequence;loading.value=true;error.value=''
  const search=page===1?keyword.value:appliedKeyword.value
  try{
    const data=await getOrderSalesInsights({...params,keyword:search,page,page_size:20})
    if(ticket!==sequence)return
    result.value=data;applied.value={...params};appliedKeyword.value=search;await nextTick();render()
  }catch(e){if(ticket===sequence){result.value=null;error.value=e.message||'查询失败，请稍后重试';dispose()}}
  finally{if(ticket===sequence)loading.value=false}
}
function dispose(){observer?.disconnect();observer=null;chart?.dispose();chart=null}
function render(){
  const el=chartElement.value;if(!el||!result.value)return dispose()
  if(chart?.getDom()!==el)dispose()
  if(!chart){chart=echarts.init(el,null,{renderer:'svg'});observer=new ResizeObserver(()=>chart?.resize());observer.observe(el)}
  const rows=result.value[granularity.value],keys=Object.keys(rows[0]?.channels||{}),labels=new Map(platformOptions.value.map(p=>[p.key,p.label]))
  const totalSeries=keys.length===1?[]:[{name:'全部已选渠道',type:'line',data:rows.map(r=>r.total),connectNulls:false,lineStyle:{width:3},symbolSize:5}]
  chart.setOption({animation:false,tooltip:{trigger:'axis',renderMode:'richText'},legend:{type:'scroll',top:5},grid:{left:18,right:18,top:60,bottom:granularity.value==='daily'?70:30,containLabel:true},xAxis:{type:'category',boundaryGap:false,data:rows.map(r=>r.period)},yAxis:{type:'value',minInterval:1,name:'订单量'},dataZoom:granularity.value==='daily'?[{type:'slider',bottom:8}]:[],series:[...totalSeries,...keys.map(key=>({name:labels.get(key)||key,type:'line',data:rows.map(r=>r.channels[key]),connectNulls:false,symbolSize:4}))]},true)
}
watch(granularity,()=>nextTick(render))
onBeforeUnmount(()=>{sequence++;dispose()})
</script>
<style scoped>
.order-insights{background:#fff;border:1px solid var(--el-border-color-lighter);border-radius:10px;padding:22px;color:var(--el-text-color-primary);min-width:0;margin:20px 0}
.insights-heading,.result-toolbar,.dish-heading,.dish-footer{display:flex;align-items:center;justify-content:space-between;gap:16px}.insights-heading h3{margin:0;font-size:16px}.insights-heading p,.dish-heading p,.coverage-note,.dish-footer p{font-size:12px;color:var(--el-text-color-secondary);line-height:1.7;margin:7px 0 0}.source-badge{font-size:12px;color:#2563eb;background:#eff6ff;padding:5px 9px;border-radius:5px;white-space:nowrap}
.insights-filters{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;margin:22px 0}.insights-filters label,.clock-field{display:flex;flex-direction:column;gap:8px;font-size:12px;color:var(--el-text-color-regular)}.date-field{width:280px}.date-field :deep(.el-date-editor){width:100%;min-width:0;box-sizing:border-box}.clock-field>div{display:flex;align-items:center;gap:8px}.clock-field .el-select{width:100px}.platform-field{min-width:220px;flex:1;max-width:350px}
.result-toolbar{padding:18px 0 8px;border-top:1px solid var(--el-border-color-lighter)}.result-toolbar strong{font-size:25px;margin-right:18px;font-variant-numeric:tabular-nums}.result-toolbar strong small{font-size:12px;font-weight:400}.result-toolbar span{font-size:12px;color:var(--el-text-color-secondary)}.orders-chart{height:340px;width:100%}.coverage-note{background:#f8fafc;padding:10px 14px;border-radius:6px}.coverage-note p{margin:3px 0}.pending-filter{color:#a76a16;font-size:12px;margin:7px 0}.query-error{color:#b42318;background:#fff2f0;padding:12px;border-radius:6px;font-size:13px}.dish-heading{margin:25px 0 16px}.dish-heading h4{font-size:14px;margin:0}.dish-search{display:flex;gap:8px;width:300px}.dish-footer{align-items:flex-start;padding-top:14px}.dish-footer p{margin:0;max-width:65%}.insights-table{font-variant-numeric:tabular-nums}
@media(max-width:700px){.order-insights{padding:16px}.insights-heading{align-items:flex-start}.insights-filters{gap:14px 10px}.date-field,.platform-field{width:100%;max-width:none;flex:auto}.clock-field{flex:1}.clock-field .el-select{width:95px}.result-toolbar{align-items:flex-start;flex-wrap:wrap}.result-toolbar strong{display:block;margin-bottom:8px}.dish-heading,.dish-footer{align-items:stretch;flex-direction:column}.dish-search{width:100%}.dish-footer p{max-width:100%}.orders-chart{height:300px}.source-badge{font-size:11px}}
</style>
