'use strict';
const base=require('./syncbot-coverage');
const {parseOperation}=require('../syncbot/src/meituan-operation-file.cjs');
const prefix='/api/internal/syncbot/meituan-group-report2';
function ensureSchema(db){
 const columns=new Set(db.queryAll('PRAGMA table_info(meituan_group_buy_operation_records)').map(r=>r.name));
 for(const field of ['checkin_users','consume_users','refund_amount','refund_order_count'])if(!columns.has(field))db.run('ALTER TABLE meituan_group_buy_operation_records ADD COLUMN '+field+' REAL');
}
function importSource(db,analytics,body){
 const {from,to,data,file_name:filename,sha256}=body||{};
 if(typeof data!=='string'||data.length>28*1024*1024||typeof filename!=='string'||!filename.endsWith('.xlsx')||/[\\/]/.test(filename))throw Error('operation_import_invalid');
 const parsed=parseOperation(Buffer.from(data,'base64'),from,to);if(parsed.sha256!==sha256)throw Error('operation_source_verification_failed');
 const bindings=db.queryAll("SELECT platform_id,store_id FROM store_platforms WHERE platform_name='美团团购'");
 for(const id of parsed.storeIds)if(bindings.filter(r=>String(r.platform_id)===id&&r.store_id).length!==1)throw Error('operation_binding_invalid');
 ensureSchema(db);
 const result=analytics.importMeituanGroupOperationWorkbook(db,{data,file_name:filename},{username:'syncbot-meituan-group-report2'});
 if(result.raw_imported!==parsed.rowCount||result.unmatched||result.skipped)throw Error('operation_import_readback_failed');
 const fields={'曝光人数':'impression_users','访问人数':'visit_users','购买人数':'ordering_users','打卡人数':'checkin_users','成交订单数':'order_count','成交金额(优惠后)':'gross_amount','消费金额':'income_amount','消费人数':'consume_users','退款金额':'refund_amount','退款订单数':'refund_order_count','全部评价数':'review_count'};
 const actual=db.queryOne('SELECT count(*) row_count,'+Object.entries(fields).map(([metric,field])=>'round(sum('+field+')*100)/100 "'+metric+'"').join(',')+' FROM meituan_group_buy_operation_records WHERE batch_id=?',[result.batch_id]);
 if(actual.row_count!==parsed.rowCount||Object.keys(fields).some(m=>Math.abs(actual[m]-parsed.totals[m])>.005))throw Error('operation_database_readback_failed');
 return {...result,verified:true,sha256:parsed.sha256,totals:parsed.totals};
}
function mount({app,express,db,audit,businessAnalytics}){
 app.use(prefix,express.raw({type:()=>true,limit:'30mb'}));
 const auth=(req,res)=>{const checked=base.verifyRequest(req,audit);if(!checked.ok)res.status(401).json({ok:false,reason:checked.reason});return checked.ok;};
 app.get(prefix+'/coverage',(req,res)=>{if(!auth(req,res))return;res.json({ok:true,dates:db.queryAll('SELECT biz_date,count(*) row_count FROM meituan_group_buy_operation_records GROUP BY biz_date ORDER BY biz_date')});});
 app.post(prefix+'/import',(req,res)=>{if(!auth(req,res))return;try{res.status(201).json({ok:true,...importSource(db,businessAnalytics,JSON.parse(base.rawGetBody(req)))});}catch(e){res.status(409).json({ok:false,reason:/^[a-z_]+$/.test(e.message)?e.message:'operation_import_failed'});}});
}
module.exports={mount,importSource};
