'use strict';
/**
 * 「自动同步与日报计划」持久化层（中控侧）
 *
 * deps 注入 db（项目既有 lib/db.js 风格：queryAll/queryOne/run/insert/save），
 * 便于离线套件用内存假 db 跑全部用例。
 *
 * 幂等性说明：中控是**单进程单线程**，claimRun 中"查-判-写"之间不含 await，
 * 因此在事件循环意义上天然原子；UNIQUE(job,business_date) 作为第二道防线。
 */

const DDL = [
  `CREATE TABLE IF NOT EXISTS schedule_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sync_enabled   INTEGER NOT NULL DEFAULT 0,
    sync_time      TEXT    NOT NULL DEFAULT '01:05',
    report_enabled INTEGER NOT NULL DEFAULT 0,
    report_time    TEXT    NOT NULL DEFAULT '09:00',
    timezone       TEXT    NOT NULL DEFAULT 'Asia/Shanghai',
    version        INTEGER NOT NULL DEFAULT 1,
    updated_at     TEXT,
    updated_by     INTEGER,
    updated_by_name TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS schedule_config_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    user_id INTEGER,
    user_name TEXT,
    action TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    note TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS schedule_job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job TEXT NOT NULL,
    business_date TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    send_attempts INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    detail_json TEXT,
    requested_at TEXT, claimed_at TEXT, started_at TEXT, finished_at TEXT,
    worker_id TEXT,
    UNIQUE (job, business_date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_schedule_job_runs_status ON schedule_job_runs(status, job, business_date)`,
];

/** 可被重新 claim（继续执行）的状态：refused 代表**零副作用**的拒绝 */
const RECLAIMABLE = ['refused'];
/** 终态：不再自动执行 */
const TERMINAL = ['success', 'failed', 'waiting_human'];

function nowIso() { return new Date().toISOString(); }

