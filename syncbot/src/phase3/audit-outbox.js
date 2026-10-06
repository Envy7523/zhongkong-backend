'use strict';
/**
 * 审计事件 **本地 outbox**（阶段3 接线层）
 *
 * 解决的问题：审计上报失败不能静默丢失，也不能因审计接口暂时不可用而重复业务动作。
 * 做法：
 *   1) emit() 先把事件**持久化**到本地 outbox（JSONL，0600，目录 0700）再尝试上报 —— 先落盘后发送；
 *   2) 中控确认接受（HTTP 2xx 且无 rejected）后才追加 delivered 标记；
 *   3) HMAC/网络失败时追加 audit_pending 记录并返回 {ok:false, queued:true}，
 *      **绝不返回假的成功**，也绝不因为审计失败而让调用方重跑业务动作；
 *   4) flush() 在网络/HMAC 恢复后按原 event_id 补送一次 —— event_id 稳定，
 *      服务端按 event_id 幂等，重复补送不会产生重复记录。
 *
 * event_id 稳定性：sha256(task_id|report_type|business_date|stage|seq) 前 32 位。
 * 同一任务同一阶段同一 seq 恒得同一 event_id → 重发/补送天然幂等。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('../paths');
const R = require('./audit-reporter');

/** 与中控 lib/sync-job-audit.js 的 STAGES 保持一致的 13 个阶段 */
const STAGES = [
  'PRECHECK', 'QUERY_DONE', 'EXPORT_SUBMITTED', 'WAITING_EXPORT', 'DOWNLOADED', 'FILE_VALIDATED',
  'IMPORT_STARTED', 'IMPORT_SUCCEEDED', 'IMPORT_FAILED',
  'PUSH_SUCCEEDED', 'PUSH_FAILED', 'FAILED', 'WAITING_HUMAN',
];

function outboxFile(platform, reportType, businessDate) {
  const dir = path.join(P.state, 'audit-outbox', platform, reportType);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (_) {}
  return path.join(dir, `${businessDate}.jsonl`);
}

function stableEventId({ taskId, reportType, businessDate, stage, seq }) {
  return 'evt-' + crypto.createHash('sha256')
    .update([taskId, reportType, businessDate, stage, String(seq)].join('|'))
    .digest('hex').slice(0, 32);
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}
function appendLine(file, obj) {
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeSync(fd, JSON.stringify(obj) + '\n'); } finally { fs.closeSync(fd); }
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

/** 尚未被 delivered 标记覆盖的事件（按稳定 event_id 去重） */
/**
 * 脱敏 rejected 原因：只保留「reason code + 白名单字段名」，绝不通传服务端任意文本。
 * 剥离：绝对路径、Windows 路径、≥32 位 hex（可能是 sha256/密钥）、JWT 片段。
 * 每项 ≤160 字符；最多 10 项。
 */
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

