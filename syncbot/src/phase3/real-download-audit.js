'use strict';
/**
 * 阶段3 审计接线 · 真实下载路径（由 real-download-run.js 调用）
 *
 * 逐条对应已批准的接线约束：
 *  1. 只在业务 state 落盘成功之后 emit —— 由 wrapSave(baseSave) 保证：baseSave 抛错则不 emit；
 *  2. 仅对可映射 phase 发事件；PENDING / PRECHECK_OK / DOWNLOAD_LIST_PROBE / EXPORT_READY / STOPPED 不发；
 *  3. 同进程按 phase **与 stage** 双重去重（QUERY 与 QUERY_DONE 收敛到同一 stage，只发一次）；
 *     进程崩溃/恢复后的重复尝试复用同一 event_id（stableEventId），由 outbox + 服务端幂等收敛；
 *  4. 审计失败只写 outbox，并通过 onPending 回调把 audit_pending + 脱敏原因写进任务状态；
 *     不回滚业务状态、不重跑任何业务动作、不阻塞已完成的下载步骤；
 *  5. onPending 由调用方用 task-state.patch 直接落盘（绝不经过 store.save），因此不会递归 emit；
 *  6. FAILED 事件只带"原 phase + 脱敏失败原因"（本地再脱敏一次：绝对路径/盘符/JWT/≥32 位 hex）；
 *  7. IMPORT_* / PUSH_* / WAITING_HUMAN 不在此入口：只走 stageForPhase，不接受任何 step kind，
 *     不为了凑齐 13 阶段伪造事件。
 *
 * 检查点**批量发送**（本次变更）：
 *  - 事件仍然一条一条地**先落盘**（audit-batcher.add），但不再一条一次 POST；
 *  - C1：WAITING_EXPORT 落盘后，把 PRECHECK / QUERY_DONE / EXPORT_SUBMITTED / WAITING_EXPORT
 *        合并为**一次** POST；
 *  - C2：FILE_VALIDATED 落盘后，把 DOWNLOADED / FILE_VALIDATED 合并为**一次** POST；
 *  - FAILED：立即 flush（不等任何延时窗口），把尚未发出的相邻事件（含 FAILED 本身）一次带走；
 *  - 正常成功路径因此是 **2 次** POST（导入侧另有 2 次，C1–C4 合计 4 次）；
 *  - whenIdle / 退出路径**只发送已缓冲事件**：不会制造"额外第 5 次 POST"，也不会制造新事件。
 *
 * 注意（重要）：emit 是异步的，但**去重判定与待发内容必须在调用点同步完成**（业务 state 是活对象，
 * 会在后续 phase 被就地修改）。因此这里同步快照 phase/metrics、同步落盘并同步入缓冲；队列只影响发送
 * 时机，绝不改变"哪些阶段该发"的判断 —— 这正是此前 inAudit 闩导致"前一事件在飞时后续阶段被静默
 * 丢弃"的根因修复。
 */
const MAP = require('./audit-stage-map');
const OUTBOX = require('./audit-outbox');
const BAT = require('./audit-batcher');
const { DEFAULT_IDLE_TIMEOUT_MS } = require('./audit-queue');

/** 本入口唯一允许发出的 7 个阶段（下载侧） */
const WIRED_STAGES = Array.from(new Set(Object.values(MAP.PHASE_TO_STAGE).filter(Boolean)));
/** 上述阶段对应的可映射 phase 键（含同阶段多 phase，如 QUERY / QUERY_DONE） */
const WIRED_PHASE_KEYS = Object.keys(MAP.PHASE_TO_STAGE).filter((k) => MAP.PHASE_TO_STAGE[k]);

/** 检查点 → 触发它的 phase（批量成员由缓冲内容决定，顺序由 seq 决定） */
const CHECKPOINTS = {
  WAITING_EXPORT: 'C1',
  FILE_VALIDATED: 'C2',
};