function createScheduleStore({ db, core }) {
  if (!db) throw new Error('schedule-store: db required');
  if (!core) throw new Error('schedule-store: core required');

  function exec(sql, params) { return db.run(sql, params || []); }
  function one(sql, params) { return db.queryOne(sql, params || []); }
  function all(sql, params) { return db.queryAll(sql, params || []); }

  function ensureSchema() {
    for (const ddl of DDL) exec(ddl);
    const cur = one('SELECT * FROM schedule_config WHERE id = 1');
    if (!cur) {
      const d = core.defaultConfig();
      exec('INSERT INTO schedule_config (id, sync_enabled, sync_time, report_enabled, report_time, timezone, version, updated_at) VALUES (1,?,?,?,?,?,1,?)',
        [d.sync_enabled, d.sync_time, d.report_enabled, d.report_time, d.timezone, nowIso()]);
    }
    return getConfig();
  }

  function getConfig() {
    const row = one('SELECT * FROM schedule_config WHERE id = 1');
    return row || core.defaultConfig();
  }

  function audit(action, before, after, ctx) {
    exec('INSERT INTO schedule_config_audit (at, user_id, user_name, action, before_json, after_json, note) VALUES (?,?,?,?,?,?,?)',
      [nowIso(), (ctx && ctx.user_id) || null, (ctx && ctx.user_name) || null, action,
        JSON.stringify(core.sanitizeForAudit(before)), JSON.stringify(core.sanitizeForAudit(after)), (ctx && ctx.note) || null]);
    const row = one('SELECT id FROM schedule_config_audit ORDER BY id DESC LIMIT 1');
    return row ? row.id : null;
  }

  /**
   * 保存配置（只影响未来计划：不执行任何作业、不补跑）。
   * 校验由调用方用 core.validateSchedulePatch 完成后传入 patch。
   */
  function saveConfig(patch, ctx) {
    const before = getConfig();
    const eff = core.effective(patch, before);
    exec(`UPDATE schedule_config SET sync_enabled=?, sync_time=?, report_enabled=?, report_time=?, timezone=?, version=version+1, updated_at=?, updated_by=?, updated_by_name=? WHERE id = 1`,
      [eff.sync_enabled ? 1 : 0, eff.sync_time, eff.report_enabled ? 1 : 0, eff.report_time, core.TIMEZONE, nowIso(),
        (ctx && ctx.user_id) || null, (ctx && ctx.user_name) || null]);
    const after = getConfig();
    const action = (ctx && ctx.action) || 'update';
    const auditId = audit(action, before, after, ctx);
    if (typeof db.save === 'function') db.save();
    return { ok: true, config: after, audit_id: auditId };
  }

  function auditList(limit = 20) {
    return all('SELECT id, at, user_name, action, before_json, after_json, note FROM schedule_config_audit ORDER BY id DESC LIMIT ?', [Math.min(Number(limit) || 20, 100)]);
  }

  function getRun(job, businessDate) {
    return one('SELECT * FROM schedule_job_runs WHERE job = ? AND business_date = ?', [job, businessDate]) || null;
  }

  function recentRuns(limit = 10) {
    return all('SELECT job, business_date, trigger, status, attempt, send_attempts, reason, started_at, finished_at FROM schedule_job_runs ORDER BY id DESC LIMIT ?', [Math.min(Number(limit) || 10, 50)]);
  }

  /** 最近一次（任意日期）同步/推送状态，供后台展示 */
  function lastRunOf(job) {
    return one('SELECT job, business_date, trigger, status, attempt, send_attempts, reason, started_at, finished_at FROM schedule_job_runs WHERE job = ? ORDER BY id DESC LIMIT 1', [job]) || null;
  }

  /**
   * 原子占位（同步作业 / 日报作业共用）。
   * 返回 {ok:true, claimed:true, run} 或 {ok:true, claimed:false, reason, run}
   */
  function claimRun({ job, business_date, trigger = 'schedule', worker_id = null, reasonWhenHeld = null }) {
    const key = core.idempotencyKey(job, business_date);
    const cur = getRun(job, business_date);
    if (cur) {
      const st = String(cur.status);
      if (st === 'success') return { ok: true, claimed: false, reason: core.REFUSAL.ALREADY_SUCCESS, run: cur };
      if (st === 'running' || st === 'claimed' || st === 'requested') {
        return { ok: true, claimed: false, reason: reasonWhenHeld || core.REFUSAL.IN_FLIGHT_UNKNOWN, run: cur };
      }
      if (st === 'waiting_human') return { ok: true, claimed: false, reason: core.REFUSAL.IN_FLIGHT_UNKNOWN, run: cur };
      if (st === 'failed') return { ok: true, claimed: false, reason: 'previous_failed_needs_human', run: cur };
      if (!RECLAIMABLE.includes(st)) return { ok: true, claimed: false, reason: core.REFUSAL.NO_ACTIVE_RUN_SLOT, run: cur };
      // 零副作用拒绝 → 允许同日再试（只累加 attempt，不新增行）
      exec("UPDATE schedule_job_runs SET status='running', attempt=attempt+1, claimed_at=?, started_at=?, finished_at=NULL, reason=NULL, worker_id=? WHERE job=? AND business_date=? AND status='refused'",
        [nowIso(), nowIso(), worker_id, job, business_date]);
      return { ok: true, claimed: true, reclaimed: true, run: getRun(job, business_date) };
    }
    exec('INSERT INTO schedule_job_runs (job, business_date, idempotency_key, trigger, status, attempt, send_attempts, requested_at, claimed_at, started_at, worker_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [job, business_date, key, trigger, 'running', 1, 0, nowIso(), nowIso(), nowIso(), worker_id]);
    if (typeof db.save === 'function') db.save();
    return { ok: true, claimed: true, run: getRun(job, business_date) };
  }

  /** 发起点（仅 manual 请求用）：requested 不是 running，worker 会 claim 它 */
  function requestRun({ job, business_date, trigger = 'manual', ctx = null }) {
    const cur = getRun(job, business_date);
    if (cur) {
      const st = String(cur.status);
      if (st === 'success') return { ok: false, reason: core.REFUSAL.ALREADY_SUCCESS, run: cur };
      if (st === 'requested') return { ok: true, run: cur, already_requested: true };
      return { ok: false, reason: core.REFUSAL.NO_ACTIVE_RUN_SLOT, run: cur };
    }
    exec('INSERT INTO schedule_job_runs (job, business_date, idempotency_key, trigger, status, attempt, send_attempts, requested_at, worker_id) VALUES (?,?,?,?,?,0,0,?,?)',
      [job, business_date, core.idempotencyKey(job, business_date), trigger, 'requested', nowIso(), ctx && ctx.user_name ? String(ctx.user_name) : null]);
    if (typeof db.save === 'function') db.save();
    return { ok: true, run: getRun(job, business_date), requested: true };
  }

  /** worker 占位：requested → running */
  function claimRequested({ job, business_date, worker_id = null }) {
    const cur = getRun(job, business_date);
    if (!cur || String(cur.status) !== 'requested') return { ok: true, claimed: false, reason: 'no_pending_request', run: cur };
    exec("UPDATE schedule_job_runs SET status='running', attempt=attempt+1, claimed_at=?, started_at=?, worker_id=? WHERE job=? AND business_date=? AND status='requested'",
      [nowIso(), nowIso(), worker_id, job, business_date]);
    if (typeof db.save === 'function') db.save();
    return { ok: true, claimed: true, run: getRun(job, business_date) };
  }

  function settleRun({ job, business_date, status, reason = null, detail = null, worker_id = null, countSendAttempt = false }) {
    if (!TERMINAL.includes(status) && status !== 'refused') throw new Error('settleRun: bad status ' + status);
    const cur = getRun(job, business_date);
    if (!cur) throw new Error('settleRun: no run row');
    exec('UPDATE schedule_job_runs SET status=?, reason=?, detail_json=?, finished_at=?, worker_id=?, send_attempts=send_attempts+? WHERE job=? AND business_date=?',
      [status, reason, detail ? JSON.stringify(detail) : null, nowIso(), worker_id || cur.worker_id, countSendAttempt ? 1 : 0, job, business_date]);
    if (typeof db.save === 'function') db.save();
    return getRun(job, business_date);
  }

  /** 发送前占位：send_attempts+1（同一日期上限 1） */
  function beginSend({ job, business_date }) {
    const cur = getRun(job, business_date);
    if (!cur) return { ok: false, reason: core.REFUSAL.NO_ACTIVE_RUN_SLOT };
    if (Number(cur.send_attempts || 0) >= 1) return { ok: false, reason: core.REFUSAL.PUSH_IN_FLIGHT_UNKNOWN, run: cur };
    exec('UPDATE schedule_job_runs SET send_attempts=send_attempts+1, status=?, started_at=? WHERE job=? AND business_date=?',
      ['running', nowIso(), job, business_date]);
    if (typeof db.save === 'function') db.save();
    return { ok: true, run: getRun(job, business_date) };
  }

  return {
    ensureSchema, getConfig, saveConfig, auditList, getRun, recentRuns, lastRunOf,
    claimRun, requestRun, claimRequested, settleRun, beginSend,
    RECLAIMABLE, TERMINAL, DDL,
  };
}

module.exports = { createScheduleStore, DDL, RECLAIMABLE, TERMINAL };
