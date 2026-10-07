const {test}=require('node:test'),assert=require('node:assert/strict');
const {settle,expiry,units,dateAdd}=require('../lib/roster-balance');
const settings={"2026-08":{scheduled_days:0,published_at:'yes'},"2026-09":{scheduled_days:30,published_at:'yes'},"2026-10":{scheduled_days:25,published_at:'yes'},"2026-12":{scheduled_days:0,published_at:'yes'}};
const work=(date,hours=8,extra={})=>({date,plan:{type:'work'},records:[{check_time:date+' 08:00:00',check_type:'OnDuty'},{check_time:date+` ${String(8+hours).padStart(2,'0')}:00:00`,check_type:'OffDuty'}],...extra});
const rest=date=>({date,plan:{type:'rest'},records:[]});
const run=(days,today='2026-10-07',extra={})=>settle({days,settings,today,activeFrom:'2026-08-01',...extra});
test('三个月按自然月独立到期，月末截断和年底硬清零',()=>{
 assert.equal(expiry('2026-08-01'),'2026-11-01');assert.equal(expiry('2026-08-31'),'2026-11-30');assert.equal(expiry('2026-11-01'),'2027-01-01');assert.equal(expiry('2026-01-31'),'2026-04-30');
});
test('正式员工请假边界与原始工时分开保留',()=>{
 assert.deepEqual([0,1.99,2,4,5.99,6,8].map(units),[0,0,0.5,0.5,0.5,1,1]);
 const result=run([work('2026-10-01',3,{exception:{decision:'leave',reason:'就医'}}),work('2026-10-02',7,{exception:{decision:'leave',reason:'就医'}})]);
 assert.equal(result.days[0].work_days,0.5);assert.equal(result.days[0].leave_days,0.5);assert.equal(result.days[1].paid_days,1);assert.equal(result.days[1].hours,7);assert.match(result.days[1].note,/不扣/);
});
test('门店原排休日期上班不算加班，集团排休日出勤存假',()=>{
 const store=run([work('2026-10-01',8,{plan:{type:'rest'}})]);assert.equal(store.balance,0);assert.equal(store.days[0].status,'work');
 const office=run([work('2026-10-01',8,{office:true,plan:{type:'rest'}})]);assert.equal(office.balance,1);assert.equal(office.days[0].status,'overtime');assert.equal(office.days[0].paid_days,0);
});
test('超过月出勤额度按实际超额半天存假，未超额不存',()=>{
 const days=Array.from({length:26},(_,i)=>work(`2026-10-${String(i+1).padStart(2,'0')}`,i===25?3:8,i===25?{exception:{decision:'leave',reason:'就医'}}:{}));
 const result=run(days,'2026-10-28');assert.equal(result.balance,0.5);assert.equal(result.lots[0].date,'2026-10-26');assert.equal(result.months[0].paid_days,25);assert.equal(result.days[25].leave_days,0.5);
});
test('先用本月正常休息额度，再扣最早到期批次，不透支库存',()=>{
 const days=[work('2026-08-01'),work('2026-08-02'),...Array.from({length:8},(_,i)=>rest(`2026-10-${String(i+1).padStart(2,'0')}`))];
 const result=run(days,'2026-10-10');assert.equal(result.balance,0);assert.equal(result.events.filter(e=>e.type==='use').length,2);assert.equal(result.events.find(e=>e.type==='use').source_date,'2026-08-01');assert.equal(result.days.find(d=>d.date==='2026-10-07').paid_days,1);
 const insufficient=run([...days,rest('2026-10-09')],'2026-10-10');assert.equal(insufficient.days.at(-1).status,'pending');assert.equal(insufficient.balance,0);
});
test('到期当天先清除，不能再用；年底余额归零且保留流水',()=>{
 const result=run([work('2026-08-01'),rest('2026-11-01')],'2026-11-02');assert.equal(result.balance,0);assert.equal(result.events[1].date,'2026-11-01');assert.equal(result.events[1].type,'expire');
 const year=run([work('2026-12-30')],'2027-01-01');assert.equal(year.balance,0);assert.equal(year.events.at(-1).type,'year_clear');
});
test('未批准短时出勤、缺卡、无记录保持待核，不自动认定旷工',()=>{
 const result=run([work('2026-10-01',3),{date:'2026-10-02',plan:{type:'work'},records:[{check_time:'2026-10-02 08:00:00',check_type:'OnDuty'}]}, {date:'2026-10-03',plan:{type:'work'}}]);
 assert.ok(result.days.every(day=>day.status==='pending'));assert.equal(result.months[0].absent_days,0);
});
test('休息超额须请假或旷工确认，申请未批准不计请假',()=>{
 const days=[...Array.from({length:6},(_,i)=>rest(`2026-10-${String(i+1).padStart(2,'0')}`)),{...rest('2026-10-07'),exception:{decision:'leave',reason:'事假'}},{...rest('2026-10-08'),exception:{decision:'absent',reason:'核实未到岗'}}];
 const result=run(days,'2026-10-10');assert.equal(result.months[0].leave_days,1);assert.equal(result.months[0].absent_days,1);assert.equal(result.balance,0);
});
test('兼职实际工时不按正式员工半天规则，也不重复存假',()=>{
 const result=run([work('2026-08-01',3)],'2026-10-07',{partTime:true});assert.equal(result.balance,0);assert.equal(result.days[0].work_days,3/8);assert.equal(result.months[0].hours,3);
});
test('今日和未来排班不提前入账，重复重放不重复计假，补卡修订可撤回旧信用',()=>{
 const days=[work('2026-08-01'),work('2026-10-07')];assert.deepEqual(run(days),run(days));assert.equal(run(days).balance,1);assert.equal(run(days).days[1].status,'planned');
 assert.equal(run([{date:'2026-08-01',records:[],plan:{type:'work'}}]).balance,0);assert.equal(dateAdd('2026-12-31',1),'2027-01-01');
});
