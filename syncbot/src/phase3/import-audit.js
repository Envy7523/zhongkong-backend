'use strict';
/**
 * 阶段3 审计接线 · **正式导入边界**（未来真实导入的唯一入口）
 *
 * 硬性规则（逐条对应）：
 *  1. IMPORT_STARTED 只在「正式导入请求发出之前」且 **G3 覆盖闸门通过之后** 发送；
 *  2. 覆盖命中 / 日期重复 / 文件校验失败 / 人工确认缺失 / 导入返回异常 → **绝不调用导入接口**，
 *     只发 WAITING_HUMAN 或 IMPORT_FAILED，并保持 ready_to_push=false（事件里显式记 ready_to_push=0）；
 *  3. IMPORT_SUCCEEDED 仅在接口成功 **且** 导入后验收全通过后发送：业务日期与 Excel 营业日期一致、
 *     raw_imported == 本次文件门店行数、matched_stores == raw_imported、imported == 响应自报（且与文件数据行数一致）、
 *     errors 为空、合计金额与库内聚合一致（容差 0.01）、且 SHA/batch_id/业务日期均已（经正式脱敏路径）记录；
 *     **期望值一律由 expectedFrom({fileStoreRows, declared, fileDataRows}) 从本次运行事实推导，
 *     不得回落任何固定门店数/固定行数**；matched_stores < raw_imported ⇒ **WAITING_HUMAN**（不猜、不重做）；
 *  4. 审计失败只进 outbox / audit_pending：绝不重试导入、不阻塞已完成导入、不让 ready_to_push 变 true；
 *  5. IMPORT_* / WAITING_HUMAN 的 event_id 稳定可重放（固定 seq），崩溃恢复/补送只会得到服务端 duplicate；
 *  6. 本模块**不写数据库**：真实导入只能经正式 HTTP 导入接口（由调用方注入的 importFn 承担）；
 *  7. 审计内容禁止 JWT/HMAC/Cookie/口令/绝对路径/完整 SHA/Excel 原文/门店敏感明细 ——
 *     进入事件前统一 scrubText，且 13 阶段契约另有一层白名单与路径清洗。
 *
 * 检查点**批量发送**（本次变更）：
 *  - C3：IMPORT_STARTED（闸门全通过、正式导入请求发出**之前**）立即发；
 *  - C4：IMPORT_SUCCEEDED 或 IMPORT_FAILED（导入后验收结束）立即发；
 *  - WAITING_HUMAN 立即 flush，不等任何延时窗口；
 *  - 事件仍先逐条落盘（audit-batcher.add）再入缓冲，故崩溃/退出时既有 OUTBOX.flush 仍能补送；
 *  - whenIdle / 锁释放路径**只发送已缓冲事件**，不制造新事件、不制造额外 POST。
 *
 * 正式导入边界（本轮接线，仍用注入式 importFn）：
 *  - createImportAudit({ importClient }) 可绑定 phase3/import-client 的**正式 HTTP 客户端**；
 *  - makeRealImportFn() 产出"未来真实边界"的 importFn：本地闸门 → 取令牌 → 单次 POST；
 *    未配置客户端时 fail-closed 返回 import_client_not_configured，**不发任何请求**；
 *  - 同一实例一旦有终态（IMPORT_SUCCEEDED / IMPORT_FAILED）即拒绝再次执行导入
 *    （零自动重试、零重复导入）；响应丢失后的重放只会得到同一 event_id 的 duplicate；
 *  - 客户端返回的 error_code（401/403/409/超时/本地闸门…）优先作为 IMPORT_FAILED 的原因码，
 *    信息不足时才退回既有的 http_4xx/http_5xx 口径。
 *
 * 摘要字段（完整 SHA 处理 · 上线前收紧 → 中控补丁已上线）：
 *  - **默认 auditShaField='sha256_prefix'**（中控白名单补丁 a2c7e2f1… 已在线上并通过自检）：
 *    事件只带 12 位前缀字段 `sha256_prefix`；**完整 SHA 绝不进入 outbox / 审计事件 / 任务状态**，
 *    完整摘要只在内存中供"七项验收"比对，对外只保留 12 位前缀（real_import.file.sha256_prefix）；
 *  - 显式 `auditShaField:'off'` 可作为应急开关（完全不发摘要字段）；
 *  - **已明确禁止**把 12 位前缀塞进名为 sha256 的字段（"sha256_prefix_as_sha256"）：
 *    任何非 off / sha256_prefix 的取值一律回落为 off（宁可审计侧暂时没有摘要，也不混用字段语义）。
 *
 * 重复导入（**只读确认**）：正式导入接口**没有**重复日期拦截，落库为
 * "先删后插"的原地覆盖；因此 409 仅作兼容分支，真实防重复依赖
 * G3 覆盖闸门 + 已持久化终态任务状态 + 客户端的本地终态闸（发 HTTP 前拦截，0 请求）。
 */
