'use strict';
const base=require('./syncbot-coverage');
const PATH='/api/internal/syncbot/order-detail-coverage';
function mountOrderDetailCoverage({app,express,db,audit}) {
 app.use(PATH,express.raw({type:()=>true,limit:'16kb'}));
 app.get(PATH,(req,res)=>{
  const auth=base.verifyRequest(req,audit); if(!auth.ok)return res.status(401).json({ok:false,reason:auth.reason});
  const day=String(req.query.business_date||'');if(!base.isRealDate(day))return res.status(400).json({ok:false,reason:'business_date_invalid'});
  try {
   const count=db.queryOne('SELECT COUNT(*) n,COUNT(DISTINCT store_id) stores FROM pos_channel_orders WHERE biz_date=?',[day]);
   const batches=db.queryAll(`SELECT b.id,b.file_name,b.row_count,b.date_from,b.date_to FROM business_import_batches b JOIN pos_order_imports i ON i.batch_id=b.id WHERE i.date_from<=? AND i.date_to>=?`,[day,day]);
   const codes=require('./store-pos-identity').codesForDate(db,day).map(x=>({id:x.id,name:x.store_name,pos_store_code:x.pos_store_code}));
   res.json({ok:true,report_type:'all_channel_orders',business_date:day,has_records:count.n>0,record_count:count.n,order_count:count.n,store_count:count.stores,import_batches:batches.map(b=>({batch_id:b.id,file_name:b.file_name,row_count:b.row_count,date_from:b.date_from,date_to:b.date_to})),store_codes:codes,store_codes_complete:codes.length>0,truncated:false,safe_to_skip_sync:false,report_eligible:false});
  }catch(e){res.status(503).json({ok:false,reason:'order_coverage_query_failed'});}
 });
}
module.exports={PATH,mountOrderDetailCoverage};
