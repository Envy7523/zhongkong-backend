'use strict';
/**
 * 任务状态：每个业务日期一个 JSON 快照 state/tasks/<platform>-<YYYY-MM-DD>.json
 *
 * 状态字段对应最终流程的每一道闸门：
 *   download → validate_file → import → validate_import → push
 * 每一段都有 status（pending/running/success/failed/skipped）与证据字段，
 * 供「阶段5 定时任务」判断是否允许推送（必须 import=success 且 validate_import=passed）。
 */
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const TC = require('./task-context');

// workflow = 全链路总编排（阶段5）的持久化小节；与其余五段并列，同样参与文件级原子写。
const SECTIONS = ['download', 'validate_file', 'import', 'validate_import', 'push', 'workflow'];

function emptySection() {
  return { status: 'pending', attempts: 0, started_at: null, finished_at: null, last_error: null, evidence: null };
}

function emptyState(platform, businessDate) {
  const now = new Date().toISOString();
  return {
    platform,
    business_date: businessDate,
    created_at: now,
    updated_at: now,
    // 闸门汇总：只有 import=success 且 validate_import=passed 才把 ready_to_push 置 true
    ready_to_push: false,
    download: emptySection(),
    validate_file: emptySection(),
    import: emptySection(),
    validate_import: emptySection(),
    push: Object.assign(emptySection(), { stores: {} }),
  };
}

function stateFile(platform, businessDate, reportType) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new Error(`非法业务日期：${businessDate}`);
  // report_type 隔离：state/tasks/<platform>/<report_type>/<YYYY-MM-DD>.json
  const fs2 = P.taskStateFile(platform, reportType, businessDate);
  P.ensureDir(path.dirname(fs2));
  return fs2;
}

function read(platform, businessDate, reportType) {
  const file = stateFile(platform, businessDate, reportType);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return emptyState(platform, businessDate);
  }
}

function atomicWrite(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

/** 合并式更新某个阶段 */
function patch(platform, businessDate, section, patchData, { status, reportType } = {}) {
  if (!SECTIONS.includes(section)) throw new Error(`未知状态段：${section}`);
  // 落盘前先校验 report_type（缺失/非法/未授权即失败，不产生任何文件）
  TC.assertResidentReportType(reportType);
  const st = read(platform, businessDate, reportType);
  st[section] = Object.assign({}, st[section], patchData);
  if (status) st[section].status = status;
  st.ready_to_push = st.import.status === 'success' && st.validate_import.status === 'passed' && st.push.status !== 'success';
  st.updated_at = new Date().toISOString();
  atomicWrite(stateFile(platform, businessDate, reportType), st);
  return st;
}

function markRunning(platform, businessDate, section, reportType) {
  TC.assertResidentReportType(reportType);
  const cur = read(platform, businessDate, reportType)[section];
  return patch(
    platform,
    businessDate,
    section,
    { started_at: new Date().toISOString(), finished_at: null, last_error: null, attempts: (cur.attempts || 0) + 1 },
    { status: 'running', reportType }
  );
}

function markSuccess(platform, businessDate, section, evidence, reportType) {
  TC.assertResidentReportType(reportType);
  return patch(
    platform,
    businessDate,
    section,
    { finished_at: new Date().toISOString(), evidence: evidence === undefined ? null : evidence },
    { status: 'success', reportType }
  );
}

function markFailed(platform, businessDate, section, err, evidence, reportType) {
  TC.assertResidentReportType(reportType);
  return patch(
    platform,
    businessDate,
    section,
    {
      finished_at: new Date().toISOString(),
      last_error: typeof err === 'string' ? err : (err && err.message) || String(err),
      evidence: evidence === undefined ? null : evidence,
    },
    { status: 'failed', reportType }
  );
}

/** validate_* 段使用 passed/failed 语义 */
function markPassed(platform, businessDate, section, evidence, reportType) {
  TC.assertResidentReportType(reportType);
  return patch(platform, businessDate, section, { finished_at: new Date().toISOString(), evidence: evidence === undefined ? null : evidence }, { status: 'passed', reportType });
}

/** 列出最近 n 天状态 */
function recent(platform, n = 7) {
  if (!fs.existsSync(P.tasks)) return [];
  const files = fs
    .readdirSync(P.tasks)
    .filter((f) => f.startsWith(`${platform}-`) && f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, n);
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(P.tasks, f), 'utf8')));
}

/** 阶段5 用：判断某日期是否具备推送条件 */
function canPush(platform, businessDate, reportType) {
  TC.assertResidentReportType(reportType);
  const st = read(platform, businessDate, reportType);
  const reasons = [];
  if (st.import.status !== 'success') reasons.push(`import=${st.import.status}`);
  if (st.validate_import.status !== 'passed') reasons.push(`validate_import=${st.validate_import.status}`);
  if (st.push.status === 'success') reasons.push('已推送过');
  return { ok: reasons.length === 0, reasons, state: st };
}

module.exports = {
  SECTIONS,
  stateFile,
  read,
  patch,
  markRunning,
  markSuccess,
  markFailed,
  markPassed,
  recent,
  canPush,
};
