'use strict';
/**
 * 统一路径定义。所有目录都位于 /opt/zhongkong-sync-bot 之下，
 * 与现有中控项目（/home/ubuntu/app）完全分离。
 * 可用环境变量 SYNCBOT_ROOT 覆盖（自检/测试用）。
 *
 * 双报表架构（2026-09-18 起）：
 *  - 共享：浏览器 Profile、日志根目录、状态根目录、锁根目录、调度框架；
 *  - 按 report_type 隔离：任务状态、归档元数据、下载目录、截图目录。
 *  - 所有 report_type 必须来自已授权的 report_registry，且禁止路径穿越。
 */
const path = require('path');

const ROOT = process.env.SYNCBOT_ROOT || '/opt/zhongkong-sync-bot';
const reviewNamespace = process.env.SYNCBOT_BOOKKEEPING_REVIEW_NAMESPACE || '';
if (reviewNamespace && !/^[A-Za-z0-9._-]{3,80}$/.test(reviewNamespace)) throw new Error('review_namespace_invalid');

// ===== report_type 校验与注册表 =====
// key -> { authorized }；B 默认锁定，仅独立手工补齐进程显式启用；计划调度仍独立锁定。
const REPORT_TYPES = {
  cashier_composite: { authorized: true, name: '综合营业统计', report: 'A', display: 'A_综合营业统计' },
  item_sales_detail: { get authorized() { return process.env.SYNCBOT_REPORT_B_MANUAL_CATCHUP === '1' || process.env.SYNCBOT_REPORT_B_SCHEDULED === '1'; }, name: '品项销售明细', report: 'B', display: 'B_品项销售明细' },
  // C 仅在专用入口明确置位后启用；默认锁定，不影响 A/B。
  pos_bookkeeping_daily: { get authorized() { return process.env.SYNCBOT_REPORT_C_MANUAL_CATCHUP === '1' || process.env.SYNCBOT_REPORT_C_SCHEDULED === '1'; }, name: '门店收支统计', report: 'C', display: 'C_门店收支统计' },
  meituan_delivery_operating: { authorized: true, name: '美团外卖营业表', report: 'M1', display: 'M1_美团外卖营业表' },
};
const DEFAULT_REPORT_TYPE = 'cashier_composite';

class PathSafetyError extends Error {}

/** report_type 合法化：必须已注册、不合法即抛错；并做路径穿越防护 */
function assertReportType(reportType) {
  const rt = String(reportType === undefined || reportType === null || reportType === '' ? DEFAULT_REPORT_TYPE : reportType);
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(rt)) {
    throw new PathSafetyError(`非法 report_type「${rt}」：仅允许小写字母/数字/下划线（防路径穿越）`);
  }
  if (!Object.prototype.hasOwnProperty.call(REPORT_TYPES, rt)) {
    throw new PathSafetyError(`未注册的 report_type「${rt}」：必须来自已启用的 report_registry`);
  }
  return rt;
}

/** 业务日期合法化（防止 ../../ 穿越） */
function assertBusinessDate(businessDate) {
  const bd = String(businessDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bd)) {
    throw new PathSafetyError(`非法业务日期「${bd}」：必须为 YYYY-MM-DD（防路径穿越）`);
  }
  return bd;
}

/** 最终兜底：所有生成路径必须仍在 ROOT 之下 */
function assertInsideRoot(p) {
  const resolved = path.resolve(p);
  const rootResolved = path.resolve(ROOT);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new PathSafetyError(`路径逃出 SYNCBOT_ROOT：${resolved}`);
  }
  return resolved;
}