const SCRUB_RULES = [
  [/(\/(?:home|opt|etc|var|root|tmp|usr)\/[^\s"']*)/g, '[path]'],
  [/([A-Za-z]:\\[^\s"']*)/g, '[path]'],
  [/(eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+)/g, '[jwt]'],
  [/[0-9a-fA-F]{32,}/g, '[hash]'],
];
function scrubText(value, max = 160) {
  let t = String(value == null ? '' : value);
  for (const [re, to] of SCRUB_RULES) t = t.replace(re, to);
  return t.slice(0, max);
}

function createRealDownloadAudit({ ctx, outbox = OUTBOX, opts = {}, onPending = null, logger = null, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, batcher = null } = {}) {
  const emitted = [];          // 同步占位 → 发送完成后回填，保证顺序等于 phase 顺序
  const byId = new Map();      // event_id → 同一 info 对象（批量结果按 event_id 回填）
  const pending = [];
  let lastPhase = null;
  let lastStage = null;
  let prevPhase = null;            // 上一个任意 phase（FAILED 的"原 phase"兜底）
  let seq = 0;
  // 发送超时：比上报 HTTP 超时略宽，且始终有限（默认 8s）。
  // 注意：定时器**不能** unref —— unref 的定时器不维持事件循环，会让 Node 在
  // 「等一个永不返回的 promise」时静默 exit 0，任务被悄悄丢弃。
  const sendTimeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? Number(opts.timeoutMs) + 1000 : 8000;

  const batch = batcher || BAT.createAuditBatcher({ ctx, outbox, opts, logger, idleTimeoutMs });
  if (batch && typeof batch.setOnResult === 'function') batch.setOnResult(applyFlush);
  // whenIdle 有界超时同样入账（与既有语义一致：超时不丢事件，只记 audit_pending(audit_idle_timeout)）
  if (batch && typeof batch.setOnIdleTimeout === 'function') {
    batch.setOnIdleTimeout((info) => recordPending({ phase: '*', stage: 'AUDIT_IDLE', reason: 'audit_idle_timeout', pending_sends: info.pending_sends, at: new Date().toISOString() }));
  }

  function recordPending(info) {
    pending.push(info);
    if (typeof onPending === 'function') { try { onPending(info); } catch (_) {} }
    if (logger && typeof logger.error === 'function') { try { logger.error('audit.pending', info); } catch (_) {} }
  }

  /** 批量结果按 event_id 回填到对应 info；失败的事件逐条记 audit_pending（与逐条发送时同口径） */
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
      if (r.ok) {
        info.ok = true; info.queued = false; info.reason = null;
      } else {
        info.ok = false; info.queued = true;
        info.reason = scrubText(r.reason || 'send_failed', 120);
        recordPending({ phase: info.phase, stage: info.stage, reason: info.reason, at: new Date().toISOString() });
      }
    }
  }

  /** 触发一次检查点批量发送；有界：超时后不再等 HTTP 结果，未结算事件记 audit_pending */
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
          recordPending({ phase: info.phase, stage: info.stage, reason: 'audit_send_timeout', at: new Date().toISOString() });
        }
      }
      return res && res.__send_deadline ? null : res;
    });
  }

  function recordSkip(phase, stage, reason) {
    // 跳过决策也入账：便于证明"同一 phase/stage 未重复发事件"，而不是静默丢弃
    const info = {
      phase, stage: stage || null, ok: true, skipped: true, event_id: null, status: null,
      queued: false, delivery_kind: null, accepted: 0, duplicates: 0, rejected_count: 0, reason,
    };
    emitted.push(info);
    return Promise.resolve(info);
  }

  function afterPhaseSaved(v) {
    const phase = v && v.phase;
    if (!phase) return Promise.resolve(null);
    const stage = MAP.stageForPhase(phase);
    if (!stage) { prevPhase = phase; return recordSkip(phase, null, 'phase_not_mapped'); }
    if (phase === lastPhase) { prevPhase = phase; return recordSkip(phase, stage, 'same_phase_in_process'); }
    if (stage === lastStage) { prevPhase = phase; return recordSkip(phase, stage, 'same_stage_in_process'); }
    // ---- 同步判定与快照（此后才进缓冲/队列，await 期间不再做任何判定）----
    lastPhase = phase;
    lastStage = stage;
    const step = ++seq;
    const metrics = {};
    if (stage === 'FAILED') {
      const hist = Array.isArray(v.history) ? v.history.slice() : [];
      const failedRec = hist.slice().reverse().find((h) => h && h.to === 'FAILED') || {};
      const orig = failedRec.from || prevPhase;
      metrics.phase = orig && orig !== 'FAILED' ? orig : 'unknown';
      metrics.failure_reason = scrubText((v.failure && (v.failure.reason || v.failure.code)) || 'unknown');
    }
    const info = {
      phase, stage, ok: false, skipped: false, event_id: null, status: null, queued: true,
      delivery_kind: null, accepted: 0, duplicates: 0, rejected_count: 0, reason: null,
      batch_reason: null, batch_size: 0, __settled: false, __inflight: true,
    };
    emitted.push(info);
    prevPhase = phase;
    // ---- 先落盘、再入缓冲 ----
    let event = null;
    try {
      event = batch.buildEvent({ stage, seq: step, metrics });
      info.event_id = event.event_id;
      byId.set(event.event_id, info);
      const added = batch.add(event);
      if (!added || added.ok !== true) {
        info.__settled = true; info.__inflight = false; info.ok = false; info.queued = false;
        info.reason = scrubText((added && added.reason) || 'outbox_write_failed', 120);
        recordPending({ phase, stage, reason: info.reason, at: new Date().toISOString() });
      }
    } catch (e) {
      info.__settled = true; info.__inflight = false; info.ok = false; info.queued = false;
      info.reason = scrubText((e && e.message) || 'audit_add_failed', 120);
      recordPending({ phase, stage, reason: info.reason, at: new Date().toISOString() });
    }
    // ---- 检查点批量发送：FAILED 立即 flush；C1/C2 在对应 phase 落盘后 flush ----
    if (stage === 'FAILED') return checkpoint('FAILED');
    const cp = CHECKPOINTS[phase];
    if (cp) return checkpoint(cp);
    return Promise.resolve(info);
  }

  /** 包住业务持久化：先落盘，成功之后才发事件；emit 异步，绝不阻塞业务返回 */
  function wrapSave(baseSave) {
    return function save(v) {
      const r = baseSave(v);
      try { afterPhaseSaved(v); } catch (_) { /* 审计绝不影响业务返回 */ }
      return r;
    };
  }
  /** 有界等待：默认 5s（可配置）超时即放行，并把 audit_idle_timeout 记为 audit_pending。
   *  **只发送已缓冲事件**（缓冲为空 → 一次 POST 都不产生），绝不制造新事件。 */
  function whenIdle(o = {}) { return batch.whenIdle(o); }
  function summary() {
    return {
      wired_stages: WIRED_STAGES,
      wired_phase_keys: WIRED_PHASE_KEYS,
      checkpoints: CHECKPOINTS,
      emitted: emitted.map((e) => ({
        phase: e.phase, stage: e.stage, ok: e.ok, skipped: !!e.skipped, event_id: e.event_id,
        status: e.status, queued: e.queued, delivery_kind: e.delivery_kind,
        accepted: e.accepted, duplicates: e.duplicates, rejected_count: e.rejected_count,
        batch_reason: e.batch_reason || null, batch_size: e.batch_size || 0,
      })),
      emitted_stages: emitted.filter((e) => e.ok && !e.skipped).map((e) => e.stage),
      skipped: emitted.filter((e) => e.skipped).map((e) => ({ phase: e.phase, stage: e.stage || null, reason: e.reason })),
      pending_count: pending.length,
      pending: pending,
      batch: typeof batch.summary === 'function' ? batch.summary() : null,
    };
  }
  return { afterPhaseSaved, wrapSave, whenIdle, summary, WIRED_STAGES, WIRED_PHASE_KEYS, CHECKPOINTS };
}

module.exports = { createRealDownloadAudit, scrubText, WIRED_STAGES, WIRED_PHASE_KEYS };
