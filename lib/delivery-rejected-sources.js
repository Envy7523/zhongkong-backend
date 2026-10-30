'use strict';
// Failed originals are isolated from business imports. They cannot count as a receipt.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function archive(device,body,current,{directory=path.resolve('data/delivery-rejected-sources'),now=new Date()}={}){
 const {platform,type,date,scope_version,sha256,data,error}=body||{};
 if(Object.keys(body||{}).some(k=>!['platform','type','date','scope_version','sha256','data','error'].includes(k))||
 !/^[a-f0-9-]{36}$/.test(device.id)||!['meituan_delivery','jd_delivery','taobao_flash'].includes(platform)||!['operating','product','settlement'].includes(type)||
 !['settlement_bill_reconciliation_failed','collector_no_active_source_rows'].includes(error)||!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||
 !(Date.parse(date+'T00:00:00+08:00')<now.getTime()&&Date.parse(date+'T00:00:00+08:00')>now.getTime()-14*86400000)||
 current?.version!==scope_version||current.platform&&current.platform!==platform||current.date!==date||
 !/^[a-f0-9]{64}$/.test(sha256||'')||typeof data!=='string'||data.length>40*1024*1024)throw Error('collector_diagnostic_invalid');
 const bytes=Buffer.from(data,'base64');if(bytes.length<20||bytes.length>30*1024*1024||bytes.subarray(0,2).toString()!=='PK'||hash(bytes)!==sha256)throw Error('collector_diagnostic_hash_invalid');
 const dir=path.join(directory,device.id,date);fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const file=path.join(dir,platform+'_'+type+'_'+sha256+'.xlsx');
 if(!fs.existsSync(file)){const files=fs.readdirSync(dir).filter(n=>n.endsWith('.xlsx'));if(files.length>=48||files.reduce((n,f)=>n+fs.statSync(path.join(dir,f)).size,0)+bytes.length>120*1024*1024)throw Error('collector_diagnostic_limit');fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600});}
 else if(hash(fs.readFileSync(file))!==sha256)throw Error('collector_diagnostic_hash_invalid');
 fs.writeFileSync(file+'.json',JSON.stringify({device_id:device.id,platform,type,date,sha256,error,bytes:bytes.length,at:now.toISOString(),scope_version}),{mode:0o600});
 return {ok:true,accepted_for_import:false,sha256,bytes:bytes.length};
}
function mount({app,db,scope,PREFIX}){app.post(PREFIX+'/diagnostic-source',(req,res)=>{try{const current=scope(db,req.body?.date,req.body?.platform),receipt=archive(req.collector,req.body,current),prior=db.queryOne('SELECT sha256 FROM delivery_collector_files WHERE device_id=? AND report_type=? AND business_date=?',[req.collector.id,req.body.platform+'_'+req.body.type,req.body.date]);res.json({...receipt,refresh_allowed:!prior});}catch(e){res.status(409).json({error:/^[a-z_]+$/.test(e.message)?e.message:'collector_diagnostic_invalid'});}});}
module.exports={archive,mount};
