'use strict';
/**
 * AI 自动导报表运行审计（**独立于营收/订单/门店业务表**）
 *
 * 职责：
 *  1) 校验并接收 syncbot 通过本机回环接口上报的**结构化事件**（HMAC + 时间戳 + 幂等）；
 *  2) 维护运行汇总 sync_job_runs（每 task_id 一行）与事件明细 sync_job_events；
 *  3) 为「AI 自动导报表记录」页面提供筛选/详情数据，**只输出脱敏字段**。
 *
 * 安全约束（本文件强制，不依赖调用方自觉）：
 *  - HMAC-SHA256 校验使用 timingSafeEqual；时间戳偏差超过 TOLERANCE_MS 拒绝；
 *  - 密钥只从服务端配置文件读取，绝不出现在日志/响应/页面；
 *  - 事件顶层字段白名单 + 全量敏感模式扫描（密码/令牌/Cookie/HMAC/Webhook/私钥）；
 *  - 绝对服务器路径一律剥离（只保留 basename / 相对片段）；
 *  - report_type 必须在已注册且授权的集合内；
 *  - event_id 唯一 → 重复上报不产生重复记录。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** 允许上报的关键阶段（与阶段3交付约定一致） */
const STAGES = [
  'PRECHECK', 'QUERY_DONE', 'EXPORT_SUBMITTED', 'WAITING_EXPORT', 'DOWNLOADED', 'FILE_VALIDATED',
  'IMPORT_STARTED', 'IMPORT_SUCCEEDED', 'IMPORT_FAILED',
  'PUSH_SUCCEEDED', 'PUSH_FAILED', 'FAILED', 'WAITING_HUMAN',
];
const FAILURE_STAGES = new Set(['IMPORT_FAILED', 'PUSH_FAILED', 'FAILED']);
const SUCCESS_STAGES = new Set(['IMPORT_SUCCEEDED', 'PUSH_SUCCEEDED']);
const AUTHORIZED_REPORT_TYPES = new Set(['cashier_composite']);
const LOCKED_REPORT_TYPES = new Set(['item_sales_detail']);

const DEFAULT_SHA_PREFIX_LEN = 12;
const TOLERANCE_MS = 5 * 60 * 1000;

/** 事件顶层允许出现的字段（白名单；其余一律拒绝） */
const ALLOWED_EVENT_FIELDS = new Set([
  'event_id', 'task_id', 'report_type', 'business_date', 'platform',
  'stage', 'status', 'at', 'seq', 'metrics', 'detail',
  // 测试专用标记：仅 fixture 上报携带；生产真实上报**不得**自行携带 is_test。
  'is_test', 'test_run_id',
]);
/** test_run_id 严格格式：test- 前缀 + 6..64 位 [A-Za-z0-9._-] */
const TEST_RUN_ID_RE = /^test-[A-Za-z0-9._-]{6,64}$/;
/** metrics/detail 允许出现的字段（白名单） */
const ALLOWED_METRIC_FIELDS = new Set([
  'phase', 'started_at', 'finished_at', 'duration_ms', 'failure_reason',
  'original_filename', 'file_size', 'sha256', 'sha256_prefix', 'import_batch_id',
  'raw_store_count', 'matched_store_count', 'ready_to_push', 'push_status',
  'imported', 'pushed', 'is_backfill', 'reconstructed', 'not_a_realtime_success',
  'screenshot_count', 'validation', 'evidence', 'note',
]);
/** 敏感模式：出现即整体拒绝该事件 */
const SENSITIVE_KEY_RE = /pass(word|wd)?|secret|token|jwt|cookie|authorization|auth_header|hmac|signature|private_key|api[_-]?key|webhook/i;
const SENSITIVE_VALUE_RE = /(bearer\s+[A-Za-z0-9._-]{10,})|(eyJ[A-Za-z0-9_-]{10,}\.)|(qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=)/i;
const ABS_PATH_RE = /(^|[\s"'(=])(\/(?:home|opt|etc|var|root|tmp|usr)\/[^\s"')]*)|([A-Za-z]:\\[^\s"')]*)/g;

