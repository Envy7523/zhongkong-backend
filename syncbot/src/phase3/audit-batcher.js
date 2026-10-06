'use strict';
/**
 * 审计事件 **批量发送器**（阶段3 接线层 · 检查点批量）
 *
 * 解决的问题：逐条 emit 时每个事件一次 POST，一次任务最多 13 次请求；而中控
 * `POST /api/internal/syncbot/events` **原生支持** `{events:[...]}`，且服务端
 * `ingestEvents(db, events)` 在一次请求内 **最多调用一次 db.save()**（整库 sql.js 重写）。
 * 因此把同一次运行的相邻检查点合并为**一次请求**，可把正常路径的请求数与整库保存次数
 * 从 13 降到 4，而**不改变**任何业务动作与状态机。
 *
 * 硬性约束（逐条对应冻结方案）：
 *  1. add(event)：**先**把 `{type:'event', at, event}` 追加到本地 JSONL（目录 0700 / 文件 0600），
 *     **再**进入内存缓冲。落盘失败则不入缓冲、绝不发送（宁可滞留也不伪造"已发出"）。
 *  2. JSONL 路径沿用既有 outboxFile(platform, report_type, business_date)；
 *     **不修改 audit-outbox.js**，本模块自写与之**逐字段兼容**的 JSONL 行格式：
 *       event      : {type:'event', at, event}                      （既有 pendingEvents 读取约定位）
 *       delivered  : {type:'delivered', at, event_id, status, stage, via, delivery_kind, accepted, duplicates, batch_size}
 *       audit_pending: {type:'audit_pending', at, event_id, stage, via, reason, status, rejected_count, rejected_reasons}
 *     因此**未被本模块发送**的事件（进程崩溃/退出路径未 flush）仍可被既有
 *     `OUTBOX.pendingEvents()` / `OUTBOX.flush()` 原样恢复补送。
 *  3. flush(reason)：按 run_key 分组 → 组内 seq ASC / at ASC / event_id ASC（**缺 seq 排最前**）
 *     → 按 ≤200 条 且 ≤512KiB（以 `JSON.stringify({events:[...]})` 的实际字节数计）分片
 *     → 逐片调用 reportEvents(batch, opts)（HMAC 照旧覆盖原始 JSON 字节）。
 *  4. 回写语义（**逐 event_id**，不是逐请求）：
 *       accepted 或 duplicates  → 仅把**对应的那些 event_id** 记为 delivered；
 *       rejected / 网络失败 / 超时 → 仅把**对应的那些 event_id** 记为 audit_pending。
 *     服务端 `rejected` 逐条带 event_id；`accepted`/`duplicates` 只回计数，
 *     故按契约 `accepted+duplicates === 非 rejected 条数` 反推"已送达集合"；
 *     计数不吻合时**保守地全部记 pending**（绝不把未确认当成成功）。
 *  5. whenIdle：**只发送已缓冲事件**（缓冲为空则一次 POST 都不产生），再走既有**有界**队列等待；
 *     绝不制造新事件、绝不制造额外第 N 次 POST。
 *  6. FAILED / WAITING_HUMAN 由接线层**立即** flush，不等 maxBatchDelayMs（默认关闭，不建定时器）。
 */
const fs = require('fs');
const R = require('./audit-reporter');
const OUTBOX = require('./audit-outbox');
const { createIdleQueue, DEFAULT_IDLE_TIMEOUT_MS } = require('./audit-queue');

/** 单批上限（与中控入站校验一致：events.length > 200 → 400；express.raw limit 1mb） */
const MAX_BATCH_EVENTS = 200;
/** 单批请求体上限：512KiB（严格小于中控 1mb 上限） */
const MAX_BATCH_BYTES = 512 * 1024;
/** posts_log / results 保留上限（仅用于证据，防止长任务内存增长） */
const MAX_POST_LOG = 200;
/** 默认不启用"最长等待后再发"：批量由状态机检查点驱动；为 0 = 不建任何定时器 */
const DEFAULT_MAX_BATCH_DELAY_MS = 0;

const STAGES = OUTBOX.STAGES;

/** 与既有 outbox 完全一致的 JSONL 追加：0600；目录 0700 由 outboxFile 负责 */
function appendLine(file, obj) {
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeSync(fd, JSON.stringify(obj) + '\n'); } finally { fs.closeSync(fd); }
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

