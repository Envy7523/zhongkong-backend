'use strict';
const base=require('./syncbot-coverage');
const {parseFinance}=require('../syncbot/src/meituan-group-file.cjs');
const {assertDate}=require('../syncbot/src/meituan-finance-dates.cjs');
const prefix='/api/internal/syncbot/meituan-group-report1';
function importSource(db,analytics,body){
 const {from,to,data,file_name:filename,sha256,expected}=body||{};assertDate(from);assertDate(to);
 if(from>to||typeof data!=='string'||data.length>28*1024*1024||typeof filename!=='string'||!filename.endsWith('.xlsx')||/[\\/]/.test(filename))throw Error('finance_import_invalid');
 if(body.kind==='oneclick'){
  const parsed=require('../syncbot/src/meituan-oneclick-file.cjs').parseFinance(Buffer.from(data,'base64'),from,to);
  const keys=['consumptionCents','deductionCents','posDeductionCents','serviceCents','refundCents','otherCents','nonTradeCents','merchantCents'];
  if(parsed.sha256!==sha256||keys.some(k=>parsed[k]!==expected?.[k]))throw Error('oneclick_source_verification_failed');
  return analytics.importMeituanGroupBuyWorkbook(db,{data,file_name:filename,from,to},{username:'syncbot-meituan-oneclick'},{allStores:true});
 }
 if(body.kind&&body.kind!=='group')throw Error('finance_kind_invalid');
 const parsed=parseFinance(Buffer.from(data,'base64'),from,to);
 if(sha256!==parsed.sha256||expected?.saleCents!==parsed.saleCents||expected?.merchantCents!==parsed.merchantCents)throw Error('finance_source_verification_failed');
 const bindings=db.queryAll("SELECT platform_id,store_id FROM store_platforms WHERE platform_name='美团团购'");
 for(const id of parsed.storeIds){const matches=bindings.filter(r=>String(r.platform_id)===id);if(matches.length!==1||!matches[0].store_id)throw Error('finance_binding_invalid');}
 const result=analytics.importMeituanGroupBuyWorkbook(db,{data,file_name:filename},{username:'syncbot-meituan-group'});
 if(result.raw_imported!==parsed.rowCount||result.unmatched||result.skipped||Math.round(result.gross_total*100)!==parsed.saleCents||Math.round(result.net_total*100)!==parsed.merchantCents)throw Error('finance_import_readback_failed');
 const actual=db.queryOne('SELECT count(*) row_count,round(sum(sale_price)*100) sale_cents,round(sum(merchant_income)*100) merchant_cents FROM meituan_group_buy_benefit_records WHERE batch_id=?',[result.batch_id]);
 if(actual.row_count!==parsed.rowCount||actual.sale_cents!==parsed.saleCents||actual.merchant_cents!==parsed.merchantCents)throw Error('finance_database_readback_failed');
 return {...result,verified:true,sha256:parsed.sha256};
}
function mount({app,express,db,audit,businessAnalytics}){
 app.use(prefix,express.raw({type:()=>true,limit:'30mb'}));
 const auth=(req,res)=>{const checked=base.verifyRequest(req,audit);if(!checked.ok)res.status(401).json({ok:false,reason:checked.reason});return checked.ok;};
 app.get(prefix+'/coverage',(req,res)=>{if(!auth(req,res))return;res.json({ok:true,dates:db.queryAll("SELECT income_date,count(*) row_count FROM meituan_group_buy_benefit_records WHERE benefit_kind='group' GROUP BY income_date ORDER BY income_date"),oneclick_dates:db.queryAll('SELECT income_date,batch_id,verified_at FROM meituan_oneclick_coverage ORDER BY income_date')});});
 app.post(prefix+'/import',(req,res)=>{if(!auth(req,res))return;try{res.status(201).json({ok:true,...importSource(db,businessAnalytics,JSON.parse(base.rawGetBody(req)))});}catch(e){res.status(409).json({ok:false,reason:/^[a-z_]+$/.test(e.message)?e.message:'finance_import_failed'});}});
}
module.exports={mount,importSource};
