'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{selectAntDay,selectElDay}=require('../syncbot/src/jd-delivery/calendar');
for(const prefix of ['ant','cook'])test(prefix+' range calendar moves from November to October before selecting the exact business date',async()=>{
 let month='11',days=0,moves=0;const frame={descriptor:{},broker:{call:async()=>({options:[{title:'2026-'+month+'-31',className:prefix+'-picker-cell-in-view'}]})},locator(css){return {filter(){return this},count:async()=>1,click:async()=>{if(css.includes('header-prev-btn')){month='10';moves++;}else{assert(css.includes('2026-10-31'));assert.equal(month,'10');days++;}}};}};
 await selectAntDay(frame,{date:'2026-10-31',prefix,inspect:'inspectFlashReport',error:'missing'});assert.equal(moves,1);assert.equal(days,2);
});
test('disabled days and duplicate visible dates never click an arbitrary calendar cell',async()=>{
 let clicks=0,disabled=true;const frame={descriptor:{},broker:{call:async()=>({reportControls:[{title:'2026-10-31',className:'ant-picker-cell-in-view'+(disabled?' ant-picker-cell-disabled':'')}]})},locator(){return {filter(){return this},count:async()=>2,click:async()=>clicks++};}};
 for(const state of [true,false]){disabled=state;await assert.rejects(selectAntDay(frame,{date:'2026-10-31',prefix:'ant',inspect:'inspectJdReport',error:'missing'}),/missing/);}assert.equal(clicks,0);
});
test('JD bill calendar handles previous month, header shortcut text, and selects only the left current-month cell',async()=>{
 let month=11,moves=0,days=0;const page={descriptor:{},broker:{call:async()=>({overlays:[{className:'el-date-range-picker',text:'最近一月 2026 年 '+month+' 月 2026 年 '+(month+1)+' 月'}]})},locator(css){return {filter(){return this},count:async()=>1,click:async()=>{if(css.includes('el-icon-arrow-left')){month--;moves++;}else{assert(css.includes('is-left'));assert(css.includes(':not(.prev-month)'));assert.equal(month,10);days++;}}};}};
 await selectElDay(page,'2026-10-31');assert.equal(moves,1);assert.equal(days,2);
});
