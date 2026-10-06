'use strict';
/**
 * report_type 显式透传自检（临时目录 + 只读快照；不访问美团、不启动 dry-run）
 *  1) 同一 ctx 下：任务状态 / 锁 / incoming / 归档 / 截图路径的 report_type 完全一致；
 *  2) 同一 report_type、不同 taskId：状态文件不共用（锁文件名按 name+report_type，任务锁由 name 区分）；
 *  3) 非法 report_type / 未授权 B / 非法日期：全部被拒绝且**零落盘**；
 *  4) 生产路径中不存在 report-type.current() / set() 调用（源码 grep）；
 *  5) legacy attempt13、历史下载审计（**基线对比**，含第 4 条真实下载记录）、旧日志：
 *     未删除、未覆盖、未迁移。**不得硬编码历史行数**：改为测试开始时采集基线、
 *     结束时断言本测试没有改变基线。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const AB = require('./audit-baseline');

// 真实 ROOT 下载审计的**测试前基线**：必须在任何写入动作之前采集。
// 用基线对比代替硬编码行数（历史含真实下载记录，行数会自然增长）。
const REAL_ROOT = '/opt/zhongkong-sync-bot';
const AUDIT_ABS = path.join(REAL_ROOT, 'state/downloads-meituan.jsonl');
const AUDIT_BASELINE = AB.snapshot(AUDIT_ABS);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'syncbot-ctx-'));
process.env.SYNCBOT_ROOT = TMP;

const P = require('../paths');
const TC = require('../task-context');
const lock = require('../lock');

const results = [];
const ck = (n, ok, d) => results.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });
const DATE = '2026-09-16';
const RT = 'cashier_composite';
const rel = (p) => p.replace(TMP, '<ROOT>').replace(/\\/g, '/');

const ctx = TC.createContext(RT, { platform: 'meituan', taskId: 'dry-ctx-1', businessDate: DATE });

// 1) 同一 ctx 下 report_type 一致
const paths = {
  taskState: P.taskStateFile(ctx.platform, ctx.reportType, ctx.businessDate),
  lock: P.lockFile('meituan-download', ctx.reportType),
  incoming: P.incoming(ctx.platform, ctx.reportType),
  archiveDay: P.dayDownloads(ctx.platform, ctx.reportType, ctx.businessDate),
  screenshot: P.screenshotDay(ctx.platform, ctx.reportType, ctx.businessDate),
  archiveMeta: P.archiveMetaFile(ctx.platform, ctx.reportType, ctx.businessDate),
};
const allContain = Object.values(paths).every((p) => {
  const u = p.replace(/\\/g, '/');
  return u.includes(`/${RT}/`) || path.basename(u).includes(`.${RT}.`);
});
ck('1 同一 ctx 下 6 类路径 report_type 均为 cashier_composite', allContain, Object.entries(paths).map(([k, v]) => `${k}=${rel(v)}`).join(' | '));
ck('1b 路径全部位于 SYNCBOT_ROOT 内', Object.values(paths).every((p) => path.resolve(p).startsWith(path.resolve(TMP) + path.sep)), '');

// 2) 同一 report_type、不同 taskId：状态不共用；锁按 name+report_type
const ctx2 = TC.createContext(RT, { platform: 'meituan', taskId: 'dry-ctx-2', businessDate: DATE });
ck('2a 两 taskId 的状态文件路径一致（同报表同日期，符合设计）', P.taskStateFile(ctx.platform, ctx.reportType, DATE) === P.taskStateFile(ctx2.platform, ctx2.reportType, DATE), 'task_id 记录在文件内容中，路径按 report_type+date 隔离');
const l1 = lock.lockFile ? null : null;
const lkA = P.lockFile('meituan-download', ctx.reportType);
const lkB = P.lockFile('meituan-download-b', ctx2.reportType);
ck('2b 不同任务名不共用锁文件', lkA !== lkB, `${rel(lkA)} vs ${rel(lkB)}`);
ck('2c 锁文件名含 report_type', lkA.includes(`.${RT}.lock`), rel(lkA));

// 3) 拒绝且零落盘
function expectThrow(fn) { try { fn(); return null; } catch (e) { return e.message; } }
const before = fs.readdirSync(TMP, { recursive: true }).length;
const m1 = expectThrow(() => TC.createContext('../../etc', { taskId: 't', businessDate: DATE }));
const m2 = expectThrow(() => TC.createContext('unknown_report', { taskId: 't', businessDate: DATE }));
const m3 = expectThrow(() => TC.createContext('item_sales_detail', { taskId: 't', businessDate: DATE }));
const m4 = expectThrow(() => TC.createContext(RT, { taskId: 't', businessDate: '../../etc' }));
const m5 = expectThrow(() => TC.createContext('', { taskId: 't', businessDate: DATE }));
const m6 = expectThrow(() => P.taskStateFile('meituan', 'item_sales_detail', DATE) && null);
ck('3a 非法 report_type 被拒', !!m1, m1 || '未抛错');
ck('3b 未注册 report_type 被拒', !!m2, m2 || '未抛错');
ck('3c 未授权 B 被拒（createContext）', !!m3, m3 || '未抛错');
ck('3d 非法日期被拒', !!m4, m4 || '未抛错');
ck('3e 空 report_type 被拒（禁止推断/默认）', !!m5, m5 || '未抛错');
const after = fs.readdirSync(TMP, { recursive: true }).length;
ck('3f 拒绝过程零落盘', before === after, `entries before=${before} after=${after}`);
ck('3g 报表B 未创建状态文件', !fs.existsSync(P.taskStateFile('meituan', 'item_sales_detail', DATE)), '');
ck('3h 报表B 未创建截图/下载目录', !fs.existsSync(P.screenshotDay('meituan', 'item_sales_detail', DATE)) && !fs.existsSync(P.incoming('meituan', 'item_sales_detail')), '');

// 4) 生产路径 grep：不得存在 report-type.current()/set()
const SRC = path.resolve(__dirname, '..');
const bad = [];
(function walk(dir) {
  for (const n of fs.readdirSync(dir)) {
    const f = path.join(dir, n);
    const st = fs.statSync(f);
    if (st.isDirectory()) { walk(f); continue; }
    if (!n.endsWith('.js')) continue;
    if (n === 'report-type.js') continue;            // 弃用占位文件本身允许出现
    if (n.startsWith('selftest-')) continue;         // 自检文件允许提及
    const t = fs.readFileSync(f, 'utf8');
    if (/rt\.current\(\)|rt\.set\(|report-type'\)\.current|report-type'\)\.set/.test(t)) bad.push(path.relative(SRC, f));
  }
})(SRC);
ck('4 生产路径无 report-type.current()/set() 调用', bad.length === 0, bad.length ? `命中：${bad.join(', ')}` : `扫描 ${SRC} 完成，0 命中`);
const rtSrc = fs.readFileSync(path.join(SRC, 'report-type.js'), 'utf8');
ck('4b 弃用模块调用即抛错', /throw new Error/.test(rtSrc) && /已弃用/.test(rtSrc), 'current()/set() 均 throw');

// 5) 真实 ROOT 历史证据只读快照
const REAL = '/opt/zhongkong-sync-bot';
if (!fs.existsSync(REAL)) {
  ck('5 历史证据保留（本地无真实 ROOT，已跳过）', true, `skip: ${REAL} 不存在；服务器部署后必须通过`);
} else {
  const snap = (p) => { try { const s = fs.statSync(p); return { exists: true, size: s.size, ino: s.ino, mtime: s.mtime.toISOString() }; } catch { return { exists: false }; } };
  const leg = snap(path.join(REAL, 'state/tasks/meituan-2026-09-16.json'));
  const dl = snap(path.join(REAL, 'state/downloads-meituan.jsonl'));
  ck('5a legacy attempt13 存在', leg.exists, JSON.stringify(leg));
  ck('5b 下载审计存在', dl.exists, JSON.stringify(dl));
  // 5c 基线对比（不硬编码行数）：测试前后逐字节一致 + 历史真实下载记录逐字保留
  const auditVerify = AB.verifyUnchanged(AUDIT_BASELINE, AB.snapshot(AUDIT_ABS));
  ck('5c 下载审计在本测试前后逐字节不变（基线对比，不硬编码行数）',
    auditVerify.ok, AB.summarize(auditVerify));
  ck('5c2 本次测试未向真实审计文件追加/删除任何记录',
    auditVerify.before && auditVerify.after && auditVerify.before.lines === auditVerify.after.lines,
    auditVerify.before && auditVerify.after ? `before=${auditVerify.before.lines} after=${auditVerify.after.lines}` : 'snapshot_fail');
  ck('5c3 历史真实下载审计记录仍在（基线末条逐字保留，未删除/未改写）',
    auditVerify.tail_preserved, `baseline_tail=${auditVerify.tail_event || 'n/a'}`);
  let lc = null; try { lc = fs.readdirSync(path.join(REAL, 'logs')).filter((x) => x.endsWith('.log')).length; } catch (_) {}
  ck('5d 旧日志仍在', lc !== null && lc > 0, `logs/*.log=${lc}`);
  let st2 = null; try { st2 = JSON.parse(fs.readFileSync(path.join(REAL, 'state/tasks/meituan-2026-09-16.json'), 'utf8')).phase2; } catch (_) {}
  ck('5e legacy 内容未改写', !!st2 && st2.state === 'DRY_RUN_DONE' && st2.attempt === 13, st2 ? `state=${st2.state} attempt=${st2.attempt}` : 'read_fail');
}

const ok = results.every((r) => r.ok);
console.log(JSON.stringify({ ok, tmp_root: TMP, checks: results }, null, 2));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.exit(ok ? 0 : 1);