const MAP = require('./audit-stage-map');
const OUTBOX = require('./audit-outbox');
const BAT = require('./audit-batcher');
const { DEFAULT_IDLE_TIMEOUT_MS } = require('./audit-queue');
const { scrubText } = require('./real-download-audit');

/** 审计摘要字段默认模式：中控 sha256_prefix 白名单补丁上线后的终态 */
const DEFAULT_AUDIT_SHA_FIELD = 'sha256_prefix';

/** kind → 13 阶段契约里的 STAGE（用于 summary 展示；push_* 由阶段4 推送边界使用） */
const KIND_TO_STAGE = {
  import_start: 'IMPORT_STARTED', import_ok: 'IMPORT_SUCCEEDED', import_fail: 'IMPORT_FAILED',
  push_ok: 'PUSH_SUCCEEDED', push_fail: 'PUSH_FAILED', waiting_human: 'WAITING_HUMAN',
};

/** 导入侧检查点：每个 kind 都是"立即 flush"（批量成员由缓冲内容 + seq 排序决定） */
const IMPORT_CHECKPOINTS = { import_start: 'C3', import_ok: 'C4', import_fail: 'C4', waiting_human: 'WAITING_HUMAN' };

/** 需要人工决策 → WAITING_HUMAN */
const HUMAN_CODES = new Set(['coverage_gate_hit', 'coverage_gate_failed', 'duplicate_business_date', 'file_validation_needs_human', 'human_confirmation_required', 'matched_stores_short']);
/** 确定性失败 → IMPORT_FAILED */
const FAILED_CODES = new Set([
  'file_validation_failed', 'import_http_4xx', 'import_http_5xx', 'import_http_error',
  'import_timeout', 'import_exception', 'import_result_incomplete', 'verify_failed',
  // 正式导入客户端可声明的原因码（401/403/409 与本地闸门）——白名单式，绝不透传任意服务端文本
  'import_http_401', 'import_http_403', 'import_http_409', 'import_response_invalid',
  'import_client_not_configured', 'import_login_transport_error', 'import_login_response_invalid',
  'file_not_validated', 'file_outside_archive_dir', 'file_changed_after_validation', 'file_unreadable',
  'importer_secrets_missing', 'importer_secrets_unreadable', 'importer_secrets_incomplete', 'importer_secrets_mode_too_open',
  'report_type_not_allowed', 'report_type_locked_or_unregistered', 'platform_not_allowed',
  'business_date_invalid', 'endpoint_not_loopback', 'endpoint_invalid',
  // 重复导入本地终态闸（防重复导入的最后一道防线；发 HTTP 之前拦截）
  'duplicate_business_date_local', 'duplicate_state_unreadable',
]);
/** 客户端声明的原因码白名单口径：小写标识符，长度受限（防止把服务端任意文本当原因码回传） */
const DECLARED_CODE_RE = /^[a-z][a-z0-9_]{2,40}$/;

/**
 * 由**本次运行事实**推导导入验收期望值（口径冻结 R6）。
 * **不得**出现任何固定门店数/固定行数字面量；推导不出来的字段一律为 null（= 不比较），
 * 由「响应自报 + 内部一致性」兜底，绝不回落成历史常量。
 *
 * @param {{fileStoreRows?:number|null, declared?:number|null, fileDataRows?:number|null}} facts
 *   fileStoreRows —— 文件门店行数（= 唯一有效门店数）
 *   declared      —— 查询步骤声明的有效门店数（fileStoreRows 缺失时的回退来源）
 *   fileDataRows  —— 文件数据行数（导入侧行数口径；文件侧不可单方面确定时为 null）
 * @returns {{raw_imported:number|null, matched_stores:number|null, imported:number|null, amount_tolerance:number, derived_from:object}}
 */