function loadSecret(fileOverride) {
  const p = fileOverride || process.env.SYNCBOT_AUDIT_HMAC_FILE
    || '/home/ubuntu/app/data/secrets/syncbot-audit-hmac';
  try {
    const v = fs.readFileSync(p, 'utf8').trim();
    return v.length >= 16 ? v : '';
  } catch {
    return '';
  }
}

/** 相对时间戳校验（防重放） */
function timestampAcceptable(ts, nowMs = Date.now()) {
  const t = Number(ts);
  if (!Number.isFinite(t)) return { ok: false, reason: 'timestamp_missing_or_invalid' };
  const skew = Math.abs(nowMs - t);
  if (skew > TOLERANCE_MS) return { ok: false, reason: `timestamp_skew_too_large(${Math.round(skew / 1000)}s)` };
  return { ok: true, skew_ms: skew };
}

/** 校验签名：X-Syncbot-Signature = hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`)) */
function verifySignature({ secret, timestamp, signature, rawBody }) {
  if (!secret) return { ok: false, reason: 'hmac_secret_not_configured' };
  if (!signature || !timestamp) return { ok: false, reason: 'signature_or_timestamp_missing' };
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest();
  let given;
  try {
    given = Buffer.from(String(signature), 'hex');
  } catch {
    return { ok: false, reason: 'signature_not_hex' };
  }
  if (given.length !== expected.length) return { ok: false, reason: 'signature_length_mismatch' };
  try {
    if (!crypto.timingSafeEqual(given, expected)) return { ok: false, reason: 'signature_mismatch' };
  } catch {
    return { ok: false, reason: 'signature_compare_failed' };
  }
  return { ok: true };
}

function signPayload({ secret, timestamp, rawBody }) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

function closeEnough(a, b) {
  return Math.abs(Number(a) - Number(b)) <= 60 * 1000;
}

/** 剥离绝对路径，只保留文件名/相对尾部 */
function stripPath(value) {
  const s = String(value == null ? '' : value);
  if (!s) return '';
  return s.replace(ABS_PATH_RE, (m, pre) => `${pre || ''}[path]`).replace(/\\/g, '/').split('/').pop() || s;
}

function scanSensitive(value, trail = '') {
  const hits = [];
  if (value == null) return hits;
  if (typeof value === 'string') {
    if (SENSITIVE_VALUE_RE.test(value)) hits.push(`${trail}:value_matches_sensitive_pattern`);
    if (ABS_PATH_RE.test(value)) hits.push(`${trail}:value_contains_absolute_path`);
    ABS_PATH_RE.lastIndex = 0;
    return hits;
  }
  if (typeof value !== 'object') return hits;
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...scanSensitive(v, `${trail}[${i}]`)));
    return hits;
  }
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(k)) hits.push(`${trail}.${k}:sensitive_key`);
    hits.push(...scanSensitive(v, `${trail}.${k}`));
  }
  return hits;
}

