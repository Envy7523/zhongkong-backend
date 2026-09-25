'use strict';
/**
 * 中控「原子 reconcile」受控动作（唯一受控动作：reconcile_batch180）
 *  - 单个 SQLite transaction 内完成：前置条件校验 → 追加唯一 IMPORT_SUCCEEDED/seq=3 事件 → 同批更新同一 run → 事务内自校验 → COMMIT
 *  - 任何前置条件/插入/更新失败即 ROLLBACK：事件与 run **零变化**；回滚不依赖"删除事件"
 *  - 固定幂等键 + **确定性 event_id**：重复调用识别为 already_reconciled ⇒ no-op（零写入）
 *  - 事务提交后**仅一次** db.save()
 *  - 安全边界与已上线 run-settle 一致：仅由路由层保证 loopback/HMAC/时间戳/原始字节签名；本模块只接受受控动作，禁任意 SQL/批量/模糊/业务表写入
 */
const crypto = require('crypto');
const FROZEN = {
  action: 'reconcile_batch180',
  run_key: 'meituan|cashier_composite|2026-09-22|sched-meituan-cashier_composite-2026-09-22',
  idempotency_key: 'reconcile|meituan|cashier_composite|2026-09-22|batch180|d65c6d011bc2',
  import_batch_id: 180,
  archive_sha256: 'd65c6d011bc238ac06f096b7dc546b1a5bc7b09e4880a5774a055a8d568630a4',
  stage: 'IMPORT_SUCCEEDED',
  seq: 3,
  expected_from: { phase: 'IMPORT_FAILED', status: 'failed', event_count: 2, max_seq: 2 },
  target: { phase: 'IMPORT_SUCCEEDED', status: 'success', imported: 1, ready_to_push: 1, import_batch_id: 180, raw_store_count: 22, matched_store_count: 22, event_count: 3 },
  validation: { raw_imported: 22, matched_stores: 22, imported: 154, errors_empty: true, amount_delta: 0, business_date_matched: true },
  detail_note: 'reconcile_batch180',
  forbidden_tables: ['business_revenue_records', 'business_import_batches', 'schedule_job_runs', 'push_logs'],
};
const EVENT_COLS = ['event_id', 'run_id', 'task_id', 'platform', 'report_type', 'business_date', 'stage', 'status', 'at', 'seq', 'detail_json', 'is_test', 'test_run_id'];
const RUN_COLS = ['phase', 'status', 'failure_reason', 'imported', 'ready_to_push', 'import_batch_id', 'raw_store_count', 'matched_store_count', 'event_count', 'validation_json', 'updated_at', 'last_event_at'];

