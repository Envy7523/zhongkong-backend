'use strict';
const express=require('express'),crypto=require('node:crypto');
const {buildPreview}=require('./store-finance-daily');
const {render}=require('./store-finance-daily-image');
const fixedCosts=require('./store-finance-fixed-costs');
const {normalizeClosedDates}=require('./store-finance-revenue');
function target(db,botId) {
 if(botId!=null){if(!Number.isSafeInteger(Number(botId))||Number(botId)<=0)return null;return db.queryOne('SELECT id,name,webhook_url,enabled FROM wecom_webhook_bots WHERE id=? AND enabled=1',[Number(botId)]);}
 return db.queryOne("SELECT id,name,webhook_url,enabled FROM wecom_webhook_bots WHERE lower(name)='nameless' AND enabled=1 ORDER BY id LIMIT 1");
}
function requestSources(value){if(value==null)return undefined;return fixedCosts.normalize(typeof value==='string'?JSON.parse(value):value);}
function initialize(db) {db.run(`CREATE TABLE IF NOT EXISTS store_finance_daily_test_sends (
  request_id TEXT PRIMARY KEY, business_date TEXT NOT NULL, store_id INTEGER NOT NULL, bot_id INTEGER NOT NULL,
  fingerprint TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')))`);}
async function sendTest({db,httpPost,body}) {
  if(body.confirm_template_approved!==true||body.confirm_target_verified!==true||body.confirm_data_reviewed!==true) return {ok:false,reason:'请先确认日报样式、数据与目标群'};
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(body.request_id||'')))return {ok:false,reason:'无效发送请求'};
  const bot=target(db,body.bot_id);if(!bot?.webhook_url) return {ok:false,reason:'所选机器人尚未配置或已停用'};
  let sources;try{sources=requestSources(body.cost_sources);}catch{return {ok:false,reason:'费用来源无效，请重新生成预览'};}
  const data=buildPreview(db,body.store_id,body.business_date,sources);
  if(data.fingerprint!==body.fingerprint) return {ok:false,reason:'数据已变化，请重新生成并检查预览'};
  if(!data.ready && body.allow_incomplete_test!==true) return {ok:false,reason:'收银渠道数据不完整，请补齐后重新预览'};
  if(db.queryOne("SELECT status FROM store_finance_daily_test_sends WHERE request_id=? OR (business_date=? AND store_id=? AND bot_id=? AND status IN ('started','unknown','success')) LIMIT 1",[body.request_id,data.business_date,data.store_id,bot.id]))return {ok:false,reason:'该门店当天已有发送记录或发送结果待确认，请勿重复发送'};
  const image=render(body.allow_incomplete_test===true?{...data,test_notice:'测试日报 · 含待核对/留空项，仅供测试，不作为正式结算依据'}:data);
  db.run('INSERT INTO store_finance_daily_test_sends(request_id,business_date,store_id,bot_id,fingerprint,status) VALUES (?,?,?,?,?,?)',[body.request_id,data.business_date,data.store_id,bot.id,data.fingerprint,'started']);db.save();
  const finish=status=>{db.run("UPDATE store_finance_daily_test_sends SET status=?,updated_at=datetime('now','localtime') WHERE request_id=?",[status,body.request_id]);db.save();};
  let response;
  try {response=await httpPost(bot.webhook_url,{msgtype:'image',image:{base64:image.base64,md5:crypto.createHash('md5').update(image.buffer).digest('hex')}});}
  catch {finish('unknown');return {ok:false,reason:'发送结果未知，请检查目标群，勿直接重发'};}
  if(!response||response.errcode!==0){finish(response?'failed':'unknown');return {ok:false,reason:'机器人未确认发送成功，请检查目标群与机器人配置'};}
  finish('success');
  let auditError=false;
  try {db.insert('INSERT INTO push_logs(push_type,target,content_preview,status) VALUES (?,?,?,?)',['store_finance_daily_test',bot.name,`${data.business_date} ${data.store_name} ${body.allow_incomplete_test===true?'测试日报（含待核对项）':'财务日报'}`,'success']);db.save();}catch{auditError=true;}
  return {ok:true,sent:true,audit_error:auditError};
}
function createRouter({db,httpPost}) {
  const router=express.Router();
  router.get('/options',(req,res)=>{const bots=db.queryAll('SELECT id,name,enabled,webhook_url FROM wecom_webhook_bots ORDER BY id').map(r=>({id:r.id,name:r.name,configured:Boolean(r.enabled&&r.webhook_url)}));const bot=target(db)||bots.find(r=>r.configured);res.json({ok:true,stores:db.queryAll('SELECT id,store_name FROM stores ORDER BY store_name'),bots,bot:{id:bot?.id||null,name:bot?.name||'',configured:Boolean(bot&&(bot.webhook_url||bot.configured))}});});
  router.get('/cost-sources',(req,res)=>{try{res.json({ok:true,cost_sources:fixedCosts.settings(db,req.query.store_id)});}catch(e){res.status(400).json({error:e.message});}});
  router.post('/closed-days',(req,res)=>{try{const id=Number(req.body.store_id);if(!Number.isSafeInteger(id)||id<=0||!db.queryOne('SELECT id FROM stores WHERE id=?',[id]))throw Error('请选择有效门店');const dates=normalizeClosedDates(req.body.dates);db.run('INSERT OR REPLACE INTO config(key,value) VALUES(?,?)',['store_finance_closed_days:'+id,JSON.stringify(dates)]);db.save();res.json({ok:true,store_id:id,dates});}catch(e){res.status(400).json({error:e.message});}});
  router.post('/cost-sources',(req,res)=>{try{const id=Number(req.body.store_id);if(!Number.isSafeInteger(id)||id<=0||!db.queryOne('SELECT id FROM stores WHERE id=?',[id]))throw Error('请选择有效门店');const sources=fixedCosts.normalize(req.body.cost_sources);db.run('INSERT OR REPLACE INTO config(key,value) VALUES(?,?)',['store_finance_cost_sources:'+id,JSON.stringify(sources)]);db.save();res.json({ok:true,cost_sources:sources});}catch(e){res.status(400).json({error:e.message});}});
  router.get('/preview',(req,res)=>{try{const data=buildPreview(db,req.query.store_id,req.query.business_date,requestSources(req.query.cost_sources)),image=render(data);res.json({ok:true,...data,image_layout:image.layout,image_data_url:'data:image/png;base64,'+image.base64});}catch(e){res.status(400).json({ok:false,error:e.message});}});
  router.post('/test-send',async(req,res)=>{try{const body=req.body||{},batch=body.bot_ids!==undefined,result=await (batch?sendMultiple({db,httpPost,body}):sendTest({db,httpPost,body}));res.status(batch&&result.results?200:result.ok?200:400).json({...result,...(!result.ok&&!result.results?{error:result.reason}:{})});}catch{res.status(500).json({ok:false,error:'财务日报发送处理异常，请检查发送记录后再操作'});}});
  return router;
}
async function sendMultiple({db,httpPost,body}){
 const ids=body.bot_ids;if(!Array.isArray(ids)||!ids.length||ids.length>20||ids.some(id=>!Number.isSafeInteger(id)||id<=0))return {ok:false,reason:'请选择有效的发送机器人'};
 if(body.confirm_template_approved!==true||body.confirm_target_verified!==true||body.confirm_data_reviewed!==true)return {ok:false,reason:'请先确认日报样式、数据与接收群'};
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(body.request_id||'')))return {ok:false,reason:'无效发送请求'};
 const bots=[...new Set(ids)].map(id=>target(db,id));if(bots.some(bot=>!bot?.webhook_url))return {ok:false,reason:'所选机器人未配置或已停用，请重新选择'};
 let sources;try{sources=requestSources(body.cost_sources);}catch{return {ok:false,reason:'费用来源无效'};}
 const preview=buildPreview(db,body.store_id,body.business_date,sources);if(preview.fingerprint!==body.fingerprint||(!preview.ready&&body.allow_incomplete_test!==true))return {ok:false,reason:'预览已变化或数据未齐，请重新生成并检查'};
 const results=[];
 for(const bot of bots){
  const previous=db.queryOne("SELECT status FROM store_finance_daily_test_sends WHERE business_date=? AND store_id=? AND bot_id=? AND status IN ('started','unknown','success') LIMIT 1",[body.business_date,Number(body.store_id),bot.id]);
  if(previous){results.push({bot_id:bot.id,name:bot.name,ok:previous.status==='success',status:previous.status,skipped:true,reason:previous.status==='success'?'已发送，不重复发送':'发送结果待确认，不自动重发'});continue;}
  const hash=crypto.createHash('sha256').update(body.request_id+':'+bot.id).digest('hex');const request_id=hash.slice(0,8)+'-'+hash.slice(8,12)+'-4'+hash.slice(13,16)+'-a'+hash.slice(17,20)+'-'+hash.slice(20,32);
  try{const result=await sendTest({db,httpPost,body:{...body,bot_id:bot.id,request_id}});const record=db.queryOne('SELECT status FROM store_finance_daily_test_sends WHERE request_id=?',[request_id]);results.push({bot_id:bot.id,name:bot.name,...result,status:record?.status||'failed'});}catch{results.push({bot_id:bot.id,name:bot.name,ok:false,status:'unknown',reason:'发送处理异常，请先核对发送记录与接收群'});}
 }
 return {ok:results.every(r=>r.ok),results};
}
module.exports={initialize,createRouter,sendTest,sendMultiple};