function pendingEvents(file) {
  const lines = readLines(file);
  const delivered = new Set(lines.filter((l) => l.type === 'delivered' && l.event_id).map((l) => l.event_id));
  const seen = new Set();
  const out = [];
  for (const l of lines) {
    if (l.type !== 'event' || !l.event) continue;
    // 事件行把 id 嵌在 l.event.event_id（**不是**顶层）。此前读顶层导致 delivered 回执
    // 永远匹配不上、且 seen.add(undefined) 之后所有后续事件行被跳过 ——
    // 于是"已被服务器幂等确认"的事件被误判为 pending，pending 永远清不掉（已由取证确认）。
    const id = l.event.event_id || l.event_id;
    if (!id) continue;
    if (delivered.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(l.event);
  }
  return out;
}

/**
 * 落盘后上报。永不抛出；永不伪造成功。
 * @returns {Promise<{ok:boolean,event_id:string,queued:boolean,reason?:string,status?:number}>}
 */
async function emit({ ctx, stage, seq = 1, metrics = {}, detail = {}, opts = {} }) {
  if (!ctx || !ctx.taskId || !ctx.reportType || !ctx.businessDate) throw new Error('emit 需要完整 TaskContext');
  if (!STAGES.includes(stage)) return { ok: false, queued: false, reason: `stage_not_in_contract:${stage}` };

  const file = outboxFile(ctx.platform, ctx.reportType, ctx.businessDate);
  // 测试事件必须带 test- 前缀（中控侧强校验），因此稳定 id 也随之带前缀；
  // 生产事件用 evt- 前缀，两条路径都不会伪造 is_test。
  const idPrefix = opts.testRunId ? 'test-' : 'evt-';
  const event = {
    event_id: idPrefix + stableEventId({ taskId: ctx.taskId, reportType: ctx.reportType, businessDate: ctx.businessDate, stage, seq }).slice(4),
    task_id: ctx.taskId,
    report_type: ctx.reportType,
    platform: ctx.platform,
    business_date: ctx.businessDate,
    stage,
    at: new Date().toISOString(),
    seq,
    // 脱敏：metrics/detail 一律经 reporter 的白名单+路径/密钥清洗；sha256 只保留 12 位前缀
    metrics: R.normalizeMetrics(metrics),
    detail: R.sanitize(detail),
  };
  // 仅测试可显式声明 test_run_id（生产调用方从不传，事件因此永不带 is_test）
  if (opts.testRunId) { event.is_test = true; event.test_run_id = String(opts.testRunId); }

  appendLine(file, { type: 'event', at: event.at, event });

  const res = await R.reportEvents([event], opts);
  // 送达语义（固化）：accepted>0 → accepted；duplicates>0 → duplicate（服务器幂等确认，
  // **同样算送达**）；rejected>0 或网络/HMAC 失败 → 保留 pending。绝不把 duplicate 当失败。
  const accepted = res.accepted || 0;
  const duplicates = res.duplicates || 0;
  const kind = res.ok ? (accepted > 0 ? 'accepted' : (duplicates > 0 ? 'duplicate' : 'accepted')) : null;
  if (res.ok) {
    appendLine(file, { type: 'delivered', at: new Date().toISOString(), event_id: event.event_id, status: res.status || null, stage, delivery_kind: kind, accepted, duplicates });
    return { ok: true, event_id: event.event_id, stage, queued: false, status: res.status || null, delivery_kind: kind, accepted, duplicates, file };
  }
  appendLine(file, {
    type: 'audit_pending', at: new Date().toISOString(), event_id: event.event_id, stage,
    reason: res.reason || res.error || 'send_failed', status: res.status || null,
    rejected_count: (res.rejected || []).length, rejected_reasons: sanitizeReasons((res.rejected || []).flatMap((r) => (r && r.reasons) || [])),
  });
  return {
    ok: false, event_id: event.event_id, stage, queued: true,
    reason: res.reason || res.error || 'send_failed', status: res.status || null,
    rejected_count: (res.rejected || []).length,
    rejected_reasons: sanitizeReasons((res.rejected || []).flatMap((r) => (r && r.reasons) || [])),
    file,
  };
}

/** 补送：仅重发未送达事件，沿用原 event_id（服务端幂等，不会重复落库） */
async function flush({ ctx, opts = {} }) {
  const file = outboxFile(ctx.platform, ctx.reportType, ctx.businessDate);
  const pend = pendingEvents(file);
  const out = { attempted: pend.length, delivered: 0, failed: 0, details: [], file };
  for (const ev of pend) {
    const res = await R.reportEvents([ev], opts);
    const accepted = res.accepted || 0;
    const duplicates = res.duplicates || 0;
    const kind = res.ok ? (accepted > 0 ? 'accepted' : (duplicates > 0 ? 'duplicate' : 'accepted')) : null;
    if (res.ok) {
      appendLine(file, { type: 'delivered', at: new Date().toISOString(), event_id: ev.event_id, status: res.status || null, stage: ev.stage, via: 'flush', delivery_kind: kind, accepted, duplicates });
      out.delivered += 1;
      out.details.push({ event_id: ev.event_id, stage: ev.stage, ok: true, status: res.status || null, delivery_kind: kind, accepted, duplicates });
    } else {
      appendLine(file, { type: 'audit_pending', at: new Date().toISOString(), event_id: ev.event_id, stage: ev.stage, reason: res.reason || res.error || 'send_failed', via: 'flush' });
      out.failed += 1;
      out.details.push({ event_id: ev.event_id, stage: ev.stage, ok: false, reason: res.reason || res.error || null });
    }
  }
  out.ok = out.failed === 0;
  return out;
}

function pendingCount(ctx) {
  return pendingEvents(outboxFile(ctx.platform, ctx.reportType, ctx.businessDate)).length;
}

module.exports = { STAGES, outboxFile, stableEventId, emit, flush, pendingCount, pendingEvents };
