'use strict';
/**
 * 「自动同步与日报计划」核心（**纯函数**：无 IO、无 DB、无 HTTP、无时钟副作用）
 *
 * 冻结契约见 F:/NewDeom/_syncbot/schedule/CONTRACT.md
 *  · 时区固定 Asia/Shanghai（只读展示，不接受自定义）
 *  · HH:mm 严格校验：必须 24 小时制两位时分；拒绝秒、拒绝 "9:00"、拒绝自然语言、拒绝无效时间
 *  · 到期语义：只判定"今天的计划时刻"，已过则到期；**跨天不补跑**
 *  · 业务日期 = 计划时刻当天 - 1 天（前一个完整自然日）
 *  · 报表 B（item_sales_detail）在本层即被拒绝（locked_not_started）
 */

const TIMEZONE = 'Asia/Shanghai';
const REPORT_TYPE = 'cashier_composite';                  // 唯一允许的报表
const LOCKED_REPORT_B = 'item_sales_detail';              // 永远 locked_not_started
const JOBS = ['sync', 'report'];
const DEFAULT_SYNC_TIME = '01:05';
const DEFAULT_REPORT_TIME = '09:00';

const HHMM_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/** 允许被保存的字段（其余一律拒绝） */
const EDITABLE_FIELDS = ['sync_enabled', 'sync_time', 'report_enabled', 'report_time', 'timezone'];
const ZK_INTERNAL_MAX_EVENTS_SHAPE = null;                // 占位：本模块不处理事件批量

/* ------------------------------------------------------------------ 时间基础 */

function isValidHHmm(value) {
  return typeof value === 'string' && HHMM_RE.test(value);
}

function parseHHmm(value) {
  if (!isValidHHmm(value)) return null;
  const m = HHMM_RE.exec(value);
  return { hour: Number(m[1]), minute: Number(m[2]), text: value };
}

/** 某时刻在指定时区的本地日历/时间片段（用 Intl，避免硬编码偏移） */
function localParts(instant, timeZone = TIMEZONE) {
  const d = instant instanceof Date ? instant : new Date(instant);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(d)) p[part.type] = part.value;
  const date = p.year + '-' + p.month + '-' + p.day;
  const time = p.hour + ':' + p.minute + ':' + p.second;
  return { date, time, date_time: date + ' ' + time, hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second), year: Number(p.year), month: Number(p.month), day: Number(p.day) };
}

/** 时区偏移（分钟，本地 - UTC），tolerates DST-less zones 立即收敛 */
function tzOffsetMinutes(instant, timeZone = TIMEZONE) {
  const d = instant instanceof Date ? instant : new Date(instant);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(d)) p[part.type] = part.value;
  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  const base = Math.floor(d.getTime() / 1000) * 1000;
  return Math.round((asUTC - base) / 60000);
}

/** "本地日历日期 + HH:mm" → 真实 UTC 时刻 */
function localWallTimeToInstant(dateStr, hhmm, timeZone = TIMEZONE) {
  const t = parseHHmm(hhmm);
  const md = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
  if (!t || !md) throw new Error('localWallTimeToInstant: bad args');
  const guess = Date.UTC(Number(md[1]), Number(md[2]) - 1, Number(md[3]), t.hour, t.minute, 0, 0);
  let ts = guess;
  for (let i = 0; i < 4; i += 1) {
    const off = tzOffsetMinutes(new Date(ts), timeZone);
    const next = guess - off * 60000;
    if (next === ts) break;
    ts = next;
  }
  return new Date(ts);
}

/** 纯日历加减（对 YYYY-MM-DD 字符串运算，不做时区换算） */
function addDays(dateStr, days) {
  const md = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
  if (!md) throw new Error('addDays: bad date ' + dateStr);
  const t = Date.UTC(Number(md[1]), Number(md[2]) - 1, Number(md[3])) + days * 86400000;
  const d = new Date(t);
  return d.toISOString().slice(0, 10);
}

function isValidDateStr(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const md = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  const t = Date.UTC(Number(md[1]), Number(md[2]) - 1, Number(md[3]));
  const d = new Date(t);
  return d.toISOString().slice(0, 10) === value;
}

/** 前一个完整自然日（上海），用于"处理昨天的数据" */
function previousCompleteDate(instant, timeZone = TIMEZONE) {
  return addDays(localParts(instant, timeZone).date, -1);
}

/* ------------------------------------------------------------------ 到期判定 */

