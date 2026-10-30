const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const vue=require('../frontend/node_modules/vue');
const source=fs.readFileSync(require.resolve('../frontend/src/views/staff/StaffRoster.vue'),'utf8');
const script=source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm,'');
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};}
function fixture(overrides={}){
 const calls=[],syncCalls=[],messages=[];let mount;
 const week=params=>({week_start:params.week_start,dates:[params.week_start],employees:[{employee_id:1,name:params.scope,days:[]}],sync:{latest:{created_at:'isolated-test'}}});
 const deps={...vue,onMounted:fn=>mount=fn,ElMessage:{error:v=>messages.push(v),success(){}},ArrowLeft:{},ArrowRight:{},StoreRegionSelect:{},getRosterContext:async()=>({today:'2026-10-30',own_only:false,scopes:[{value:'store:1',label:'隔离门店一'},{value:'store:2',label:'隔离门店二'},{value:'office',label:'办公室'}]}),getRosterWeek:async p=>{calls.push({...p});return overrides.query?overrides.query(p):{week:week(p)}},syncRosterWeek:async p=>{syncCalls.push({...p});return overrides.sync?overrides.sync(p):{week:week(p)}},getRosterBalance:async()=>({account:null,revisions:[]})};
 const exposed='context,scope,scopeType,storeId,pickedDate,week,loading,hasResult,queryError,canQuery,contextLoading,load,changeScope,moveWeek,changeWeek,thisWeek,syncWeek';
 const vm=new Function(...Object.keys(deps),script+';return {'+exposed+'}').apply(null,Object.values(deps));
 return {vm,calls,syncCalls,messages,mount:()=>mount(),week};
}
test('进入页面只加载可选条件，不请求周考勤或同步钉钉',async()=>{
 const f=fixture();assert.equal(f.vm.canQuery.value,false);await f.mount();
 assert.equal(f.vm.pickedDate.value,'2026-10-26');assert.equal(f.vm.scope.value,'store:1');assert.equal(f.vm.canQuery.value,true);
 assert.equal(f.calls.length,0);assert.equal(f.syncCalls.length,0);assert.equal(f.vm.hasResult.value,false);assert.deepEqual(f.vm.week.value.employees,[]);
});
test('人员和门店条件改变不请求，查询按钮使用当前条件并清除旧结果',async()=>{
 const f=fixture();await f.mount();f.vm.storeId.value=2;f.vm.changeScope();assert.equal(f.calls.length,0);
 await f.vm.load();assert.deepEqual(f.calls,[{scope:'store:2',week_start:'2026-10-26'}]);assert.equal(f.vm.hasResult.value,true);
 f.vm.scopeType.value='office';f.vm.changeScope();assert.equal(f.calls.length,1);assert.equal(f.vm.hasResult.value,false);assert.equal(f.vm.week.value.employees.length,0);
 await f.vm.load();assert.equal(f.calls.at(-1).scope,'office');
 f.vm.scopeType.value='store';f.vm.storeId.value=null;f.vm.changeScope();await f.vm.load();assert.equal(f.calls.length,2);assert.equal(f.vm.canQuery.value,false);
});
test('上一周、下一周、选择日期和本周均主动自动查询',async()=>{
 const f=fixture();await f.mount();await f.vm.moveWeek(-7);await f.vm.moveWeek(7);f.vm.pickedDate.value='2026-11-06';await f.vm.changeWeek();await f.vm.thisWeek();
 assert.deepEqual(f.calls.map(r=>r.week_start),['2026-10-19','2026-10-26','2026-11-02','2026-10-26']);assert.equal(f.vm.hasResult.value,true);
});
test('条件改变使旧请求失效，旧成功或失败都不能显示为新范围结果',async()=>{
 for(const failure of [false,true]){
  const d=deferred(),f=fixture({query:()=>d.promise});await f.mount();const pending=f.vm.load();
  f.vm.storeId.value=2;f.vm.changeScope();failure?d.reject(Error('旧请求失败')):d.resolve({week:f.week({scope:'store:1',week_start:'2026-10-26'})});await pending;
  assert.equal(f.vm.hasResult.value,false);assert.equal(f.vm.loading.value,false);assert.equal(f.vm.queryError.value,'');assert.equal(f.messages.length,0);
 }
});
test('连续切换周次只展示最新响应，失败时不残留上次员工数据',async()=>{
 const jobs=[],f=fixture({query:p=>{const d=deferred();jobs.push({d,p});return d.promise}});await f.mount();
 const first=f.vm.load(),second=f.vm.moveWeek(7);jobs[1].d.resolve({week:f.week(jobs[1].p)});await second;jobs[0].d.resolve({week:f.week(jobs[0].p)});await first;
 assert.equal(f.vm.week.value.week_start,'2026-11-02');
 const failed=f.vm.load();jobs[2].d.reject(Error('网络异常'));await failed;assert.equal(f.vm.hasResult.value,false);assert.equal(f.vm.week.value.employees.length,0);assert.match(f.vm.queryError.value,/网络异常/);
 const retried=f.vm.load();jobs[3].d.resolve({week:f.week(jobs[3].p)});await retried;assert.equal(f.vm.hasResult.value,true);assert.equal(f.vm.queryError.value,'');
});
test('查询前不执行同步，已发起同步的旧结果不覆盖后来查询',async()=>{
 const d=deferred(),f=fixture({sync:()=>d.promise});await f.mount();await f.vm.syncWeek();assert.equal(f.syncCalls.length,0);
 await f.vm.load();const syncing=f.vm.syncWeek();await f.vm.moveWeek(7);d.resolve({week:f.week({scope:'store:1',week_start:'2026-10-26'})});await syncing;
 assert.equal(f.vm.week.value.week_start,'2026-11-02');assert.equal(f.syncCalls.length,1);
});
