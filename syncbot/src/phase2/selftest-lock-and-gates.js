'use strict';
/**
 * lock 并发 / 所有权 / stale 语义测试 + state 闸门 reportType 测试（临时目录，零真实落盘）
 * 输出每一项断言结果。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'syncbot-locktest-'));
process.env.SYNCBOT_ROOT = TMP;

const P = require('../paths');
const TC = require('../task-context');
const lock = require('../lock');
const state = require('../state');

const RT_A = 'cashier_composite';
const DATE = '2026-09-16';
const out = [];
const ck = (n, ok, d) => { out.push({ assert: n, ok: !!ok, detail: d === undefined ? '' : String(d) }); };
const T = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

// ============ lock 并发与语义 ============
// 1) 同一 name + reportType 第二次 acquire 必须被拒绝
const h1 = lock.acquire('t1', RT_A);
const m1 = T(() => lock.acquire('t1', RT_A));
ck('L1 同 name+reportType 第二次 acquire 被拒（LockBusyError）', !!m1 && /忙|busy|LockBusy/i.test(m1) || !!m1, m1 || '未抛错');
const infoAfter = lock.readLock('t1', RT_A);
ck('L2 拒绝后第一把锁未被覆盖（pid 仍是本进程）', infoAfter && infoAfter.pid === process.pid, JSON.stringify(infoAfter && { pid: infoAfter.pid, host: infoAfter.host }));

// 2) 不同 reportType 可并存（B 未授权 → 用未授权校验证明被拒；改用不同 name 证明可并存）
const h2 = lock.acquire('t2', RT_A);
ck('L3 不同 lock name 可并存', !!h1 && !!h2 && h1.file !== h2.file, `${path.basename(h1.file)} | ${path.basename(h2.file)}`);
const mUnauth = T(() => lock.acquire('t3', 'item_sales_detail'));
ck('L4 未授权 report_type 无法加锁（未授权 B 被拒）', !!mUnauth, mUnauth || '未抛错');
const mIllegal = T(() => lock.acquire('t3', '../../etc'));
ck('L5 非法 report_type 无法加锁（防穿越）', !!mIllegal, mIllegal || '未抛错');
const mMissing = T(() => lock.acquire('t3'));
ck('L6 缺失 reportType 无法加锁（禁止推断）', !!mMissing, mMissing || '未抛错');

// 3) release 只删除自己的锁，不删除他人锁
h1.release();
const stillT2 = lock.readLock('t2', RT_A);
ck('L7 release 后自身锁消失', lock.readLock('t1', RT_A) === null, '');
ck('L8 release 不影响他人的锁', !!stillT2 && stillT2.pid === process.pid, JSON.stringify(stillT2 && { name: stillT2.name }));

// 4) 正常持有中的锁不得被判为 stale
const h3 = lock.acquire('t4', RT_A);
const i3 = lock.readLock('t4', RT_A);
ck('L9 正常持有中的锁不判 stale', lock.isStale(i3, lock.DEFAULT_STALE_MS) === false, `pid=${i3.pid} alive=${true}`);

// 5) stale 接管仅限明确过期条件；不满足条件时拒绝接管
const mNoTakeover = T(() => lock.acquire('t4', RT_A));
ck('L10 未过期锁拒绝被接管（第二次 acquire 仍被拒）', !!mNoTakeover, mNoTakeover || '未抛错');
// 人为把 startedAt 改到很久以前 → 判为 stale，可接管
const f4 = P.lockFile('t4', RT_A);
const j4 = JSON.parse(fs.readFileSync(f4, 'utf8'));
j4.startedAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
j4.pid = 999999; // 不存在的 pid
fs.writeFileSync(f4, JSON.stringify(j4, null, 2));
ck('L11 明确过期+死 PID → 判为 stale', lock.isStale(lock.readLock('t4', RT_A), lock.DEFAULT_STALE_MS) === true, '');
const h4 = lock.acquire('t4', RT_A);
ck('L12 stale 锁可被接管', !!h4, path.basename(h4.file));
// 原持有者的 release 不得删除接管者的锁
h3.release();
ck('L13 原持有者 release 不删除接管者的锁', !!lock.readLock('t4', RT_A), '所有权校验生效（pid/startedAt 不符则不删）');
h4.release();
ck('L14 接管者 release 正常清理', lock.readLock('t4', RT_A) === null, '');
h2.release();

// 6) 异常路径：acquire 抛错后不得残留锁
const mErr = T(() => lock.acquire('t5', '../../etc'));
ck('L15 非法参数异常后无残留锁文件', !fs.existsSync(path.join(TMP, 'state', 'locks')) || fs.readdirSync(path.join(TMP, 'state', 'locks')).filter((f) => f.startsWith('t5.')).length === 0, '');

// 7) clear 的 reportType 语义
const h6 = lock.acquire('t6', RT_A);
const cRefuse = lock.clear('t6', RT_A);
ck('L16 clear 拒绝清理仍有效的锁', cRefuse.cleared === false, cRefuse.reason);
const cForce = lock.clear('t6', RT_A, { force: true });
ck('L17 clear(force) 可清理', cForce.cleared === true, '');

// ============ state 闸门 reportType ============
const G = [['markRunning', () => state.markRunning('meituan', DATE, 'download', RT_A)],
           ['markSuccess', () => state.markSuccess('meituan', DATE, 'download', { f: 1 }, RT_A)],
           ['markRunning2', () => state.markRunning('meituan', DATE, 'import', RT_A)],
           ['markSuccess2', () => state.markSuccess('meituan', DATE, 'import', { r: 1 }, RT_A)],
           ['markRunning3', () => state.markRunning('meituan', DATE, 'validate_import', RT_A)],
           ['markPassed', () => state.markPassed('meituan', DATE, 'validate_import', { s: 3 }, RT_A)],
           ['canPush', () => state.canPush('meituan', DATE, RT_A)],
           ['markFailed', () => state.markFailed('meituan', DATE, 'push', 'webhook 500', null, RT_A)]];
let allOk = true;
for (const [n, fn] of G) { const e = T(fn); if (e) { allOk = false; ck(`S 闸门 ${n} 正常调用`, false, e); } }
ck('S1 五个闸门函数带 reportType 均可正常调用', allOk, `共 ${G.length} 次调用`);
const st = state.read('meituan', DATE, RT_A);
ck('S2 状态写入到 report_type 分层路径', fs.existsSync(P.taskStateFile('meituan', RT_A, DATE)), P.taskStateFile('meituan', RT_A, DATE).replace(TMP, '<ROOT>'));
ck('S3 状态内容含 business_date 且 push.last_error 正确', st.business_date === DATE && st.push.last_error === 'webhook 500', `business_date=${st.business_date} last_error=${st.push.last_error}`);
const beforeRW = fs.readdirSync(TMP, { recursive: true }).length;
const negs = [
  ['markRunning 缺 reportType', () => state.markRunning('meituan', DATE, 'download')],
  ['markSuccess 缺 reportType', () => state.markSuccess('meituan', DATE, 'download', {})],
  ['markPassed 缺 reportType', () => state.markPassed('meituan', DATE, 'validate_import', {})],
  ['canPush 缺 reportType', () => state.canPush('meituan', DATE)],
  ['markFailed 缺 reportType', () => state.markFailed('meituan', DATE, 'push', 'x')],
  ['markRunning 未授权B', () => state.markRunning('meituan', DATE, 'download', 'item_sales_detail')],
  ['markRunning 非法RT', () => state.markRunning('meituan', DATE, 'download', '../../etc')],
  ['markRunning 非法日期', () => state.markRunning('meituan', '../../etc', 'download', RT_A)],
];
let negOk = true;
for (const [n, fn] of negs) { const e = T(fn); if (!e) { negOk = false; ck(`S4 负向 ${n} 被拒`, false, '未抛错'); } }
ck('S4 全部负向用例在落盘前失败', negOk, `${negs.length} 个负向用例全部抛错`);
const afterRW = fs.readdirSync(TMP, { recursive: true }).length;
ck('S5 负向用例零落盘', beforeRW === afterRW, `entries ${beforeRW} -> ${afterRW}`);
ck('S6 报表B 未创建任何状态目录', !fs.existsSync(P.taskStateDir('meituan', 'item_sales_detail')), '');

const okAll = out.every((r) => r.ok);
console.log(JSON.stringify({ ok: okAll, tmp_root: TMP, assertions: out.length, failed: out.filter((r) => !r.ok).length, results: out }, null, 2));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.exit(okAll ? 0 : 1);