const P = {
  root: ROOT,
  app: path.join(ROOT, 'app'),
  browserProfiles: path.join(ROOT, 'browser-profiles'),
  downloads: path.join(ROOT, 'downloads'),
  screenshots: path.join(ROOT, 'screenshots'),
  logs: path.join(ROOT, 'logs'),
  state: path.join(ROOT, 'state'),
  config: path.join(ROOT, 'config'),

  /** 防并发锁目录（锁文件名内含 report_type） */
  locks: path.join(ROOT, 'state', 'locks'),
  /** 任务状态根目录（按 report_type / 业务日期 分层） */
  tasks: path.join(ROOT, 'state', 'tasks'),
  /** 归档元数据根目录（按 report_type / 业务日期 分层） */
  archiveMeta: path.join(ROOT, 'state', 'archive-meta'),
  /** 浏览器运行态信息（pid / 启动时间） */
  runtime: path.join(ROOT, 'state', 'runtime'),
  /** 阶段1 样本只读留档清单 */
  samples: path.join(ROOT, 'state', 'samples'),
  /** VNC 口令、X11 xauth cookie 等运行凭据（0600，不入库、不打日志） */
  secrets: path.join(ROOT, 'state', 'secrets'),

  REPORT_TYPES,
  DEFAULT_REPORT_TYPE,
  PathSafetyError,
  assertReportType,
  assertBusinessDate,
  assertInsideRoot,

  profile(platform) {
    return path.join(ROOT, 'browser-profiles', platform);
  },
  /** 平台下载根目录：downloads/<platform>/ */
  platformDownloads(platform) {
    return path.join(ROOT, 'downloads', platform);
  },
  /** 报表级下载根目录：downloads/<platform>/<report_type>/ */
  reportDownloads(platform, reportType) {
    const rt = assertReportType(reportType);
    return assertInsideRoot(path.join(ROOT, 'downloads', platform, rt));
  },
  /** 报表级下载临时落地区：downloads/<platform>/<report_type>/_incoming/ */
  incoming(platform, reportType) {
    const rt = assertReportType(reportType);
    return assertInsideRoot(path.join(ROOT, 'downloads', platform, rt, '_incoming'));
  },
  /** 某一业务日期的归档目录：downloads/<platform>/<report_type>/<YYYY-MM-DD>/ */
  dayDownloads(platform, reportType, businessDate) {
    const rt = assertReportType(reportType);
    const bd = assertBusinessDate(businessDate);
    return assertInsideRoot(path.join(ROOT, 'downloads', platform, rt, bd));
  },
  /** 任务状态文件：state/tasks/<platform>/<report_type>/<YYYY-MM-DD>.json */
  taskStateFile(platform, reportType, businessDate) {
    const rt = assertReportType(reportType);
    const bd = assertBusinessDate(businessDate);
    return assertInsideRoot(path.join(ROOT, 'state', 'tasks', ...(reviewNamespace && rt === 'pos_bookkeeping_daily' ? ['reviews', reviewNamespace] : []), platform, rt, `${bd}.json`));
  },
  /** 任务状态目录：state/tasks/<platform>/<report_type>/ */
  taskStateDir(platform, reportType) {
    const rt = assertReportType(reportType);
    return assertInsideRoot(path.join(ROOT, 'state', 'tasks', ...(reviewNamespace && rt === 'pos_bookkeeping_daily' ? ['reviews', reviewNamespace] : []), platform, rt));
  },
  /** 归档元数据文件：state/archive-meta/<platform>/<report_type>/<YYYY-MM-DD>.json */
  archiveMetaFile(platform, reportType, businessDate) {
    const rt = assertReportType(reportType);
    const bd = assertBusinessDate(businessDate);
    return assertInsideRoot(path.join(ROOT, 'state', 'archive-meta', ...(reviewNamespace && rt === 'pos_bookkeeping_daily' ? ['reviews', reviewNamespace] : []), platform, rt, `${bd}.json`));
  },
  /** 截图目录：screenshots/<platform>/<report_type>/<YYYY-MM-DD>/ */
  screenshotDay(platform, reportType, businessDate) {
    const rt = assertReportType(reportType);
    const bd = assertBusinessDate(businessDate);
    return assertInsideRoot(path.join(ROOT, 'screenshots', platform, rt, bd));
  },
  /** 锁文件名：含 report_type（任务锁、人工会话锁各自独立） */
  lockFile(name, reportType) {
    const rt = assertReportType(reportType);
    const safe = String(name).replace(/[^A-Za-z0-9_.-]/g, '_');
    return assertInsideRoot(path.join(ROOT, 'state', 'locks', `${safe}.${rt}.lock`));
  },
};

/** 确保目录存在（权限由安装脚本统一设定，这里不 chmod） */
function ensureDir(dir) {
  require('fs').mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = Object.assign(P, { ensureDir, ROOT });
