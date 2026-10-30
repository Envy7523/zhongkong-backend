'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {watchFinanceAccess}=require('../syncbot/src/meituan-delivery/platform-access');
const response=(path,status)=>({url:()=> 'https://waimaieapp.meituan.com'+path+'?private_test_parameter=not_logged',status:()=>status});
test('平台403或会话401停止处理；其他广告请求不误判，正常响应可解除对应阻点',()=>{
 const page=new EventEmitter(),guard=watchFinanceAccess(page),a='/finance/pc/api/billDownload/getFileType',b='/finance/pc/api/billDownload/getPoiList';page.emit('response',response('/ad/example',403));assert.doesNotThrow(()=>guard.assertAllowed());page.emit('response',response(a,403));assert.throws(()=>guard.assertAllowed(),/client_platform_access_denied/);page.emit('response',response(b,401));page.emit('response',response(a,200));assert.throws(()=>guard.assertAllowed(),/client_platform_login_expired/);page.emit('response',response(b,200));assert.doesNotThrow(()=>guard.assertAllowed());guard.dispose();assert.equal(page.listenerCount('response'),0);
});
