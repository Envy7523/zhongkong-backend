'use strict';
/**
 * 中控内部接口 **HMAC 客户端**（契约第 3 节 I1–I4）
 *
 * 硬约束（逐条落实）：
 *  1. **只允许 base http://127.0.0.1:3456**：host 必须是回环字面量 127.0.0.1，端口必须是 3456，
 *     协议必须是 http。其它 host/端口一律**硬拒**（构造即拒绝，绝不发出请求）。
 *     离线套件需要随机端口 mock 时，必须显式打开 allowTestBase（仅测试注入）；
 *     生产路径（CLI/worker 默认）**永远**走 3456 且不接受覆盖。
 *  2. 密钥只从 0600 secrets 文件读取：state/secrets/audit-hmac.json 的 secret 字段；
 *     密钥、签名、时间戳**绝不出现在**返回值、日志、状态文件、异常消息里。
 *  3. **单次请求**：每个方法最多发一次 HTTP；超时/失败一律 fail-closed 返回，**绝不自动重试**
 *     （send 类调用尤其禁止重试：claim/settle/report-push）。
 *  4. 签名与既有 /api/internal/syncbot/events 完全一致：
 *     X-Syncbot-Timestamp + X-Syncbot-Signature = HMAC_SHA256(secret, ts + '.' + rawBody)。
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const P = require('../paths');

const DEFAULT_BASE = 'http://127.0.0.1:3456';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3456;
const DEFAULT_TIMEOUT_MS = 8000;
const PREFIX = '/api/internal/syncbot/schedule';
const PATHS = {
  schedule: PREFIX,
  claim: PREFIX + '/claim',
  settle: PREFIX + '/settle',
  reportPush: PREFIX + '/report-push',
  // 契约 v2 §2.2：中控**只读**覆盖接口（syncbot 生产 runner 的 G1/G3 闸门用它判定"该业务日期是否已在库"）
  coverage: '/api/internal/syncbot/coverage',
  // 收银系统品项销售明细独立覆盖；不得用 A 的营收记录判定 B 是否已入库。
  itemSalesCoverage: '/api/internal/syncbot/item-sales-coverage',
  bookkeepingCoverage: '/api/internal/syncbot/bookkeeping-coverage',
  reportSyncPlan: '/api/internal/syncbot/report-sync-plans',
  // 契约 v2 追加 D–E §G.6：中控**只读**已导入汇总（G1 命中时完整性核验的对照口径）
  importedSummary: '/api/internal/syncbot/imported-summary',
};
/** 超时/连接中断这类"请求可能已经到达服务端"的失败 → unknown */
const UNKNOWN_CODES = ['timeout', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ERR_STREAM_WRITE_AFTER_END', 'socket hang up'];

function defaultSecretFile() {
  return path.join(P.secrets, 'audit-hmac.json');
}

/** 解析并校验 base：只允许 http://127.0.0.1:3456（allowTestBase 时才允许换端口） */
function assertBase(base, { allowTestBase = false } = {}) {
  const raw = String(base == null || base === '' ? DEFAULT_BASE : base).trim();
  let u;
  try { u = new URL(raw); } catch (e) { return { ok: false, reason: 'base_invalid' }; }
  if (u.protocol !== 'http:') return { ok: false, reason: 'base_scheme_not_allowed' };
  if (u.username || u.password) return { ok: false, reason: 'base_credentials_not_allowed' };
  if (u.search || u.hash) return { ok: false, reason: 'base_query_not_allowed' };
  if (u.pathname && u.pathname !== '/') return { ok: false, reason: 'base_path_not_allowed' };
  if (u.hostname !== DEFAULT_HOST) return { ok: false, reason: 'base_host_not_allowed' };
  const port = u.port === '' ? 80 : Number(u.port);
  if (port !== DEFAULT_PORT && allowTestBase !== true) return { ok: false, reason: 'base_port_not_allowed' };
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { ok: false, reason: 'base_port_not_allowed' };
  return { ok: true, base: 'http://' + DEFAULT_HOST + ':' + port, host: DEFAULT_HOST, port, test_override: port !== DEFAULT_PORT };
}

/** 读取 HMAC 密钥（只读；返回值里带 secret，调用方**必须**不外泄） */
function loadSecret(secretFile) {
  const file = secretFile || defaultSecretFile();
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const secret = String(j && j.secret ? j.secret : '').trim();
    if (secret.length < 16) return { ok: false, reason: 'secret_missing_or_too_short' };
    return { ok: true, secret };
  } catch (e) {
    return { ok: false, reason: 'secret_unreadable' };
  }
}