/** 严格校验单个事件；返回 {ok, reason} 或 {ok:true, clean} */
function validateEvent(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reasons: ['event_not_object'] };

  const unknown = Object.keys(raw).filter((k) => !ALLOWED_EVENT_FIELDS.has(k));
  if (unknown.length) problems.push(`unknown_fields:${unknown.join(',')}`);

  const sensitive = scanSensitive(raw, 'event');
  if (sensitive.length) problems.push(`sensitive:${sensitive.slice(0, 5).join('|')}`);

  for (const f of ['event_id', 'task_id', 'report_type', 'business_date', 'stage']) {
    if (!raw[f] || typeof raw[f] !== 'string') problems.push(`missing_or_invalid:${f}`);
  }
  if (problems.length) return { ok: false, reasons: problems };

  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(raw.event_id)) problems.push('event_id_format');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.business_date)) problems.push('business_date_format');
  if (!STAGES.includes(raw.stage)) problems.push(`stage_not_allowed:${raw.stage}`);
  if (LOCKED_REPORT_TYPES.has(raw.report_type)) problems.push('report_type_locked');
  else if (!AUTHORIZED_REPORT_TYPES.has(raw.report_type)) problems.push(`report_type_not_authorized:${raw.report_type}`);
  if (raw.at && Number.isNaN(Date.parse(raw.at))) problems.push('at_not_iso');

  for (const bucket of ['metrics', 'detail']) {
    const b = raw[bucket];
    if (b === undefined) continue;
    if (!b || typeof b !== 'object' || Array.isArray(b)) { problems.push(`${bucket}_not_object`); continue; }
    const bad = Object.keys(b).filter((k) => !ALLOWED_METRIC_FIELDS.has(k));
    if (bad.length) problems.push(`${bucket}_unknown_fields:${bad.join(',')}`);
  }
  // ---- 摘要前缀（上线前收紧）----
  // 显式 sha256_prefix 必须为 1..12 位 hex；不合法即**拒绝事件**（绝不静默吞掉，也绝不落完整值）。
  // 完整 sha256 沿用既有"入站即截断为前缀"的口径，只用于派生前缀；
  // 两者同批出现时以**显式 sha256_prefix 为准**（避免字段顺序决定结果）。
  let explicitShaPrefix = null;
  for (const bucket of ['metrics', 'detail']) {
    const b = raw[bucket];
    if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
    if (b.sha256_prefix === undefined) continue;
    const p = String(b.sha256_prefix === null ? '' : b.sha256_prefix).trim().toLowerCase();
    if (/^[0-9a-f]{1,12}$/.test(p)) explicitShaPrefix = p;
    else problems.push('sha256_prefix_invalid');
  }
  // 测试标记校验：is_test 必须为布尔真；带 is_test 时必须给合法 test_run_id，
  // 且 task_id / event_id 必须带 test- 前缀（防伪造，并让清理可按 run 精确限定）。
  const isTest = raw.is_test === true || raw.is_test === 1;
  if (raw.is_test !== undefined && !isTest) problems.push('is_test_must_be_true');
  let testRunId = '';
  if (isTest) {
    testRunId = String(raw.test_run_id || '');
    if (!TEST_RUN_ID_RE.test(testRunId)) problems.push(`test_run_id_invalid:${testRunId.slice(0, 40)}`);
    if (!String(raw.task_id).startsWith('test-')) problems.push('test_task_id_needs_test_prefix');
    if (!String(raw.event_id).startsWith('test-')) problems.push('test_event_id_needs_test_prefix');
  } else if (raw.test_run_id !== undefined && raw.test_run_id !== '') {
    problems.push('test_run_id_requires_is_test');
  }
  if (problems.length) return { ok: false, reasons: problems };

  const clean = {
    event_id: raw.event_id,
    task_id: raw.task_id,
    is_test: isTest ? 1 : 0,
    test_run_id: testRunId,
    platform: typeof raw.platform === 'string' && raw.platform ? raw.platform : 'meituan',
    report_type: raw.report_type,
    business_date: raw.business_date,
    stage: raw.stage,
    status: typeof raw.status === 'string' ? raw.status.slice(0, 40) : '',
    at: raw.at && !Number.isNaN(Date.parse(raw.at)) ? new Date(raw.at).toISOString() : new Date().toISOString(),
    seq: Number.isFinite(Number(raw.seq)) ? Number(raw.seq) : null,
    metrics: {},
    detail: {},
  };
  for (const bucket of ['metrics', 'detail']) {
    const b = raw[bucket];
    if (!b) continue;
    for (const [k, v] of Object.entries(b)) {
      if (k === 'sha256_prefix') continue;   // 已在校验阶段取出（explicitShaPrefix）
      if (k === 'sha256') { if (!explicitShaPrefix) clean.metrics.sha256_prefix = String(v || '').slice(0, DEFAULT_SHA_PREFIX_LEN); continue; }
      if (k === 'original_filename') { clean.metrics.original_filename = stripPath(v).slice(0, 200); continue; }
      if (k === 'failure_reason') { clean.metrics.failure_reason = String(v || '').slice(0, 500).replace(ABS_PATH_RE, '[path]'); continue; }
      if (typeof v === 'string') clean[bucket][k] = v.slice(0, 500).replace(ABS_PATH_RE, '[path]');
      else clean[bucket][k] = v;
    }
  }
  if (explicitShaPrefix) clean.metrics.sha256_prefix = explicitShaPrefix;
  return { ok: true, clean };
}