function expectedFrom(facts = {}) {
  const n = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  const fileStoreRows = n(facts.fileStoreRows);
  const declared = n(facts.declared);
  const fileDataRows = n(facts.fileDataRows);
  const storeRows = fileStoreRows !== null ? fileStoreRows : declared;
  return {
    raw_imported: storeRows,          // 期望：导入原始门店行数 == 文件门店行数
    matched_stores: storeRows,        // 期望：匹配门店数 == raw_imported（不足 ⇒ 转人工）
    imported: fileDataRows,           // 期望：导入行数 == 文件数据行数（不可得 ⇒ 走「响应自报」）
    amount_tolerance: 0.01,           // 金额容差保留 0.01
    derived_from: { fileStoreRows, declared, fileDataRows },
  };
}

/** 兼容导出的哨兵：全部为 null ⇒ 不做固定值比较（**绝不**再回落 22/154） */
const DEFAULT_EXPECTED = expectedFrom({});

/**
 * 导入后验收：只产出**原因码 + 字段名 + 差值**，不带原始值/明细。
 * 口径（冻结）：
 *  - raw_imported === fileStoreRows（期望值可得时严格等值）
 *  - matched_stores === raw_imported；**matched < raw ⇒ matched_stores_short ⇒ 转人工（WAITING_HUMAN）**
 *  - imported === 响应自报 且（fileDataRows 可得时）=== fileDataRows
 *  - amount_tolerance 保留 0.01
 */
function verifyImportResult(r, expected = null, businessDate = null) {
  const e = Object.assign({}, DEFAULT_EXPECTED, expected || {});
  const problems = [];
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (!r || typeof r !== 'object') problems.push('result_missing');
  const src = r || {};
  if (businessDate && src.excel_business_date !== businessDate) problems.push('business_date_mismatch');
  const raw = num(src.raw_imported);
  const matched = num(src.matched_stores);
  const imported = num(src.imported);
  const expectedRaw = num(e.raw_imported);
  const expectedMatched = num(e.matched_stores);
  const expectedImported = num(e.imported);
  if (expectedRaw !== null && raw !== expectedRaw) problems.push('raw_imported_mismatch');
  if (expectedMatched !== null && matched !== expectedMatched) problems.push('matched_stores_mismatch');
  // matched < raw_imported ⇒ 未被中控静默吞掉的门店缺口 ⇒ 转人工（不是确定性失败，绝不自动重做）
  const shortBy = (raw !== null && matched !== null && matched < raw) ? raw - matched : 0;
  let human = false;
  let humanReason = null;
  if (shortBy > 0) { problems.push('matched_stores_short'); human = true; humanReason = 'matched_stores_short'; }
  if (expectedImported !== null) {
    if (imported !== expectedImported) problems.push('imported_mismatch');
  } else if (imported === null) {
    // 期望值不可得 ⇒ 至少要求「响应自报」了一个有限数（fail-closed，不臆造）
    problems.push('imported_missing');
  }
  if (!Array.isArray(src.errors) || src.errors.length !== 0) problems.push('errors_not_empty');
  // v0.3.6 冻结顺序：amount_missing → amount_basis_mismatch → amount_mismatch
  const a = num(src.amount_excel);
  const b = num(src.amount_db);
  let delta = null;
  let amountsBothNumeric = false;
  let pendingDelta = null;
  if (a === null || b === null) {
    problems.push('amount_missing');
  } else {
    amountsBothNumeric = true;
    pendingDelta = Math.round(Math.abs(a - b) * 100) / 100;
  }
  // ---- v0.3.3 金额口径（冻结）：scope 必须为 import_batch_id，且仅允许三组白名单映射 ----
  const FROZEN_BASIS_MAP = [ { file_column: '营业收入(元)', db_column: 'recorded_amount' }, { file_column: '营业额(元)', db_column: 'gross_amount' }, { file_column: '优惠金额(元)', db_column: 'discount_amount' } ];
  const basisOf = (o) => (o && typeof o === 'object' && o.amount_basis && typeof o.amount_basis === 'object') ? o.amount_basis : null;
  {
    const b = basisOf(src);
    const norm = (arr) => (Array.isArray(arr) ? arr.map((x) => String(x && x.file_column) + '|' + String(x && x.db_column)).sort().join(',') : null);
    if (amountsBothNumeric) {
      if (!b || b.scope !== 'import_batch_id') problems.push('amount_basis_mismatch');
      else if (norm(b.mappings) !== norm(FROZEN_BASIS_MAP)) problems.push('amount_basis_mismatch');
    }
  }
  if (amountsBothNumeric && pendingDelta !== null && !problems.some((x) => String(x).indexOf('amount_basis_mismatch') === 0)) {
    delta = pendingDelta;
    if (delta > e.amount_tolerance) problems.push('amount_mismatch(delta=' + delta + ')');
  }
  if (!src.import_batch_id) problems.push('batch_id_missing');
  if (!src.sha256) problems.push('sha256_missing');
  // 未匹配门店名单：**只出现在返回值 / 本地状态**，绝不进入审计 metrics（审计载荷禁止门店明细）
  const unmatched = Array.isArray(src.unmatched_stores) ? src.unmatched_stores.map((x) => scrubText(x, 60)).slice(0, 20) : [];
  // 动态门店数证据（期望值 + 缺口计数）**不进 metrics**：
  // 中控 lib/sync-job-audit.js:46-52 的 ALLOWED_METRIC_FIELDS 是白名单，任何新字段都必须与中控**同批**上线，
  // 否则整条事件被判 metrics_unknown_fields → 400 拒绝 → 审计全丢。
  // 因此这些字段只返回给调用方，由调用方写入**本地任务状态**（detail / state），绝不出现在 metrics。
  const dynamicEvidence = {
    raw_imported_expected: expectedRaw,
    matched_stores_expected: expectedMatched,
    // imported 的期望值：数值 = 文件数据行数；字符串 = 以响应自报为准（文件侧不可推导）
    imported_expected: expectedImported !== null ? expectedImported : 'response_self_reported',
    matched_short_by: shortBy,
    unmatched_count: unmatched.length,
  };
  if (num(e.store_count_dynamic) !== null) dynamicEvidence.store_count_dynamic = num(e.store_count_dynamic);
  if (num(e.absent_count) !== null) dynamicEvidence.absent_count = num(e.absent_count);
  return {
    ok: problems.length === 0,
    human: human,
    human_reason: humanReason,
    problems: problems.slice(0, 8),
    unmatched: unmatched,
    dynamic: dynamicEvidence,
    // metrics 载荷（validation）：**只保留原有形状的键**，不新增任何 metrics 字段/嵌套证据
    summary: {
      raw_imported: raw, matched_stores: matched, imported: imported,
      errors_empty: Array.isArray(src.errors) && src.errors.length === 0, amount_delta: delta,
      business_date_matched: businessDate ? src.excel_business_date === businessDate : null,
    },
  };
}

