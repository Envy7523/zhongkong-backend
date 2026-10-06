'use strict';
/**
 * 调度 **本地幂等状态**（契约第 5 节）
 *
 *   state/schedule/<job>/<YYYY-MM-DD>.json     （原子写；0600）
 *   { job, business_date, status, attempt, reason, updated_at, worker_id }
 *
 * 语义（与 CONTRACT.md 第 2 节一致）：
 *  - success / failed / waiting_human = **终态**：同 (job, business_date) 不再自动执行；
 *  - refused = **无副作用**的拒绝（未发送/未导出/未导入）⇒ 当天内允许再次尝试；
 *  - running = 动作已发起、结果未知（崩溃残留）⇒ **只能标记 waiting_human**，绝不自动重做。
 *
 * 本模块不写锁、不发 HTTP，只做本地文件的读写与状态迁移。
 */
const fs = require('fs');
const path = require('path');
const P = require('../paths');
const PLAN = require('./plan');

const FIELDS = ['job', 'business_date', 'status', 'attempt', 'reason', 'updated_at', 'worker_id'];

function root() {
  return path.join(P.state, 'schedule');
}
function jobDir(job) {
  if (!PLAN.isJob(job)) throw new Error('未知作业：' + String(job).slice(0, 32) + '（仅 sync/report）');
  PLAN.assertNotLockedReport(job, '本地调度状态');
  return path.join(root(), String(job));
}
/** 目录不存在即创建（写入前才调用；只读路径绝不建目录） */
function ensureJobDir(job) {
  const d = jobDir(job);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}
function stateFile(job, businessDate) {
  const mapped = PLAN.scheduleStateRelPath(job, businessDate);   // job/日期校验（报表 B 在此被拒）
  const rel = mapped.split('/');
  return path.join(P.root, rel[0], rel[1], rel[2], rel[3]);
}
function exists(job, businessDate) {
  return fs.existsSync(stateFile(job, businessDate));
}

/** 只读：不存在或损坏一律返回 null（**不创建任何文件/目录**） */
function read(job, businessDate) {
  const file = stateFile(job, businessDate);
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object') return null;
    return j;
  } catch (e) {
    return null;
  }
}

function atomicWrite(file, obj) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now().toString(36);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (_) {}
  fs.renameSync(tmp, file);
  return file;
}

function sanitizeWorkerId(workerId) {
  const s = String(workerId == null ? '' : workerId);
  const clean = s.replace(/[^A-Za-z0-9_.:@#-]/g, '_').slice(0, 64);
  return clean || 'unknown-worker';
}

/**
 * 写入/合并本地状态（原子写）。
 * @param {{status?:string, reason?:string|null, worker_id?:string, attempt?:number, now?:string}} patch
 */
function write(job, businessDate, patch = {}) {
  const file = stateFile(job, businessDate);
  const prev = read(job, businessDate) || {};
  const status = patch.status === undefined ? (prev.status || 'pending') : String(patch.status);
  if (PLAN.STATUSES.indexOf(status) < 0) throw new Error('非法本地状态：' + status.slice(0, 32));
  const next = {
    job: String(job),
    business_date: PLAN.assertPlainDate(businessDate),
    status,
    attempt: Number.isFinite(Number(patch.attempt)) ? Number(patch.attempt) : (Number.isFinite(Number(prev.attempt)) ? Number(prev.attempt) : 0),
    reason: patch.reason === undefined ? (prev.reason === undefined ? null : prev.reason) : (patch.reason === null ? null : String(patch.reason).slice(0, 120)),
    updated_at: patch.now || new Date().toISOString(),
    worker_id: sanitizeWorkerId(patch.worker_id === undefined ? prev.worker_id : patch.worker_id),
  };
  // 只保留契约字段（绝不落任何额外/敏感字段）
  const out = {};
  for (const k of FIELDS) out[k] = next[k];
  atomicWrite(file, out);
  return out;
}

/** 终态/非终态判定（缺文件 = 未执行过） */
function statusOf(job, businessDate) {
  const cur = read(job, businessDate);
  return {
    exists: cur !== null,
    status: cur ? String(cur.status) : null,
    terminal: !!(cur && PLAN.isTerminalStatus(cur.status)),
    record: cur,
  };
}

/**
 * 崩溃残留恢复：本地状态停在 running（动作已发起、结果未知）时，
 * **只能**标记为 waiting_human —— 绝不重跑、绝不重置为 pending。
 * @returns {{recovered:boolean, previous:object|null, record:object|null}}
 */
function recoverStaleRunning(job, businessDate, { workerId, reason = 'in_flight_unknown', now } = {}) {
  const cur = read(job, businessDate);
  if (!cur || String(cur.status) !== PLAN.UNCERTAIN_STATUS) return { recovered: false, previous: cur, record: cur };
  const record = write(job, businessDate, {
    status: 'waiting_human', reason, worker_id: workerId,
    attempt: Number(cur.attempt) || 0, now,
  });
  return { recovered: true, previous: cur, record };
}

/** 只读列出全部本地状态（--status 用；不创建任何文件） */
function list() {
  const out = [];
  for (const job of PLAN.JOBS) {
    let names = [];
    try { names = fs.readdirSync(jobDir(job)); } catch (_) { names = []; }
    for (const n of names.filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) {
      const rec = read(job, n.replace(/\.json$/, ''));
      if (rec) out.push(rec);
    }
  }
  return out;
}

module.exports = {
  FIELDS, root, jobDir, ensureJobDir, stateFile, exists, read, write, atomicWrite,
  sanitizeWorkerId, statusOf, recoverStaleRunning, list,
};
