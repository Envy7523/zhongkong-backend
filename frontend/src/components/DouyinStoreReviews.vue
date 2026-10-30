<template>
  <section class="panel dy-reviews" v-loading="loading">
    <header class="dy-header">
      <div><h3>抖音门店评价</h3><p>最新门店指标 · {{ stamp(result.updatedAt) }} 更新</p></div>
    </header>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div class="dy-overview" :class="{'is-multiple':multipleStores}">
      <div class="dy-overview-store">
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
      </div>
    <section class="dy-distribution"><h4>评价标签分布</h4><div v-for="item in result.summary?.labels || []" :key="item.label"><span>{{ item.label }}</span><div class="dy-bar"><i :style="{width:(result.summary.total ? item.count/result.summary.total*100 : 0)+'%'}"></i></div><b>{{ item.count }}</b></div><p class="dy-note">按当前时间范围的全部采集评价统计；数值星级按平台显示采集，旧归档未采集的星级不通过标签推算。</p></section>
    </div>
    <div class="dy-summary"><article v-for="item in summaryMetrics" :key="item.key"><small>{{ item.label }}</small><strong>{{ result.summary?.[item.key] ?? 0 }} <em>条</em></strong></article></div>
    <div class="dy-tools">
      <el-radio-group v-model="mode" ><el-radio-button value="recent7">近7天评价</el-radio-button><el-radio-button value="full">全部评价</el-radio-button></el-radio-group>
      <el-select v-model="rating"  style="width:145px"><el-option label="全部评价" value="all"/><el-option label="中差评" value="negative"/><el-option label="好评" value="positive"/></el-select>
      <el-select v-model="ratingLabel" clearable placeholder="按评价标签筛选"  style="width:170px"><el-option v-for="label in result.ratingLabels || []" :key="label" :label="label" :value="label" /></el-select>
      <el-checkbox v-model="textOnly" >隐藏无文字评价</el-checkbox>
      <el-button type="primary" :loading="loading" @click="queryReviews">查询</el-button><span>共 {{ result.total || 0 }} 条</span>
    </div>
    <div class="dy-stars"><span>评价星级</span><el-checkbox :model-value="selectedStars.length===stars.length" :indeterminate="selectedStars.length>0 && selectedStars.length<stars.length" @change="value=>selectedStars=value?[...stars]:[]">全选</el-checkbox><el-checkbox-group v-model="selectedStars"><el-checkbox v-for="star in stars" :key="star" :value="star">{{ star }} 星</el-checkbox></el-checkbox-group></div>
    <p class="dy-note">{{ applied.mode==='recent7' ? '近七天：'+(result.dateRange || '') : '全部已采集评价' }} · 采集于 {{ stamp(result.collectedAt) }}。门店评分为最新采集快照。</p>
    <div v-for="review in result.reviews" :key="review.key" class="dy-review">
      <div class="dy-review-head"><strong>{{ review.customerName || '姓名未采集' }}</strong><el-rate v-if="review.rating" :model-value="Number(review.rating)" disabled allow-half/><el-tag v-else type="info" size="small">星级未采集</el-tag><span>{{ review.storeName }}</span><el-tag :type="['超赞','推荐','满意','好评'].includes(review.ratingLabel)?'success':'warning'" size="small">{{ review.ratingLabel || '未标记' }}</el-tag><span>{{ review.publishedDisplay }}</span></div>
      <div class="dy-review-extra"><span v-if="review.viewsDisplay">{{ review.viewsDisplay }}</span><el-tag v-if="review.foldedNotice" type="info" size="small">平台折叠评价</el-tag><el-tag v-for="tag in review.tags || []" :key="tag" size="small" effect="plain">{{ tag }}</el-tag></div><p class="dy-content">{{ review.text || '顾客未填写文字评价' }}</p>
      <small v-if="review.product" class="dy-note">商品：{{ review.product }}</small>
      <div v-if="review.media?.length" class="dy-media"><el-image v-for="(url,index) in review.media" :key="url" :src="url" :preview-src-list="review.media" :initial-index="index" fit="cover" preview-teleported loading="lazy"><template #error><span>图片暂不可用</span></template></el-image></div>
      <p v-if="review.mediaUnavailable" class="dy-note">{{ review.mediaUnavailable }} 张图片未缓存或原链接已失效，需补采后查看。</p>
      <div v-for="(reply,index) in review.merchantReplies || []" :key="index" class="dy-reply">商家回复：{{ reply }}</div>
    </div>
    <el-empty v-if="!loading && !result.reviews?.length" description="当前筛选暂无采集评价" :image-size="60" />
    <el-pagination v-model:current-page="page" v-model:page-size="pageSize" :total="result.total || 0" :page-sizes="[10,20,50,100]" layout="total, sizes, prev, pager, next" @size-change="reset" @current-change="load"/>
  </section>
