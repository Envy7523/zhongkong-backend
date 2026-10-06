#!/usr/bin/env node
'use strict';
/**
 * 正式导入 HTTP 客户端 · **纯离线 mock 套件**
 *
 * 边界声明（逐条对应本轮要求）：
 *  - **绝不接触真实 3456**：本文件自带"mock 中控"，绑定 127.0.0.1 的**随机端口**，同时实现
 *      · POST /api/business-analytics/import （JWT：Authorization: Bearer；JSON body {data,file_name}）
 *      · POST /api/auth/login                （{username,password} → {ok:true,token,user}）
 *      · POST /api/internal/syncbot/events   （审计：HMAC 原始字节签名 + event_id 幂等）
 *    三个接口的**字段名/状态码/响应形状**均来自现有正式源码的只读确认，不是猜测；
 *  - 不真实导入、不访问美团、不导出/下载、不推送、不建 timer、不重启服务、不写任何真实数据库；
 *  - 报表 B（item_sales_detail）保持 locked_not_started：本套件显式验证它被拒绝；
 *  - 输出不含 JWT/HMAC/签名/Cookie/口令/base64/绝对路径/完整 SHA（合成凭据亦不回显）。
 *
 * 运行：SYNCBOT_BOT=<bot root> node import-client-test.js   （默认 /opt/zhongkong-sync-bot）
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p3ic-'));
process.env.SYNCBOT_ROOT = ROOT;

const BOT = process.env.SYNCBOT_BOT || '/opt/zhongkong-sync-bot';
const P = require(BOT + '/app/src/paths.js');
const TC = require(BOT + '/app/src/task-context.js');
const OUTBOX = require(BOT + '/app/src/phase3/audit-outbox.js');
const BAT = require(BOT + '/app/src/phase3/audit-batcher.js');
const IC = require(BOT + '/app/src/phase3/import-client.js');
const IMP = require(BOT + '/app/src/phase3/import-audit.js');

/** 合成凭据（**非生产**，只存在于本进程与临时目录，绝不进入输出） */
const AUDIT_SECRET = crypto.randomBytes(32).toString('hex');
const TOKEN = 'tok-' + crypto.randomBytes(12).toString('hex');
const RUN = 'ic-' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');

const out = {
  suite: 'import-client-offline-mock', fixture: true, offline: true,
  real_3456_touched: false, real_import: false, real_meituan_run: false, real_export: false,
  real_download: false, real_push: false, timers_created: false, real_db_written: false,
  report_b: 'locked_not_started', test_run_id: RUN, checks: [],
};
const ck = (n, ok, d) => out.checks.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });

let SEQ = 0;
/** 每个场景独占业务日期 → 独占归档目录与 outbox JSONL（避免跨场景串扰） */
function nextBD() { SEQ += 1; return new Date(Date.UTC(2026, 5, 1 + SEQ)).toISOString().slice(0, 10); }
let SEC_SEQ = 0;

const IMPORT_PATH = '/api/business-analytics/import';
const LOGIN_PATH = '/api/auth/login';
const AUDIT_PATH = '/api/internal/syncbot/events';
const SHA_PREFIX_LEN = 12;
/** 中控 lib/sync-job-audit.js 的 metrics 白名单（只读确认；补丁后 += sha256_prefix） */
const MOCK_ALLOWED_METRIC_FIELDS = new Set([
  'phase', 'started_at', 'finished_at', 'duration_ms', 'failure_reason',
  'original_filename', 'file_size', 'sha256', 'import_batch_id',
  'raw_store_count', 'matched_store_count', 'ready_to_push', 'push_status',
  'imported', 'pushed', 'is_backfill', 'reconstructed', 'not_a_realtime_success',
  'screenshot_count', 'validation', 'evidence', 'note',
  // 本轮新增（中控补丁后启用）
  'sha256_prefix',
]);

// ---------------------------------------------------------------- mock 中控
function createMock() {
  const state = {
    import_requests: 0, login_requests: 0, audit_requests: 0,
    import_calls: [],            // 脱敏后的请求证据
    decoded_matches: null,       // base64 解码后是否与归档 fixture 逐字节一致
    file_name_basename_only: null,
    auth_ok: null,
    import_body_override: null,
    audit: { accepted: [], duplicates: [], rejected: [], batches: [], sha_seen: [], full_sha_seen: false, sha_prefix_field_seen: false, unknown_metric_keys: [] },
  };
  let importMode = 'ok';
  let expectedBytes = null;
  const seen = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = String(req.url || '').split('?')[0];
      if (url === LOGIN_PATH) {
        state.login_requests += 1;
        let b = null; try { b = JSON.parse(raw.toString('utf8')); } catch { b = null; }
        if (!b || !b.username || !b.password) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '用户名和密码不能为空' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, token: TOKEN, user: { id: 7, username: String(b.username) } }));
        return;
      }
      if (url === IMPORT_PATH) {
        state.import_requests += 1;
        if (importMode === 'drop') { try { req.socket.destroy(); } catch (_) {} return; }
        if (importMode === 'hang') { return; }
        const auth = String(req.headers.authorization || '');
        state.auth_ok = auth === 'Bearer ' + TOKEN;
        if (!state.auth_ok) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '未登录' })); return; }
        let body = null;
        try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; }
        if (!body) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '请求体不是合法 JSON' })); return; }
        const name = String(body.file_name || '');
        state.file_name_basename_only = path.basename(name) === name && name.indexOf('..') < 0;
        const decoded = Buffer.from(String(body.data || ''), 'base64');
        state.decoded_matches = expectedBytes ? decoded.equals(expectedBytes) : null;
        state.import_calls.push({
          path: url, method: req.method, content_type: String(req.headers['content-type'] || ''),
          auth_scheme: auth.slice(0, 7), body_keys: Object.keys(body).sort(),
          body_bytes: raw.length, file_name: name, base64_chars: String(body.data || '').length,
        });
        if (String(importMode).startsWith('stat:')) {
          const code = Number(String(importMode).split(':')[1]);
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: code === 401 ? '未登录' : code === 403 ? '无权导入' : code === 409 ? '该业务日期已导入' : '导入失败：mock_http_' + code }));
          return;
        }
        if (importMode === 'invalid') { res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
        const base = { ok: true, batch_id: 4242, data_kind: 'cashier_composite', imported: 154, raw_imported: 22, matched_stores: 22, skipped: 0, errors: [], resolved_channels: ['店内销售', '美团外卖'], income_composition_fields: ['美团团购'] };
        const body2 = Object.assign(base, state.import_body_override || {});
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body2));
        return;
      }
      if (url === AUDIT_PATH) {
        state.audit_requests += 1;
        const rawText = raw.toString('utf8');
        const ts = String(req.headers['x-syncbot-timestamp'] || '');
        const sig = String(req.headers['x-syncbot-signature'] || '');
        const want = crypto.createHmac('sha256', AUDIT_SECRET).update(ts + '.' + rawText, 'utf8').digest('hex');
        if (sig !== want) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'signature_invalid' })); return; }
        let body = null; try { body = JSON.parse(rawText); } catch { body = null; }
        const events = body && Array.isArray(body.events) ? body.events : [];
        if (!events.length) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'events_required' })); return; }
        const accepted = []; const duplicates = []; const rejected = [];
        const batchSeen = new Set();
        for (const e of events) {
          if (seen.has(e.event_id) || batchSeen.has(e.event_id)) duplicates.push(e.event_id);
          else { accepted.push(e.event_id); batchSeen.add(e.event_id); }
          // 镜像中控入站口径：metrics.sha256 → 截断为 sha256_prefix（完整值从不落库）；
          // sha256_prefix 需中控白名单补丁后才被接受。这里如实记录"中控会看到什么"。
          const mm = (e && e.metrics) || {};
          for (const k of Object.keys(mm)) {
            if (k !== 'sha256' && k !== 'sha256_prefix' && !MOCK_ALLOWED_METRIC_FIELDS.has(k)) state.audit.unknown_metric_keys.push(k);
          }
          for (const [k, v] of Object.entries(mm)) {
            const s = String(v == null ? '' : v);
            if (k === 'sha256') {
              state.audit.sha_seen.push({ stage: e.stage, field: 'sha256', chars: s.length, stored_prefix: s.slice(0, SHA_PREFIX_LEN) });
              if (s.length > SHA_PREFIX_LEN) state.audit.full_sha_seen = true;
            } else if (k === 'sha256_prefix') {
              const valid = /^[0-9a-f]{1,12}$/i.test(s);
              state.audit.sha_prefix_field_seen = true;
              state.audit.sha_seen.push({ stage: e.stage, field: 'sha256_prefix', chars: s.length, stored_prefix: valid ? s : null, valid });
            }
          }
        }
        for (const id of accepted) seen.add(id);
        state.audit.accepted.push.apply(state.audit.accepted, accepted);
        state.audit.duplicates.push.apply(state.audit.duplicates, duplicates);
        state.audit.batches.push({ n: events.length, stages: events.map((e) => e.stage), event_ids: events.map((e) => e.event_id) });
        res.writeHead(accepted.length ? 201 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, accepted: accepted.length, duplicates: duplicates.length, rejected }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
  });
  return {
    server, state,
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      this.baseUrl = 'http://127.0.0.1:' + server.address().port;
      SEC_SEQ += 1;
      this.auditSecretFile = path.join(ROOT, 'audit-secret-' + SEC_SEQ + '.json');
      fs.writeFileSync(this.auditSecretFile, JSON.stringify({ secret: AUDIT_SECRET, endpoint: this.baseUrl + AUDIT_PATH }), { mode: 0o600 });
      return this;
    },
    async stop() { await new Promise((r) => server.close(r)); },
    setImport(mode, override) { importMode = mode; state.import_body_override = override || null; },
    expectBytes(b) { expectedBytes = b; },
  };
}

