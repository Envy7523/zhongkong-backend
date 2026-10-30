'use strict';
// A user click starts one read-only source snapshot. No timer runs on mount.
const crypto=require('node:crypto'),S=require('./finance-approval-summaries'),L=require('./business-ledger');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
// Quote JSON number tokens outside strings. IDs and decimal money never pass through Number.
function losslessJson(input){
 const s=String(input);let out='',i=0;
 while(i<s.length){
  if(s[i]==='"'){const from=i++;let escaped=false;while(i<s.length){const c=s[i++];if(c==='"'&&!escaped)break;if(c==='\\'&&!escaped)escaped=true;else escaped=false;}out+=s.slice(from,i);continue;}
  if(s[i]==='-'||/[0-9]/.test(s[i])){const m=s.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);if(!m)fail('源数据数字格式无效');out+=JSON.stringify(m[0]);i+=m[0].length;continue;}
  out+=s[i++];
 }
 return JSON.parse(out);
}
function cents(value){
 const m=String(value??'').trim().match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);if(!m)return null;
 const exponent=Number(m[4]||0),fraction=m[3]||'';if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>100||m[2].length+fraction.length>150)return null;
 let n=BigInt(m[2]+fraction);if(m[1]&&n)return null;const power=2+exponent-fraction.length;
 if(power>=0)n*=10n**BigInt(power);else {const d=10n**BigInt(-power);if(n%d)return null;n/=d;}
 return n<=99999999999n?Number(n):null;
}
function amount(fields){
 const found=[];
 for(const field of fields){if(field.componentType!=='TableField')continue;let extra;try{extra=typeof field.extValue==='string'?losslessJson(field.extValue):field.extValue;}catch{continue;}
  for(const stat of extra?.statValue||[]){const label=String(stat.label||'').replace(/（/g,'(').replace(/）/g,')').replace(/\s/g,'');if(['总报销金额(元)','报销总金额(元)','总金额(元)'].includes(label)&&stat.num!=null&&typeof stat.num!=='boolean')found.push(cents(stat.num));}
 }
 return found.length===1&&found[0]!==null?{amount_cents:found[0],amount_note:''}:{amount_cents:null,amount_note:'源金额统计缺失、不唯一或格式待核'};
}
function range(period,now=Date.now()){
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period||''))fail('请选择正确月份');const [year,month]=period.split('-').map(Number);
 if(year<2000||year>2100)fail('查询月份超出支持范围');
 const start=Date.UTC(year,month-1,1)-8*3600000,end=Math.min(Date.UTC(year,month,1)-8*3600000-1,now);if(start>end)fail('不能同步尚未开始的月份');
 return {start,end,date_from:period+'-01',date_to:new Date(end+8*3600000).toISOString().slice(0,10)};
}
function createDingtalkReader({db,env=process.env,fetchImpl=fetch,getToken=()=>require('./dingtalk-attendance').getAccessToken(),now=Date.now,sleep=wait,spacing=250}={}){
 let last=0,gate=Promise.resolve();
 async function request(path,token,body){
  for(let attempt=0;attempt<3;attempt++){
   const turn=gate.then(async()=>{const pause=Math.max(0,last+spacing-now());if(pause)await sleep(pause);last=now();});gate=turn.catch(()=>{});await turn;
   const response=await fetchImpl('https://api.dingtalk.com'+path,{method:body?'POST':'GET',headers:{'x-acs-dingtalk-access-token':token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
   if([429,502,503,504].includes(response.status)&&attempt<2){await sleep(1000*(attempt+1));continue;}
   let data;try{data=losslessJson(await response.text());}catch{fail('钉钉响应格式无效，未更新审批数据',502);}
   if(!response.ok||data.errcode&&!['0',0].includes(data.errcode)||data.code&&!['0',0].includes(data.code))fail('钉钉审批读取失败，请检查企业应用、模板及读取权限',502);
   return data;
  }
 }
 return async function read(period,progress=()=>{}){
  if(!env.DINGTALK_APP_KEY||!env.DINGTALK_APP_SECRET||!env.DINGTALK_CORP_ID)fail('当前服务未配置钉钉审批应用，不能获取最新平台数据',503);
  const r=range(period,now()),tenant_key=hash(env.DINGTALK_CORP_ID||env.DINGTALK_APP_KEY),started=now();
  let employees=[];try{employees=db.queryAll("SELECT dingtalk_user_id,name FROM employees WHERE dingtalk_user_id<>'' ORDER BY id");}catch(e){if(!/no such (table|column)/i.test(e.message))throw e;}
  const operator=String(env.DINGTALK_SCHEDULE_OPERATOR_ID||employees[0]?.dingtalk_user_id||'');if(!operator)fail('缺少已授权的钉钉读取操作人，请管理员核对应用配置',503);
  const token=await getToken(),visible=[];let cursor='0';const seen=new Set();
  progress({phase:'读取财务审批模板',done:0,total:0});
  for(let page=0;;page++){
   if(page>=20)fail('钉钉模板分页超出限额，未更新数据',502);
   const result=(await request('/v1.0/workflow/processes/userVisibilities/templates?'+new URLSearchParams({userId:operator,maxResults:'100',nextToken:String(cursor)}),token)).result;
   const list=result?.processList||result?.list;if(!Array.isArray(list))fail('钉钉模板列表不完整，未更新数据',502);visible.push(...list);
   const next=result.nextToken;if(next==null||['','-1'].includes(String(next)))break;if(seen.has(String(next))||String(next)===String(cursor))fail('钉钉模板分页停滞，未更新数据',502);seen.add(String(cursor));cursor=next;
  }
  let configured;try{configured=env.FINANCE_APPROVAL_SUMMARY_TEMPLATES?JSON.parse(env.FINANCE_APPROVAL_SUMMARY_TEMPLATES):[{name:'鹅太公费用报销单'},{name:'批量付款'}];}catch{fail('财务摘要模板配置格式错误',503);}
  if(!Array.isArray(configured)||!configured.length)fail('未配置财务摘要模板',503);
  const templates=configured.map(c=>{const matches=visible.filter(t=>c.processCode?String(t.processCode)===String(c.processCode):t.name===c.name);if(matches.length!==1||!matches[0].processCode)fail('财务审批模板不可见或不唯一，请管理员核对',503);return matches[0];});
  if(new Set(templates.map(t=>t.processCode)).size!==templates.length)fail('财务摘要模板配置重复',503);
  const coverage=[],tasks=[];
  for(const template of templates){
   let next=0;const cursors=new Set(),ids=new Set();
   for(let page=0;;page++){
    if(page>=500)fail('钉钉审批列表超出单次读取限额，未更新数据',502);
    const result=(await request('/v1.0/workflow/processes/instanceIds/query',token,{processCode:String(template.processCode),startTime:r.start,endTime:r.end,maxResults:20,nextToken:next})).result;
    if(!Array.isArray(result?.list))fail('钉钉审批实例清单不完整，未更新数据',502);
    for(const id of result.list){if(typeof id!=='string'||!id||ids.has(id))fail('钉钉审批实例重复或格式异常，未更新数据',502);ids.add(id);}
    const n=result.nextToken;if(n==null||['','-1'].includes(String(n)))break;
    if(cursors.has(String(n))||String(n)===String(next)||!/^\d+$/.test(String(n))||!Number.isSafeInteger(Number(n)))fail('钉钉审批列表分页异常，未更新数据',502);cursors.add(String(next));next=Number(n);
   }
   coverage.push({template_id:String(template.processCode),template_name:template.name,listed:ids.size,list_complete:true});for(const id of ids)tasks.push({id,template});
  }
  if(new Set(tasks.map(t=>t.id)).size!==tasks.length)fail('同一审批出现在多个模板，未更新数据',502);
  const items=new Array(tasks.length);let index=0,done=0,stopped=false;
  progress({phase:'读取最新审批状态',done,total:tasks.length});
  async function worker(){while(!stopped&&index<tasks.length){const at=index++,{id,template}=tasks[at];try{
   const d=(await request('/v1.0/workflow/processInstances?'+new URLSearchParams({processInstanceId:id}),token)).result;
   if(!d||typeof d!=='object'||!Array.isArray(d.formComponentValues)||!d.status||d.processCode&&String(d.processCode)!==String(template.processCode))fail('钉钉审批详情或模板归属异常，未更新数据',502);
   const fields=d.formComponentValues,originator=String(d.originatorUserId||''),title=String(d.title||template.name).slice(0,200),marker='提交的'+template.name;
   const matches=employees.filter(e=>String(e.dingtalk_user_id)===originator),prefix=title.endsWith(marker)?title.slice(0,-marker.length).trim():'';
   const applicant_name=matches.length===1?matches[0].name:prefix.length<=40?prefix:'';
   items[at]={platform:'dingtalk',tenant_key,instance_id:id,template_id:String(template.processCode),template_name:template.name,business_no:String(d.businessId||''),applicant_external_id:originator,applicant_name,department:String(d.originatorDeptName||''),source_department_id:String(d.originatorDeptId||''),title,reason:String(fields.find(f=>f.name==='申请事由')?.value||'').slice(0,240),...amount(fields),source_status:String(d.status),source_result:String(d.result||''),source_created_at:String(d.createTime||''),source_finished_at:String(d.finishTime||'')};
   done++;progress({phase:'读取最新审批状态',done,total:tasks.length});
  }catch(e){stopped=true;throw e;}}}
  const workers=await Promise.allSettled(Array.from({length:Math.min(3,tasks.length)},worker));const failure=workers.find(w=>w.status==='rejected');if(failure)throw failure.reason;
  return {format:'finance-approval-summary-v1',platform:'dingtalk',tenant_key,...{date_from:r.date_from,date_to:r.date_to},fetched_at:new Date(now()).toISOString(),started_at:new Date(started).toISOString(),coverage,complete:true,errors:[],items,source_writes:0};
 };
}
function create({db,reader=createDingtalkReader({db}),now=Date.now}={}){
 const jobs=new Map();let active=null;
 function publicJob(j){return {id:j.id,status:j.status,progress:j.progress,started_at:j.started_at,finished_at:j.finished_at,error:j.error};}
 function start(actor,query={}){
  S.assertManager(db,actor);range(query.period,now());
  if(query.platform&&!['dingtalk','wecom'].includes(query.platform))fail('请选择支持的审批平台');
  if(query.platform==='wecom')fail('企业微信审批摘要同步尚未接通，不能显示为最新数据',503);
  if(active)fail('平台审批正在同步，请完成后再点击查询／更新',409);
  for(const [id,j] of jobs)if(j.expires<now())jobs.delete(id);
  const job={id:crypto.randomBytes(20).toString('hex'),actorId:actor.id,status:'running',query:{...query},progress:{phase:'准备读取钉钉审批',done:0,total:0},started_at:new Date(now()).toISOString(),expires:now()+30*60000};jobs.set(job.id,job);active=job.id;
  job.promise=(async()=>{try{
   const batch=await reader(query.period,p=>{job.progress=p;});if(batch.platform!=='dingtalk')fail('审批来源与读取任务不一致',502);
   if(!String(batch.date_from||'').startsWith(query.period+'-')||!String(batch.date_to||'').startsWith(query.period+'-'))fail('审批批次与查询月份不一致，未更新数据',502);
   job.progress={phase:'保存并核验审批摘要',done:batch.items?.length||0,total:batch.items?.length||0};
   const system={id:null,username:'平台同步（财务手动触发）',channel:'sync',admin:true};
   job.imported=S.importBatch(db,batch,system);if(job.imported.stale)fail('当前数据已有较新批次，请重新查询',409);job.sources=[{platform:batch.platform,tenant_key:batch.tenant_key,instance_ids:new Set(batch.items.map(r=>r.instance_id))}];
   L.transaction(db,()=>L.audit(db,actor,'finance.approval-refresh','approval-import:'+job.imported.run_id,null,{period:query.period,platform:batch.platform,run_id:job.imported.run_id,total:batch.items.length,trigger:'query-button'}));
   job.status='succeeded';job.progress={phase:'同步完成',done:batch.items.length,total:batch.items.length};job.finished_at=new Date(now()).toISOString();
  }catch(e){job.status='failed';job.error=e.status?e.message:'平台同步未完成，请检查网络或企业应用配置后重试';job.finished_at=new Date(now()).toISOString();}finally{active=null;}})();
  return publicJob(job);
 }
 function status(actor,id){
  S.assertManager(db,actor);const job=jobs.get(id);if(!job||job.actorId!==actor.id||job.expires<now())fail('本次查询不存在或已过期，请重新点击查询／更新',404);
  return {...publicJob(job),...(job.status==='succeeded'?{result:{...S.list(db,actor,job.query,{sources:job.sources,runId:job.imported.run_id}),sync:{platforms:['dingtalk'],finished_at:job.finished_at,source_count:job.imported.total,notice:'企业微信审批摘要尚未接通，未纳入本次查询'}}}:{})};
 }
 return {start,status};
}
module.exports={create,createDingtalkReader,losslessJson,cents,amount,range};