</template>
<script setup>
import { computed,ref,watch,onBeforeUnmount } from 'vue';
import { getDouyinReviews,getDouyinReviewMedia } from '@/api';
import { validReviewScope } from '@/utils/analysis-query-gate.mjs';
const props=defineProps({scope:{type:Object,default:()=>({})}});
const multipleStores=computed(()=>new Set(String(props.scope.store_ids || props.scope.store_id || '').split(',').filter(Boolean)).size>1);
const ratingLabel=ref(''),textOnly=ref(true);
const mode=ref('recent7'),rating=ref('all'),page=ref(1),loading=ref(false),error=ref(''),result=ref({stores:[],reviews:[]});
const stars=[1,2,3,4,5],selectedStars=ref([...stars])
const pageSize=ref(20),applied=ref({mode:'recent7',rating:'all',ratingLabel:'',textOnly:true,ratings:[...stars],includeUnrated:false});
const summaryMetrics=[{key:'total',label:'采集评价'},{key:'positive',label:'好评'},{key:'negative',label:'中差评'},{key:'textCount',label:'有文字评价'},{key:'replied',label:'已回复评价'},{key:'mediaCount',label:'有图片评价'}];
function queryReviews(){applied.value={mode:mode.value,rating:rating.value,ratingLabel:ratingLabel.value,textOnly:textOnly.value,ratings:[...selectedStars.value],includeUnrated:false};reset();}
let request=0,mediaUrls=[];
onBeforeUnmount(()=>{request++;mediaUrls.forEach(URL.revokeObjectURL)})
const stamp=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'尚未采集';
const percent=value=>value==null?'—':`${value}%`;
async function load(){if(!validReviewScope(props.scope)){request++;result.value={stores:[],reviews:[]};loading.value=false;return;}const id=++request;loading.value=true;error.value='';try{const data=await getDouyinReviews({...props.scope,mode:applied.value.mode,rating:applied.value.rating,rating_label:applied.value.ratingLabel,text_only:applied.value.textOnly ? '1' : '0',page_size:pageSize.value,page:page.value,ratings:applied.value.ratings.join(','),include_unrated:applied.value.includeUnrated?'1':'0'});if(id===request){const urls=[];await Promise.all((data.reviews||[]).map(async row=>{const files=row.mediaFiles||[];row.mediaUnavailable=Math.max(0,(row.media||[]).length-files.length);row.media=await Promise.all(files.map(async name=>{try{const blob=await getDouyinReviewMedia(name),url=URL.createObjectURL(blob);urls.push(url);return url}catch{row.mediaUnavailable++;return null}}));row.media=row.media.filter(Boolean)}));if(id===request){mediaUrls.forEach(URL.revokeObjectURL);mediaUrls=urls;result.value=data;}else urls.forEach(URL.revokeObjectURL);}}catch(e){if(id===request){error.value=e.message || '评价数据加载失败';result.value={stores:[],reviews:[]};}}finally{if(id===request)loading.value=false;}}
function reset(){page.value=1;load();}
watch(()=>JSON.stringify(props.scope),reset,{immediate:true});
</script>
<style scoped>
.dy-store-table{width:100%;margin-bottom:8px}.dy-pending-count{color:#e08635;font-weight:600}.dy-table-tags{margin-top:0}
.dy-reviews{margin-top:20px;padding:24px;background:#fff;border:1px solid #e4ebf4;border-radius:12px;color:#20344f}.dy-header,.dy-store-title,.dy-tools,.dy-review-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.dy-header{justify-content:space-between;margin-bottom:20px}.dy-header h3{margin:0;font-size:18px}.dy-header p,.dy-note{font-size:12px;color:#8090a5;line-height:1.7}.dy-header p{margin:7px 0 0}.dy-metrics{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,540px),1fr))}.dy-store{border:1px solid #e5ecf5;border-radius:10px;padding:18px;background:#fbfdff}.dy-store-title{justify-content:space-between}.dy-store-title>span{font-size:22px;color:#4265d8;font-weight:700}.dy-values{display:grid;grid-template-columns:repeat(3,1fr);gap:20px 12px;margin-top:20px}.dy-values small{display:block;color:#8492a6;font-size:12px;margin-bottom:7px}.dy-values b{font-size:19px;font-weight:600}.dy-pending b{color:#e08635}.dy-tags{display:flex;flex-wrap:wrap;gap:8px;margin-top:15px}.dy-tags span{font-size:11px;padding:4px 8px;border-radius:4px;background:#edf3ff;color:#627baf}.dy-tools{margin-top:26px}.dy-tools>span,.dy-review-head>span{color:#8b99ae;font-size:12px}.dy-review{padding:20px 0;border-bottom:1px solid #edf1f7}.dy-review-head{font-size:13px}.dy-content{white-space:pre-wrap;font-size:14px;line-height:1.8;margin:12px 0;color:#334963}.dy-reply{background:#f6f8fb;color:#75849a;border-radius:6px;padding:10px 14px;font-size:12px;margin-top:10px;white-space:pre-wrap}.el-pagination{margin-top:20px;justify-content:flex-end}@media(max-width:640px){.dy-reviews{padding:16px}.dy-values{grid-template-columns:repeat(2,1fr)}}
.dy-summary{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-top:20px}.dy-summary article{padding:16px;border:1px solid #e5ecf5;border-radius:10px;background:#fbfdff}.dy-summary small{display:block;color:#8090a5;font-size:12px}.dy-summary strong{display:block;font-size:23px;color:#4265d8;margin-top:10px}.dy-summary em{font-size:12px;font-style:normal;font-weight:400}.dy-distribution{border-bottom:1px solid #edf1f7;padding:16px 0}.dy-distribution h4{font-size:14px}.dy-distribution>div{display:flex;gap:14px;align-items:center;margin:10px 0;font-size:13px}.dy-distribution>div>span{width:65px}.dy-bar{height:10px;background:#f0f3f8;border-radius:5px;width:min(60%,600px);overflow:hidden}.dy-bar i{display:block;height:100%;background:#64b98a;border-radius:5px}.dy-review-extra{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px;font-size:12px;color:#8090a5}.dy-media{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}.dy-media .el-image{width:100px;height:100px;border-radius:8px}.dy-media span{font-size:12px;color:#8090a5}@media(max-width:900px){.dy-summary{grid-template-columns:repeat(3,1fr)}}@media(max-width:500px){.dy-summary{grid-template-columns:repeat(2,1fr)}}
.dy-stars{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:14px 0;font-size:13px}.dy-stars .el-checkbox-group{display:flex;gap:14px}.dy-stars .el-checkbox{margin-right:0}

.dy-overview{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:16px;align-items:stretch}.dy-overview-store{min-width:0}.dy-overview .dy-metrics,.dy-overview .dy-store{height:100%;box-sizing:border-box}.dy-overview .dy-values{gap:14px 12px;margin-top:16px}.dy-overview .dy-values b{font-size:18px}.dy-overview .dy-distribution{min-width:0;margin:0;padding:18px;border:1px solid #e5ecf5;border-radius:10px;background:#fbfdff;box-sizing:border-box}.dy-overview .dy-distribution h4{margin:0 0 16px}.dy-overview .dy-distribution>div{margin:12px 0}.dy-overview .dy-bar{width:auto;flex:1;min-width:0}.dy-overview .dy-note{margin:12px 0 0}.dy-overview.is-multiple{grid-template-columns:minmax(0,1fr)}.dy-summary{margin-top:14px}@media(max-width:1000px){.dy-overview{grid-template-columns:minmax(0,1fr)}}
</style>