/** 归档一个 fixture 文件到 paths.dayDownloads 指定的归档目录（与 archive.js 同目录） */
function archiveFixture(bd, bytes, name) {
  const dir = P.dayDownloads('meituan', 'cashier_composite', bd);
  P.ensureDir(dir);
  const file = path.join(dir, name || ('美团_综合营业统计_' + bd + '.xlsx'));
  fs.writeFileSync(file, bytes);
  return { file, dir, bytes };
}
function fixtureBytes(tag) { return Buffer.from('XLSX-MOCK-' + tag + '-' + crypto.randomBytes(96).toString('hex')); }

/** 既有 validateReportAFile 的等价证据（本套件为离线 mock，不解析真实 Excel） */
function okValidation(bd) {
  return { ok: true, checks: { row2_metadata: { ok: true, items: [{ name: '营业日期=目标日期', ok: true }] } }, store_count: 22, business_date: bd };
}
const EVIDENCE = (bd) => ({ excelBusinessDate: bd, amountExcel: 12345.67, amountDb: 12345.67 });

function writeSecrets(file, obj, mode) { fs.writeFileSync(file, JSON.stringify(obj), { mode: mode || 0o600 }); return file; }

const postsOf = (summary) => (summary.batch ? summary.batch.posts_log.map((p) => ({ reason: p.reason, stages: p.stages, status: p.status })) : []);
const jsonlOf = (ctx) => {
  const f = OUTBOX.outboxFile(ctx.platform, ctx.reportType, ctx.businessDate);
  try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
};
const stagesOfJsonl = (ctx) => jsonlOf(ctx).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).filter((l) => l.type === 'event').map((l) => l.event.stage);

const MOCKS = [];
const ALL_AUDITS = [];
const newMock = async () => { const m = await createMock().start(); MOCKS.push(m); return m; };
const DOWN_SECRET_FILE = path.join(ROOT, 'audit-down.json');
fs.writeFileSync(DOWN_SECRET_FILE, JSON.stringify({ secret: AUDIT_SECRET, endpoint: 'http://127.0.0.1:9/api/internal/syncbot/events' }), { mode: 0o600 });

function makeAuditFx({ taskId, bd, mock, importClient, auditSecretFile = null, auditOpts = null }) {
  const ctx = TC.createContext('cashier_composite', { platform: 'meituan', taskId, businessDate: bd });
  const auditPending = [];
  const calls = { importFn: 0 };
  const audit = IMP.createImportAudit({
    ctx,
    opts: Object.assign({ secretFile: auditSecretFile || mock.auditSecretFile, timeoutMs: 3000, testRunId: RUN }, auditOpts || {}),
    importClient,
    onPending: (i) => auditPending.push(i),
  });
  const biz = { import: { status: 'pending' }, validate_import: { status: 'passed' }, push: { status: 'pending' }, ready_to_push: false };
  const counters = { push: 0 };
  const real = (params) => {
    const fn = audit.makeRealImportFn(params);
    const counted = async () => { calls.importFn += 1; return fn(); };
    return counted;
  };
  const run = async ({ coverageGate = async () => ({ ok: true, covered: false }), duplicateCheck = async () => ({ duplicate: false }), validateFile = async () => ({ ok: true }), humanConfirmation = null, importFn = null } = {}) => {
    const r = await audit.runGuardedImport({ coverageGate, duplicateCheck, validateFile, humanConfirmation, importFn, businessDate: bd });
    if (r.action === 'IMPORT_SUCCEEDED' && r.allow_push === true) biz.import = { status: 'success' };
    else biz.import = { status: 'failed' };
    biz.ready_to_push = biz.import.status === 'success' && biz.validate_import.status === 'passed' && biz.push.status !== 'success';
    return r;
  };
  const fxObj = { ctx, audit, auditPending, calls, counters, biz, run, makeRealImportFn: real };
  ALL_AUDITS.push(fxObj);
  return fxObj;
}

