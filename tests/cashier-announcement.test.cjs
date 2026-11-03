const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readOverlays}=require('../syncbot/src/phase2/dom-probe');
const {navigateAndQueryReportA}=require('../syncbot/src/phase2/report-a-query-flow');
test('long announcement preserves its nested footer button before bounded body labels',()=>{
 const rect={x:0,y:0,width:800,height:600};
 const element=(tag,text,children=[])=>({tagName:tag,innerText:text,textContent:text,children,className:'fixture',getBoundingClientRect:()=>rect,getAttribute:()=>null});
 const body=Array.from({length:65},(_,i)=>element('SPAN','公告项目'+i));
 const close=element('BUTTON','知道了',[element('SPAN','知道了')]);
 const overlay=element('DIV','更新公告');overlay.querySelectorAll=s=>s==='button,[role="button"],a'?[close]:body;
 const prior={window:global.window,document:global.document,getComputedStyle:global.getComputedStyle,location:global.location};
 try{global.window={innerWidth:1000,innerHeight:800,__probeHelpers:{cssPathOf:e=>e===close?'#footer-close':'#body'}};global.document={querySelectorAll:()=>[overlay]};global.location={href:'https://example.test/'};global.getComputedStyle=()=>({display:'block',visibility:'visible',opacity:'1',position:'fixed',zIndex:'10'});
 const result=readOverlays();assert.equal(result.overlays[0].controls.length,30);assert.equal(result.overlays[0].controls[0].text,'知道了');assert.equal(result.overlays[0].controls[0].selector,'#footer-close');
 }finally{Object.assign(global,prior);}
});
test('unhandled announcement prevents all navigation and query operations',async()=>{
 let clicks=0;const r=await navigateAndQueryReportA({rules:{navigation:{home_url:'https://example.test/'}},ctx:{},flow:{gotoAndAssert:async()=>({ok:true}),dismissOverlays:async()=>({ok:false}),clickSelectorAndVerify:async()=>{clicks++;}}});
 assert.equal(r.ok,false);assert.match(r.reason,/公告未清除/);assert.equal(clicks,0);
});
