'use strict';
/**
 * 阶段4 · **企业微信推送客户端**（唯一允许发出推送的出口）
 *
 * 硬性约束（逐条对应本轮要求）：
 *  1. **真实发送能力必须由外部注入**（`sender`）：本模块自身**不读取、不持有**任何真实
 *     webhook / token / 密钥；未注入 sender 时 fail-closed（push_sender_not_configured，0 次发送）。
 *     离线测试一律注入 fake client，因此测试进程中不存在任何真实凭据。
 *  2. 消息内容**只能是已脱敏汇总**：业务日期、导入批次号、门店数/导入行数等统计、SHA **前缀(12)**、
 *     状态文案。绝不含 JWT / 口令 / Authorization / 完整 SHA / 绝对路径 / Excel 明细 / 文件名。
 *  3. 默认超时 15s（可注入覆盖）；**零自动重试**：每次调用最多投递 1 次。
 *  4. 结果**绝不抛出**：失败返回结构化脱敏错误码；超时/网络异常/5xx 标记
 *     `delivery_uncertain=true`（消息可能已送达），调用方据此**禁止自动重发**。
 */
const { scrubText } = require('./real-download-audit');

const DEFAULT_TIMEOUT_MS = 15000;
const SHA_PREFIX_LEN = 12;
/** 允许出现在推送文案里的字段（白名单，逐项脱敏后拼接） */
const SUMMARY_FIELDS = ['businessDate', 'importBatchId', 'rawStoreCount', 'matchedStoreCount', 'imported', 'sha256Prefix', 'status'];

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : null; }

/**
 * 构造**脱敏**推送文案。只接受白名单字段；任何非白名单输入一律忽略。
 * @returns {string}
 */
function buildPushSummary(src = {}) {
  const s = src || {};
  const lines = ['【syncbot】综合营业统计 · 导入完成'];
  const bd = String(s.businessDate || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(bd)) lines.push('业务日期：' + bd);
  const batch = num(s.importBatchId);
  if (batch !== null) lines.push('导入批次：' + batch);
  const matched = num(s.matchedStoreCount);
  const raw = num(s.rawStoreCount);
  if (matched !== null) lines.push('匹配门店：' + matched + ' 家');
  if (raw !== null) lines.push('原始行数：' + raw);
  const imported = num(s.imported);
  if (imported !== null) lines.push('导入行数：' + imported);
  const prefix = String(s.sha256Prefix || '');
  if (/^[0-9a-f]{1,12}$/i.test(prefix)) lines.push('文件摘要：' + prefix.toLowerCase() + '（前 ' + prefix.length + ' 位）');
  lines.push('状态：' + scrubText(s.status || '导入成功，可推送', 40));
  return lines.join('\n');
}

function createPushClient({ ctx = null, opts = {}, logger = null, sender = null } = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const theSender = sender || opts.sender || null;
  const counters = { sends: 0 };
  let lastSummary = null;

  function note(obj) {
    lastSummary = obj;
    if (logger && typeof logger.info === 'function') { try { logger.info('push_client', obj); } catch (_) {} }
  }
  function result(code, extra) {
    return Object.assign({
      ok: false, http: null, error_code: code, reason: scrubText(code, 120),
      message_id: null, delivery_uncertain: false, attempts: counters.sends, sent: counters.sends,
    }, extra || {});
  }

  /**
   * 发送一条脱敏汇总。**永不抛出；最多发送 1 次**。
   * @param {string} summary 已由 buildPushSummary 生成的文案
   */
  async function sendSummary(summary, o = {}) {
    const content = String(summary == null ? '' : summary);
    if (!content.trim()) return result('push_content_empty', { attempts: 0, sent: 0 });
    if (!theSender || typeof theSender.send !== 'function') {
      return result('push_sender_not_configured', { attempts: 0, sent: 0 });
    }
    const payload = { msgtype: 'text', text: { content } };
    const limit = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? Number(o.timeoutMs) : timeoutMs;
    counters.sends += 1;
    let timer = null;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ __timeout: true }), limit); });
    let res = null;
    try {
      res = await Promise.race([
        Promise.resolve().then(() => theSender.send(payload, { timeoutMs: limit })).then((r) => r, (e) => ({ __thrown: true, error: (e && e.code) || 'error' })),
        timeout,
      ]);
    } catch (e) {
      res = { __thrown: true, error: (e && e.code) || 'error' };
    }
    if (timer) { clearTimeout(timer); timer = null; }
    if (res && res.__timeout) {
      const r = result('push_timeout', { delivery_uncertain: true, reason: 'push_timeout' });
      note({ ok: false, error_code: 'push_timeout', sends: counters.sends });
      return r;
    }
    if (!res || res.__thrown) {
      const r = result('push_network_error', { delivery_uncertain: true, reason: 'push_network_error(' + scrubText((res && res.error) || 'error', 40) + ')' });
      note({ ok: false, error_code: 'push_network_error', sends: counters.sends });
      return r;
    }
    const status = Number.isFinite(Number(res.http !== undefined ? res.http : res.status)) ? Number(res.http !== undefined ? res.http : res.status) : null;
    if (res.ok === true) {
      if (status !== null && (status < 200 || status >= 300)) {
        // 声称成功但 HTTP 非 2xx：按失败处理（宁可人工确认，也不伪造成功）
        const r = result(status >= 500 ? 'push_http_5xx' : 'push_http_4xx', { http: status, delivery_uncertain: status >= 500 });
        note({ ok: false, error_code: r.error_code, http: status, sends: counters.sends });
        return r;
      }
      const r = { ok: true, http: status === null ? 200 : status, error_code: null, reason: null, message_id: res.message_id ? String(res.message_id).slice(0, 64) : null, delivery_uncertain: false, attempts: counters.sends, sent: 1 };
      note({ ok: true, http: r.http, sends: counters.sends, has_message_id: !!r.message_id });
      return r;
    }
    const code = status === null ? 'push_network_error'
      : status >= 500 ? 'push_http_5xx'
        : status >= 400 ? 'push_http_4xx' : 'push_response_invalid';
    const uncertain = status === null || status >= 500;
    const r = result(code, { http: status, delivery_uncertain: uncertain, reason: scrubText((res && (res.error || res.reason)) || code, 120) });
    note({ ok: false, error_code: code, http: status, uncertain, sends: counters.sends });
    return r;
  }

  return { sendSummary, buildPushSummary, counters, lastSummary: () => lastSummary, timeoutMs, hasSender: !!(theSender && typeof theSender.send === 'function') };
}

module.exports = { createPushClient, buildPushSummary, DEFAULT_TIMEOUT_MS, SUMMARY_FIELDS, SHA_PREFIX_LEN };
