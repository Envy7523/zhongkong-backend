'use strict';
const express=require('express'),transfers=require('./staff-transfers'),messages=require('./store-messages'),access=require('./personnel-access');
const workflow=require('./staff-role-workflow');
const hq=require('./headquarter-staff-workflow'),engine=require('./workflow-engine');
function createRouter({db,authenticate,channel='web'}){
 const r=express.Router();r.use(authenticate);const wrap=fn=>async(req,res)=>{try{res.json({ok:true,...await fn(req)})}catch(e){res.status(e.status||500).json({error:e.status?e.message:'门店流程操作失败，请重试'})}};
 r.use('/training',require('./staff-training').createRouter({db}));
 r.use('/reports',require('./store-report-router').createRouter({db,channel}));
 r.use('/inspections',require('./inspection-router').createRouter({db,channel}));
 r.use('/custom-workflows',require('./custom-workflow-router').createRouter({db,channel}));
 if(channel==='mini')r.use('/employee-profiles',require('./mini-employee-profile-router').createRouter({db}));
 const onboarding=require('./staff-onboarding');
 if(channel==='web'){r.get('/onboarding/config',wrap(req=>onboarding.config(db,req.operationUser)));r.put('/onboarding/config',wrap(req=>onboarding.saveConfig(db,req.operationUser,req.body)));r.get('/onboarding/records',wrap(req=>onboarding.list(db,req.operationUser,'web')));}
 const offboard=require('./staff-offboarding');
 r.get('/offboarding/config',wrap(req=>offboard.config(db,req.operationUser)));
 if(channel==='web')r.put('/offboarding/config',wrap(req=>offboard.saveConfig(db,req.body,req.operationUser)));
 r.get('/offboarding/records',wrap(req=>offboard.list(db,req.operationUser,channel)));
 r.get('/offboarding/records/:id',wrap(req=>({record:offboard.present(db,offboard.load(db,req.params.id),req.operationUser,channel)})));
 r.post('/offboarding/records/:id/complete',wrap(req=>offboard.complete(db,req.params.id,req.body,req.operationUser,channel)));
 const support=require('./staff-support');
 r.get('/support/requests',wrap(req=>support.list(db,req.operationUser,channel==='web')));
 r.get('/support/requests/:id',wrap(req=>({record:support.present(db,support.load(db,req.params.id),req.operationUser,channel==='web')})));
 if(channel==='mini'){
  r.get('/support/options',wrap(req=>support.options(db,req.operationUser,req.query)));
  r.post('/support/requests',wrap(req=>support.start(db,req.body,req.operationUser)));
  r.post('/support/requests/:id/decision',wrap(req=>support.decide(db,req.params.id,req.body,req.operationUser)));
 }
 r.get('/workflow/requests',wrap(req=>req.query.business&&req.query.business!=='staff-mini-role'?hq.list(db,req.operationUser,req.query.business,channel==='web'):workflow.list(db,req.operationUser,channel==='web')));
 r.post('/workflow/requests/:id/decision',wrap(req=>hq.TYPES.includes(engine.load(db,req.params.id).business)?hq.decide(db,req.params.id,req.body,req.operationUser,channel==='web'):workflow.decide(db,req.params.id,req.body,req.operationUser,channel==='web')));
 r.get('/workflow/hq-options',wrap(req=>hq.options(db,req.operationUser,channel==='web')));
 r.post('/workflow/hq-requests',wrap(req=>hq.start(db,req.body,req.operationUser,channel==='web')));
 if(channel==='mini'){
  r.get('/workflow/options',wrap(req=>workflow.options(db,req.operationUser)));
  r.post('/workflow/requests',wrap(req=>workflow.start(db,req.body,req.operationUser)));
 }else{
  r.get('/workflow/config',wrap(req=>req.query.business&&req.query.business!=='staff-mini-role'?hq.config(db,req.operationUser,req.query.business):workflow.config(db,req.operationUser)));
  r.post('/workflow/templates',wrap(req=>req.body.business&&req.body.business!=='staff-mini-role'?hq.save(db,req.body,req.operationUser):workflow.save(db,req.body,req.operationUser)));
 }
 if(channel==='mini'){
  r.get('/transfers/options',wrap(req=>transfers.options(db,req.operationUser)));
  r.get('/transfers',wrap(req=>({rows:transfers.list(db,req.operationUser,req.query)})));
  r.get('/transfers/:id',wrap(req=>({record:transfers.get(db,req.params.id,req.operationUser)})));
  r.post('/transfers',wrap(req=>({record:transfers.start(db,req.body,req.operationUser)})));
  r.post('/transfers/batch',wrap(req=>transfers.startBatch(db,req.body,req.operationUser)));
  r.post('/transfers/:id/decision',wrap(req=>({record:transfers.decide(db,req.params.id,req.body,req.operationUser)})));
  r.get('/messages',wrap(req=>messages.list(db,req.operationUser,req.query)));
  r.get('/messages/:id',wrap(req=>({record:messages.read(db,req.params.id,req.operationUser)})));
  r.post('/messages/:id/read',wrap(req=>({record:messages.read(db,req.params.id,req.operationUser)})));
  r.post('/messages/:id/confirm',wrap(req=>({record:messages.read(db,req.params.id,req.operationUser,true)})));
 }else{
  r.get('/config',wrap(req=>{if(!messages.can(req.operationUser,'staff.onboarding.view')&&!messages.can(req.operationUser,'workflow.manage')&&!messages.can(req.operationUser,'staff.offboarding.view')&&!messages.can(req.operationUser,'staff.transfers.view')&&!messages.can(req.operationUser,'staff.support.view')&&!messages.can(req.operationUser,'store-notices.manage'))throw Object.assign(new Error('没有门店流程查询权限'),{status:403});return {regions:db.queryAll('SELECT id,name,parent_id FROM store_regions'),permissions:req.operationUser.position_permissions,stores:db.queryAll('SELECT id,store_name FROM stores'),positions:access.positions(db).filter(p=>p.enabled&&p.channels.includes('mini')).map(p=>({id:p.id,name:p.name})),rules:messages.rules(db),types:messages.TYPES}}));
  r.get('/transfers',wrap(req=>({rows:transfers.list(db,req.operationUser,req.query,true)})));
  r.get('/transfers/export', (req,res)=>{try{const rows=transfers.list(db,req.operationUser,req.query,true),fields=['employee_name','from_store_name','to_store_name','status','reason','initiated_name','created_at','decided_name','decided_at','decision_note'];const labels=['员工','原店','接收店','状态','原因','发起人','发起时间','处理人','处理时间','处理意见'];const safe=v=>'"'+String(v??'').replace(/^[=+@-]/,'\'$&').replace(/"/g,'""')+'"';res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="staff-transfers.csv"');res.send('\ufeff'+labels.map(safe).join(',')+'\r\n'+rows.map(row=>fields.map(f=>safe(row[f])).join(',')).join('\r\n'))}catch(e){res.status(e.status||500).json({error:e.message})}});
  r.get('/announcements',wrap(req=>{messages.requireManage(req.operationUser);return {rows:db.queryAll('SELECT * FROM store_announcements ORDER BY id DESC').filter(a=>{try{messages.requireAudience(db,req.operationUser,JSON.parse(a.audience_json));return true}catch{return false}}).map(a=>({...a,...JSON.parse(a.audience_json),audience_json:undefined}))}}));
  r.post('/announcements',wrap(req=>messages.saveAnnouncement(db,req.body,req.operationUser)));
  r.get('/announcements/:id/report',wrap(req=>({rows:messages.report(db,req.params.id,req.operationUser)})));
  r.put('/rules',wrap(req=>{messages.requireManage(req.operationUser);if(messages.manageScope(db,req.operationUser)!==null)throw Object.assign(new Error('仅全门店通知管理岗位可调整全局提醒规则'),{status:403});const value={};for(const key of Object.keys(messages.TYPES)){if(typeof req.body[key]!=='boolean')throw Object.assign(new Error('提醒设置不完整'),{status:400});value[key]=req.body[key]}messages.audit(db,req.operationUser,'rules.save',null,messages.rules(db),value);db.run("INSERT INTO store_message_meta VALUES('rules',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[JSON.stringify(value)]);db.save();return {rules:value}}));
  r.get('/audit',wrap(req=>{messages.requireManage(req.operationUser);return {rows:db.queryAll('SELECT * FROM store_operation_audits ORDER BY id DESC LIMIT 200')}}));
 }return r;
}
module.exports={createRouter};
