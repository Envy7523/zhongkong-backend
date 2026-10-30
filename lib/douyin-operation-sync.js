'use strict';
const base=require('./syncbot-coverage'),operation=require('./douyin-operation'),{parseOperation}=require('../syncbot/src/douyin-operation-file.cjs'),XLSX=require('xlsx');
const prefix='/api/internal/syncbot/douyin-group-report2';
function importSource(db,body){
 const {from,to,data,file_name,sha256}=body||{};
 if(typeof data!=='string'||data.length>38*1024*1024||typeof file_name!=='string'||!file_name.endsWith('.xlsx')||/[\\/]/.test(file_name))throw Error('douyin_operation_import_invalid');
 const bytes=Buffer.from(data,'base64'),parsed=parseOperation(bytes,from,to);if(parsed.sha256!==sha256)throw Error('douyin_operation_digest_mismatch');
 const bindings=db.queryAll("SELECT platform_id,store_id FROM store_platforms WHERE platform_name='抖音团购'");for(const id of parsed.storeIds)if(bindings.filter(x=>String(x.platform_id)===id&&x.store_id).length!==1)throw Error('douyin_operation_binding_invalid');
 const result=operation.importReport(db,operation.detect(XLSX.read(bytes,{type:'buffer'})),{file_name},{display_name:'syncbot-douyin-operation'});
 if(result.raw_imported!==parsed.rowCount||result.unmatched)throw Error('douyin_operation_import_readback_failed');
 const actual=db.queryAll('SELECT * FROM douyin_group_buy_operation_records WHERE batch_id=?',[result.batch_id]);if(actual.length!==parsed.rowCount||actual.some(x=>x.match_status!=='matched'||Object.keys(JSON.parse(x.raw_json)).length!==7))throw Error('douyin_operation_database_readback_failed');
 const keys={门店页访问人数:'visit_users',商品点击人数:'click_users',门店意向成交金额:'purchase_amount',门店意向成交人数:'ordering_users',门店核销金额:'consume_amount',门店核销人数:'consume_users',门店意向退款金额:'refund_amount',门店意向退款人数:'refund_users',门店评分:'store_rating',累计评价数:'review_count',门店点亮数:'light_count'};
 for(const [name,key] of Object.entries(keys)){const total=actual.reduce((n,row)=>n+Number(row[key]??JSON.parse(row.raw_json)[key]),0);if(Math.abs(total-parsed.totals[name])>0.000001)throw Error('douyin_operation_metrics_readback_failed');}
 return {...result,verified:true,sha256};
}
function mount({app,express,db,audit}){
 app.use(prefix,express.raw({type:()=>true,limit:'40mb'}));const auth=(req,res)=>{const r=base.verifyRequest(req,audit);if(!r.ok)res.status(401).json({ok:false,reason:r.reason});return r.ok;};
 app.get(prefix+'/coverage',(req,res)=>{if(!auth(req,res))return;res.json({ok:true,dates:db.queryAll('SELECT biz_date,count(*) row_count FROM douyin_group_buy_operation_records GROUP BY biz_date ORDER BY biz_date')});});
 app.post(prefix+'/import',(req,res)=>{if(!auth(req,res))return;try{res.status(201).json({ok:true,...importSource(db,JSON.parse(base.rawGetBody(req)))});}catch(e){res.status(409).json({ok:false,reason:/^[a-z_]+$/.test(e.message)?e.message:'douyin_operation_import_failed'});}});
}
module.exports={mount,importSource};
