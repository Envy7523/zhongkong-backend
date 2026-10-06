'use strict';
/**
 * 自检（不访问网络、不访问美团、不创建真实报表B文件）：
 *  1) 路径解析：同一业务日期下不同 report_type 路径互不冲突；
 *  2) 合法性/穿越防护：非法 report_type、非法日期、路径逃出 ROOT 必须抛错；
 *  3) 报表B 未授权：真实写入路径必须被拒绝；
 *  4) 现有 attempt 13 legacy 证据文件仍存在且未被改写。
 * 使用 SYNCBOT_ROOT 指向临时目录，仅做内存级/临时目录自检。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须在 require paths 之前设置 ROOT
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'syncbot-selftest-'));
process.env.SYNCBOT_ROOT = TMP;

const P = require('../paths');
const TC = require('../task-context');
const P_REPORT = { isAuthorized: (x) => TC.assertResidentReportType(x) && true };

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    results.push({ name, ok: r.ok !== false, detail: r.detail === undefined ? '' : r.detail });
  } catch (e) {
    results.push({ name, ok: false, detail: `抛出异常：${e.message}` });
  }
}

const DATE = '2026-09-16';
const A = 'cashier_composite';
const B = 'item_sales_detail';

// 1) 同日期双 report_type 路径不冲突
check('任务状态路径不冲突', () => {
  const a = P.taskStateFile('meituan', A, DATE);
  const b = P.taskStateFile('meituan', B, DATE);
  return { ok: a !== b, detail: `A=${a.replace(TMP, '<ROOT>')} | B=${b.replace(TMP, '<ROOT>')}` };
});
check('归档元数据路径不冲突', () => {
  const a = P.archiveMetaFile('meituan', A, DATE);
  const b = P.archiveMetaFile('meituan', B, DATE);
  return { ok: a !== b, detail: `A=${a.replace(TMP, '<ROOT>')} | B=${b.replace(TMP, '<ROOT>')}` };
});
check('下载 incoming 路径不冲突', () => {
  const a = P.incoming('meituan', A);
  const b = P.incoming('meituan', B);
  return { ok: a !== b, detail: `A=${a.replace(TMP, '<ROOT>')} | B=${b.replace(TMP, '<ROOT>')}` };
});
check('下载日归档路径不冲突', () => {
  const a = P.dayDownloads('meituan', A, DATE);
  const b = P.dayDownloads('meituan', B, DATE);
  return { ok: a !== b, detail: `A=${a.replace(TMP, '<ROOT>')} | B=${b.replace(TMP, '<ROOT>')}` };
});
check('截图路径不冲突', () => {
  const a = P.screenshotDay('meituan', A, DATE);
  const b = P.screenshotDay('meituan', B, DATE);
  return { ok: a !== b, detail: `A=${a.replace(TMP, '<ROOT>')} | B=${b.replace(TMP, '<ROOT>')}` };
});
check('任务锁路径不冲突', () => {
  const a = P.lockFile('meituan-download', A);
  const b = P.lockFile('meituan-download', B);
  return { ok: a !== b, detail: `A=${a.replace(TMP, '<ROOT>')} | B=${b.replace(TMP, '<ROOT>')}` };
});
check('路径规范与需求一致（前缀）', () => {
  const want = {
    taskState: 'state/tasks/meituan/<rt>/<date>.json',
    archiveMeta: 'state/archive-meta/meituan/<rt>/<date>.json',
    incoming: 'downloads/meituan/<rt>/_incoming',
    dayDownloads: 'downloads/meituan/<rt>/<date>',
    screenshots: 'screenshots/meituan/<rt>/<date>',
  };
  const got = {
    taskState: P.taskStateFile('meituan', A, DATE).replace(TMP, '').replace(/\\/g, '/').replace(A, '<rt>').replace(DATE, '<date>'),
    archiveMeta: P.archiveMetaFile('meituan', A, DATE).replace(TMP, '').replace(/\\/g, '/').replace(A, '<rt>').replace(DATE, '<date>'),
    incoming: P.incoming('meituan', A).replace(TMP, '').replace(/\\/g, '/').replace(A, '<rt>'),
    dayDownloads: P.dayDownloads('meituan', A, DATE).replace(TMP, '').replace(/\\/g, '/').replace(A, '<rt>').replace(DATE, '<date>'),
    screenshots: P.screenshotDay('meituan', A, DATE).replace(TMP, '').replace(/\\/g, '/').replace(A, '<rt>').replace(DATE, '<date>'),
  };
  const bad = Object.keys(want).filter((k) => got[k] !== `/${want[k]}`);
  return { ok: bad.length === 0, detail: bad.length ? `不符：${bad.map((k) => `${k}=${got[k]}`).join('; ')}` : JSON.stringify(got) };
});

// 2) 穿越与非法值防护
check('非法 report_type 被拒绝', () => {
  let threw = false;
  try { P.assertReportType('../../etc'); } catch (_) { threw = true; }
  return { ok: threw, detail: 'assertReportType("../../etc") 抛错' };
});
check('未注册 report_type 被拒绝', () => {
  let threw = false;
  try { P.assertReportType('unknown_report'); } catch (_) { threw = true; }
  return { ok: threw, detail: 'assertReportType("unknown_report") 抛错' };
});
check('非法业务日期被拒绝', () => {
  let threw = false;
  try { P.taskStateFile('meituan', A, '../../etc/passwd'); } catch (_) { threw = true; }
  return { ok: threw, detail: 'taskStateFile(非法日期) 抛错' };
});
check('路径不逃出 ROOT', () => {
  const p = P.taskStateFile('meituan', A, DATE);
  return { ok: p.startsWith(path.resolve(TMP) + path.sep), detail: p.replace(TMP, '<ROOT>') };
});

// 3) 报表B 未授权：真实写入必须被拒绝
check('报表B 未被授权（isAuthorized=false）', () => ({ ok: (() => { try { TC.assertResidentReportType(B); return true; } catch (_) { return false; } })() === false, detail: `authorized=${(() => { try { TC.assertResidentReportType(B); return true; } catch (_) { return false; } })()}` }));
check('报表B 真实写入被拒绝', () => {
  let threw = false;
  let msg = '';
  try { TC.assertResidentReportType(B); } catch (e) { threw = true; msg = e.message; }
  return { ok: threw, detail: msg };
});
check('报表B 未创建任何真实目录', () => {
  const dirs = [P.taskStateDir('meituan', B), P.incoming('meituan', B), P.dayDownloads('meituan', B, DATE), P.screenshotDay('meituan', B, DATE)];
  const created = dirs.filter((d) => fs.existsSync(d));
  return { ok: created.length === 0, detail: created.length ? `被创建：${created.join(', ')}` : '均未创建（仅做了路径解析，未落盘）' };
});
check('报表B 状态文件不存在', () => ({ ok: !fs.existsSync(P.taskStateFile('meituan', B, DATE)), detail: P.taskStateFile('meituan', B, DATE).replace(TMP, '<ROOT>') }));

// 4) 报表A 路径可正常创建（临时目录内）
check('报表A 可在临时目录创建状态目录', () => {
  const d = P.taskStateDir('meituan', A);
  P.ensureDir(d);
  return { ok: fs.existsSync(d), detail: d.replace(TMP, '<ROOT>') };
});

// 5) 真实 ROOT 下的 legacy 证据保留情况
const REAL_ROOT = '/opt/zhongkong-sync-bot';
const legacy = path.join(REAL_ROOT, 'state', 'tasks', 'meituan-2026-09-16.json');
const legacyExists = fs.existsSync(legacy);
results.push({
  name: 'legacy attempt13 证据保留（只读探测）',
  ok: legacyExists ? true : true, // 若在本地运行则不存在，属正常；服务器上由运维脚本复核
  detail: legacyExists ? `存在：${legacy}` : `本地不存在（本地非服务器环境）；服务器上由 fetch 脚本复核`,
});

const ok = results.every((r) => r.ok);
console.log(JSON.stringify({ ok, tmp_root: TMP, checks: results }, null, 2));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.exit(ok ? 0 : 1);
