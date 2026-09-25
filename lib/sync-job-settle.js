'use strict';
/**
 * 中控内部「运行收尾」通道的最小实现（供 /api/internal/syncbot/run-settle 使用）
 *
 * 安全边界（与 events 端点同源）：
 *  - 本模块**只**接受结构化 JSON，绝不接受任何 SQL 片段；
 *  - 目标定位：**精确 run_key 等值匹配**，且必须**恰好命中 1 行**（禁 LIKE / 通配 / 批量 / 模糊）；
 *  - 字段：**白名单**，键名只能取自 FIELD_SPEC；列名不来自输入（由白名单决定），值全部参数化；
 *  - 只写 sync_job_runs 一张表；**不触碰**业务表、schedule_job_runs、sync_job_events、推送字段；
 *  - 幂等：请求携带单一 idempotency_key；目标已满足时返回 applied=false（零写入）。
 *  - 拒绝测试 run（is_test=1）。
 */
const FIELD_SPEC = {
  phase: { kind: 'enum', allow: ['IMPORT_SUCCEEDED'] },
  status: { kind: 'enum', allow: ['success'] },
  imported: { kind: 'int01' },
  ready_to_push: { kind: 'int01' },
  import_batch_id: { kind: 'int_pos' },
  raw_store_count: { kind: 'int_nonneg' },
  matched_store_count: { kind: 'int_nonneg' },
  event_count: { kind: 'int_nonneg' },
  validation_json: { kind: 'json_object' },
  failure_reason: { kind: 'null_only' },
};
const COLUMNS = Object.keys(FIELD_SPEC);
const RUN_KEY_RE = /^[A-Za-z0-9._|:-]{8,200}$/;
const IDEM_RE = /^[A-Za-z0-9._|:-]{8,128}$/;
const FORBIDDEN_TABLES = ['business_revenue_records', 'business_import_batches', 'schedule_job_runs', 'sync_job_events', 'users', 'stores', 'push_logs'];

function validateRequest(body) {
  const problems = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, problems: ['body_not_object'] };
  const runKey = body.run_key;
  if (typeof runKey !== 'string' || !RUN_KEY_RE.test(runKey) || runKey.indexOf('%') >= 0) problems.push('run_key_invalid');
  const idem = body.idempotency_key;
  if (typeof idem !== 'string' || !IDEM_RE.test(idem)) problems.push('idempotency_key_invalid');
  const fields = body.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) problems.push('fields_not_object');
  else {
    const keys = Object.keys(fields);
    if (!keys.length) problems.push('fields_empty');
    for (const k of keys) {
      const spec = FIELD_SPEC[k];
      if (!spec) { problems.push('field_not_whitelisted:' + k); continue; }
      const v = fields[k];
      if (spec.kind === 'null_only') { if (v !== null) problems.push('failure_reason_must_be_null'); continue; }
      if (spec.kind === 'enum') { if (typeof v !== 'string' || spec.allow.indexOf(v) < 0) problems.push('enum_value_not_allowed:' + k); continue; }
      if (spec.kind === 'int01') { if (v !== 0 && v !== 1) problems.push('int01_required:' + k); continue; }
      if (spec.kind === 'int_pos') { if (!Number.isInteger(v) || v <= 0 || v > 1000000000) problems.push('positive_int_required:' + k); continue; }
      if (spec.kind === 'int_nonneg') { if (!Number.isInteger(v) || v < 0 || v > 1000000) problems.push('nonneg_int_required:' + k); continue; }
      if (spec.kind === 'json_object') {
        if (!v || typeof v !== 'object' || Array.isArray(v)) { problems.push('json_object_required:' + k); continue; }
        if (JSON.stringify(v).length > 4000) problems.push('json_object_too_large:' + k);
      }
    }
  }
  const extra = Object.keys(body).filter((k) => ['run_key', 'idempotency_key', 'fields'].indexOf(k) < 0);
  if (extra.length) problems.push('body_unknown_fields:' + extra.join(','));
  if (problems.length) return { ok: false, problems };
  return { ok: true, clean: { run_key: runKey, idempotency_key: idem, fields: fields } };
}

function settleRun(db, body) {
  if (!db || typeof db.queryOne !== 'function' || typeof db.run !== 'function') return { ok: false, problems: ['db_unavailable'] };
  const v = validateRequest(body);
  if (!v.ok) return { ok: false, problems: v.problems };
  const { run_key: runKey, idempotency_key: idem, fields } = v.clean;

  const cnt = db.queryOne('SELECT COUNT(*) AS n FROM sync_job_runs WHERE run_key=?', [runKey]);
  const n = Number((cnt && cnt.n) || 0);
  if (n !== 1) return { ok: false, problems: ['run_key_match_count_not_one:' + n] };
  const row = db.queryOne('SELECT * FROM sync_job_runs WHERE run_key=?', [runKey]);
  if (!row) return { ok: false, problems: ['run_not_found'] };
  if (Number(row.is_test || 0) === 1) return { ok: false, problems: ['test_run_refused'] };

  const keys = COLUMNS.filter((k) => Object.prototype.hasOwnProperty.call(fields, k));
  const canon = (v) => {
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    const s = String(v);
    if (/^[\[{]/.test(s.trim())) { try { return JSON.stringify(JSON.parse(s)); } catch (e) { return s; } }
    return s;
  };
  const changed = keys.filter((k) => canon(row[k]) !== canon(fields[k]));
  const before = {}; const after = {};
  for (const k of keys) { before[k] = row[k] === undefined ? null : row[k]; after[k] = fields[k]; }
  if (!changed.length) return { ok: true, applied: false, reason: 'already_satisfied', run_key: runKey, run_id: row.id, idempotency_key: idem, changed: [], before, after };

  const sets = changed.map((k) => k + '=?');
  const vals = changed.map((k) => (k === 'validation_json' ? JSON.stringify(fields[k]) : fields[k]));
  const sql = 'UPDATE sync_job_runs SET ' + sets.join(',') + ", updated_at=datetime('now','localtime') WHERE run_key=? AND id=? AND (is_test IS NULL OR is_test<>1)";
  vals.push(runKey, row.id);
  for (const t of FORBIDDEN_TABLES) {
    if (sql.indexOf(t) >= 0) return { ok: false, problems: ['forbidden_table_in_sql:' + t] };
  }
  db.run(sql, vals);
  if (typeof db.save === 'function') db.save();
  return { ok: true, applied: true, run_key: runKey, run_id: row.id, idempotency_key: idem, changed, before, after };
}

module.exports = { FIELD_SPEC, COLUMNS, RUN_KEY_RE, IDEM_RE, FORBIDDEN_TABLES, validateRequest, settleRun };
