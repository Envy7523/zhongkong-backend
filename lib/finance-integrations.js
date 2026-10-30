'use strict';
// Explicit, administrator-triggered read-only source access. No schedule starts
// on mount and no transfer/payment API is called here.
const L=require('./business-ledger');
function create({db,fetchImpl=fetch,env=process.env,getDingToken=()=>require('./dingtalk-attendance').getAccessToken()}) {
  const definitions=()=>{
    let rows;try{rows=JSON.parse(env.FINANCE_APPROVAL_TEMPLATES||'[]');}catch{throw new Error('FINANCE_APPROVAL_TEMPLATES 配置格式错误');}
    if(!Array.isArray(rows))throw new Error('审批模板配置须为数组');
    return rows;
  };
  async function request(url,options={}) {
    const response=await fetchImpl(url,{...options,signal:AbortSignal.timeout(30000)}),body=await response.json();
    if(!response.ok||body.errcode||body.code&&body.code!=='0')throw new Error('源平台请求失败，请检查应用权限、审批编号和服务器配置');
    return body;
  }
  const post=(url,body,headers={})=>request(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  async function wecomToken() {
    if(!env.WECOM_APPROVAL_CORP_ID||!env.WECOM_APPROVAL_SECRET)throw new Error('尚未配置企业微信审批应用凭证');
    const r=await request('https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid='+encodeURIComponent(env.WECOM_APPROVAL_CORP_ID)+'&corpsecret='+encodeURIComponent(env.WECOM_APPROVAL_SECRET));
    if(!r.access_token)throw new Error('企业微信未返回有效凭证');return r.access_token;
  }
  async function fetchApproval(platform,id,config) {
    if(platform==='dingtalk') {
      const token=await getDingToken();
      const b=await request('https://api.dingtalk.com/v1.0/workflow/processInstances?processInstanceId='+encodeURIComponent(id),{headers:{'x-acs-dingtalk-access-token':token}});
      const info=b.result;if(!info||!Array.isArray(info.formComponentValues))throw new Error('钉钉审批详情格式不符合预期');
      let template=String(info.processCode||'');
      // The detail API may omit processCode. Verify membership through the
      // configured template's instance list instead of trusting a UI selection.
      if(!template){
        const at=/^\d{13}$/.test(String(info.createTime))?Number(info.createTime):Date.parse(String(info.createTime));
        if(!Number.isFinite(at))throw new Error('缺少可核验的审批创建时间，不能确认模板归属');
        let cursor=0,found=false;const seen=new Set();
        for(let page=0;page<20;page++){
          const r=(await post('https://api.dingtalk.com/v1.0/workflow/processes/instanceIds/query',{processCode:config.template_id,startTime:Math.max(0,at-86400000),endTime:at+86400000,maxResults:20,nextToken:cursor},{'x-acs-dingtalk-access-token':token})).result;
          if(!Array.isArray(r?.list))throw new Error('钉钉模板实例列表格式异常');
          if(r.list.includes(id)){found=true;break;}
          if(r.nextToken==null||['','-1'].includes(String(r.nextToken)))break;
          if(seen.has(String(r.nextToken))||String(r.nextToken)===String(cursor))throw new Error('钉钉分页未前进，保留原台账');
          seen.add(String(cursor));cursor=r.nextToken;
        }
        if(!found)throw new Error('在单次核验范围内未确认此审批属于指定模板，未导入');
        template=String(config.template_id);
      }
      return {template,fields:Object.fromEntries(info.formComponentValues.map(f=>[f.name,f.value])),approved:info.status==='COMPLETED'&&info.result==='agree',state:info.status==='TERMINATED'?'revoked':info.result==='refuse'?'rejected':info.status==='COMPLETED'&&info.result==='agree'?'approved':'pending',originator:info.originatorUserId||''};
    }
    if(platform==='wecom') {
      const b=await post('https://qyapi.weixin.qq.com/cgi-bin/oa/getapprovaldetail?access_token='+encodeURIComponent(await wecomToken()),{sp_no:id}),info=b.info;
      if(!info||!info.apply_data?.contents)throw new Error('企微审批详情格式不符合预期');
      const fields={};for(const f of info.apply_data.contents){const value=f.value||{};fields[f.id]=value.new_money||value.new_number||value.text||value.money||value.bank_account?.account_number||'';}
      return {template:String(info.template_id),fields,approved:info.sp_status===2,state:info.sp_status===2?'approved':[4,6].includes(info.sp_status)?'revoked':info.sp_status===3?'rejected':info.sp_status===1?'pending':'unknown',originator:info.applyer?.userid||''};
    }
    throw new Error('不支持此审批平台');
  }
  function status() {
    let templates=[],config_error='';try{templates=definitions().map(({key,platform,entity,template_id})=>({key,platform,entity,template_id}));}catch(e){config_error=e.message;}
    return {templates,config_error,wecom_configured:!!(env.WECOM_APPROVAL_CORP_ID&&env.WECOM_APPROVAL_SECRET),dingtalk_configured:require('./dingtalk-attendance').getDingTalkConfig().configured,wecom_reminder_configured:!!(env.WECOM_PAYSLIP_CORP_ID&&env.WECOM_PAYSLIP_SECRET&&env.WECOM_PAYSLIP_AGENT_ID&&env.PAYSLIP_PORTAL_URL),mode:'explicit-single-approval',automatic_sync:false};
  }
  async function importApproval(actor,b,service) {
    if(!actor.admin)throw Object.assign(new Error('仅管理员可同步外部审批'),{status:403});
    const config=definitions().find(r=>r.key===b.template_key),source_no=String(b.source_no||'').trim();
    if(!config||!source_no||source_no.length>120)throw new Error('请选择已配置模板并填写审批编号');
    if(!Number.isSafeInteger(Number(b.requester_id))||Number(b.requester_id)<=0)throw new Error('请填写并核验申请人的内部账号编号');
    let outcome;
    try {
      const data=await fetchApproval(config.platform,source_no,config);
      if(data.template!==String(config.template_id))throw new Error('审批单不属于已配置的财务模板');
      const old=db.queryOne('SELECT * FROM finance_requests WHERE source=? AND entity=? AND source_no=?',[config.platform,config.entity,source_no]);
      const get=key=>data.fields[config[key]];
      const amount=get('amount_field'),account=get('account_field'),beneficiary=get('beneficiary_field');
      if(data.approved&&(typeof amount!=='string'&&typeof amount!=='number'||typeof account!=='string'||typeof beneficiary!=='string'||!account.trim()||!beneficiary.trim()))throw new Error('金额或收款字段映射无效，请管理员检查模板配置');
      const observed={template:data.template,state:data.state,originator:data.originator,approved:data.approved,
        amount:['string','number'].includes(typeof amount)?String(amount).slice(0,100):'',
        account:typeof account==='string'?account.slice(0,100):'',beneficiary:typeof beneficiary==='string'?beneficiary.slice(0,100):''};
      if(old) {
        const paid=service.present(old,actor).paid_cents;
        const changed=data.approved&&(L.money(amount)!==old.amount_cents||account!==old.account||beneficiary!==old.beneficiary);
        const state=changed&&paid>0?'conflict':data.approved?'unverified':data.state;
        L.transaction(db,()=>{
          db.run('INSERT INTO finance_source_observations(request_id,snapshot_json,created_at) VALUES(?,?,?)',[old.id,JSON.stringify(observed),L.stamp()]);
          if(data.approved&&paid===0)db.run('UPDATE finance_requests SET amount_cents=?,account=?,beneficiary=? WHERE id=?',[L.money(amount),account.trim(),beneficiary.trim(),old.id]);
          db.run('UPDATE finance_requests SET approval_state=?,execution_state=?,note=?,version=version+1,updated_at=? WHERE id=?',[state,'held',state==='conflict'?'源审批收款信息或金额与已付款单冲突；保留原付款与收款快照，需管理员和财务处理':'源平台已重新核对，请财务检查变更及既有付款记录',L.stamp(),old.id]);
          L.audit(db,actor,'finance.source-refresh','finance:'+old.id,{approval_state:old.approval_state,amount_cents:old.amount_cents},{approval_state:state,originator:data.originator,amount_cents:data.approved?L.money(amount):null});
        });
        outcome={item:service.present(service.request(old.id,actor),actor),message:'已更新源审批状态并暂缓；请财务核对金额、账户和既有付款后处理'};
      } else {
        if(!data.approved)throw new Error('原审批尚未有效通过，不能建立待付款单');
        outcome={item:service.addRequest(actor,{source:config.platform,entity:config.entity,source_no,title:get('title_field')||'外部审批请款',amount,account,beneficiary,store_id:config.store_id,requester_id:Number(b.requester_id),historical:b.historical!==false,note:'外部审批发起人：'+data.originator},false),message:'已读取原审批；申请人与收款字段仍须财务核验，历史付款状态默认待核实'};
        L.transaction(db,()=>db.run('INSERT INTO finance_source_observations(request_id,snapshot_json,created_at) VALUES(?,?,?)',[outcome.item.id,JSON.stringify(observed),L.stamp()]));
      }
      L.transaction(db,()=>db.run('INSERT INTO finance_sync_runs(platform,source_no,status,message,actor_id,created_at) VALUES(?,?,?,?,?,?)',[config.platform,source_no,'success',outcome.message,actor.id,L.stamp()]));
      return outcome;
    } catch(e) {
      L.transaction(db,()=>db.run('INSERT INTO finance_sync_runs(platform,source_no,status,message,actor_id,created_at) VALUES(?,?,?,?,?,?)',[config.platform,source_no,'failed',e.message.slice(0,200),actor.id,L.stamp()]));throw e;
    }
  }
  async function remind(actor,row) {
    const accounts=db.queryAll('SELECT * FROM users').filter(u=>require('./employee-mini-context').employee(db,u)?.id===row.employee_id);
    if(accounts.length!==1)throw new Error('员工与登录账号未唯一绑定，请先核验身份');
    const recipient=accounts[0],channel='wecom';
    const identities=db.queryAll("SELECT identity_id FROM mp_identities WHERE user_id=? AND identity_type='wxwork' AND status='active'",[recipient.id]);
    if(identities.length!==1)throw new Error('员工尚未唯一绑定企业微信；可在小程序主动领取');
    if(!status().wecom_reminder_configured)throw new Error('企微个人提醒尚未配置；工资条仍可在小程序领取');
    const portal=new URL(env.PAYSLIP_PORTAL_URL);if(portal.protocol!=='https:')throw new Error('工资条入口须使用HTTPS');
    const old=db.queryOne('SELECT * FROM payslip_deliveries WHERE payslip_id=? AND channel=? AND recipient_id=?',[row.id,channel,recipient.id]);
    if(old?.state==='sent')return {message:'此版本已发送提醒，无需重复发送'};
    if(old&&['sending','unknown'].includes(old.state))throw new Error('上次发送结果待核实，请勿重复发送');
    L.transaction(db,()=>{db.run('INSERT INTO payslip_deliveries(payslip_id,channel,recipient_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(payslip_id,channel,recipient_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at',[row.id,channel,recipient.id,'sending',L.stamp(),L.stamp()]);});
    let sent=false;
    try {
      const t=await request('https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid='+encodeURIComponent(env.WECOM_PAYSLIP_CORP_ID)+'&corpsecret='+encodeURIComponent(env.WECOM_PAYSLIP_SECRET));
      if(!t.access_token)throw new Error('企微提醒应用未返回凭证');
      // Message body contains neither salary amounts nor public bearer links.
      portal.pathname='/my/payslips';portal.search='';portal.hash='';
      sent=true;
      const result=await post('https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token='+encodeURIComponent(t.access_token),{touser:identities[0].identity_id,msgtype:'text',agentid:Number(env.WECOM_PAYSLIP_AGENT_ID),text:{content:row.period+'工资条已发布，请登录本人账号核对：'+portal.href},enable_duplicate_check:1,duplicate_check_interval:1800});
      if(result.invaliduser||result.unlicenseduser)throw new Error('接收人不在应用可见范围或无接口许可');
      L.transaction(db,()=>{db.run("UPDATE payslip_deliveries SET state='sent',detail=?,updated_at=? WHERE payslip_id=? AND channel=? AND recipient_id=?",['接口已接受提醒，不代表已查看或签收',L.stamp(),row.id,channel,recipient.id]);L.audit(db,actor,'payslip.remind','payslip:'+row.id,null,{recipient_id:recipient.id,channel});});
      return {message:'个人提醒已提交，员工签收状态单独记录'};
    }catch(e){L.transaction(db,()=>db.run('UPDATE payslip_deliveries SET state=?,detail=?,updated_at=? WHERE payslip_id=? AND channel=? AND recipient_id=?',[sent?'unknown':'failed',sent?'发送结果待核实，请勿直接重发':e.message,L.stamp(),row.id,channel,recipient.id]));throw e;}
  }
  return {status,importApproval,remind};
}
module.exports={create};
