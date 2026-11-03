'use strict';
const contract=require('./product-contract');
const {selectOperatingStores,validateJobFilename}=require('./operating-download');
async function prepareProductReport(frame,{storeIds}){
 await frame.locator('span.tab-text').filter({visible:true,hasText:/^商品$/}).click();
 const daily=frame.getByText('按天',{exact:true}).filter({visible:true});
 if(!await daily.evaluate(el=>[...el.classList].some(c=>c.startsWith('active_'))))await daily.click();
 if(!await daily.evaluate(el=>[...el.classList].some(c=>c.startsWith('active_'))))throw Error('product_ui_grain_mismatch');
 await selectOperatingStores(frame,storeIds);
 const labels=frame.locator('label.roo-checkbox').filter({visible:true});
 for(const metric of contract.metrics)await labels.filter({hasText:new RegExp('^'+metric+'$')}).waitFor({state:'visible'});
 // Scope changes asynchronously reload the field options. Reconcile the live
 // selection again if the platform replaced the first checkbox during rendering.
 for(let pass=0,stable=0;pass<6;pass++){
  const inventory=await labels.evaluateAll(es=>es.map(e=>({name:e.textContent.trim(),value:e.querySelector('input')?.value,disabled:e.querySelector('input')?.disabled})));
  for(const item of inventory){if(!item.value||item.disabled)continue;const label=labels.filter({has:frame.locator('input[value="'+item.value+'"]')});if(await label.locator('input').isChecked()!==contract.metrics.includes(item.name))await label.click();}
  await new Promise(resolve=>setTimeout(resolve,350));
  const actual=await labels.evaluateAll(es=>es.filter(e=>{const i=e.querySelector('input');return i?.checked&&i.value;}).map(e=>e.textContent.trim()));
  if(actual.length===contract.metrics.length&&contract.metrics.every(f=>actual.includes(f))){if(++stable===2)break;}else stable=0;
 }
 const selected=['日期',...await labels.evaluateAll(es=>es.filter(e=>{const i=e.querySelector('input');return i?.checked&&(i.value||i.disabled);}).map(e=>e.textContent.trim()))];
 if(selected.length!==contract.fields.length||contract.fields.some(f=>!selected.includes(f)))throw Error('product_ui_selection_mismatch');
 return {fields:selected,scope:'custom_stores',grain:'day',expected_store_ids:storeIds};
}
function validateProductJob(filename,options){if(!filename.startsWith('商品_'))throw Error('product_job_name_mismatch');validateJobFilename('门店_'+filename.slice(3),options);return filename;}
module.exports={prepareProductReport,validateProductJob};