function runKeyOf({ platform, report_type, business_date, task_id }) {
  return `${platform}|${report_type}|${business_date}|${task_id}`;
}

/** 由事件序列推导运行状态与阶段 */
function deriveStatus(stage) {
  if (FAILURE_STAGES.has(stage)) return 'failed';
  if (stage === 'WAITING_HUMAN') return 'waiting_human';
  if (SUCCESS_STAGES.has(stage)) return 'success';
  return 'running';
}

function boolInt(v) {
  return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
}

/**
 * 入库（幂等）。返回 {accepted, duplicates, rejected:[{event_id,reasons}], runs:[run_key]}
 */
function ingestEvents(db, events, opts = {}) {
  const accepted = [];
  const duplicates = [];
  const rejected = [];
  const nowIso = opts.now || new Date().toISOString();

  for (const raw of events) {
    const v = validateEvent(raw);
    if (!v.ok) {
      rejected.push({ event_id: raw && raw.event_id ? String(raw.event_id).slice(0, 64) : null, reasons: v.reasons });
      continue;
    }
    const e = v.clean;
    const existing = db.queryOne('SELECT id FROM sync_job_events WHERE event_id=?', [e.event_id]);
    if (existing) { duplicates.push(e.event_id); continue; }

    const key = runKeyOf(e);
    let run = db.queryOne('SELECT * FROM sync_job_runs WHERE run_key=?', [key]);
    if (!run) {
      const id = db.insert(
        `INSERT INTO sync_job_runs (run_key,task_id,platform,report_type,business_date,phase,status,started_at,event_count,first_event_at,last_event_at,is_test,test_run_id)
         VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?)`,
        [key, e.task_id, e.platform, e.report_type, e.business_date, e.stage, deriveStatus(e.stage), e.at, e.at, e.at, e.is_test, e.test_run_id]
      );
      run = db.queryOne('SELECT * FROM sync_job_runs WHERE id=?', [id]);
    }

    // 防污染：非测试事件不得复用某个测试 run 的 task_id，否则会在测试 run 下混入真实事件，
    // 清理时要么漏删、要么误删，两种都不可接受。直接拒绝。
    if (!e.is_test && run && run.is_test === 1) {
      rejected.push({ event_id: e.event_id, reasons: ['task_id_belongs_to_test_run'] });
      continue;
    }
    const m = Object.assign({}, e.detail, e.metrics);
    const importedFlag = m.imported !== undefined ? boolInt(m.imported) : (e.stage === 'IMPORT_SUCCEEDED' ? 1 : null);
    const pushedFlag = m.pushed !== undefined ? boolInt(m.pushed) : (e.stage === 'PUSH_SUCCEEDED' ? 1 : null);
    const status = deriveStatus(e.stage);

    db.run('INSERT INTO sync_job_events (event_id,run_id,task_id,platform,report_type,business_date,stage,status,at,seq,detail_json,is_test,test_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [
      e.event_id, run.id, e.task_id, e.platform, e.report_type, e.business_date,
      e.stage, status, e.at, e.seq, JSON.stringify(Object.assign({}, e.metrics, e.detail)).slice(0, 8000),
      e.is_test, e.test_run_id,
    ]);

    const sets = [
      'phase=?', 'status=?',
      'event_count=(SELECT COUNT(*) FROM sync_job_events WHERE run_id=?)',
      'first_event_at=COALESCE(first_event_at,?)',
      'last_event_at=?',
      "updated_at=datetime('now','localtime')",
    ];
    const vals = [e.stage, status, run.id, e.at, e.at];

    const assign = (col, val) => { if (val !== undefined && val !== null && val !== '') { sets.push(`${col}=?`); vals.push(val); } };
    assign('started_at', m.started_at);
    assign('finished_at', m.finished_at);
    assign('duration_ms', Number.isFinite(Number(m.duration_ms)) ? Number(m.duration_ms) : undefined);
    assign('failure_reason', m.failure_reason);
    assign('original_filename', m.original_filename);
    assign('file_size', Number.isFinite(Number(m.file_size)) ? Number(m.file_size) : undefined);
    assign('sha256_prefix', m.sha256_prefix);
    assign('import_batch_id', Number.isFinite(Number(m.import_batch_id)) ? Number(m.import_batch_id) : undefined);
    assign('raw_store_count', Number.isFinite(Number(m.raw_store_count)) ? Number(m.raw_store_count) : undefined);
    assign('matched_store_count', Number.isFinite(Number(m.matched_store_count)) ? Number(m.matched_store_count) : undefined);
    assign('push_status', m.push_status);
    assign('screenshot_count', Number.isFinite(Number(m.screenshot_count)) ? Number(m.screenshot_count) : undefined);
    if (m.ready_to_push !== undefined) assign('ready_to_push', boolInt(m.ready_to_push));
    if (importedFlag !== null) assign('imported', importedFlag);
    if (pushedFlag !== null) assign('pushed', pushedFlag);
    if (m.is_backfill !== undefined) assign('is_backfill', boolInt(m.is_backfill));
    if (m.reconstructed !== undefined) assign('reconstructed', boolInt(m.reconstructed));
    if (m.not_a_realtime_success !== undefined) assign('not_a_realtime_success', boolInt(m.not_a_realtime_success));
    if (m.validation !== undefined) assign('validation_json', JSON.stringify(m.validation).slice(0, 4000));
    if (m.evidence !== undefined) assign('evidence_json', JSON.stringify(m.evidence).slice(0, 4000));
    if (e.stage === 'PUSH_SUCCEEDED') assign('push_status', 'success');
    if (e.stage === 'PUSH_FAILED') assign('push_status', 'failed');
    if (FAILURE_STAGES.has(e.stage)) assign('failure_reason', m.failure_reason || `${e.stage}`);

    vals.push(run.id);
    db.run(`UPDATE sync_job_runs SET ${sets.join(',')} WHERE id=?`, vals);
    accepted.push(e.event_id);
  }

  if (accepted.length || duplicates.length) db.save();
  const runs = db.queryAll(
    `SELECT * FROM sync_job_runs WHERE run_key IN (${events.map(() => '?').join(',') || "''"})`,
    events.map((raw) => {
      const v = validateEvent(raw);
      return v.ok ? runKeyOf(v.clean) : '__invalid__';
    })
  ).map((r) => r.run_key);
  return { accepted, duplicates, rejected, runs, ingested_at: nowIso };
}

