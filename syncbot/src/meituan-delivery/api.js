'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
async function call(root, endpoint, body) {
  if (!endpoint.startsWith('/api/internal/syncbot/meituan-delivery/')
    && endpoint !== '/api/internal/syncbot/report-sync-plans/meituan_delivery_operating') throw Error('operating_api_endpoint_invalid');
  const file = path.join(root, 'state/secrets/audit-hmac.json');
  if ((fs.statSync(file).mode & 0o077) !== 0) throw Error('operating_secret_permissions_invalid');
  const secret = JSON.parse(fs.readFileSync(file, 'utf8')).secret;
  if (typeof secret !== 'string' || secret.length < 16) throw Error('operating_secret_invalid');
  const raw = body === undefined ? '' : JSON.stringify(body), ts = String(Date.now());
  const signature = crypto.createHmac('sha256', secret).update(ts + '.' + raw).digest('hex');
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 3456, path: endpoint, method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': Buffer.byteLength(raw),
        'X-Syncbot-Timestamp': ts, 'X-Syncbot-Signature': signature }, timeout: 60000 }, res => {
      let text = '';
      res.on('data', data => { text += data; if (text.length > 1024 * 1024) req.destroy(); });
      res.on('end', () => {
        try { const result = JSON.parse(text); if (res.statusCode !== 200 || result.ok !== true) throw Error(result.reason || 'operating_api_rejected'); resolve(result); }
        catch (error) { reject(Error(/^[a-z][a-z0-9_:.-]{0,150}$/.test(error.message) ? error.message : 'operating_api_response_invalid')); }
      });
      res.on('error', () => reject(Error('operating_api_transport_unknown')));
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => reject(Error('operating_api_transport_unknown')));
    req.end(raw);
  });
}
module.exports = { call };
