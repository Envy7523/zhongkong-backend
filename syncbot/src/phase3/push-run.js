'use strict';
/**
 * 阶段4 · **企业微信推送编排入口**
 *
 * 只允许对"**import-run 已持久化 IMPORT_SUCCEEDED 且顶层 ready_to_push=true**"的任务发起推送。
 *
 * 前置闸门（任一不满足 → **0 次发送调用** + WAITING_HUMAN/PUSH_FAILED，且不得伪造 ready_to_push）：
 *   ① report_type 必须是 cashier_composite（TC 层先拒未授权报表；报表 B 不接线）
 *   ② 业务日期一致（任务状态 business_date == 上下文 business_date）
 *   ③ **import 终态成功**：state.import.status === 'success'
 *   ④ 该成功由 import-run 记录为**实时成功**（import.realtime_success === true）→ 历史回填/补录一律拒绝
 *   ⑤ **顶层 ready_to_push === true**（src/state.js 公式：import=success 且 validate_import=passed 且未推送过）
 *   ⑥ 尚未 PUSH_SUCCEEDED（push.status 不得为 success/running/failed/waiting_human —— 含"发送中/结果未知"）
 *
 * 发送与持久化顺序：
 *   持久化 PUSH_STARTED（等价"发送中"状态：push.status='running'）→ **恰好 1 次**发送 →
 *   持久化 PUSH_SUCCEEDED（成功）或 PUSH_FAILED（失败，含 delivery_uncertain 标记）→ 审计事件（批量检查点）。
 *
 * 崩溃恢复 / 重复启动 / 响应丢失：push.status 一旦进入 running/success/failed/waiting_human 即视为
 * **不可自动重发**（running 表示"可能已发出、结果未知"）→ 0 次发送，只允许审计补送或人工处理。
 */
const TC = require('../task-context');
const state = require('../state');
const OUTBOX = require('./audit-outbox');
const PC = require('./push-client');
const IMP = require('./import-audit');
const { scrubText } = require('./real-download-audit');

const ALLOWED_REPORT_TYPES = ['cashier_composite'];
const PUSH_SECTION = 'push';
/** 一旦处于这些状态，就**不再自动发送**（running = 发送中/结果未知） */
const NO_RESEND_STATUSES = ['running', 'success', 'failed', 'waiting_human'];
/** 中控 metrics 白名单（发送前再挡一道，防止把未登记字段发上去导致整条事件被 400） */
const ALLOWED_METRIC_KEYS = new Set(['phase', 'started_at', 'finished_at', 'duration_ms', 'failure_reason', 'original_filename',
  'file_size', 'sha256', 'sha256_prefix', 'import_batch_id', 'raw_store_count', 'matched_store_count', 'ready_to_push',
  'push_status', 'imported', 'pushed', 'is_backfill', 'reconstructed', 'not_a_realtime_success', 'screenshot_count',
  'validation', 'evidence', 'note']);

/** 推送边界的事件 seq：导入侧 seq 1/2，这里用 3（PUSH_*）与 4（人工）以避免 event_id 冲突 */
const PUSH_SEQ = { push_ok: 3, push_fail: 3, waiting_human: 4 };

function pickMetrics(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (ALLOWED_METRIC_KEYS.has(k)) out[k] = v;
  return out;
}

