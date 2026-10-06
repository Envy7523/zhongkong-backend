'use strict';
/**
 * 调度计划 · **纯函数模块**（契约第 1 节 / 第 5 节）
 *
 * 本模块**没有 IO**：不读写文件、不发 HTTP、不建定时器、不读环境变量。
 * 只做：HH:mm 解析与校验 / 上海时区"现在" / 业务日期 / 到期判定 / 幂等键 / 本地状态相对路径。
 *
 * 冻结的时间语义（CONTRACT.md 第 1 节）：
 *  - 时区固定 Asia/Shanghai（不接受自定义；用 Intl 的 timeZone 计算，**绝不硬编码 +08:00**）；
 *  - 两个作业（sync 默认 01:05 / report 默认 09:00）到达且 now >= 当日计划时刻才判定到期；
 *  - 计划时刻所在的那一天 **必须等于今天**：跨天停机恢复**不补跑**过去日期；
 *  - business_date = 今天-1；幂等键 = '<job>:<business_date>'。
 */
const TIMEZONE = 'Asia/Shanghai';
const JOB_SYNC = 'sync';
const JOB_REPORT = 'report';
const JOBS = [JOB_SYNC, JOB_REPORT];
/** 唯一允许的报表：报表 A */
const ALLOWED_REPORT_TYPE = 'cashier_composite';
/** 永远锁定的报表 B（任何入口出现即拒绝） */
const LOCKED_REPORT_TYPE = 'item_sales_detail';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** 本地状态机允许的状态（与 CONTRACT.md 第 2 节一致） */
const STATUSES = ['pending', 'running', 'success', 'failed', 'waiting_human', 'refused'];
/** 终态：同 (job, business_date) 不再自动执行 */
const TERMINAL_STATUSES = ['success', 'failed', 'waiting_human'];
/** 非终态但"结果未知"的残留标记 */
const UNCERTAIN_STATUS = 'running';

const FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function isJob(job) {
  return JOBS.indexOf(String(job)) >= 0;
}
function isPlainDate(v) {
  const s = String(v == null ? '' : v);
  if (!DATE_RE.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}
function assertPlainDate(v, what) {
  const s = String(v == null ? '' : v);
  if (!isPlainDate(s)) throw new Error((what || 'business_date') + ' 必须是 YYYY-MM-DD 的真实日期（收到：' + s.slice(0, 32) + '）');
  return s;
}
function isTerminalStatus(status) {
  return TERMINAL_STATUSES.indexOf(String(status)) >= 0;
}

/** HH:mm 解析/校验：返回 {ok:true,hh,mm,minutes,normalized} 或 {ok:false,reason} */
function parseHHmm(text) {
  const s = String(text == null ? '' : text).trim();
  const m = HHMM_RE.exec(s);
  if (!m) return { ok: false, reason: 'time_format_invalid' };
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return { ok: true, hh, mm, minutes: hh * 60 + mm, normalized: m[1] + ':' + m[2] };
}

/**
 * 上海时区"现在"。**只用 Intl 的 timeZone，绝不硬编码 +08:00 偏移**。
 * @returns {{date:string,time:string,local:string,minutes:number,epoch_ms:number,timezone:string}}
 */
function shanghaiNow(dateInput) {
  const d = dateInput === undefined ? new Date() : (dateInput instanceof Date ? dateInput : new Date(dateInput));
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new Error('shanghaiNow 收到非法时间');
  const parts = {};
  for (const p of FORMATTER.formatToParts(d)) if (p.type !== 'literal') parts[p.type] = p.value;
  // 个别 ICU 版本在 h23 下仍会给出 '24'，统一归一到 '00'
  const hour = String(parts.hour) === '24' ? '00' : String(parts.hour);
  const date = parts.year + '-' + parts.month + '-' + parts.day;
  const time = hour + ':' + parts.minute + ':' + parts.second;
  return {
    date, time, local: date + ' ' + time,
    minutes: Number(hour) * 60 + Number(parts.minute),
    epoch_ms: d.getTime(), timezone: TIMEZONE, source: 'intl',
  };
}

function localParts(date, time) {
  const d = assertPlainDate(date, 'now.date');
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(String(time || ''));
  if (!m) throw new Error('now.time 必须是 HH:mm[:ss]');
  const hh = Number(m[1]); const mm = Number(m[2]); const ss = Number(m[3] || 0);
  const t = (hh < 10 ? '0' + hh : String(hh)) + ':' + m[2] + ':' + (ss < 10 ? '0' + ss : String(ss));
  return { date: d, time: t, local: d + ' ' + t, minutes: hh * 60 + mm, epoch_ms: null, timezone: TIMEZONE, source: 'literal' };
}

/**
 * 把多种"现在"入参归一到上海本地时间结构。
 * 接受：undefined（真实时钟）/ Date / epoch ms / ISO 串 / 'YYYY-MM-DD HH:mm[:ss]' / {local} / {date,time}。
 * 显式给出的 'YYYY-MM-DD HH:mm:ss' 一律**按上海本地时间**解释（测试与 --dry-run 用）。
 */
function resolveNow(input) {
  if (input === undefined || input === null) return shanghaiNow(new Date());
  if (input instanceof Date) return shanghaiNow(input);
  if (typeof input === 'number') return shanghaiNow(new Date(input));
  if (typeof input === 'string') {
    const s = input.trim();
    const lit = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(s);
    if (lit) return localParts(lit[1], lit[2]);
    return shanghaiNow(new Date(s));
  }
  if (typeof input === 'object') {
    if (typeof input.local === 'string') {
      const lit = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(input.local.trim());
      if (lit) return localParts(lit[1], lit[2]);
    }
    if (input.date !== undefined && input.time !== undefined) return localParts(input.date, input.time);
    if (input.date !== undefined) return localParts(input.date, '00:00');
  }
  throw new Error('无法识别的 now 入参（仅接受 Date / ISO / YYYY-MM-DD HH:mm:ss / {date,time}）');
}

/** 被处理的业务日期 = 今天-1（上海本地日期减一天；用 UTC 运算避免本地时区干扰） */
function previousCompleteDate(nowLocal) {
  const date = assertPlainDate(typeof nowLocal === 'string' ? nowLocal.slice(0, 10) : (nowLocal && nowLocal.date), 'now.date');
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 86400000).toISOString().slice(0, 10);
}

