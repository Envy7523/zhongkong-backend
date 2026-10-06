const test = require('node:test');
const assert = require('node:assert/strict');
const { revealDate } = require('../syncbot/src/phase2/date-range');
function calendar(month) {
 const state={month,clicks:0};
 const client={
  async picker(){return {best:{cells:[{date:`2026-${String(state.month).padStart(2,'0')}-01`,selector:'div.saas-picker-date-panel > div.saas-picker-body > td'}]}};},
  async region(){return {children:[{attrs:{class:'saas-picker-header'},children:[{tag:'button',attrs:{class:'saas-picker-header-prev-btn'}},{tag:'button',attrs:{class:'saas-picker-header-next-btn'}},{attrs:{class:'saas-picker-header-view'},children:[{text:'2026年'},{text:`${state.month}月`}]}]}]};},
  async inspect(selector){state.direction=selector.includes('prev-btn')?-1:1;return {visible:true,enabled:true,rect:{x:1,y:1,w:10,h:10}};},
  async mouse(){state.month+=state.direction;state.clicks++;}
 };return {client,state};
}
test('跨月复核在同一日期面板切到上月',async()=>{const c=calendar(10);assert.equal((await revealDate(c.client,'2026-09-01')).ok,true);assert.equal(c.state.clicks,1);});
test('能够从历史月份回到目标月份',async()=>{const c=calendar(8);assert.equal((await revealDate(c.client,'2026-10-01')).ok,true);assert.equal(c.state.clicks,2);});
test('本月不可选择日期必须失败，不切换到别的日期',async()=>{const c=calendar(10);assert.equal((await revealDate(c.client,'2026-10-31')).ok,false);assert.equal(c.state.clicks,0);});
test('选定开始日后自动跳月，仍不重开输入框且正确完成同日区间',async()=>{
 const c=calendar(10);let open=false,inputClicks=0,dateClicks=0;let values=['2026/10/01','2026/10/06'];
 const picker=c.client.picker;c.client.picker=async()=>open?picker():{best:null};
 const mouse=c.client.mouse;c.client.mouse=async({y})=>{if(y===105){open=true;inputClicks++;}else if(y===55){dateClicks++;values[dateClicks===1?0:1]='2026/09/01';if(dateClicks===1)c.state.month=10;}else await mouse();};
 const originalPicker=c.client.picker;c.client.picker=async()=>{const p=await originalPicker();if(p.best){p.best.distinct_dates=1;p.best.cells[0].rect={x:1,y:50,w:10,h:10};}return p;};
 c.client.press=async()=>{open=false;};
 const result=await require('../syncbot/src/phase2/date-range').setDateRangeExact({client:c.client,readDates:async()=>({values,inputs:[{placeholder:'开始日期',rect:{x:1,y:100,w:10,h:10}}]}),targetInput:'2026/09/01',iso:'2026-09-01',startSelector:'#start'});
 assert.equal(result.ok,true);assert.equal(inputClicks,1);assert.equal(dateClicks,2);assert.equal(c.state.clicks,2);
});