/** 单次 HTTP 请求（绝不重试）。返回 {ok,status,body} 或 {ok:false,reason,unknown} */
function requestOnce({ base, pathName, method, rawBody, timestamp, signature, timeoutMs }) {
  return new Promise((resolve) => {
    const payload = Buffer.from(rawBody == null ? '' : rawBody, 'utf8');
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = http.request({
        host: DEFAULT_HOST,
        port: base.port,
        path: pathName,
        method,
        headers: {
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
          try { parsed = JSON.parse(body || '{}'); } catch (e) { parsed = null; }
          done({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: parsed });
        });
        res.on('error', (e) => done({ ok: false, reason: 'response_error', unknown: true }));
      });
    } catch (e) {
      return done({ ok: false, reason: 'request_build_failed', unknown: false });
    }
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch (_) {} done({ ok: false, reason: 'timeout', unknown: true }); });
    req.on('error', (e) => {
      const code = String((e && e.code) || (e && e.message) || 'transport_error');
      const unknown = UNKNOWN_CODES.some((c) => code.indexOf(c) >= 0);
      done({ ok: false, reason: unknown ? 'transport_unknown' : 'transport_failed', transport: code.slice(0, 40), unknown });
    });
    try { if (payload.length > 0) req.write(payload); req.end(); } catch (e) {
      done({ ok: false, reason: 'transport_failed', transport: 'write_failed', unknown: false });
    }
  });
}

/**
 * 创建客户端。
 * @param {{base?:string, secretFile?:string, timeoutMs?:number, allowTestBase?:boolean, env?:object}} config
 */
