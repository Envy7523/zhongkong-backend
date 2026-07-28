const http = require('http');

function getToken() {
  return new Promise((resolve) => {
    const data = JSON.stringify({ username: 'admin', password: 'admin123' });
    const r = http.request({ hostname: '127.0.0.1', port: 3456, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b).token));
    });
    r.write(data); r.end();
  });
}

function req(m, p, d, tk) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: '127.0.0.1', port: 3456, path: p, method: m, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tk } };
    const r = http.request(opts, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => {
        let body;
        try { body = JSON.parse(b); } catch (e) { body = { raw: b }; }
        resolve({ status: res.statusCode, body });
      });
    });
    r.on('error', reject);
    if (d) { const body = JSON.stringify(d); r.setHeader('Content-Length', Buffer.byteLength(body)); r.write(body); }
    r.end();
  });
}

(async () => {
  try {
    const TK = await getToken();
    console.log('Token obtained:', TK.slice(0, 20) + '...');

    // 1. Create
    let r = await req('POST', '/api/collab/issues', {
      title: '重构验证-多选参与人',
      description: '测试新状态流转',
      deadline: '2026-08-05',
      start_time: '2026-07-28',
      participants: [2, 3],
      participants_name: ['王督导', '李客服']
    }, TK);
    console.log('1. CREATE =>', JSON.stringify(r.body, null, 2).slice(0, 200));
    const id = r.body?.issue?.id;
    if (!id) { console.log('NO ID!'); return; }

    // 2. →进行中
    r = await req('PUT', '/api/collab/issues/' + id + '/advance', { status: '进行中', note: '开始处理' }, TK);
    console.log('2. →进行中 => status=' + r.body?.issue?.status, 'error=' + (r.body?.error || 'none'));

    // 3. →已完成
    r = await req('PUT', '/api/collab/issues/' + id + '/advance', { status: '已完成', note: '全部搞定' }, TK);
    console.log('3. →已完成 => status=' + r.body?.issue?.status, 'completed_at=' + r.body?.issue?.completed_at, 'error=' + (r.body?.error || 'none'));

    // 4. 不可逆
    r = await req('PUT', '/api/collab/issues/' + id + '/advance', { status: '进行中', note: '试图回退' }, TK);
    console.log('4. 不可逆 => error=' + (r.body?.error || 'NONE'));

    console.log('ALL DONE');
  } catch (e) { console.error('FATAL:', e.message); }
})();
