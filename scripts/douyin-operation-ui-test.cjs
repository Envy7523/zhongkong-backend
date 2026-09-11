// Isolated UI test: all /api requests are intercepted; no credentials or DB access.
// Requires dedicated headless Chrome on port 9335 and Vite on port 5173.
const assert = require('node:assert/strict');
async function main() {
  const pages=await fetch('http://127.0.0.1:9335/json/list').then(r=>r.json());
  const ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0; const pending=new Map(),errors=[];
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const totals={gross_amount:1000,income_amount:900,actual_amount:800,order_count:20,visit_users:100,ordering_users:25,order_rate:0.25,store_rating:4.3,meituan_rating:4.1,dianping_rating:4.2,impression_users:400,visit_rate:0.25,review_count:12};
  ws.addEventListener('message',async e=>{
    const m=JSON.parse(e.data);
    if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(m.error):p?.resolve(m.result);}
    if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description);
    if(m.method==='Fetch.requestPaused') {
      const {requestId,request}=m.params,url=new URL(request.url); let body={};
      if(url.pathname==='/api/auth/me')body={user:{username:'ui-fixture',role:'管理员',display_name:'界面测试'}};
      else if(url.pathname.includes('meituan-operation'))body=url.searchParams.get('date_from')?.startsWith('2027')?{totals:{},stores:[],trend:[],days:0,stores_count:0}:{totals,stores:[{store_id:9,store_name:'测试门店',...totals}],trend:[{date:'2026-08-01',...totals},{date:'2026-08-02',...totals,store_rating:4.4,review_count:13}],days:2,stores_count:1};
      else if(url.pathname.includes('/views/'))body={totals:{},trend:[],stores:[],reconciliation:[],revenue_composition:[],channel_breakdown:[],fee_detail_breakdown:[]};
      else if(url.pathname.includes('stores'))body={stores:[],total:0};
      else if(url.pathname.includes('products'))body={products:[],totals:{}};
      await cdp('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(body)).toString('base64')});
    }
  });
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description);return r.result.value;};
  try {
    await cdp('Runtime.enable');await cdp('Page.enable');await cdp('Emulation.setDeviceMetricsOverride',{width:1664,height:1100,deviceScaleFactor:1,mobile:false});
    await cdp('Fetch.enable',{patterns:[{urlPattern:'*://127.0.0.1:5173/api/*'}]});
    await cdp('Page.addScriptToEvaluateOnNewDocument',{source:"localStorage.setItem('etaigong_token','ui-fixture-not-a-real-token')"});
    await cdp('Page.navigate',{url:'http://127.0.0.1:5173/analysis/group-buy/platform'});
    for(let i=0;i<40;i++){if(await evaluate("!!document.querySelector('.business-analytics-page')"))break;await pause(200);}
    const change=async values=>{await evaluate(`Object.assign(document.querySelector('.business-analytics-page').__vueParentComponent.setupState.filters,${JSON.stringify(values)})`);await pause(100);await evaluate("document.querySelector('.query-button').click()");await pause(80);assert.ok(await evaluate("!!document.querySelector('.group-query-overlay')"));await pause(1150);};
    const chartState=()=>evaluate(`(async()=>{const el=document.querySelector('.mt-chart');const chart=document.querySelector('.business-analytics-page').__vueParentComponent.setupState.mtTrendChart;const option=chart?.getOption();return {connected:!!chart&&chart.getDom().isConnected,height:el?.getBoundingClientRect().height,formula:document.querySelector('.delivery-settlement-chain')?.getBoundingClientRect().height,series:option?.series.map(s=>({id:s.id,type:s.type,data:s.data})),grid:option?.yAxis[0].splitLine.lineStyle.type}})()`)
    await change({timeMode:'month',month:'2026-08',platform:'美团团购'});
    let firstHeight;
    for(const platform of ['美团团购','抖音团购','美团团购','抖音团购','美团团购']) {
      await evaluate(`[...document.querySelectorAll(".delivery-platform-switch .el-radio-button")].find(el=>el.textContent.trim()===${JSON.stringify(platform)}).click()`);await pause(800);const state=await chartState();
      assert.equal(state.connected,true); assert.equal(state.height,340); assert.ok(state.series.length>=3); assert.equal(state.grid,'dashed');
      if(firstHeight==null) firstHeight=state.formula; else assert.equal(state.formula,firstHeight);
      if(platform==='抖音团购') {
        const table=await evaluate("document.querySelector('.meituan-op-table').innerText");
        assert.ok(table.includes('1,000.00')); assert.ok(table.includes('800.00'));
        assert.equal(await evaluate("document.querySelectorAll('.settlement-hover').length"),2);
        assert.ok(!table.includes('曝光人数')); assert.ok(!table.includes('美团星级'));
      }
    }
    console.log('PASS Meituan/Douyin five switches: live series, equal chart/formula height, consistent grid and monetary fields');
    await change({platform:'抖音团购'});
    await evaluate("[...document.querySelectorAll('.mt-trend-toolbar button')].find(x=>x.textContent==='评分评价').click()"); await pause(200);
    await evaluate("document.querySelector('.delivery-settlement-chain').scrollIntoView()");await pause(700);
    const shot=await cdp('Page.captureScreenshot',{format:'png'});require('node:fs').writeFileSync('data/group-operation-ui.png',Buffer.from(shot.data,'base64'));
    const rating=await chartState();assert.equal(rating.series.find(s=>s.id==='store_rating').type,'line');assert.equal(rating.series.find(s=>s.id==='review_count').type,'bar');
    await evaluate("[...document.querySelectorAll('.mt-group-field-picker button')].find(x=>x.textContent==='门店评分').click()");await pause(200);assert.equal((await chartState()).series.length,1);
    await change({month:'2027-01'});assert.ok((await evaluate("document.querySelector('.mt-trend-panel').innerText")).includes('暂无'));
    await change({month:'2026-08',platform:'美团团购'});assert.equal((await chartState()).connected,true);
    console.log('PASS rating types, field toggle and empty-to-populated remount');
    await cdp('Page.navigate',{url:'http://127.0.0.1:5173/data-import/group-buy'});await pause(1000);
    await evaluate("[...document.querySelectorAll('button')].find(x=>x.textContent.includes('抖音团购')).click()");await pause(200);
    await evaluate("[...document.querySelectorAll('.report-type-card')].find(x=>x.textContent.includes('门店经营数据')).click()");await pause(200);
    const text=await evaluate('document.body.innerText');assert.ok(text.includes('下单转化率'));assert.ok(text.includes('访问人数 / 购买人数'));
    assert.deepEqual(errors,[]);console.log('PASS mocked UI: import screen and zero runtime exceptions');
  } finally { await evaluate("localStorage.removeItem('etaigong_token')");ws.close(); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
