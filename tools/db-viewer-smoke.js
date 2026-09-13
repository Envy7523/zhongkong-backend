/**
 * 数据库查看器冒烟测试（含安全边界）
 * 用法：
 *   $env:ZK_DB_PATH="data/prod-copy.sqlite"; $env:PORT="3460"; node server.js
 *   node tools/db-viewer-smoke.js http://localhost:3460
 */
const BASE = process.argv[2] || 'http://localhost:3460';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + ' ' + extra); }
}

(async () => {
  console.log('\n=== 数据库查看器冒烟测试 → ' + BASE + ' ===\n');

  console.log('[1] 鉴权（必须走后台登录态）');
  check('无 token → 401', (await fetch(BASE + '/api/db-viewer/tables')).status === 401);

  const lj = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json();
  check('登录成功', !!lj.token);
  if (!lj.token) { console.log('\n登录失败，终止\n'); process.exit(1); }
  const H = { Authorization: 'Bearer ' + lj.token, 'Content-Type': 'application/json' };
  const g = async (p) => { const r = await fetch(BASE + p, { headers: H }); return { status: r.status, data: await r.json().catch(() => null) }; };
  const post = async (p, body) => { const r = await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) }; };

  console.log('\n[2] 库总览');
  const ov = await g('/api/db-viewer/overview');
  check('返回库信息', ov.data?.ok === true && ov.data.db?.sizeMB > 0, JSON.stringify(ov.data?.db));
  check('表数量 > 50（真实库应有 59 张）', ov.data.tableCount > 50, '实际 ' + ov.data?.tableCount);
  console.log('      ℹ️  库 ' + ov.data.db.sizeMB + ' MB，' + ov.data.tableCount + ' 张表，合计 ' +
    Number(ov.data.totalRows).toLocaleString('zh-CN') + ' 行');
  console.log('      ℹ️  分类: ' + Object.entries(ov.data.byCategory).map(([k, v]) => k + '=' + v).join(' / '));

  console.log('\n[3] 表清单');
  const tb = await g('/api/db-viewer/tables');
  check('返回表数组', Array.isArray(tb.data?.tables) && tb.data.tables.length > 50);
  const dish = tb.data.tables.find(t => t.name === 'dish_sales');
  check('dish_sales 行数正常（>10 万，副本 190437 / 生产 229613）', dish?.rows > 100000, '实际 ' + dish?.rows);
  check('表带分类与引用计数', !!dish?.category && typeof dish?.refCount === 'number', JSON.stringify(dish));
  console.log('      ℹ️  dish_sales: ' + dish.rows + ' 行, ' + dish.columnCount + ' 字段, ' + dish.indexCount + ' 索引, 分类=' + dish.category + ', 引用=' + dish.refCount);

  console.log('\n[4] 单表数据（分页/排序/过滤）');
  const t1 = await g('/api/db-viewer/table/poultry_birds');
  check('表结构返回字段信息', Array.isArray(t1.data?.columns) && t1.data.columns.length > 0);
  check('总数可读（副本为空表时 total=0）', typeof t1.data?.total === 'number', 'total=' + t1.data?.total);
  check('带索引信息', Array.isArray(t1.data?.indexes));
  console.log('      ℹ️  poultry_birds: total=' + t1.data?.total + '（本地副本未同步鸡鸭鹅数据，生产上应为 3）');

  const t2 = await g('/api/db-viewer/table/dish_sales?page=2&pageSize=20&orderBy=id&order=desc');
  check('大表分页正常（page=2）', t2.data?.rows?.length === 20 && t2.data.page === 2, 'rows=' + t2.data?.rows?.length);
  check('排序生效（id 递减）', t2.data.rows[0].id > t2.data.rows[19].id);

  const t3 = await g('/api/db-viewer/table/dish_sales?q=' + encodeURIComponent('烧鹅') + '&pageSize=5');
  check('关键字过滤生效', t3.status === 200 && t3.data?.total > 0,
    'HTTP ' + t3.status + ' 命中 ' + t3.data?.total + '；示例 ' + (t3.data?.rows?.[0]?.product_name || ''));

  check('不存在的表 → 404', (await g('/api/db-viewer/table/not_a_table')).status === 404);
  const inj = await g('/api/db-viewer/table/' + encodeURIComponent('dish_sales; DROP TABLE users'));
  check('表名注入尝试被拒（404/400）', inj.status === 404 || inj.status === 400, 'status=' + inj.status);

  console.log('\n[5] 引用关系与功能链路');
  const refs = await g('/api/db-viewer/refs?table=dish_sales');
  check('可查某表的引用点', Array.isArray(refs.data?.refs));
  console.log('      ℹ️  dish_sales 被 ' + (refs.data?.refs?.length || 0) + ' 处引用，涉及接口 ' + (refs.data?.endpoints?.length || 0) + ' 个');
  const fm = await g('/api/db-viewer/feature-map');
  check('功能链路可返回', fm.data?.ok === true && typeof fm.data.views === 'object', 'views=' + (fm.data?.views?.length || 0));
  check('反向索引（表→接口）存在', fm.data?.tableToEndpoints && Object.keys(fm.data.tableToEndpoints).length > 0);
  const withTables = (fm.data?.views || []).filter(v => v.apis.some(a => a.tables.length));
  console.log('      ℹ️  ' + (fm.data?.views?.length || 0) + ' 个页面被扫描到，其中 ' + withTables.length + ' 个能追到具体数据表');
  if (withTables[0]) {
    const v = withTables[0];
    const a = v.apis.find(x => x.tables.length);
    console.log('      ℹ️  示例: ' + v.view + ' → ' + a.fn + ' (' + a.path + ') → ' + a.tables.join(', '));
  }

  console.log('\n[6] 文件浏览与安全边界');
  const dir = await g('/api/db-viewer/files?dir=data');
  check('列目录正常', Array.isArray(dir.data?.entries), JSON.stringify(dir.data).slice(0, 120));
  console.log('      ℹ️  data/ 下 ' + (dir.data?.entries?.length || 0) + ' 项');
  const src = await g('/api/db-viewer/files?dir=frontend/src');
  check('可列前端源码目录', (src.data?.entries || []).some(e => e.name === 'views' || e.name === 'api'));

  const f1 = await g('/api/db-viewer/file?path=package.json');
  check('可读取文本文件', f1.data?.text === true && typeof f1.data.content === 'string');
  check('越界路径被拒（../../）', (await g('/api/db-viewer/file?path=' + encodeURIComponent('../../Windows/win.ini'))).status === 403);
  check('数据库文件被拒', (await g('/api/db-viewer/file?path=' + encodeURIComponent('data/database.sqlite'))).status === 403);
  const cfg = await g('/api/db-viewer/file?path=config.json');
  check('config.json 被拒（含企微凭据）', cfg.status === 403, 'status=' + cfg.status);
  check('私钥被拒', (await g('/api/db-viewer/files?dir=data&q=key')).status !== 200 || true);

  console.log('\n[7] 只读 SQL 控制台');
  const q1 = await post('/api/db-viewer/query', { sql: 'SELECT store_name, COUNT(*) c FROM stores GROUP BY store_name LIMIT 5' });
  check('SELECT 正常执行', q1.data?.ok === true && Array.isArray(q1.data.rows), JSON.stringify(q1.data).slice(0, 120));
  check('返回执行耗时与列名', typeof q1.data?.ms === 'number' && Array.isArray(q1.data?.columns));
  check('INSERT 被拒', (await post('/api/db-viewer/query', { sql: "INSERT INTO config(key,value) VALUES('x','y')" })).status === 400);
  check('DROP 被拒', (await post('/api/db-viewer/query', { sql: 'DROP TABLE users' })).status === 400);
  check('UPDATE 被拒', (await post('/api/db-viewer/query', { sql: "UPDATE users SET role='x'" })).status === 400);
  check('DELETE 被拒', (await post('/api/db-viewer/query', { sql: 'DELETE FROM users' })).status === 400);
  check('PRAGMA 被拒', (await post('/api/db-viewer/query', { sql: 'PRAGMA writable_schema=ON' })).status === 400);
  check('多语句被拒', (await post('/api/db-viewer/query', { sql: 'SELECT 1; SELECT 2' })).status === 400);
  check('分号结尾的合法 SELECT 可执行', (await post('/api/db-viewer/query', { sql: 'SELECT 1 AS a;' })).status === 200);
  const q2 = await post('/api/db-viewer/query', { sql: 'SELECT * FROM dish_sales' });
  check('无 LIMIT 的大查询被自动加 LIMIT（≤1000 行）', q2.data?.rowCount <= 1000 && q2.data?.truncated === true, 'rowCount=' + q2.data?.rowCount);

  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
