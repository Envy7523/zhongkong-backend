'use strict';
/**
 * 阶段3 · **正式导入 HTTP 客户端**（未来真实导入的唯一出口）
 *
 * 契约来源（**只读确认，非猜测**）：
 *   - 路由：  /home/ubuntu/app/server.js  \`app.post('/api/business-analytics/import', ...)\`
 *             成功 → \`res.status(201).json({ ok: true, ...result })\`；异常 → \`res.status(400).json({ error: e.message })\`
 *   - 认证：  server.js JWT 中间件——必须 \`Authorization: Bearer <jwt>\`（缺失/非 Bearer → 401 未登录；
 *             token 非法/过期 → 401 登录已过期）；/api/auth/login 本身免鉴权。
 *             另有一层岗位权限：\`lib/permissions.js\` 收录
 *             \`['/api/business-analytics/import','business_analytics.import','POST']\` → 权限不足为 403。
 *   - 请求体：\`express.json({limit:'50mb'})\` → JSON。\`lib/business-analytics.js:importWorkbook(db,params,user)\`
 *             只读取 \`params.data\`（base64；\`readWorkbook\` 会剥掉可选的 \`data:*;base64,\` 前缀）与
 *             \`params.file_name\`（写入 business_import_batches.file_name）。**只发这两个字段**，不多发一个猜测字段。
 *   - 响应：  cashier_composite 走 \`importCashierCompositeReport\`，返回
 *             \`{batch_id, data_kind:'cashier_composite', imported, raw_imported, matched_stores, skipped, errors,
 *               resolved_channels, income_composition_fields}\`。
 *   - 登录：  \`app.post('/api/auth/login')\` ← \`{username,password}\` → 200 \`{ok:true, token, user}\`；
 *             401 \`{error:'用户名或密码错误'}\`。
 *
 * 硬约束（逐条对应本轮要求）：
 *   1. 仅接受「已归档目录内 + report_type=cashier_composite + 已通过 validateReportAFile」的文件；
 *      归档目录 = \`paths.dayDownloads(platform, report_type, business_date)\`（archive.js 的目标目录）；
 *      越界（含符号链接越界/非普通文件）一律拒绝；
 *   2. 凭据只从 0600 的 \`state/secrets/project-importer.json\` 读取，**仅在内存使用**；
 *      文件缺失或 group/other 位非 0（权限过宽）直接拒绝；JWT 绝不落盘、绝不打印、绝不回传；
 *   3. 本地闸门全部通过**之后**才发起 HTTP；任一本地闸门不通过 → 0 次请求；
 *   4. 文件只读取并按 base64 编码进请求体；**不复制进项目目录、不写 SQLite**；
 *   5. 默认超时 30s，可注入覆盖；**零自动重试**（每次调用至多 1 次导入请求）；
 *   6. 401/403/409/其它 4xx/5xx/网络异常/超时 → 结构化脱敏错误码，绝不抛出、绝不重试；
 *   7. 输出（含错误信息）不含 JWT/密码/Authorization/base64/完整 SHA/绝对路径/Excel 原文。
 *
 * 重复导入语义（**只读确认，非猜测**）：
 *   · 正式路由 `/api/business-analytics/import` **没有**重复业务日期拦截——源码里
 *     `importWorkbook` 成功即 201，异常才 400；server.js 中仅有的两处 409 属于
 *     `/api/bookkeeping/*`，与本接口无关；
 *   · 落库走 `replaceRevenue`/`replaceRevenueComposition`（先 DELETE 同
 *     store+biz_date+source_type+channel 再 INSERT）→ **重复导入不会报错，而是静默原地覆盖**
 *     该业务日期的同维度数据，并新增一条 business_import_batches 记录。
 *   · 因此 409 只能作为"若未来服务端返回则处理"的**兼容分支**，绝不能被当作已证实的防护；
 *     真实防重复必须依靠 **G3 覆盖闸门 + 已持久化终态任务状态**，并且在**发 HTTP 之前**拦截。
 *   · 本模块据此提供最后一道本地闸门：`priorTerminal` / `readTerminalState` 判定
 *     "同一 platform+report_type+business_date 已是终态成功" → 直接拒绝，**0 次 HTTP 请求**；
 *     终态读取失败时 fail-closed（duplicate_state_unreadable），绝不冒险重复导入。
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const P = require('../paths');
const TC = require('../task-context');
const { scrubText } = require('./real-download-audit');

const IMPORT_PATH = '/api/business-analytics/import';
const LOGIN_PATH = '/api/auth/login';
const DEFAULT_BASE_URL = 'http://127.0.0.1:3456';
const DEFAULT_TIMEOUT_MS = 30000;
const IMPORTER_SECRETS_NAME = 'project-importer.json';
// B 仅在 REPORT_TYPES 中被正式授权后才可能通过下面的 TaskContext 闸门；
// 当前注册表仍为 authorized=false，且 workflow/调度入口仍独立锁定 B。
const ALLOWED_REPORT_TYPES = ['cashier_composite', 'item_sales_detail'];
const ALLOWED_PLATFORMS = ['meituan'];
/** 凭据文件必须是 0600 或更严；group/other 任一位非 0 → 拒绝 */
const SECRETS_FORBIDDEN_MODE_BITS = 0o077;
const SHA_PREFIX_LEN = 12;
/** 响应体读取上限（防挂死/防超大 body） */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** 被视为"已终态成功"的导入状态（用于本地重复闸；命中即拒绝，0 次 HTTP） */
const TERMINAL_OK_STATUSES = new Set(['success', 'succeeded', 'imported', 'completed', 'done', 'ok']);
/** 审计事件里摘要字段允许的取值（详见文件头说明；其余取值一律回落 off） */
const AUDIT_SHA_MODES = ['off', 'sha256_prefix'];

