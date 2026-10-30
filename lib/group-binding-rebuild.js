'use strict';
// Rebuild derived revenue/SKU snapshots from stored source rows after an exact
// platform-ID match. The caller owns the transaction; raw reports stay intact.
function rebuild(db,{from,to,batchId,storeId,platformName}) {
  const mt=platformName==='美团团购';
  if(!mt&&platformName!=='抖音团购')throw Error('不支持的团购来源');
  const table=mt?'meituan_group_buy_benefit_records':'douyin_group_buy_settlement_records';
  const channel=mt?'meituan_group':'douyin_group';
  const rows=db.queryAll(`SELECT * FROM ${table} WHERE store_id=? AND income_date BETWEEN ? AND ? AND match_status='matched'`,[storeId,from,to]);
  const byDate=new Map();for(const row of rows){if(!byDate.has(row.income_date))byDate.set(row.income_date,[]);byDate.get(row.income_date).push(row);}
  const analytics=require('./business-analytics');let netTotal=0,productRows=0;
  for(const [incomeDate,records] of byDate){
    const result=(mt?analytics.replaceMeituanGroupBuyRevenue:analytics.replaceDouyinGroupBuyRevenue)(db,{batchId,storeId,incomeDate});
    netTotal+=mt?result.merchant:result.net;
    const products=new Map();
    for(const r of records){
      const name=mt?r.project_name:r.product_name,amount=Number(mt?r.sale_price:r.sale_amount)||0;
      if(!name||(mt&&(r.benefit_kind==='oneclick'||!['消费','撤销'].includes(r.transaction_type)||Math.abs(amount)<0.000001)))continue;
      const p=products.get(name)||{name,quantity:0,amount:0,ids:new Set(),storeName:r.store_name};
      p.quantity+=mt?(amount<0||r.transaction_type==='撤销'?-1:1):(r.record_type==='退款'?-1:1);p.amount+=amount;
      let id=String(r.project_id||'').trim();
      if(!mt){let raw={};try{raw=JSON.parse(r.raw_json||'{}');}catch{}
        const labels=['商品ID','商品id','套餐ID','套餐id','项目ID','项目id','团购ID','团购id','商品编号','SPU ID','商品SPU'];
        id=String(raw[Object.keys(raw).find(k=>labels.includes(k.trim()))]||'').trim();}
      if(id)p.ids.add(id);products.set(name,p);
    }
    db.run("DELETE FROM business_product_sales WHERE store_id=? AND biz_date=? AND source_type='platform' AND channel=?",[storeId,incomeDate,channel]);
    for(const p of products.values()){
      db.insert(`INSERT INTO business_product_sales (batch_id,store_id,store_name,biz_date,source_type,platform,channel,product_name,platform_product_id,quantity,sales_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,[batchId,storeId,p.storeName,incomeDate,'platform',platformName,channel,p.name,p.ids.size===1?[...p.ids][0]:'',p.quantity,p.amount]);productRows++;
    }
  }
  return {revenueRecords:byDate.size,productRows,netTotal};
}
module.exports={rebuild};
