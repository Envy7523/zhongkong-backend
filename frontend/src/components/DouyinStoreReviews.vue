<template>
  <section class="panel dy-reviews" v-loading="loading">
    <header class="dy-header">
      <div><h3>抖音门店评价</h3><p>最新门店指标 · {{ stamp(result.updatedAt) }} 更新</p></div>
    </header>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-table v-if="multipleStores && result.stores?.length" :data="result.stores" class="dy-store-table" stripe>
      <el-table-column prop="storeName" label="门店" min-width="210" fixed />
      <el-table-column label="评分" width="90"><template #default="{row}">{{ row.score == null ? '暂无评分' : row.score + ' 分' }}</template></el-table-column>
      <el-table-column prop="yesterdayReviews" label="昨日新增评价" min-width="120" />
      <el-table-column prop="yesterdayPoorReviews" label="昨日新增中差评" min-width="140" />
      <el-table-column label="好评率" width="100"><template #default="{row}">{{ percent(row.goodRatePercent) }}</template></el-table-column>
      <el-table-column label="近30天好评率" min-width="130"><template #default="{row}">{{ percent(row.goodRate30dPercent) }}</template></el-table-column>
      <el-table-column label="中差评回复率" min-width="130"><template #default="{row}">{{ percent(row.poorReplyRatePercent) }}</template></el-table-column>
      <el-table-column label="待处理评价投诉结果" min-width="165"><template #default="{row}"><span :class="{'dy-pending-count':row.pendingComplaintResults>0}">{{ row.pendingComplaintResults }} 条</span></template></el-table-column>
      <el-table-column label="门店标签" min-width="260" show-overflow-tooltip><template #default="{row}">{{ (row.tags || []).join('；') || '—' }}</template></el-table-column>
    </el-table>
    <div v-else-if="result.stores?.length" class="dy-metrics">
      <article v-for="store in result.stores" :key="store.storeId" class="dy-store">
        <div class="dy-store-title"><strong>{{ store.storeName }}</strong><span>{{ store.score == null ? '暂无评分' : store.score + ' 分' }}</span></div>
        <div class="dy-values">
          <div><small>昨日新增评价</small><b>{{ store.yesterdayReviews }}</b></div>
          <div><small>昨日新增中差评</small><b>{{ store.yesterdayPoorReviews }}</b></div>
          <div><small>好评率</small><b>{{ percent(store.goodRatePercent) }}</b></div>
          <div><small>近30天好评率</small><b>{{ percent(store.goodRate30dPercent) }}</b></div>
          <div><small>中差评回复率</small><b>{{ percent(store.poorReplyRatePercent) }}</b></div>
          <div :class="{'dy-pending':store.pendingComplaintResults>0}"><small>待处理评价投诉结果</small><b>{{ store.pendingComplaintResults }} 条</b></div>
        </div>
        <div v-if="store.tags?.length" class="dy-tags"><span v-for="tag in store.tags" :key="tag">{{ tag }}</span></div>
      </article>
    </div>
    <el-empty v-else-if="!loading && !error" description="所选门店暂无已关联的抖音评价指标" :image-size="60" />
    <p v-if="result.unmatchedStores?.length" class="dy-note">待关联门店：{{ result.unmatchedStores.join('、') }}</p>
    <div class="dy-tools">
      <el-radio-group v-model="mode" @change="reset"><el-radio-button value="recent7">近7天评价</el-radio-button><el-radio-button value="full">首次全量记录</el-radio-button></el-radio-group>
      <el-select v-model="rating" @change="reset" style="width:145px"><el-option label="全部评价" value="all"/><el-option label="中差评" value="negative"/><el-option label="好评" value="positive"/></el-select>
      <el-select v-model="ratingLabel" clearable placeholder="按评价标签筛选" @change="reset" style="width:170px"><el-option v-for="label in result.ratingLabels || []" :key="label" :label="label" :value="label" /></el-select>
      <el-checkbox v-model="textOnly" @change="reset">隐藏无文字评价</el-checkbox>
      <span>共 {{ result.total || 0 }} 条</span>
    </div>
    <p class="dy-note">{{ mode==='recent7' ? '近7天采集窗口（含今天）' : '首次全量采集存档' }}{{ result.dateRange ? '：'+result.dateRange : '' }} · 采集于 {{ stamp(result.collectedAt) }}。门店指标为最新快照，不随上方营业日期累计。</p>
    <div v-for="review in result.reviews" :key="review.key" class="dy-review">
      <div class="dy-review-head"><strong>{{ review.storeName }}</strong><el-tag :type="['超赞','推荐','满意','好评'].includes(review.ratingLabel)?'success':'warning'" size="small">{{ review.ratingLabel || '未标记' }}</el-tag><span>{{ review.publishedDisplay }}</span></div>
      <p class="dy-content">{{ review.text || '顾客未填写文字评价' }}</p>
      <small v-if="review.product" class="dy-note">商品：{{ review.product }}</small>
      <div v-for="(reply,index) in review.merchantReplies || []" :key="index" class="dy-reply">商家回复：{{ reply }}</div>
    </div>
    <el-empty v-if="!loading && !result.reviews?.length" description="当前筛选暂无采集评价" :image-size="60" />
    <el-pagination v-if="result.total>20" v-model:current-page="page" :total="result.total" :page-size="20" layout="prev, pager, next, total" @current-change="load"/>
  </section>