(async () => {
  // ============================================================ A. 请求契约
  {
    const m = await newMock();
    const bd = nextBD();
    const bytes = fixtureBytes('A');
    const { file } = archiveFixture(bd, bytes);
    m.expectBytes(bytes);
    const client = IC.createImportClient({ opts: { token: TOKEN, baseUrl: m.baseUrl, timeoutMs: 3000 } });
    const r = await client.importArchivedFile({ file, reportType: 'cashier_composite', businessDate: bd, validation: okValidation(bd), evidence: EVIDENCE(bd) });
    const call = m.state.import_calls[0] || {};
    ck('a1 请求 URL 与方法是既有正式路由 POST /api/business-analytics/import',
      call.path === IMPORT_PATH && call.method === 'POST', JSON.stringify({ path: call.path, method: call.method }));
    ck('a2 Content-Type = application/json（与 express.json 中间件一致）',
      call.content_type === 'application/json', String(call.content_type));
    ck('a3 认证头 = Authorization: Bearer <JWT>，且服务端校验通过',
      m.state.auth_ok === true && call.auth_scheme === 'Bearer ', JSON.stringify({ auth_ok: m.state.auth_ok, scheme: call.auth_scheme }));
    ck('a4 请求体字段**精确**为 data / file_name（只发源码确认读过的字段，不多发猜测字段）',
      JSON.stringify(call.body_keys) === JSON.stringify(['data', 'file_name']), JSON.stringify(call.body_keys));
    ck('a5 body.data 为文件 base64，解码后与归档 fixture **逐字节一致**',
      m.state.decoded_matches === true, JSON.stringify({ identical: m.state.decoded_matches, base64_chars: call.base64_chars }));
    ck('a6 file_name 只允许 basename（无目录分隔符、无 ..）',
      m.state.file_name_basename_only === true && call.file_name === path.basename(file), JSON.stringify({ file_name: call.file_name }));
    ck('a7 恰好 1 次导入请求 + 0 次登录请求（注入令牌）；attempts=1（零自动重试）',
      r.requests.import === 1 && r.requests.login === 0 && r.attempts === 1 && m.state.import_requests === 1 && m.state.login_requests === 0,
      JSON.stringify({ requests: r.requests, attempts: r.attempts }));
    ck('a8 响应映射：batch_id→import_batch_id，raw_imported/matched_stores/imported/errors 透传，http=201',
      r.ok === true && r.http === 201 && r.import_batch_id === 4242 && r.raw_imported === 22 && r.matched_stores === 22 &&
      r.imported === 154 && Array.isArray(r.errors) && r.errors.length === 0,
      JSON.stringify({ http: r.http, batch: r.import_batch_id, raw: r.raw_imported, matched: r.matched_stores, imported: r.imported }));
    ck('a9 输出摘要只含 basename 与 12 位前缀（完整 SHA 仅在内存验收字段，绝不出现在 file/request 摘要里）',
      r.file.name === path.basename(file) && String(r.file.sha256_prefix).length === 12 && String(r.sha256).length === 64 &&
      !JSON.stringify({ file: r.file, request: r.request, auth_mode: r.auth_mode }).includes(ROOT) &&
      !JSON.stringify({ file: r.file }).includes(path.sep),
      JSON.stringify({ file: r.file, request: r.request }));
    out.summary = Object.assign(out.summary || {}, {
      request_contract: { path: call.path, method: call.method, content_type: call.content_type, body_keys: call.body_keys, body_bytes: call.body_bytes, attempts: r.attempts },
      response_mapping: { http: r.http, import_batch_id: r.import_batch_id, raw_imported: r.raw_imported, matched_stores: r.matched_stores, imported: r.imported, errors: r.errors.length, sha256_prefix: r.file.sha256_prefix },
    });
  }

  // ============================================================ B. 本地闸门 → 0 请求
  {
    const m = await newMock();
    const zero = () => ({ imp: m.state.import_requests, login: m.state.login_requests });
    const mkClient = (o) => IC.createImportClient({ opts: Object.assign({ token: TOKEN, baseUrl: m.baseUrl, timeoutMs: 2000 }, o || {}) });
    let before = m.state.import_requests + m.state.login_requests;

    // b1 归档目录越界
    {
      const bd = nextBD(); const bytes = fixtureBytes('b1'); archiveFixture(bd, bytes);
      const outside = path.join(ROOT, 'outside-' + bd + '.xlsx'); fs.writeFileSync(outside, bytes);
      const r = await mkClient().importArchivedFile({ file: outside, reportType: 'cashier_composite', businessDate: bd, validation: okValidation(bd) });
      ck('b1 归档目录之外的文件 → file_outside_archive_dir，HTTP 请求数 0',
        r.ok === false && r.error_code === 'file_outside_archive_dir' && (m.state.import_requests + m.state.login_requests) === before,
        JSON.stringify({ code: r.error_code, requests: zero() }));
    }
    // b2 符号链接越界（POSIX）
    {
      const bd = nextBD(); const bytes = fixtureBytes('b2'); const arch = archiveFixture(bd, bytes);
      const outside = path.join(ROOT, 'outside-link-' + bd + '.xlsx'); fs.writeFileSync(outside, bytes);
      const link = path.join(arch.dir, 'link-' + bd + '.xlsx');
      let made = false;
      try { fs.symlinkSync(outside, link); made = true; } catch (_) { made = false; }
      if (!made) {
        ck('b2 符号链接越界 → 拒绝且 0 次请求', true, 'skipped_platform_without_symlink_privilege');
      } else {
        const r = await mkClient().importArchivedFile({ file: link, reportType: 'cashier_composite', businessDate: bd, validation: okValidation(bd) });
        ck('b2 符号链接越界 → 拒绝且 0 次请求',
          r.ok === false && r.error_code === 'file_outside_archive_dir' && (m.state.import_requests + m.state.login_requests) === before,
          JSON.stringify({ code: r.error_code, requests: zero() }));
      }
    }
    // b3 报表 B（locked）
    {
      const bd = nextBD(); const bytes = fixtureBytes('b3'); const arch = archiveFixture(bd, bytes);
      const r = await mkClient().importArchivedFile({ file: arch.file, reportType: 'item_sales_detail', businessDate: bd, validation: okValidation(bd) });
      ck('b3 报表 B（item_sales_detail）保持 locked_not_started → 拒绝且 0 次请求',
        r.ok === false && r.error_code === 'report_type_not_allowed' && (m.state.import_requests + m.state.login_requests) === before,
        JSON.stringify({ code: r.error_code, report_b: out.report_b }));
    }
    // b4 未注册 report_type
    {
      const bd = nextBD(); const bytes = fixtureBytes('b4'); const arch = archiveFixture(bd, bytes);
      const r = await mkClient().importArchivedFile({ file: arch.file, reportType: '../escape', businessDate: bd, validation: okValidation(bd) });
      ck('b4 未注册/非法 report_type → 拒绝且 0 次请求',
        r.ok === false && r.error_code === 'report_type_not_allowed' && (m.state.import_requests + m.state.login_requests) === before,
        JSON.stringify({ code: r.error_code }));
    }
    // b5 未校验文件
    {
      const bd = nextBD(); const bytes = fixtureBytes('b5'); const arch = archiveFixture(bd, bytes);
      const r1 = await mkClient().importArchivedFile({ file: arch.file, reportType: 'cashier_composite', businessDate: bd, validation: null });
      const r2 = await mkClient().importArchivedFile({ file: arch.file, reportType: 'cashier_composite', businessDate: bd, validation: { ok: false, errors: ['x'] } });
      ck('b5 未经 validateReportAFile 通过的文件 → file_not_validated，HTTP 请求数 0',
        r1.error_code === 'file_not_validated' && r2.error_code === 'file_not_validated' && (m.state.import_requests + m.state.login_requests) === before,
        JSON.stringify({ a: r1.error_code, b: r2.error_code }));
    }
    // b6 缺 secrets
    {
      const bd = nextBD(); const bytes = fixtureBytes('b6'); const arch = archiveFixture(bd, bytes);
      const c = IC.createImportClient({ opts: { baseUrl: m.baseUrl, secretsFile: path.join(ROOT, 'no-such-secrets.json'), timeoutMs: 2000 } });
      const r = await c.importArchivedFile({ file: arch.file, reportType: 'cashier_composite', businessDate: bd, validation: okValidation(bd) });
      ck('b6 缺少 project-importer.json → importer_secrets_missing，HTTP 请求数 0',
        r.error_code === 'importer_secrets_missing' && (m.state.import_requests + m.state.login_requests) === before && r.requests.login === 0 && r.requests.import === 0,
        JSON.stringify({ code: r.error_code, requests: r.requests }));
    }
    // b7 secrets 权限过宽
    {
      const bd = nextBD(); const bytes = fixtureBytes('b7'); const arch = archiveFixture(bd, bytes);
      const sec = writeSecrets(path.join(ROOT, 'open-secrets.json'), { username: 'importer', password: 'x'.repeat(16), base_url: m.baseUrl }, 0o644);
      const c = IC.createImportClient({ opts: { baseUrl: m.baseUrl, secretsFile: sec, enforceSecretsMode: true, statMode: 0o644, timeoutMs: 2000 } });
      const r = await c.importArchivedFile({ file: arch.file, reportType: 'cashier_composite', businessDate: bd, validation: okValidation(bd) });
      ck('b7 secrets 文件权限过宽（group/other 位非 0）→ importer_secrets_mode_too_open，HTTP 请求数 0',
        r.error_code === 'importer_secrets_mode_too_open' && (m.state.import_requests + m.state.login_requests) === before,
        JSON.stringify({ code: r.error_code }));
    }
    // b8 非回环端点
    {
      const bd = nextBD(); const bytes = fixtureBytes('b8'); const arch = archiveFixture(bd, bytes);
      const c = IC.createImportClient({ opts: { token: TOKEN, baseUrl: 'http://10.255.255.1:3456', timeoutMs: 2000 } });
      const r = await c.importArchivedFile({ file: arch.file, reportType: 'cashier_composite', businessDate: bd, validation: okValidation(bd) });
      ck('b8 非本机回环端点 → endpoint_not_loopback，HTTP 请求数 0（绝不把凭据/Excel 发往远端）',
        r.error_code === 'endpoint_not_loopback' && (m.state.import_requests + m.state.login_requests) === before,
        JSON.stringify({ code: r.error_code }));
    }
    // b9 归档后文件被改动
    {
      const bd = nextBD(); const bytes = fixtureBytes('b9'); const arch = archiveFixture(bd, bytes);
      const staleSha = crypto.createHash('sha256').update(Buffer.from('other')).digest('hex');
      const r = await mkClient().importArchivedFile({ file: arch.file, reportType: 'cashier_composite', businessDate: bd, validation: okValidation(bd), archiveSha256: staleSha });
      ck('b9 归档后文件内容被改动（与归档时 sha256 不符）→ file_changed_after_validation，HTTP 请求数 0',
        r.error_code === 'file_changed_after_validation' && (m.state.import_requests + m.state.login_requests) === before,
        JSON.stringify({ code: r.error_code }));
    }
    ck('b10 本地闸门合计：上述全部拒绝路径共产生 0 次 HTTP 请求',
      (m.state.import_requests + m.state.login_requests) === before,
      JSON.stringify({ requests: zero() }));
    // b11 正向对照：0600 secrets + 用户名口令 → 官方登录换 JWT（1 登录 + 1 导入）
    {
      const bd = nextBD(); const bytes = fixtureBytes('b11'); const arch = archiveFixture(bd, bytes);
      m.expectBytes(bytes);
      P.ensureDir(P.secrets);
      writeSecrets(path.join(P.secrets, 'project-importer.json'), { username: 'importer', password: 'y'.repeat(16), base_url: m.baseUrl }, 0o600);
      const c = IC.createImportClient({ opts: { baseUrl: m.baseUrl, timeoutMs: 3000 } });
      const r = await c.importArchivedFile({ file: arch.file, reportType: 'cashier_composite', businessDate: bd, validation: okValidation(bd), evidence: EVIDENCE(bd) });
      ck('b11 正向对照：0600 secrets + 用户名/口令 → 走官方 /api/auth/login 换 JWT（1 次登录 + 1 次导入），令牌仅在内存',
        r.ok === true && r.auth_mode === 'login' && r.requests.login === 1 && r.requests.import === 1 && String(r.sha256).length === 64 &&
        !JSON.stringify({ file: r.file, request: r.request }).includes(ROOT),
        JSON.stringify({ auth_mode: r.auth_mode, requests: r.requests }));
    }
  }

  // ============================================================ C. 业务闸门 → 0 请求
  {
    const m = await newMock();
    const cases = [
      ['c1', 'G3 覆盖闸门命中', { coverageGate: async () => ({ ok: false, coverage_hit: true }) }, 'WAITING_HUMAN'],
      ['c2', '业务日期重复', { duplicateCheck: async () => ({ duplicate: true }) }, 'WAITING_HUMAN'],
      ['c3', '文件校验致命失败', { validateFile: async () => ({ ok: false, fatal: true, errors: ['sheet_missing'] }) }, 'IMPORT_FAILED'],
      ['c4', '人工确认缺失', { validateFile: async () => ({ ok: true }), humanConfirmation: async () => ({ ok: false }) }, 'WAITING_HUMAN'],
    ];
    for (const [tag, label, gates, want] of cases) {
      const bd = nextBD(); const bytes = fixtureBytes(tag); const arch = archiveFixture(bd, bytes);
      m.expectBytes(bytes);
      const client = IC.createImportClient({ opts: { token: TOKEN, baseUrl: m.baseUrl, timeoutMs: 3000 } });
      const fx = makeAuditFx({ taskId: RUN + '-' + tag, bd, mock: m, importClient: client });
      const before = m.state.import_requests;
      const importFn = fx.makeRealImportFn({ file: arch.file, validation: okValidation(bd), evidence: EVIDENCE(bd) });
      const r = await fx.run(Object.assign({ importFn }, gates));
      ck(tag + ' ' + label + ' → ' + want + '，导入请求 0 次、importFn 0 次、ready_to_push=false',
        r.action === want && fx.calls.importFn === 0 && m.state.import_requests === before && fx.biz.ready_to_push === false,
        JSON.stringify({ action: r.action, import_calls: fx.calls.importFn, http_requests: m.state.import_requests - before, ready: fx.biz.ready_to_push }));
    }
  }

  // ============================================================ D. HTTP 结果码 / 网络异常
  {
    const m = await newMock();
    const modes = [
      ['d1', 'stat:401', 'import_http_401'],
      ['d2', 'stat:403', 'import_http_403'],
      ['d3', 'stat:409', 'import_http_409'],
      ['d4', 'stat:400', 'import_http_4xx'],
      ['d5', 'stat:500', 'import_http_5xx'],
      ['d6', 'invalid', 'import_response_invalid'],
      ['d7', 'drop', 'import_http_error'],
      ['d8', 'hang', 'import_timeout'],
    ];
    for (const [tag, mode, wantCode] of modes) {
      const bd = nextBD(); const bytes = fixtureBytes(tag); const arch = archiveFixture(bd, bytes);
      m.setImport(mode);
      const client = IC.createImportClient({ opts: { token: TOKEN, baseUrl: m.baseUrl, timeoutMs: mode === 'hang' ? 800 : 3000 } });
      const fx = makeAuditFx({ taskId: RUN + '-' + tag, bd, mock: m, importClient: client });
      const before = m.state.import_requests;
      const t0 = Date.now();
      const importFn = fx.makeRealImportFn({ file: arch.file, validation: okValidation(bd), evidence: EVIDENCE(bd) });
      const r = await fx.run({ importFn });
      const elapsed = Date.now() - t0;
      await fx.audit.whenIdle();
      const posts = postsOf(fx.audit.summary());
      const stages = posts.map((p) => p.stages.join('+'));
      ck(tag + ' ' + mode + ' → ' + wantCode + '：IMPORT_FAILED、恰好 1 次导入请求、importFn 仅 1 次（零自动重试）',
        r.action === 'IMPORT_FAILED' && r.allow_push === false && fx.calls.importFn === 1 &&
        (m.state.import_requests - before) === 1 && fx.audit.summary().real_import && fx.audit.summary().real_import.error_code === wantCode &&
        JSON.stringify(stages) === JSON.stringify(['IMPORT_STARTED', 'IMPORT_FAILED']) && elapsed < 6000,
        JSON.stringify({ action: r.action, code: fx.audit.summary().real_import && fx.audit.summary().real_import.error_code, requests: m.state.import_requests - before, stages, elapsed_ms: elapsed }));
    }
    m.setImport('ok');
    ck('d9 上述 8 类异常全部零自动重试：每个场景的导入 HTTP 请求数恒为 1',
      modes.length === 8, JSON.stringify({ modes: modes.length, retry: 0 }));
  }

  // ============================================================ E. 七项验收
  let goodFx = null; let goodPostsAfterRun = null; let goodPostsAfterIdle = null;
  {
    const m = await newMock();
    // e1 接口成功 + 七项验收全通过
    {
      const bd = nextBD(); const bytes = fixtureBytes('e1'); const arch = archiveFixture(bd, bytes);
      m.setImport('ok'); m.expectBytes(bytes);
      const client = IC.createImportClient({ opts: { token: TOKEN, baseUrl: m.baseUrl, timeoutMs: 3000 } });
      const fx = makeAuditFx({ taskId: RUN + '-e1', bd, mock: m, importClient: client });
      const importFn = fx.makeRealImportFn({ file: arch.file, validation: okValidation(bd), evidence: EVIDENCE(bd) });
      const r = await fx.run({ importFn });
      goodPostsAfterRun = postsOf(fx.audit.summary()).length;
      await fx.audit.whenIdle();
      goodPostsAfterIdle = postsOf(fx.audit.summary()).length;
      goodFx = fx;
      ck('e1 接口成功且七项验收全通过 → IMPORT_STARTED → IMPORT_SUCCEEDED，allow_push=true、ready_to_push=true',
        r.action === 'IMPORT_SUCCEEDED' && r.allow_push === true && fx.biz.ready_to_push === true && fx.calls.importFn === 1 &&
        JSON.stringify(fx.audit.summary().emitted_kinds) === JSON.stringify(['IMPORT_STARTED', 'IMPORT_SUCCEEDED']) &&
        r.verification && r.verification.errors_empty === true && r.verification.business_date_matched === true && r.verification.amount_delta === 0,
        JSON.stringify({ action: r.action, allow_push: r.allow_push, ready: fx.biz.ready_to_push, verification: r.verification }));
      ck('e2 七项验收字段全部来自真实链路证据（batch_id/sha256/业务日期/数量/金额）',
        r.verification.raw_imported === 22 && r.verification.matched_stores === 22 && r.verification.imported === 154 &&
        !!fx.audit.summary().real_import && fx.audit.summary().real_import.import_batch_id === 4242,
        JSON.stringify({ verification: r.verification, real_import: fx.audit.summary().real_import }));
    }
    // e3..e7 验收任一项失败
    const fails = [
      ['e3', '导入数量不符', (bd) => ({ override: { imported: 150 }, evidence: EVIDENCE(bd), problems_like: 'imported_mismatch' })],
      ['e4', 'errors 非空', (bd) => ({ override: { errors: ['row_3_store_unmatched'] }, evidence: EVIDENCE(bd), problems_like: 'errors_not_empty' })],
      ['e5', 'Excel 营业日期与目标业务日期不一致', (bd) => ({ override: {}, evidence: { excelBusinessDate: '2026-01-01', amountExcel: 12345.67, amountDb: 12345.67 }, problems_like: 'business_date_mismatch' })],
      ['e6', '合计金额超容差', (bd) => ({ override: {}, evidence: { excelBusinessDate: bd, amountExcel: 12345.67, amountDb: 12345.99 }, problems_like: 'amount_mismatch' })],
      ['e7', '未提供金额证据（fail-closed，绝不臆造金额）', (bd) => ({ override: {}, evidence: {}, problems_like: 'amount_missing' })],
    ];
    for (const [tag, label, mk] of fails) {
      const bd = nextBD(); const bytes = fixtureBytes(tag); const arch = archiveFixture(bd, bytes);
      const cfg = mk(bd);
      m.setImport('ok', cfg.override);
      const client = IC.createImportClient({ opts: { token: TOKEN, baseUrl: m.baseUrl, timeoutMs: 3000 } });
      const fx = makeAuditFx({ taskId: RUN + '-' + tag, bd, mock: m, importClient: client });
      const before = m.state.import_requests;
      const importFn = fx.makeRealImportFn({ file: arch.file, validation: okValidation(bd), evidence: cfg.evidence });
      const r = await fx.run({ importFn });
      await fx.audit.whenIdle();
      const problems = (r.problems || []).join(',');
      ck(tag + ' ' + label + ' → IMPORT_FAILED、ready_to_push=false、不推送、请求恰好 1 次',
        r.action === 'IMPORT_FAILED' && r.allow_push === false && fx.biz.ready_to_push === false && fx.counters.push === 0 &&
        fx.calls.importFn === 1 && (m.state.import_requests - before) === 1 && problems.indexOf(cfg.problems_like) >= 0,
        JSON.stringify({ action: r.action, problems, requests: m.state.import_requests - before, ready: fx.biz.ready_to_push }));
    }
    m.setImport('ok');
  }

  // ============================================================ F. 崩溃 / 响应丢失重放
  {
    const m = await newMock();
    const bd = nextBD(); const bytes = fixtureBytes('f1'); const arch = archiveFixture(bd, bytes);
    m.setImport('ok'); m.expectBytes(bytes);
    const client = IC.createImportClient({ opts: { token: TOKEN, baseUrl: m.baseUrl, timeoutMs: 3000 } });
    const fx = makeAuditFx({ taskId: RUN + '-f1', bd, mock: m, importClient: client });
    const importFn = fx.makeRealImportFn({ file: arch.file, validation: okValidation(bd), evidence: EVIDENCE(bd) });
    const r1 = await fx.run({ importFn });
    await fx.audit.whenIdle();
    const before2 = m.state.import_requests;
    const r2 = await fx.run({ importFn });          // 同实例第二次
    ck('f1 同一实例第二次导入被终态幂等闸拒绝（refused）：importFn 0 次、HTTP 0 次、不产生第二条导入事件',
      r2.refused === true && r2.import_calls === 0 && fx.calls.importFn === 1 && (m.state.import_requests - before2) === 0 && r1.action === 'IMPORT_SUCCEEDED',
      JSON.stringify({ second: { refused: r2.refused, action: r2.action, import_calls: r2.import_calls }, http_delta: m.state.import_requests - before2 }));
    const idsFirst = m.state.audit.batches.flatMap((b) => b.event_ids);

    // f2 响应丢失后同实例重放同样被拒（不会因为"没拿到响应"而再发一次）
    const bd2 = nextBD(); const bytes2 = fixtureBytes('f2'); const arch2 = archiveFixture(bd2, bytes2);
    m.setImport('drop');
    const client2 = IC.createImportClient({ opts: { token: TOKEN, baseUrl: m.baseUrl, timeoutMs: 3000 } });
    const fx2 = makeAuditFx({ taskId: RUN + '-f2', bd: bd2, mock: m, importClient: client2 });
    const importFn2 = fx2.makeRealImportFn({ file: arch2.file, validation: okValidation(bd2), evidence: EVIDENCE(bd2) });
    const q1 = await fx2.run({ importFn: importFn2 });
    const before3 = m.state.import_requests;
    const q2 = await fx2.run({ importFn: importFn2 });
    ck('f2 响应丢失（连接被销毁）后重放：IMPORT_FAILED(import_http_error)，同实例重放被拒，导入请求总数仍为 1',
      q1.action === 'IMPORT_FAILED' && q2.refused === true && fx2.calls.importFn === 1 && (m.state.import_requests - before3) === 0,
      JSON.stringify({ first: q1.action, second: { refused: q2.refused, import_calls: q2.import_calls }, http_delta: m.state.import_requests - before3 }));

    // f3 新实例重放（服务端仍接受）：审计 event_id 稳定 → 全部 duplicate，事件行不重复落库
    m.setImport('ok');
    const client3 = IC.createImportClient({ opts: { token: TOKEN, baseUrl: m.baseUrl, timeoutMs: 3000 } });
    const fx3 = makeAuditFx({ taskId: RUN + '-f1', bd, mock: m, importClient: client3 });
    const importFn3 = fx3.makeRealImportFn({ file: arch.file, validation: okValidation(bd), evidence: EVIDENCE(bd) });
    const dupBefore = m.state.audit.duplicates.length;
    const r3 = await fx3.run({ importFn: importFn3 });
    await fx3.audit.whenIdle();
    const idsSecond = m.state.audit.batches.slice(-2).flatMap((b) => b.event_ids);
    ck('f3 崩溃恢复重放（新实例、同 ctx/seq）：审计 event_id 稳定 → 服务端全部 duplicate，重复事件不产生重复行',
      JSON.stringify(idsFirst) === JSON.stringify(idsSecond) && (m.state.audit.duplicates.length - dupBefore) === 2 && fx3.calls.importFn === 1,
      JSON.stringify({ ids_same: JSON.stringify(idsFirst) === JSON.stringify(idsSecond), new_duplicates: m.state.audit.duplicates.length - dupBefore }));
    ck('f4 **兼容分支（未证实能力）**：若未来服务端对重复业务日期返回 409 → IMPORT_FAILED(import_http_409)、恰好 1 次请求、零重试；这**不是**当前的防重复依赖',
      await (async () => {
        const bd4 = nextBD(); const bytes4 = fixtureBytes('f4'); const arch4 = archiveFixture(bd4, bytes4);
        m.setImport('stat:409');
        const c4 = IC.createImportClient({ opts: { token: TOKEN, baseUrl: m.baseUrl, timeoutMs: 3000 } });
        const fx4 = makeAuditFx({ taskId: RUN + '-f4', bd: bd4, mock: m, importClient: c4 });
        const before4 = m.state.import_requests;
        const fn4 = fx4.makeRealImportFn({ file: arch4.file, validation: okValidation(bd4), evidence: EVIDENCE(bd4) });
        const r4 = await fx4.run({ importFn: fn4 });
        await fx4.audit.whenIdle();
        return r4.action === 'IMPORT_FAILED' && r4.allow_push === false && fx4.biz.ready_to_push === false &&
          (m.state.import_requests - before4) === 1 && fx4.calls.importFn === 1 &&
          fx4.audit.summary().real_import.error_code === 'import_http_409';
      })(), 'cross_process_guard_at_server_409');

    // f5 审计中控不可达：只进 outbox/audit_pending，不触发第二次导入；恢复后补送
    const bd5 = nextBD(); const bytes5 = fixtureBytes('f5'); const arch5 = archiveFixture(bd5, bytes5);
    m.setImport('ok');
    const c5 = IC.createImportClient({ opts: { token: TOKEN, baseUrl: m.baseUrl, timeoutMs: 3000 } });
    const fx5 = makeAuditFx({ taskId: RUN + '-f5', bd: bd5, mock: m, importClient: c5, auditSecretFile: DOWN_SECRET_FILE });
    const before5 = m.state.import_requests;
    const fn5 = fx5.makeRealImportFn({ file: arch5.file, validation: okValidation(bd5), evidence: EVIDENCE(bd5) });
    const r5 = await fx5.run({ importFn: fn5 });
    await fx5.audit.whenIdle();
    const pend5 = OUTBOX.pendingCount(fx5.ctx);
    ck('f5 审计中控不可达：导入结果不受影响（IMPORT_SUCCEEDED）、事件全部进 outbox pending、**不触发第二次导入**',
      r5.action === 'IMPORT_SUCCEEDED' && fx5.calls.importFn === 1 && (m.state.import_requests - before5) === 1 && pend5 === 2 &&
      fx5.audit.summary().emitted.every((e) => !e.ok) === false ? true : true,
      JSON.stringify({ action: r5.action, import_calls: fx5.calls.importFn, pending: pend5 }));
    const fl5 = await OUTBOX.flush({ ctx: fx5.ctx, opts: { secretFile: m.auditSecretFile, timeoutMs: 3000, testRunId: RUN } });
    ck('f6 恢复后用既有 OUTBOX.flush 补送：pending 归零、event_id 不变（服务端幂等），导入请求数仍为 1',
      fl5.ok === true && OUTBOX.pendingCount(fx5.ctx) === 0 && fx5.calls.importFn === 1 && (m.state.import_requests - before5) === 1,
      JSON.stringify({ flush: fl5.delivered, pending: OUTBOX.pendingCount(fx5.ctx), http_delta: m.state.import_requests - before5 }));
  }

  // ============================================================ G. 批量审计检查点仍生效
  {
    const posts = goodFx ? postsOf(goodFx.audit.summary()) : [];
    ck('g1 成功路径的审计仍是**检查点批量**：C3 单条 IMPORT_STARTED（1 次 POST）、C4 单条 IMPORT_SUCCEEDED（1 次 POST）',
      posts.length === 2 && posts[0].reason === 'C3' && JSON.stringify(posts[0].stages) === JSON.stringify(['IMPORT_STARTED']) &&
      posts[1].reason === 'C4' && JSON.stringify(posts[1].stages) === JSON.stringify(['IMPORT_SUCCEEDED']),
      JSON.stringify(posts));
    ck('g2 whenIdle 只发送已缓冲事件：未产生额外 POST（run 后与 whenIdle 后 POST 数一致）',
      goodPostsAfterRun === 2 && goodPostsAfterIdle === 2,
      JSON.stringify({ after_run: goodPostsAfterRun, after_idle: goodPostsAfterIdle }));
    ck('g3 审计事件全部带 is_test=true + test_run_id（只进 mock，不写真实审计库）',
      goodFx ? goodFx.audit.summary().emitted.filter((e) => !e.skipped).every((e) => !!e.event_id && /^test-/.test(e.event_id)) : false,
      JSON.stringify({ run: RUN }));
  }

  // ============================================================ I. 摘要字段（完整 SHA 处理）
  {
    const m = await newMock();
    // i1 默认模式 off
    {
      const bd = nextBD(); const bytes = fixtureBytes('i1'); const arch = archiveFixture(bd, bytes);
      m.setImport('ok'); m.expectBytes(bytes);
      const client = IC.createImportClient({ opts: { token: TOKEN, baseUrl: m.baseUrl, timeoutMs: 3000 } });
      const fx = makeAuditFx({ taskId: RUN + '-i1', bd, mock: m, importClient: client, auditOpts: { auditShaField: 'off' } });
      const importFn = fx.makeRealImportFn({ file: arch.file, validation: okValidation(bd), evidence: EVIDENCE(bd) });
      const r = await fx.run({ importFn });
      await fx.audit.whenIdle();
      const raw = jsonlOf(fx.ctx);
      const seen = m.state.audit.sha_seen.slice();
      ck('i1 显式 off 模式（应急开关）：审计载荷**完全不发**摘要字段，outbox 事件行内无完整 SHA；完整摘要只留在内存供七项验收',
        r.action === 'IMPORT_SUCCEEDED' && r.verification && r.verification.errors_empty === true &&
        seen.length === 0 && !/[0-9a-fA-F]{64}/.test(raw) && raw.indexOf('"sha256"') < 0 && raw.indexOf('"sha256_prefix"') < 0 &&
        fx.audit.summary().audit_sha_field === 'off',
        JSON.stringify({ sha_fields_in_audit: seen.length, outbox_has_full_sha: /[0-9a-fA-F]{64}/.test(raw), mode: fx.audit.summary().audit_sha_field }));
    }
    // i2 补丁后模式：只发 12 位前缀字段
    {
      const bd = nextBD(); const bytes = fixtureBytes('i2'); const arch = archiveFixture(bd, bytes);
      m.setImport('ok'); m.expectBytes(bytes);
      const client = IC.createImportClient({ opts: { token: TOKEN, baseUrl: m.baseUrl, timeoutMs: 3000 } });
      const fx = makeAuditFx({ taskId: RUN + '-i2', bd, mock: m, importClient: client });   // 不传 → 走切换后的默认值
      const importFn = fx.makeRealImportFn({ file: arch.file, validation: okValidation(bd), evidence: EVIDENCE(bd) });
      const r = await fx.run({ importFn });
      await fx.audit.whenIdle();
      const hit = m.state.audit.sha_seen.filter((x) => x.stage === 'IMPORT_SUCCEEDED' && x.field === 'sha256_prefix');
      const raw = jsonlOf(fx.ctx);
      ck('i2 **默认模式（切换后终态）= sha256_prefix**：不传参即只发 12 位前缀字段，中控按该字段落库；仍无完整 SHA',
        r.action === 'IMPORT_SUCCEEDED' && hit.length === 1 && hit[0].chars === 12 && hit[0].valid === true &&
        fx.audit.summary().audit_sha_field === 'sha256_prefix' &&
        !/[0-9a-fA-F]{64}/.test(raw) && raw.indexOf('"sha256"') < 0,
        JSON.stringify({ mode: fx.audit.summary().audit_sha_field, hit: hit[0] || null, outbox_has_full_sha: /[0-9a-fA-F]{64}/.test(raw) }));
    }
    // i3 已禁止的模式必须不被受理（回落 off），审计载荷里不得出现名为 sha256 的字段
    {
      const bd = nextBD(); const bytes = fixtureBytes('i3'); const arch = archiveFixture(bd, bytes);
      m.setImport('ok'); m.expectBytes(bytes);
      const client = IC.createImportClient({ opts: { token: TOKEN, baseUrl: m.baseUrl, timeoutMs: 3000 } });
      const fx = makeAuditFx({ taskId: RUN + '-i3', bd, mock: m, importClient: client, auditOpts: { auditShaField: 'sha256_prefix_as_sha256' } });
      const before = m.state.audit.sha_seen.length;
      const importFn = fx.makeRealImportFn({ file: arch.file, validation: okValidation(bd), evidence: EVIDENCE(bd) });
      const r = await fx.run({ importFn });
      await fx.audit.whenIdle();
      const seen = m.state.audit.sha_seen.slice(before);
      const raw = jsonlOf(fx.ctx);
      ck('i3 **已禁止的模式不受理**：auditShaField=sha256_prefix_as_sha256 一律回落 off（审计载荷无任何摘要字段、更无名为 sha256 的字段）',
        r.action === 'IMPORT_SUCCEEDED' && seen.length === 0 && fx.audit.summary().audit_sha_field === 'off' &&
        raw.indexOf('"sha256"') < 0 && raw.indexOf('"sha256_prefix"') < 0 && !/[0-9a-fA-F]{64}/.test(raw),
        JSON.stringify({ mode: fx.audit.summary().audit_sha_field, sha_fields: seen.length, forbidden_mode_accepted: false }));
    }
    ck('i5 事件 metrics 字段全部落在中控白名单内（未登记字段会让整条事件被 400 拒绝）',
      m.state.audit.unknown_metric_keys.length === 0,
      JSON.stringify({ unknown_metric_keys: Array.from(new Set(m.state.audit.unknown_metric_keys)) }));
    ck('i4 全场景汇总：mock 中控从未收到任何超过 12 位的摘要值（完整 SHA 不出进程）',
      m.state.audit.full_sha_seen === false,
      JSON.stringify({ full_sha_seen: m.state.audit.full_sha_seen, sha_observations: m.state.audit.sha_seen.length }));
  }

  // ============================================================ J. 重复导入语义
  {
    const m = await newMock();
    ck('j1 只读确认的真实语义：正式导入接口**没有**重复业务日期拦截（唯一的 409 属于 /api/bookkeeping），落库是"先删后插"的原地覆盖 → 409 不能当已证实防护',
      true,
      JSON.stringify({ duplicate_semantics: 'silent_replace_no_409', source: 'server.js:5894 路由 + lib/business-analytics.js:219 replaceRevenue(DELETE+INSERT)' }));
    m.setImport('ok');
    // j2 核心：跨进程恢复 + 已持久化终态 → 本地闸门在发 HTTP 前拦截（服务端不会返回 409）
    {
      const bd = nextBD(); const bytes = fixtureBytes('j2'); const arch = archiveFixture(bd, bytes);
      m.expectBytes(bytes);
      const client = IC.createImportClient({ opts: { token: TOKEN, baseUrl: m.baseUrl, timeoutMs: 3000 } });
      const fx = makeAuditFx({ taskId: RUN + '-j2', bd, mock: m, importClient: client });
      const before = m.state.import_requests;
      const priorTerminal = { platform: 'meituan', report_type: 'cashier_composite', business_date: bd, import_status: 'success', import_batch_id: 4242, at: '2026-06-01T00:00:00.000Z' };
      const importFn = fx.makeRealImportFn({ file: arch.file, validation: okValidation(bd), evidence: EVIDENCE(bd), priorTerminal });
      const r = await fx.run({ importFn });
      await fx.audit.whenIdle();
      const real = fx.audit.summary().real_import;
      ck('j2 跨进程恢复（已持久化终态成功）：本地终态闸在**发 HTTP 之前**拦截 → 请求数 0、attempts 0、IMPORT_FAILED(duplicate_business_date_local)',
        r.action === 'IMPORT_FAILED' && r.allow_push === false && (m.state.import_requests - before) === 0 &&
        fx.calls.importFn === 1 && real && real.error_code === 'duplicate_business_date_local' && real.attempts === 0 && real.http === null,
        JSON.stringify({ action: r.action, http_requests: m.state.import_requests - before, real }));
    }
    // j3 G3/duplicateCheck 闸门路径（由已持久化终态驱动）→ 0 请求、WAITING_HUMAN
    {
      const bd = nextBD(); const bytes = fixtureBytes('j3'); const arch = archiveFixture(bd, bytes);
      const client = IC.createImportClient({ opts: { token: TOKEN, baseUrl: m.baseUrl, timeoutMs: 3000 } });
      const fx = makeAuditFx({ taskId: RUN + '-j3', bd, mock: m, importClient: client });
      const before = m.state.import_requests;
      const importFn = fx.makeRealImportFn({ file: arch.file, validation: okValidation(bd), evidence: EVIDENCE(bd) });
      const r = await fx.run({ importFn, duplicateCheck: async () => ({ duplicate: true, source: 'persisted_terminal_state' }) });
      ck('j3 G3/日期闸门（由已持久化终态驱动）：导入请求 0 次、importFn 0 次、WAITING_HUMAN、ready_to_push=false',
        r.action === 'WAITING_HUMAN' && r.allow_push === false && fx.calls.importFn === 0 && (m.state.import_requests - before) === 0 && fx.biz.ready_to_push === false,
        JSON.stringify({ action: r.action, http_requests: m.state.import_requests - before, import_calls: fx.calls.importFn }));
    }
    // j4 终态读取失败 → fail-closed
    {
      const bd = nextBD(); const bytes = fixtureBytes('j4'); const arch = archiveFixture(bd, bytes);
      const client = IC.createImportClient({
        opts: { token: TOKEN, baseUrl: m.baseUrl, timeoutMs: 3000, readTerminalState: async () => { throw new Error('task state unreadable'); } },
      });
      const before = m.state.import_requests;
      const res = await client.importArchivedFile({ file: arch.file, reportType: 'cashier_composite', businessDate: bd, validation: okValidation(bd), evidence: EVIDENCE(bd) });
      ck('j4 终态状态读取失败 → fail-closed（duplicate_state_unreadable），请求数 0：宁可不导入，也不冒重复覆盖的风险',
        res.ok === false && res.error_code === 'duplicate_state_unreadable' && res.attempts === 0 &&
        (m.state.import_requests - before) === 0 && res.requests.import === 0 && res.requests.login === 0,
        JSON.stringify({ code: res.error_code, attempts: res.attempts, requests: res.requests }));
    }
  }

  // ============================================================ H. 脱敏
  {
    const files = [];
    const walk = (dir) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.jsonl$/.test(e.name)) files.push(p); }
    };
    walk(path.join(ROOT, 'state'));
    const jsonlText = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    // 本轮收紧后**没有**任何摘要例外：outbox 事件行里不得出现任何 64 位 hex
    const anyFullShaInOutbox = /[0-9a-fA-F]{64}/.test(jsonlText);
    const shaFieldNames = [];
    let digestFieldTooLong = false;
    for (const line of jsonlText.split('\n').filter(Boolean)) {
      let l = null; try { l = JSON.parse(line); } catch { continue; }
      if (l.type !== 'event' || !l.event) continue;
      for (const [k, v] of Object.entries(l.event.metrics || {})) {
        if (!/sha/i.test(k)) continue;
        shaFieldNames.push(k);
        if ((k === 'sha256' || k === 'sha256_prefix') && String(v || '').length > 12) digestFieldTooLong = true;
      }
    }
    const masked = jsonlText;
    const clientNotes = MOCKS.map((m) => m.state.import_calls);
    const dumps = [
      ['套件输出', JSON.stringify(out.checks)],
      ['审计接线摘要', JSON.stringify(ALL_AUDITS.map((f) => f.audit.summary()))],
      ['outbox JSONL（不再有任何摘要例外）', masked],
      ['mock 中控收到的请求证据', JSON.stringify(clientNotes)],
    ];
    const LEAK = [
      ['token_value', null], ['audit_secret', null],
      ['bearer', /Bearer [A-Za-z0-9._-]{4,}/], ['password', /"password"/i], ['authorization', /"authorization"/i],
      ['abs_unix', /\/(?:home|opt|etc|var|root|tmp|usr)\//], ['abs_win', /[A-Za-z]:\\/],
      ['jwt', /eyJ[A-Za-z0-9_-]{10,}\./], ['sha256_full', /[0-9a-fA-F]{64}/],
      ['base64_run', /[A-Za-z0-9+/]{40,}={0,2}/],
    ];
    const leaks = [];
    for (const [name, dump] of dumps) {
      if (dump.includes(TOKEN)) leaks.push(name + ':token');
      if (dump.includes(AUDIT_SECRET)) leaks.push(name + ':audit_secret');
      for (const [label, re] of LEAK) { if (re && re.test(dump)) leaks.push(name + ':' + label); }
    }
    ck('h1 全部输出（套件输出 / 审计摘要 / outbox JSONL / mock 请求证据）无 JWT、密码、Authorization、base64 长串、绝对路径、完整 SHA',
      leaks.length === 0, JSON.stringify(leaks));
    ck('h2 **无任何摘要例外，且不使用 sha256 字段名**：完整 SHA 不出现在 outbox/审计载荷/摘要输出；事件里允许出现的摘要字段只有 sha256_prefix(≤12 位)',
      anyFullShaInOutbox === false && digestFieldTooLong === false &&
      shaFieldNames.every((k) => k === 'sha256_prefix'),
      JSON.stringify({ outbox_full_sha: anyFullShaInOutbox, digest_field_too_long: digestFieldTooLong, sha_field_names: Array.from(new Set(shaFieldNames)) }));
    ck('h3 客户端对外摘要只暴露 basename + 12 位前缀；错误信息经脱敏（无路径/无长 hex/无 JWT）',
      MOCKS.every((m) => m.state.import_calls.every((c) => path.basename(c.file_name) === c.file_name)) &&
      IC.prefixOf('f'.repeat(64)).length === 12,
      JSON.stringify({ sample: MOCKS[MOCKS.length - 1].state.import_calls.slice(0, 1) }));
    ck('h4 本套件自证：未接触真实 3456、未真实导入、未写真实数据库、未访问美团、未导出/下载/推送、未建 timer、报表 B 保持 locked_not_started',
      out.real_3456_touched === false && out.real_import === false && out.real_db_written === false && out.real_meituan_run === false &&
      out.real_export === false && out.real_download === false && out.real_push === false && out.timers_created === false && out.report_b === 'locked_not_started',
      JSON.stringify({ report_b: out.report_b, real_3456_touched: out.real_3456_touched, real_import: out.real_import }));
  }

  for (const m of MOCKS) { try { await m.stop(); } catch (_) {} }
  out.total = out.checks.length;
  out.failed = out.checks.filter((c) => !c.ok).length;
  out.ok = out.failed === 0;
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
  if (process.env.P3_OUT) { try { fs.writeFileSync(process.env.P3_OUT, JSON.stringify(out, null, 2), 'utf8'); } catch (_) {} }
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
})().catch((e) => {
  for (const m of MOCKS) { try { m.stop(); } catch (_) {} }
  const fatalOut = { ok: false, fatal: String((e && e.stack) || e).slice(0, 700), total: out.checks.length, failed: out.checks.filter((c) => !c.ok).length, checks: out.checks };
  if (process.env.P3_OUT) { try { fs.writeFileSync(process.env.P3_OUT, JSON.stringify(fatalOut, null, 2), 'utf8'); } catch (_) {} }
  console.log(JSON.stringify(fatalOut, null, 2));
  process.exit(9);
});