/** rejected 原因脱敏（与 audit-outbox.sanitizeReasons 同口径：只留原因码 + 白名单字段名） */
const REASON_TAIL_RE = /^[A-Za-z_][A-Za-z0-9_.\[\]]{0,40}$/;
function sanitizeReasons(list) {
  return (Array.isArray(list) ? list : []).slice(0, 10).map((raw) => {
    let s = String(raw == null ? '' : raw);
    s = s.replace(/(\/(?:home|opt|etc|var|root|tmp|usr)\/[^\s]*)|([A-Za-z]:\\[^\s]*)|([0-9a-fA-F]{32,})|(eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+)/g, '[redacted]');
    const i = s.indexOf(':');
    const code = i >= 0 ? s.slice(0, i) : s;
    const tail = i >= 0 ? s.slice(i + 1) : '';
    const head = /^[a-z_]{3,40}$/.test(code) ? code : 'unrecognized_reason';
    const body = tail ? (REASON_TAIL_RE.test(tail) ? ':' + tail : ':[redacted]') : '';
    return (head + body).slice(0, 160);
  });
}

/** 脱敏错误文本（与接线层同口径，用于 posts_log.reason_text） */
function scrubReason(value, max = 120) {
  let t = String(value == null ? '' : value);
  t = t.replace(/(\/(?:home|opt|etc|var|root|tmp|usr)\/[^\s"']*)/g, '[path]')
       .replace(/([A-Za-z]:\\[^\s"']*)/g, '[path]')
       .replace(/(eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+)/g, '[jwt]')
       .replace(/[0-9a-fA-F]{32,}/g, '[hash]');
  return t.slice(0, max);
}

/** 运行键：一次业务运行的全部事件归入同一组（不同 task/日期/报表绝不混批） */
function runKeyOf(e) {
  return [e && e.task_id, e && e.report_type, e && e.platform, e && e.business_date].map((x) => String(x == null ? '' : x)).join('|');
}

/** seq 规范化：缺失/非法 → null（排最前） */
function seqOf(e) {
  const v = e && e.seq;
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 组内排序：缺 seq 最前 → seq ASC → at ASC → event_id ASC（全序，稳定可复现） */
function compareEvents(a, b) {
  const sa = seqOf(a); const sb = seqOf(b);
  if (sa === null && sb !== null) return -1;
  if (sa !== null && sb === null) return 1;
  if (sa !== null && sb !== null && sa !== sb) return sa - sb;
  const aa = String((a && a.at) || ''); const ab = String((b && b.at) || '');
  if (aa !== ab) return aa < ab ? -1 : 1;
  const ia = String((a && a.event_id) || ''); const ib = String((b && b.event_id) || '');
  return ia < ib ? -1 : (ia > ib ? 1 : 0);
}

/** 单条事件的序列化字节数（与 reportEvents 的 rawBody 同构） */
function eventBytes(ev) { return Buffer.byteLength(JSON.stringify(ev), 'utf8'); }
/** 请求体字节数：'{"events":[' + join(',') + ']}' —— 与 JSON.stringify({events:[...]}) 完全一致 */
function payloadBytes(events, sizes) {
  if (!events.length) return Buffer.byteLength('{"events":[]}', 'utf8');
  let sum = 0;
  for (const n of sizes) sum += n;
  return 11 + sum + (events.length - 1) + 2;
}

/** 分片：≤200 条 且 ≤512KiB；单条自身超限时独占一片（绝不拆分事件） */
function shardEvents(ordered, maxEvents = MAX_BATCH_EVENTS, maxBytes = MAX_BATCH_BYTES) {
  const shards = [];
  let cur = [];
  let curSizes = [];
  for (const ev of ordered) {
    const n = eventBytes(ev);
    const wouldCount = cur.length + 1;
    const wouldBytes = payloadBytes(cur.concat([ev]), curSizes.concat([n]));
    if (cur.length && (wouldCount > maxEvents || wouldBytes > maxBytes)) {
      shards.push(cur);
      cur = [ev]; curSizes = [n];
    } else {
      cur.push(ev); curSizes.push(n);
    }
  }
  if (cur.length) shards.push(cur);
  return shards;
}

/** 事件必要性校验：缺 event_id / 阶段不在 13 阶段契约内 → 不落盘、不缓冲、不发送 */
function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { ok: false, reason: 'event_not_object' };
  if (!event.event_id || typeof event.event_id !== 'string') return { ok: false, reason: 'event_id_missing' };
  if (!STAGES.includes(event.stage)) return { ok: false, reason: 'stage_not_in_contract:' + String(event.stage) };
  for (const k of ['task_id', 'report_type', 'platform', 'business_date']) {
    if (!event[k]) return { ok: false, reason: k + '_missing' };
  }
  return { ok: true };
}

/**
 * @param {object} o
 * @param {object} o.ctx        TaskContext（platform/reportType/businessDate/taskId）
 * @param {object} o.outbox     既有 audit-outbox 模块（只用 outboxFile/stableEventId/STAGES，绝不修改它）
 * @param {object} o.opts       透传给 reportEvents 的选项（secretFile/endpoint/timeoutMs/testRunId…）
 * @param {function} o.onResult 每次 flush 完成后的回调（接线层据此回填逐事件结果）
 */
function createAuditBatcher({
  ctx = null, outbox = OUTBOX, opts = {}, logger = null,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, onResult = null,
  maxBatchEvents = MAX_BATCH_EVENTS, maxBatchBytes = MAX_BATCH_BYTES,
  maxBatchDelayMs = DEFAULT_MAX_BATCH_DELAY_MS,
} = {}) {
  const reporter = opts.reporter || R;
  // 单分片发送上限：比上报 HTTP 超时宽 1s（默认 8s），始终有限
  const shardTimeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? Number(opts.timeoutMs) + 1000 : 8000;
  const buffer = [];
  const postLog = [];
  const stats = { added: 0, rejected_add: 0, flushes: 0, posts: 0, delivered: 0, pending: 0, bytes: 0, last_reason: null, last_at: null };
  let onIdleTimeout = null;
  const queue = createIdleQueue({
    defaultTimeoutMs: idleTimeoutMs,
    onTimeout: (info) => {
      if (typeof onIdleTimeout === 'function') { try { onIdleTimeout(info); } catch (_) {} }
      if (logger && typeof logger.error === 'function') { try { logger.error('audit.batch.idle_timeout', { pending_sends: info.pending_sends }); } catch (_) {} }
    },
  });
  // maxBatchDelayMs 默认 0 = 不启用；启用时也必须 unref（绝不因为批处理定时器拖住进程退出）
  let timer = null;
  if (Number.isFinite(maxBatchDelayMs) && maxBatchDelayMs > 0) {
    timer = setInterval(() => { if (buffer.length) flush('max_batch_delay'); }, Number(maxBatchDelayMs));
    if (typeof timer.unref === 'function') timer.unref();
  }

  /** 与既有 outbox.emit 完全同构的事件构造（event_id 稳定，可跨进程重放/补送） */
  function buildEvent({ stage, seq = 1, metrics = {}, detail = {}, opts: extra = {} } = {}) {
    const useCtx = ctx || {};
    const o = Object.assign({}, opts, extra);
    const idPrefix = o.testRunId ? 'test-' : 'evt-';
    const taskId = (extra.taskId || useCtx.taskId);
    const reportType = (extra.reportType || useCtx.reportType);
    const platform = (extra.platform || useCtx.platform || 'meituan');
    const businessDate = (extra.businessDate || useCtx.businessDate);
    const event = {
      event_id: idPrefix + outbox.stableEventId({ taskId, reportType, businessDate, stage, seq }).slice(4),
      task_id: taskId,
      report_type: reportType,
      platform,
      business_date: businessDate,
      stage,
      at: new Date().toISOString(),
      seq,
      metrics: R.normalizeMetrics(metrics),
      detail: R.sanitize(detail),
    };
    if (o.testRunId) { event.is_test = true; event.test_run_id = String(o.testRunId); }
    return event;
  }

  /** 先落盘、再入缓冲。永不抛出；失败返回 {ok:false} 由接线层记 audit_pending。 */
  function add(event) {
    const v = validateEvent(event);
    if (!v.ok) { stats.rejected_add += 1; return { ok: false, queued: false, buffered: false, event_id: (event && event.event_id) || null, reason: v.reason }; }
    let file;
    try {
      file = outbox.outboxFile(event.platform, event.report_type, event.business_date);
      appendLine(file, { type: 'event', at: event.at || new Date().toISOString(), event });
    } catch (e) {
      stats.rejected_add += 1;
      return { ok: false, queued: false, buffered: false, event_id: event.event_id, reason: 'outbox_write_failed(' + ((e && e.code) || 'error') + ')' };
    }
    buffer.push(event);
    stats.added += 1;
    return { ok: true, queued: true, buffered: true, event_id: event.event_id, file };
  }

  /** 单次 flush 的发送结果记录（证据用；不含密钥/签名/绝对路径） */
  function recordPost(rec) {
    postLog.push(rec);
    if (postLog.length > MAX_POST_LOG) postLog.splice(0, postLog.length - MAX_POST_LOG);
  }

  /**
   * 发送一个分片并**逐 event_id** 归类。
   * @returns {Promise<Array>} 逐事件结果
   */
  async function sendShard(batch, reason, index) {
    const sizes = batch.map(eventBytes);
    const startedAt = new Date().toISOString();
    // 发送本身有界：reporter 自带 HTTP 超时；这里的兜底定时器更宽，只用于"reporter 永不返回"的病态情形，
    // 保证队列链一定推进（否则后续 flush 会被永久占住，任务退出被拖死）。
    // 定时器**不能** unref（unref 不维持事件循环，会让进程在等待中静默 exit 0）；结算后立即清理。
    let timer = null;
    const sendP = Promise.resolve()
      .then(() => reporter.reportEvents(batch, opts))
      .then((r) => r, (e) => ({ ok: false, reason: 'report_exception(' + ((e && e.code) || 'error') + ')' }));
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve({ __shard_deadline: true }), shardTimeoutMs); });
    let res = await Promise.race([sendP, deadline]);
    if (timer) { clearTimeout(timer); timer = null; }
    if (res && res.__shard_deadline) res = { ok: false, reason: 'audit_send_timeout' };
    if (!res || typeof res !== 'object') res = { ok: false, reason: 'invalid_reporter_result' };
    stats.posts += 1;
    stats.bytes += payloadBytes(batch, sizes);
    const status = res && Number.isFinite(res.status) ? Number(res.status) : null;
    const rejectedList = Array.isArray(res && res.rejected) ? res.rejected : [];
    const rejectedIds = new Set(rejectedList.map((x) => x && x.event_id).filter(Boolean));
    const acceptedN = Number((res && res.accepted) || 0);
    const duplicatesN = Number((res && res.duplicates) || 0);
    const accounted = acceptedN + duplicatesN;

    let deliveredIds = new Set();
    let transportOk = status !== null;
    if (transportOk) {
      const notRejected = batch.filter((e) => !rejectedIds.has(e.event_id)).map((e) => e.event_id);
      if (status >= 200 && status < 300 && rejectedList.length === 0 && accounted === batch.length) {
        // 全成功（含全新 accepted 与全部 duplicate 两种情况）
        deliveredIds = new Set(batch.map((e) => e.event_id));
      } else if (notRejected.length > 0 && accounted === notRejected.length) {
        // 部分 rejected：仅把服务端确认过的那些记为送达
        deliveredIds = new Set(notRejected);
      }
      // 其余（500 / 计数不吻合 / 全部 rejected）→ 保守：全部 pending
    }
    const deliveryKind = (ids) => {
      if (!ids.length) return null;
      if (duplicatesN > 0 && acceptedN === 0) return 'duplicate';
      if (acceptedN > 0 && duplicatesN === 0) return 'accepted';
      return 'mixed';
    };
    const rejectedReasons = sanitizeReasons(rejectedList.flatMap((x) => (x && x.reasons) || []));
    const baseReason = transportOk
      ? (rejectedList.length ? 'rejected' : (accounted === 0 ? 'not_confirmed' : 'not_confirmed'))
      : String((res && (res.reason || res.error)) || 'send_failed');

    const results = batch.map((ev) => {
      const ok = deliveredIds.has(ev.event_id);
      const kind = ok ? deliveryKind([ev.event_id]) : null;
      return {
        event_id: ev.event_id, stage: ev.stage, ok, delivered: ok,
        status, delivery_kind: kind, accepted: acceptedN, duplicates: duplicatesN,
        rejected_count: rejectedIds.has(ev.event_id) ? 1 : 0,
        reason: ok ? null : scrubReason(baseReason, 120),
        batch_reason: reason, batch_index: index, batch_size: batch.length,
      };
    });
    recordPost({
      n: stats.posts, reason, index, at: startedAt, status, transport_ok: transportOk,
      event_count: batch.length, stages: batch.map((e) => e.stage), event_ids: batch.map((e) => e.event_id),
      bytes: payloadBytes(batch, sizes), accepted: acceptedN, duplicates: duplicatesN,
      rejected_count: rejectedList.length, delivered: results.filter((x) => x.ok).map((x) => x.event_id),
      pending: results.filter((x) => !x.ok).map((x) => x.event_id),
      reason_text: scrubReason(transportOk ? (rejectedList.length ? 'rejected' : null) : baseReason, 120),
      rejected_reasons: rejectedReasons,
    });
    return results;
  }

  /** 真正的 flush 执行体：分组 → 排序 → 分片 → 发送 → 逐 id 回写 JSONL。永不抛出。 */
  async function runFlush(items, reason) {
    const groups = new Map();
    for (const ev of items) {
      const k = runKeyOf(ev);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(ev);
    }
    const results = [];
    let shards = 0;
    try {
      for (const list of groups.values()) {
        const ordered = list.slice().sort(compareEvents);
        const parts = shardEvents(ordered, maxBatchEvents, maxBatchBytes);
        for (let i = 0; i < parts.length; i += 1) {
          shards += 1;
          const r = await sendShard(parts[i], reason, i);
          for (const x of r) results.push(x);
        }
      }
    } catch (e) {
      for (const ev of items) {
        if (!results.some((x) => x.event_id === ev.event_id)) {
          results.push({ event_id: ev.event_id, stage: ev.stage, ok: false, delivered: false, status: null, delivery_kind: null, accepted: 0, duplicates: 0, rejected_count: 0, reason: scrubReason('flush_failed(' + ((e && e.code) || 'error') + ')', 120), batch_reason: reason });
        }
      }
    }
    // ---- 逐 event_id 回写（同一 flush 内同一 event_id 只写一行终态）----
    const written = new Set();
    let delivered = 0; let pending = 0;
    const nowIso = () => new Date().toISOString();
    for (const r of results) {
      if (written.has(r.event_id)) continue;
      written.add(r.event_id);
      const ev = items.find((x) => x.event_id === r.event_id) || {};
      let file = null;
      try { file = outbox.outboxFile(ev.platform, ev.report_type, ev.business_date); } catch (_) { file = null; }
      if (!file) continue;
      try {
        if (r.ok) {
          appendLine(file, {
            type: 'delivered', at: nowIso(), event_id: r.event_id, status: r.status, stage: r.stage, via: 'batch',
            delivery_kind: r.delivery_kind, accepted: r.accepted, duplicates: r.duplicates, batch_size: r.batch_size,
          });
          delivered += 1;
        } else {
          appendLine(file, {
            type: 'audit_pending', at: nowIso(), event_id: r.event_id, stage: r.stage, via: 'batch',
            reason: r.reason || 'send_failed', status: r.status, rejected_count: r.rejected_count,
            rejected_reasons: r.rejected_count ? (postLog[postLog.length - 1] || {}).rejected_reasons || [] : [],
          });
          pending += 1;
        }
      } catch (_) { /* 回写失败不影响返回；事件仍是 pending（无 delivered 行即 pending） */ }
    }
    stats.flushes += 1;
    stats.delivered += delivered;
    stats.pending += pending;
    stats.last_reason = reason;
    stats.last_at = nowIso();
    const out = {
      ok: pending === 0, reason, sent: results.length, shards, batches: shards,
      delivered, pending, bytes: payloadBytes(items, items.map(eventBytes)), results,
    };
    if (typeof onResult === 'function') { try { onResult(out); } catch (_) {} }
    return out;
  }

  /** 快照式入队：**在调用时刻**取走缓冲，保证每个检查点的批量成员稳定、与后续检查点不串批 */
  function flush(reason = 'manual') {
    const items = buffer.splice(0, buffer.length);
    if (!items.length) {
      return Promise.resolve({ ok: true, reason, sent: 0, shards: 0, batches: 0, delivered: 0, pending: 0, bytes: 0, results: [], empty: true });
    }
    return queue.enqueue(() => runFlush(items, reason));
  }

  /** 只发送**已缓冲**事件，再走既有有界等待；不产生新事件、不产生额外 POST */
  function whenIdle(o = {}) {
    flush('when_idle');
    return queue.whenIdle(o);
  }

  function summary() {
    return {
      added: stats.added, rejected_add: stats.rejected_add, flushes: stats.flushes, posts: stats.posts,
      delivered: stats.delivered, pending: stats.pending, bytes: stats.bytes,
      buffered: buffer.length, last_reason: stats.last_reason, last_at: stats.last_at,
      queue_depth: queue.size(),
      posts_log: postLog.slice(),
    };
  }

  function close() { if (timer) { clearInterval(timer); timer = null; } }

  /** 接线层注册"每次 flush 完成"的回调（含 whenIdle 触发的 flush）；注入式实例同样适用 */
  function setOnResult(fn) { onResult = typeof fn === 'function' ? fn : null; }
  /** 接线层注册"whenIdle 有界超时"的回调（用于把 audit_idle_timeout 记进任务状态） */
  function setOnIdleTimeout(fn) { onIdleTimeout = typeof fn === 'function' ? fn : null; }

  return { add, buildEvent, flush, whenIdle, summary, close, setOnResult, setOnIdleTimeout, size: () => buffer.length, postLog };
}

module.exports = {
  MAX_BATCH_EVENTS, MAX_BATCH_BYTES, DEFAULT_MAX_BATCH_DELAY_MS,
  createAuditBatcher, appendLine, sanitizeReasons, runKeyOf, compareEvents, shardEvents, validateEvent, scrubReason,
};
