const http = require('http');
function test(method, path, body) {
  return new Promise((resolve) => {
    const opts = { hostname: 'localhost', port: 3456, path, method, headers: { 'Content-Type': 'application/json' } };
    const req = http.request(opts, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { const j = JSON.parse(d); resolve({ path, method, status: res.statusCode, ok: j.ok, keys: Object.keys(j).join(',') }); }
        catch (e) { resolve({ path, method, status: res.statusCode, raw: d.slice(0, 60) }); }
      });
    });
    req.on('error', e => resolve({ path, method, error: e.message }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
(async () => {
  const tests = [
    ['GET', '/api/dashboard/stats'], ['GET', '/api/db/stores'], ['GET', '/api/menu'],
    ['GET', '/api/users'], ['GET', '/api/push-logs'], ['GET', '/api/analysis/revenue'],
    ['GET', '/api/cost-accounting'], ['GET', '/api/config'], ['GET', '/api/stores/1/employees'],
    ['GET', '/api/stores/1/fixed-costs'], ['GET', '/api/stores/1/platforms'],
    ['POST', '/api/stores/1/operating-costs', { item: '测试', amount: 100, date: '2026-07-13' }],
  ];
  for (const [m, p, b] of tests) {
    const r = await test(m, p, b);
    console.log(`${m} ${p} → ${r.status}`, r.ok !== undefined ? (r.ok ? '✓' : '✗') : '?', r.keys || r.error || '');
  }
  console.log('\nAll tests done.');
})();
