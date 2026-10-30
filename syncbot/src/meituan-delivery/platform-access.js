'use strict';
function watchFinanceAccess(page){
 const blocked=new Map();
 const listener=response=>{let url;try{url=new URL(response.url());}catch{return;}
  if(url.origin!=='https://waimaieapp.meituan.com'||!url.pathname.startsWith('/finance/pc/api/billDownload/'))return;
  const status=response.status();if(status===401||status===403)blocked.set(url.pathname,status);else if(status>=200&&status<300)blocked.delete(url.pathname);
 };
 page.on('response',listener);
 return {assertAllowed(){if([...blocked.values()].includes(403))throw Error('client_platform_access_denied');if([...blocked.values()].includes(401))throw Error('client_platform_login_expired');},dispose(){page.off('response',listener);}};
}
module.exports={watchFinanceAccess};
