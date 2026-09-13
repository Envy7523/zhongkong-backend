/**
 * /api/mp 冒烟测试 —— 验证「登录 → 发起事项 → 列表 → 详情 → 回复 → 推进 → 撤销」整条闭环
 *
 * 用法：node tools/mp-smoke.js [baseUrl]      默认 http://localhost:3457
 * 前置：先启动服务（PORT=3457 node server.js）
 * 说明：结束时保留「已完成」的测试事项（用于验证不可逆留痕），
 *       停止服务后执行 node tools/mp-clean.js 清理（服务运行中直接改库会被内存态覆盖）。
 */
const BASE = process.argv[2] || 'http://localhost:3457';
const STAMP = String(Date.now()).slice(-6);          // 每次运行唯一，避免断言互相干扰
const TAG = '【冒烟测试】';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function login(username, password) {
  const r = await req('POST', '/api/mp/auth/login/password', { body: { username, password } });
  return r.data?.token || null;
}

(async () => {
  console.log(`\n=== /api/mp 冒烟测试 → ${BASE}（用例标记 ${STAMP}）===\n`);

  console.log('[1] 连通性与登录方式');
  const health = await req('GET', '/api/mp/health');
  check('GET /api/mp/health 返回 200', health.status === 200 && health.data?.ok === true, JSON.stringify(health.data));
  const providers = await req('GET', '/api/mp/auth/providers');
  check('providers 含 password 且 enabled', providers.data?.providers?.find(p => p.key === 'password')?.enabled === true);
  const wxwork = providers.data?.providers?.find(p => p.key === 'wxwork');
  console.log(`      ℹ️  企业微信免登 wxwork enabled=${wxwork?.enabled}（个人测试期应为 false，企业阶段配好凭据后自动 true）`);

  console.log('\n[2] 鉴权边界');
  check('无 token 访问 /me → 401', (await req('GET', '/api/mp/me')).status === 401);
  check('小程序 token 体系与后台隔离（用 mp token 调 /api/stores → 401）', (await req('GET', '/api/stores', { token: 'x' })).status === 401);

  console.log('\n[3] 密码登录');
  check('错误密码 → 401', (await req('POST', '/api/mp/auth/login/password', { body: { username: 'admin', password: 'wrong' } })).status === 401);
  const token = await login('admin', 'admin123');
  check('admin/admin123 登录成功并拿到 token', !!token);
  if (!token) { console.log('\n登录失败，后续用例跳过\n'); process.exit(1); }
  const me = await req('GET', '/api/mp/me', { token });
  check('GET /api/mp/me 返回当前身份', me.data?.user?.username === 'admin');
  console.log(`      ℹ️  user=${me.data?.user?.display_name} role=${me.data?.user?.role} storeScope=${me.data?.storeScope}`);

  console.log('\n[4] 协同事项：发起');
  const created = await req('POST', '/api/mp/collab/issues', {
    token,
    body: {
      title: `${TAG}门店卫生检查 ${STAMP}`,
      description: '自动化测试创建，见 tools/mp-clean.js',
      deadline: '2026-12-31',
      participants: [1],
      participants_name: ['系统管理员'],
    },
  });
  check('发起事项 → 201', created.status === 201 && !!created.data?.issue?.id, JSON.stringify(created.data));
  const issueId = created.data?.issue?.id;
  check('初始状态为「待开始」', created.data?.issue?.status === '待开始');
  check('下发 next_status 供前端渲染按钮', Array.isArray(created.data?.issue?.next_status) && created.data.issue.next_status.length > 0);
  check('空标题被拒 → 400', (await req('POST', '/api/mp/collab/issues', { token, body: { title: '   ' } })).status === 400);
  if (!issueId) { console.log('\n创建失败，后续用例跳过\n'); process.exit(1); }

  console.log('\n[5] 列表、筛选与统计');
  const list = await req('GET', '/api/mp/collab/issues?page=1&pageSize=10', { token });
  check('列表返回 rows/total', Array.isArray(list.data?.rows) && typeof list.data?.total === 'number');
  check('新事项出现在列表中', list.data.rows.some(r => r.id === issueId));
  const filtered = await req('GET', `/api/mp/collab/issues?keyword=${STAMP}`, { token });
  check('关键词筛选只命中本次创建的事项', filtered.data?.rows?.length === 1 && filtered.data.rows[0].id === issueId, `实际 ${filtered.data?.rows?.length} 条`);
  check('status 筛选可用', (await req('GET', '/api/mp/collab/issues?status=' + encodeURIComponent('待开始'), { token })).status === 200);
  check('onlyMine=1 可用', Array.isArray((await req('GET', '/api/mp/collab/issues?onlyMine=1', { token })).data?.rows));
  const stats = await req('GET', '/api/mp/collab/stats', { token });
  check('状态统计返回 5 项计数', ['total', 'pending', 'doing', 'done', 'undone'].every(k => typeof stats.data?.stats?.[k] === 'number'));

  console.log('\n[6] 详情');
  const detail = await req('GET', `/api/mp/collab/issues/${issueId}`, { token });
  check('详情返回 issue', detail.data?.issue?.id === issueId);
  check('participation 解析为数组', Array.isArray(detail.data?.issue?.participants_name) && detail.data.issue.participants_name[0] === '系统管理员');
  check('can_advance=true（自己是发起人）', detail.data?.issue?.can_advance === true);
  check('不存在的 id → 404', (await req('GET', '/api/mp/collab/issues/99999999', { token })).status === 404);

  console.log('\n[7] 跟进回复');
  const reply = await req('POST', `/api/mp/collab/issues/${issueId}/reply`, { token, body: { content: '已到店检查，厨房地面需整改', images: [] } });
  check('回复成功 → 201', reply.status === 201 && !!reply.data?.reply?.id);
  check('空内容回复被拒 → 400', (await req('POST', `/api/mp/collab/issues/${issueId}/reply`, { token, body: { content: '   ' } })).status === 400);

  console.log('\n[8] 状态推进（状态机与 PC 端共用同一份规则）');
  console.log('      ℹ️  待开始→进行中/已完成，进行中→已完成/未完成，未完成→已完成，已完成不可逆');
  const doing = await req('PUT', `/api/mp/collab/issues/${issueId}/advance`, { token, body: { status: '进行中', note: '已安排店长整改' } });
  check('待开始 → 进行中 成功', doing.status === 200 && doing.data?.issue?.status === '进行中', JSON.stringify(doing.data));
  check('推进自动写入时间线', doing.data?.reply?.content?.includes('状态更新'));
  const done = await req('PUT', `/api/mp/collab/issues/${issueId}/advance`, { token, body: { status: '已完成', note: '复检通过' } });
  check('进行中 → 已完成 成功', done.status === 200 && done.data?.issue?.status === '已完成');
  check('已完成 → 进行中 被拦截（不可逆）→ 400', (await req('PUT', `/api/mp/collab/issues/${issueId}/advance`, { token, body: { status: '进行中', note: '回退试试' } })).status === 400);
  check('缺少推进说明 → 400', (await req('PUT', `/api/mp/collab/issues/${issueId}/advance`, { token, body: { status: '未完成', note: '' } })).status === 400);
  check('已完成事项禁止回复 → 400', (await req('POST', `/api/mp/collab/issues/${issueId}/reply`, { token, body: { content: '还能回复吗' } })).status === 400);
  const finalDetail = await req('GET', `/api/mp/collab/issues/${issueId}`, { token });
  check('时间线共 3 条（回复 1 + 推进 2）', finalDetail.data?.replies?.length === 3, `实际 ${finalDetail.data?.replies?.length}`);
  check('已完成后 can_advance=false', finalDetail.data?.issue?.can_advance === false);

  console.log('\n[9] 权限：仅发起人可推进/撤销');
  const agentToken = await login('agent', 'agent123');
  check('agent 账号可登录', !!agentToken);
  if (agentToken) {
    check('非发起人推进 → 400', (await req('PUT', `/api/mp/collab/issues/${issueId}/advance`, { token: agentToken, body: { status: '未完成', note: '别人推进' } })).status === 400);
    check('非发起人撤销 → 403', (await req('DELETE', `/api/mp/collab/issues/${issueId}`, { token: agentToken })).status === 403);
  }

  console.log('\n[10] 撤销事项');
  check('已完成事项不能撤销（留痕）→ 400', (await req('DELETE', `/api/mp/collab/issues/${issueId}`, { token })).status === 400);
  const tmp = await req('POST', '/api/mp/collab/issues', { token, body: { title: `${TAG}待撤销事项 ${STAMP}` } });
  const tmpId = tmp.data?.issue?.id;
  check('新建一条用于撤销的事项', !!tmpId);
  if (tmpId) {
    check('发起人撤销「待开始」事项 → 200', (await req('DELETE', `/api/mp/collab/issues/${tmpId}`, { token })).status === 200);
    check('撤销后详情 404', (await req('GET', `/api/mp/collab/issues/${tmpId}`, { token })).status === 404);
  }

  console.log('\n[11] 图片上传');
  const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const up = await req('POST', '/api/mp/upload', { token, body: { data: `data:image/png;base64,${png1x1}` } });
  check('上传 PNG 成功并返回绝对 URL', up.status === 200 && /^http.*\/uploads\/mp\/.+\.png$/.test(up.data?.url || ''), JSON.stringify(up.data));
  check('伪造图片内容被魔数校验拦截 → 400', (await req('POST', '/api/mp/upload', { token, body: { data: 'data:image/png;base64,bm90YW5pbWFnZQ==' } })).status === 400);
  if (up.data?.url) {
    check('上传后的图片可通过静态地址访问', (await fetch(up.data.url)).status === 200);
  }

  console.log('\n[12] 遗留测试数据');
  const leftover = await req('GET', `/api/mp/collab/issues?keyword=${TAG}&pageSize=50`, { token });
  console.log(`      ℹ️  当前库中「${TAG}」事项 ${leftover.data?.rows?.length ?? '?'} 条（每次运行留下 1 条已完成事项）`);
  console.log(`      ℹ️  清理：先停止服务，再执行 node tools/mp-clean.js`);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
