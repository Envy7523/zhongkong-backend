'use strict';
// Operate the real visible Chrome tab. No document.hidden/focus emulation.
async function withVisiblePage(context,page,action){
 if(page.isClosed())throw Error('client_browser_unavailable');
 const session=await context.newCDPSession(page);
 try{
  const window=await session.send('Browser.getWindowForTarget');
  if(window?.bounds?.windowState==='minimized'&&Number.isInteger(window.windowId))await session.send('Browser.setWindowBounds',{windowId:window.windowId,bounds:{windowState:'normal'}});
  await page.bringToFront();
  try{await page.waitForFunction(()=>document.visibilityState==='visible',undefined,{timeout:5000});}catch{throw Error('client_browser_not_visible');}
  return await action();
 }finally{await session.detach().catch(()=>{});}
}
module.exports={withVisiblePage};
