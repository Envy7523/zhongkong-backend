'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {publicError}=require('./core.cjs');
function equal(a,b){const left=Buffer.from(String(a||'')),right=Buffer.from(String(b||''));return left.length===right.length&&crypto.timingSafeEqual(left,right);}
async function body(req,limit=32768){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw Error('client_request_too_large');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw Error('client_request_invalid');}}
async function createServer(collector,{port=0,token=crypto.randomBytes(32).toString('hex'),onQuit=()=>{}}={}){
  let origin;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    if(req.headers.host!==new URL(origin).host)return json(403,{error:'client_host_denied'});
    if(req.headers.origin&&req.headers.origin!==origin)return json(403,{error:'client_origin_denied'});
    if(req.headers['sec-fetch-site']==='cross-site')return json(403,{error:'client_origin_denied'});
    const route=new URL(req.url,origin).pathname;
    if(req.method==='GET'&&['/','/ui.js','/ui.css'].includes(route)){
      const name=route==='/'?'ui.html':route.slice(1),type=route==='/'?'text/html':route.endsWith('.js')?'text/javascript':'text/css';res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});return res.end(fs.readFileSync(path.join(__dirname,name)));
    }
    if(!route.startsWith('/api/'))return json(404,{error:'not_found'});
    if(!equal(req.headers['x-client-token'],token))return json(401,{error:'client_token_required'});
    try{
      if(req.method==='GET'&&route==='/api/update-health'){const version=JSON.parse(fs.readFileSync(path.join(__dirname,'version.json'))).version,ext=JSON.parse(fs.readFileSync(path.join(__dirname,'chrome-extension/manifest.json'))).version,bridge=collector.extension.status();return json(200,{ok:(!collector.updateProbe||collector.updateReady)&&bridge.bridgeConnected&&bridge.extensionVersion===ext,version});}
      if(req.method==='GET'&&route==='/api/status')return json(200,collector.state());
      if(req.method==='GET'&&route==='/api/extension/status')return json(200,collector.extension.status());
      if(req.method!=='POST')return json(405,{error:'method_not_allowed'});
      if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return json(415,{error:'json_required'});
      // Report snapshots grow with the platform download history. Native messaging
      // already caps these replies at 1 MiB; the 32 KiB settings limit truncated
      // valid authenticated replies and left their commands waiting until timeout.
      const input=await body(req,route==='/api/extension/result'?1024*1024:32768);
      if(route==='/api/extension/platform-download'){
        if(collector.busy||collector.updating)throw Error('client_busy');
        if(!['jd_delivery','taobao_flash'].includes(input.platform)||!['operating','product','settlement'].includes(input.type))throw Error('client_platform_invalid');
        const config=require('./core.cjs').normalizeConfig({account:input.account,storeIds:input.storeIds,browserMode:'extension'});require('./core.cjs').configured(config);require('./core.cjs').validBusinessDate(input.date);
        const job={id:crypto.randomUUID(),platform:input.platform,reportType:input.type,date:input.date,source:'download-test',status:'running',startedAt:new Date().toISOString(),message:'仅测试自动下载；不会上传云端。'};
        collector.busy=true;collector.history.push(job);collector.saveHistory();
        collector.completion=require('./platform-runner.cjs').runPlatform({root:collector.root,platform:input.platform,type:input.type,date:input.date,scope:{account:config.account,bindings:config.storeIds.map(platform_id=>({platform_id}))},extension:collector.extension,onProgress:u=>{collector.phase=u.phase;}}).then(result=>Object.assign(job,{status:'downloaded',result,message:'自动下载及原件结构校验完成，未上传云端。'})).catch(error=>Object.assign(job,{status:'failed',...publicError(error)})).finally(()=>{job.finishedAt=new Date().toISOString();collector.busy=false;collector.phase='idle';collector.saveHistory();});
        return json(202,{ok:true,job:{id:job.id,status:job.status}});
      }
      if(route==='/api/extension/jd/step'){

        if(collector.busy)throw Error('client_busy');const page=collector.extension.attach({platform:'jd_delivery'}).page;
        if(input.area==='report'){
          await page.bringToFront();const frames=page.frames().filter(frame=>new URL(frame.url()).origin==='https://kunce-store.jddj.com');
          if(frames.length!==1)throw Error('jd_report_frame_missing');
          return json(200,{ok:true,result:await require('../src/jd-delivery/report-probe').runJdReportStep(frames[0],input)});
        }
        return json(200,{ok:true,result:await require('../src/jd-delivery/browser-probe').runJdStep(page,input)});
      }
      if(route==='/api/extension/jd/open'){
        if(collector.busy)throw Error('client_busy');let connection;
        try{connection=collector.extension.attach({platform:'jd_delivery'});}catch(error){if(error.message!=='client_existing_platform_tab_missing')throw error;connection=collector.extension.attach({platform:'taobao_flash'});}
        const page=connection.page;await page.bringToFront();
        await collector.extension.call(page.descriptor,{action:'refreshControls'});
        return json(200,{ok:true,result:await collector.extension.call(page.descriptor,{action:'openJdStatement'})});
      }
      if(route==='/api/extension/jd/inspect'){
        if(collector.busy)throw Error('client_busy');
        const page=collector.extension.attach({platform:'jd_delivery'}).page;
        if(input.front===true)await page.bringToFront();
        const reportFrames=input.report===true?page.frames().filter(frame=>new URL(frame.url()).origin==='https://kunce-store.jddj.com'):[];
        if(input.report===true&&reportFrames.length!==1)throw Error('jd_report_frame_missing');
        const target=input.report===true?reportFrames[0]:page;
        if(input.refresh===true)await collector.extension.call(target.descriptor,{action:'refreshControls'});
        if(input.structured===true)return json(200,{ok:true,result:await collector.extension.call(target.descriptor,{action:'inspectJdReport'})});
        const visible=locator=>locator.filter({visible:true});
        const headings=await visible(page.locator('h1,h2,h3')).allTextContents();
        const controls=await visible(page.locator('button,a,[role="menuitem"]')).allTextContents();
        const labels=await visible(page.locator('label')).allTextContents();
        const headers=await visible(page.locator('thead th')).allTextContents();
        return json(200,{ok:true,headings:headings.slice(0,20),controls:controls.map(t=>t.trim().slice(0,200)).filter(Boolean).slice(0,120),labels:labels.slice(0,50),headers:headers.slice(0,40),loginRequired:new URL(page.url()).pathname.includes('/login')||await page.locator('input[type="password"]').isVisible(),frames:page.frames().map(f=>{const u=new URL(f.url());return {origin:u.origin,path:u.pathname};})});
      }
      if(route==='/api/extension/flash/step'){
        if(collector.busy)throw Error('client_busy');
        const page=collector.extension.attach({platform:'taobao_flash'}).page;await page.bringToFront();
        if(input.area==='finance'){
          const frames=page.frames().filter(frame=>new URL(frame.url()).origin==='https://napos-bill-pc.faas.ele.me'&&new URL(frame.url()).pathname==='/napos-bill-pc/v2/bill-download');
          if(frames.length!==1)throw Error('flash_finance_frame_missing');
          return json(200,{ok:true,result:await require('../src/taobao-flash/frame-probe').runFlashFrameStep(frames[0],input)});
        }
        if(input.area==='report'){
          const candidates=[],frames=page.frames().filter(f=>new URL(f.url()).origin==='https://melody-stats-next.ele.me');
          if(frames.length===1)candidates.push(frames[0]);
          const inspected=frames.length===1?[]:await Promise.allSettled(frames.map(async frame=>({frame,state:await collector.extension.call(frame.descriptor,{action:'inspectFlashReport'})})));
          if(inspected.some(item=>item.status==='rejected'))throw Error('flash_report_frame_unresponsive');
          for(const item of inspected)if(item.status==='fulfilled'&&item.value.state.controls.some(c=>c.text==='报表下载'||c.text==='下载管理'))candidates.push(item.value.frame);
          if(candidates.length!==1)throw Error('flash_report_frame_missing');
          return json(200,{ok:true,result:await require('../src/taobao-flash/report-probe').runFlashReportStep(candidates[0],input)});
        }
        return json(200,{ok:true,result:await require('../src/taobao-flash/browser-probe').runFlashStep(page,input)});
      }
      if(route==='/api/extension/flash/inspect'){
        if(collector.busy)throw Error('client_busy');
        const page=collector.extension.attach({platform:'taobao_flash'}).page;
        if(input.front===true)await page.bringToFront();
        if(input.structured===true){const inspected=await Promise.allSettled(page.frames().map(async frame=>{
          if(input.refresh===true)await collector.extension.call(frame.descriptor,{action:'refreshControls'});
          return {frameId:frame.descriptor.frameId,origin:new URL(frame.url()).origin,...await collector.extension.call(frame.descriptor,{action:'inspectFlashReport'})};
        }));return json(200,{ok:true,result:inspected.filter(r=>r.status==='fulfilled').map(r=>r.value),errors:inspected.filter(r=>r.status==='rejected').map(r=>r.reason.message)});}
        const visible=locator=>locator.filter({visible:true});
        const headings=await visible(page.locator('h1,h2,h3')).allTextContents();
        const controls=await visible(page.locator('button,a,[role="menuitem"]')).allTextContents();
        const labels=await visible(page.locator('label')).allTextContents();
        return json(200,{ok:true,headings:headings.slice(0,20),controls:controls.map(t=>t.trim().slice(0,200)).filter(Boolean).slice(0,100),labels:labels.slice(0,30),loginRequired:new URL(page.url()).pathname.startsWith('/login')||await page.locator('input[type="password"]').isVisible(),frames:page.frames().map(f=>{const u=new URL(f.url());return {origin:u.origin,path:u.pathname};})});
      }
      if(route==='/api/extension/navigation-structure'||route==='/api/extension/refresh-controls'){
        if(collector.busy)throw Error('client_busy');
        const page=collector.extension.attach().page;
        if(route.endsWith('refresh-controls')){for(const frame of page.frames().filter(f=>!f.url().includes('/new_fe/')))await collector.extension.call(frame.descriptor,{action:'refreshControls'});return json(200,{ok:true});}
        return json(200,{ok:true,result:await collector.extension.call(page.descriptor,{action:'inspectNavigation'})});
      }
      if(route==='/api/extension/settlement-inspect'){
        if(collector.busy)throw Error('client_busy');const frames=collector.extension.attach().page.frames().filter(f=>new URL(f.url()).pathname==='/finance/static/html_pc/billReconciliation.html');if(frames.length!==1)throw Error('settlement_frame_missing');await collector.extension.call(frames[0].descriptor,{action:'refreshControls'});return json(200,{ok:true,result:await collector.extension.call(frames[0].descriptor,{action:'inspectSettlementList'})});
      }
      if(route==='/api/extension/document-health'){
        const page=collector.extension.attach().page,health=[];
        for(const frame of page.frames().filter(f=>!f.url().includes('/new_fe/')))health.push(await collector.extension.call(frame.descriptor,{action:'documentHealth'}));
        return json(200,{ok:true,health});
      }
      if(route==='/api/extension/inspect-navigation'){
        if(collector.busy)throw Error('client_busy');
        const page=collector.extension.attach().page;
        const labels=await page.getByText(/报表|经营|罗盘|数据/).filter({visible:true}).allTextContents();
        const report=page.getByText('报表下载',{exact:true}).filter({visible:true});
        const compass=page.getByText('经营罗盘',{exact:false}).filter({visible:true});
        const ancestors=[];let ancestor=compass;for(let d=0;d<6;d++){ancestors.push((await ancestor.allTextContents()).map(t=>t.slice(0,1200)));ancestor=ancestor.locator('..');}
        const menuCandidates={};for(const tag of ['a','li','[role="menuitem"]','[class*="menu"]'])menuCandidates[tag]=(await page.locator(tag).filter({hasText:/经营罗盘/}).allTextContents()).map(t=>t.slice(0,400)).slice(0,10);
        return json(200,{ok:true,labels:labels.map(t=>t.slice(0,150)).slice(0,60),menuCandidates,reportAllTexts:await page.getByText('报表下载',{exact:false}).allTextContents(),reportExactAllCount:await page.getByText('报表下载',{exact:true}).count(),reportCount:await report.count(),compassCount:await compass.count(),reportParents:await report.locator('..').allTextContents(),compassAncestors:ancestors,frames:page.frames().map(f=>{const u=new URL(f.url());return {origin:u.origin,path:u.pathname};})});
      }
      if(route==='/api/extension/diagnostics')return json(200,{ok:true,trace:collector.extension.diagnostics,frames:collector.extension.frames.map(f=>{const u=new URL(f.url);return {origin:u.origin,path:u.pathname};})});
      if(route==='/api/extension/inspect-settlement'||route==='/api/extension/refresh-settlement'){
        const page=collector.extension.attach().page;
        const frame=page.frames().find(f=>new URL(f.url()).pathname==='/finance/static/html_pc/billReconciliation.html');
        if(!frame)throw Error('settlement_frame_missing');
        const visible=locator=>locator.filter({visible:true});
        if(route==='/api/extension/refresh-settlement')await visible(frame.getByText('刷新',{exact:true})).click();
        const [values,options,scoped]=await Promise.all([
          visible(frame.locator('input[type="text"]')).evaluateAll(elements=>elements.map(el=>el.value)),
          visible(frame.locator('li')).allTextContents(),
          visible(frame.getByText('结算门店',{exact:true}).locator('..').locator('li')).allTextContents()
        ]);
        const dropdownOptions=await visible(frame.locator('[class*="dropdown"] li,[role="option"]')).allTextContents();
        const rows=await visible(frame.locator('tr')).evaluateAll(es=>es.map(e=>{const c=e.querySelectorAll('td');return {id:c[0]?.textContent.trim(),content:c[1]?.textContent.trim(),operation:c[3]?.textContent.trim()};}).filter(r=>/^\d+$/.test(r.id)));
        const rowText=await visible(frame.locator('tr')).allTextContents();
        const dialogs=await visible(frame.locator('[role="dialog"],.modal,.roo-modal,.modal-dialog,.roo-dialog,.ui-dialog,.layui-layer')).allTextContents();
        const noticePattern=/验证|失败|成功|确认|请输入|请选择|请先|不能|不支持|错误|稍后|上限|频繁|下载次数/;
        const notices=await visible(frame.getByText(noticePattern)).allTextContents();
        const mainNotices=await visible(page.getByText(noticePattern)).allTextContents();
        const downloadContext=await visible(frame.getByRole('button',{name:'下载账单',exact:true}).locator('..')).allTextContents();
        return json(200,{ok:true,values,options:options.slice(0,100).map(value=>value.slice(0,200)),storeFieldOptions:scoped.slice(0,100).map(value=>value.slice(0,200)),dropdownOptions:dropdownOptions.slice(0,100).map(value=>value.slice(0,200)),rows,rowText:rowText.slice(0,25).map(value=>value.slice(0,800)),dialogs:dialogs.slice(0,10).map(value=>value.slice(0,2000)),notices:notices.slice(-30).map(value=>value.slice(0,300)),mainNotices:mainNotices.slice(-30).map(value=>value.slice(0,300)),downloadContext:downloadContext.map(value=>value.slice(0,1000))});
      }
      if(route==='/api/extension/poll')return json(200,collector.extension.poll(input));
      if(route==='/api/extension/result')return json(200,collector.extension.result(input));
      if(route==='/api/config')return json(200,{ok:true,config:collector.save(input)});
      if(route==='/api/login'){await collector.openLogin();return json(200,{ok:true});}
      if(route==='/api/collect'){const {job}=collector.start(input.date,'manual',input.reportType||'operating',input.platform||'meituan_delivery');return json(202,{ok:true,id:job.id});}
      if(route==='/api/quit'){if(collector.busy)throw Error('client_busy');require('./core.cjs').atomic(path.join(collector.root,'user-paused.json'),{paused:true,at:new Date().toISOString()});json(200,{ok:true});await collector.close();server.close();onQuit();return;}
      return json(404,{error:'not_found'});
    }catch(error){const failure=publicError(error);return json(error.message==='client_busy'?409:400,{ok:false,...failure});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{origin='http://127.0.0.1:'+server.address().port;resolve();});});
  return {server,origin,token,url:origin+'/#'+token};
}
module.exports={createServer};