/** 是否是完整自然日（<= 今天-1，非未来） */
function isCompleteDate(businessDate, nowLocal) {
  const bd = assertPlainDate(businessDate);
  const today = resolveNow(nowLocal === undefined ? undefined : nowLocal).date;
  return bd < today;
}

/**
 * 到期判定（契约第 1 节）：
 *  仅当「计划时刻所在的那一天 == 今天」且 now >= 计划时刻 时到期。
 *  ⇒ 跨天停机恢复时，昨天的计划时刻所属日期 != 今天 ⇒ **不补跑**。
 * @returns {{due:boolean, reason:string, scheduled_moment:string|null, business_date:string|null, idempotency_key:string|null}}
 */
function dueDetail({ job, now, scheduledTime, enabled, configUpdatedAt = null } = {}) {
  const n = resolveNow(now);
  const businessDate = previousCompleteDate(n);
  const base = { due: false, reason: 'not_due', scheduled_moment: null, business_date: businessDate, idempotency_key: null, job: String(job == null ? '' : job) };
  if (!isJob(job)) return Object.assign(base, { reason: 'job_invalid' });
  if (enabled !== true) return Object.assign(base, { reason: 'job_disabled' });
  const p = parseHHmm(scheduledTime);
  if (!p.ok) return Object.assign(base, { reason: p.reason });
  // 计划时刻只取"今天"这一次（绝不取昨天）：这就是"不补跑过去日期"的实现。
  const scheduledDate = n.date;
  const scheduledMoment = scheduledDate + ' ' + p.normalized + ':00';
  if (scheduledDate !== n.date) return Object.assign(base, { reason: 'different_day_no_backfill', scheduled_moment: scheduledMoment });
  // 当天计划时刻已过去才修改/启用配置时，不能在下一次 tick 追跑昨天的数据。
  // 保存时间是中控生成的 UTC ISO；只在“保存发生于今天”时比较，历史配置不受影响。
  if (configUpdatedAt) {
    const changed = new Date(configUpdatedAt);
    if (Number.isFinite(changed.getTime())) {
      const changedLocal = shanghaiNow(changed);
      if (changedLocal.date === n.date && changedLocal.local >= scheduledMoment) {
        return Object.assign(base, { reason: 'configured_after_scheduled_time', scheduled_moment: scheduledMoment });
      }
    }
  }
  if (n.minutes < p.minutes) return Object.assign(base, { reason: 'before_scheduled_time', scheduled_moment: scheduledMoment });
  return Object.assign(base, {
    due: true, reason: 'due', scheduled_moment: scheduledMoment,
    idempotency_key: idempotencyKey(job, businessDate),
  });
}

function isDue(args) {
  return dueDetail(args).due === true;
}

/** 幂等键：'sync:<date>' / 'report:<date>'（job 非法或日期非法一律抛错） */
function idempotencyKey(job, businessDate) {
  if (!isJob(job)) throw new Error('未知作业：' + String(job).slice(0, 32) + '（仅 sync/report）');
  return String(job) + ':' + assertPlainDate(businessDate);
}

/** 本地幂等状态**相对路径**：state/schedule/<job>/<YYYY-MM-DD>.json（纯字符串，不碰磁盘） */
function scheduleStateRelPath(job, businessDate) {
  if (!isJob(job)) throw new Error('未知作业：' + String(job).slice(0, 32) + '（仅 sync/report）');
  return ['state', 'schedule', String(job), assertPlainDate(businessDate) + '.json'].join('/');
}

/** 深度扫描：任何入口出现报表 B（item_sales_detail）都必须被拒绝 */
function containsLockedReport(value, depth = 0) {
  if (value == null || depth > 4) return false;
  if (typeof value === 'string') return value.toLowerCase().indexOf(LOCKED_REPORT_TYPE) >= 0;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => containsLockedReport(v, depth + 1));
  for (const [k, v] of Object.entries(value)) {
    if (containsLockedReport(k, depth + 1)) return true;
    if (containsLockedReport(v, depth + 1)) return true;
  }
  return false;
}
function assertNotLockedReport(value, what) {
  if (containsLockedReport(value)) {
    throw new Error('报表 B（' + LOCKED_REPORT_TYPE + '）永远锁定：' + (what || '入口') + ' 一律拒绝（report_b_locked）');
  }
  return true;
}

module.exports = {
  TIMEZONE, JOB_SYNC, JOB_REPORT, JOBS,
  ALLOWED_REPORT_TYPE, LOCKED_REPORT_TYPE,
  STATUSES, TERMINAL_STATUSES, UNCERTAIN_STATUS,
  isJob, isPlainDate, assertPlainDate, isTerminalStatus, isCompleteDate,
  parseHHmm, shanghaiNow, resolveNow, previousCompleteDate,
  dueDetail, isDue, idempotencyKey, scheduleStateRelPath,
  containsLockedReport, assertNotLockedReport,
};
