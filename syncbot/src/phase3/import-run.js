'use strict';
/**
 * 阶段3 · **真实导入编排入口**（唯一允许调用正式导入 HTTP 客户端的边界）
 *
 * 设计约束（逐条对应本轮要求）：
 *  1. 只接受 report_type = 'cashier_composite'（TaskContext 先拒绝未授权报表，再显式白名单二次确认；
 *     报表 B item_sales_detail 在任何一步都会被拒，不建目录、不接线）；
 *  2. 输入 = **已归档文件** + archive / task 元数据；元数据不完整一律拒绝；
 *  3. 顺序（全部 HTTP 之前完成）：
 *       ① 归档文件闸门（目录内、非符号链接越界、普通文件、非空、validateReportAFile 通过）
 *       ② 源文件 SHA 闸门（与归档元数据比对）
 *       ③ 业务日期一致性闸门
 *       ④ 本地已持久化终态闸门（success/failed/waiting_human 任一即为终态 → 不再导入）
 *       ⑤ 历史回填闸门（historical_backfill 绝不走实时成功路径）
 *       ⑥ G3 覆盖闸门（由调用方注入，**紧邻**正式导入前执行）
 *       ⑦ 人工确认等其余闸门（沿用 import-audit.beforeImport）
 *       ⑧ 持久化 IMPORT_STARTED（**在 HTTP 之前**）
 *       ⑨ 调用现有 import-client（恰好 1 次 HTTP，零自动重试）
 *    任一闸门命中 → **0 次 HTTP** + WAITING_HUMAN + ready_to_push=false（终态落盘）；
 *  4. 不直接写 SQLite、不复制文件到项目目录：只写任务状态 JSON（经 src/state.js 原子写）与审计 outbox；
 *  5. 崩溃恢复 / 重复启动：终态已落盘 → 拒绝再次导入（0 HTTP），只允许"审计补送或进入人工处理"。
 *
 * 状态持久化（写在既有 state/tasks/<platform>/<report_type>/<date>.json 的 import 段，经 src/state.js）：
 *   task_id / report_type / business_date / source_sha256_prefix / g3 / attempts /
 *   import_batch_id / phase / failure_reason / ready_to_push / realtime_success / terminal
 *   （matched < raw 时另写本地 unmatched_stores —— 门店名**只进本地状态**，绝不进审计 metrics）
 * 顶层 ready_to_push 仍由 src/state.js 的既有公式给出（import=success 且 validate_import=passed 且未推送过）；
 * 七项验收通过时本模块会把 validate_import 标为 passed。
 */
const fs = require('fs');
const P = require('../paths');
const TC = require('../task-context');
const state = require('../state');
const OUTBOX = require('./audit-outbox');
const IC = require('./import-client');
const IMP = require('./import-audit');
const { scrubText } = require('./real-download-audit');

/** 本轮唯一允许的报表 */
const ALLOWED_REPORT_TYPES = ['cashier_composite'];
const IMPORT_SECTION = 'import';
/** 视为"已终态"的 import.status（终态即不再发起导入） */
const TERMINAL_STATUSES = ['success', 'failed', 'waiting_human'];
/**
 * **不可再次发起导入**的状态：终态 + running。
 * running 表示"上一次导入可能已经发出、结果未知"（崩溃/被 kill 时留下的状态）——
 * 此时绝不自动重发，只允许审计补送或人工处理。
 */
const NO_REIMPORT_STATUSES = ['running', 'success', 'failed', 'waiting_human'];

function prefixOf(sha) { return sha ? String(sha).slice(0, IC.SHA_PREFIX_LEN) : null; }

