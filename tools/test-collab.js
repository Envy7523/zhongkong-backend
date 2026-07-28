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
  return new Promise((resolve) => {
    const r = http.request({ hostname: '127.0.0.1', port: 3456, path: p, method: m, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tk } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
    });
    if (d) { const body = JSON.stringify(d); r.setHeader('Content-Length', Buffer.byteLength(body)); r.write(body); }
    r.end();
  });
}

(async () => {
  const TK = await getToken();

  // 1. Create
  let r = await req('POST', '/api/collab/issues', {
    title: '重构验证-多选参与人',
    description: '测试新状态流转',
    deadline: '2026-08-05',
    start_time: '2026-07-28',
    participants: [2, 3],
    participants_name: ['王督导', '李客服']
  }, TK);
  console.log('1. CREATE:', r.status, '| status=' + r.body.issue.status, '| participants=' + r.body.issue.participants_name.join(','), '| display=' + r.body.issue.status_display);

  const id = r.body.issue.id;

  // 2. Advance: 待开始→进行中
  r = await req('PUT', '/api/collab/issues/' + id + '/advance', { status: '进行中', note: '开始处理' }, TK);
  console.log('2. →进行中:', r.status, '| status=' + r.body.issue?.status, '| start_time=' + r.body.issue?.start_time, r.body.error || '');

  // 3. Advance: 进行中→已完成
  r = await req('PUT', '/api/collab/issues/' + id + '/advance', { status: '已完成', note: '全部搞定' }, TK);
  console.log('3. →已完成:', r.status, '| status=' + r.body.issue?.status, '| completed_at=' + r.body.issue?.completed_at, r.body.error || '');

  // 4. 不可逆验证
  r = await req('PUT', '/api/collab/issues/' + id + '/advance', { status: '进行中', note: '试图回退' }, TK);
  console.log('4. 不可逆:', r.status, '| error=' + (r.body.error || 'NONE'));

  // 5. 列表验证 - 筛选"已完成"
  r = await req('GET', '/api/collab/issues?status=' + encodeURIComponent('已完成'), null, TK);
  console.log('5. 列表(已完成):', r.status, '| count=' + r.body.rows?.length);

  console.log('ALL DONE');
})().catch(e => console.error('FATAL:', e.message));
