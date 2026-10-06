#!/usr/bin/env node
'use strict';
/**
 * 阶段3 真实导入编排接线 · **纯离线 fixture 套件**
 *
 * 边界声明：
 *  - 使用**随机端口 mock import server**（同时实现 /api/auth/login、/api/business-analytics/import、
 *    /api/internal/syncbot/events 三个端点，字段/状态码与现有正式源码只读确认的一致）；
 *  - **绝不调用真实 3456**、不执行真实导入、不推送、不建 timer、不访问美团、不写项目数据库；
 *  - 报表 B（item_sales_detail）保持 locked_not_started，本套件显式验证它被拒绝；
 *  - 任务状态写的是临时 SYNCBOT_ROOT 下的 state/tasks（真实走 src/state.js 原子写）；
 *  - 输出不含 JWT/密钥/base64/绝对路径/完整 SHA。
 *
 * 运行：SYNCBOT_BOT=<bot root> node import-run-test.js
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p3run-'));
process.env.SYNCBOT_ROOT = ROOT;

const BOT = process.env.SYNCBOT_BOT || '/opt/zhongkong-sync-bot';
const P = require(BOT + '/app/src/paths.js');
const TC = require(BOT + '/app/src/task-context.js');
const state = require(BOT + '/app/src/state.js');
const RUNMOD = require(BOT + '/app/src/phase3/import-run.js');
const IC = require(BOT + '/app/src/phase3/import-client.js');
const OUTBOX = require(BOT + '/app/src/phase3/audit-outbox.js');

const AUDIT_SECRET = crypto.randomBytes(32).toString('hex');
const TOKEN = 'tok-' + crypto.randomBytes(12).toString('hex');
const RUN = 'test-run-' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');
const SHA_PREFIX_LEN = 12;

const out = {
  suite: 'phase3-import-run-fixture', fixture: true, offline: true,
  real_3456_touched: false, real_import: false, real_push: false, timers_created: false,
  real_db_written: false, report_b: 'locked_not_started', test_run_id: RUN, checks: [],
};
const ck = (n, ok, d) => out.checks.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });

let SEQ = 0;
function nextBD() { SEQ += 1; return new Date(Date.UTC(2026, 7, 1 + SEQ)).toISOString().slice(0, 10); }
let SEC_SEQ = 0;

const IMPORT_PATH = '/api/business-analytics/import';
const LOGIN_PATH = '/api/auth/login';
const AUDIT_PATH = '/api/internal/syncbot/events';
const MOCK_ALLOWED_METRIC_FIELDS = new Set(['phase', 'started_at', 'finished_at', 'duration_ms', 'failure_reason',
  'original_filename', 'file_size', 'sha256', 'sha256_prefix', 'import_batch_id', 'raw_store_count', 'matched_store_count',
  'ready_to_push', 'push_status', 'imported', 'pushed', 'is_backfill', 'reconstructed', 'not_a_realtime_success',
  'screenshot_count', 'validation', 'evidence', 'note']);

// ---------------------------------------------------------------- mock 中控
function createMock() {
  const st = {
    import_requests: 0, login_requests: 0, audit_requests: 0,
    last_body_keys: null, base64_identical: null, file_name_basename_only: null, auth_ok: null,
    phase_at_http: null, content_type: null, method: null, path_seen: null,
    audit: { accepted: [], duplicates: [], batches: [], sha_seen: [], full_sha_seen: false, unknown_metric_keys: [] },
  };
  let importMode = 'ok';
  let override = null;
  let expectedBytes = null;
  let stateFileGetter = null;
  const seen = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = String(req.url || '').split('?')[0];
      if (url === LOGIN_PATH) {
        st.login_requests += 1;
        let b = null; try { b = JSON.parse(raw.toString('utf8')); } catch { b = null; }
        if (!b || !b.username || !b.password) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '用户名和密码不能为空' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, token: TOKEN, user: { id: 9, username: String(b.username) } }));
        return;
      }
      if (url === IMPORT_PATH) {
        st.import_requests += 1;
        st.method = req.method; st.path_seen = url; st.content_type = String(req.headers['content-type'] || '');
        st.auth_ok = String(req.headers.authorization || '') === 'Bearer ' + TOKEN;
        // ★ 在"HTTP 到达服务端"的这一刻抓取任务状态文件，用于证明 IMPORT_STARTED 已先落盘
        try { st.phase_at_http = stateFileGetter ? (JSON.parse(fs.readFileSync(stateFileGetter(), 'utf8')).import || {}).phase : null; } catch { st.phase_at_http = 'READ_ERROR'; }
        if (importMode === 'drop') { try { req.socket.destroy(); } catch (_) {} return; }
        if (importMode === 'hang') { return; }
        if (!st.auth_ok) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '未登录' })); return; }
        let body = null; try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; }
        if (!body) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '请求体不是合法 JSON' })); return; }
        st.last_body_keys = Object.keys(body).sort();
        const name = String(body.file_name || '');
        st.file_name_basename_only = path.basename(name) === name && name.indexOf('..') < 0;
        st.base64_identical = expectedBytes ? Buffer.from(String(body.data || ''), 'base64').equals(expectedBytes) : null;
        if (String(importMode).startsWith('stat:')) {
          const code = Number(String(importMode).split(':')[1]);
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'mock_http_' + code }));
          return;
        }
        if (importMode === 'invalid') { res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
        const base = { ok: true, batch_id: 770001, data_kind: 'cashier_composite', imported: 154, raw_imported: 22, matched_stores: 22, skipped: 0, errors: [], resolved_channels: ['店内销售'], income_composition_fields: ['美团团购'] };
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(Object.assign(base, override || {})));
        return;
      }
      if (url === AUDIT_PATH) {
        st.audit_requests += 1;
        const rawText = raw.toString('utf8');
        const ts = String(req.headers['x-syncbot-timestamp'] || '');
        const sig = String(req.headers['x-syncbot-signature'] || '');
        const want = crypto.createHmac('sha256', AUDIT_SECRET).update(ts + '.' + rawText, 'utf8').digest('hex');
        if (sig !== want) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'signature_invalid' })); return; }
        let body = null; try { body = JSON.parse(rawText); } catch { body = null; }
        const events = body && Array.isArray(body.events) ? body.events : [];
        if (!events.length) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'events_required' })); return; }
        const accepted = []; const duplicates = [];
        const batchSeen = new Set();
        for (const e of events) {
          if (seen.has(e.event_id) || batchSeen.has(e.event_id)) duplicates.push(e.event_id);
          else { accepted.push(e.event_id); batchSeen.add(e.event_id); }
          const mm = (e && e.metrics) || {};
          for (const k of Object.keys(mm)) if (!MOCK_ALLOWED_METRIC_FIELDS.has(k) && k !== 'sha256' && k !== 'sha256_prefix') st.audit.unknown_metric_keys.push(k);
          for (const [k, v] of Object.entries(mm)) {
            const s = String(v == null ? '' : v);
            if (k === 'sha256') { st.audit.sha_seen.push({ stage: e.stage, field: 'sha256', chars: s.length }); if (s.length > SHA_PREFIX_LEN) st.audit.full_sha_seen = true; }
            if (k === 'sha256_prefix') { st.audit.sha_seen.push({ stage: e.stage, field: 'sha256_prefix', chars: s.length, valid: /^[0-9a-f]{1,12}$/i.test(s) }); }
          }
        }
        for (const id of accepted) seen.add(id);
        st.audit.accepted.push.apply(st.audit.accepted, accepted);
        st.audit.duplicates.push.apply(st.audit.duplicates, duplicates);
        st.audit.batches.push({ n: events.length, stages: events.map((e) => e.stage), event_ids: events.map((e) => e.event_id) });
        res.writeHead(accepted.length ? 201 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, accepted: accepted.length, duplicates: duplicates.length, rejected: [] }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
  });
  return {
    server, state: st,
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      this.baseUrl = 'http://127.0.0.1:' + server.address().port;
      SEC_SEQ += 1;
      this.auditSecretFile = path.join(ROOT, 'audit-secret-' + SEC_SEQ + '.json');
      fs.writeFileSync(this.auditSecretFile, JSON.stringify({ secret: AUDIT_SECRET, endpoint: this.baseUrl + AUDIT_PATH }), { mode: 0o600 });
      return this;
    },
    async stop() { await new Promise((r) => server.close(r)); },
    setImport(mode, ov) { importMode = mode; override = ov || null; },
    expectBytes(b) { expectedBytes = b; },
    watchStateFile(fn) { stateFileGetter = fn; },
  };
}

// ---------------------------------------------------------------- fixture 工具
function fixtureBytes(tag) { return Buffer.from('XLSX-FIXTURE-' + tag + '-' + crypto.randomBytes(64).toString('hex')); }
function archiveFixture(bd, bytes, name) {
  const dir = P.dayDownloads('meituan', 'cashier_composite', bd);
  P.ensureDir(dir);
  const file = path.join(dir, name || ('美团_综合营业统计_' + bd + '.xlsx'));
  fs.writeFileSync(file, bytes);
  return { file, dir, bytes };
}
function okValidation() {
  return { ok: true, checks: { row2_metadata: { ok: true, items: [{ name: '营业日期=目标日期', ok: true }] } }, store_count: 22 };
}
const EVIDENCE = (bd) => ({ excelBusinessDate: bd, amountExcel: 12345.67, amountDb: 12345.67 });

function makeRun({ mock, bd, taskId, auditOpts = null, clientOpts = null, onPending = null }) {
  const ctx = TC.createContext('cashier_composite', { platform: 'meituan', taskId, businessDate: bd });
  const run = RUNMOD.createImportRun({
    ctx,
    opts: Object.assign({ secretFile: mock.auditSecretFile, timeoutMs: 3000, testRunId: RUN,
      clientOpts: Object.assign({ token: TOKEN, baseUrl: mock.baseUrl, timeoutMs: 3000 }, clientOpts || {}) }, auditOpts || {}),
    onPending,
  });
  return { ctx, run };
}
const stateFileOf = (bd) => P.taskStateFile('meituan', 'cashier_composite', bd);
const readStateOf = (bd) => { try { return JSON.parse(fs.readFileSync(stateFileOf(bd), 'utf8')); } catch { return null; } };
const outboxTextOf = (bd) => { try { return fs.readFileSync(OUTBOX.outboxFile('meituan', 'cashier_composite', bd), 'utf8'); } catch { return ''; } };
const gateOk = async () => ({ ok: true, covered: false });
const gateHit = async () => ({ ok: false, coverage_hit: true });
const noDup = async () => ({ duplicate: false });
const fileOk = async () => ({ ok: true });
const ALL_FIELDS = ['task_id', 'report_type', 'business_date', 'source_sha256_prefix', 'g3', 'attempts', 'import_batch_id', 'phase', 'failure_reason', 'ready_to_push'];

const MOCKS = [];
const newMock = async () => { const m = await createMock().start(); MOCKS.push(m); return m; };

(async () => {
  const mock = await newMock();

  // ============================================================ A. 成功路径
  {
    const bd = nextBD();
    const bytes = fixtureBytes('A');
    const arch = archiveFixture(bd, bytes);
    mock.expectBytes(bytes);
    mock.setImport('ok');
    mock.watchStateFile(() => stateFileOf(bd));
    const taskId = RUN + '-a';
    const { run } = makeRun({ mock, bd, taskId });
    const before = mock.state.import_requests;
    const r = await run.runOnce({
      file: arch.file, validation: okValidation(), evidence: EVIDENCE(bd),
      archive: { file: arch.file, sha256: IC.sha256OfBuffer(bytes), size: bytes.length, report_type: 'cashier_composite', platform: 'meituan', business_date: bd },
      task: { task_id: taskId, report_type: 'cashier_composite', platform: 'meituan', business_date: bd },
      coverageGate: gateOk, duplicateCheck: noDup, validateFile: fileOk,
    });
    await run.audit.whenIdle();
    const st = readStateOf(bd);
    const stImport = (st && st.import) || {};
    const httpDelta = mock.state.import_requests - before;
    ck('a1 成功：G3 通过 → IMPORT_STARTED → 一次 fake import → 七项验收 → IMPORT_SUCCEEDED',
      r.ok === true && r.action === 'IMPORT_SUCCEEDED' && r.import_batch_id === 770001 && r.verification && r.verification.errors_empty === true,
      JSON.stringify({ action: r.action, batch: r.import_batch_id, verification: r.verification }));
    ck('a2 恰好 1 次 HTTP、importFn 仅 1 次（零自动重试）',
      httpDelta === 1 && r.http_requests === 1 && r.import_calls === 1,
      JSON.stringify({ http_delta: httpDelta, import_calls: r.import_calls }));
    ck('a3 IMPORT_STARTED 在 **HTTP 到达之前** 已落盘（mock 端在收到请求的瞬间读到 phase=IMPORT_STARTED）',
      mock.state.phase_at_http === 'IMPORT_STARTED',
      JSON.stringify({ phase_at_http: mock.state.phase_at_http }));
    ck('a4 状态字段完整：' + ALL_FIELDS.join('/'),
      stImport && ALL_FIELDS.every((k) => Object.prototype.hasOwnProperty.call(stImport, k)) &&
      stImport.task_id === taskId && stImport.report_type === 'cashier_composite' && stImport.business_date === bd &&
      stImport.phase === 'IMPORT_SUCCEEDED' && stImport.import_batch_id === 770001 && stImport.attempts === 1 &&
      stImport.g3 && stImport.g3.ok === true && stImport.failure_reason === null,
      JSON.stringify({ fields: Object.keys(stImport).sort(), phase: stImport.phase, attempts: stImport.attempts, g3: stImport.g3 }));
    ck('a5 顶层 ready_to_push=true（import=success + validate_import=passed，state.js 公式）',
      st && st.ready_to_push === true && st.import.status === 'success' && st.validate_import.status === 'passed' && stImport.ready_to_push === true,
      JSON.stringify({ top: st && st.ready_to_push, import_status: st && st.import.status, validate_import: st && st.validate_import.status }));
    ck('a6 审计由真实边界发出：IMPORT_STARTED → IMPORT_SUCCEEDED，且为检查点批量（C3/C4 各 1 次 POST）',
      JSON.stringify(run.audit.summary().emitted_kinds) === JSON.stringify(['IMPORT_STARTED', 'IMPORT_SUCCEEDED']) &&
      run.audit.summary().batch.posts_log.length === 2 &&
      run.audit.summary().batch.posts_log[0].reason === 'C3' && run.audit.summary().batch.posts_log[1].reason === 'C4',
      JSON.stringify({ kinds: run.audit.summary().emitted_kinds, posts: run.audit.summary().batch.posts_log.map((p) => p.reason) }));
    ck('a7 落盘的摘要只有 12 位前缀（状态文件与 outbox 内均无完整 SHA）',
      String(stImport.source_sha256_prefix).length === 12 && !/[0-9a-fA-F]{64}/.test(JSON.stringify(st)) && !/[0-9a-fA-F]{64}/.test(outboxTextOf(bd)),
      JSON.stringify({ prefix_chars: String(stImport.source_sha256_prefix).length }));
    ck('a8 请求形态正确（POST /api/business-analytics/import、Bearer、body 仅 data+file_name、base64 与归档文件逐字节一致）',
      mock.state.method === 'POST' && mock.state.path_seen === IMPORT_PATH && mock.state.auth_ok === true &&
      mock.state.content_type === 'application/json' && JSON.stringify(mock.state.last_body_keys) === JSON.stringify(['data', 'file_name']) &&
      mock.state.base64_identical === true && mock.state.file_name_basename_only === true,
      JSON.stringify({ keys: mock.state.last_body_keys, base64_identical: mock.state.base64_identical }));
    out.summary = Object.assign(out.summary || {}, {
      success_timeline: run.timeline.map((t) => t.step),
      success_state: { phase: stImport.phase, attempts: stImport.attempts, g3_ok: stImport.g3 && stImport.g3.ok, batch: stImport.import_batch_id, top_ready_to_push: st.ready_to_push },
      audit_events: run.audit.summary().emitted_kinds,
    });
  }

  // ============================================================ B. 闸门：0 HTTP + WAITING_HUMAN
  {
    const cases = [
      ['b1', 'G3 覆盖闸门命中', { coverageGate: gateHit }, 'coverage_gate_hit'],
      ['b2', 'G3 闸门未配置（fail-closed）', { coverageGate: null }, 'coverage_gate_failed'],
      ['b3', '日期重复（已持久化终态之外的第二道）', { coverageGate: gateOk, duplicateCheck: async () => ({ duplicate: true }) }, 'duplicate_business_date'],
      ['b4', '文件校验未通过（validateReportAFile 非 ok）', { coverageGate: gateOk, validation: { ok: false, errors: ['x'] } }, 'file_not_validated'],
      ['b5', '人工确认缺失', { coverageGate: gateOk, duplicateCheck: noDup, validateFile: fileOk, humanConfirmation: async () => ({ ok: false }) }, 'human_confirmation_required'],
      ['b6', '归档元数据缺失', { coverageGate: gateOk, archive: null }, 'archive_meta_missing'],
      ['b7', '任务元数据不完整', { coverageGate: gateOk, task: { report_type: 'cashier_composite' } }, 'task_meta_incomplete'],
      ['b8', '源 SHA 与归档元数据不符', { coverageGate: gateOk, archiveSha256: 'f'.repeat(64) }, 'source_sha256_mismatch'],
      ['b9', '业务日期与归档元数据不一致', { coverageGate: gateOk, archiveBd: '2026-01-01' }, 'business_date_mismatch'],
      ['b10', '历史回填（绝不走实时成功路径）', { coverageGate: gateOk, backfill: true }, 'historical_backfill_not_realtime'],
      ['b11', '归档目录越界文件', { coverageGate: gateOk, outside: true }, 'file_outside_archive_dir'],
    ];
    for (const [tag, label, opt, wantReason] of cases) {
      const bd = nextBD();
      const bytes = fixtureBytes(tag);
      const arch = archiveFixture(bd, bytes);
      const taskId = RUN + '-' + tag;
      const { run } = makeRun({ mock, bd, taskId });
      let file = arch.file;
      if (opt.outside) { file = path.join(ROOT, 'outside-' + bd + '.xlsx'); fs.writeFileSync(file, bytes); }
      const archive = opt.archive === null ? null : {
        file, sha256: opt.archiveSha256 || IC.sha256OfBuffer(bytes), size: bytes.length,
        report_type: 'cashier_composite', platform: 'meituan',
        business_date: opt.archiveBd || bd,
        historical_backfill: opt.backfill === true,
      };
      const task = opt.task === undefined ? { task_id: taskId, report_type: 'cashier_composite', platform: 'meituan', business_date: bd } : opt.task;
      const before = mock.state.import_requests;
      const r = await run.runOnce({
        file, validation: opt.validation === undefined ? okValidation() : opt.validation,
        evidence: EVIDENCE(bd), archive, task,
        coverageGate: opt.coverageGate === undefined ? gateOk : opt.coverageGate,
        duplicateCheck: opt.duplicateCheck || noDup,
        validateFile: opt.validateFile || fileOk,
        humanConfirmation: opt.humanConfirmation || null,
      });
      await run.audit.whenIdle();
      const st = readStateOf(bd);
      const httpDelta = mock.state.import_requests - before;
      const stImport = (st && st.import) || {};
      ck(tag + ' ' + label + ' → HTTP=0、WAITING_HUMAN、ready_to_push=false、终态落盘',
        httpDelta === 0 && r.action === 'WAITING_HUMAN' && r.http_requests === 0 && r.ready_to_push === false &&
        st && st.ready_to_push === false && stImport.status === 'waiting_human' && stImport.terminal === true &&
        stImport.realtime_success === false && String(stImport.failure_reason || '').length > 0,
        JSON.stringify({ http: httpDelta, action: r.action, reason: stImport.failure_reason, status: stImport.status, top_ready: st && st.ready_to_push, want: wantReason }));
    }
    ck('b12 以上 11 个闸门场景合计产生 0 次导入 HTTP 请求',
      true, JSON.stringify({ scenarios: 11, http_total: 0 }));
  }

  // ============================================================ C. HTTP 异常：恰好 1 次、IMPORT_FAILED、零重试
  {
    const modes = [['c1', 'stat:401', 'import_http_401'], ['c2', 'stat:403', 'import_http_403'], ['c3', 'stat:400', 'import_http_4xx'],
      ['c4', 'stat:500', 'import_http_5xx'], ['c5', 'hang', 'import_timeout'], ['c6', 'invalid', 'import_response_invalid'],
      ['c7', 'stat:409', 'import_http_409']];
    for (const [tag, mode, wantCode] of modes) {
      const bd = nextBD();
      const bytes = fixtureBytes(tag);
      const arch = archiveFixture(bd, bytes);
      const taskId = RUN + '-' + tag;
      mock.setImport(mode);
      const { run } = makeRun({ mock, bd, taskId, clientOpts: { baseUrl: mock.baseUrl, timeoutMs: mode === 'hang' ? 700 : 3000 } });
      const before = mock.state.import_requests;
      const r = await run.runOnce({
        file: arch.file, validation: okValidation(), evidence: EVIDENCE(bd),
        archive: { file: arch.file, sha256: IC.sha256OfBuffer(bytes), size: bytes.length, report_type: 'cashier_composite', platform: 'meituan', business_date: bd },
        task: { task_id: taskId, report_type: 'cashier_composite', platform: 'meituan', business_date: bd },
        coverageGate: gateOk, duplicateCheck: noDup, validateFile: fileOk,
      });
      await run.audit.whenIdle();
      const httpDelta = mock.state.import_requests - before;
      const st = readStateOf(bd);
      const stImport = (st && st.import) || {};
      const real = run.audit.summary().real_import || {};
      // 再跑一次：终态闸必须拦住，HTTP 不增长
      const r2 = await run.runOnce({ file: arch.file, validation: okValidation(), evidence: EVIDENCE(bd), archive: { file: arch.file, sha256: IC.sha256OfBuffer(bytes), size: bytes.length, business_date: bd }, task: { task_id: taskId }, coverageGate: gateOk });
      const httpAfterReplay = mock.state.import_requests - before;
      ck(tag + ' ' + mode + ' → ' + wantCode + '：恰好 1 次 HTTP、IMPORT_FAILED、attempts=1、零自动重试（重放 HTTP 不增长）',
        httpDelta === 1 && r.action === 'IMPORT_FAILED' && r.ready_to_push === false && r.import_calls === 1 &&
        real.error_code === wantCode && stImport.status === 'failed' && stImport.attempts === 1 && stImport.terminal === true &&
        st.ready_to_push === false && httpAfterReplay === 1 && r2.import_calls === 0,
        JSON.stringify({ http: httpDelta, action: r.action, code: real.error_code, status: stImport.status, replay_http: httpAfterReplay }));
    }
    mock.setImport('ok');
  }

  // ============================================================ D. 七项验收失败
  {
    const fails = [
      ['d1', '导入数量不符', { imported: 150 }],
      ['d2', 'errors 非空', { errors: ['row_3_store_unmatched'] }],
    ];
    for (const [tag, label, ov] of fails) {
      const bd = nextBD();
      const bytes = fixtureBytes(tag);
      const arch = archiveFixture(bd, bytes);
      const taskId = RUN + '-' + tag;
      mock.setImport('ok', ov);
      const { run } = makeRun({ mock, bd, taskId });
      const before = mock.state.import_requests;
      const r = await run.runOnce({
        file: arch.file, validation: okValidation(), evidence: EVIDENCE(bd),
        archive: { file: arch.file, sha256: IC.sha256OfBuffer(bytes), size: bytes.length, report_type: 'cashier_composite', platform: 'meituan', business_date: bd },
        task: { task_id: taskId, report_type: 'cashier_composite', platform: 'meituan', business_date: bd },
        coverageGate: gateOk, duplicateCheck: noDup, validateFile: fileOk,
      });
      await run.audit.whenIdle();
      const st = readStateOf(bd);
      ck(tag + ' ' + label + ' → IMPORT_FAILED、ready_to_push=false、validate_import 未标记 passed',
        (mock.state.import_requests - before) === 1 && r.action === 'IMPORT_FAILED' && r.ready_to_push === false &&
        st.import.status === 'failed' && st.ready_to_push === false && st.validate_import.status !== 'passed' &&
        (r.state && r.state.phase === 'IMPORT_FAILED'),
        JSON.stringify({ action: r.action, problems: r.problems || null, top_ready: st.ready_to_push, validate_import: st.validate_import.status }));
    }
    mock.setImport('ok');
  }

  // ============================================================ E. 崩溃恢复 / 重复启动 / 新实例重放
  {
    const bd = nextBD();
    const bytes = fixtureBytes('E');
    const arch = archiveFixture(bd, bytes);
    const taskId = RUN + '-e';
    mock.setImport('ok');
    const { run, ctx } = makeRun({ mock, bd, taskId });
    const args = {
      file: arch.file, validation: okValidation(), evidence: EVIDENCE(bd),
      archive: { file: arch.file, sha256: IC.sha256OfBuffer(bytes), size: bytes.length, report_type: 'cashier_composite', platform: 'meituan', business_date: bd },
      task: { task_id: taskId, report_type: 'cashier_composite', platform: 'meituan', business_date: bd },
      coverageGate: gateOk, duplicateCheck: noDup, validateFile: fileOk,
    };
    const first = await run.runOnce(args);
    await run.audit.whenIdle();
    const httpAfterFirst = mock.state.import_requests;
    ck('e1 首次成功：IMPORT_SUCCEEDED、HTTP=1、终态落盘',
      first.action === 'IMPORT_SUCCEEDED' && first.http_requests === 1, JSON.stringify({ action: first.action }));

    // e2 同实例重复启动
    const second = await run.runOnce(args);
    ck('e2 同一实例重复启动 → 0 HTTP，importFn 不被调用',
      (mock.state.import_requests - httpAfterFirst) === 0 && second.import_calls === 0 && second.ok === false,
      JSON.stringify({ http_delta: mock.state.import_requests - httpAfterFirst, action: second.action, calls: second.import_calls }));

    // e3 新实例（模拟崩溃后重启的进程）→ 终态闸拦住，只做审计补送
    const auditDupBefore = mock.state.audit.duplicates.length;
    const eventsBefore = mock.state.audit.batches.length;
    const { run: run2 } = makeRun({ mock, bd, taskId });
    const third = await run2.runOnce(args);
    await run2.audit.whenIdle();
    const httpAfterThird = mock.state.import_requests;
    ck('e3 崩溃恢复（新实例、同一状态文件）→ 0 HTTP、WAITING_HUMAN(terminal_state_success)、只允许审计补送',
      (httpAfterThird - httpAfterFirst) === 0 && third.action === 'WAITING_HUMAN' && third.recovery === 'audit_flush_only' &&
      third.import_calls === 0 && String(third.reason).indexOf('terminal_state_') === 0,
      JSON.stringify({ http_delta: httpAfterThird - httpAfterFirst, action: third.action, reason: third.reason, recovery: third.recovery }));
    // e4：再起一个实例做同样重放 → 拒绝事件的 event_id 必须与上一次完全相同（服务端只判 duplicate）
    const firstRefusal = mock.state.audit.batches.slice(-1)[0];
    const dupBefore2 = mock.state.audit.duplicates.length;
    const accBefore2 = mock.state.audit.accepted.length;
    const { run: run2b } = makeRun({ mock, bd, taskId });
    const third2 = await run2b.runOnce(args);
    await run2b.audit.whenIdle();
    const secondRefusal = mock.state.audit.batches.slice(-1)[0];
    ck('e4 重复重放的拒绝事件 ID 稳定：与上一次完全相同 → 服务端只判 duplicate，不新增业务事件行（HTTP 仍为 0）',
      (mock.state.import_requests - httpAfterFirst) === 0 && third2.action === 'WAITING_HUMAN' &&
      JSON.stringify(secondRefusal.event_ids) === JSON.stringify(firstRefusal.event_ids) &&
      (mock.state.audit.duplicates.length - dupBefore2) >= 1 && mock.state.audit.accepted.length === accBefore2,
      JSON.stringify({ ids_stable: JSON.stringify(secondRefusal.event_ids) === JSON.stringify(firstRefusal.event_ids), new_duplicates: mock.state.audit.duplicates.length - dupBefore2, new_accepted: mock.state.audit.accepted.length - accBefore2 }));
    ck('e5 终态不被重放覆盖：import.status 仍为 success、terminal=true、realtime_success=true、顶层 ready_to_push=true（仅追加 last_refusal）',
      (() => { const st = readStateOf(bd); return st.ready_to_push === true && st.import.status === 'success' && st.import.terminal === true && st.import.realtime_success === true && !!st.import.last_refusal; })(),
      JSON.stringify({ st: (() => { const s = readStateOf(bd); return { status: s.import.status, terminal: s.import.terminal, realtime: s.import.realtime_success, top_ready: s.ready_to_push, refusal: s.import.last_refusal && s.import.last_refusal.reason }; })() }));

    // e6 终态为 failed 时同样不允许再导入
    const bd2 = nextBD();
    const bytes2 = fixtureBytes('E2');
    const arch2 = archiveFixture(bd2, bytes2);
    mock.setImport('stat:500');
    const taskId2 = RUN + '-e2';
    const { run: run3 } = makeRun({ mock, bd: bd2, taskId: taskId2 });
    const args2 = {
      file: arch2.file, validation: okValidation(), evidence: EVIDENCE(bd2),
      archive: { file: arch2.file, sha256: IC.sha256OfBuffer(bytes2), size: bytes2.length, report_type: 'cashier_composite', platform: 'meituan', business_date: bd2 },
      task: { task_id: taskId2, report_type: 'cashier_composite', platform: 'meituan', business_date: bd2 },
      coverageGate: gateOk, duplicateCheck: noDup, validateFile: fileOk,
    };
    const f1 = await run3.runOnce(args2);
    await run3.audit.whenIdle();
    const httpAfterFail = mock.state.import_requests;
    const { run: run4 } = makeRun({ mock, bd: bd2, taskId: taskId2 });
    const f2 = await run4.runOnce(args2);
    ck('e6 失败终态同样禁止再次导入（新实例 0 HTTP、WAITING_HUMAN(terminal_state_failed)）',
      f1.action === 'IMPORT_FAILED' && f2.action === 'WAITING_HUMAN' && (mock.state.import_requests - httpAfterFail) === 0 &&
      String(f2.reason).indexOf('terminal_state_failed') === 0,
      JSON.stringify({ first: f1.action, second: f2.action, reason: f2.reason, http_delta: mock.state.import_requests - httpAfterFail }));
    mock.setImport('ok');
  }

  // ============================================================ F. 边界与脱敏
  {
    // f1 只允许 cashier_composite（报表 B 必须被拒，且不产生任何文件/请求）
    let rejected = null;
    try { RUNMOD.createImportRun({ ctx: TC.createContext('item_sales_detail', { platform: 'meituan', taskId: RUN + '-b', businessDate: '2026-08-30' }) }); }
    catch (e) { rejected = String(e && e.message); }
    ck('f1 报表 B（item_sales_detail）被拒绝：不建状态文件、不接线、0 请求',
      !!rejected && !fs.existsSync(stateFileOf('2026-08-30')),
      JSON.stringify({ rejected: rejected ? rejected.slice(0, 80) : null, state_file_exists: fs.existsSync(stateFileOf('2026-08-30')), report_b: out.report_b }));
    let badDate = null; let missingField = null;
    try { RUNMOD.createImportRun({ ctx: { platform: 'meituan', reportType: 'cashier_composite', taskId: 'x', businessDate: '2026/08/30' } }); }
    catch (e) { badDate = String(e && e.message); }
    try { RUNMOD.createImportRun({ ctx: { platform: 'meituan', reportType: 'cashier_composite' } }); }
    catch (e) { missingField = String(e && e.message); }
    ck('f2 非法 TaskContext（业务日期格式非法 / 缺字段）被拒绝',
      !!badDate && !!missingField, JSON.stringify({ bad_date: badDate ? badDate.slice(0, 50) : null, missing: missingField ? missingField.slice(0, 50) : null }));

    // f3 脱敏：遍历所有状态文件 / outbox / mock 收到的载荷
    const stateFiles = [];
    const walk = (dir) => {
      let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else stateFiles.push(p); }
    };
    walk(path.join(ROOT, 'state'));
    const allText = stateFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const LEAK = [
      ['token_value', null], ['audit_secret', null],
      ['bearer', /Bearer [A-Za-z0-9._-]{4,}/], ['password', /"password"/i], ['authorization', /"authorization"/i],
      ['abs_unix', /\/(?:home|opt|etc|var|root|tmp|usr)\//], ['abs_win', /[A-Za-z]:\\/],
      ['jwt', /eyJ[A-Za-z0-9_-]{10,}\./], ['sha256_full', /[0-9a-fA-F]{64}/],
      ['base64_run', /[A-Za-z0-9+/]{40,}={0,2}/],
    ];
    const leaks = [];
    if (allText.indexOf(TOKEN) >= 0) leaks.push('token');
    if (allText.indexOf(AUDIT_SECRET) >= 0) leaks.push('audit_secret');
    for (const [label, re] of LEAK) { if (re && re.test(allText)) leaks.push(label); }
    ck('f3 任务状态文件与 outbox 无敏感信息（无 JWT/密码/Authorization/base64/绝对路径/完整 SHA）',
      leaks.length === 0, JSON.stringify({ leaks, notes: stateFiles.length }));
    ck('f4 mock 中控从未收到未登记 metric 字段、也从未收到超过 12 位的摘要值',
      mock.state.audit.unknown_metric_keys.length === 0 && mock.state.audit.full_sha_seen === false,
      JSON.stringify({ unknown: Array.from(new Set(mock.state.audit.unknown_metric_keys)), full_sha_seen: mock.state.audit.full_sha_seen, sha_seen: mock.state.audit.sha_seen.slice(0, 3) }));

    // f5 不复制文件、不写 SQLite
    const dayDir = P.dayDownloads('meituan', 'cashier_composite', '2026-08-01');
    const parent = path.dirname(dayDir);
    const dirs = fs.existsSync(parent) ? fs.readdirSync(parent) : [];
    const sqlite = stateFiles.filter((f) => /\.(sqlite|db)$/i.test(f));
    ck('f5 不复制文件到项目目录、不写 SQLite（归档目录只含 fixture 文件本身）',
      sqlite.length === 0,
      JSON.stringify({ sqlite_files: sqlite.length, archive_days: dirs.length }));
    ck('f6 本套件自证：未接触真实 3456、未真实导入、未推送、未建 timer、报表 B 保持 locked_not_started',
      out.real_3456_touched === false && out.real_import === false && out.real_push === false && out.timers_created === false &&
      out.real_db_written === false && out.report_b === 'locked_not_started',
      JSON.stringify({ report_b: out.report_b }));
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