function createImportRun({ ctx, outbox = OUTBOX, opts = {}, importClient = null, logger = null, onPending = null } = {}) {
  TC.assertContext(ctx);
  if (!ALLOWED_REPORT_TYPES.includes(ctx.reportType)) {
    throw new Error('import-run 只接受 report_type=' + ALLOWED_REPORT_TYPES.join('/') + '（收到：' + ctx.reportType + '）');
  }
  const client = importClient || IC.createImportClient({ ctx, opts: opts.clientOpts || {}, logger });
  const audit = IMP.createImportAudit({ ctx, outbox, opts, logger, onPending, importClient: client });
  const attempts = { n: 0 };
  let startedInProcess = false;
  const timeline = [];

  function note(step, data) {
    const rec = Object.assign({ at: new Date().toISOString(), step }, data || {});
    timeline.push(rec);
    if (logger && typeof logger.info === 'function') { try { logger.info('import_run.' + step, rec); } catch (_) {} }
    return rec;
  }
  function readImport() {
    try { return state.read(ctx.platform, ctx.businessDate, ctx.reportType)[IMPORT_SECTION] || {}; } catch { return {}; }
  }
  function patchImport(data, status) {
    return state.patch(ctx.platform, ctx.businessDate, IMPORT_SECTION, data, { status, reportType: ctx.reportType });
  }
  /**
   * 构造要落盘的 import 段。**以已落盘状态为基线**再叠加本次增量：
   * state.patch 是浅合并，若这里强制给默认值，会把 g3 / import_batch_id 等已记录的证据冲掉。
   */
  function baseState(extra) {
    const cur = readImport();
    return Object.assign({
      task_id: ctx.taskId,
      report_type: ctx.reportType,
      platform: ctx.platform,
      business_date: ctx.businessDate,
      phase: cur.phase || null,
      attempts: attempts.n,
      source_sha256_prefix: cur.source_sha256_prefix || null,
      g3: cur.g3 || null,
      import_batch_id: cur.import_batch_id || null,
      failure_reason: cur.failure_reason || null,
      ready_to_push: cur.ready_to_push === true,
      realtime_success: cur.realtime_success === true,
      terminal: cur.terminal === true,
      audit_sha_field: audit.summary().audit_sha_field,
      updated_at: new Date().toISOString(),
    }, extra || {});
  }
  const isTerminal = (st) => TERMINAL_STATUSES.includes(String((st || {}).status));
  const isBlocked = (st) => NO_REIMPORT_STATUSES.includes(String((st || {}).status));

  /** 只读的审计补送（绝不触发业务导入） */
  async function flushAuditOnly(reason) {
    try {
      const r = await OUTBOX.flush({ ctx, opts });
      note('audit_flush_only', { reason, attempted: r && r.attempted, delivered: r && r.delivered, failed: r && r.failed });
      return r;
    } catch (e) { note('audit_flush_error', { reason, error: scrubText(e && e.message, 80) }); return null; }
  }

  /** 闸门命中：0 HTTP + WAITING_HUMAN/IMPORT_FAILED（终态落盘） */
  async function refuse(reason, { action = 'WAITING_HUMAN', metrics = {}, detail = {}, preserveTerminal = false } = {}) {
    note('gate_blocked', Object.assign({ reason, action, preserve_terminal: !!preserveTerminal }, detail));
    const r = await audit.runGuardedImport({
      blocked: { reason, action, metrics },
      businessDate: ctx.businessDate,
      // 绝不允许走到 HTTP：importFn 一旦被调用即视为编排缺陷
      importFn: async () => { throw new Error('import-run 闸门命中却调用了 importFn（缺陷）'); },
    });
    const cur = readImport();
    // 只要当前已是终态或"结果未知的 running"，任何后续拒绝都**只能追加拒绝记录**，
    // 绝不覆盖既有证据（否则会把 success 改写成 waiting_human、把 ready_to_push 打回 false）。
    if (preserveTerminal || isBlocked(cur)) {
      // 已终态：**保留**原终态证据（status/terminal/realtime_success/failure_reason/ready_to_push 一律不动），
      // 只追加"本次被拒绝"的记录；WAITING_HUMAN 由真实边界的审计事件表达。
      patchImport(baseState({
        last_refusal: { reason, at: new Date().toISOString(), gate_detail: detail.gate_detail || 'terminal_state' },
      }), cur.status);
      const ready = finalizeReadyToPush();
      return { ok: false, action: r.action, reason, http_requests: 0, import_calls: 0, ready_to_push: ready, allow_push: false, state: readImport(), timeline };
    }
    const status = r.action === 'IMPORT_FAILED' ? 'failed' : 'waiting_human';
    patchImport(baseState(Object.assign({
      phase: r.action === 'IMPORT_FAILED' ? 'IMPORT_FAILED' : 'WAITING_HUMAN',
      failure_reason: reason,
      ready_to_push: false,
      realtime_success: false,
      terminal: true,
      gate_detail: detail.gate_detail || null,
    }, detail.state || {})), status);
    finalizeReadyToPush();
    return { ok: false, action: r.action, reason, http_requests: 0, import_calls: 0, ready_to_push: false, allow_push: false, state: readImport(), timeline };
  }

  /** 让 import 段里的 ready_to_push 与顶层（state.js 公式）保持一致 */
  function finalizeReadyToPush() {
    try {
      const st = state.read(ctx.platform, ctx.businessDate, ctx.reportType);
      patchImport({ ready_to_push: st.ready_to_push === true }, st[IMPORT_SECTION] && st[IMPORT_SECTION].status);
      return st.ready_to_push === true;
    } catch { return false; }
  }

  /**
   * 本地输入闸门（全部同步、0 HTTP）。返回 {ok:true, file, sha256, sha256_prefix, meta} 或 {ok:false, reason, ...}
   */
  function preflight({ file, archive = null, task = null, validation = null }) {
    const meta = {
      archive: archive || null, task: task || null,
      backfill: !!(archive && (archive.historical_backfill === true || archive.backfill === true)) || !!(task && task.historical_backfill === true),
    };
    if (!file) return { ok: false, reason: 'archive_file_missing', gate_detail: 'file' };
    if (!archive || typeof archive !== 'object') return { ok: false, reason: 'archive_meta_missing', gate_detail: 'archive_meta' };
    if (!task || typeof task !== 'object' || !task.task_id) return { ok: false, reason: 'task_meta_incomplete', gate_detail: 'task_meta' };
    if (archive.report_type && String(archive.report_type) !== ctx.reportType) return { ok: false, reason: 'report_type_mismatch', gate_detail: 'report_type' };
    if (task.report_type && String(task.report_type) !== ctx.reportType) return { ok: false, reason: 'report_type_mismatch', gate_detail: 'report_type' };
    if (archive.business_date && String(archive.business_date) !== ctx.businessDate) return { ok: false, reason: 'business_date_mismatch', gate_detail: 'business_date' };
    if (task.business_date && String(task.business_date) !== ctx.businessDate) return { ok: false, reason: 'business_date_mismatch', gate_detail: 'business_date' };
    // 归档文件闸门（复用 import-client 的同一套判定：目录内/无符号链接越界/普通文件/非空/已校验）
    const resolved = client.resolveArchivedFile({ file, reportType: ctx.reportType, platform: ctx.platform, businessDate: ctx.businessDate, validation });
    if (!resolved.ok) return { ok: false, reason: resolved.reason, gate_detail: 'archive_file' };
    // 源文件 SHA 闸门
    let buf = null;
    try { buf = fs.readFileSync(resolved.file); } catch { return { ok: false, reason: 'file_unreadable', gate_detail: 'sha' }; }
    const sha256 = IC.sha256OfBuffer(buf);
    if (archive.sha256 && String(archive.sha256) !== sha256) {
      return { ok: false, reason: 'source_sha256_mismatch', gate_detail: 'sha', sha256_prefix: prefixOf(sha256) };
    }
    if (archive.size !== undefined && Number(archive.size) !== buf.length) {
      return { ok: false, reason: 'source_size_mismatch', gate_detail: 'sha', sha256_prefix: prefixOf(sha256) };
    }
    if (meta.backfill) {
      return { ok: false, reason: 'historical_backfill_not_realtime', gate_detail: 'backfill', sha256_prefix: prefixOf(sha256) };
    }
    return { ok: true, file: resolved.file, name: resolved.name, size: buf.length, sha256, sha256_prefix: prefixOf(sha256), meta };
  }

  /**
   * 唯一入口：跑一次受闸门保护的真实导入。
   * 永不抛出（审计/持久化异常不影响业务返回语义）；返回结构化结果与时间线。
   */
  async function runOnce({ file, archive = null, task = null, validation = null, evidence = {}, coverageGate = null, duplicateCheck = null, validateFile = null, humanConfirmation = null, lockHandle = null } = {}) {
    // ① 进程内重复启动
    if (startedInProcess) {
      return refuse('run_already_started_in_process', { detail: { gate_detail: 'in_process' } });
    }
    // ② 本地已持久化终态闸门（0 HTTP；只允许审计补送或人工处理）
    const cur = readImport();
    if (isBlocked(cur)) {
      const recovery = await flushAuditOnly('terminal_state');
      note('terminal_state_blocked', { prior_status: cur.status, prior_phase: cur.phase, prior_batch: cur.import_batch_id || null, audit_flush: !!recovery });
      const r = await refuse('terminal_state_' + String(cur.status), {
        preserveTerminal: true,
        detail: { gate_detail: 'terminal_state', state: { prior_status: cur.status, prior_import_batch_id: cur.import_batch_id || null, audit_recovery: !!recovery } },
      });
      return Object.assign(r, { recovery: 'audit_flush_only' });
    }
    // ③ 输入预检（0 HTTP）
    const pre = preflight({ file, archive, task, validation });
    if (!pre.ok) {
      return refuse(pre.reason, {
        detail: { gate_detail: pre.gate_detail, state: pre.sha256_prefix ? { source_sha256_prefix: pre.sha256_prefix } : {} },
      });
    }
    patchImport(baseState({ phase: 'PREFLIGHT_OK', source_sha256_prefix: pre.sha256_prefix, failure_reason: null, terminal: false }), 'running');
    note('preflight_ok', { sha256_prefix: pre.sha256_prefix, size: pre.size });

    startedInProcess = true;
    // ④ G3 覆盖闸门：由调用方注入，包一层以便把结果持久化（**紧邻**正式导入前执行）
    const wrappedCoverage = async () => {
      let g = null;
      try {
        g = coverageGate
          ? await coverageGate({ businessDate: ctx.businessDate, platform: ctx.platform, reportType: ctx.reportType, sha256_prefix: pre.sha256_prefix, file: pre.file })
          : { ok: false, coverage_hit: false, reason: 'coverage_gate_not_configured' };
      } catch (e) {
        g = { ok: false, coverage_hit: false, reason: 'coverage_gate_exception:' + scrubText(e && e.message, 60) };
      }
      patchImport(baseState({
        phase: 'G3_CHECKED',
        source_sha256_prefix: pre.sha256_prefix,
        g3: { ok: !!(g && g.ok === true), coverage_hit: !!(g && g.coverage_hit), reason: g && g.reason ? scrubText(g.reason, 80) : null, at: new Date().toISOString() },
      }), 'running');
      note('g3_checked', { ok: !!(g && g.ok === true), coverage_hit: !!(g && g.coverage_hit) });
      return g;
    };

    // ⑤ 正式边界：闸门 → 审计 IMPORT_STARTED → 持久化 IMPORT_STARTED → HTTP（恰好 1 次）
    const amountEv = (validation && validation.amount_evidence) ? validation.amount_evidence : null;
    const importFn = audit.makeRealImportFn({
      file: pre.file, validation, archiveSha256: pre.sha256 || null, priorTerminal: null,
      evidence: Object.assign({}, evidence, amountEv ? { amountExcel: (amountEv.amount_excel || {}).recorded_amount, amountBasis: { scope: amountEv.scope, mappings: (amountEv.mappings || []).map((m) => ({ file_column: m.file_column, db_column: m.db_column, scope: amountEv.scope })) }, file_store_rows: amountEv.file_store_rows } : {}),
    });
    // R6：导入验收期望值**完全由本次运行事实推导**（文件门店行数 / 本次声明数 / 文件数据行数），
    // 不再有任何固定门店数/固定行数回落；推导不出来的字段为 null ⇒ 由「响应自报」兜底。
    const numOrNull = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' && v !== undefined ? Number(v) : null);
    const expected = Object.assign(
      IMP.expectedFrom({
        fileStoreRows: numOrNull(validation && validation.store_count),
        declared: numOrNull(validation && validation.declared_dynamic),
        fileDataRows: numOrNull(validation && validation.data_row_count),
      }),
      {
        // 动态门店数证据（只放计数；嵌套在已登记白名单字段 validation 内，不新增顶层 metrics 字段）
        store_count_dynamic: numOrNull(validation && validation.declared_dynamic) !== null
          ? numOrNull(validation && validation.declared_dynamic) : numOrNull(validation && validation.store_count),
        absent_count: numOrNull(validation && validation.absent_count) !== null
          ? numOrNull(validation && validation.absent_count)
          : (validation && Array.isArray(validation.absent_stores) ? validation.absent_stores.length : null),
      },
    );
    const r = await audit.runGuardedImport({
      coverageGate: wrappedCoverage,
      duplicateCheck, validateFile, humanConfirmation,
      businessDate: ctx.businessDate, lockHandle, importFn, expected,
      onImportCall: () => {
        attempts.n += 1;
        patchImport(baseState({
          phase: 'IMPORT_STARTED',
          source_sha256_prefix: pre.sha256_prefix,
          failure_reason: null,
          terminal: false,
        }), 'running');                    // ★ IMPORT_STARTED 在 HTTP **之前**落盘
        note('import_started_persisted', { attempts: attempts.n, before_http: true });
      },
    });

    const clientRes = r.result || null;
    const batchId = clientRes && clientRes.import_batch_id ? clientRes.import_batch_id : null;
    if (r.action === 'IMPORT_SUCCEEDED') {
      patchImport(baseState({
        phase: 'IMPORT_SUCCEEDED',
        source_sha256_prefix: pre.sha256_prefix,
        import_batch_id: batchId,
        failure_reason: null,
        realtime_success: true,
        terminal: true,
        verification: r.verification || null,
        // 动态期望值证据：**不进审计 metrics**（中空白名单未登记），只落本地任务状态供人工核对
        verification_dynamic: r.verification_dynamic || null,
      }), 'success');
      // 七项验收通过 → validate_import=passed（让 src/state.js 的 ready_to_push 公式生效）
      try { state.markPassed(ctx.platform, ctx.businessDate, 'validate_import', { at: new Date().toISOString(), checks: r.verification || null, note: 'seven_item_verified' }, ctx.reportType); } catch (_) {}
      const ready = finalizeReadyToPush();
      note('import_succeeded', { import_batch_id: batchId, ready_to_push: ready, http: r.http });
      return { ok: true, action: 'IMPORT_SUCCEEDED', allow_push: r.allow_push === true, ready_to_push: ready, import_batch_id: batchId, http: r.http || null, http_requests: 1, import_calls: r.import_calls || 0, verification: r.verification || null, verification_dynamic: r.verification_dynamic || null, state: readImport(), timeline };
    }
    const failedStatus = r.action === 'IMPORT_FAILED' ? 'failed' : 'waiting_human';
    // 未匹配门店名单：**只写本地任务状态**（供人工处理），绝不进入审计事件 metrics
    const unmatched = Array.isArray(r.unmatched) && r.unmatched.length ? r.unmatched : null;
    patchImport(baseState({
      phase: r.action === 'IMPORT_FAILED' ? 'IMPORT_FAILED' : 'WAITING_HUMAN',
      source_sha256_prefix: pre.sha256_prefix,
      import_batch_id: batchId,
      failure_reason: r.reason || r.action || 'import_failed',
      ready_to_push: false,
      realtime_success: false,
      terminal: true,
      verification_dynamic: r.verification_dynamic || null,
      ...(unmatched ? { unmatched_stores: unmatched, unmatched_count: unmatched.length } : {}),
    }), failedStatus);
    const ready = finalizeReadyToPush();
    note(r.action === 'IMPORT_FAILED' ? 'import_failed' : 'waiting_human', { reason: r.reason || null, ready_to_push: ready, http: r.http || null });
    return {
      ok: false, action: r.action === 'IMPORT_FAILED' ? 'IMPORT_FAILED' : 'WAITING_HUMAN',
      reason: r.reason || null, allow_push: false, ready_to_push: ready, import_batch_id: batchId,
      unmatched: unmatched || [],
      verification_dynamic: r.verification_dynamic || null,
      http: r.http || null, http_requests: r.import_calls ? 1 : 0, import_calls: r.import_calls || 0,
      state: readImport(), timeline,
    };
  }

  function summary() {
    const st = state.read(ctx.platform, ctx.businessDate, ctx.reportType);
    return {
      ctx: { task_id: ctx.taskId, report_type: ctx.reportType, platform: ctx.platform, business_date: ctx.businessDate },
      import_state: st[IMPORT_SECTION] || null,
      ready_to_push_top_level: st.ready_to_push === true,
      attempts: attempts.n,
      started_in_process: startedInProcess,
      audit: audit.summary(),
      timeline: timeline.slice(),
    };
  }

  return { runOnce, preflight, readImport, summary, timeline, audit, client, flushAuditOnly };
}

module.exports = { createImportRun, ALLOWED_REPORT_TYPES, IMPORT_SECTION, TERMINAL_STATUSES, NO_REIMPORT_STATUSES };
