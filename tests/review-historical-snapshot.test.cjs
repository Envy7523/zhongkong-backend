'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite'),history=require('../lib/review-historical-snapshot');
const day='2026-10-23',at='2026-10-28T23:00:00Z';
function fixture(type){
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'review-history-')),file=path.join(folder,'archive.sqlite'),db=new DatabaseSync(file);
 if(type==='douyin_group_reviews'){
  db.exec('CREATE TABLE collection_runs(run_id TEXT,started_at TEXT); CREATE TABLE collection_run_results(run_id TEXT,completed_at TEXT,record_count INTEGER,store_count INTEGER,metadata_json TEXT); CREATE TABLE review_observations(run_id TEXT,page_number INTEGER,row_number INTEGER,data_json TEXT); CREATE TABLE store_metric_observations(run_id TEXT,data_json TEXT); CREATE TABLE review_pages(run_id TEXT,record_count INTEGER)');
  const meta={dateRange:day+' ~ 2026-10-29',dateBasis:'platform-calendar-day-v1',sourceTotal:1,pages:1,storesTotal:1,storeMetricsDeclaredTotal:1,storeMetricsCoverage:'complete',rangeControl:{range:day+' ~ 2026-10-29',sourceTotal:1},dayEvidence:[{date:day,range:day+' ~ '+day,records:1,sourceTotal:1,complete:true}]};
  db.prepare('INSERT INTO collection_runs VALUES(?,?)').run('r1',at);db.prepare('INSERT INTO collection_run_results VALUES(?,?,?,?,?)').run('r1',at,1,1,JSON.stringify(meta));db.prepare('INSERT INTO review_observations VALUES(?,?,?,?)').run('r1',1,1,JSON.stringify({publishedDate:day,dateBasis:meta.dateBasis,storeName:'测试店'}));db.prepare('INSERT INTO store_metric_observations VALUES(?,?)').run('r1',JSON.stringify({storeName:'测试店'}));db.prepare('INSERT INTO review_pages VALUES(?,?)').run('r1',1);
 }else{
  db.exec('CREATE TABLE runs(run_id TEXT,state TEXT,completed_at TEXT,metadata_json TEXT);CREATE TABLE source_results(run_id TEXT,platform_store_id TEXT,source TEXT,source_total INTEGER,state TEXT);CREATE TABLE observations(run_id TEXT,platform_store_id TEXT,source TEXT,review_id TEXT);CREATE TABLE reviews(platform_store_id TEXT,source TEXT,review_id TEXT,data_json TEXT);CREATE TABLE stores(platform_store_id TEXT,store_name TEXT)');
  db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run('r1','recentComplete',at,JSON.stringify({scope:'recent7',state:'recentComplete',incompleteTexts:0,storesDone:1,storesTotal:1,records:1}));db.exec("INSERT INTO source_results VALUES('r1','s1','美团评价',1,'complete'),('r1','s1','点评评价',0,'complete');INSERT INTO observations VALUES('r1','s1','美团评价','a1');INSERT INTO reviews VALUES('s1','美团评价','a1','{}');INSERT INTO stores VALUES('s1','测试店')");
 }
 return {db,file,close(){db.close();fs.rmSync(folder,{recursive:true,force:true})}};
}
test('已完成归档可恢复滚动窗口外的核验证据，不修改归档文件',()=>{
 for(const type of ['douyin_group_reviews','meituan_group_reviews']){const f=fixture(type);try{const before=fs.readFileSync(f.file),r=history.load(type,day,{file:f.file});assert.equal(r.historicalEvidence,true);assert.equal(r.runId,'r1');assert.equal(r.stores.length,1);assert.equal(r.reviews?.length||r.datasets?.recent7.reviews.length,1);assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(history.load(type,'2026-10-22',{file:f.file}),null)}finally{f.close()}}
});
test('未完成来源、缺记录、错误日期和不一致的源条数仍拒绝',()=>{
 let f=fixture('meituan_group_reviews');try{f.db.exec("UPDATE source_results SET state='partial' WHERE source='点评评价'");assert.equal(history.load('meituan_group_reviews',day,{file:f.file}),null);f.db.exec("UPDATE source_results SET state='complete';DELETE FROM reviews");assert.equal(history.load('meituan_group_reviews',day,{file:f.file}),null)}finally{f.close()}
 f=fixture('douyin_group_reviews');try{f.db.exec('UPDATE review_pages SET record_count=2');assert.equal(history.load('douyin_group_reviews',day,{file:f.file}),null);f.db.exec("UPDATE review_pages SET record_count=1;UPDATE review_observations SET data_json='{\"publishedDate\":\"2026-10-24\",\"dateBasis\":\"platform-calendar-day-v1\"}'");assert.equal(history.load('douyin_group_reviews',day,{file:f.file}),null)}finally{f.close()}
});