function sha256OfBuffer(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function prefixOf(sha) { return sha ? String(sha).slice(0, SHA_PREFIX_LEN) : null; }

/** 默认 HTTP 传输（本机回环）；可注入覆盖用于离线测试 */
function defaultRequest({ url, method, headers, body, timeoutMs }) {
  return new Promise((resolve) => {
    let u = null;
    try { u = new URL(url); } catch { return resolve({ error: 'endpoint_invalid' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = Buffer.from(body, 'utf8');
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: Object.assign({}, headers, { 'Content-Length': payload.length }),
      timeout: timeoutMs,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; if (text.length > MAX_RESPONSE_BYTES) text = text.slice(0, MAX_RESPONSE_BYTES); });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    let timedOut = false;
    req.on('timeout', () => { timedOut = true; req.destroy(new Error('timeout')); });
    // 错误串只保留**分类令牌**（绝不透传可能含地址/路径的原始 message）
    req.on('error', (e) => resolve({ error: timedOut || (e && e.code === 'ETIMEDOUT') ? 'transport_timeout' : 'transport_error(' + ((e && e.code) || 'error') + ')' }));
    req.write(payload);
    req.end();
  });
}

/** 只允许本机回环端点：绝不把凭据/Excel 发往非回环地址 */
function assertLoopback(rawUrl) {
  let u = null;
  try { u = new URL(rawUrl); } catch { return { ok: false, reason: 'endpoint_invalid' }; }
  const host = String(u.hostname || '').toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (!loopback) return { ok: false, reason: 'endpoint_not_loopback' };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'endpoint_invalid' };
  return { ok: true, url: u };
}

/**
 * 读取导入方凭据。**只返回原因码，绝不回显任何字段值。**
 * 文件里可能是 token 本身，也可能只有 username/password（此时由官方 /api/auth/login 换取 JWT）。
 */
function loadImporterSecrets({ file = null, enforceMode = (process.platform !== 'win32'), statMode = null } = {}) {
  const f = file || path.join(P.secrets, IMPORTER_SECRETS_NAME);
  let st = null;
  try { st = fs.statSync(f); } catch { return { ok: false, reason: 'importer_secrets_missing' }; }
  if (!st.isFile()) return { ok: false, reason: 'importer_secrets_not_a_file' };
  // POSIX 权限检查：group/other 任一位非 0 即"权限过宽"→ 拒绝。
  // Windows 无 POSIX 位（Node 一律报 0o666），因此在 Windows 上默认跳过；离线测试可用 statMode 注入验证该规则。
  const mode = statMode === null || statMode === undefined ? (st.mode & 0o777) : (Number(statMode) & 0o777);
  if (enforceMode && (mode & SECRETS_FORBIDDEN_MODE_BITS)) return { ok: false, reason: 'importer_secrets_mode_too_open', mode };
  let j = null;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { ok: false, reason: 'importer_secrets_unreadable' }; }
  if (!j || typeof j !== 'object') return { ok: false, reason: 'importer_secrets_unreadable' };
  const token = j.token || j.jwt || j.access_token || null;
  const username = j.username || j.user || j.account || null;
  const password = j.password || j.pass || null;
  const baseUrl = String(j.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (!token && !(username && password)) return { ok: false, reason: 'importer_secrets_incomplete' };
  return { ok: true, file: f, token: token ? String(token) : null, username: username ? String(username) : null, password: password ? String(password) : null, baseUrl };
}

/**
 * 本地闸门：归档目录 / 报表类型 / 平台 / 业务日期 / 文件 / 校验证据。
 * 全部同步完成，**不产生任何 HTTP 请求**。
 * @returns {{ok:true, file, dir, name, size, stat}|{ok:false, reason:string}}
 */
function resolveArchivedFile({ file, reportType, platform = 'meituan', businessDate, validation = null } = {}) {
  if (!ALLOWED_PLATFORMS.includes(String(platform))) return { ok: false, reason: 'platform_not_allowed' };
  if (!ALLOWED_REPORT_TYPES.includes(String(reportType))) return { ok: false, reason: 'report_type_not_allowed' };
  if (reportType === 'item_sales_detail' && P.REPORT_TYPES.item_sales_detail.authorized !== true)
    return { ok: false, reason: 'report_type_not_allowed' };
  try { TC.assertResidentReportType(reportType); } catch { return { ok: false, reason: 'report_type_locked_or_unregistered' }; }
  let dayDir = null;
  try { dayDir = P.dayDownloads(platform, reportType, businessDate); } catch { return { ok: false, reason: 'business_date_invalid' }; }
  if (!file) return { ok: false, reason: 'file_required' };
  const resolved = path.resolve(String(file));
  if (path.resolve(path.dirname(resolved)) !== path.resolve(dayDir)) return { ok: false, reason: 'file_outside_archive_dir' };
  // 符号链接越界：realpath 必须仍落在归档目录内
  let realFile = null; let realDir = null;
  try { realFile = fs.realpathSync(resolved); realDir = fs.realpathSync(dayDir); } catch { return { ok: false, reason: 'file_missing' }; }
  if (path.dirname(realFile) !== realDir) return { ok: false, reason: 'file_outside_archive_dir' };
  let st = null;
  try { st = fs.statSync(realFile); } catch { return { ok: false, reason: 'file_missing' }; }
  if (!st.isFile()) return { ok: false, reason: 'file_not_regular' };
  if (!(st.size > 0)) return { ok: false, reason: 'file_empty' };
  const name = path.basename(realFile);
  if (name !== path.basename(resolved)) return { ok: false, reason: 'file_outside_archive_dir' };
  // 已校验证据：必须由 validateReportAFile 明确判过 ok
  if (!validation || validation.ok !== true) return { ok: false, reason: 'file_not_validated' };
  if (reportType === 'item_sales_detail' && (validation.report_type !== reportType
    || validation.business_date !== businessDate || !Number.isInteger(validation.source_rows)
    || validation.source_rows <= 0 || !Number.isInteger(validation.store_count) || validation.store_count <= 0))
    return { ok: false, reason: 'report_b_validation_identity_mismatch' };
  return { ok: true, file: realFile, dir: realDir, name, size: st.size, mtime_ms: st.mtimeMs };
}

/**
 * 从既有校验证据里取"Excel 营业日期 = 目标业务日期"的**已确认**结论。
 * validateReportAFile 的 row2_metadata 已逐项断言「营业日期=目标日期」；
 * 只有它明确 ok 时，才把 businessDate 作为 excel_business_date 证据回传（否则 null，验收会因此 fail-closed）。
 */
function excelBusinessDateFromValidation(validation, businessDate) {
  if (validation && validation.report_type === 'item_sales_detail') {
    const metadata = validation.metadata_checks;
    const dateCheck = Array.isArray(metadata) && metadata.find(x => x && x.name === '营业日期');
    return validation.ok === true && validation.business_date === businessDate && dateCheck && dateCheck.ok === true
      ? String(businessDate) : null;
  }
  const items = validation && validation.checks && validation.checks.row2_metadata && validation.checks.row2_metadata.items;
  if (!Array.isArray(items)) return null;
  const hit = items.find((x) => x && String(x.name || '').startsWith('营业日期=目标日期'));
  return hit && hit.ok === true ? String(businessDate) : null;
}

/**
 * 已持久化终态任务状态的判读：同一 platform+report_type+business_date 已终态成功 → 重复导入。
 * 只读判断，纯函数，无副作用。
 */
function terminalDuplicate(priorTerminal, { platform, reportType, businessDate } = {}) {
  if (!priorTerminal || typeof priorTerminal !== 'object') return null;
  const t = priorTerminal;
  const same = String(t.platform || platform) === String(platform)
    && String(t.report_type || reportType) === String(reportType)
    && String(t.business_date || '') === String(businessDate);
  if (!same) return null;
  const status = String(t.import_status || t.status || '').toLowerCase();
  if (t.terminal === true || TERMINAL_OK_STATUSES.has(status)) {
    return { at: t.at || t.finished_at || null, import_batch_id: t.import_batch_id || null, status: status || null };
  }
  return null;
}

function createImportClient({ ctx = null, opts = {}, logger = null, request = null } = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const doRequest = typeof request === 'function' ? request : (typeof opts.request === 'function' ? opts.request : defaultRequest);
  const secretsFile = opts.secretsFile || null;
  // 测试钩子：可注入 POSIX 权限位/强制策略，使"权限过宽必须拒绝"在任意平台上都可离线验证。
  // 生产不传 → POSIX 上强制、Windows 上因无 POSIX 位而跳过。
  const enforceSecretsMode = opts.enforceSecretsMode === undefined ? (process.platform !== 'win32') : !!opts.enforceSecretsMode;
  const statMode = opts.statMode === undefined ? null : opts.statMode;
  const injectedToken = opts.token ? String(opts.token) : null;
  const injectedBaseUrl = opts.baseUrl ? String(opts.baseUrl).replace(/\/+$/, '') : null;
  const readDbAggregate = typeof opts.readDbAggregate === 'function' ? opts.readDbAggregate : null;
  // 已持久化终态任务状态的**只读**读取器（防重复导入的最后一道本地闸门）
  const readTerminalState = typeof opts.readTerminalState === 'function' ? opts.readTerminalState : null;
  const counters = { login: 0, import: 0 };
  let lastSummary = null;

  function note(obj) { lastSummary = obj; if (logger && typeof logger.info === 'function') { try { logger.info('audit.import_client', obj); } catch (_) {} } }

  /** 取令牌：优先注入 → 其次 secrets 内 token → 最后用 secrets 凭据走官方登录（仅内存） */
  async function acquireToken(baseUrl) {
    if (injectedToken) return { ok: true, token: injectedToken, mode: 'injected' };
    const s = loadImporterSecrets({ file: secretsFile, enforceMode: enforceSecretsMode, statMode });
    if (!s.ok) return { ok: false, reason: s.reason };
    if (s.token) return { ok: true, token: s.token, mode: 'secrets_token' };
    const base = injectedBaseUrl || s.baseUrl || DEFAULT_BASE_URL;
    const lb = assertLoopback(base);
    if (!lb.ok) return { ok: false, reason: lb.reason };
    counters.login += 1;
    const res = await doRequest({
      url: base + LOGIN_PATH,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: s.username, password: s.password }),
      timeoutMs,
    });
    if (res && res.error) return { ok: false, reason: /timeout/i.test(String(res.error)) ? 'import_login_timeout' : (res.error === 'endpoint_invalid' ? 'endpoint_invalid' : 'import_login_transport_error') };
    if (res.status !== 200) return { ok: false, reason: 'import_login_http_' + res.status };
    let body = null;
    try { body = JSON.parse(res.text || '{}'); } catch { return { ok: false, reason: 'import_login_response_invalid' }; }
    const token = body && (body.token || (body.data && body.data.token));
    if (!token) return { ok: false, reason: 'import_login_response_invalid' };
    return { ok: true, token: String(token), mode: 'login' };
  }

  function errorResult(code, { http: httpStatus = null, reason = null, extra = {} } = {}) {
    return Object.assign({
      ok: false, http: httpStatus, error_code: code,
      reason: scrubText(reason == null ? code : reason, 200),
      // attempts = 真正发出的**导入**请求数（本地闸门拒绝时为 0）
      attempts: counters.import, requests: { login: counters.login, import: counters.import },
      retryable: false,
    }, extra);
  }

  /**
   * 正式导入一个**已归档且已校验**的 cashier_composite 文件。
   * 永不抛出；任何失败都返回结构化脱敏错误；**零自动重试**。
   */
  async function importArchivedFile(params = {}) {
    const { file, reportType, platform = 'meituan', businessDate, validation = null, evidence = {}, archiveSha256 = null, priorTerminal = null } = params;
    const prep = resolveArchivedFile({ file, reportType, platform, businessDate, validation });
    if (!prep.ok) {
      const r = errorResult(prep.reason, { extra: { stage: 'local_gate' } });
      note({ ok: false, error_code: prep.reason, stage: 'local_gate', requests: r.requests });
      return r;
    }
    let buf = null;
    try { buf = fs.readFileSync(prep.file); } catch { return errorResult('file_unreadable', { extra: { stage: 'local_gate' } }); }
    const sha256 = sha256OfBuffer(buf);
    if (buf.length !== prep.size) return errorResult('file_changed_after_validation', { extra: { stage: 'local_gate' } });
    if (archiveSha256 && String(archiveSha256) !== sha256) {
      const r = errorResult('file_changed_after_validation', { extra: { stage: 'local_gate', file: { name: prep.name, sha256_prefix: prefixOf(sha256) } } });
      note({ ok: false, error_code: 'file_changed_after_validation', stage: 'local_gate', requests: r.requests });
      return r;
    }
    // ---- 重复导入本地闸门（必须在取令牌/发请求之前；命中即 0 次 HTTP）----
    let prior = priorTerminal;
    if (readTerminalState) {
      try { prior = await readTerminalState({ platform, reportType, businessDate, file: prep.file }); }
      catch (_) {
        const r = errorResult('duplicate_state_unreadable', { extra: { stage: 'duplicate_gate', file: { name: prep.name, size: prep.size, sha256_prefix: prefixOf(sha256) } } });
        note({ ok: false, error_code: 'duplicate_state_unreadable', stage: 'duplicate_gate', requests: r.requests });
        return r;
      }
    }
    const dup = terminalDuplicate(prior, { platform, reportType, businessDate });
    if (dup) {
      const r = errorResult('duplicate_business_date_local', {
        extra: { stage: 'duplicate_gate', prior_import_batch_id: dup.import_batch_id, prior_at: dup.at, file: { name: prep.name, size: prep.size, sha256_prefix: prefixOf(sha256) } },
      });
      note({ ok: false, error_code: 'duplicate_business_date_local', stage: 'duplicate_gate', requests: r.requests });
      return r;
    }

    const excelBusinessDate = evidence.excelBusinessDate !== undefined ? evidence.excelBusinessDate : excelBusinessDateFromValidation(validation, businessDate);
    const amountExcel = evidence.amountExcel === undefined ? null : evidence.amountExcel;
    let amountDb = evidence.amountDb === undefined ? null : evidence.amountDb;
  let amountBasis = (evidence && evidence.amountBasis) ? evidence.amountBasis : null;

    const tok = await acquireToken(injectedBaseUrl);
    if (!tok.ok) {
      const r = errorResult(tok.reason, { extra: { stage: 'auth', file: { name: prep.name, size: prep.size, sha256_prefix: prefixOf(sha256) } } });
      note({ ok: false, error_code: tok.reason, stage: 'auth', requests: r.requests });
      return r;
    }
    const base = injectedBaseUrl || DEFAULT_BASE_URL;
    const lb = assertLoopback(base);
    if (!lb.ok) return errorResult(lb.reason, { extra: { stage: 'auth' } });

    // 请求体：**只有** data(base64) 与 file_name —— 字段名来自 importWorkbook 的只读确认
    const body = JSON.stringify({ data: buf.toString('base64'), file_name: prep.name });
    const bodyBytes = Buffer.byteLength(body, 'utf8');
    const requestMeta = { method: 'POST', path: IMPORT_PATH, content_type: 'application/json', body_bytes: bodyBytes, body_fields: ['data', 'file_name'] };
    counters.import += 1;
    const res = await doRequest({
      url: base + IMPORT_PATH,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok.token },
      body,
      timeoutMs,
    });
    const fileMeta = { name: prep.name, size: prep.size, sha256_prefix: prefixOf(sha256) };
    if (res && res.error) {
      const code = /timeout/i.test(String(res.error)) ? 'import_timeout' : 'import_http_error';
      const r = errorResult(code, { reason: res.error, extra: { stage: 'request', file: fileMeta, request: requestMeta, auth_mode: tok.mode } });
      note({ ok: false, error_code: code, stage: 'request', requests: r.requests });
      return r;
    }
    const status = Number(res.status);
    let parsed = null;
    try { parsed = JSON.parse(res.text || '{}'); } catch { parsed = null; }
  // v0.3.4：amount_db / amount_basis 消费点 —— 必须在 parsed 成功定义之后；缺值仅置 null，
  // 由 import-audit.verifyImportResult 以 amount_missing / amount_basis_mismatch 继续 fail-closed。
  if (parsed && typeof parsed === 'object') {
    const respAmountDb = parsed.amount_db;
    const respBasis = parsed.amount_basis;
    const rv = (respAmountDb && typeof respAmountDb === 'object') ? Number(respAmountDb.recorded_amount) : NaN;
    amountDb = Number.isFinite(rv) ? rv : null;
    amountBasis = (respBasis && typeof respBasis === 'object') ? respBasis : null;
  } else { amountDb = null; amountBasis = null; }
    if (status >= 200 && status < 300 && parsed && parsed.ok === true) {
      if (!parsed.batch_id) {
        const r = errorResult('import_response_invalid', { http: status, extra: { stage: 'response', file: fileMeta, request: requestMeta, auth_mode: tok.mode } });
        note({ ok: false, error_code: 'import_response_invalid', requests: r.requests });
        return r;
      }
      if (reportType === 'item_sales_detail' && parsed.data_kind !== 'pos_item_sales_detail') {
        const r = errorResult('report_b_import_response_kind_mismatch', { http: status,
          extra: { stage: 'response', file: fileMeta, request: requestMeta, auth_mode: tok.mode, outcome_uncertain: true } });
        note({ ok: false, error_code: r.error_code, requests: r.requests });
        return r;
      }
      if (readDbAggregate && amountDb === null) {
        try { amountDb = await readDbAggregate({ importBatchId: parsed.batch_id, businessDate, file: fileMeta }); } catch { amountDb = null; }
      }
      const result = {
        ok: true, http: status, data_kind: parsed.data_kind || null,
        duplicate_semantics_note: 'no_409_duplicate_guard_on_server_see_import_client_header',
        import_batch_id: parsed.batch_id,
        raw_imported: parsed.raw_imported, matched_stores: parsed.matched_stores, imported: parsed.imported,
        dish_mirrored: parsed.dish_mirrored, source_rows: parsed.source_rows,
        date_from: parsed.date_from, date_to: parsed.date_to,
        errors: Array.isArray(parsed.errors) ? parsed.errors.slice(0, 20) : [],
        skipped: parsed.skipped, resolved_channels: parsed.resolved_channels || [], income_composition_fields: parsed.income_composition_fields || [],
  sha256, excel_business_date: excelBusinessDate, amount_excel: amountExcel, amount_db: amountDb, amount_basis: amountBasis,
  batch_id: parsed.batch_id,
        file: fileMeta, request: requestMeta, auth_mode: tok.mode,
        attempts: counters.import, requests: { login: counters.login, import: counters.import },
      };
      note({ ok: true, http: status, batch_present: true, imported: result.imported, requests: result.requests, file: fileMeta });
      return result;
    }
    const code = status === 401 ? 'import_http_401' : status === 403 ? 'import_http_403' : status === 409 ? 'import_http_409'
      : status >= 500 ? 'import_http_5xx' : status >= 400 ? 'import_http_4xx' : 'import_response_invalid';
    const reasonText = parsed && parsed.error ? parsed.error : ('http_' + status);
    const r = errorResult(code, { http: status, reason: reasonText, extra: { stage: 'response', file: fileMeta, request: requestMeta, auth_mode: tok.mode } });
    note({ ok: false, error_code: code, http: status, requests: r.requests });
    return r;
  }

  return {
    importArchivedFile,
    resolveArchivedFile: (p) => resolveArchivedFile(p),
    loadImporterSecrets: () => loadImporterSecrets({ file: secretsFile, enforceMode: enforceSecretsMode, statMode }),
    terminalDuplicate: (prior, p) => terminalDuplicate(prior, p),
    counters,
    lastSummary: () => lastSummary,
    timeoutMs,
    IMPORT_PATH, LOGIN_PATH, DEFAULT_TIMEOUT_MS,
  };
}

module.exports = {
  IMPORT_PATH, LOGIN_PATH, DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS,
  ALLOWED_REPORT_TYPES, ALLOWED_PLATFORMS, SHA_PREFIX_LEN,
  createImportClient, loadImporterSecrets, resolveArchivedFile, assertLoopback, terminalDuplicate,
  excelBusinessDateFromValidation, sha256OfBuffer, prefixOf, defaultRequest,
  TERMINAL_OK_STATUSES, AUDIT_SHA_MODES,
};