// ===== 页面读取（只输出脱敏后的字段；绝不返回路径/密钥/令牌） =====
function runView(row) {
  return {
    id: row.id,
    task_id: row.task_id,
    platform: row.platform,
    report_type: row.report_type,
    business_date: row.business_date,
    phase: row.phase,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_ms: row.duration_ms,
    failure_reason: row.failure_reason || '',
    original_filename: row.original_filename || '',
    file_size: row.file_size,
    sha256_prefix: row.sha256_prefix || '',
    import_batch_id: row.import_batch_id,
    raw_store_count: row.raw_store_count,
    matched_store_count: row.matched_store_count,
    ready_to_push: !!row.ready_to_push,
    push_status: row.push_status || '',
    imported: !!row.imported,
    pushed: !!row.pushed,
    is_backfill: !!row.is_backfill,
    reconstructed: !!row.reconstructed,
    not_a_realtime_success: !!row.not_a_realtime_success,
    screenshot_count: row.screenshot_count || 0,
    event_count: row.event_count || 0,
    first_event_at: row.first_event_at,
    last_event_at: row.last_event_at,
  };
}

function listRuns(db, filters = {}) {
  const clauses = [];
  const values = [];
  if (filters.platform) { clauses.push('platform=?'); values.push(String(filters.platform)); }
  if (filters.report_type) { clauses.push('report_type=?'); values.push(String(filters.report_type)); }
  if (filters.date_from) { clauses.push('business_date>=?'); values.push(String(filters.date_from)); }
  if (filters.date_to) { clauses.push('business_date<=?'); values.push(String(filters.date_to)); }
  if (filters.status) { clauses.push('status=?'); values.push(String(filters.status)); }
  if (filters.is_backfill === '1' || filters.is_backfill === true) clauses.push('is_backfill=1');
  if (filters.is_backfill === '0' || filters.is_backfill === false) clauses.push('is_backfill=0');
  if (filters.imported === '1') clauses.push('imported=1');
  if (filters.imported === '0') clauses.push('imported=0');
  if (filters.pushed === '1') clauses.push('pushed=1');
  if (filters.pushed === '0') clauses.push('pushed=0');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const pageSize = Math.min(100, Math.max(5, Number(filters.page_size) || 20));
  const page = Math.max(1, Number(filters.page) || 1);
  const total = Number(db.queryOne(`SELECT COUNT(*) AS total FROM sync_job_runs ${where}`, values)?.total || 0);
  const rows = db.queryAll(
    `SELECT * FROM sync_job_runs ${where} ORDER BY COALESCE(last_event_at, created_at) DESC, id DESC LIMIT ? OFFSET ?`,
    [...values, pageSize, (page - 1) * pageSize]
  );
  return { total, page, page_size: pageSize, runs: rows.map(runView) };
}

