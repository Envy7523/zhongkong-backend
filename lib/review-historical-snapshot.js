'use strict';
const path=require('node:path');
const dayOf=at=>new Date(Date.parse(at)+28800000).toISOString().slice(0,10);
const shift=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const inRange=(day,range)=>{const dates=String(range||'').match(/\d{4}-\d{2}-\d{2}/g);return dates?.length===2&&dates[0]<=day&&day<=dates[1]};

// The rolling display file deliberately drops old days. For health checks only,
// reconstruct an already-completed observation window from the retained archive.
// No public route, writes, new collection, or modified display snapshot.
function load(type,day,{file}={}){
 if(!['douyin_group_reviews','meituan_group_reviews'].includes(type)||!/^\d{4}-\d{2}-\d{2}$/.test(day))return null;
 const dy=type==='douyin_group_reviews';
 file||=process.env[dy?'DOUYIN_REVIEW_DATABASE':'MEITUAN_REVIEW_DATABASE']||path.join(path.dirname(require('./review-update-evidence').snapshotPath(type)),dy?'douyin-reviews.sqlite':'meituan-reviews.sqlite');
 const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(file,{readOnly:true});
 try{
  db.exec('PRAGMA query_only=ON; BEGIN');
  if(dy){
   const candidates=db.prepare('SELECT c.run_id,r.completed_at,r.record_count,r.store_count,r.metadata_json FROM collection_runs c JOIN collection_run_results r ON r.run_id=c.run_id WHERE r.completed_at>=? ORDER BY r.completed_at DESC LIMIT 60').all(day);
   for(const run of candidates){
    const meta=JSON.parse(run.metadata_json);if(!inRange(day,meta.dateRange))continue;
    const proof=meta.dayEvidence?.find(d=>d.date===day);
    if(meta.dateBasis!=='platform-calendar-day-v1'||!proof?.complete||proof.range!==day+' ~ '+day||proof.records!==proof.sourceTotal||meta.rangeControl?.range!==meta.dateRange||meta.rangeControl.sourceTotal!==meta.sourceTotal||meta.storeMetricsCoverage!=='complete')continue;
    if(!Number.isInteger(meta.sourceTotal)||run.record_count!==meta.sourceTotal||run.store_count!==meta.storesTotal||meta.storeMetricsDeclaredTotal!==meta.storesTotal)continue;
    const reviews=db.prepare('SELECT data_json FROM review_observations WHERE run_id=? ORDER BY page_number,row_number').all(run.run_id).map(r=>JSON.parse(r.data_json));
    const stores=db.prepare('SELECT data_json FROM store_metric_observations WHERE run_id=?').all(run.run_id).map(r=>JSON.parse(r.data_json));
    const pages=db.prepare('SELECT COUNT(*) pages,COALESCE(SUM(record_count),0) records FROM review_pages WHERE run_id=?').get(run.run_id);
    if(reviews.length!==meta.sourceTotal||stores.length!==meta.storesTotal||new Set(stores.map(s=>s.storeName)).size!==stores.length||pages.records!==meta.sourceTotal||pages.pages!==meta.pages||reviews.filter(r=>r.publishedDate===day&&r.dateBasis==='platform-calendar-day-v1').length!==proof.sourceTotal)continue;
    return {runId:run.run_id,updatedAt:run.completed_at,stores,datasets:{recent7:{collectedAt:run.completed_at,metadata:meta,reviews}},historicalEvidence:true};
   }
  }else{
   const candidates=db.prepare("SELECT * FROM runs WHERE state='recentComplete' AND completed_at>=? ORDER BY completed_at DESC LIMIT 60").all(day);
   for(const run of candidates){
    const end=dayOf(run.completed_at);if(day<shift(end,-6)||day>end)continue;
    const meta=JSON.parse(run.metadata_json);if(meta.scope!=='recent7'||meta.state!=='recentComplete'||meta.incompleteTexts!==0||meta.storesDone!==meta.storesTotal||!Number.isInteger(meta.records))continue;
    const results=db.prepare('SELECT platform_store_id,source,source_total,state FROM source_results WHERE run_id=?').all(run.run_id);
    if(results.length!==meta.storesTotal*2||results.some(r=>r.state!=='complete')||new Set(results.map(r=>JSON.stringify([r.platform_store_id,r.source]))).size!==results.length||results.reduce((n,r)=>n+r.source_total,0)!==meta.records)continue;
    const observations=db.prepare('SELECT o.platform_store_id,o.source,o.review_id,r.data_json FROM observations o LEFT JOIN reviews r ON r.platform_store_id=o.platform_store_id AND r.source=o.source AND r.review_id=o.review_id WHERE o.run_id=?').all(run.run_id);
    if(observations.length!==meta.records||observations.some(r=>!r.data_json))continue;
    const stores=[...new Set(results.map(r=>String(r.platform_store_id)))].map(id=>({platformStoreId:id,storeName:db.prepare('SELECT store_name FROM stores WHERE platform_store_id=?').get(id)?.store_name||''}));
    if(stores.length!==meta.storesTotal||stores.some(s=>!s.storeName))continue;
    const reviews=observations.map(r=>({...JSON.parse(r.data_json),platformStoreId:String(r.platform_store_id),source:r.source,reviewId:String(r.review_id)}));
    if(new Set(reviews.map(r=>JSON.stringify([r.platformStoreId,r.source,r.reviewId]))).size!==meta.records)continue;
    return {runId:run.run_id,updatedAt:run.completed_at,audit:meta,stores,reviews,historicalEvidence:true};
   }
  }
  return null;
 }finally{db.close()}
}
module.exports={load};
