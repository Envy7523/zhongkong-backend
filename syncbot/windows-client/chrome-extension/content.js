'use strict';
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(sender.id!==chrome.runtime.id||message?.channel!=='etg-dom-v1')return;
 Promise.resolve().then(()=>ETG_DOM.execute(document,message.command)).then(value=>reply({ok:true,value}),error=>reply({ok:false,error:/^[a-z][a-z0-9_]+$/.test(error.message)?error.message:'extension_dom_failed'}));
 return true;
});
