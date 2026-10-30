'use strict';
const crypto=require('node:crypto'),X=require('xlsx');
const platforms={taobao_flash:{name:'淘宝闪购',parse:require('../syncbot/src/taobao-flash/source-file').inspectFlashBuffer,importer:'importTaobaoFlashWorkbook',bills:'taobao_flash_bills',id:'platform_store_id'},jd_delivery:{name:'京东外卖',parse:require('../syncbot/src/jd-delivery/source-file').inspectJdBuffer,importer:'importJdDeliveryWorkbook',bills:'jd_delivery_bills',id:'jd_store_id'}};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),cents=n=>Math.round(Number(n)*100);
function spec(platform){if(!platforms[platform])throw Error('collector_platform_invalid');return platforms[platform];}
function types(platform){spec(platform);return Object.fromEntries(['operating','product','settlement'].map(t=>[t,platform+'_'+t]));}
function scope(db,date,platform){const p=spec(platform);if(require('../syncbot/src/meituan-delivery/operating-file').plainDate(date)!==date)throw Error('collector_date_invalid');
 const rows=db.queryAll('SELECT s.*,p.platform_id,p.online_date FROM store_platforms p JOIN stores s ON s.id=p.store_id WHERE p.platform_name=? ORDER BY s.id',[p.name]).filter(r=>require('./daily-update-health').operatingOn(r,date)&&(!r.online_date||r.online_date<=date));
 const bindings=rows.filter(r=>/^\d+$/.test(String(r.platform_id||'').trim())).map(r=>({platform_id:String(r.platform_id).trim(),store_id:r.id,store_name:r.store_name}));
 const missing=rows.filter(r=>!/^\d+$/.test(String(r.platform_id||'').trim())).map(r=>({store_id:r.id,store_name:r.store_name}));
 if(bindings.length>200||new Set(bindings.map(r=>r.platform_id)).size!==bindings.length)throw Error('collector_bindings_invalid');
 return {platform,date,bindings,missing,version:hash(JSON.stringify({platform,date,bindings,missing}))};
}
function mark(db,device,type,date,status,current,summary={},error=''){const report=types(current.platform)[type];if(!report)throw Error('collector_report_invalid');
 db.run(`INSERT INTO delivery_collector_runs VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(device_id,report_type,business_date) DO UPDATE SET status=excluded.status,scope_json=excluded.scope_json,summary_json=excluded.summary_json,error_code=excluded.error_code,updated_at=excluded.updated_at`,[device.id,report,date,status,JSON.stringify(current),JSON.stringify(summary),error,new Date().toISOString()]);
 if(db.queryOne("SELECT name FROM sqlite_master WHERE name='sync_job_events'")){const receipt=require('./sync-job-audit').ingestEvents(db,[{event_id:crypto.randomUUID(),task_id:'delivery-'+device.id+'-'+current.platform+'-'+type+'-'+date,report_type:report,business_date:date,platform:current.platform,stage:({running:'PRECHECK',importing:'IMPORT_STARTED',success:'IMPORT_SUCCEEDED',unverified:'WAITING_HUMAN',failed:'FAILED',waiting_human:'WAITING_HUMAN',interrupted:'FAILED'})[status],at:new Date().toISOString(),metrics:{imported:summary.storage_verified?1:0,raw_store_count:summary.expected||0,matched_store_count:summary.actual||0,...(summary.batch_id?{import_batch_id:summary.batch_id}:{}),...(error?{failure_reason:error}:{})}}]);if(receipt.rejected?.length)throw Error('collector_audit_rejected');}
 db.save();
}
function parse(buffer,current,type){return spec(current.platform).parse(buffer,{type,date:current.date,expectedStoreIds:current.bindings.map(r=>r.platform_id),allowUnmatched:true});}
function verify(db,current,type,batch,parsed){const p=spec(current.platform),ids=new Set(current.bindings.map(r=>r.platform_id)),rows=parsed.rows.filter(r=>ids.has(r.store_id));
 if(type==='operating'){
  const actual=db.queryAll('SELECT * FROM delivery_operation_records WHERE platform=? AND biz_date=? AND batch_id=?',[p.name,current.date,batch]);if(actual.length!==rows.length)throw Error('collector_database_count_mismatch');
  for(const wanted of rows){const got=actual.find(r=>r.platform_store_id===wanted.store_id);if(!got||got.match_status!=='matched'||cents(got.gross_amount)!==wanted.gross_cents||cents(got.income_amount)!==wanted.income_cents||Number(got.order_count)!==wanted.orders)throw Error('collector_database_metric_mismatch');}return actual.length;
 }
 const groups=new Map();
 for(const row of rows){const name=type==='product'?row.name:current.platform==='taobao_flash'?row.bill_type:(row.raw['订单二级类型']?row.order_type+' · '+row.raw['订单二级类型']:row.order_type),key=JSON.stringify([row.store_id,name]),g=groups.get(key)||{id:row.store_id,name,amount:0,quantity:0,count:0};g.amount+=type==='product'?row.sales_cents:row.amount_cents??row.receivable_cents;g.quantity+=Math.round(Number(row.quantity||0)*10000);g.count++;groups.set(key,g);}
 let actual;
 if(type==='product')actual=db.queryAll('SELECT p.*,s.platform_id source_id FROM business_product_sales p JOIN store_platforms s ON p.store_id=s.store_id AND s.platform_name=? WHERE p.platform=? AND p.channel=? AND p.biz_date=? AND p.batch_id=?',[p.name,p.name,current.platform,current.date,batch]);
 else actual=db.queryAll('SELECT *, '+p.id+' source_id FROM '+p.bills+' WHERE bill_date=? AND batch_id=?',[current.date,batch]);
 if(actual.length!==groups.size)throw Error('collector_database_count_mismatch');
 for(const got of actual){const wanted=groups.get(JSON.stringify([got.source_id,type==='product'?got.product_name:got.bill_type]));if(!wanted||cents(type==='product'?got.sales_amount:got.amount)!==wanted.amount||type==='product'&&Math.round(Number(got.quantity)*10000)!==wanted.quantity||current.platform==='jd_delivery'&&type==='settlement'&&Number(got.transaction_count)!==wanted.count)throw Error('collector_database_metric_mismatch');}
 if(type==='settlement'){
  const byStore=new Map();for(const row of rows)byStore.set(row.store_id,(byStore.get(row.store_id)||0)+(row.amount_cents??row.receivable_cents));
  for(const [id,amount]of byStore){const binding=current.bindings.find(r=>r.platform_id===id),daily=db.queryOne('SELECT actual_amount FROM business_revenue_records WHERE platform=? AND channel=? AND source_type=? AND biz_date=? AND store_id=?',[p.name,current.platform,'platform',current.date,binding.store_id]);if(!daily||cents(daily.actual_amount)!==amount)throw Error('collector_database_daily_metric_mismatch');}
 }
 return actual.length;
}
function importFile(db,analytics,device,body){const {platform,type,date,scope_version,sha256,data}=body,p=spec(platform);if(!types(platform)[type]||typeof data!=='string'||data.length>40*1024*1024||body.store_key)throw Error('collector_upload_invalid');
 const current=scope(db,date,platform);if(!current.bindings.length)throw Error('collector_scope_unconfigured');if(current.version!==scope_version)throw Error('collector_scope_changed');
 const buffer=Buffer.from(data,'base64');if(hash(buffer)!==sha256)throw Error('collector_hash_mismatch');const parsed=parse(buffer,current,type);
 const report=types(platform)[type],prior=db.queryOne('SELECT * FROM delivery_collector_files WHERE device_id=? AND report_type=? AND business_date=? AND store_key=?',[device.id,report,date,'']);if(prior&&prior.sha256!==sha256)throw Error('collector_source_changed_review_required');
 let batch=prior?.batch_id;
 if(!prior||JSON.parse(prior.summary_json||'{}').scope_version!==current.version){const wanted=parsed.rows.filter(r=>r.matched);if(!wanted.length)throw Error('collector_no_active_source_rows');const workbook=X.utils.book_new(),sheet=X.utils.json_to_sheet(wanted.map(r=>r.raw));if(platform==='jd_delivery'&&type==='settlement'){const grid=X.utils.sheet_to_json(sheet,{header:1,raw:true,defval:''});X.utils.book_append_sheet(workbook,X.utils.aoa_to_sheet([['京东对账单'],...grid]),'data');}else X.utils.book_append_sheet(workbook,sheet,'data');
  const result=analytics[p.importer](db,{data:X.write(workbook,{bookType:'xlsx',type:'buffer'}).toString('base64'),file_name:'collector_'+platform+'_'+type+'_'+date+'.xlsx',report_kind:type==='product'?'products':type},{username:'delivery-device',display_name:device.name});if(result.unmatched||result.skipped)throw Error('collector_import_incomplete');batch=result.batch_id;
 }
 const count=verify(db,current,type,batch,parsed),{rows,...summary}=parsed;Object.assign(summary,{storage_count:count,batch_id:batch,storage_verified:true,scope_version:current.version});
 if(!prior)db.run('INSERT INTO delivery_collector_files VALUES(?,?,?,?,?,?,?,?)',[device.id,report,date,'',sha256,batch,data,JSON.stringify(summary)]);else db.run('UPDATE delivery_collector_files SET batch_id=?,summary_json=? WHERE device_id=? AND report_type=? AND business_date=? AND store_key=?',[batch,JSON.stringify(summary),device.id,report,date,'']);mark(db,device,type,date,'importing',current,summary);return {ok:true,reused:!!prior,verification:summary};
}
function finish(db,device,{platform,type,date,scope_version,dryRun=false}){const current=scope(db,date,platform),p=spec(platform);if(!types(platform)[type]||current.version!==scope_version)throw Error('collector_scope_changed');const file=db.queryOne('SELECT * FROM delivery_collector_files WHERE device_id=? AND report_type=? AND business_date=? AND store_key=?',[device.id,types(platform)[type],date,'']);if(!file)throw Error('collector_files_incomplete');const buffer=Buffer.from(file.source_base64,'base64');if(hash(buffer)!==file.sha256)throw Error('collector_source_hash_changed');const parsed=parse(buffer,current,type),storageCount=verify(db,current,type,file.batch_id,parsed);
 const unknown=parsed.unmatched_store_ids.filter(id=>!db.queryOne('SELECT store_id FROM store_platforms WHERE platform_name=? AND platform_id=?',[p.name,id]));
 const zeroProductStores=[];let operatingProof;
 function zeroProductActivity(id){
  if(operatingProof===undefined){
   const original=db.queryOne('SELECT * FROM delivery_collector_files WHERE device_id=? AND report_type=? AND business_date=? AND store_key=?',[device.id,types(platform).operating,date,'']);
   operatingProof=null;
   if(original){const bytes=Buffer.from(original.source_base64,'base64');if(hash(bytes)!==original.sha256)throw Error('collector_source_hash_changed');const source=parse(bytes,current,'operating');verify(db,current,'operating',original.batch_id,source);operatingProof=source;}
  }
  const source=operatingProof?.rows.find(r=>r.store_id===id);
  // Net income may contain fees even on a day with no sales. The original
  // operating file and its stored metrics, rather than net income alone,
  // establish whether an absent product row is a legitimate zero-sales day.
  if(!source||source.orders!==0||source.gross_cents!==0||source.income_cents>0)return false;
  zeroProductStores.push(id);return true;
 }
 const missing=parsed.stores_without_rows.filter(id=>{if(type==='operating')return true;const op=db.queryOne('SELECT * FROM delivery_operation_records WHERE platform=? AND biz_date=? AND platform_store_id=?',[p.name,date,id]);if(!op||Number(op.order_count)!==0)return true;const raw=JSON.parse(op.raw_json||'{}');if(!['有效订单','订单数'].some(k=>raw[k]!==undefined&&String(raw[k]).trim()!==''&&Number(raw[k])===0))return true;if(type==='product')return !zeroProductActivity(id);return cents(op.income_amount)!==0;});
 const summary={zero_product_store_ids:zeroProductStores,storage_verified:true,storage_count:storageCount,batch_id:file.batch_id,count:parsed.row_count,expected:current.bindings.length,actual:current.bindings.length-missing.length,missing:unknown.map(id=>({platform_id:id,store_name:'报表存在但中控未关联的门店（平台ID：'+id+'）'})),missing_store_ids:missing,unknown_store_ids:unknown,excluded_store_ids:parsed.unmatched_store_ids};const needsReview=!!(missing.length||unknown.length),status=needsReview?'unverified':'success';if(!dryRun)mark(db,device,type,date,status,current,summary,needsReview?'collector_store_coverage_incomplete':'');return {ok:true,status,verification:summary};
}
module.exports={platforms,types,scope,mark,parse,verify,importFile,finish};