const REFUSAL = {
  JOB_INVALID: 'job_invalid',
  BUSINESS_DATE_INVALID: 'business_date_invalid',
  BUSINESS_DATE_IN_FUTURE: 'business_date_in_future',
  BUSINESS_DATE_NOT_COMPLETE: 'business_date_not_complete',
  NO_ACTIVE_RUN_SLOT: 'no_active_run_slot',
  ALREADY_SUCCESS: 'already_success',
  IN_FLIGHT_UNKNOWN: 'in_flight_unknown',
  JOB_DISABLED: 'job_disabled',
  CONFIRM_REQUIRED: 'confirm_required',
  REPORT_B_LOCKED: 'report_b_locked',
  SYNC_NOT_SUCCEEDED: 'sync_not_succeeded',
  IMPORT_NOT_VERIFIED: 'import_not_verified',
  ALREADY_PUSHED: 'already_pushed',
  PUSH_IN_FLIGHT_UNKNOWN: 'push_in_flight_unknown',
  WEBHOOK_NOT_CONFIGURED: 'webhook_not_configured',
  PUSH_FAILED: 'push_failed',
  PUSH_TIMEOUT_UNKNOWN: 'push_timeout_unknown',
  SYNC_RUNNER_MISSING: 'sync_runner_missing',
  NOT_YET: 'not_yet',
  TIMEZONE_NOT_CONFIGURABLE: 'timezone_not_configurable',
  TIME_FORMAT_INVALID: 'time_format_invalid',
  ENABLED_FLAG_INVALID: 'enabled_flag_invalid',
  NO_CHANGES: 'no_changes',
  UNKNOWN_FIELD: 'unknown_field',
  REPORT_TYPE_NOT_ALLOWED: 'report_type_not_allowed',
  CONFIG_NOT_FOUND: 'config_not_found',
};

/** 作业是否"到期"：只看今天的计划时刻；已过即到期（跨天不补跑） */
function dueDecision({ job, now, time, enabled, timezone = TIMEZONE }) {
  if (!JOBS.includes(job)) return { due: false, reason: REFUSAL.JOB_INVALID };
  if (enabled !== true) return { due: false, reason: REFUSAL.JOB_DISABLED, next_run_at: nextRunAt({ now, time, enabled: false, timezone }) };
  const t = parseHHmm(time);
  if (!t) return { due: false, reason: REFUSAL.TIME_FORMAT_INVALID };
  const lp = localParts(now, timezone);
  const today = lp.date;
  const scheduled = localWallTimeToInstant(today, time, timezone);
  if (new Date(now).getTime() < scheduled.getTime()) {
    return { due: false, reason: REFUSAL.NOT_YET, business_date: addDays(today, -1), scheduled_at: scheduled.toISOString(), next_run_at: scheduled.toISOString() };
  }
  return {
    due: true,
    business_date: addDays(today, -1),               // 前一个完整自然日
    scheduled_at: scheduled.toISOString(),
    scheduled_at_local: today + ' ' + time,
    local_date: today,
  };
}

/** 下一次计划运行时刻（UTC ISO）；disabled 时返回 null */
function nextRunAt({ now, time, enabled, timezone = TIMEZONE }) {
  if (enabled !== true) return null;
  if (!parseHHmm(time)) return null;
  const today = localParts(now, timezone).date;
  const todayInstant = localWallTimeToInstant(today, time, timezone);
  if (new Date(now).getTime() < todayInstant.getTime()) return todayInstant.toISOString();
  return localWallTimeToInstant(addDays(today, 1), time, timezone).toISOString();
}

function idempotencyKey(job, businessDate) {
  if (!JOBS.includes(job)) throw new Error('idempotencyKey: bad job');
  if (!isValidDateStr(businessDate)) throw new Error('idempotencyKey: bad date');
  return job + ':' + businessDate;
}

/* ------------------------------------------------------------------ 配置校验 */

/**
 * 严格校验前端提交的配置补丁。
 * 返回 {ok:true, patch} 或 {ok:false, reason, field}
 */
