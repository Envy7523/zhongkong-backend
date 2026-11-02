'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const C=require('../syncbot/src/meituan-delivery/operating-contract'),{prepareOperatingReport}=require('../syncbot/src/meituan-delivery/operating-download');
function fixture(alwaysReset=false){
 let reads=0,clicks=0;const items=C.fields.slice(1).map((name,i)=>{const input={checked:i<5,disabled:i<5,value:i<5?'':'metric_'+i};return {textContent:name,querySelector:()=>input};});
 function locator(selected=items,selector=''){
  return {selector,filter(o){if(o.hasText)return locator(selected.filter(e=>o.hasText.test(e.textContent)));if(o.has){const key=o.has.selector.match(/value="([^"]+)/)?.[1];return locator(selected.filter(e=>e.querySelector().value===key));}return this;},waitFor:async()=>{},evaluateAll:async fn=>{if(fn.toString().includes('elements.filter')){reads++;if(alwaysReset||reads===1)items[5].querySelector().checked=false;}return fn(selected);},evaluate:async fn=>fn(selected[0]),click:async()=>{clicks++;selected[0].querySelector().checked=!selected[0].querySelector().checked;}};
 }
 const page={locator(s){if(s==='input[type="text"]')return {filter(){return this},evaluateAll:async()=>['2026-11-01','2026-11-01']};return locator(s==='label.roo-checkbox'?items:[],s);},getByRole(){return {filter(){return this},evaluate:async()=>true};},getByText(){return {filter(){return this},evaluate:async()=>true};}};
 return {page,get reads(){return reads},get clicks(){return clicks}};
}
test('report selection survives an asynchronous reset and is read twice before export preparation succeeds',async()=>{
 const f=fixture(),result=await prepareOperatingReport(f.page,{from:'2026-11-01',to:'2026-11-01'});assert.deepEqual(result.fields,C.fields);assert(f.reads>=3);assert(f.clicks>C.metrics.length);
});
test('persistent field resets remain rejected instead of exporting an incomplete report',async()=>{
 const f=fixture(true);await assert.rejects(prepareOperatingReport(f.page,{from:'2026-11-01',to:'2026-11-01'}),e=>e.message==='operating_ui_selection_mismatch'&&e.trace.some(t=>t.startsWith('fields_missing_')));assert.equal(f.reads,6);
});
