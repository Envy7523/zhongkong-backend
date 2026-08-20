<template>
  <div class="analytics-subpage">
    <AnalysisPerspectiveNav /><AnalysisSectionNav />
    <section class="subpage-hero"><div><span>PRODUCT PERFORMANCE</span><h2>{{ scopeLabel }} · 商品销售数据</h2><p>平台商品完成标准菜品绑定后，按销量自动计算成本与毛利。</p></div><el-button plain @click="loadData">刷新数据</el-button></section>
    <section class="filters">
      <el-select v-model="filters.store_id" clearable filterable placeholder="全部门店" @change="loadData"><el-option v-for="store in stores" :key="store.id" :label="store.store_name" :value="store.id" /></el-select>
      <el-date-picker v-model="filters.range" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" @change="loadData" />
    </section>
    <section class="metrics"><div><span>商品销量</span><b>{{ number(data.totals.quantity) }}</b></div><div><span>商品销售额</span><b>{{ money(data.totals.sales_amount) }}</b></div><div><span>已核算成本</span><b>{{ money(data.totals.total_cost) }}</b></div><div><span>关联完成度</span><b>{{ data.totals.mapped }}/{{ data.totals.total_products }}</b></div></section>
    <section class="panel" v-loading="loading"><header><h3>平台商品销售与成本</h3><small>未关联商品不会进入成本与毛利计算</small></header>
      <el-table :data="data.products" height="520">
        <el-table-column prop="platform" label="平台" width="120" /><el-table-column prop="product_name" label="平台商品" min-width="180" show-overflow-tooltip />
        <el-table-column label="标准菜品" min-width="170"><template #default="{row}"><span v-if="row.mapped">{{ row.menu_name }}</span><el-tag v-else type="warning" size="small">待关联</el-tag></template></el-table-column>
        <el-table-column label="销量" width="90" align="right"><template #default="{row}">{{ number(row.quantity) }}</template></el-table-column>
        <el-table-column label="销售额" width="115" align="right"><template #default="{row}">{{ money(row.sales_amount) }}</template></el-table-column>
        <el-table-column label="单位成本" width="105" align="right"><template #default="{row}">{{ row.mapped ? money(row.unit_cost) : '—' }}</template></el-table-column>
        <el-table-column label="总成本" width="110" align="right"><template #default="{row}">{{ row.mapped ? money(row.total_cost) : '—' }}</template></el-table-column>
        <el-table-column label="商品毛利" width="115" align="right"><template #default="{row}"><b v-if="row.mapped" :class="row.gross_profit < 0 ? 'negative' : 'positive'">{{ money(row.gross_profit) }}</b><span v-else>—</span></template></el-table-column>
      </el-table><el-empty v-if="!loading && !data.products.length" description="暂无商品销售数据，请先导入平台商品明细" />
    </section>
  </div>
</template>
<script setup>
import { computed,onMounted,reactive,ref,watch } from 'vue';import { useRoute } from 'vue-router';import { ElMessage } from 'element-plus';import { getBusinessProductAnalytics,getStores } from '@/api';import AnalysisPerspectiveNav from './AnalysisPerspectiveNav.vue';import AnalysisSectionNav from './AnalysisSectionNav.vue'
const route=useRoute(),loading=ref(false),stores=ref([]),filters=reactive({store_id:null,range:[]}),data=reactive({products:[],totals:{}})
const scope=computed(()=>({group:'overview','group-buy':'group-buy',delivery:'delivery'})[route.params.perspective]||'overview');const scopeLabel=computed(()=>({overview:'集团总视角','group-buy':'团购视角',delivery:'外卖视角'})[scope.value]);const money=v=>`¥${Number(v||0).toFixed(2)}`;const number=v=>Number(v||0).toLocaleString('zh-CN',{maximumFractionDigits:2})
async function loadData(){loading.value=true;try{Object.assign(data,await getBusinessProductAnalytics(scope.value,{store_id:filters.store_id||undefined,date_from:filters.range?.[0],date_to:filters.range?.[1]}))}catch(e){ElMessage.error(e.message)}finally{loading.value=false}}
watch(()=>route.params.perspective,loadData);onMounted(async()=>{const r=await getStores({page:1,page_size:500}).catch(()=>[]);stores.value=r.stores||r.items||r.data||(Array.isArray(r)?r:[]);await loadData()})
</script>
<style scoped>
.analytics-subpage{color:#172033}.subpage-hero{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:14px;padding:24px 27px;border-radius:17px;color:#fff;background:linear-gradient(125deg,#172b5f,#466ba8)}.subpage-hero span{font-size:9px;letter-spacing:.16em;opacity:.7}.subpage-hero h2{margin:6px 0;font-size:23px}.subpage-hero p{margin:0;font-size:11px;opacity:.75}.filters{display:flex;gap:12px;margin-bottom:13px;padding:12px;border:1px solid #e5e9f0;border-radius:13px;background:#fff}.filters .el-select{width:220px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:13px}.metrics div,.panel{border:1px solid #e5e9f0;border-radius:13px;background:#fff}.metrics div{padding:16px}.metrics span,.metrics b{display:block}.metrics span{color:#8792a4;font-size:10px}.metrics b{margin-top:8px;font-size:20px}.panel{overflow:hidden}.panel header{display:flex;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #edf0f4}.panel h3{margin:0;font-size:14px}.panel small{color:#929cad}.positive{color:#168564}.negative{color:#d04f48}@media(max-width:760px){.metrics{grid-template-columns:1fr 1fr}.filters{flex-direction:column}.filters .el-select{width:100%}}
</style>
