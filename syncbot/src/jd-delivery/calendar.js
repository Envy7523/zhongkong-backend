'use strict';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function selectAntDay(frame,{date,prefix,inspect,error}){
 if(!['ant','cook'].includes(prefix)||!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('platform_calendar_parameters_invalid');
 const read=()=>frame.broker.call(frame.descriptor,{action:inspect}),month=date.slice(0,7);
 for(let turn=0;turn<25;turn++){
  const state=await read(),cells=(state.options||state.reportControls||[]).filter(c=>/^\d{4}-\d{2}-\d{2}$/.test(c.title||'')&&String(c.className).includes(prefix+'-picker-cell-in-view'));
  if(cells.some(c=>c.title===date&&!String(c.className).includes(prefix+'-picker-cell-disabled'))){
   const day=frame.locator('.'+prefix+'-picker-dropdown td.'+prefix+'-picker-cell-in-view:not(.'+prefix+'-picker-cell-disabled)[title="'+date+'"]').filter({visible:true});
   if(await day.count()!==1)throw Error(error);await day.click();await day.click();return;
  }
  const months=[...new Set(cells.map(c=>c.title.slice(0,7)))].sort();
  if(!months.length){if(turn>10)throw Error(error);await pause(250);continue;}
  const direction=month<months[0]?'prev':month>months.at(-1)?'next':null;if(!direction)throw Error(error);
  const button=frame.locator('.'+prefix+'-picker-dropdown button.'+prefix+'-picker-header-'+direction+'-btn').filter({visible:true});
  if(await button.count()!==1)throw Error(error);await button.click();
  const before=months.join(','),deadline=Date.now()+10000;let changed=false;
  while(Date.now()<deadline){const next=await read(),after=(next.options||next.reportControls||[]).filter(c=>/^\d{4}-\d{2}-\d{2}$/.test(c.title||'')&&String(c.className).includes(prefix+'-picker-cell-in-view')).map(c=>c.title.slice(0,7));if(after.length&&[...new Set(after)].sort().join(',')!==before){changed=true;break;}await pause(200);}
  if(!changed)throw Error(error);
 }
 throw Error(error);
}
async function selectElDay(page,date){
 const read=()=>page.broker.call(page.descriptor,{action:'inspectJdReport'}),month=date.slice(0,7);
 const current=state=>{const p=state.overlays?.find(e=>e.className.includes('el-date-range-picker')),m=p?.text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);return m?m[1]+'-'+m[2].padStart(2,'0'):null;};
 for(let turn=0;turn<25;turn++){
  const shown=current(await read());if(!shown)throw Error('jd_calendar_month_mismatch');
  if(shown===month){const day=page.locator('.el-date-range-picker__content.is-left td.available:not(.prev-month):not(.next-month):not(.disabled)').filter({visible:true,hasText:new RegExp('^'+Number(date.slice(8))+'$')});if(await day.count()!==1)throw Error('jd_calendar_day_missing');await day.click();await day.click();return;}
  const left=shown>month,scope='.el-date-range-picker__content.'+(left?'is-left':'is-right')+' ',direction=left?'left':'right';
  const button=page.locator(scope+'button.el-icon-arrow-'+direction+', '+scope+'button.arrow-'+direction+', '+scope+'button[aria-label="'+(left?'上个月':'下个月')+'"]' ).filter({visible:true});
  if(await button.count()!==1){const state=await read(),e=Error('jd_calendar_month_mismatch');e.trace=['jd_calendar_month_'+shown.replace('-',''),...(state.calendar||[]).filter(c=>c.tag==='BUTTON').slice(0,8).map(c=>'jd_calendar_button_'+Buffer.from(String(c.className),'utf8').toString('hex').slice(0,100))];throw e;}await button.click();
  const deadline=Date.now()+10000;let changed=false;while(Date.now()<deadline){const next=current(await read());if(next&&next!==shown){changed=true;break;}await pause(200);}if(!changed)throw Error('jd_calendar_month_mismatch');
 }
 throw Error('jd_calendar_month_mismatch');
}
module.exports={selectAntDay,selectElDay};