function getRun(db, id) {
  const row = db.queryOne('SELECT * FROM sync_job_runs WHERE id=?', [Number(id)]);
  if (!row) return null;
  const events = db.queryAll('SELECT event_id,stage,status,at,seq,detail_json FROM sync_job_events WHERE run_id=? ORDER BY COALESCE(seq, 999999), id', [row.id])
    .map((e) => {
      let detail = {};
      try { detail = JSON.parse(e.detail_json || '{}'); } catch { detail = {}; }
      return { stage: e.stage, status: e.status, at: e.at, seq: e.seq, detail };
    });
  let validation = {};
  let evidence = {};
  try { validation = JSON.parse(row.validation_json || '{}'); } catch { validation = {}; }
  try { evidence = JSON.parse(row.evidence_json || '{}'); } catch { evidence = {}; }
  return { run: runView(row), events, validation, evidence };
}

function overview(db) {
  const today = new Date().toISOString().slice(0, 10);
  const latest = db.queryOne('SELECT * FROM sync_job_runs ORDER BY COALESCE(last_event_at, created_at) DESC, id DESC LIMIT 1');
  const lastSuccess = db.queryOne("SELECT * FROM sync_job_runs WHERE status='success' ORDER BY COALESCE(finished_at,last_event_at) DESC LIMIT 1");
  const todayCounts = db.queryOne(
    `SELECT
       SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,
       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status='waiting_human' THEN 1 ELSE 0 END) AS waiting_human,
       SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running
     FROM sync_job_runs WHERE business_date=?`, [today]);
  const pending = Number(db.queryOne(
    "SELECT COUNT(*) AS n FROM sync_job_runs WHERE status IN ('failed','waiting_human') AND COALESCE(pushed,0)=0")?.n || 0);
  return {
    today,
    latest: latest ? runView(latest) : null,
    last_success_at: lastSuccess ? (lastSuccess.finished_at || lastSuccess.last_event_at) : null,
    last_success_business_date: lastSuccess ? lastSuccess.business_date : null,
    today_counts: {
      success: Number(todayCounts?.success || 0),
      failed: Number(todayCounts?.failed || 0),
      waiting_human: Number(todayCounts?.waiting_human || 0),
      running: Number(todayCounts?.running || 0),
    },
    pending_exceptions: pending,
  };
}