function validateSchedulePatch(body, current, now = new Date()) {
  const b = body && typeof body === 'object' ? body : {};
  const keys = Object.keys(b);
  if (!keys.length) return { ok: false, reason: REFUSAL.NO_CHANGES };
  for (const k of keys) if (!EDITABLE_FIELDS.includes(k)) return { ok: false, reason: REFUSAL.UNKNOWN_FIELD, field: k };
  const patch = {};
  for (const k of ['sync_enabled', 'report_enabled']) {
    if (b[k] === undefined) continue;
    if (b[k] === true || b[k] === false) patch[k] = b[k] ? 1 : 0;
    else if (b[k] === 1 || b[k] === 0) patch[k] = Number(b[k]);
    else return { ok: false, reason: REFUSAL.ENABLED_FLAG_INVALID, field: k };
  }
  for (const k of ['sync_time', 'report_time']) {
    if (b[k] === undefined) continue;
    if (!isValidHHmm(b[k])) return { ok: false, reason: REFUSAL.TIME_FORMAT_INVALID, field: k };
    patch[k] = b[k];
  }
  if (b.timezone !== undefined && String(b.timezone) !== TIMEZONE) {
    return { ok: false, reason: REFUSAL.TIMEZONE_NOT_CONFIGURABLE, field: 'timezone' };
  }
  const eff = effective(patch, current);
  if (eff.report_type && String(eff.report_type) !== REPORT_TYPE) return { ok: false, reason: REFUSAL.REPORT_TYPE_NOT_ALLOWED, field: 'report_type' };
  // 注意：不能对 '01:05' 这类字符串做 Number() 比较（NaN !== NaN 会误判为"有变化"）
  const changed = Object.keys(patch).some((k) => String(current && current[k] !== undefined ? current[k] : '') !== String(patch[k]));
  if (!changed) return { ok: false, reason: REFUSAL.NO_CHANGES };
  return { ok: true, patch };
}

function effective(patch, current) {
  return Object.assign({
    sync_enabled: 0, sync_time: DEFAULT_SYNC_TIME,
    report_enabled: 0, report_time: DEFAULT_REPORT_TIME, timezone: TIMEZONE,
  }, current || {}, patch || {});
}

/** 手工请求的业务日期校验（必须是已结束的完整自然日） */
function validateManualBusinessDate(businessDate, now = new Date(), timezone = TIMEZONE) {
  if (!isValidDateStr(businessDate)) return { ok: false, reason: REFUSAL.BUSINESS_DATE_INVALID };
  const today = localParts(now, timezone).date;
  if (businessDate > today) return { ok: false, reason: REFUSAL.BUSINESS_DATE_IN_FUTURE };
  if (businessDate === today) return { ok: false, reason: REFUSAL.BUSINESS_DATE_NOT_COMPLETE };
  return { ok: true, business_date: businessDate };
}

/** 报表类型闸门：报表 B 永远拒绝 */
function assertReportAllowed(reportType) {
  if (reportType === LOCKED_REPORT_B) return { ok: false, reason: REFUSAL.REPORT_B_LOCKED };
  if (reportType !== REPORT_TYPE) return { ok: false, reason: REFUSAL.REPORT_TYPE_NOT_ALLOWED };
  return { ok: true, report_type: REPORT_TYPE };
}

/** 默认配置（全部 disabled —— 本轮初始安全状态） */
function defaultConfig() {
  return { sync_enabled: 0, sync_time: DEFAULT_SYNC_TIME, report_enabled: 0, report_time: DEFAULT_REPORT_TIME, timezone: TIMEZONE, version: 1 };
}

/** 对外展示的配置视图（不含任何敏感字段） */
function publicConfig(cfg) {
  const c = effective(null, cfg);
  return {
    sync_enabled: c.sync_enabled === 1 || c.sync_enabled === true,
    sync_time: c.sync_time,
    report_enabled: c.report_enabled === 1 || c.report_enabled === true,
    report_time: c.report_time,
    timezone: TIMEZONE,
    version: Number(c.version || 1),
    updated_at: c.updated_at || null,
    updated_by_name: c.updated_by_name || null,
  };
}

/** 审计脱敏：只保留白名单字段 */
function sanitizeForAudit(obj) {
  const out = {};
  for (const k of ['sync_enabled', 'sync_time', 'report_enabled', 'report_time', 'timezone', 'version']) {
    if (obj && obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

module.exports = {
  TIMEZONE, REPORT_TYPE, LOCKED_REPORT_B, JOBS, DEFAULT_SYNC_TIME, DEFAULT_REPORT_TIME,
  EDITABLE_FIELDS, REFUSAL,
  isValidHHmm, parseHHmm, localParts, tzOffsetMinutes, localWallTimeToInstant, addDays, isValidDateStr,
  previousCompleteDate, dueDecision, nextRunAt, idempotencyKey,
  validateSchedulePatch, validateManualBusinessDate, assertReportAllowed,
  defaultConfig, publicConfig, sanitizeForAudit, effective,
};
