'use strict';
async function dismissOverlays(page){
 const actions=[];
 for(let round=0;round<6;round++){
  let changed=false;
  for(const frame of page.frames()){
   for(const text of ['跳过引导','跳过','我知道了','我已知晓','开始体验']){
    const candidates=frame.getByText(text,{exact:true});
    for(const candidate of await candidates.all())if(await candidate.isVisible()){
     try{await candidate.click({timeout:2000});actions.push(text);changed=true;}catch{/* Legacy hidden layers may report visible but be occluded. */}
     break;
    }
   }
   const notifications=frame.locator('.mtd-notification-close:visible');for(const close of await notifications.all()){await close.click({timeout:2000});actions.push('notification_close');changed=true;}
   for(const dialog of await frame.locator('[role="dialog"]:visible').all()){
    const text=await dialog.innerText();if(!/新手|引导|平台公告|活动推广|浏览器升级/.test(text))continue;
    const close=dialog.getByRole('button',{name:/^(关闭|跳过|取消)$/});if(await close.count()===1){await close.click({timeout:2000});actions.push('guide_dialog_close');changed=true;}
   }
  }
  if(!changed)break;await page.waitForTimeout(300);
 }
 return actions;
}
module.exports={dismissOverlays};
