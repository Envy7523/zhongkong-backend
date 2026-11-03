'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {RemoteLocator}=require('../syncbot/windows-client/extension-broker.cjs');
const contract=require('../syncbot/src/meituan-delivery/product-contract');
const {prepareProductReport}=require('../syncbot/src/meituan-delivery/product-download');
function fixture({switchGrain=true,hiddenCopy=true}={}){
 const extension={ETG_READS:require('../syncbot/windows-client/chrome-extension/reads.js')};
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../syncbot/windows-client/chrome-extension/dom.js'),'utf8'),{globalThis:extension,setTimeout,URL});
 let productClicks=0,hiddenClicks=0,grainReads=0,scopeClicks=0,editorVisible=true,confirmVisible=true;
 const doc={location:{origin:'https://waimaieapp.meituan.com',href:'https://waimaieapp.meituan.com/bizdata_pc/report/download'},visibilityState:'visible',body:{dispatchEvent(){}},defaultView:{MouseEvent:class{},getComputedStyle:el=>({visibility:'visible',display:el.hidden?'none':'block'})}};
 function element(text,hidden,onClick){const classList=new Set();classList.contains=name=>classList.has(name);return {tagName:'SPAN',textContent:text,children:[],hidden,classList,ownerDocument:doc,parentElement:doc.body,querySelectorAll:()=>[],getAttribute:()=>null,matches:()=>false,getClientRects:()=>hidden?[]:[{}],getBoundingClientRect:()=>({x:0,y:0,width:100,height:30}),scrollIntoView(){},dispatchEvent(){},click:onClick};}
 const tab=element('商品',false,()=>productClicks++),hiddenTab=element('商品',true,()=>hiddenClicks++),daily=element('按天',false,()=>{if(switchGrain)daily.classList.add('active_daily');});
 const tabs=hiddenCopy?[hiddenTab,tab]:[tab];
 doc.querySelectorAll=css=>css==='span.tab-text'?tabs:css==='*'?[...tabs,daily]:[];
 const frame={descriptor:{frameId:1},broker:{diagnostics:[],async call(_d,c){
  const isTab=c.steps?.some(s=>s.kind==='css'&&s.value==='span.tab-text'),isDaily=c.steps?.some(s=>s.kind==='text'&&s.match.text==='按天');
  if(isTab||isDaily){if(isDaily&&c.action==='read')grainReads++;const value=await extension.ETG_DOM.execute(doc,c);if(isTab&&c.action==='count')assert.equal(value,1,'The real DOM query still includes a hidden duplicate product tab');return value;}
  const role=c.steps?.find(s=>s.kind==='role')?.match.text,textarea=c.steps?.some(s=>s.kind==='css'&&s.value==='textarea');
  if(c.action==='count')return textarea?Number(editorVisible):role==='确认'?Number(confirmVisible):1;
  if(c.action==='visible')return true;
  if(c.action==='click'){if(role==='自定义门店')scopeClicks++;return true;}
  if(c.action==='fill'){assert.equal(c.value,'100');return true;}
  if(c.action==='press'){if(role==='一键导入')editorVisible=false;if(role==='确认')confirmVisible=false;return true;}
  if(c.action==='checked')return true;
  if(c.action==='read'){assert(['primary','primaryElement'].includes(c.reader));return true;}
  if(c.action==='readAll'){
   if(c.reader==='productInventory')return contract.metrics.map((name,i)=>({name,value:String(i+1),disabled:false}));
   if(c.reader==='productActual')return [...contract.metrics];
   if(c.reader==='productSelected')return [...contract.identityFields.slice(1),...contract.metrics];
  }
  throw Error('unexpected_extension_command_'+c.action+'_'+c.reader);
 }}};
 const page={locator:css=>new RemoteLocator(frame).locator(css),getByText:(...args)=>new RemoteLocator(frame).getByText(...args),getByRole:(...args)=>new RemoteLocator(frame).getByRole(...args)};
 return {page,get counts(){return {productClicks,hiddenClicks,grainReads,scopeClicks};}};
}
test('product selection uses real RemoteLocator and extension DOM filtering to exclude the hidden duplicate tab',async()=>{
 const f=fixture(),result=await prepareProductReport(f.page,{storeIds:['100']});
 assert.deepEqual(result.fields,contract.fields);assert.equal(result.grain,'day');
 assert.deepEqual(f.counts,{productClicks:1,hiddenClicks:0,grainReads:2,scopeClicks:1});
});
test('product selection refuses to claim daily grain when the platform ignores the click',async()=>{
 const f=fixture({switchGrain:false,hiddenCopy:false});
 await assert.rejects(prepareProductReport(f.page,{storeIds:['100']}),/product_ui_grain_mismatch/);
 assert.deepEqual(f.counts,{productClicks:1,hiddenClicks:0,grainReads:2,scopeClicks:0});
});
