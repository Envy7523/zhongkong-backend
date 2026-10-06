'use strict';
/**
 * 结构化日志：JSON Lines，按天分文件写入 logs/<channel>-YYYY-MM-DD.log，
 * 同时输出到 stdout（systemd 会收进 journal）。
 *
 * 安全约束：所有写入日志的内容都会先经过脱敏，禁止出现
 * 密码 / 校验码 / Cookie / Token / 短信码 / 扫码票据 / 企微 key 等敏感值。
 */
const fs = require('fs');
const path = require('path');
const P = require('./paths');

/** 常驻服务（与具体报表无关）统一使用的 report_type 固定值 */
const SYSTEM_REPORT_TYPE = '_system';

/** 命中这些 key 名的字段值一律打码（注意 sign 用词边界，避免误伤 signal 等普通词） */
const SENSITIVE_KEY_RE =
  /(pass(word|wd)?|secret|token|cookie|authorization|auth|session|sid|ticket|qrcode|qr_?code|sms|verify|vcode|captcha|webhook|api[-_]?key|apikey|signature|(^|_)sign($|_)|credential|corpid|corpsecret)/i;

/** 命中这些值形态的内容一律打码（Bearer / 长串 base64 / key= 参数） */
const SENSITIVE_VALUE_RES = [
  /(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi,
  /([?&](?:key|token|secret|code|ticket|sig|signature)=)[^&\s"'\\]+/gi,
  /\b(sk-[A-Za-z0-9]{8,})\b/g,
];

const MASK = '[REDACTED]';

function redactString(s) {
  let out = s;
  for (const re of SENSITIVE_VALUE_RES) out = out.replace(re, (m, p1) => `${p1}${MASK}`);
  return out;
}

/** 递归脱敏：敏感 key 的值整体打码；字符串再走值形态规则；限制深度防循环 */
function redact(value, depth = 0, seen = new WeakSet()) {
  if (depth > 6) return '[DEPTH_LIMIT]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const s = value.length > 4000 ? value.slice(0, 4000) + '…[TRUNCATED]' : value;
    return redactString(s);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), stack: redactString(String(value.stack || '')) };
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1, seen));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? MASK : redact(v, depth + 1, seen);
    }
    return out;
  }
  return String(value);
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 任务级 logger（**必须显式传入 report_type**，禁止从全局可变状态推断）。
 *  - report_type 必须来自已注册注册表；未授权（如 item_sales_detail）直接抛错，不创建任何文件；
 *  - 该任务产生的每一条 JSON 日志都带 report_type / platform / task_id / business_date。
 */
function createTaskLogger(channel, { reportType, platform = 'meituan', taskId, businessDate }) {
  if (!reportType) throw new Error('createTaskLogger 必须显式传入 reportType（禁止推断）');
  const rt = P.assertReportType(reportType);
  if (!P.REPORT_TYPES[rt].authorized) {
    throw new Error(`report_type「${rt}」未授权（authorized=false）：禁止创建任务 logger / 状态 / 下载目录或任何业务文件`);
  }
  if (!taskId) throw new Error('createTaskLogger 必须显式传入 taskId');
  P.ensureDir(P.logs);
  const file = path.join(P.logs, `${channel}-${today()}.log`);
  const stream = fs.createWriteStream(file, { flags: 'a' });

  function write(level, event, data) {
    // report_type 位置固定，且保证不为 undefined
    const rec = {
      ts: new Date().toISOString(),
      level,
      channel,
      report_type: rt,
      platform,
      task_id: taskId,
      business_date: businessDate === undefined ? null : String(businessDate),
      event,
    };
    if (data !== undefined) rec.data = redact(data);
    const line = JSON.stringify(rec);
    stream.write(line + '\n');
    const tag = `[${rec.ts}] ${level.toUpperCase().padEnd(5)} ${channel} ${rt} ${taskId} ${event}`;
    if (level === 'error') console.error(tag, data === undefined ? '' : JSON.stringify(rec.data));
    else console.log(tag, data === undefined ? '' : JSON.stringify(rec.data));
    return rec;
  }

  return {
    file,
    report_type: rt,
    platform,
    task_id: taskId,
    business_date: businessDate === undefined ? null : String(businessDate),
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data),
    step: (event, data) => write('step', event, data),
    close: () => new Promise((r) => stream.end(r)),
    redact,
    /** task-scoped child logger：派生新 channel 但沿用同一 report_type/task 上下文 */
    child: (childChannel, extra = {}) => createTaskLogger(childChannel, { reportType: rt, platform, taskId, businessDate: extra.businessDate === undefined ? businessDate : extra.businessDate }),
  };
}

/**
 * 常驻服务 logger（与报表无关）：report_type 固定为 "_system"，绝不为 undefined。
 */
function createSystemLogger(channel = 'syncbot', { platform = 'meituan', taskId = null } = {}) {
  P.ensureDir(P.logs);
  const file = path.join(P.logs, `${channel}-${today()}.log`);
  const stream = fs.createWriteStream(file, { flags: 'a' });

  function write(level, event, data) {
    const rec = {
      ts: new Date().toISOString(),
      level,
      channel,
      report_type: SYSTEM_REPORT_TYPE,
      platform,
      task_id: taskId,
      business_date: null,
      event,
    };
    if (data !== undefined) rec.data = redact(data);
    const line = JSON.stringify(rec);
    stream.write(line + '\n');
    const tag = `[${rec.ts}] ${level.toUpperCase().padEnd(5)} ${channel} ${SYSTEM_REPORT_TYPE} ${event}`;
    if (level === 'error') console.error(tag, data === undefined ? '' : JSON.stringify(rec.data));
    else console.log(tag, data === undefined ? '' : JSON.stringify(rec.data));
    return rec;
  }

  return {
    file,
    report_type: SYSTEM_REPORT_TYPE,
    platform,
    task_id: taskId,
    business_date: null,
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data),
    step: (event, data) => write('step', event, data),
    close: () => new Promise((r) => stream.end(r)),
    redact,
  };
}

/**
 * 兼容旧调用：**仅用于常驻服务**。任务日志请改用 createTaskLogger（显式 report_type）。
 * 不再从环境变量/全局状态推断报表类型。
 */
function createLogger(channel = 'syncbot', opts = {}) {
  return createSystemLogger(channel, opts);
}

/** 清理超过保留期的日志（阶段5 定时调用；默认 90 天） */
function cleanupOldLogs(days = 90, { dryRun = true } = {}) {
  const cutoff = Date.now() - days * 86400000;
  const removed = [];
  if (!fs.existsSync(P.logs)) return removed;
  for (const name of fs.readdirSync(P.logs)) {
    const full = path.join(P.logs, name);
    const st = fs.statSync(full);
    if (!st.isFile()) continue;
    if (st.mtimeMs < cutoff) {
      removed.push({ file: full, mtime: st.mtime.toISOString(), size: st.size });
      if (!dryRun) fs.unlinkSync(full);
    }
  }
  return removed;
}

module.exports = { createLogger, createTaskLogger, createSystemLogger, SYSTEM_REPORT_TYPE, cleanupOldLogs, redact, SENSITIVE_KEY_RE };