function createZkClient(config = {}) {
  const env = config.env || process.env;
  // 生产默认：只允许 127.0.0.1:3456；显式 allowTestBase（或离线套件环境变量）才允许换端口
  const allowTestBase = config.allowTestBase === true || env.SYNCBOT_SCHEDULE_ALLOW_TEST_BASE === '1';
  const rawBase = config.base || env.SYNCBOT_SCHEDULE_ZK_BASE || DEFAULT_BASE;
  const parsed = assertBase(rawBase, { allowTestBase });
  const base = parsed.ok ? { host: parsed.host, port: parsed.port } : null;
  const timeoutMs = Number.isFinite(Number(config.timeoutMs)) ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const secretFile = config.secretFile || env.SYNCBOT_SCHEDULE_HMAC_SECRET_FILE || defaultSecretFile();
  const calls = { schedule: 0, claim: 0, settle: 0, report_push: 0, coverage: 0,
    item_sales_coverage: 0, bookkeeping_coverage: 0, report_sync_plan: 0, imported_summary: 0 };

  /** 只读查询串（只用于 GET 覆盖接口；值一律 encodeURIComponent） */
  function queryString(query) {
    if (!query) return '';
    const parts = Object.keys(query)
      .filter((k) => query[k] !== undefined && query[k] !== null)
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(query[k])));
    return parts.length ? '?' + parts.join('&') : '';
  }

  /** 统一入口：单次请求 + HMAC；任何前置失败都**不发 HTTP** */
  async function call(kind, pathName, method, bodyObj, query) {
    calls[kind] += 1;
    if (!parsed.ok) return { ok: false, reason: parsed.reason, unknown: false, sent: false };
    const sec = loadSecret(secretFile);
    if (!sec.ok) return { ok: false, reason: sec.reason, unknown: false, sent: false };
    const rawBody = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    const timestamp = String(Date.now());
    const signature = crypto.createHmac('sha256', sec.secret).update(timestamp + '.' + rawBody, 'utf8').digest('hex');
    const res = await requestOnce({ base, pathName: pathName + queryString(query), method, rawBody, timestamp, signature, timeoutMs });
    if (!res.ok && res.status === undefined) {
      return { ok: false, reason: res.reason, transport: res.transport || null, unknown: res.unknown === true, sent: true };
    }
    const b = res.body || {};
    const httpOk = res.status >= 200 && res.status < 300;
    return {
      ok: httpOk && b.ok === true,
      http_ok: httpOk,
      status: res.status,
      reason: b.ok === true ? (b.reason || null) : (b.error || (httpOk ? 'server_not_ok' : 'http_error')),
      body: b, sent: true, unknown: false,
    };
  }

  return {
    base: parsed.ok ? 'http://' + parsed.host + ':' + parsed.port : null,
    base_ok: parsed.ok,
    base_reason: parsed.ok ? null : parsed.reason,
    timeout_ms: timeoutMs,
    paths: Object.assign({}, PATHS),
    calls,
    /** I1 读取计划与状态（只读） */
    async getSchedule() { return call('schedule', PATHS.schedule, 'GET', undefined); },
    /** I2 原子占位（发送类：**绝不重试**） */
    async claim({ job, business_date, trigger = 'schedule', worker_id }) {
      return call('claim', PATHS.claim, 'POST', { job, business_date, trigger, worker_id });
    },
    /** I3 回写终态（发送类：**绝不重试**） */
    async settle({ job, business_date, status, reason, detail, worker_id }) {
      return call('settle', PATHS.settle, 'POST', {
        job, business_date, status,
        reason: reason === undefined ? null : reason,
        detail: detail === undefined ? null : detail,
        worker_id,
      });
    },
    /** I4 项目侧日报推送（发送类：**绝不重试**；confirm 恒为 true） */
    async reportPush({ business_date, worker_id, confirm = true }) {
      return call('report_push', PATHS.reportPush, 'POST', { business_date, worker_id, confirm: confirm === true });
    },
    /**
     * 覆盖查询（契约 v2 §2.2，**只读** GET）：该业务日期是否已导入项目数据库。
     * 业务日期必须是显式 YYYY-MM-DD（非法 ⇒ 0 HTTP，直接 fail-closed）。
     */
    async coverage({ business_date } = {}) {
      const bd = String(business_date === undefined || business_date === null ? '' : business_date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(bd)) return { ok: false, reason: 'business_date_invalid', unknown: false, sent: false };
      return call('coverage', PATHS.coverage, 'GET', undefined, { business_date: bd });
    },
    /** B 专属只读覆盖；与 A 同用回环、0600 密钥、单次 HMAC 请求及无自动重试。 */
    async itemSalesCoverage({ business_date } = {}) {
      const bd = String(business_date === undefined || business_date === null ? '' : business_date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(bd)) return { ok: false, reason: 'business_date_invalid', unknown: false, sent: false };
      return call('item_sales_coverage', PATHS.itemSalesCoverage, 'GET', undefined, { business_date: bd });
    },
    /** C 记账本专属只读覆盖；有手工数据时必须停下，不以 A/B 成功推断 C 已同步。 */
    async bookkeepingCoverage({ business_date } = {}) {
      const bd = String(business_date === undefined || business_date === null ? '' : business_date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(bd)) return { ok: false, reason: 'business_date_invalid', unknown: false, sent: false };
      return call('bookkeeping_coverage', PATHS.bookkeepingCoverage, 'GET', undefined, { business_date: bd });
    },
    /** B/C 各自的采集计划，只读；失败必须阻止当天自动导出。 */
    async reportSyncPlan(reportType) {
      if (!['item_sales_detail', 'pos_bookkeeping_daily'].includes(reportType))
        return { ok: false, reason: 'report_type_invalid', unknown: false, sent: false };
      return call('report_sync_plan', PATHS.reportSyncPlan + '/' + encodeURIComponent(reportType), 'GET', undefined);
    },
    /**
     * 已导入汇总（契约 v2 追加 D–E §G.6，**只读** GET）：G1 覆盖命中时的**对照口径**。
     * 失败/异常/字段缺失一律由调用方 fail-closed（绝不据此判成功）。
     */
    async importedSummary({ business_date } = {}) {
      const bd = String(business_date === undefined || business_date === null ? '' : business_date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(bd)) return { ok: false, reason: 'business_date_invalid', unknown: false, sent: false };
      return call('imported_summary', PATHS.importedSummary, 'GET', undefined, { business_date: bd });
    },
  };
}

module.exports = {
  DEFAULT_BASE, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_TIMEOUT_MS, PATHS, UNKNOWN_CODES,
  defaultSecretFile, assertBase, loadSecret, createZkClient,
};