function derivedEventId() {
  return 'reconcile-batch180-' + crypto.createHash('sha256').update(FROZEN.idempotency_key).digest('hex').slice(0, 16);
}
function buildEventDetail() {
  return { note: FROZEN.detail_note, ready_to_push: FROZEN.target.ready_to_push, failure_reason: null, validation: FROZEN.validation };
}
function validateRequest(body) {
  const problems = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, problems: ['body_not_object'] };
  if (body.action !== FROZEN.action) problems.push('action_not_controlled:' + String(body.action));
  if (body.idempotency_key !== FROZEN.idempotency_key) problems.push('idempotency_key_mismatch');
  if (body.run_key !== FROZEN.run_key) problems.push('run_key_not_controlled');
  const extra = Object.keys(body).filter((k) => ['action', 'idempotency_key', 'run_key'].indexOf(k) < 0);
  if (extra.length) problems.push('body_unknown_fields:' + extra.join(','));
  if (problems.length) return { ok: false, problems };
  return { ok: true };
}
function runView(row) {
  return { id: row.id, phase: row.phase, status: row.status, failure_reason: row.failure_reason === undefined ? null : row.failure_reason,
    imported: row.imported, ready_to_push: row.ready_to_push, import_batch_id: row.import_batch_id,
    raw_store_count: row.raw_store_count, matched_store_count: row.matched_store_count, event_count: row.event_count,
    push_status: row.push_status, pushed: row.pushed };
}
function isTargetState(row) {
  const t = FROZEN.target;
  return row && row.phase === t.phase && row.status === t.status
    && (row.failure_reason === null || row.failure_reason === undefined || row.failure_reason === '')
    && Number(row.imported) === t.imported && Number(row.ready_to_push) === t.ready_to_push
    && Number(row.import_batch_id) === t.import_batch_id && Number(row.event_count) === t.event_count;
}
function reconcile(db, body) {
  if (!db || typeof db.queryOne !== 'function' || typeof db.run !== 'function') return { ok: false, problems: ['db_unavailable'], writes: 0 };
  const v = validateRequest(body);
  if (!v.ok) return { ok: false, problems: v.problems, writes: 0 };
  const runKey = FROZEN.run_key;
  const eventId = derivedEventId();

  const cnt = db.queryOne('SELECT COUNT(*) AS n FROM sync_job_runs WHERE run_key=?', [runKey]);
  const n = Number((cnt && cnt.n) || 0);
  if (n !== 1) return { ok: false, problems: ['run_key_match_count_not_one:' + n], writes: 0 };
  const row = db.queryOne('SELECT * FROM sync_job_runs WHERE run_key=?', [runKey]);
  if (!row) return { ok: false, problems: ['run_not_found'], writes: 0 };
  if (Number(row.is_test || 0) === 1) return { ok: false, problems: ['test_run_refused'], writes: 0 };

  const evExists = db.queryOne('SELECT id FROM sync_job_events WHERE event_id=?', [eventId]);
  if (evExists || isTargetState(row)) {
    return { ok: true, applied: false, reason: 'already_reconciled', run_id: row.id, event_id: eventId, idempotency_key: FROZEN.idempotency_key, state: runView(row), writes: 0 };
  }
  if (row.phase !== FROZEN.expected_from.phase || row.status !== FROZEN.expected_from.status) {
    return { ok: false, problems: ['unexpected_run_state:' + String(row.phase) + '/' + String(row.status)], writes: 0 };
  }
  if (row.import_batch_id !== null && row.import_batch_id !== undefined && Number(row.import_batch_id) !== FROZEN.import_batch_id) {
    return { ok: false, problems: ['import_batch_id_mismatch:' + String(row.import_batch_id)], writes: 0 };
  }
  const ec = db.queryOne('SELECT COUNT(*) AS n FROM sync_job_events WHERE run_id=?', [row.id]);
  const ms = db.queryOne('SELECT COALESCE(MAX(seq),0) AS m FROM sync_job_events WHERE run_id=?', [row.id]);
  const evCount = Number((ec && ec.n) || 0); const maxSeq = Number((ms && ms.m) || 0);
  if (evCount !== FROZEN.expected_from.event_count || maxSeq !== FROZEN.expected_from.max_seq) {
    return { ok: false, problems: ['event_timeline_unexpected:' + evCount + '/' + maxSeq], writes: 0 };
  }
  const dup = db.queryOne("SELECT id FROM sync_job_events WHERE run_id=? AND stage=?", [row.id, FROZEN.stage]);
  if (dup) return { ok: false, problems: ['import_succeeded_event_already_present'], writes: 0 };

  const at = new Date().toISOString();
  const detailJson = JSON.stringify(buildEventDetail()).slice(0, 8000);
  const eventVals = [eventId, row.id, row.task_id, row.platform, row.report_type, row.business_date, FROZEN.stage, 'success', at, FROZEN.seq, detailJson,
    Number(row.is_test || 0), row.test_run_id === undefined || row.test_run_id === null ? '' : row.test_run_id];
  const runVals = [FROZEN.target.phase, FROZEN.target.status, null, FROZEN.target.imported, FROZEN.target.ready_to_push, FROZEN.target.import_batch_id,
    FROZEN.target.raw_store_count, FROZEN.target.matched_store_count, FROZEN.target.event_count, JSON.stringify(FROZEN.validation), at, at,
    runKey, row.id, FROZEN.expected_from.phase, FROZEN.expected_from.status];
  const insSql = 'INSERT INTO sync_job_events (' + EVENT_COLS.join(',') + ') VALUES (' + EVENT_COLS.map(() => '?').join(',') + ')';
  const updSql = 'UPDATE sync_job_runs SET ' + RUN_COLS.map((c) => c + '=?').join(',') + ' WHERE run_key=? AND id=? AND phase=? AND status=?';
  for (const t of FROZEN.forbidden_tables) {
    if (insSql.indexOf(t) >= 0 || updSql.indexOf(t) >= 0) return { ok: false, problems: ['forbidden_table_in_sql:' + t], writes: 0 };
  }
  let inTx = false;
  try {
    db.run('BEGIN IMMEDIATE'); inTx = true;
    db.run(insSql, eventVals);
    db.run(updSql, runVals);
    const after = db.queryOne('SELECT * FROM sync_job_runs WHERE id=?', [row.id]);
    const afterEv = db.queryOne('SELECT COUNT(*) AS n FROM sync_job_events WHERE run_id=?', [row.id]);
    const afterDup = db.queryOne('SELECT COUNT(*) AS n FROM sync_job_events WHERE run_id=? AND stage=?', [row.id, FROZEN.stage]);
    const okAfter = isTargetState(after) && Number((afterEv && afterEv.n) || 0) === FROZEN.target.event_count && Number((afterDup && afterDup.n) || 0) === 1;
    if (!okAfter) { db.run('ROLLBACK'); inTx = false; return { ok: false, problems: ['post_write_verify_failed'], rolled_back: true, writes: 0 }; }
    db.run('COMMIT'); inTx = false;
  } catch (e) {
    if (inTx) { try { db.run('ROLLBACK'); } catch (x) { /* ignore */ } }
    return { ok: false, problems: ['write_failed:' + String((e && e.message) || e)], rolled_back: true, writes: 0 };
  }
  if (typeof db.save === 'function') db.save();
  const finalRow = db.queryOne('SELECT * FROM sync_job_runs WHERE id=?', [row.id]);
  return { ok: true, applied: true, run_id: row.id, event_id: eventId, idempotency_key: FROZEN.idempotency_key, seq: FROZEN.seq, state: runView(finalRow), writes: 1 };
}
module.exports = { FROZEN, EVENT_COLS, RUN_COLS, derivedEventId, buildEventDetail, validateRequest, isTargetState, runView, reconcile };
