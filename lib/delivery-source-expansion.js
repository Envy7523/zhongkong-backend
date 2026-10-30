'use strict';
// A scope expansion may add shops, but must never revise any previously captured
// row. Preserve the previous original, and commit the replacement atomically.
const crypto=require('node:crypto');
const {parseOperatingBuffer}=require('../syncbot/src/meituan-delivery/operating-file');
const fields=require('../syncbot/src/meituan-delivery/operating-contract').fields;
function canExpand(prior,parsed,date){try{
 const bytes=Buffer.from(prior.source_base64,'base64');if(crypto.createHash('sha256').update(bytes).digest('hex')!==prior.sha256)return false;
 const old=parseOperatingBuffer(bytes,{from:date});if(old.store_count>=parsed.store_count)return false;
 const rows=new Map(parsed.rows.map(r=>[r.日期+':'+r.门店id,r]));return old.rows.every(r=>{const next=rows.get(r.日期+':'+r.门店id);return next&&fields.every(f=>String(r[f]??'').trim()===String(next[f]??'').trim());});
 }catch{return false;}}
function expand(db,prior,reimport){
 const proxy=new Proxy(db,{get(target,key){if(key==='save')return ()=>{};if(key==='run')return (sql,values)=>/^\s*(BEGIN(?:\s+TRANSACTION)?|COMMIT|ROLLBACK)\s*;?\s*$/i.test(sql)?undefined:target.run(sql,values);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 db.run('BEGIN');try{
 db.run(`CREATE TABLE IF NOT EXISTS delivery_collector_file_revisions(device_id TEXT,report_type TEXT,business_date TEXT,store_key TEXT,sha256 TEXT,batch_id INTEGER,source_base64 TEXT,summary_json TEXT,archived_at TEXT,PRIMARY KEY(device_id,report_type,business_date,store_key,sha256))`);
 db.run('INSERT OR IGNORE INTO delivery_collector_file_revisions VALUES(?,?,?,?,?,?,?,?,?)',[prior.device_id,prior.report_type,prior.business_date,prior.store_key,prior.sha256,prior.batch_id,prior.source_base64,prior.summary_json,new Date().toISOString()]);
 db.run('DELETE FROM delivery_collector_files WHERE device_id=? AND report_type=? AND business_date=? AND store_key=? AND sha256=?',[prior.device_id,prior.report_type,prior.business_date,prior.store_key,prior.sha256]);
 const result=reimport(proxy);db.run('COMMIT');db.save();return {...result,scope_expanded:true};
 }catch(e){try{db.run('ROLLBACK');}catch{}throw e;}
}
module.exports={canExpand,expand};