/**
 * 精确清理**本次测试运行**的 fixture（内部测试专用能力，不是泛用删除接口）
 *
 * 只允许删除 `is_test=1 AND test_run_id=<给定值>` 的 runs/events，并在事务内执行。
 * 明确拒绝：空 test_run_id、非法格式、以及任何"按日期/按 task_id 模糊匹配"的用法
 * （本函数只接受一个精确 test_run_id，不接受日期或类似名）。
 * 绝不触碰：真实任务、历史补录、其它测试运行、非 test 记录。
 */
function cleanupTestRun(db, testRunId) {
  const id = String(testRunId || '');
  if (!id) return { ok: false, refused: true, reason: 'test_run_id_required' };
  if (!TEST_RUN_ID_RE.test(id)) return { ok: false, refused: true, reason: `test_run_id_invalid:${id.slice(0, 40)}` };
  // 防线：若同一 test_run_id 下存在非 test 记录，说明数据异常，直接拒绝清理
  const nonTest = db.queryOne('SELECT COUNT(*) AS n FROM sync_job_runs WHERE test_run_id=? AND (is_test IS NULL OR is_test<>1)', [id]).n;
  if (Number(nonTest) > 0) return { ok: false, refused: true, reason: 'non_test_rows_share_this_test_run_id' };
  const runIds = db.queryAll('SELECT id FROM sync_job_runs WHERE is_test=1 AND test_run_id=?', [id]).map((r) => r.id);
  let deletedEvents = 0;
  let deletedRuns = 0;
  db.run('BEGIN');
  try {
    // 事件删除按"归属于本次测试运行的 run"精确限定：既覆盖事件自身带测试标记的情况，
    // 也覆盖因 task_id 复用而落在该测试 run 下的非 test 事件（否则清理后会留下孤儿行）。
    const idList = runIds.length ? runIds.join(',') : '-1';
    deletedEvents = db.run(`DELETE FROM sync_job_events WHERE run_id IN (${idList}) OR (is_test=1 AND test_run_id=?)`, [id]) || 0;
    deletedRuns = db.run('DELETE FROM sync_job_runs WHERE is_test=1 AND test_run_id=?', [id]) || 0;
    db.run('COMMIT');
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (_) {}
    return { ok: false, refused: false, reason: `cleanup_failed:${String(e && e.message).slice(0, 120)}` };
  }
  db.save();
  return { ok: true, test_run_id: id, deleted_events: deletedEvents, deleted_runs: deletedRuns, matched_run_ids: runIds.length };
}

module.exports = {
  STAGES, FAILURE_STAGES, SUCCESS_STAGES, AUTHORIZED_REPORT_TYPES, LOCKED_REPORT_TYPES,
  TOLERANCE_MS, ALLOWED_EVENT_FIELDS, ALLOWED_METRIC_FIELDS, TEST_RUN_ID_RE,
  loadSecret, verifySignature, signPayload, timestampAcceptable, closeEnough,
  stripPath, scanSensitive, validateEvent, deriveStatus, runKeyOf,
  ingestEvents, listRuns, getRun, overview, runView, cleanupTestRun,
};