</template>
<script setup>
import { computed,ref,watch } from 'vue';
import { getDouyinReviews } from '@/api';
import { validReviewScope } from '@/utils/analysis-query-gate.mjs';
const props=defineProps({scope:{type:Object,default:()=>({})}});
const multipleStores=computed(()=>new Set(String(props.scope.store_ids || props.scope.store_id || '').split(',').filter(Boolean)).size>1);
const ratingLabel=ref(''),textOnly=ref(true);
const mode=ref('recent7'),rating=ref('all'),page=ref(1),loading=ref(false),error=ref(''),result=ref({stores:[],reviews:[]});
let request=0;
const stamp=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'尚未采集';
const percent=value=>value==null?'—':`${value}%`;
async function load(){if(!validReviewScope(props.scope)){request++;result.value={stores:[],reviews:[]};loading.value=false;return;}const id=++request;loading.value=true;error.value='';try{const data=await getDouyinReviews({...props.scope,mode:mode.value,rating:rating.value,rating_label:ratingLabel.value,text_only:textOnly.value ? '1' : '0',page:page.value});if(id===request)result.value=data;}catch(e){if(id===request){error.value=e.message || '评价数据加载失败';result.value={stores:[],reviews:[]};}}finally{if(id===request)loading.value=false;}}
function reset(){page.value=1;load();}
watch(()=>JSON.stringify(props.scope),reset,{immediate:true});
</script>
<style scoped>
.dy-store-table{width:100%;margin-bottom:8px}.dy-pending-count{color:#e08635;font-weight:600}.dy-table-tags{margin-top:0}
.dy-reviews{margin-top:20px;padding:24px;background:#fff;border:1px solid #e4ebf4;border-radius:12px;color:#20344f}.dy-header,.dy-store-title,.dy-tools,.dy-review-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.dy-header{justify-content:space-between;margin-bottom:20px}.dy-header h3{margin:0;font-size:18px}.dy-header p,.dy-note{font-size:12px;color:#8090a5;line-height:1.7}.dy-header p{margin:7px 0 0}.dy-metrics{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,540px),1fr))}.dy-store{border:1px solid #e5ecf5;border-radius:10px;padding:18px;background:#fbfdff}.dy-store-title{justify-content:space-between}.dy-store-title>span{font-size:22px;color:#4265d8;font-weight:700}.dy-values{display:grid;grid-template-columns:repeat(3,1fr);gap:20px 12px;margin-top:20px}.dy-values small{display:block;color:#8492a6;font-size:12px;margin-bottom:7px}.dy-values b{font-size:19px;font-weight:600}.dy-pending b{color:#e08635}.dy-tags{display:flex;flex-wrap:wrap;gap:8px;margin-top:15px}.dy-tags span{font-size:11px;padding:4px 8px;border-radius:4px;background:#edf3ff;color:#627baf}.dy-tools{margin-top:26px}.dy-tools>span,.dy-review-head>span{color:#8b99ae;font-size:12px}.dy-review{padding:20px 0;border-bottom:1px solid #edf1f7}.dy-review-head{font-size:13px}.dy-content{white-space:pre-wrap;font-size:14px;line-height:1.8;margin:12px 0;color:#334963}.dy-reply{background:#f6f8fb;color:#75849a;border-radius:6px;padding:10px 14px;font-size:12px;margin-top:10px;white-space:pre-wrap}.el-pagination{margin-top:20px;justify-content:flex-end}@media(max-width:640px){.dy-reviews{padding:16px}.dy-values{grid-template-columns:repeat(2,1fr)}}
</style>
