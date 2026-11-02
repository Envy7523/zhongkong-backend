'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {runJdReportStep}=require('../syncbot/src/jd-delivery/report-probe');
test('JD calendar ignores hidden copies but rejects multiple visible matching dates',async()=>{
 let clicked=0,visible=1;
 const locator={filter(o){assert.equal(o.visible,true);return {waitFor:async()=>{},count:async()=>visible,click:async()=>clicked++};}};
 const frame={url:()=> 'https://kunce-store.jddj.com/waimai/report-download',descriptor:{},broker:{call:async()=>({visibility:'visible',reportControls:[{title:'2026-10-23',className:'ant-picker-cell-in-view'}]})},locator:()=>locator};
 await runJdReportStep(frame,{step:'select-day',date:'2026-10-23'});assert.equal(clicked,2);visible=2;await assert.rejects(runJdReportStep(frame,{step:'select-day',date:'2026-10-23'}),/day_missing/);assert.equal(clicked,2);
});
test('JD selects the product tab even when another visible control is also named product',async()=>{
 let clicked=false;
 const frame={url:()=> 'https://kunce-store.jddj.com/waimai/report-download',descriptor:{},broker:{call:async()=>({visibility:'visible'})},getByText(){throw Error('ambiguous_product_text');},locator(selector){
  assert.equal(selector,'[role="tab"]');
  return {filter(o){assert.equal(o.visible,true);assert.equal(o.hasText.test('商品'),true);return {click:async()=>{clicked=true;}};}};
 }};
 await runJdReportStep(frame,{step:'product-tab'});assert.equal(clicked,true);
});
test('empty exports only retry after isolated server evidence authorizes refreshing; money errors do not loop',()=>{
 const {retryable}=require('../syncbot/windows-client/platform-schedule.cjs');assert.equal(retryable({status:'failed',code:'collector_no_active_source_rows'}),false);assert.equal(retryable({status:'failed',code:'collector_no_active_source_rows',rejectedSource:{refreshAllowed:true}}),true);assert.equal(retryable({status:'failed',code:'settlement_bill_reconciliation_failed',rejectedSource:{refreshAllowed:true}}),false);assert.equal(retryable({status:'completed',code:'client_cloud_unreachable'}),false);
});
test('rejected originals are immutable diagnostics, never import receipts, scoped and bounded',()=>{
 const {archive}=require('../lib/delivery-rejected-sources'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'rejected-source-'));
 const bytes=Buffer.concat([Buffer.from('PK'),Buffer.alloc(30)]),device={id:'78ebc0a9-c202-4005-af9e-6295f937bedb'},current={platform:'taobao_flash',date:'2026-10-23',version:'a'.repeat(64)};
 const body={platform:'taobao_flash',type:'operating',date:current.date,scope_version:current.version,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),data:bytes.toString('base64'),error:'collector_no_active_source_rows'},options={directory,now:new Date('2026-10-24T02:00:00Z')};
 try{assert.equal(archive(device,body,current,options).accepted_for_import,false);assert.equal(archive(device,body,current,options).sha256,body.sha256);assert.equal(fs.readdirSync(path.join(directory,device.id,body.date)).length,2);
 assert.throws(()=>archive(device,{...body,sha256:'0'.repeat(64)},current,options),/hash_invalid/);assert.throws(()=>archive(device,{...body,scope_version:'b'.repeat(64)},current,options),/invalid/);assert.throws(()=>archive(device,{...body,type:'../../file'},current,options),/invalid/);assert.throws(()=>archive(device,{...body,error:'success'},current,options),/invalid/);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
