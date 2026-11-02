'use strict';
function yesterday(now=new Date()){
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 return new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10);
}
function assertDate(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw Error('invalid_business_date');return value;}
async function setRange(frame,from,to,options={}){
 assertDate(from);assertDate(to);if(from>to||to>yesterday())throw Error('invalid_finance_range');
 const placeholder=options.placeholder||'开始时间 - 结束时间',separator=options.separator||' - ';
 await frame.getByPlaceholder(placeholder).click();
 const popup=frame.locator('.mtd-singleRangePicker-pop:visible');await popup.waitFor();
 async function choose(date){
  const month=Number(date.slice(0,4))*12+Number(date.slice(5,7));
  for(let step=0;step<12;step++){
   const calendars=popup.locator('.mtd-date-calendar:visible');
   for(const calendar of await calendars.all()){
    const header=calendar.locator('.mtd-date-calendar-content.active:visible .mtd-date-calendar-date-header');
    const year=Number((await header.locator('.mtd-date-calendar-year-btn').innerText()).replace('年','')),m=Number((await header.locator('.mtd-date-calendar-month-btn').innerText()).replace('月',''));
    if(step<3)console.log(JSON.stringify({calendarYear:year,calendarMonth:m,target:date}));
    if(year*12+m===month){await calendar.locator('.mtd-date-calendar-content.active:visible .mtd-date-panel-data-wrapper:not(.not-current-month):not(.disabled-date) .mtd-date-panel-data').filter({hasText:new RegExp('^'+String(Number(date.slice(8)))+'$')}).click();return;}
   }
   const calendar=calendars.first(),header=calendar.locator('.mtd-date-calendar-content.active:visible .mtd-date-calendar-date-header');
   const currentYear=Number((await header.locator('.mtd-date-calendar-year-btn').innerText()).replace('年',''));
   if(currentYear!==Number(date.slice(0,4))){await header.locator('.mtd-date-calendar-year-btn').click();await calendar.locator('.mtd-date-calendar-content.active:visible .mtd-year-panel-list:not(.disabled-year) .mtd-year-panel-list-data').filter({hasText:new RegExp('^'+date.slice(0,4)+'$')}).click();}
   await calendar.locator('.mtd-date-calendar-content.active:visible .mtd-date-calendar-month-btn').click();
   await calendar.locator('.mtd-date-calendar-content.active:visible .mtd-month-panel-list:not(.disabled-month) .mtd-month-panel-list-data').filter({hasText:new RegExp('^'+Number(date.slice(5,7))+'月$')}).click();
   await frame.page().waitForTimeout(300);
  }throw Error('calendar_navigation_limit');
 }
 await choose(from);await choose(to);await popup.waitFor({state:'hidden'});
 const range=await frame.getByPlaceholder(placeholder).inputValue();
 if(range!==`${from.replaceAll('-','/')}${separator}${to.replaceAll('-','/')}`)throw Error('finance_date_assertion_failed');
}
module.exports={yesterday,assertDate,setRange};
