'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),X=require('xlsx');
const {runPlatform}=require('../syncbot/windows-client/platform-runner.cjs');
const {runJdStep}=require('../syncbot/src/jd-delivery/browser-probe');
const date='2026-11-02',jobId='12345',merchantId='123',partId='0';
function fixture(t,changes={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jd-recovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const directory=path.join(root,'browser-downloads');fs.mkdirSync(directory);
 const journal=path.join(root,'jd-export-tests',date+'-orders.json');fs.mkdirSync(path.dirname(journal));
 const at=new Date(Date.now()-180000).toISOString(),created=new Date(Date.parse(at)+28800000).toISOString().slice(0,19).replace('T',' ');
 const prior={status:'submission_pending',date,at,jobId,merchantId,downloadRequestedAt:at,...changes};fs.writeFileSync(journal,JSON.stringify(prior));
 const base=merchantId+'_对账单下载_'+date.replaceAll('-','')+'_全部_'+jobId+'_'+partId;
 const book=X.utils.book_new();X.utils.book_append_sheet(book,X.utils.aoa_to_sheet([['京东对账单'],['门店编号','门店名称','订单完成/退款完成时间','应结金额','订单类型'],['100','测试店',date+' 12:00:00',12.34,'正常订单']]),'data');const bytes=X.write(book,{type:'buffer',bookType:'xlsx'});
 let picker=false,reopens=0,downloads=0,partChecks=0;const controls=kind=>({filter(){return this;},locator(){return controls(kind==='modal'?'part':kind);},async count(){return 1;},getByRole(){return this;},async click(){if(kind==='record'){picker=true;reopens++;}if(kind==='part'){downloads++;fs.writeFileSync(path.join(directory,base+'_0.xlsx'),bytes);}}});
 const page={url:()=> 'https://store.jddj.com/v3/financial/statement/newDownload',bringToFront:async()=>{},descriptor:{},getByText:(text,options)=>({text,options}),locator:selector=>controls(selector==='tr'?'record':selector==='.dj-modal'?'modal':'refresh'),getByRole(){throw Error('unexpected_export');},broker:{async call(_d,c){if(c.action==='documentHealth')return {visibility:'visible'};if(c.action==='openJdStatement'){picker=false;return true;}if(c.action==='inspectJdReport'){partChecks++;return {tableRows:[[jobId,base,created,'下载'],...(picker&&partChecks>5?[[base,'下载']]:[])]};}throw Error('unexpected_action_'+c.action);}}};
 return {root,directory,journal,prior,base,bytes,page,get counts(){return {reopens,downloads};}};
}
test('JD settlement resumes a persisted download after page restart and retries the same missing part once',async t=>{
 const f=fixture(t,{partId,partRequestedAt:new Date(Date.now()-180000).toISOString()});
 const result=await runPlatform({root:f.root,platform:'jd_delivery',type:'settlement',date,scope:{bindings:[{platform_id:'100'}]},extension:{attach:()=>({page:f.page})},downloadDirectory:f.directory});
 assert.equal(result.row_count,1);assert.equal(result.receivable_cents,1234);assert.deepEqual(f.counts,{reopens:1,downloads:1});
 const journal=JSON.parse(fs.readFileSync(f.journal));assert.ok(journal.pickerReopenedAt);assert.ok(journal.partRetryAt);assert.equal(journal.partRequestedAt,f.prior.partRequestedAt);assert.equal(journal.at,f.prior.at);
});
test('JD settlement consumes an already downloaded Chrome duplicate name without another download',async t=>{
 const f=fixture(t,{partId,partRequestedAt:new Date(Date.now()-180000).toISOString()});
 fs.writeFileSync(path.join(f.directory,f.base+'_0 (1).xlsx'),f.bytes);
 const result=await runPlatform({root:f.root,platform:'jd_delivery',type:'settlement',date,scope:{bindings:[{platform_id:'100'}]},extension:{attach:()=>({page:f.page})},downloadDirectory:f.directory});
 assert.equal(result.receivable_cents,1234);assert.deepEqual(f.counts,{reopens:1,downloads:0});assert.equal(JSON.parse(fs.readFileSync(f.journal)).partRetryAt,undefined);
});
test('JD settlement first download waits for the part picker to render',async t=>{
 const f=fixture(t,{downloadRequestedAt:undefined});
 const result=await runPlatform({root:f.root,platform:'jd_delivery',type:'settlement',date,scope:{bindings:[{platform_id:'100'}]},extension:{attach:()=>({page:f.page})},downloadDirectory:f.directory});
 assert.equal(result.row_count,1);assert.deepEqual(f.counts,{reopens:1,downloads:1});
 const saved=JSON.parse(fs.readFileSync(f.journal));assert.ok(saved.downloadRequestedAt);assert.ok(saved.partRequestedAt);assert.equal(saved.partRetryAt,undefined);
});
test('JD settlement never reopens a different job or accepts an invalid export timestamp',async t=>{
 const f=fixture(t,{jobId:'999'});
 await assert.rejects(runJdStep(f.page,{step:'download-orders',date,jobId,root:f.root,reopen:true}),/record_mismatch/);
 fs.writeFileSync(f.journal,JSON.stringify({...f.prior,jobId,at:'invalid'}));
 await assert.rejects(runJdStep(f.page,{step:'download-orders',date,jobId,root:f.root,reopen:true}),/record_mismatch/);
 assert.deepEqual(f.counts,{reopens:0,downloads:0});
});
test('JD part retry is bounded, waits two minutes, and cannot change part identity',async t=>{
 const f=fixture(t,{partId,partRequestedAt:new Date().toISOString()});
 await assert.rejects(runJdStep(f.page,{step:'download-part',date,jobId,partId,root:f.root,retry:true}),/already_requested/);
 fs.writeFileSync(f.journal,JSON.stringify({...f.prior,partRequestedAt:f.prior.at,partRetryAt:new Date().toISOString()}));
 await assert.rejects(runJdStep(f.page,{step:'download-part',date,jobId,partId,root:f.root,retry:true}),/already_requested/);
 await assert.rejects(runJdStep(f.page,{step:'download-part',date,jobId,partId:'1',root:f.root,retry:true}),/record_mismatch/);
 assert.equal(f.counts.downloads,0);
});
