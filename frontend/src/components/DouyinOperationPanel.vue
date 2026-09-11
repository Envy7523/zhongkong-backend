<template>
  <section class="dy-panel" v-loading="loading">
    <header><div><h3>抖音团购门店经营</h3><p>下单转化率按购买人数 ÷ 访问人数计算；评分与累计评价取各门店期末记录。</p></div><span>{{ result.stores_count }} 家门店 · {{ result.days }} 天</span></header>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <template v-else-if="result.days">
      <div class="dy-metrics"><article v-for="m in metrics" :key="m.key"><span>{{ m.label }}</span><strong>{{ format(result.totals[m.key],m.key) }}</strong></article></div>
      <div class="dy-controls"><button :class="{active:selected==='traffic'}" @click="selected='traffic'">流量转化</button><button :class="{active:selected==='rating'}" @click="selected='rating'">评分评价</button><span>点击图例可单独显示或隐藏字段</span></div>
      <div ref="chartEl" class="dy-chart"></div>
      <el-table :data="result.stores" stripe>
        <el-table-column prop="store_name" label="门店" min-width="220" />
        <el-table-column v-for="m in metrics" :key="m.key" :label="m.label" min-width="130" align="right"><template #default="{row}">{{ format(row[m.key],m.key) }}</template></el-table-column>
      </el-table>
    </template>
    <el-empty v-else description="当前范围暂无门店经营数据，请导入抖音门店经营表" />
  </section>
</template>
<script setup>
import {ref,watch,nextTick,onBeforeUnmount} from 'vue'
import * as echarts from 'echarts'
import {getMeituanOperation} from '@/api'
const props=defineProps({params:{type:Object,required:true},revision:{type:Number,default:0}})
const result=ref({totals:{},stores:[],trend:[],days:0,stores_count:0}),loading=ref(false),error=ref(''),chartEl=ref(),selected=ref('traffic')
const metrics=[{key:'visit_users',label:'访问人数',group:'traffic'},{key:'ordering_users',label:'购买人数',group:'traffic'},{key:'order_rate',label:'下单转化率',group:'traffic'},{key:'store_rating',label:'门店评分',group:'rating'},{key:'review_count',label:'累计评价数',group:'rating'}]
let chart,sequence=0
function format(v,k){if(v==null)return '—';return k==='order_rate'?(v*100).toFixed(1)+'%':k==='store_rating'?Number(v).toFixed(1):Number(v).toLocaleString('zh-CN')}
function render(){
 if(!chartEl.value)return
 if(chart&&chart.getDom()!==chartEl.value){chart.dispose();chart=null}
 chart=chart||echarts.init(chartEl.value)
 const group=metrics.filter(m=>m.group===selected.value)
 chart.setOption({tooltip:{trigger:'axis'},legend:{top:4},grid:{left:55,right:60,top:55,bottom:35},xAxis:{type:'category',data:result.value.trend.map(r=>r.date)},yAxis:[{type:'value',scale:selected.value==='rating',axisLabel:{formatter:v=>selected.value==='rating'?Number(v).toFixed(1):v}},{type:'value',splitLine:{show:false}}],series:group.map((m,i)=>({name:m.label,type:['order_rate','store_rating'].includes(m.key)?'line':'bar',yAxisIndex:['order_rate','review_count'].includes(m.key)?1:0,barMaxWidth:22,symbolSize:6,itemStyle:{color:['#3b82f6','#14b8a6','#8b5cf6'][i]},data:result.value.trend.map(r=>m.key==='order_rate'?(r[m.key]==null?null:Number((r[m.key]*100).toFixed(1))):r[m.key]),tooltip:{valueFormatter:v=>m.key==='order_rate'?v+'%':format(v,m.key)}}))},true)
}
watch(()=>[props.params,props.revision],async()=>{
 const request=++sequence;loading.value=true;error.value=''
 try{const r=await getMeituanOperation({...props.params,platform:'抖音团购'});if(request!==sequence)return;result.value=r;await nextTick();render()}catch(e){if(request===sequence)error.value=e.message||'经营数据加载失败'}finally{if(request===sequence)loading.value=false}
},{deep:true,immediate:true})
watch(selected,()=>nextTick(render))
const observer=new ResizeObserver(()=>chart?.resize())
watch(chartEl,el=>{observer.disconnect();if(el)observer.observe(el)})
onBeforeUnmount(()=>{sequence++;observer.disconnect();chart?.dispose()})
</script>
<style scoped>
.dy-panel{margin:0 0 18px;border:1px solid #dce6f3;border-radius:12px;background:#fff;overflow:hidden}.dy-panel header{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:18px 20px;border-bottom:1px solid #e8eef6}.dy-panel h3{margin:0;font-size:16px;color:#16314f}.dy-panel p,.dy-panel header>span{font-size:12px;color:#7b8da4}.dy-panel p{margin:6px 0 0}.dy-metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;padding:18px}.dy-metrics article{padding:16px;border:1px solid #e0e9f5;border-radius:9px}.dy-metrics span{display:block;color:#718096;font-size:12px}.dy-metrics strong{display:block;margin-top:8px;font-size:21px;color:#2563eb;font-variant-numeric:tabular-nums}.dy-controls{display:flex;gap:8px;padding:0 18px;flex-wrap:wrap}.dy-controls button{padding:7px 12px;border:1px solid #dbe5f4;border-radius:7px;background:#fff;color:#65758a;cursor:pointer}.dy-controls .active{background:#eff6ff;color:#2563eb;border-color:#93b8ff}.dy-chart{height:310px;margin:12px}@media(max-width:900px){.dy-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>