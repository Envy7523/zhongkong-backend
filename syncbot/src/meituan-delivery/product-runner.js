'use strict';
const {runOperating}=require('./runner');
const contract=require('./product-contract');
const {parseProductFile}=require('./product-file');
const {prepareProductReport,validateProductJob}=require('./product-download');
async function runProduct(options){
 if(!options.downloadOnly)throw Error('product_cloud_upload_not_configured');
 if(typeof options.downloadFile!=='function')throw Error('product_file_receiver_required');
 const result=await runOperating({...options,explicitStoreSelection:true,report:{contract,parseFile:parseProductFile,prepare:prepareProductReport,validateJob:validateProductJob}});
 const fs=require('node:fs'),path=require('node:path');
 const operatingFile=path.join(options.root,'downloads/meituan_delivery/meituan_delivery_operating',options.date+'_custom'+(options.scopeKey?'_'+options.scopeKey:''),'operating.csv');
 if(fs.existsSync(operatingFile)){
  const operating=require('./operating-file').parseOperatingFile(operatingFile,{from:options.date,expectedStoreIds:[...result.store_ids,...result.stores_without_rows]});
  result.stores_with_operating_orders_without_products=operating.rows.filter(r=>result.stores_without_rows.includes(r.门店id)&&Number(r.有效订单)>0).map(r=>r.门店id);
  result.reconciliation='different_date_basis_requires_review';
 }else result.reconciliation='operating_source_not_available';
 return result;
}
module.exports={runProduct};