function createImportAudit({ ctx, outbox = OUTBOX, opts = {}, onPending = null, logger = null, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, batcher = null, importClient = null, onImportResult = null } = {}) {
  const client = importClient;
  // 摘要字段模式：默认 sha256_prefix（中控白名单补丁已上线）；显式 off 可应急关闭。
  // 未显式指定 → 用默认值；显式但取值非法（含已禁止的 "sha256_prefix_as_sha256"）→ 回落 off。
  const shaFieldOpt = opts.auditShaField;
  const auditShaField = shaFieldOpt === undefined ? DEFAULT_AUDIT_SHA_FIELD
    : (['off', 'sha256_prefix'].includes(shaFieldOpt) ? shaFieldOpt : 'off');
  const emitted = [];
  const pending = [];
  const byId = new Map();          // event_id → 同一 info 对象（批量结果按 event_id 回填）
  const seenSteps = new Set();
  // 发送超时：比上报 HTTP 超时略宽，且始终有限（默认 8s）。
  // 定时器**不能** unref —— unref 的定时器不维持事件循环，会让进程在等待中静默退出。
  const sendTimeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? Number(opts.timeoutMs) + 1000 : 8000;
  const batch = batcher || BAT.createAuditBatcher({ ctx, outbox, opts, logger, idleTimeoutMs });
  if (batch && typeof batch.setOnResult === 'function') batch.setOnResult(applyFlush);
  // whenIdle 有界超时同样入账（既有语义：超时不丢事件，只记 audit_pending(audit_idle_timeout)）
  if (batch && typeof batch.setOnIdleTimeout === 'function') {
    batch.setOnIdleTimeout((info) => recordPending({ phase: 'IMPORT', stage: 'AUDIT_IDLE', reason: 'audit_idle_timeout', pending_sends: info.pending_sends, at: new Date().toISOString() }));
  }
  let importStarted = null;
  let finishedKind = null;
  const realImports = [];   // 仅保存**脱敏**摘要（无 JWT/base64/绝对路径/完整 SHA）

  function recordPending(info) {
    pending.push(info);
    if (typeof onPending === 'function') { try { onPending(info); } catch (_) {} }
    if (logger && typeof logger.error === 'function') { try { logger.error('audit.pending', info); } catch (_) {} }
  }
  /** 记录一次"正式导入"的脱敏摘要：只留 basename / 大小 / 12 位前缀 / 计数 */
  function recordRealImport(res) {
    const safe = {
      ok: !!(res && res.ok === true),
      http: res && Number.isFinite(res.http) ? res.http : null,
      error_code: (res && typeof res.error_code === 'string') ? res.error_code : null,
      import_batch_id: (res && res.import_batch_id) || null,
      raw_imported: res && Number.isFinite(res.raw_imported) ? res.raw_imported : null,
      matched_stores: res && Number.isFinite(res.matched_stores) ? res.matched_stores : null,
      imported: res && Number.isFinite(res.imported) ? res.imported : null,
      attempts: res && Number.isFinite(res.attempts) ? res.attempts : null,
      requests: (res && res.requests) || null,
      file: (res && res.file) ? { name: res.file.name || null, size: res.file.size || null, sha256_prefix: res.file.sha256_prefix || null } : null,
      at: new Date().toISOString(),
    };
    realImports.push(safe);
    if (typeof onImportResult === 'function') { try { onImportResult(safe); } catch (_) {} }
    if (logger && typeof logger.info === 'function') { try { logger.info('audit.real_import', safe); } catch (_) {} }
    return safe;
  }

  /**
   * 产出"未来真实边界"的 importFn：不做任何业务判断，只负责调用正式 HTTP 客户端。
   * 未配置 importClient → fail-closed，**0 次请求**。
   */
  function makeRealImportFn({ file, reportType = (ctx && ctx.reportType), platform = (ctx && ctx.platform), businessDate = (ctx && ctx.businessDate), validation = null, evidence = {}, archiveSha256 = null, priorTerminal = null, importClient = client } = {}) {
    return async () => {
      if (!importClient || typeof importClient.importArchivedFile !== 'function') {
        const r = { ok: false, http: null, error_code: 'import_client_not_configured', reason: 'import_client_not_configured', attempts: 0, requests: { login: 0, import: 0 } };
        recordRealImport(r);
        return r;
      }
      const res = await importClient.importArchivedFile({ file, reportType, platform, businessDate, validation, evidence, archiveSha256, priorTerminal });
      recordRealImport(res);
      return res;
    };
  }

  /** 批量结果按 event_id 回填；失败事件逐条记 audit_pending（与逐条发送时同口径） */
  function applyFlush(res) {
    if (!res || !Array.isArray(res.results)) return;
    for (const r of res.results) {
      const info = byId.get(r.event_id);
      if (!info || info.__settled) continue;
      info.__settled = true;
      info.__inflight = false;
      info.status = r.status === undefined ? null : r.status;
      info.delivery_kind = r.delivery_kind || null;
      info.accepted = r.accepted || 0;
      info.duplicates = r.duplicates || 0;
      info.rejected_count = r.rejected_count || 0;
      info.batch_reason = r.batch_reason || null;
      info.batch_size = r.batch_size || 0;
      if (r.ok) { info.ok = true; info.queued = false; info.reason = null; }
      else {
        info.ok = false; info.queued = true;
        info.reason = scrubText(r.reason || 'send_failed', 120);
        recordPending({ kind: info.kind, stage: info.stage || null, reason: info.reason, at: new Date().toISOString() });
      }
    }
  }
  function recordSkip(kind, reason) {
    const info = { kind, ok: true, skipped: true, event_id: null, status: null, queued: false, delivery_kind: null, accepted: 0, duplicates: 0, rejected_count: 0, reason };
    emitted.push(info);
    return Promise.resolve(info);
  }
  /** 触发一次检查点批量发送（导入侧 4 类事件全部"立即发"）；有界：超时后不再等 HTTP 结果 */
  function checkpoint(reason) {
    const sent = batch.flush(reason);
    let timer = null;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve({ __send_deadline: true }), sendTimeoutMs); });
    return Promise.race([sent.then((res) => { applyFlush(res); return res; }, () => null), deadline]).then((res) => {
      if (timer) clearTimeout(timer);
      if (res && res.__send_deadline) {
        for (const info of emitted) {
          if (info.skipped || info.__settled || !info.__inflight) continue;
          info.__settled = true; info.__inflight = false;
          info.ok = false; info.queued = true; info.reason = 'audit_send_timeout';
          recordPending({ kind: info.kind, stage: info.stage || null, reason: 'audit_send_timeout', at: new Date().toISOString() });
        }
      }
    });
  }
  /** 固定 seq：import_start=1，结果事件=2 → event_id 稳定可重放 */
  function emitStep(kind, step, metrics) {
    if (seenSteps.has(kind)) return recordSkip(kind, 'same_step_in_process');
    seenSteps.add(kind);
    const stage = MAP.stageForStep(kind);
    if (!stage) return recordSkip(kind, 'unknown_step_kind:' + kind);
    const info = {
      kind, stage, ok: false, skipped: false, event_id: null, status: null, queued: true,
      delivery_kind: null, accepted: 0, duplicates: 0, rejected_count: 0, reason: null,
      batch_reason: null, batch_size: 0, __settled: false, __inflight: true,
    };
    emitted.push(info);
    // ---- 先落盘、再入缓冲 ----
    try {
      const event = batch.buildEvent({ stage, seq: step, metrics });
      info.event_id = event.event_id;
      byId.set(event.event_id, info);
      const added = batch.add(event);
      if (!added || added.ok !== true) {
        info.__settled = true; info.__inflight = false; info.ok = false; info.queued = false;
        info.reason = scrubText((added && added.reason) || 'outbox_write_failed', 120);
        recordPending({ kind, stage, reason: info.reason, at: new Date().toISOString() });
      }
    } catch (e) {
      info.__settled = true; info.__inflight = false; info.ok = false; info.queued = false;
      info.reason = scrubText((e && e.message) || 'audit_add_failed', 120);
      recordPending({ kind, stage, reason: info.reason, at: new Date().toISOString() });
    }
    // C3 / C4 / WAITING_HUMAN：立即进入发送队列（不等 maxBatchDelayMs）
    return checkpoint(IMPORT_CHECKPOINTS[kind] || kind).then(() => info);
  }
  const human = (code, metrics) => emitStep('waiting_human', 2, Object.assign({ note: code, ready_to_push: 0 }, metrics || {}));
  const failed = (code, metrics) => emitStep('import_fail', 2, Object.assign({ failure_reason: code, ready_to_push: 0 }, metrics || {}));

  /**
   * 导入前闸门：G3 覆盖闸门 → 日期重复 → 文件校验 → 人工确认。
   * 任一不通过都**不发出导入请求**，只发 WAITING_HUMAN / IMPORT_FAILED。
   */
  async function beforeImport({ coverageGate = null, duplicateCheck = null, validateFile = null, humanConfirmation = null, blocked = null } = {}) {
    // 编排层前置闸门（归档文件/SHA/元数据完整性/历史回填/终态…）：命中即由**真实边界**发出
    // WAITING_HUMAN（默认）或 IMPORT_FAILED，**绝不进入后续闸门、绝不发出 HTTP**。
    if (blocked && blocked.reason) {
      const extra = Object.assign({ ready_to_push: 0 }, blocked.metrics || {});
      if (blocked.action === 'IMPORT_FAILED') {
        await failed(blocked.reason, extra);
        return { allowed: false, action: 'IMPORT_FAILED', reason: blocked.reason, allow_push: false };
      }
      await human(blocked.reason, extra);
      return { allowed: false, action: 'WAITING_HUMAN', reason: blocked.reason, allow_push: false };
    }
    const call = async (fn) => { try { return fn ? await fn() : null; } catch (e) { return { ok: false, reason: scrubText(e && e.message, 120) }; } };
    const cov = await call(coverageGate);
    if (!cov || cov.ok !== true) {
      const code = cov && cov.coverage_hit ? 'coverage_gate_hit' : 'coverage_gate_failed';
      await human(code);
      return { allowed: false, action: 'WAITING_HUMAN', reason: code, allow_push: false };
    }
    const dup = await call(duplicateCheck);
    if (dup && dup.duplicate === true) {
      await human('duplicate_business_date');
      return { allowed: false, action: 'WAITING_HUMAN', reason: 'duplicate_business_date', allow_push: false };
    }
    const vf = await call(validateFile);
    if (!vf || vf.ok !== true) {
      const code = vf && vf.fatal === true ? 'file_validation_failed' : 'file_validation_needs_human';
      if (vf && vf.fatal === true) await failed(code);
      else await human(code);
      return { allowed: false, action: vf && vf.fatal === true ? 'IMPORT_FAILED' : 'WAITING_HUMAN', reason: code, allow_push: false };
    }
    const hc = await call(humanConfirmation);
    if (hc && hc.ok === false) {
      await human('human_confirmation_required');
      return { allowed: false, action: 'WAITING_HUMAN', reason: 'human_confirmation_required', allow_push: false };
    }
    // 闸门全通过 —— 此刻、且在请求发出之前才发 IMPORT_STARTED
    importStarted = await emitStep('import_start', 1, { note: 'gates_passed' });
    return { allowed: true, action: 'IMPORT_STARTED', reason: 'gates_passed', allow_push: false };
  }

  /** 导入后：验收全通过才 IMPORT_SUCCEEDED，否则 IMPORT_FAILED（且不允许推送） */
  async function afterImport(result, { expected = null, businessDate = null, pushFn = null } = {}) {
    if (finishedKind) return { action: finishedKind, allow_push: false, reason: 'already_finished' };
    const v = verifyImportResult(result, expected, businessDate);
    if (!v.ok) {
      // matched_stores < raw_imported：门店缺口不是确定性失败 ⇒ **转人工**（零自动重做、零推送）
      if (v.human) {
        finishedKind = 'WAITING_HUMAN';
        await human(v.human_reason || 'matched_stores_short', { validation: v.summary, note: v.problems.join(',') });
        return { action: 'WAITING_HUMAN', allow_push: false, reason: v.human_reason || 'matched_stores_short', problems: v.problems, verification: v.summary, verification_dynamic: v.dynamic, unmatched: v.unmatched };
      }
      finishedKind = 'IMPORT_FAILED';
      await failed('verify_failed', { validation: v.summary, note: v.problems.join(',') });
      return { action: 'IMPORT_FAILED', allow_push: false, reason: 'verify_failed', problems: v.problems, verification: v.summary, verification_dynamic: v.dynamic, unmatched: v.unmatched };
    }
    finishedKind = 'IMPORT_SUCCEEDED';
    // 摘要字段：**默认一个都不发**（完整 SHA 绝不落 outbox/审计事件/任务状态）。
    // 完整摘要仅存在于内存的验收对象中；对外只保留 12 位前缀。
    const shaPrefix = (result && result.file && result.file.sha256_prefix)
      || (result && result.sha256 ? String(result.sha256).slice(0, 12) : null);
    const okMetrics = {
      raw_store_count: v.summary.raw_imported,
      matched_store_count: v.summary.matched_stores,
      imported: v.summary.imported,
      import_batch_id: result.import_batch_id,
      validation: v.summary,
      note: 'verified_after_import',
      // 注意：**不得**把诊断字段（如摘要模式）写进事件 metrics ——
      // 中控 lib/sync-job-audit.js 的 ALLOWED_METRIC_FIELDS 是白名单，
      // 任何未登记的字段都会让整条事件被判 metrics_unknown_fields 并 400 拒绝。
      // 摘要模式只出现在本地 summary().audit_sha_field，绝不进入审计载荷。
    };
    if (auditShaField === 'sha256_prefix' && shaPrefix) okMetrics.sha256_prefix = shaPrefix;
    await emitStep('import_ok', 2, okMetrics);
    // 仅在此处给出"可推送"信号；推送本身属于未来的独立边界，本模块绝不触发
    return { action: 'IMPORT_SUCCEEDED', allow_push: true, reason: 'verified', verification: v.summary, verification_dynamic: v.dynamic, pushFn_unused: typeof pushFn === 'function' };
  }

  /**
   * 受闸门保护的导入执行：注入 coverageGate/duplicateCheck/validateFile/humanConfirmation/importFn。
   * importFn 只会被调用**一次**（从不重试）；业务锁在等待审计之前释放。
   */
  async function runGuardedImport({ coverageGate = null, duplicateCheck = null, validateFile = null, humanConfirmation = null, importFn, expected = null, businessDate = null, lockHandle = null, idleTimeoutMs: waitMs = undefined, onImportCall = null, blocked = null } = {}) {
    // 终态幂等闸：同一实例一旦已有终态，绝不再执行一次导入（零自动重试 / 零重复导入，
    // 崩溃重放与响应丢失重放都走"同一 event_id → 服务端 duplicate"，而不是第二次导入请求）。
    if (finishedKind) {
      return { ok: false, action: finishedKind, reason: 'already_finished', allow_push: false, import_calls: 0, refused: true };
    }
    let decision = { allowed: false, action: null, reason: null, allow_push: false };
    let result = null;
    let importCalls = 0;
    try {
      decision = await beforeImport({ coverageGate, duplicateCheck, validateFile, humanConfirmation, blocked });
      if (!decision.allowed) return { ok: false, action: decision.action, reason: decision.reason, allow_push: false, import_calls: 0 };
      importCalls += 1;
      if (typeof onImportCall === 'function') { try { onImportCall({ businessDate }); } catch (_) {} }
      let res;
      try {
        res = await importFn();
      } catch (e) {
        const msg = String((e && e.message) || e);
        const code = /timeout|timed out|ETIMEDOUT/i.test(msg) ? 'import_timeout' : 'import_exception';
        finishedKind = 'IMPORT_FAILED';
        await failed(code, { note: scrubText(msg, 120) });
        return { ok: false, action: 'IMPORT_FAILED', reason: code, allow_push: false, import_calls: importCalls };
      }
      const http = res && Number.isFinite(res.http) ? res.http : (res && Number.isFinite(res.status) ? res.status : null);
      if (!res || res.ok !== true) {
        // 优先采用调用方**声明且在白名单内**的原因码（401/403/409/超时/本地闸门…），
        // 否则退回既有的 http_4xx / http_5xx / http_error 口径。
        const declared = res && typeof res.error_code === 'string' && DECLARED_CODE_RE.test(res.error_code) ? res.error_code : null;
        const code = declared && FAILED_CODES.has(declared) ? declared
          : (http && http >= 500 ? 'import_http_5xx' : (http && http >= 400 ? 'import_http_4xx' : 'import_http_error'));
        finishedKind = 'IMPORT_FAILED';
        await failed(code, { note: http ? `http_${http}` : scrubText((res && (res.error_code || res.error)) || 'no_result', 80) });
        return { ok: false, action: 'IMPORT_FAILED', reason: code, http, allow_push: false, import_calls: importCalls };
      }
      result = await afterImport(res, { expected, businessDate });
      return Object.assign({ ok: result.action === 'IMPORT_SUCCEEDED', import_calls: importCalls, http, result: res }, result);
    } finally {
      // 业务锁与审计等待解耦：先释放锁，再（有界地）等审计落地
      if (lockHandle && typeof lockHandle.release === 'function') { try { lockHandle.release(); } catch (_) {} }
    }
  }

  /** 有界等待：**只发送已缓冲事件**；缓冲为空时不产生任何 POST，也绝不制造新事件 */
  function whenIdle(o = {}) { return batch.whenIdle(o); }
  function summary() {
    return {
      import_started_event_id: importStarted && importStarted.event_id ? importStarted.event_id : null,
      emitted: emitted.map((e) => ({
        kind: e.kind, ok: e.ok, skipped: !!e.skipped, event_id: e.event_id, status: e.status,
        queued: e.queued, delivery_kind: e.delivery_kind, accepted: e.accepted, duplicates: e.duplicates, rejected_count: e.rejected_count,
      })),
      emitted_kinds: emitted.filter((e) => e.ok && !e.skipped).map((e) => KIND_TO_STAGE[e.kind] || null).filter(Boolean),
      skipped: emitted.filter((e) => e.skipped).map((e) => ({ kind: e.kind, reason: e.reason })),
      pending_count: pending.length,
      pending: pending,
      audit_sha_field: auditShaField,
      batch: typeof batch.summary === 'function' ? batch.summary() : null,
      real_import_count: realImports.length,
      real_import: realImports.length ? realImports[realImports.length - 1] : null,
      import_client_configured: !!(client && typeof client.importArchivedFile === 'function'),
    };
  }
  return { beforeImport, afterImport, runGuardedImport, whenIdle, summary, emitStep, makeRealImportFn, realImports };
}

module.exports = { createImportAudit, verifyImportResult, expectedFrom, DEFAULT_EXPECTED, HUMAN_CODES, FAILED_CODES };
