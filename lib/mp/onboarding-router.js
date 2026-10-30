const express=require('express'),S=require('../staff-onboarding');
function createRouter({db,authenticate,verifyTicket,qrImage=require('./invite-code').image}){
 const r=express.Router(),wrap=fn=>async(req,res)=>{try{res.json({ok:true,...await fn(req)})}catch(e){res.status(e.status||500).json({error:e.status?e.message:'入职办理失败，请稍后重试'})}};
 const identity=(req,res,fn)=>{if(req.body?.ticket||req.query?.ticket){try{fn({type:'openid',value:verifyTicket(req.body?.ticket||req.query.ticket)})}catch(e){res.status(e.status||401).json({error:e.message})}}else authenticate(req,res,()=>fn({type:'user',value:String(req.mpUser.id)}))};
 r.get('/info',wrap(req=>S.publicInfo(db,req.query.token)));
 // Verify the caller's own identity before reading any request. No anonymous lookup by name/phone/id.
 r.post('/status',(req,res)=>identity(req,res,i=>{try{res.json({ok:true,record:S.ownStatus(db,i)})}catch(e){res.status(e.status||500).json({error:e.message})}}));
 r.post('/apply',(req,res)=>identity(req,res,i=>{try{res.json({ok:true,...S.apply(db,req.body,i)})}catch(e){res.status(e.status||500).json({error:e.status?e.message:'入职提交失败，请稍后重试'})}}));
 r.use(authenticate);
 r.get('/options',wrap(req=>({stores:S.stores(db,req.mpUser)})));
 r.post('/invites',wrap(async req=>{const invite=S.createInvite(db,req.mpUser,req.body);let qr='',qr_error='';try{if(req.body.preview===true){const origin=String(req.get('origin')||'');let url;try{url=new URL(origin)}catch{}if(!url||!['http:','https:'].includes(url.protocol)||!(/^(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)$/.test(url.hostname)))throw Object.assign(new Error('网页预览邀请码仅用于本机或局域网测试'),{status:400});qr=await require('qrcode').toDataURL(origin+'/#/pages/staff/join?token='+invite.token,{width:360,margin:2});}else qr=await qrImage(invite.token)}catch(e){qr_error=e.message}return {invite,qr,qr_error}}));
 r.post('/invites/:id/revoke',wrap(req=>S.revoke(db,req.mpUser,req.params.id)));
 r.get('/records',wrap(req=>S.list(db,req.mpUser)));
 r.post('/records/:id/decision',wrap(req=>S.decide(db,req.mpUser,req.params.id,req.body)));
 return r;
}
module.exports={createRouter};
