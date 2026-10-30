/* This module accepts a small locator/action vocabulary, never JavaScript source. */
(function(root){
 const allowed=new Set(['https://waimaie.meituan.com','https://waimaieapp.meituan.com','https://melody.shop.ele.me','https://store.jddj.com','https://kunce-store.jddj.com','https://melody-stats-next.ele.me','https://napos-bill-pc.faas.ele.me']);
 const normalize=s=>String(s||'').replace(/\s+/g,' ').trim();
 function matches(text,rule){if(!rule)return true;if(rule.regex){if(rule.regex.length>300||!/^[imu]*$/.test(rule.flags||''))throw Error('extension_regex_denied');return new RegExp(rule.regex,rule.flags).test(text);}return rule.exact?normalize(text)===normalize(rule.text):normalize(text).includes(normalize(rule.text));}
 function visible(el){const style=el.ownerDocument.defaultView.getComputedStyle(el);return !!el.getClientRects().length&&style.visibility!=='hidden'&&style.display!=='none';}
 function moveAndClick(doc,el,click){
  el.scrollIntoView({block:'center'});const rect=el.getBoundingClientRect(),options={bubbles:true,clientX:rect.x+rect.width/2,clientY:rect.y+rect.height/2,view:doc.defaultView,button:0};
  for(let ancestor=el;ancestor&&ancestor!==doc.body;ancestor=ancestor.parentElement)ancestor.dispatchEvent(new doc.defaultView.MouseEvent('mouseenter',{...options,bubbles:false}));
  for(const name of ['mouseover','mousemove',...(click?['mousedown','mouseup']:[])])el.dispatchEvent(new doc.defaultView.MouseEvent(name,{...options,buttons:name==='mousedown'?1:0}));
  if(click)el.click();
 }
 function query(doc,steps,scope=doc,depth=0){
  if(!Array.isArray(steps)||steps.length>30||depth>6)throw Error('extension_locator_denied');
  let items=[scope];
  for(const step of steps){
   if(step.kind==='css'){if(typeof step.value!=='string'||step.value.length>500)throw Error('extension_selector_denied');items=items.flatMap(e=>step.value==='..'?(e.parentElement?[e.parentElement]:[]):[...e.querySelectorAll(step.value)]);}
   else if(step.kind==='text'){items=items.flatMap(e=>[...e.querySelectorAll('*')].filter(el=>!['SCRIPT','STYLE','NOSCRIPT'].includes(el.tagName)&&matches(el.textContent,step.match)&&![...el.children].some(child=>matches(child.textContent,step.match))));}
   else if(step.kind==='role'){const selectors={button:'button,[role="button"],input[type="button"],input[type="submit"]',link:'a,[role="link"]'};if(!selectors[step.role])throw Error('extension_role_denied');items=items.flatMap(e=>[...e.querySelectorAll(selectors[step.role])].filter(el=>matches(el.getAttribute('aria-label')||el.textContent||el.value,step.match)&&(step.disabled===undefined||!!el.disabled===step.disabled)));}
   else if(step.kind==='filter')items=items.filter(el=>(step.visible===undefined||visible(el)===step.visible)&&(!step.text||matches(el.textContent,step.text))&&(!step.has||query(doc,step.has,el,depth+1).length));
   else if(step.kind==='nth')items=items[step.index]?[items[step.index]]:[];
   else throw Error('extension_locator_denied');
   items=[...new Set(items)];
  }
  return items;
 }
 async function execute(doc,command){
  if(!allowed.has(doc.location.origin))throw Error('extension_origin_denied');
  if(command.action==='collectorLayout'){
   const labels={shop:'门店',product:'商品',finance:'财务管理',finance_download:'下载专区',reports:'报表下载',data:'数据中心',data_download:'数据下载',materials:'资料下载',shop_download:'门店下载',product_download:'商品下载',download_management:'下载管理'};
   const codes=['document_'+(doc.visibilityState==='visible'?'visible':'hidden')];
   for(const [key,text]of Object.entries(labels)){const nodes=query(doc,[{kind:'text',match:{text,exact:true}}]);codes.push('nav_'+key+'_'+Math.min(nodes.length,99)+'_visible_'+Math.min(nodes.filter(visible).length,99));}
   return codes;
  }
  if(command.action==='reloadFlashDownloadPage'){
   if(doc.location.origin!=='https://melody.shop.ele.me'||!/^\/app\/chain\/\d+\/downloadCenter$/.test(doc.location.pathname)||doc.defaultView.top!==doc.defaultView)throw Error('flash_reload_origin_invalid');
   if(doc.visibilityState!=='visible')throw Error('client_browser_not_visible');doc.location.reload();return true;
  }
  if(command.action==='inspectFlashCalendar'){
   if(doc.location.origin!=='https://melody-stats-next.ele.me')throw Error('extension_origin_denied');
   return {visibility:doc.visibilityState,inputs:[...doc.querySelectorAll('input[placeholder="开始日期"],input[placeholder="结束日期"]')].map(e=>({placeholder:e.placeholder,value:e.value})),dates:[...doc.querySelectorAll('.ant-picker-dropdown td')].filter(visible).map(e=>({title:e.title,className:e.className}))};
  }
  if(command.action==='inspectFlashReport'){
   if(!['https://melody.shop.ele.me','https://melody-stats-next.ele.me','https://napos-bill-pc.faas.ele.me'].includes(doc.location.origin))throw Error('extension_origin_denied');
   return {path:doc.location.pathname,visibility:doc.visibilityState,routeHint:/^#\/[a-z0-9_/-]+$/i.test(doc.location.hash)?doc.location.hash:'',
    menus:[...doc.querySelectorAll('[class*="menu"],[role="dialog"]')].filter(visible).map(e=>normalize(e.textContent)).filter(t=>t&&t.length<1400).slice(-40),
    controls:[...doc.querySelectorAll('button,a,[role="menuitem"],[role="tab"],label')].filter(visible).map(e=>({tag:e.tagName,text:normalize(e.innerText||e.textContent),className:e.className,selected:e.getAttribute('aria-selected'),disabled:!!e.disabled})).filter(e=>e.text).slice(0,140),
    inputs:[...doc.querySelectorAll('input')].filter(e=>visible(e)&&!['password','hidden'].includes(e.type)&&!/pass|token|secret|auth|cookie|mobile|phone|验证码/i.test(e.name+' '+e.id+' '+e.placeholder)).slice(0,70).map(e=>({type:e.type,value:e.value,checked:e.checked,readOnly:e.readOnly,placeholder:e.placeholder,className:e.className})),
    headings:[...doc.querySelectorAll('h1,h2,h3,h4,thead')].filter(visible).map(e=>normalize(e.textContent)).slice(0,30),
    text:['https://melody-stats-next.ele.me','https://napos-bill-pc.faas.ele.me'].includes(doc.location.origin)?normalize(doc.body.innerText).slice(0,14000):'',
    tableRows:[...doc.querySelectorAll('tr')].filter(visible).slice(0,25).map(e=>[...e.querySelectorAll('td,th')].map(cell=>normalize(cell.textContent))),
    options:[...doc.querySelectorAll('[role="option"],[role="combobox"],.cook-picker-dropdown td,.cook-picker-dropdown button,.ant-picker-dropdown td,.ant-picker-dropdown button')].filter(visible).map(e=>({tag:e.tagName,className:e.className,text:normalize(e.innerText||e.textContent),title:e.title,selected:e.getAttribute('aria-selected')})),
    selectedColumns:[...doc.querySelectorAll('input[type="checkbox"]')].filter(e=>e.checked&&visible(e)).map(e=>e.value).slice(0,300),
    reportSelections:[...doc.querySelectorAll('[class*="filterWrapper"]')].filter(visible).map(e=>({text:normalize(e.innerText),selected:[...e.querySelectorAll('[class*="activated"]')].map(n=>normalize(n.innerText))})),
    fieldGroups:query(doc,[{kind:'text',match:{regex:'^(类型|门店|内容|时间|自定义|全部门店|汇总)$'}},{kind:'filter',visible:true}]).slice(0,20).map(el=>{const chain=[];for(let node=el,i=0;node&&i<4;node=node.parentElement,i++)chain.push({tag:node.tagName,className:node.className,text:normalize(node.textContent).slice(0,600)});return chain;}),
    activeChoices:[...doc.querySelectorAll('[class*="index_active"]')].filter(visible).map(e=>normalize(e.textContent)),
    navigation:query(doc,[{kind:'text',match:{regex:'^(数据中心|财务管理|报表下载|数据下载|下载中心|经营分析)$'}}]).map(el=>{const chain=[];for(let node=el,i=0;node&&i<4;node=node.parentElement,i++)chain.push({tag:node.tagName,className:node.className,visible:visible(node),text:normalize(node.textContent).slice(0,450)});return chain;}),
    embeddedPages:[...doc.querySelectorAll('iframe')].map(e=>{try{const u=new URL(e.src,doc.location.href);return {origin:u.origin,path:u.pathname,visible:visible(e),routeHint:/^#\/[a-z0-9_/-]+$/i.test(u.hash)?u.hash:''};}catch{return null;}}).filter(Boolean)};
  }
  if(command.action==='inspectJdReport'){
   if(!['https://store.jddj.com','https://kunce-store.jddj.com'].includes(doc.location.origin))throw Error('extension_origin_denied');
   return {path:doc.location.pathname,visibility:doc.visibilityState,
    embeddedPages:[...doc.querySelectorAll('iframe')].map(e=>{try{const u=new URL(e.src,doc.location.href);return {origin:u.origin,path:u.pathname};}catch{return null;}}).filter(Boolean),
    inputs:[...doc.querySelectorAll('input')].filter(e=>visible(e)&&!['password','hidden'].includes(e.type)&&!/pass|token|secret|auth|cookie|mobile|phone|验证码/i.test(e.name+' '+e.id+' '+e.placeholder)).slice(0,60).map(e=>({type:e.type,value:e.value,checked:e.checked,readOnly:e.readOnly,placeholder:e.placeholder,className:e.className})),
    controls:[...doc.querySelectorAll('button,[role="button"],a')].filter(visible).slice(0,100).map(e=>({tag:e.tagName,text:normalize(e.textContent),className:e.className,disabled:!!e.disabled})).filter(e=>e.text),
    choices:[...doc.querySelectorAll('label,[class*="radio"],[class*="checkbox"]')].filter(visible).slice(0,80).map(e=>({text:normalize(e.textContent).slice(0,150),className:e.className})),
    ancestors:['账单时间','月','结算门店'].map(text=>{const found=query(doc,[{kind:'text',match:{text,exact:true}},{kind:'filter',visible:true}]);return found.slice(0,2).map(el=>{const chain=[];for(let node=el,d=0;node&&d<4;d++,node=node.parentElement)chain.push({tag:node.tagName,className:node.className,text:normalize(node.textContent).slice(0,500)});return chain;});}),
    rows:[...doc.querySelectorAll('tr')].filter(visible).slice(0,25).map(e=>normalize(e.textContent)),
    tableRows:[...doc.querySelectorAll('tr')].filter(visible).slice(0,25).map(e=>[...e.querySelectorAll('td,th')].map(cell=>normalize(cell.textContent))),
    navigation:query(doc,[{kind:'text',match:{regex:'^(报表下载|经营罗盘)$'}}]).map(el=>{const chain=[];for(let node=el,i=0;node&&i<5;node=node.parentElement,i++)chain.push({tag:node.tagName,className:node.className,visible:visible(node),text:normalize(node.textContent).slice(0,300)});return chain;}),
    text:doc.location.origin==='https://kunce-store.jddj.com'?normalize(doc.body.innerText).slice(0,10000):[...doc.querySelectorAll('form.dj-form,[role="dialog"],.dj-dialog,.el-dialog')].filter(visible).map(e=>normalize(e.innerText)).join('\n').slice(0,10000),
    reportControls:[...doc.querySelectorAll('[role="tab"],[role="radio"],.ant-picker-dropdown td,.ant-picker-dropdown button')].filter(visible).map(e=>({tag:e.tagName,className:e.className,text:normalize(e.innerText),title:e.title,selected:e.getAttribute('aria-selected')})),
    overlays:[...doc.querySelectorAll('[class*="dialog"],[class*="modal"],[class*="drawer"],.el-picker-panel')].filter(visible).slice(0,20).map(e=>({tag:e.tagName,className:e.className,text:normalize(e.innerText).slice(0,4000)})),
    calendar:[...doc.querySelectorAll('.el-picker-panel td,.el-picker-panel button')].filter(visible).map(e=>({tag:e.tagName,className:e.className,text:normalize(e.textContent),title:e.title,disabled:!!e.disabled}))};
  }
  if(command.action==='openJdStatement'){
   if(doc.defaultView.top!==doc.defaultView||doc.visibilityState!=='visible')throw Error('client_browser_not_visible');
   doc.location.assign('https://store.jddj.com/v3/financial/statement/newDownload');return true;
  }
  if(command.action==='inspectSettlementList'){
   if(doc.location.origin!=='https://waimaieapp.meituan.com'||!doc.location.pathname.startsWith('/finance/'))throw Error('extension_origin_denied');
   return {path:doc.location.pathname,pagination:[...doc.querySelectorAll('ul.roo-pagination li')].filter(visible).map(e=>({text:normalize(e.textContent),className:e.className,ariaDisabled:e.getAttribute('aria-disabled'),html:e.innerHTML.slice(0,350)})),rows:[...doc.querySelectorAll('tr')].filter(visible).slice(0,25).map(e=>[...e.querySelectorAll('td')].map(c=>normalize(c.textContent)))};
  }
  if(command.action==='documentHealth')return {visibility:doc.visibilityState,focused:doc.hasFocus(),path:doc.location.pathname,...(doc.location.pathname==='/bizdata_pc/report/download'?{buttons:[...doc.querySelectorAll('button')].map(e=>({text:normalize(e.textContent),visible:visible(e),disabled:e.disabled})),dates:[...doc.querySelectorAll('input[type="text"]')].filter(visible).map(e=>e.value),tabs:[...doc.querySelectorAll('span.tab-text')].map(e=>normalize(e.textContent))}:{})};
  if(command.action==='inspectNavigation'){
   if(doc.location.origin!=='https://waimaie.meituan.com')throw Error('extension_origin_denied');
   const labels=query(doc,[{kind:'text',match:{regex:'经营罗盘|报表下载'}}]);
   return labels.slice(0,10).map(el=>{const chain=[];for(let node=el,d=0;node&&d<6;d++,node=node.parentElement){let href;try{const u=new URL(node.getAttribute('href'),doc.location.href);if(node.hasAttribute('href')&&allowed.has(u.origin))href=u.origin+u.pathname;}catch{}chain.push({tag:node.tagName,className:node.className,role:node.getAttribute('role'),expanded:node.getAttribute('aria-expanded'),visible:visible(node),text:normalize(node.textContent).slice(0,500),href});}return chain;});
  }
  if(command.action==='openOperatingReport'){
   if(doc.location.origin!=='https://waimaie.meituan.com'||doc.visibilityState!=='visible')throw Error('client_browser_not_visible');
   // A CSS-hover submenu cannot be opened by synthetic pointer events. Activate only
   // this unique, fixed navigation entry; no hidden form controls or arbitrary URLs.
   let entries=query(doc,[{kind:'text',match:{text:'报表下载',exact:true}}]);
   if(!entries.length){const compass=query(doc,[{kind:'css',value:'[class*="menu-item"]'},{kind:'filter',text:{regex:'^经营罗盘(?:新)?$'},visible:true}]);if(compass.length!==1)throw Error('operating_compass_ambiguous');moveAndClick(doc,compass[0],true);for(let i=0;i<30&&!entries.length;i++){await new Promise(r=>setTimeout(r,100));entries=query(doc,[{kind:'text',match:{text:'报表下载',exact:true}}]);}}
   if(entries.length!==1)throw Error('operating_navigation_ambiguous');
   const target=entries[0].closest('a,[role="menuitem"]')||entries[0];
   if(target.tagName==='A'&&target.getAttribute('href')&&!target.getAttribute('href').startsWith('javascript:')){
    const destination=new URL(target.getAttribute('href'),doc.location.href);
    if(!allowed.has(destination.origin))throw Error('operating_navigation_origin_denied');
   }
   moveAndClick(doc,target,true);return true;
  }
  if(command.action==='openFinanceDownload'){
   if(doc.location.origin!=='https://waimaie.meituan.com'||doc.visibilityState!=='visible')throw Error('client_browser_not_visible');
   // A CSS-hover submenu cannot be opened by synthetic pointer events. Activate only
   // this unique, fixed navigation entry; no hidden form controls or arbitrary URLs.
   let entries=query(doc,[{kind:'text',match:{regex:'^下载专区(?:\\s*新)?$'}}]);
   if(!entries.length){const compass=query(doc,[{kind:'css',value:'[class*="menu-item"]'},{kind:'filter',text:{regex:'^财务管理(?:新)?$'},visible:true}]);if(compass.length!==1)throw Error('settlement_finance_menu_ambiguous');moveAndClick(doc,compass[0],true);for(let i=0;i<30&&!entries.length;i++){await new Promise(r=>setTimeout(r,100));entries=query(doc,[{kind:'text',match:{regex:'^下载专区(?:\\s*新)?$'}}]);}}
   if(entries.length!==1)throw Error('settlement_finance_navigation_ambiguous');
   const target=entries[0].closest('a,[role="menuitem"]')||entries[0];
   if(target.tagName==='A'&&target.getAttribute('href')&&!target.getAttribute('href').startsWith('javascript:')){
    const destination=new URL(target.getAttribute('href'),doc.location.href);
    if(!allowed.has(destination.origin))throw Error('settlement_navigation_origin_denied');
   }
   moveAndClick(doc,target,true);return true;
  }
  const {action,steps=[],value,reader,arg}=command,items=query(doc,steps);
  if(!['count','texts','visible','readAll','read','value','checked','hover','click','fill','press'].includes(action))throw Error('extension_action_denied');
  if(action==='count')return items.length;
  if(action==='texts')return items.map(el=>el.textContent);
  if(action==='visible')return items.length===1&&visible(items[0]);
  if(items.some(el=>el.matches?.('input[type="password"]')))throw Error('extension_password_denied');
  if(action==='readAll'){if(!Object.hasOwn(root.ETG_READS,reader))throw Error('extension_reader_denied');if(arg!==undefined&&!['门店','商品'].includes(arg))throw Error('extension_argument_denied');return root.ETG_READS[reader](items,arg);}
  if(items.length!==1)throw Error('extension_element_ambiguous');
  const el=items[0];
  if(action==='read'){if(!Object.hasOwn(root.ETG_READS,reader))throw Error('extension_reader_denied');return root.ETG_READS[reader](el);}
  if(action==='value')return el.value;
  if(action==='checked')return !!el.checked;
  if(doc.visibilityState!=='visible')throw Error('client_browser_not_visible');
  if(!visible(el))throw Error('extension_element_hidden');
  if(el.disabled||el.getAttribute('aria-disabled')==='true')throw Error('extension_element_disabled');
  if(el.matches('input[type="password"]'))throw Error('extension_password_denied');
  if(action==='hover'||action==='click'){
   moveAndClick(doc,el,action==='click');return true;
  }
  if(action==='fill'){
   if(!(el.tagName==='TEXTAREA'||el.tagName==='INPUT'&&el.type==='text')||el.readOnly||typeof value!=='string'||value.length>10000)throw Error('extension_fill_denied');
   const proto=el.tagName==='TEXTAREA'?doc.defaultView.HTMLTextAreaElement.prototype:doc.defaultView.HTMLInputElement.prototype;
   Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;
  }
  if(action==='press'){
   if(!['Enter','Tab'].includes(value))throw Error('extension_key_denied');el.focus();
   if(value==='Tab'){el.dispatchEvent(new Event('change',{bubbles:true}));el.blur();return true;}
   // DOM-dispatched Enter has no browser default activation; activate only this verified button.
   if(!el.matches('button,a,[role="button"],input[type="submit"]'))throw Error('extension_key_denied');el.click();return true;
  }
  throw Error('extension_action_denied');
 }
 root.ETG_DOM={execute,query};
 if(typeof module==='object')module.exports=root.ETG_DOM;
})(globalThis);
