'use strict';
/**
 * syncbot → 中控 审计事件上报器（阶段3）
 *
 * 职责：把关键阶段以**结构化事件**上报到中控的本机回环接口
 *       `POST http://127.0.0.1:3456/api/internal/syncbot/events`
 *       （HMAC-SHA256 + 时间戳，详见 lib/sync-job-audit.js）。**不从普通日志解析**。
 *
 * 硬约束：
 *  - HMAC 密钥只从 0600 secrets 文件读取：`state/secrets/audit-hmac.json`；
 *    密钥、签名、JWT、Cookie 绝不出现在日志、截图、接口响应或控制台输出；
 *  - 上报前**先脱敏**：绝对服务器路径替换为 `[path]`，文件名只取 basename，
 *    sha256 只保留 12 位前缀；敏感键值直接剔除（服务端同样会拒绝，这里是第一道防线）；
 *  - 上报失败**绝不抛出**：返回 {ok:false, reason} 并只记一条不含敏感信息的告警，
 *    以免审计通道故障阻断真实下载/导入流程；
 *  - 未配置密钥时返回 {ok:false, reason:'not_configured'}，静默降级。
 *
 * 自检：node src/phase3/audit-reporter.js --selftest [--stage=PRECHECK]
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const P = require('../paths');
const { createTaskLogger } = require('../logger');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:3456/api/internal/syncbot/events';
const SENSITIVE_KEY_RE = /pass(word|wd)?|secret|token|jwt|cookie|authorization|hmac|signature|private_key|api[_-]?key|webhook/i;
const ABS_PATH_RE = /(^|[\s"'(=])(\/(?:home|opt|etc|var|root|tmp|usr)\/[^\s"')]*)|([A-Za-z]:\\[^\s"')]*)/g;
const SHA_PREFIX_LEN = 12;

function secretFile() {
  return path.join(P.secrets, 'audit-hmac.json');
}

/** 读取上报配置（只读；不打印任何字段值） */
function loadConfig(fileOverride) {
  const file = fileOverride || secretFile();
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const secret = String(j.secret || '').trim();
    if (secret.length < 16) return { ok: false, reason: 'secret_missing_or_too_short', file };
    return { ok: true, secret, endpoint: String(j.endpoint || DEFAULT_ENDPOINT), file };
  } catch (e) {
    return { ok: false, reason: `config_unreadable(${e.code || e.message})`, file };
  }
}

function scrubText(value) {
  return String(value == null ? '' : value).replace(ABS_PATH_RE, (m, pre) => `${pre || ''}[path]`).slice(0, 500);
}

/** 深度脱敏：剔除敏感键、路径化字符串、截断长度 */
function sanitize(value, depth = 0) {
  if (value == null) return value;
  if (depth > 4) return '[depth]';
  if (typeof value === 'string') return scrubText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 200);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(k)) continue;
    out[k] = sanitize(v, depth + 1);
  }
  return out;
}

/** 文件名/摘要按展示口径处理（先取 basename，再整体脱敏，避免文件名被路径替换吃掉） */
function normalizeMetrics(metrics = {}) {
  const raw = metrics || {};
  const derived = {};
  if (raw.original_filename) derived.original_filename = path.basename(String(raw.original_filename)).slice(0, 200);
  // 不在此派生 sha256_prefix：中控入站白名单只接受 sha256（lib/sync-job-audit.js），
  // 前缀由中控落库时自行截取；此前多发的 sha256_prefix 会被 400 拒绝并滞留 outbox。
  const m = Object.assign({}, sanitize(raw), derived);
  if (m.original_filename) m.original_filename = path.basename(String(m.original_filename)).slice(0, 200);
  if (m.failure_reason) m.failure_reason = scrubText(m.failure_reason);
  return m;
}

function buildEvent({ stage, taskId, reportType, businessDate, platform = 'meituan', seq, metrics, detail, now = () => new Date().toISOString() }) {
  return {
    event_id: crypto.randomUUID(),
    task_id: String(taskId),
    report_type: String(reportType),
    business_date: String(businessDate),
    platform: String(platform),
    stage: String(stage),
    at: now(),
    seq: Number.isFinite(Number(seq)) ? Number(seq) : undefined,
    metrics: normalizeMetrics(metrics),
    detail: sanitize(detail),
  };
}

