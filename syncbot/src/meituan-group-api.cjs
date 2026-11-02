'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
async function callOnce(root, endpoint, body) {
  if (!['/api/internal/syncbot/events','/api/internal/syncbot/report-sync-plans/douyin_group_reviews','/api/internal/syncbot/douyin-group-report2/coverage','/api/internal/syncbot/douyin-group-report2/import','/api/internal/syncbot/report-sync-plans/douyin_group_report2','/api/internal/syncbot/douyin-group-report1/coverage','/api/internal/syncbot/douyin-group-report1/import','/api/internal/syncbot/report-sync-plans/douyin_group_report1','/api/internal/syncbot/meituan-group-report1/coverage','/api/internal/syncbot/meituan-group-report1/import','/api/internal/syncbot/meituan-group-report2/coverage','/api/internal/syncbot/meituan-group-report2/import',...['report1','report2','reviews'].map(type=>'/api/internal/syncbot/report-sync-plans/meituan_group_'+type)].includes(endpoint)) throw Error('finance_api_endpoint_invalid');
  const file = path.join(root, 'state/secrets/audit-hmac.json');
  if ((fs.statSync(file).mode & 0o077) !== 0) throw Error('finance_secret_permissions_invalid');
  const secret = JSON.parse(fs.readFileSync(file, 'utf8')).secret;
  if (typeof secret !== 'string' || secret.length < 16) throw Error('finance_secret_invalid');
  const raw = body === undefined ? '' : JSON.stringify(body), ts = String(Date.now());
  const signature = crypto.createHmac('sha256', secret).update(ts + '.' + raw).digest('hex');
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 3456, path: endpoint, method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': Buffer.byteLength(raw),
        'X-Syncbot-Timestamp': ts, 'X-Syncbot-Signature': signature }, timeout: 120000 }, res => {
      let text = '';
      res.on('data', data => { text += data; if (text.length > 1024 * 1024) req.destroy(); });
      res.on('end', () => {
        try { const result = JSON.parse(text); if (![200,201].includes(res.statusCode) || result.ok !== true) throw Error(result.reason || 'finance_api_rejected'); resolve(result); }
        catch (error) { reject(Error(/^[a-z][a-z0-9_:.-]{0,150}$/.test(error.message) ? error.message : 'finance_api_response_invalid')); }
      });
      res.on('error', () => reject(Error('finance_api_transport_unknown')));
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => reject(Error('finance_api_transport_unknown')));
    req.end(raw);
  });
}
async function retryTransport(operation,{attempts=3,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  for(let n=0;n<attempts;n++){
    try{return await operation();}catch(error){
      if(error.message!=='finance_api_transport_unknown'||n===attempts-1)throw error;
      await wait(2000*(n+1));
    }
  }
}
// Imports are keyed by file hash and audit events by event_id; retrying a lost
// response recovers the receipt without creating a second financial import.
async function call(root,endpoint,body){return retryTransport(()=>callOnce(root,endpoint,body));}
module.exports = { call, retryTransport };
