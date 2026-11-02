'use strict';
// Result/leave data are separate DingTalk APIs from punch records.
const crypto=require('node:crypto'),ding=require('./dingtalk-attendance'),approvals=require('./dingtalk-approvals');
const {losslessJson}=require('./finance-approval-refresh');
const shift=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const day=v=>typeof v==='number'||/^\d{13}$/.test(String(v))?new Date(Number(v)+28800000).toISOString().slice(0,10):String(v||'').slice(0,10);
const time=v=>v===null||v===undefined||v===''||v===0||v==='0'?'':typeof v==='number'||/^\d{13}$/.test(String(v))?new Date(Number(v)+28800000).toISOString().slice(0,19).replace('T',' '):String(v).replace('T',' ').slice(0,19);
const valid=d=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
function initialize(db){approvals.initialize(db);db.run(`CREATE TABLE IF NOT EXISTS dingtalk_detail_sync_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,date_from TEXT NOT NULL,date_to TEXT NOT NULL,status TEXT NOT NULL,employee_count INTEGER,result_count INTEGER,approval_count INTEGER,receipt_json TEXT,message TEXT,started_at TEXT NOT NULL,finished_at TEXT)`);}
function reader({fetchImpl=fetch,getToken=()=>ding.getAccessToken(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),spacing=250}={}){
 return async({from,to,mapped,operator,templates,pending=[]})=>{
  const token=await getToken();let calls=0;
  async function request(path,body,old=false){
   for(let attempt=0;attempt<3;attempt++){
    await sleep(spacing);calls++;
    const response=await fetchImpl((old?'https://oapi.dingtalk.com':'https://api.dingtalk.com')+path+(old?'?access_token='+encodeURIComponent(token):''),{method:body?'POST':'GET',headers:{...(old?{}:{'x-acs-dingtalk-access-token':token}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
    if([429,502,503,504].includes(response.status)&&attempt<2){await sleep(1000*(attempt+1));continue;}
    let value;try{value=losslessJson(await response.text());}catch{throw Error('dingtalk_detail_response_invalid');}
    if(!response.ok||value.errcode&&!['0',0].includes(value.errcode)||value.code&&!['0',0].includes(value.code))throw Error('dingtalk_detail_api_failed');
    return value;
   }
  }
  const results=[],ids=new Set(mapped.map(e=>e.dingtalk_user_id)),keys=new Set();
  for(let first=from;first<=to;first=shift(first,7))for(let start=0;start<mapped.length;start+=50){
   const last=shift(first,6)>to?to:shift(first,6),users=mapped.slice(start,start+50).map(e=>e.dingtalk_user_id),seen=new Set();let offset=0;
   for(let page=0;;page++){
    if(page>=1000)throw Error('dingtalk_result_pagination_limit');
    const body=await request('/attendance/list',{workDateFrom:first+' 00:00:00',workDateTo:last+' 23:59:59',userIdList:users,offset,limit:50},true);
    if(!Array.isArray(body.recordresult)||typeof body.hasMore!=='boolean')throw Error('dingtalk_result_incomplete_response');
    const fingerprint=crypto.createHash('sha256').update(JSON.stringify(body.recordresult)).digest('hex');if(body.hasMore&&(seen.has(fingerprint)||!body.recordresult.length))throw Error('dingtalk_result_pagination_stalled');seen.add(fingerprint);
    for(const r of body.recordresult){
     const uid=String(r.userId||''),date=day(r.workDate),planned=time(r.baseCheckTime);
     if(!users.includes(uid)||!ids.has(uid)||date<first||date>last||!valid(date)||!['OnDuty','OffDuty'].includes(r.checkType)||!r.timeResult||!planned)throw Error('dingtalk_result_scope_invalid');
     const key=crypto.createHash('sha256').update(JSON.stringify([uid,date,r.checkType,String(r.planId||''),planned])).digest('hex');
     if(keys.has(key))throw Error('dingtalk_result_duplicate');keys.add(key);
     results.push({record_key:key,dingtalk_user_id:uid,work_date:date,check_type:r.checkType,time_result:String(r.timeResult),plan_check_time:planned,user_check_time:time(r.userCheckTime),source_data:JSON.stringify(r)});
    }
    if(!body.hasMore)break;offset+=50;
   }
  }
  const visible=[];let cursor='0';const templateCursors=new Set();
  for(let page=0;;page++){
   if(page>=20)throw Error('dingtalk_template_pagination_limit');
   const r=(await request('/v1.0/workflow/processes/userVisibilities/templates?'+new URLSearchParams({userId:operator,maxResults:'100',nextToken:cursor}))).result,list=r?.processList||r?.list;
   if(!Array.isArray(list))throw Error('dingtalk_templates_incomplete');visible.push(...list);
   const next=r.nextToken;if(next==null||['','-1'].includes(String(next)))break;if(templateCursors.has(String(next))||String(next)===cursor)throw Error('dingtalk_template_pagination_stalled');templateCursors.add(cursor);cursor=String(next);
  }
  const selected=templates.map(t=>{const a=visible.filter(v=>v.name===t.template_name&&(!t.process_code||v.processCode===t.process_code));if(a.length!==1||!a[0].processCode)throw Error('dingtalk_attendance_template_unavailable');return {template_name:t.template_name,process_code:String(a[0].processCode)};});
  if(new Set(selected.map(t=>t.process_code)).size!==selected.length)throw Error('dingtalk_attendance_template_duplicate');
  const instances=new Map(),coverage=[];
  for(const template of selected){
   let next=0;const seen=new Set(),listed=new Set();
   for(let page=0;;page++){
    if(page>=500)throw Error('dingtalk_approval_pagination_limit');
    const r=(await request('/v1.0/workflow/processes/instanceIds/query',{processCode:template.process_code,startTime:Date.parse(from+'T00:00:00+08:00'),endTime:Date.parse(to+'T23:59:59.999+08:00'),maxResults:20,nextToken:next})).result;
    if(!Array.isArray(r?.list))throw Error('dingtalk_approval_list_incomplete');
    for(const id of r.list){if(typeof id!=='string'||!id||listed.has(id)||instances.has(id))throw Error('dingtalk_approval_duplicate');listed.add(id);instances.set(id,template);}
    const n=r.nextToken;if(n==null||['','-1'].includes(String(n)))break;if(seen.has(String(n))||String(n)===String(next)||!/^\d+$/.test(String(n))||!Number.isSafeInteger(Number(n)))throw Error('dingtalk_approval_pagination_stalled');seen.add(String(next));next=Number(n);
   }
   coverage.push({template_name:template.template_name,listed:listed.size,complete:true});
  }
  for(const p of pending){const t=selected.find(t=>t.process_code===p.process_code);if(t&&!instances.has(p.instance_id))instances.set(p.instance_id,t);}
  const items=[];
  for(const [id,t]of instances){
   const detail=(await request('/v1.0/workflow/processInstances?'+new URLSearchParams({processInstanceId:id}))).result;
   if(!detail||!Array.isArray(detail.formComponentValues)||!detail.status||detail.processCode&&String(detail.processCode)!==t.process_code)throw Error('dingtalk_approval_detail_invalid');
   items.push({instance_id:id,...t,detail});
  }
  return {complete:true,from,to,employee_count:mapped.length,results,approvals:items,coverage,api_calls:calls};
 };
}
function service(db,{read=reader(),clock=()=>new Date(),operator=()=>process.env.DINGTALK_SCHEDULE_OPERATOR_ID}={}){
 let busy=false;
 async function sync({from,to,employeeIds}={}){
  if(busy)throw Error('dingtalk_details_sync_running');
  if(!valid(from)||!valid(to)||from>to||shift(from,30)<to||to>new Date(clock().getTime()+28800000).toISOString().slice(0,10))throw Error('dingtalk_details_range_invalid');
  busy=true;const started=clock().toISOString();
  try{
   const mapped=db.queryAll("SELECT id,dingtalk_user_id FROM employees WHERE TRIM(COALESCE(dingtalk_user_id,''))<>'' ORDER BY id").filter(e=>!employeeIds?.length||employeeIds.includes(e.id));
   if(!mapped.length||new Set(mapped.map(e=>e.dingtalk_user_id)).size!==mapped.length)throw Error('dingtalk_detail_employee_mapping_invalid');
   const templates=db.queryAll('SELECT DISTINCT process_code,template_name FROM dingtalk_approval_instances WHERE template_name IN (?,?,?)',['请假申请','加班申请','补卡申请']);
   for(const name of ['请假申请','加班申请','补卡申请'])if(!templates.some(t=>t.template_name===name))templates.push({template_name:name});
   const pending=db.queryAll("SELECT instance_id,process_code FROM dingtalk_approval_instances WHERE status NOT IN ('COMPLETED','TERMINATED','CANCELED')");
   const source=await read({from,to,mapped,operator:operator()||mapped[0].dingtalk_user_id,templates,pending});
   if(source.complete!==true||source.from!==from||source.to!==to||source.employee_count!==mapped.length||!Array.isArray(source.results)||!Array.isArray(source.approvals)||source.coverage?.length!==templates.length||source.coverage.some(c=>c.complete!==true))throw Error('dingtalk_detail_receipt_incomplete');
   const people=new Map(mapped.map(e=>[e.dingtalk_user_id,e.id])),stamp=clock().toISOString(),rows=source.approvals.map(r=>approvals.normalize(r,stamp));
   const current=db.queryAll("SELECT id,dingtalk_user_id FROM employees WHERE TRIM(COALESCE(dingtalk_user_id,''))<>'' ORDER BY id").filter(e=>!employeeIds?.length||employeeIds.includes(e.id));
   if(JSON.stringify(current)!==JSON.stringify(mapped))throw Error('dingtalk_detail_employee_mapping_changed');
   if(source.results.some(r=>!people.has(r.dingtalk_user_id)||r.work_date<from||r.work_date>to))throw Error('dingtalk_result_scope_invalid');
   const receipt={complete:true,date_from:from,date_to:to,employee_count:mapped.length,result_count:source.results.length,approval_count:rows.length,coverage:source.coverage,api_calls:source.api_calls,synced_at:stamp};
   db.run('BEGIN');try{
    for(const e of mapped)db.run('DELETE FROM dingtalk_attendance_results WHERE dingtalk_user_id=? AND work_date BETWEEN ? AND ?',[e.dingtalk_user_id,from,to]);
    for(const r of source.results)db.run('INSERT INTO dingtalk_attendance_results(record_key,employee_id,dingtalk_user_id,work_date,check_type,time_result,plan_check_time,user_check_time,source_data,synced_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[r.record_key,people.get(r.dingtalk_user_id),r.dingtalk_user_id,r.work_date,r.check_type,r.time_result,r.plan_check_time,r.user_check_time,r.source_data,stamp]);
    const fields=['instance_id','process_code','template_name','originator_user_id','subject_user_ids','status','result','leave_type','start_time','end_time','duration','duration_unit','created_at','finished_at','source_data','synced_at'];
    for(const r of rows)db.run('INSERT INTO dingtalk_approval_instances('+fields.join(',')+') VALUES('+fields.map(()=>'?').join(',')+') ON CONFLICT(instance_id) DO UPDATE SET '+fields.slice(1).map(k=>k+'=excluded.'+k).join(','),fields.map(k=>r[k]));
    db.run("INSERT INTO dingtalk_approval_sync_runs(date_from,date_to,status,record_count,message) VALUES(?,?,'success',?,?)",[from,to,rows.length,'考勤审批已完整读取']);
    db.run("INSERT INTO dingtalk_detail_sync_runs(date_from,date_to,status,employee_count,result_count,approval_count,receipt_json,message,started_at,finished_at) VALUES(?,?,'success',?,?,?,?,?,?,?)",[from,to,mapped.length,source.results.length,rows.length,JSON.stringify(receipt),'考勤结果和审批同步完成',started,stamp]);
    db.run('COMMIT');
   }catch(e){db.run('ROLLBACK');throw e;}
   db.save();return receipt;
  }catch(e){const message=/^dingtalk_[a-z_]+$/.test(e.message)?e.message:'dingtalk_details_sync_failed';db.run("INSERT INTO dingtalk_detail_sync_runs(date_from,date_to,status,message,started_at,finished_at) VALUES(?,?,'failed',?,?,?)",[from,to,message,started,clock().toISOString()]);db.save();throw Error(message);}
  finally{busy=false;}
 }
 return {sync,status:()=>({busy,latest:db.queryOne('SELECT date_from,date_to,status,employee_count,result_count,approval_count,message,started_at,finished_at FROM dingtalk_detail_sync_runs ORDER BY id DESC LIMIT 1')})};
}
function mountInternal({app,express,db,audit,details}){
 const prefix='/api/internal/syncbot/dingtalk-attendance-details';
 app.post(prefix+'/sync',express.raw({type:'application/octet-stream',limit:'4kb'}),async(req,res)=>{
  if(!require('./syncbot-coverage').verifyRequest(req,audit).ok)return res.status(401).json({error:'dingtalk_details_sync_denied'});
  try{const b=JSON.parse(req.body.toString('utf8'));if(Object.keys(b).some(k=>!['from','to'].includes(k)))throw Error('dingtalk_details_range_invalid');res.json({ok:true,...await details.sync(b)});}catch(e){res.status(409).json({error:/^dingtalk_[a-z_]+$/.test(e.message)?e.message:'dingtalk_details_sync_failed'});}
 });
}
async function forRequest(details,args,{wait=true,onError=()=>{}}={}){
 if(wait)return details.sync(args);
 const running=details.status().busy;
 if(!running)details.sync(args).catch(onError);
 return {pending:true,already_running:running};
}
module.exports={initialize,reader,service,mountInternal,forRequest};
