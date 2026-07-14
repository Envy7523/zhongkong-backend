/**
 * 编码验证脚本 — 检查 HTTP 响应头 charset 和中文字段是否正确
 */
const http = require('http');

function fetchJSON(path) {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:3456' + path, (res) => {
      let data = '';
      const ct = res.headers['content-type'] || 'N/A';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ path, status: res.statusCode, contentType: ct, sample: JSON.stringify(json).slice(0, 250) });
        } catch(e) {
          resolve({ path, status: res.statusCode, contentType: ct, error: e.message });
        }
      });
    }).on('error', reject);
  });
}

(async () => {
  console.log('=== 编码修复验证报告 ===\n');

  // 1. JSON API charset
  const r1 = await fetchJSON('/api/db/stores');
  console.log('【JSON API — /api/db/stores】');
  console.log('  Content-Type:', r1.contentType);
  console.log('  Status:', r1.status);
  console.log('  中文内容:', r1.sample.includes('鹅太公') ? '✓ 中文正常' : '✗ 中文乱码/缺失');
  console.log('  charset:', r1.contentType.includes('charset=utf-8') ? '✓ 包含 charset=utf-8' : '✗ 缺少 charset');
  console.log();

  // 2. HTML 页面 charset
  const r2 = await fetchJSON('/');
  console.log('【HTML 页面 — /】');
  console.log('  Content-Type:', r2.contentType);
  console.log('  Status:', r2.status);
  console.log('  charset:', r2.contentType.includes('charset=utf-8') ? '✓ 包含 charset=utf-8' : '✗ 缺少 charset');
  console.log();

  // 3. Config（BOM 剥离验证）
  const r3 = await fetchJSON('/api/config');
  console.log('【配置 API — /api/config】');
  console.log('  Content-Type:', r3.contentType);
  console.log('  Status:', r3.status);
  console.log('  charset:', r3.contentType.includes('charset=utf-8') ? '✓ 包含 charset=utf-8' : '✗ 缺少 charset');
  console.log();

  console.log('=== 验证完成 ===');
  process.exit(0);
})();