function postJson({ endpoint, rawBody, timestamp, signature, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(endpoint); } catch { return resolve({ ok: false, reason: 'endpoint_invalid' }); }
    const lib = url.protocol === 'https:' ? require('https') : http;
    const payload = Buffer.from(rawBody, 'utf8');
    const req = lib.request({
      protocol: url.protocol, hostname: url.hostname, port: url.port || 80,
      path: url.pathname + url.search, method: 'POST',
      headers: {
        // 必须发送原始字节，签名覆盖未被重新序列化的确切内容
        'Content-Type': 'application/octet-stream',
        'Content-Length': payload.length,
        'X-Syncbot-Timestamp': timestamp,
        'X-Syncbot-Signature': signature,
      },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body || '{}'); } catch { parsed = null; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ ok: false, reason: `transport_error(${e.code || e.message})` }));
    req.write(payload);
    req.end();
  });
}

/**
 * 上报一批事件。**永不抛出**。
 * @returns {Promise<{ok:boolean, reason?:string, status?:number, accepted?:number, duplicates?:number, rejected?:any[]}>}
 */
async function reportEvents(events, opts = {}) {
  const cfg = loadConfig(opts.secretFile);
  if (!cfg.ok) return { ok: false, reason: cfg.reason };
  const rawBody = JSON.stringify({ events });
  const timestamp = String(Date.now());
  const signature = crypto.createHmac('sha256', cfg.secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  const res = await postJson({ endpoint: opts.endpoint || cfg.endpoint, rawBody, timestamp, signature, timeoutMs: opts.timeoutMs });
  if (!res.ok && !res.status) return { ok: false, reason: res.reason || 'unknown_transport_failure' };
  const b = res.body || {};
  return {
    ok: res.status >= 200 && res.status < 300 && b.rejected && b.rejected.length === 0,
    status: res.status,
    accepted: b.accepted || 0,
    duplicates: b.duplicates || 0,
    rejected: b.rejected || [],
    error: b.error || null,
  };
}

/** 单个阶段上报（失败只告警，不阻断） */
async function reportStage(params, opts = {}) {
  const logger = opts.logger || null;
  const event = buildEvent(params);
  const res = await reportEvents([event], opts);
  if (logger) {
    if (res.ok) logger.info('audit.report_ok', { stage: event.stage, accepted: res.accepted, duplicates: res.duplicates });
    else logger.warn('audit.report_failed', { stage: event.stage, reason: res.reason || res.error || 'rejected', status: res.status || null, rejected_count: (res.rejected || []).length });
  }
  return { ...res, event_id: event.event_id, stage: event.stage };
}

/** 绑定一个任务上下文的阶段上报器（自动递增 seq） */
function createStageReporter(ctx, { platform = 'meituan', logger = null, secretFile = null, endpoint = null } = {}) {
  let seq = 0;
  const opts = { logger, secretFile, endpoint };
  return {
    ctx,
    async stage(stage, { metrics, detail } = {}) {
      seq += 1;
      return reportStage({
        stage, taskId: ctx.taskId, reportType: ctx.reportType, businessDate: ctx.businessDate, platform, seq, metrics, detail,
      }, opts);
    },
    get seq() { return seq; },
  };
}

// ---------------- 自检 CLI（只发一条合成事件；不导出/不下载/不导入） ----------------
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (!argv.includes('--selftest')) {
    console.error('用法: node src/phase3/audit-reporter.js --selftest [--stage=PRECHECK] [--dry-run]');
    process.exit(2);
  }
  const stageArg = (argv.find((a) => a.startsWith('--stage=')) || '').split('=')[1] || 'PRECHECK';
  const dryRun = argv.includes('--dry-run');
  (async () => {
    const cfg = loadConfig();
    const out = { configured: cfg.ok, config_reason: cfg.reason || null, stage: stageArg, endpoint: dryRun ? '(dry-run)' : null };
    if (!cfg.ok) { console.log(JSON.stringify(out, null, 2)); process.exit(1); }
    const event = buildEvent({
      stage: stageArg, taskId: `selftest-${Date.now().toString(36)}`, reportType: 'cashier_composite',
      businessDate: new Date().toISOString().slice(0, 10), platform: 'meituan', seq: 1,
      metrics: { note: 'audit-reporter selftest', original_filename: '/opt/zhongkong-sync-bot/downloads/x/鹅太公.xlsx', sha256: 'abcdef0123456789' },
      detail: { purpose: 'selftest' },
    });
    out.event_preview = { stage: event.stage, task_id: event.task_id, metrics: event.metrics };
    if (dryRun) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
    const res = await reportEvents([event]);
    out.result = { ok: res.ok, status: res.status || null, accepted: res.accepted || 0, duplicates: res.duplicates || 0, rejected_count: (res.rejected || []).length, reason: res.reason || res.error || null };
    console.log(JSON.stringify(out, null, 2));
    process.exit(res.ok ? 0 : 1);
  })();
}

module.exports = {
  DEFAULT_ENDPOINT, secretFile, loadConfig, sanitize, scrubText, normalizeMetrics,
  buildEvent, reportEvents, reportStage, createStageReporter,
};
