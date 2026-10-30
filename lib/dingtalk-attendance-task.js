'use strict';
const crypto=require('node:crypto');
const KEY='dingtalk_attendance';
const day=at=>new Date(new Date(at).getTime()+28800000).toISOString().slice(0,10);
const shift=(date,n)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
function initialize(db){db.run(`CREATE TABLE IF NOT EXISTS staff_daily_task_runs(task_key TEXT,business_date TEXT,status TEXT,attempts INTEGER DEFAULT 0,lease_owner TEXT,next_retry_at TEXT,started_at TEXT,finished_at TEXT,window_start TEXT,window_end TEXT,message TEXT,result_json TEXT,PRIMARY KEY(task_key,business_date))`)}
function safeError(e){return String(e?.message||'同步失败').replace(/https?:\/\/\S+/g,'[接口地址]').replace(/(?:access_token|appsecret|secret|token)\s*[:=]\s*\S+/gi,'[已隐藏凭据]').slice(0,240)}
function create({db,settings,configured,run,clock=()=>new Date()}){
 const owner=crypto.randomUUID();let busy=false;
 function status(){const cfg=settings(),now=clock(),today=day(now),target=shift(today,-1),time=`${String(cfg.hour).padStart(2,'0')}:${String(cfg.minute).padStart(2,'0')}`,due=new Date(today+'T'+time+':00+08:00');const latest=db.queryOne('SELECT * FROM staff_daily_task_runs WHERE task_key=? ORDER BY business_date DESC LIMIT 1',[KEY]);return {task_key:KEY,name:'钉钉考勤同步',timezone:'Asia/Shanghai',...cfg,configured:!!configured(),busy,planned_time:time,business_date:target,next_run_at:(now<due||!latest||latest.business_date<target||latest.status!=='success'?today:shift(today,1))+' '+time,latest_task:latest,recent_tasks:db.queryAll('SELECT * FROM staff_daily_task_runs WHERE task_key=? ORDER BY business_date DESC LIMIT 14',[KEY])};}
 async function tick(now=clock()){
  if(busy)return {ran:false,reason:'running'};
  const cfg=settings(),today=day(now),target=shift(today,-1),from=shift(target,-(cfg.lookbackDays-1)),due=Date.parse(today+`T${String(cfg.hour).padStart(2,'0')}:${String(cfg.minute).padStart(2,'0')}:00+08:00`);
  if(!cfg.enabled)return {ran:false,reason:'disabled'};
  if(new Date(now).getTime()<due)return {ran:false,reason:'not_due'};
  const previous=db.queryOne('SELECT * FROM staff_daily_task_runs WHERE task_key=? AND business_date=?',[KEY,target]);
  if(previous?.status==='success')return {ran:false,reason:'already_synced',target};
  if(previous?.status==='running'&&previous.lease_owner===owner)return {ran:false,reason:'running'};
  if(previous?.next_retry_at&&Date.parse(previous.next_retry_at)>new Date(now).getTime())return {ran:false,reason:'retry_pending'};
  if(Number(previous?.attempts)>=4)return {ran:false,reason:'retry_exhausted'};
  if(!configured()){
   if(!previous||previous.status!=='blocked'){db.run("INSERT INTO staff_daily_task_runs(task_key,business_date,status,attempts,window_start,window_end,message) VALUES(?,?,'blocked',0,?,?,?) ON CONFLICT(task_key,business_date) DO UPDATE SET status='blocked',message=excluded.message",[KEY,target,from,target,'钉钉考勤应用尚未配置，任务待配置，不能计为成功']);db.save();}
   return {ran:false,reason:'not_configured',target};
  }
  busy=true;const started=new Date(now).toISOString(),attempts=Number(previous?.attempts||0)+1;
  try{
   db.run("INSERT INTO staff_daily_task_runs(task_key,business_date,status,attempts,lease_owner,next_retry_at,started_at,finished_at,window_start,window_end,message,result_json) VALUES(?,?,'running',?,?,NULL,?,NULL,?,?,'正在同步','{}') ON CONFLICT(task_key,business_date) DO UPDATE SET status='running',attempts=excluded.attempts,lease_owner=excluded.lease_owner,next_retry_at=NULL,started_at=excluded.started_at,finished_at=NULL,window_start=excluded.window_start,window_end=excluded.window_end,message=excluded.message,result_json='{}'",[KEY,target,attempts,owner,started,from,target]);db.save();
   const result=await run({dateFrom:from,dateTo:target});
   // The shared importer completes all requested employee/date chunks first.
   // Zero punch records can be valid; a task still needs a complete import receipt.
   if(result?.date_from!==from||result?.date_to!==target||!Number.isInteger(result.employee_count)||result.employee_count<1||!Number.isInteger(result.record_count)||result.record_count<0)throw Error('考勤导入回执不完整，未计为成功');
   db.run("UPDATE staff_daily_task_runs SET status='success',finished_at=?,message=?,result_json=?,next_retry_at=NULL WHERE task_key=? AND business_date=?",[clock().toISOString(),String(result.message||'同步完成'),JSON.stringify(result),KEY,target]);db.save();return {ran:true,target,window_start:from,lookback_days:cfg.lookbackDays,...result};
  }catch(e){const message=safeError(e),retry=attempts<4?new Date(new Date(now).getTime()+[5,15,60][attempts-1]*60000).toISOString():null;db.run("UPDATE staff_daily_task_runs SET status='failed',finished_at=?,message=?,next_retry_at=? WHERE task_key=? AND business_date=?",[clock().toISOString(),message,retry,KEY,target]);db.save();return {ran:false,reason:'failed',target,error:message,next_retry_at:retry};}
  finally{busy=false;}
 }
 return {status,tick};
}
function evidence(db,businessDate,{now=new Date(),enabled=true,time='01:00',configured=true}={}){
 const base={type:KEY,name:'钉钉考勤每日同步',group:'staff',business_date:businessDate,planned_time:time,enabled,status:'unverified',missing:[]};
 if(!enabled)return {...base,status:'disabled',reason:'考勤每日任务已停用'};
 const exists=db.queryOne("SELECT name FROM sqlite_master WHERE name='staff_daily_task_runs'");
 if(!exists)return {...base,status:'unconfigured',reason:'尚未启用考勤每日任务记录'};
 const r=db.queryOne('SELECT * FROM staff_daily_task_runs WHERE task_key=? AND business_date=?',[KEY,businessDate]);
 if(!r){if(!configured)return {...base,status:'unconfigured',reason:'钉钉应用尚未配置，不能计为通过'};return {...base,status:Date.parse(now)<Date.parse(shift(businessDate,1)+'T'+time+':00+08:00')?'pending':'missing',reason:'等待当日考勤任务执行'};}
 let result={};try{result=JSON.parse(r.result_json||'{}')}catch{}
 const valid=r.status==='success'&&result.date_to===businessDate&&result.date_from===r.window_start&&Number(result.employee_count)>0&&Number.isInteger(result.record_count);
 return {...base,status:valid?'passed':r.status==='success'?'unverified':r.status==='blocked'?'unconfigured':r.status==='running'?'running':'failed',reason:valid?`已自动同步 ${result.employee_count} 名员工、${result.record_count} 条打卡；回扫 ${r.window_start} 至 ${r.window_end}`:r.message,records:valid?result.record_count:null,updated_at:r.finished_at||r.started_at};
}
module.exports={initialize,create,evidence,day,shift,KEY};
