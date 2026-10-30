'use strict';
const express=require('express');
const ledger=require('./business-ledger');
function createRouter({db,channel='web',authenticate,buildPayslip,listPayslips,integrations,proofRoot,approvalRefresh}) {
  const router=express.Router(),service=ledger.create(db,{buildPayslip});
  if(authenticate)router.use(authenticate);
  router.use((req,res,next)=>{try{req.ledgerActor=ledger.actorFor(db,req.mpUser||req.user,channel);if(!req.ledgerActor.admin&&!require('./common-capabilities').forUser(req.ledgerActor,req.ledgerActor.permissions).length)throw Object.assign(new Error('采集导入身份不能办理人员请款或工资条'),{status:403});next();}catch(e){res.status(e.status||400).json({error:e.message});}});
  const wrap=fn=>async(req,res)=>{try{res.json({ok:true,...await fn(req,req.ledgerActor)});}catch(e){res.status(e.status||400).json({error:e.message});}};
  router.get('/context',wrap((req,a)=>({employee_bound:!!require('./employee-mini-context').employee(db,a),privacy_version:ledger.PAYSLIP_PRIVACY_VERSION,payslip_consent:db.queryOne('SELECT version FROM payslip_consents WHERE user_id=?',[a.id])?.version===ledger.PAYSLIP_PRIVACY_VERSION,can_manage:a.can('finance.payments.manage'),can_publish:a.can('payroll.publish')&&ledger.scopeFor(db,a,'payroll.publish')===null,admin:a.admin,stores:db.queryAll('SELECT id,store_name FROM stores').filter(s=>ledger.inScope(db,a,a.can('finance.payments.manage')?'finance.payments.manage':null,s.id))})));
  router.post('/payslips/consent',wrap((req,a)=>{
    if(req.body.accept!==true||req.body.version!==ledger.PAYSLIP_PRIVACY_VERSION)throw new Error('请主动同意当前工资条个人信息用途');
    ledger.transaction(db,()=>{db.run('INSERT INTO payslip_consents(user_id,version,accepted_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET version=excluded.version,accepted_at=excluded.accepted_at',[a.id,ledger.PAYSLIP_PRIVACY_VERSION,ledger.stamp()]);ledger.audit(db,a,'payslip.consent','user:'+a.id,null,{version:ledger.PAYSLIP_PRIVACY_VERSION});});return {};
  }));
  router.use('/payslips/mine',(req,res,next)=>db.queryOne('SELECT version FROM payslip_consents WHERE user_id=?',[req.ledgerActor.id])?.version===ledger.PAYSLIP_PRIVACY_VERSION?next():res.status(403).json({error:'请先单独同意本人薪资领取和签收用途',code:'PAYSLIP_CONSENT_REQUIRED'}));
  router.get('/requests',wrap((req,a)=>{
    const mine=req.query.mine==='1'||!a.can('finance.payments.manage');
    const rows=db.queryAll('SELECT * FROM finance_requests ORDER BY id DESC').filter(r=>mine?r.requester_id===a.id:ledger.inScope(db,a,'finance.payments.manage',r.store_id)).map(r=>service.present(r,a));
    const filtered=rows.filter(r=>!req.query.state||r.state===req.query.state);
    const page=Math.max(1,Number(req.query.page)||1),limit=50;
    return {items:filtered.slice((page-1)*limit,page*limit),total:filtered.length,page,summary:{remaining_cents:rows.filter(r=>['unpaid','partial'].includes(r.state)).reduce((s,r)=>s+r.remaining_cents,0),unverified:rows.filter(r=>['unverified','history_unverified'].includes(r.state)).length}};
  }));
  const retiredManual=(req,res)=>res.status(410).json({error:'手工请款和付款登记已停用，请在钉钉或企业微信办理审批，由财务在请款审批清单上传凭证并确认款项',code:'MANUAL_FINANCE_RETIRED'});
  router.post('/requests',retiredManual);
  router.get('/requests/:id',wrap((req,a)=>({item:service.present(service.request(req.params.id,a),a),events:db.queryAll('SELECT actor_name,action,created_at FROM operation_audit WHERE resource=? ORDER BY id',['finance:'+Number(req.params.id)])})));
  router.post('/requests/:id/action',retiredManual);
  router.post('/requests/:id/payments',retiredManual);
  router.post('/requests/:id/payments/:paymentId/reverse',retiredManual);
  router.get('/payslips/mine',wrap((req,a)=>{
    const employee=ledger.boundEmployee(db,a);
    return {employee_name:employee.name,items:db.queryAll(`SELECT p.id,p.period,p.revision,p.published_at,p.withdrawn_at,p.withdraw_reason,r.viewed_at,r.confirmed_at,r.objection_at FROM published_payslips p LEFT JOIN payslip_receipts r ON r.payslip_id=p.id WHERE p.employee_id=? ORDER BY p.period DESC,p.revision DESC`,[employee.id])};
  }));
  router.get('/payslips/mine/:id',wrap((req,a)=>{
    const row=service.payslip(req.params.id,a);if(row.withdrawn_at)return {item:service.slipDto({...row,snapshot_json:'{}'})};
    const prior=db.queryOne('SELECT * FROM payslip_receipts WHERE payslip_id=?',[row.id]);
    if(!prior?.viewed_at)ledger.transaction(db,()=>{db.run('INSERT INTO payslip_receipts(payslip_id,user_id,viewed_at) VALUES(?,?,?) ON CONFLICT(payslip_id) DO UPDATE SET user_id=excluded.user_id,viewed_at=COALESCE(payslip_receipts.viewed_at,excluded.viewed_at)',[row.id,a.id,ledger.stamp()]);});
    return {item:service.slipDto(row,db.queryOne('SELECT * FROM payslip_receipts WHERE payslip_id=?',[row.id]))};
  }));
  router.post('/payslips/mine/:id/receipt',wrap((req,a)=>({receipt:service.receipt(a,req.params.id,req.body)})));
  // Management and integration routes never become available through the mini API.
  if(channel==='web') {
    const approvalSummaries=require('./finance-approval-summaries');
    const refresh=approvalRefresh||require('./finance-approval-refresh').create({db});
    router.post('/approvals/query',wrap((req,a)=>({job:refresh.start(a,req.body)})));
    router.get('/approvals/query/:jobId',(req,res,next)=>{res.set('Cache-Control','private, no-store');next();},wrap((req,a)=>({job:refresh.status(a,req.params.jobId)})));
    const proofs=require('./finance-approval-proofs').create(db,proofRoot),approvalRow=req=>approvalSummaries.record(db,req.ledgerActor,req.params.id);
    const storeBindings=require('./finance-approval-stores');
    router.get('/approval-store-bindings',wrap((req,a)=>storeBindings.listBindings(db,a,req.query)));
    router.post('/approval-store-bindings/:bindingId',wrap((req,a)=>({store_match:storeBindings.saveBinding(db,a,req.params.bindingId,req.body)})));
    router.get('/approvals',(req,res,next)=>{res.set('Cache-Control','private, no-store');next();},wrap((req,a)=>approvalSummaries.list(db,a,req.query)));
    router.post('/approvals/:id/action',wrap((req,a)=>({item:approvalSummaries.action(db,a,req.params.id,req.body,proofs)})));
    router.get('/approvals/:id/proofs',wrap((req,a)=>({items:proofs.list(approvalRow(req),a)})));
    router.post('/approvals/:id/proofs',(req,res,next)=>{try{approvalRow(req);next();}catch(e){res.status(e.status||400).json({error:e.message});}},express.raw({type:'application/octet-stream',limit:'8mb'}),wrap(async(req,a)=>({proof:await proofs.upload(a,approvalRow(req),req.query.version,req.query.name,req.body,{uploadKey:req.query.upload_key||''})})));
    router.delete('/approvals/:id/proofs/:proofId',wrap((req,a)=>proofs.remove(a,approvalRow(req),req.params.proofId)));
    router.get('/approvals/:id/proofs/:proofId',(req,res)=>{try{
      const {proof,buffer}=proofs.download(approvalRow(req),req.params.proofId);
      res.set({'Content-Type':proof.mime,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(proof.original_name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16)),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}).send(buffer);
    }catch(e){res.status(e.status||400).json({error:e.message});}});
    router.use('/approvals',(e,req,res,next)=>{if(e.type==='entity.too.large')return res.status(413).json({error:'付款凭证不能超过8MB'});next(e);});
    router.get('/payslips/candidates',wrap((req,a)=>{
      ledger.assertRight(a,'payroll.publish');if(ledger.scopeFor(db,a,'payroll.publish')!==null)throw Object.assign(new Error('需要完整工资范围'),{status:403});
      if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.period||''))throw new Error('请选择月份');
      return {items:listPayslips?listPayslips(req.query.period):[]};
    }));
    router.get('/payslips',wrap((req,a)=>{
      ledger.assertRight(a,'payroll.publish');if(ledger.scopeFor(db,a,'payroll.publish')!==null)throw Object.assign(new Error('需要完整工资范围'),{status:403});
      if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.period||''))throw new Error('请选择月份');
      return {items:db.queryAll(`SELECT p.id,p.employee_id,p.period,p.revision,p.content_hash,p.published_at,p.withdrawn_at,p.withdraw_reason,e.name,r.viewed_at,r.confirmed_at,r.confirmation_name,r.objection,r.objection_at FROM published_payslips p LEFT JOIN employees e ON e.id=p.employee_id LEFT JOIN payslip_receipts r ON r.payslip_id=p.id WHERE p.period=? ORDER BY p.id DESC`,[req.query.period]),deliveries:db.queryAll('SELECT d.* FROM payslip_deliveries d JOIN published_payslips p ON p.id=d.payslip_id WHERE p.period=? ORDER BY d.id DESC',[req.query.period])};
    }));
    router.post('/payslips/publish',wrap((req,a)=>({item:service.publish(a,req.body)})));
    router.post('/payslips/:id/withdraw',wrap((req,a)=>{
      const row=service.payslip(req.params.id,a,true);if(!String(req.body.reason||'').trim())throw new Error('请填写撤回原因');
      if(!row.withdrawn_at)ledger.transaction(db,()=>{db.run('UPDATE published_payslips SET withdrawn_at=?,withdraw_reason=? WHERE id=?',[ledger.stamp(),String(req.body.reason).slice(0,500),row.id]);ledger.audit(db,a,'payslip.withdraw','payslip:'+row.id,null,{reason:req.body.reason});});return {};
    }));
    router.post('/payslips/:id/remind',wrap(async(req,a)=>{
      const row=service.payslip(req.params.id,a,true);if(row.withdrawn_at)throw new Error('已撤回版本不能提醒');
      if(req.body.confirm!==true)throw new Error('请明确确认发送个人提醒');
      if(!integrations)throw new Error('提醒服务未配置');return integrations.remind(a,row);
    }));
    router.use('/integrations',(req,res,next)=>req.ledgerActor.admin?next():res.status(403).json({error:'仅管理员可配置和同步外部审批'}));
    router.get('/integrations',wrap(()=>({...(integrations?.status()||{}),runs:db.queryAll('SELECT * FROM finance_sync_runs ORDER BY id DESC LIMIT 50')})));
    router.post('/integrations/import',wrap(async(req,a)=>{
      if(req.body.confirm!==true)throw new Error('请明确确认读取并导入指定审批单');
      if(!integrations)throw new Error('外部审批服务未配置');return integrations.importApproval(a,req.body,service);
    }));
  }
  return router;
}
module.exports={createRouter};
