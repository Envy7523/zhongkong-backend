'use strict';
const base=require('./syncbot-coverage'),{parseFinance}=require('../syncbot/src/douyin-finance-file.cjs');
const prefix='/api/internal/syncbot/douyin-group-report1';
function importSource(db,analytics,body){
 const {from,to,data,file_name,sha256}=body||{};if(typeof data!=='string'||data.length>38*1024*1024||typeof file_name!=='string'||!file_name.endsWith('.xlsx')||/[\\/]/.test(file_name))throw Error('douyin_import_invalid');
 const parsed=parseFinance(Buffer.from(data,'base64'),from,to);if(parsed.sha256!==sha256)throw Error('douyin_source_digest_mismatch');
 const bindings=db.queryAll("SELECT platform_id,store_id FROM store_platforms WHERE platform_name IN ('抖音团购','抖音')");for(const id of parsed.storeIds){const matches=bindings.filter(x=>String(x.platform_id)===id);if(matches.length!==1||!matches[0].store_id)throw Error('douyin_store_binding_invalid');}
 const result=analytics.importDouyinGroupBuyWorkbook(db,{data,file_name},{username:'syncbot-douyin-group'});if(result.raw_imported!==parsed.rowCount||result.unmatched||result.skipped||Math.round(result.gross_total*100)!==parsed.saleCents||Math.round(result.net_total*100)!==parsed.merchantCents)throw Error('douyin_import_readback_failed');
 const actual=db.queryOne('SELECT count(*) row_count,round(sum(sale_amount)*100) sale_cents,round(sum(net_amount)*100) merchant_cents FROM douyin_group_buy_settlement_records WHERE batch_id=?',[result.batch_id]);if(actual.row_count!==parsed.rowCount||actual.sale_cents!==parsed.saleCents||actual.merchant_cents!==parsed.merchantCents)throw Error('douyin_database_readback_failed');return {...result,verified:true,sha256};
}
function mount({app,express,db,audit,businessAnalytics}){
 app.use(prefix,express.raw({type:()=>true,limit:'40mb'}));const auth=(req,res)=>{const r=base.verifyRequest(req,audit);if(!r.ok)res.status(401).json({ok:false,reason:r.reason});return r.ok;};
 app.get(prefix+'/coverage',(req,res)=>{if(!auth(req,res))return;res.json({ok:true,dates:db.queryAll('SELECT income_date,count(*) row_count FROM douyin_group_buy_settlement_records GROUP BY income_date ORDER BY income_date')});});
 app.post(prefix+'/import',(req,res)=>{if(!auth(req,res))return;try{res.status(201).json({ok:true,...importSource(db,businessAnalytics,JSON.parse(base.rawGetBody(req)))});}catch(e){res.status(409).json({ok:false,reason:/^[a-z_]+$/.test(e.message)?e.message:'douyin_import_failed'});}});
}
module.exports={mount,importSource};
