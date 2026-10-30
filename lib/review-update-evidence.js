'use strict';
const fs=require('fs'),path=require('path');
const cache=new Map();
const chinaDay=at=>new Date(Date.parse(at)+28800000).toISOString().slice(0,10);
const shift=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
function read(file){const stat=fs.statSync(file),prior=cache.get(file);if(prior?.mtime===stat.mtimeMs&&prior.size===stat.size)return prior.data;const data=JSON.parse(fs.readFileSync(file,'utf8'));cache.set(file,{mtime:stat.mtimeMs,size:stat.size,data});return data}
function snapshotPath(type){const douyin=type==='douyin_group_reviews';return process.env[douyin?'DOUYIN_REVIEW_SNAPSHOT':'MEITUAN_REVIEW_SNAPSHOT']||(process.platform==='win32'?path.join(__dirname,'../data/'+(douyin?'douyin-review-display-snapshot.json':'meituan-review-display-snapshot.json')):'/opt/zhongkong-sync-bot/state/reviews/'+(douyin?'display-snapshot.json':'meituan-display-snapshot.json'))}
function archiveProof(data){
 const file=process.env.MEITUAN_REVIEW_DATABASE||path.join(path.dirname(snapshotPath('meituan_group_reviews')),'meituan-reviews.sqlite');
 const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(file,{readOnly:true});
 try{db.exec('BEGIN');const run=db.prepare('SELECT state FROM runs WHERE run_id=?').get(data.runId),rows=db.prepare('SELECT DISTINCT platform_store_id,source,review_id FROM observations WHERE run_id=?').all(data.runId),saved=db.prepare('SELECT COUNT(*) n FROM (SELECT DISTINCT o.platform_store_id,o.source,o.review_id FROM observations o JOIN reviews r ON r.platform_store_id=o.platform_store_id AND r.source=o.source AND r.review_id=o.review_id WHERE o.run_id=?)').get(data.runId).n;
  const key=(id,source,review)=>JSON.stringify([String(id),source,String(review)]),snap=new Set(data.reviews.map(r=>key(r.platformStoreId,r.source,r.reviewId)));
  const sourceCount=db.prepare('SELECT COUNT(*) n FROM source_results WHERE run_id=?').get(data.runId).n;const incomplete=db.prepare("SELECT COUNT(*) n FROM source_results WHERE run_id=? AND state<>'complete'").get(data.runId).n;
  return {complete:run?.state==='recentComplete'&&!incomplete&&sourceCount===data.stores.length*2,observations:rows.length,saved,missing_snapshot:rows.filter(r=>!snap.has(key(r.platform_store_id,r.source,r.review_id))).length};
 }finally{db.close()}
}
function evidence(db,type,day,run,scope,load=()=>read(snapshotPath(type)),getArchive=archiveProof,loadHistorical=(type,day)=>require('./review-historical-snapshot').load(type,day)){
 const unknown=reason=>({ok:false,unverified:true,storage:'snapshot',count:null,expected:scope?.length??null,actual:null,missing:[],reason});
 let data;try{data=load()}catch(e){return e.code==='ENOENT'?{ok:false,count:0,missing:[],reason:'评价展示快照尚未保存'}:unknown('评价快照无法读取，需核对采集结果')}
 const douyin=type==='douyin_group_reviews',recent=douyin?data.datasets?.recent7:null,meta=douyin?recent?.metadata:data.audit;
 const updated=douyin?recent?.collectedAt:data.updatedAt;
 if(!updated||!Number.isFinite(Date.parse(updated)))return unknown('缺少评价采集时间，无法确认更新');
 if(run&&Date.parse(updated)+5000<Date.parse(run.started_at||run.last_event_at||run.finished_at))return unknown('成功运行尚未对应到新的评价快照');
 const end=chinaDay(updated),dates=douyin?String(meta?.dateRange||'').match(/\d{4}-\d{2}-\d{2}/g):[shift(end,-6),end];
 if(!dates||dates.length!==2||day<dates[0]||day>dates[1]){
  let historical;try{historical=loadHistorical(type,day)}catch{}
  if(historical){const verified=evidence(db,type,day,run,scope,()=>historical,getArchive,()=>null);return verified.ok?{...verified,reason:'已完成的历史采集归档、源条数及门店覆盖核对通过',historical_verified:true}:verified;}
  return unknown('当前评价快照不覆盖该营业日，历史结果待核验');
 }
 if(!scope?.length)return unknown('没有可确认的应更新门店范围');
 if(!Array.isArray(data.stores)||!meta)return unknown('缺少评价门店覆盖或完成记录');
 let saved,declared;
 if(douyin){
  if(meta.storeMetricsCoverage!=='complete'||!Number.isInteger(meta.storesTotal)||meta.storesTotal!==data.stores.length||meta.storeMetricsDeclaredTotal!==data.stores.length)return unknown('评价门店统计覆盖尚未完整核对');
  if(!Array.isArray(recent.reviews)||!Number.isInteger(meta.sourceTotal))return unknown('缺少评价源条数或保存结果');
  saved=recent.reviews.length;declared=meta.sourceTotal;
 }else{
  if(meta.state!=='recentComplete'||meta.scope!=='recent7'||!Number.isInteger(meta.storesTotal)||meta.storesDone!==meta.storesTotal||meta.storesTotal!==data.stores.length)return unknown('评价采集未取得完整门店完成证明');
  if(Number(meta.incompleteTexts)>0)return {ok:false,count:meta.records??null,missing:[],reason:'评价存在未展开的残缺正文，需检查采集结果'};
  if(!Array.isArray(data.reviews)||!Number.isInteger(meta.records))return unknown('缺少评价源条数或保存结果');
  let proof;try{proof=getArchive(data)}catch{return unknown('评价已更新快照，但采集归档保存记录暂时无法核验')}if(!proof.complete)return unknown('评价采集归档缺少完整完成证明');if(proof.missing_snapshot)return {ok:false,count:proof.saved,missing:[],reason:'评价展示快照缺少本次已采集记录'};saved=proof.saved;declared=meta.records;if(proof.observations!==declared)return unknown('评价采集观测条数与本次运行记录不一致');
 }
 if(saved!==declared)return {ok:false,unverified:saved>declared,count:saved,missing:[],reason:'评价源条数与快照保存条数不一致（'+declared+' / '+saved+'）'};
 let stores;try{if(douyin){const all=require('./douyin-reviews').report(db,{mode:'recent7',date_to:end},data);if(all.unmatchedStores.length)return {...unknown('有评价来源门店尚未匹配到门店档案，需核对绑定'),count:saved,expected:scope.length,actual:all.stores.filter(s=>scope.some(expected=>Number(expected.id)===Number(s.storeId))).length,unmatched_stores:all.unmatchedStores}}stores=require(douyin?'./douyin-reviews':'./meituan-reviews').report(db,{store_ids:scope.map(s=>s.id).join(','),mode:'recent7',date_to:end},data).stores}catch{return unknown('评价门店绑定暂时无法核对')}
 const ids=new Set(stores.map(s=>Number(s.storeId))),missing=scope.filter(s=>!ids.has(Number(s.id)));
 return {ok:!missing.length,storage_verified:!missing.length,count:saved,expected:scope.length,actual:scope.length-missing.length,missing,reason:missing.length?'评价缺少应更新门店':'评价门店覆盖及近7天源条数、快照保存条数核对通过',storage:'snapshot',snapshot_updated_at:updated};
}
module.exports={evidence,snapshotPath,archiveProof};