function createPushRun({ ctx, outbox = OUTBOX, opts = {}, pushClient = null, logger = null, onPending = null } = {}) {
  TC.assertContext(ctx);
  if (!ALLOWED_REPORT_TYPES.includes(ctx.reportType)) {
    throw new Error('push-run 只接受 report_type=' + ALLOWED_REPORT_TYPES.join('/') + '（收到：' + ctx.reportType + '）');
  }
  const client = pushClient || PC.createPushClient({ ctx, opts, logger });
  const audit = IMP.createImportAudit({ ctx, outbox, opts, logger, onPending });
  const timeline = [];
  let startedInProcess = false;

  function note(step, data) {
    const rec = Object.assign({ at: new Date().toISOString(), step }, data || {});
    timeline.push(rec);
    if (logger && typeof logger.info === 'function') { try { logger.info('push_run.' + step, rec); } catch (_) {} }
    return rec;
  }
  const readState = () => state.read(ctx.platform, ctx.businessDate, ctx.reportType);
  const readPush = () => readState()[PUSH_SECTION] || {};
  function patchPush(data, status) {
    return state.patch(ctx.platform, ctx.businessDate, PUSH_SECTION, data, { status, reportType: ctx.reportType });
  }
  function basePush(extra) {
    const cur = readPush();
    return Object.assign({
      task_id: ctx.taskId, report_type: ctx.reportType, platform: ctx.platform, business_date: ctx.businessDate,
      phase: cur.phase || null, attempts: cur.attempts || 0, message_id: cur.message_id || null,
      failure_reason: cur.failure_reason || null, delivery_uncertain: cur.delivery_uncertain === true,
      terminal: cur.terminal === true, summary_fields: cur.summary_fields || null,
      platform_channel: 'wecom', updated_at: new Date().toISOString(),
    }, extra || {});
  }
  const isBlocked = (st) => NO_RESEND_STATUSES.includes(String((st || {}).status));

  async function flushAuditOnly(reason) {
    try {
      const r = await OUTBOX.flush({ ctx, opts });
      note('audit_flush_only', { reason, attempted: r && r.attempted, delivered: r && r.delivered, failed: r && r.failed });
      return r;
    } catch (e) { note('audit_flush_error', { reason, error: scrubText(e && e.message, 80) }); return null; }
  }

  /** 闸门命中：0 次发送；只追加拒绝记录，绝不覆盖既有终态、绝不伪造 ready_to_push */
  async function refuse(reason, { stage = 'waiting_human', metrics = {}, detail = {} } = {}) {
    note('gate_blocked', Object.assign({ reason, stage }, detail));
    const kind = stage === 'push_fail' ? 'push_fail' : 'waiting_human';
    const r = await audit.emitStep(kind, PUSH_SEQ[kind], pickMetrics(Object.assign({ note: reason, ready_to_push: 0, failure_reason: reason }, metrics)));
    const cur = readPush();
    if (isBlocked(cur)) {
      patchPush(basePush({ last_refusal: { reason, at: new Date().toISOString(), gate_detail: detail.gate_detail || 'state' } }), cur.status);
    } else {
      patchPush(basePush(Object.assign({
        phase: kind === 'push_fail' ? 'PUSH_FAILED' : 'WAITING_HUMAN',
        failure_reason: reason, terminal: true, gate_detail: detail.gate_detail || null,
      }, detail.state || {})), kind === 'push_fail' ? 'failed' : 'waiting_human');
    }
    const st = readState();
    return {
      ok: false, action: kind === 'push_fail' ? 'PUSH_FAILED' : 'WAITING_HUMAN', reason,
      send_calls: 0, sent: 0, ready_to_push: st.ready_to_push === true, message_id: null, state: readPush(), timeline,
      audit_event_id: r && r.event_id ? r.event_id : null,
    };
  }

  /** 唯一入口 */
  async function runOnce({ summary = null } = {}) {
    if (startedInProcess) return refuse('push_already_started_in_process', { detail: { gate_detail: 'in_process' } });
    // ⑥ 尚未推送（含"发送中/结果未知"一律不重发）
    const cur = readPush();
    if (isBlocked(cur)) {
      const recovery = await flushAuditOnly('push_state_' + String(cur.status));
      note('push_state_blocked', { prior_status: cur.status, prior_message_id: cur.message_id || null, audit_flush: !!recovery });
      const r = await refuse('push_state_' + String(cur.status), {
        detail: { gate_detail: 'push_state', state: { prior_status: cur.status, prior_message_id: cur.message_id || null, audit_recovery: !!recovery } },
      });
      return Object.assign(r, { recovery: 'audit_flush_only' });
    }
    const st = readState();
    const imp = st.import || {};
    // ② 业务日期一致
    if (st.business_date && String(st.business_date) !== ctx.businessDate) return refuse('business_date_mismatch', { detail: { gate_detail: 'business_date' } });
    // ③ import 终态成功
    if (String(imp.status) !== 'success') return refuse('import_not_succeeded', { detail: { gate_detail: 'import_status', state: { import_status: imp.status || null } } });
    // ④ 必须是 import-run 记录的实时成功（历史回填/补录一律拒绝）
    if (imp.realtime_success !== true) return refuse('historical_backfill_not_realtime', { detail: { gate_detail: 'realtime_success' } });
    // ⑤ 顶层 ready_to_push
    if (st.ready_to_push !== true) return refuse('ready_to_push_false', { detail: { gate_detail: 'ready_to_push' } });

    startedInProcess = true;
    const sm = summary || client.buildPushSummary({
      businessDate: ctx.businessDate,
      importBatchId: imp.import_batch_id,
      rawStoreCount: (imp.verification && imp.verification.raw_imported) || null,
      matchedStoreCount: (imp.verification && imp.verification.matched_stores) || null,
      imported: (imp.verification && imp.verification.imported) || null,
      sha256Prefix: imp.source_sha256_prefix,
      status: '导入成功，可推送',
    });
    const evidence = {
      business_date: ctx.businessDate,
      import_batch_id: numOrNull(imp.import_batch_id),
      raw_store_count: numOrNull(imp.verification && imp.verification.raw_imported),
      matched_store_count: numOrNull(imp.verification && imp.verification.matched_stores),
      imported: numOrNull(imp.verification && imp.verification.imported),
      sha256_prefix: /^[0-9a-f]{1,12}$/i.test(String(imp.source_sha256_prefix || '')) ? String(imp.source_sha256_prefix).toLowerCase() : null,
    };
    // ① 先持久化"发送中"（PUSH_STARTED 等价状态）——在发送**之前**
    patchPush(basePush({ phase: 'PUSH_STARTED', attempts: (basePush().attempts || 0) + 1, failure_reason: null, terminal: false, delivery_uncertain: false, summary_fields: Object.keys(evidence), content_lines: countLines(sm) }), 'running');
    note('push_started_persisted', { before_send: true, content_lines: countLines(sm) });

    const res = await client.sendSummary(sm);
    if (res.ok === true) {
      patchPush(basePush({ phase: 'PUSH_SUCCEEDED', message_id: res.message_id || null, failure_reason: null, delivery_uncertain: false, terminal: true, http: res.http || null, summary: evidence }), 'success');
      await audit.emitStep('push_ok', PUSH_SEQ.push_ok, pickMetrics({
        push_status: 'success', import_batch_id: evidence.import_batch_id, raw_store_count: evidence.raw_store_count,
        matched_store_count: evidence.matched_store_count, imported: evidence.imported,
        sha256_prefix: evidence.sha256_prefix, ready_to_push: 1, note: 'pushed_after_verified_import',
      }));
      await audit.whenIdle({ timeoutMs: opts.idleTimeoutMs || 8000 });
      const st2 = readState();
      note('push_succeeded', { message_id: res.message_id || null, http: res.http || null });
      return { ok: true, action: 'PUSH_SUCCEEDED', send_calls: res.attempts === 0 ? 1 : res.attempts, sent: res.sent, http: res.http || null,
        message_id: res.message_id || null, ready_to_push: st2.ready_to_push === true, state: readPush(), timeline };
    }
    const uncertain = res.delivery_uncertain === true;
    patchPush(basePush({
      phase: 'PUSH_FAILED', failure_reason: res.error_code || 'push_failed', delivery_uncertain: uncertain,
      terminal: true, http: res.http || null, summary: evidence,
    }), 'failed');
    await audit.emitStep('push_fail', PUSH_SEQ.push_fail, pickMetrics({
      push_status: 'failed', failure_reason: res.error_code || 'push_failed', import_batch_id: evidence.import_batch_id,
      sha256_prefix: evidence.sha256_prefix, ready_to_push: 0, note: uncertain ? 'delivery_uncertain_no_auto_resend' : 'push_rejected',
    }));
    await audit.whenIdle({ timeoutMs: opts.idleTimeoutMs || 8000 });
    const st3 = readState();
    note('push_failed', { error_code: res.error_code, uncertain });
    return { ok: false, action: 'PUSH_FAILED', reason: res.error_code, send_calls: res.attempts, sent: res.sent,
      http: res.http || null, delivery_uncertain: uncertain, ready_to_push: st3.ready_to_push === true, state: readPush(), timeline };
  }
  function numOrNull(v) { return Number.isFinite(Number(v)) && v !== null && v !== undefined && v !== '' ? Number(v) : null; }
  function countLines(s) { return String(s || '').split('\n').filter(Boolean).length; }

  function summary() {
    const st = readState();
    return {
      ctx: { task_id: ctx.taskId, report_type: ctx.reportType, platform: ctx.platform, business_date: ctx.businessDate },
      push_state: st[PUSH_SECTION] || null,
      ready_to_push_top_level: st.ready_to_push === true,
      client: { sends: client.counters ? client.counters.sends : null, has_sender: client.hasSender === true },
      audit: audit.summary(),
      timeline: timeline.slice(),
    };
  }
  return { runOnce, readPush, summary, timeline, audit, client, flushAuditOnly };
}

module.exports = { createPushRun, ALLOWED_REPORT_TYPES, PUSH_SECTION, NO_RESEND_STATUSES, PUSH_SEQ, ALLOWED_METRIC_KEYS };
