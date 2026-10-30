'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {atomic}=require('./core.cjs');
async function importDevice({bundleFile,installRoot=path.resolve(__dirname,'..'),root=require('./core.cjs').dataRoot(),fetchImpl}={}){
 const envelope=JSON.parse(fs.readFileSync(bundleFile,'utf8')),bytes=Buffer.from(envelope.payload||'','base64');
 if(bytes.length>24000||!crypto.verify(null,bytes,fs.readFileSync(path.join(installRoot,'windows-client/update-public-key.pem')),Buffer.from(envelope.signature||'','base64')))throw Error('device_package_signature_invalid');
 const b=JSON.parse(bytes),c=b.credentials,u=new URL(c.origin);if(u.protocol!=='https:'||u.pathname!=='/'||u.search||u.hash||u.username||u.password||!/^\d{4}-\d{2}-\d{2}$/.test(c.scheduleStartDay)||b.kind!=='delivery-device'||! /^[a-f0-9]{64}$/.test(c.token||'')||c.localAddress||c.certificateMode!=='provisioned'||c.multiPlatform!==true)throw Error('device_package_invalid');
 if(!Number.isFinite(Date.parse(b.expiresAt))||Date.parse(b.expiresAt)<Date.now())throw Error('device_package_expired');
 const cert=new crypto.X509Certificate(b.certificate);if(Date.parse(cert.validTo)<Date.now()||Date.parse(cert.validFrom)>Date.now()||!(require('node:net').isIP(u.hostname)?cert.checkIP(u.hostname):cert.checkHost(u.hostname)))throw Error('device_certificate_invalid');
 if(fs.existsSync(path.join(root,'cloud-device.json')))throw Error('device_already_configured');
 for(let p=path.resolve(root);;p=path.dirname(p)){if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('device_data_path_invalid');if(path.dirname(p)===p)break;}
 const request=fetchImpl||require('./cloud-https.cjs').certifiedFetch(b.certificate),date=new Date(Date.now()+28800000-86400000).toISOString().slice(0,10);
 for(const platform of ['meituan_delivery','jd_delivery','taobao_flash']){const response=await request(c.origin+'/api/internal/syncbot/delivery-client/config?date='+date+'&platform='+platform,{headers:{Authorization:'Bearer '+c.token},signal:AbortSignal.timeout(20000)}),v=await response.json();if(!response.ok||v.ok!==true||v.account!==b.accounts[platform])throw Error('device_cloud_connection_failed');}
 fs.mkdirSync(root,{recursive:true,mode:0o700});fs.writeFileSync(path.join(root,'cloud-server-ca.pem'),b.certificate,{flag:'wx',mode:0o600});
 try{atomic(path.join(root,'cloud-device.json'),{origin:u.origin,token:c.token,certificateMode:'provisioned',multiPlatform:true,scheduleStartDay:c.scheduleStartDay});}catch(e){fs.unlinkSync(path.join(root,'cloud-server-ca.pem'));throw e;}
 return {ok:true,deviceId:b.deviceId,startDay:c.scheduleStartDay};
}
if(require.main===module)importDevice({bundleFile:process.argv[2]}).then(async r=>{console.log('授权配置已安装，三平台中控连接核验通过。');const root=require('./core.cjs').dataRoot(),instance=require('./core.cjs').read(path.join(root,'client-instance.json'),null);let restart=true;if(instance&&Number.isInteger(instance.port)&&/^[a-f0-9]{64}$/.test(instance.token||'')){try{const response=await fetch('http://127.0.0.1:'+instance.port+'/api/quit',{method:'POST',headers:{'Content-Type':'application/json','X-Client-Token':instance.token},body:'{}',signal:AbortSignal.timeout(3000)});restart=response.ok;}catch{}}
 if(restart){await new Promise(resolve=>setTimeout(resolve,600));const child=require('node:child_process').spawn(process.execPath,[path.join(__dirname,'bootstrap.cjs'),'--serve-only'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,ETG_COLLECTOR_HOME:root},detached:true,windowsHide:true,stdio:'ignore'});child.on('error',()=>{});child.unref();console.log('客户端已启动，请在扩展中确认连接。');}else console.log('客户端正在采集，请等待结束后在客户端点击退出，再重新启动。');console.log('首次自动运行日期：'+r.startDay);
}).catch(e=>{console.error('授权未安装：'+(/^[a-z_]+$/.test(e.message)?e.message:'device_import_failed'));process.exitCode=1;});
module.exports={importDevice};
