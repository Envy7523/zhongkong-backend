'use strict';
/**
 * 日志隔离自检（只读 / 临时目录；不访问美团、不启动 dry-run、不点击导出、不下载、不导入、不推送）
 *
 * 验证项：
 *  1) 任务日志每条都有 report_type="cashier_composite"，且 platform/task_id/business_date 齐备；
 *  2) 系统日志每条都有 report_type="_system"（绝不为 undefined）；
 *  3) A/B 同一业务日期的模拟日志可按 report_type + task_id 区分；
 *  4) 非法/未授权 report_type 被拒绝，且不创建任何真实目录/文件；
 *  5) 旧 attempt 13 证据文件、旧日志、历史人工下载审计（**基线对比**，含第 4 条真实下载记录）
 *     均未被删除/覆盖/迁移。**不得硬编码历史行数**：改为测试开始时采集基线，
 *     结束时断言本测试没有改变基线。
 *
 * 运行：node src/phase2/selftest-log-isolation.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const AB = require('./audit-baseline');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'syncbot-logtest-'));
process.env.SYNCBOT_ROOT = TMP;

const P = require('../paths');
const { createTaskLogger, createSystemLogger, SYSTEM_REPORT_TYPE } = require('../logger');

const results = [];
const ck = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

// 真实 ROOT 下载审计的**测试前基线**：必须在任何 logger 写入之前采集。
// 用基线对比代替硬编码行数（历史含真实下载记录，行数会自然增长）。
const REAL_AUDIT_ABS = '/opt/zhongkong-sync-bot/state/downloads-meituan.jsonl';
const AUDIT_BASELINE = AB.snapshot(REAL_AUDIT_ABS);

const DATE = '2026-09-16';
const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const flush = () => new Promise((r) => setTimeout(r, 250)); // 等待 createWriteStream 落盘

(async () => {
// ---- 1) 任务 logger：显式 report_type，每条日志字段齐备 ----
let taskLog = null;
try {
  const lg = createTaskLogger('phase2-dryrun', { reportType: 'cashier_composite', platform: 'meituan', taskId: 'dry-selftestA', businessDate: DATE });
  lg.info('selftest_event_1', { note: 'normal' });
  lg.warn('selftest_event_2', { cookie: 'SHOULD_BE_REDACTED', token: 'SHOULD_BE_REDACTED' });
  lg.step('selftest_event_3', { business_date: DATE });
  const childLg = lg.child('phase2-dryrun-child');
  childLg.info('selftest_event_child', {});
  await flush();
  taskLog = lg.file;
  const lines = readLines(taskLog);
  const allHave = lines.every((r) => r.report_type === 'cashier_composite');
  const allMeta = lines.every((r) => r.platform === 'meituan' && typeof r.task_id === 'string' && r.task_id.length > 0 && r.business_date === DATE);
  const noUndef = lines.every((r) => r.report_type !== undefined && r.report_type !== null);
  ck('1a 任务日志每条 report_type=cashier_composite', allHave, `lines=${lines.length}`);
  ck('1b 任务日志含 platform/task_id/business_date', allMeta, JSON.stringify(Object.keys(lines[0] || {})));
  ck('1c 任务日志 report_type 非 undefined/null', noUndef, '');
  const childLines = readLines(childLg.file);
  ck('1d child logger 沿用同一 report_type 与 task_id', childLines.some((r) => r.event === 'selftest_event_child' && r.report_type === 'cashier_composite' && r.task_id === 'dry-selftestA' && r.business_date === DATE), `child channel file lines=${childLines.length}`);
  const redacted = JSON.stringify(lines.find((r) => r.event === 'selftest_event_2') || {});
  ck('1e 敏感字段被脱敏（cookie/token）', !/SHOULD_BE_REDACTED/.test(redacted), redacted.slice(0, 160));
} catch (e) {
  ck('1 任务 logger 创建/写入', false, e.message);
}

// ---- 2) 系统 logger：_system，绝不为 undefined ----
try {
  const sl = createSystemLogger('syncbot-browser', { platform: 'meituan' });
  sl.info('system_event_1', {});
  sl.error('system_event_2', { reason: 'x' });
  await flush();
  const lines = readLines(sl.file);
  const allSys = lines.every((r) => r.report_type === SYSTEM_REPORT_TYPE);
  const noneUndef = lines.every((r) => r.report_type !== undefined && r.report_type !== null && r.report_type !== '');
  ck('2a 系统日志每条 report_type="_system"', allSys, `lines=${lines.length}`);
  ck('2b 系统日志 report_type 非 undefined/空', noneUndef, JSON.stringify(lines.map((r) => r.report_type)));
} catch (e) {
  ck('2 系统 logger 创建/写入', false, e.message);
}

// ---- 3) A/B 同日期模拟日志可按 report_type + task_id 区分（B 用纯内存构造，不落盘）----
try {
  const lgA = createTaskLogger('phase2-dryrun', { reportType: 'cashier_composite', platform: 'meituan', taskId: 'dry-A', businessDate: DATE });
  lgA.info('same_day_probe', { who: 'A' });
  await flush();
  const recB = { ts: new Date().toISOString(), level: 'info', channel: 'phase2-dryrun', report_type: 'item_sales_detail', platform: 'meituan', task_id: 'dry-B', business_date: DATE, event: 'same_day_probe' };
  const linesA = readLines(lgA.file).filter((r) => r.event === 'same_day_probe');
  const keyOf = (r) => `${r.report_type}::${r.task_id}::${r.business_date}`;
  const distinct = linesA.length > 0 && keyOf(linesA[0]) !== keyOf(recB);
  ck('3 A/B 同日期日志可区分（report_type+task_id）', distinct, `${keyOf(linesA[0] || {})} vs ${keyOf(recB)}`);
} catch (e) {
  ck('3 A/B 区分', false, e.message);
}

// ---- 4) 非法 / 未授权 report_type 被拒绝，且不创建真实目录 ----
function expectThrow(fn) { try { fn(); return null; } catch (e) { return e.message; } }
const mIllegal = expectThrow(() => createTaskLogger('x', { reportType: '../../etc', taskId: 't1' }));
ck('4a 非法 report_type 被拒绝（任务 logger）', !!mIllegal, mIllegal || '未抛错');
const mUnknown = expectThrow(() => createTaskLogger('x', { reportType: 'unknown_report', taskId: 't1' }));
ck('4b 未注册 report_type 被拒绝（任务 logger）', !!mUnknown, mUnknown || '未抛错');
const mUnauth = expectThrow(() => createTaskLogger('x', { reportType: 'item_sales_detail', taskId: 'dry-B' }));
ck('4c 未授权 item_sales_detail 被拒绝（任务 logger）', !!mUnauth, mUnauth || '未抛错');
const mMissing = expectThrow(() => createTaskLogger('x', { taskId: 't1' }));
ck('4d 未传 report_type 被拒绝（禁止推断）', !!mMissing, mMissing || '未抛错');
const dirsB = [P.taskStateFile('meituan', 'item_sales_detail', DATE), P.incoming('meituan', 'item_sales_detail'), P.dayDownloads('meituan', 'item_sales_detail', DATE), P.screenshotDay('meituan', 'item_sales_detail', DATE)];
ck('4e 报表B 未被创建任何文件/目录', dirsB.every((d) => !fs.existsSync(d)), dirsB.map((d) => d.replace(TMP, '<ROOT>')).join(' | '));
ck('4f 报表B 无状态文件', !fs.existsSync(P.taskStateFile('meituan', 'item_sales_detail', DATE)), '');

// ---- 5) 真实 ROOT 下历史证据只读快照（不得删除/覆盖/迁移）----
// 本地（非服务器）无 /opt/zhongkong-sync-bot 时跳过，避免误判；服务器上必须通过。
const REAL = '/opt/zhongkong-sync-bot';
const REAL_PRESENT = fs.existsSync(REAL);
const snap = (p) => { try { const st = fs.statSync(p); return { exists: true, size: st.size, mtime: st.mtime.toISOString(), ino: st.ino }; } catch { return { exists: false }; } };
if (!REAL_PRESENT) {
  ck('5 legacy 证据保留检查（本地无真实 ROOT，已跳过）', true, `skip: ${REAL} 不存在（本地环境）；服务器部署后必须通过`);
} else {
  const legacyTask = snap(path.join(REAL, 'state/tasks/meituan-2026-09-16.json'));
  const dlAudit = snap(path.join(REAL, 'state/downloads-meituan.jsonl'));
  ck('5a legacy attempt13 任务状态文件存在（只读）', legacyTask.exists, JSON.stringify(legacyTask));
  ck('5b 下载审计文件存在（只读）', dlAudit.exists, JSON.stringify(dlAudit));
  let dlLines = null;
  try { dlLines = fs.readFileSync(path.join(REAL, 'state/downloads-meituan.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch (_) {}
  // 5c 基线对比（不硬编码行数）：测试前后逐字节一致 + 历史真实下载记录逐字保留
  const auditVerify = AB.verifyUnchanged(AUDIT_BASELINE, AB.snapshot(REAL_AUDIT_ABS));
  ck('5c 下载审计在本测试前后逐字节不变（基线对比，不硬编码行数=3）',
    auditVerify.ok, AB.summarize(auditVerify) + ` readback=${dlLines}`);
  ck('5c2 本次测试未向真实审计文件追加/删除任何记录',
    auditVerify.before && auditVerify.after && auditVerify.before.lines === auditVerify.after.lines,
    auditVerify.before && auditVerify.after ? `before=${auditVerify.before.lines} (readback=${dlLines}) after=${auditVerify.after.lines}` : 'snapshot_fail');
  ck('5c3 历史真实下载审计记录仍在（基线末条逐字保留，未删除/未改写）',
    auditVerify.tail_preserved, `baseline_tail=${auditVerify.tail_event || 'n/a'}`);
  let logCount = null;
  try { logCount = fs.readdirSync(path.join(REAL, 'logs')).filter((f) => f.endsWith('.log')).length; } catch (_) {}
  ck('5d 旧日志文件仍在（只读计数）', logCount !== null && logCount > 0, `logs/*.log = ${logCount}`);
  let legacyState = null;
  try { legacyState = JSON.parse(fs.readFileSync(path.join(REAL, 'state/tasks/meituan-2026-09-16.json'), 'utf8')).phase2; } catch (_) {}
  ck('5e legacy 内容未被改写（仍为 attempt 13 / DRY_RUN_DONE）', !!legacyState && legacyState.state === 'DRY_RUN_DONE' && legacyState.attempt === 13, legacyState ? `state=${legacyState.state} attempt=${legacyState.attempt} task=${legacyState.task_id}` : 'read_fail');
}

const ok = results.every((r) => r.ok);
console.log(JSON.stringify({ ok, tmp_root: TMP, checks: results }, null, 2));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.exit(ok ? 0 : 1);
})();
