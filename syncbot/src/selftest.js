'use strict';

// 自检显式指定报表类型（禁止推断）
const RT = 'cashier_composite';
/**
 * 框架自检（不接触任何业务数据、不访问任何平台页面）：
 *   node src/selftest.js
 * 会在临时目录中验证：路径、日志脱敏、防并发锁（含残留锁）、任务状态闸门、
 * 文件归档（sha256/去重/不覆盖历史）、临时下载文件识别、保留策略预览。
 * 全部通过退出码 0，否则 1。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

// 自检使用独立的临时根目录，绝不污染 /opt/zhongkong-sync-bot
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'syncbot-selftest-'));
process.env.SYNCBOT_ROOT = TMP_ROOT;

const P = require('./paths');
const { createLogger } = require('./logger');
const lock = require('./lock');
const state = require('./state');
const archive = require('./archive');

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail === undefined ? 'ok' : detail });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

(async () => {
  const platform = 'selftest';
  const logger = createLogger('selftest');

  await check('1. 目录结构按 SYNCBOT_ROOT 生成', () => {
    for (const d of [P.downloads, P.screenshots, P.logs, P.state, P.locks, P.tasks, P.runtime, P.secrets]) P.ensureDir(d);
    assert(fs.existsSync(P.locks), 'locks 目录未创建');
    assert(P.locks.startsWith(TMP_ROOT), '未使用临时根目录');
    return `${TMP_ROOT} 下 ${[P.downloads, P.screenshots, P.logs, P.state].length} 个基础目录就绪`;
  });

  await check('2. 日志写入 + 敏感字段自动脱敏', async () => {
    logger.info('selftest.log_probe', {
      password: 'p@ssw0rd-should-not-appear',
      cookie: 'SESSIONID=abc123',
      token: 'sk-abcdefghijklmnop',
      url: 'https://example.com/x?token=zzz&a=1',
      normal: 'keep-me',
    });
    await logger.close();
    const raw = fs.readFileSync(logger.file, 'utf8');
    assert(!raw.includes('p@ssw0rd-should-not-appear'), 'password 未脱敏');
    assert(!raw.includes('abc123'), 'cookie 未脱敏');
    assert(!raw.includes('sk-abcdefghijklmnop'), 'token 未脱敏');
    assert(!raw.includes('token=zzz'), 'URL 中 token 未脱敏');
    assert(raw.includes('keep-me'), '普通字段被误删');
    return path.basename(logger.file);
  });

  await check('3. 防并发锁：第二次获取被拒绝，释放后可再次获取', () => {
    const h1 = lock.acquire('demo-task', RT);
    let rejected = false;
    try {
      lock.acquire('demo-task', RT);
    } catch (e) {
      rejected = e instanceof lock.LockBusyError;
    }
    assert(rejected, '并发未被拒绝');
    h1.release();
    const h2 = lock.acquire('demo-task', RT);
    h2.release();
    assert(!fs.existsSync(h2.file), '释放后锁文件仍存在');
    return '并发拒绝 + 正常释放通过';
  });

  await check('4. 残留锁识别：持有者 PID 不存在时自动接管', () => {
    P.ensureDir(P.locks);
    const f = path.join(P.locks, 'stale-task.lock');
    fs.writeFileSync(
      f,
      JSON.stringify({ name: 'stale-task', pid: 999999, host: os.hostname(), startedAt: new Date().toISOString() })
    );
    const info = lock.readLock('stale-task', RT);
    assert(lock.isStale(info, lock.DEFAULT_STALE_MS) === true, '未识别为残留锁');
    const h = lock.acquire('stale-task', RT);
    assert(h.name === 'stale-task', '接管失败');
    h.release();
    return '僵尸锁可自动接管';
  });

  await check('5. 任务状态闸门：import=success 且 validate=passed 才允许推送', () => {
    const d = '2026-09-16';
    state.markRunning(platform, d, 'download', RT);
    state.markSuccess(platform, d, 'download', { file: 'x.xlsx', size: 123 }, RT);
    state.markRunning(platform, d, 'import', RT);
    state.markSuccess(platform, d, 'import', { rows: 10 }, RT);
    let g = state.canPush(platform, d, RT);
    assert(g.ok === false && g.reasons.includes('validate_import=pending'), '校验未通过时不应允许推送');
    state.markRunning(platform, d, 'validate_import', RT);
    state.markPassed(platform, d, 'validate_import', { stores: 3 }, RT);
    g = state.canPush(platform, d, RT);
    assert(g.ok === true, '条件满足时应允许推送：' + g.reasons.join(','));
    assert(g.state.download.attempts === 1 && g.state.import.attempts === 1, 'attempts 计数异常');
    state.markFailed(platform, d, 'push', 'webhook 500', null, RT);
    assert(state.read(platform, d, RT).push.last_error === 'webhook 500', '失败原因未记录');
    return '状态机与推送闸门正确';
  });

  await check('6. 文件归档：统一命名 / sha256 / 重复文件识别 / 不覆盖历史', () => {
    const d = '2026-09-16';
    const inc = P.incoming(platform, 'cashier_composite');
    P.ensureDir(inc);
    const name = archive.canonicalName({ platformLabel: '美团管家', reportLabel: '指定报表', businessDate: d, ext: 'xlsx' });
    assert(name === '美团管家_指定报表_2026-09-16.xlsx', '统一命名不符合约定：' + name);

    const src = path.join(inc, 'raw-download.xlsx');
    fs.writeFileSync(src, 'fake-xlsx-content-1');
    const r1 = archive.archive({ srcFile: src, platform, reportType: RT, businessDate: d, fileName: name, move: true });
    assert(fs.existsSync(r1.file), '归档文件不存在');
    assert(r1.sha256.length === 64, 'sha256 异常');
    assert(!fs.existsSync(src), 'move=true 时临时文件应被移走');
    assert(archive.findDuplicate({ platform, reportType: RT, businessDate: d, sha256: r1.sha256 }) === r1.file, '去重查询失败');

    // 同名但内容不同 → 两份都保留
    const src2 = path.join(inc, 'raw-download-2.xlsx');
    fs.writeFileSync(src2, 'fake-xlsx-content-2-different');
    const r2 = archive.archive({ srcFile: src2, platform, reportType: RT, businessDate: d, fileName: name, move: true });
    assert(r2.file !== r1.file, '同名不同内容必须另存，不能覆盖历史文件');
    assert(fs.existsSync(r1.file) && fs.existsSync(r2.file), '历史文件被覆盖');
    return `${path.basename(r1.file)} + 变更版本 ${path.basename(r2.file)}`;
  });

  await check('7. 未完成下载识别（.crdownload 等）', () => {
    const inc = P.incoming(platform, 'cashier_composite');
    fs.writeFileSync(path.join(inc, 'x.xlsx.crdownload'), 'partial');
    const pending = archive.pendingTempFiles(inc);
    assert(pending.length === 1 && pending[0].endsWith('.crdownload'), '未识别临时文件：' + pending.join(','));
    fs.unlinkSync(path.join(inc, 'x.xlsx.crdownload'));
    assert(archive.pendingTempFiles(inc).length === 0, '清理后仍报临时文件');
    return '可正确等待下载完成';
  });

  await check('8. 保留策略预览（90 天，dry-run 不删除）', () => {
    const old = P.dayDownloads(platform, 'cashier_composite', '2020-01-01');
    P.ensureDir(old);
    fs.writeFileSync(path.join(old, 'old.xlsx'), 'old');
    const past = new Date(Date.now() - 200 * 86400000);
    fs.utimesSync(old, past, past);
    const plan = archive.cleanup({ platform, reportType: RT, days: 90, dryRun: true });
    assert(plan.length === 1, '未识别过期目录：' + JSON.stringify(plan));
    assert(fs.existsSync(old), 'dry-run 不应删除任何文件');
    return `待清理 1 个目录（${plan[0].files} 文件 / ${plan[0].bytes} 字节），未执行删除`;
  });

  const failed = results.filter((r) => !r.ok);
  console.log('\n================ 阶段0 框架自检 ================');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.ok ? '-> ' + r.detail : '-> ' + r.detail}`);
  console.log('------------------------------------------------');
  console.log(`结果：${results.length - failed.length}/${results.length} 通过`);
  console.log(`临时根目录：${TMP_ROOT}（自检结束将删除）`);
  console.log('SELFTEST_SUMMARY=' + JSON.stringify({ total: results.length, failed: failed.length, results }));

  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  process.exit(failed.length === 0 ? 0 : 1);
})();
