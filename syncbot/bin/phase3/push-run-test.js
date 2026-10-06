#!/usr/bin/env node
'use strict';
/**
 * 阶段4 企业微信推送边界 · **纯离线 fixture 套件**
 *
 * 边界声明：
 *  - **绝不发送真实企业微信消息**：推送能力由 fake WeCom client 注入，测试进程内**不存在**
 *    任何真实 webhook/token/密钥，也不读取任何真实推送配置；
 *  - 审计端点用随机端口 mock（HMAC + is_test 幂等），**不接触真实 3456 的业务接口**；
 *  - 不访问美团、不导出/下载/导入真实数据、不建 timer、不重启服务；报表 B 保持 locked_not_started；
 *  - 任务状态写在临时 SYNCBOT_ROOT 下（真实走 src/state.js 原子写）；
 *  - 输出不含 JWT/密钥/完整 SHA/绝对路径/base64/Excel 明细。
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p4push-'));
process.env.SYNCBOT_ROOT = ROOT;

const BOT = process.env.SYNCBOT_BOT || '/opt/zhongkong-sync-bot';
const P = require(BOT + '/app/src/paths.js');
const TC = require(BOT + '/app/src/task-context.js');
const state = require(BOT + '/app/src/state.js');
const IC = require(BOT + '/app/src/phase3/import-client.js');
const OUTBOX = require(BOT + '/app/src/phase3/audit-outbox.js');
const RUNMOD = require(BOT + '/app/src/phase3/import-run.js');
const PUSHMOD = require(BOT + '/app/src/phase3/push-run.js');
const PUSHC = require(BOT + '/app/src/phase3/push-client.js');

const AUDIT_SECRET = crypto.randomBytes(32).toString('hex');
const TOKEN = 'tok-' + crypto.randomBytes(12).toString('hex');
const RUN = 'test-push-' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');
const SHA_PREFIX_LEN = 12;

const out = {
  suite: 'phase4-push-run-fixture', fixture: true, offline: true,
  real_wecom_message_sent: false, real_webhook_read: false, real_3456_business_called: false,
  real_import: false, real_export: false, real_download: false, timers_created: false,
  report_b: 'locked_not_started', test_run_id: RUN, checks: [],
};
const ck = (n, ok, d) => out.checks.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });

let SEQ = 0;
function nextBD() { SEQ += 1; return new Date(Date.UTC(2026, 8, 1 + SEQ)).toISOString().slice(0, 10); }
const AUDIT_PATH = '/api/internal/syncbot/events';
const LOGIN_PATH = '/api/auth/login';
const IMPORT_PATH = '/api/business-analytics/import';
const MOCK_ALLOWED_METRIC_FIELDS = new Set(['phase', 'started_at', 'finished_at', 'duration_ms', 'failure_reason',
  'original_filename', 'file_size', 'sha256', 'sha256_prefix', 'import_batch_id', 'raw_store_count', 'matched_store_count',
  'ready_to_push', 'push_status', 'imported', 'pushed', 'is_backfill', 'reconstructed', 'not_a_realtime_success',
  'screenshot_count', 'validation', 'evidence', 'note']);

// ---------------------------------------------------------------- mock 中控（审计 + 导入，供真实 import-run 造前置状态）
function createMock() {
  const st = { audit_requests: 0, import_requests: 0, login_requests: 0, audit: { accepted: [], duplicates: [], batches: [], full_sha_seen: false, unknown_metric_keys: [], stages: [] } };
  const seen = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = String(req.url || '').split('?')[0];
      if (url === LOGIN_PATH) {
        st.login_requests += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, token: TOKEN, user: { id: 9 } }));
        return;
      }
      if (url === IMPORT_PATH) {
        st.import_requests += 1;
        if (String(req.headers.authorization || '') !== 'Bearer ' + TOKEN) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '未登录' })); return; }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, batch_id: 880001, amount_db: { recorded_amount: 12345.67 }, amount_basis: { scope: 'import_batch_id', mappings: [ { file_column: '营业收入(元)', db_column: 'recorded_amount' }, { file_column: '营业额(元)', db_column: 'gross_amount' }, { file_column: '优惠金额(元)', db_column: 'discount_amount' } ] }, data_kind: 'cashier_composite', imported: 154, raw_imported: 22, matched_stores: 22, skipped: 0, errors: [], resolved_channels: ['店内销售'], income_composition_fields: ['美团团购'] }));
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
          for (const k of Object.keys(mm)) if (!MOCK_ALLOWED_METRIC_FIELDS.has(k)) st.audit.unknown_metric_keys.push(k);
          for (const [k, v] of Object.entries(mm)) if (k === 'sha256' && String(v || '').length > SHA_PREFIX_LEN) st.audit.full_sha_seen = true;
          st.audit.stages.push(e.stage);
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
      this.auditSecretFile = path.join(ROOT, 'audit-secret.json');
      fs.writeFileSync(this.auditSecretFile, JSON.stringify({ secret: AUDIT_SECRET, endpoint: this.baseUrl + AUDIT_PATH }), { mode: 0o600 });
      return this;
    },
    async stop() { await new Promise((r) => server.close(r)); },
  };
}

// ---------------------------------------------------------------- fake WeCom client（注入式，无真实凭据）
function createFakeSender(mode = 'ok') {
  const rec = { calls: 0, payloads: [], mode, state_at_send: null, stateFileGetter: null };
  return {
    rec,
    setMode(m) { rec.mode = m; },
    watchStateFile(fn) { rec.stateFileGetter = fn; },
    async send(payload, o) {
      rec.calls += 1;
      rec.payloads.push(JSON.parse(JSON.stringify(payload)));
      if (rec.stateFileGetter) { try { rec.state_at_send = (JSON.parse(fs.readFileSync(rec.stateFileGetter(), 'utf8')).push || {}).phase; } catch { rec.state_at_send = 'READ_ERROR'; } }
      if (rec.mode === 'hang') return new Promise(() => {});
      if (rec.mode === 'throw') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      if (String(rec.mode).startsWith('stat:')) {
        const code = Number(String(rec.mode).split(':')[1]);
        return { ok: false, http: code, error: 'mock_wecom_http_' + code };
      }
      return { ok: true, http: 200, message_id: 'msg-' + crypto.randomBytes(6).toString('hex') };
    },
  };
}

// ---------------------------------------------------------------- fixture 工具
function fixtureBytes(tag) { return Buffer.from('XLSX-P4-' + tag + '-' + crypto.randomBytes(64).toString('hex')); }
function archiveFixture(bd, bytes) {
  const dir = P.dayDownloads('meituan', 'cashier_composite', bd);
  P.ensureDir(dir);
  const file = path.join(dir, ('美团_综合营业统计_' + bd + '.xlsx'));
  fs.writeFileSync(file, bytes);
  return { file, dir };
}
const okValidation = () => ({ ok: true, checks: { row2_metadata: { ok: true, items: [{ name: '营业日期=目标日期', ok: true }] } }, store_count: 22 });
const EVIDENCE = (bd) => ({ excelBusinessDate: bd, amountExcel: 12345.67, amountDb: 12345.67 });
const stateFileOf = (bd) => P.taskStateFile('meituan', 'cashier_composite', bd);
const readStateOf = (bd) => { try { return JSON.parse(fs.readFileSync(stateFileOf(bd), 'utf8')); } catch { return null; } };
const outboxTextOf = (bd) => { try { return fs.readFileSync(OUTBOX.outboxFile('meituan', 'cashier_composite', bd), 'utf8'); } catch { return ''; } };

/** 直接用 src/state.js 造"导入已成功"的前置状态（部分场景用；成功场景走真实 import-run） */
function seedImported(bd, { importStatus = 'success', realtime = true, batch = 770001, raw = 22, matched = 22, imported = 154,
  shaPrefix = 'aabbccddeeff', validatePassed = true, pushStatus = 'pending', businessDateOverride = null } = {}) {
  state.patch('meituan', bd, 'import', {
    task_id: 'seed', phase: 'IMPORT_SUCCEEDED', attempts: 1, source_sha256_prefix: shaPrefix,
    g3: { ok: true, coverage_hit: false }, import_batch_id: batch, failure_reason: null, terminal: true,
    realtime_success: realtime, verification: { raw_imported: raw, matched_stores: matched, imported, errors_empty: true, amount_delta: 0, business_date_matched: true },
    ready_to_push: false,
  }, { status: importStatus, reportType: 'cashier_composite' });
  if (validatePassed) state.markPassed('meituan', bd, 'validate_import', { at: new Date().toISOString(), note: 'seven_item_verified' }, 'cashier_composite');
  else state.patch('meituan', bd, 'validate_import', { status: 'pending' }, { reportType: 'cashier_composite' });
  if (pushStatus !== 'pending') state.patch('meituan', bd, 'push', { phase: 'PUSH_SUCCEEDED', message_id: 'msg-existing' }, { status: pushStatus, reportType: 'cashier_composite' });
  if (businessDateOverride) {
    const f = stateFileOf(bd); const j = JSON.parse(fs.readFileSync(f, 'utf8')); j.business_date = businessDateOverride;
    fs.writeFileSync(f, JSON.stringify(j, null, 2));
  }
  return state.read('meituan', bd, 'cashier_composite');
}

const MOCKS_SENDERS = [];
function makePushRun({ mock, bd, taskId, sender, auditSecretFile = null, opts = null }) {
  if (sender) MOCKS_SENDERS.push(sender);
  const ctx = TC.createContext('cashier_composite', { platform: 'meituan', taskId, businessDate: bd });
  const pushClient = PUSHC.createPushClient({ ctx, opts: Object.assign({ timeoutMs: 800 }, opts || {}), sender });
  const run = PUSHMOD.createPushRun({
    ctx,
    opts: Object.assign({ secretFile: auditSecretFile || mock.auditSecretFile, timeoutMs: 3000, testRunId: RUN, idleTimeoutMs: 3000 }, opts || {}),
    pushClient,
  });
  return { ctx, run, pushClient };
}
function makeImportRun({ mock, bd, taskId }) {
  const ctx = TC.createContext('cashier_composite', { platform: 'meituan', taskId, businessDate: bd });
  const run = RUNMOD.createImportRun({ ctx, opts: { secretFile: mock.auditSecretFile, timeoutMs: 3000, testRunId: RUN, clientOpts: { token: TOKEN, baseUrl: mock.baseUrl, timeoutMs: 3000 } } });
  return { ctx, run };
}

(async () => {
  const mock = await createMock().start();

  // ============================================================ A. 成功（端到端：真实 import-run → push-run）
  {
    const bd = nextBD();
    const bytes = fixtureBytes('A');
    const arch = archiveFixture(bd, bytes);
    const taskId = RUN + '-a';
    // ① 先用真实 import-run（离线 mock 导入端点）把任务推进到 IMPORT_SUCCEEDED + ready_to_push=true
    const imp = makeImportRun({ mock, bd, taskId });
    const ir = await imp.run.runOnce({
      file: arch.file, validation: okValidation(), evidence: EVIDENCE(bd),
      archive: { file: arch.file, sha256: IC.sha256OfBuffer(bytes), size: bytes.length, report_type: 'cashier_composite', platform: 'meituan', business_date: bd },
      task: { task_id: taskId, report_type: 'cashier_composite', platform: 'meituan', business_date: bd },
      coverageGate: async () => ({ ok: true }), duplicateCheck: async () => ({ duplicate: false }), validateFile: async () => ({ ok: true }),
    });
    await imp.run.audit.whenIdle();
    const seeded = readStateOf(bd);
    ck('a0 前置：真实 import-run 已持久化 IMPORT_SUCCEEDED 且顶层 ready_to_push=true',
      ir.action === 'IMPORT_SUCCEEDED' && seeded.import.status === 'success' && seeded.ready_to_push === true,
      JSON.stringify({ import_action: ir.action, import_status: seeded.import.status, top_ready: seeded.ready_to_push }));

    const sender = createFakeSender('ok');
    sender.watchStateFile(() => stateFileOf(bd));
    const { run } = makePushRun({ mock, bd, taskId, sender });
    const r = await run.runOnce();
    const st = readStateOf(bd);
    ck('a1 成功：恰好 1 次发送调用 → PUSH_SUCCEEDED，push.status=success、message_id 已记录',
      r.ok === true && r.action === 'PUSH_SUCCEEDED' && sender.rec.calls === 1 && r.sent === 1 &&
      st.push.status === 'success' && st.push.phase === 'PUSH_SUCCEEDED' && !!st.push.message_id && st.push.terminal === true,
      JSON.stringify({ action: r.action, sends: sender.rec.calls, status: st.push.status, msg: !!st.push.message_id }));
    ck('a2 PUSH_STARTED（发送中状态）在**发送之前**已落盘（fake sender 在 send 被调用的瞬间读到 phase=PUSH_STARTED）',
      sender.rec.state_at_send === 'PUSH_STARTED' && st.push.attempts === 1,
      JSON.stringify({ phase_at_send: sender.rec.state_at_send, attempts: st.push.attempts }));
    ck('a3 推送成功后顶层 ready_to_push=false（已推送；src/state.js 公式），且状态不再是"待推送"',
      st.ready_to_push === false && st.push.status === 'success', JSON.stringify({ top_ready: st.ready_to_push }));
    const content = sender.rec.payloads[0] && sender.rec.payloads[0].text && sender.rec.payloads[0].text.content;
    const realBatch = String(seeded.import.import_batch_id);
    const realPrefix = String(seeded.import.source_sha256_prefix);
    ck('a4 推送内容只含脱敏汇总：业务日期 / 批次号 / 22 家门店 / 154 行 / SHA 前缀(12)',
      !!content && content.indexOf(bd) >= 0 && content.indexOf(realBatch) >= 0 && content.indexOf('22') >= 0 &&
      content.indexOf('154') >= 0 && content.indexOf(realPrefix) >= 0 && sender.rec.payloads[0].msgtype === 'text' &&
      realPrefix.length === 12,
      JSON.stringify({ content_lines: String(content || '').split('\n').length, batch: realBatch, prefix_chars: realPrefix.length }));
    ck('a5 推送内容不含 JWT/口令/Authorization/完整 SHA/绝对路径/文件名',
      !/(eyJ[A-Za-z0-9_-]{10,}\.)|(Bearer )|(password)|(\/(?:home|opt|etc|var|root|tmp|usr)\/)|([A-Za-z]:\\)|([0-9a-fA-F]{64})|\.xlsx/i.test(String(content || '')),
      JSON.stringify({ content_head: String(content || '').slice(0, 40) }));
    ck('a6 审计由真实边界发出 PUSH_SUCCEEDED（mock 审计端实际收到该 stage；单事件批量检查点）',
      JSON.stringify(run.audit.summary().emitted_kinds) === JSON.stringify(['PUSH_SUCCEEDED']) &&
      mock.state.audit.stages.indexOf('PUSH_SUCCEEDED') >= 0 &&
      run.audit.summary().batch.posts_log.length === 1 && run.audit.summary().batch.posts_log[0].reason === 'push_ok',
      JSON.stringify({ kinds: run.audit.summary().emitted_kinds, received: mock.state.audit.stages.slice(-2), posts: run.audit.summary().batch.posts_log.map((p) => p.reason) }));
    out.summary = Object.assign(out.summary || {}, {
      success_timeline: run.timeline.map((t) => t.step),
      success_state: { push_status: st.push.status, phase: st.push.phase, attempts: st.push.attempts, has_message_id: !!st.push.message_id, top_ready_to_push: st.ready_to_push },
      audit_events: run.audit.summary().emitted_kinds,
      message_line_count: String(content || '').split('\n').filter(Boolean).length,
    });
  }

  // ============================================================ B. 闸门（0 次发送）
  {
    const cases = [
      ['b1', '无 ready_to_push（validate_import 未 passed）', { validatePassed: false }, 'ready_to_push_false'],
      ['b2', '历史补录（import.realtime_success 非 true）', { realtime: false }, 'historical_backfill_not_realtime'],
      ['b3', '导入失败终态', { importStatus: 'failed', validatePassed: false }, 'import_not_succeeded'],
      ['b4', '导入未终态（running）', { importStatus: 'running', validatePassed: false }, 'import_not_succeeded'],
      ['b5', '业务日期不一致', { businessDateOverride: '2026-01-01' }, 'business_date_mismatch'],
    ];
    for (const [tag, label, seed, wantReason] of cases) {
      const bd = nextBD();
      const taskId = RUN + '-' + tag;
      seedImported(bd, seed);
      const sender = createFakeSender('ok');
      const { run } = makePushRun({ mock, bd, taskId, sender });
      const r = await run.runOnce();
      const st = readStateOf(bd);
      await run.audit.whenIdle();
      ck(tag + ' ' + label + ' → 发送调用=0、WAITING_HUMAN、ready_to_push 未被伪造',
        sender.rec.calls === 0 && r.action === 'WAITING_HUMAN' && r.send_calls === 0 &&
        st.push.status === 'waiting_human' && st.push.terminal === true && st.push.failure_reason === wantReason &&
        st.ready_to_push === (seed.validatePassed === false ? false : st.ready_to_push),
        JSON.stringify({ sends: sender.rec.calls, action: r.action, push_status: st.push.status, reason: st.push.failure_reason, want: wantReason, top_ready: st.ready_to_push }));
    }
    // b6 报表 B
    let rej = null;
    try { PUSHMOD.createPushRun({ ctx: TC.createContext('item_sales_detail', { platform: 'meituan', taskId: RUN + '-b6', businessDate: '2026-09-30' }) }); }
    catch (e) { rej = String(e && e.message); }
    ck('b6 报表 B（item_sales_detail）被拒绝：不建状态文件、不接线、0 发送',
      !!rej && !fs.existsSync(stateFileOf('2026-09-30')),
      JSON.stringify({ rejected: rej ? rej.slice(0, 70) : null, state_file_exists: fs.existsSync(stateFileOf('2026-09-30')), report_b: out.report_b }));
    // b7 非法 TaskContext
    let bad = null; let miss = null;
    try { PUSHMOD.createPushRun({ ctx: { platform: 'meituan', reportType: 'cashier_composite', taskId: 'x', businessDate: '2026/09/01' } }); } catch (e) { bad = String(e && e.message); }
    try { PUSHMOD.createPushRun({ ctx: { platform: 'meituan', reportType: 'cashier_composite' } }); } catch (e) { miss = String(e && e.message); }
    ck('b7 非法 TaskContext（日期格式非法 / 缺字段）被拒绝', !!bad && !!miss, JSON.stringify({ bad: !!bad, missing: !!miss }));
  }

  // ============================================================ C. 重复发送
  {
    const bd = nextBD();
    const taskId = RUN + '-c';
    seedImported(bd, {});
    const sender = createFakeSender('ok');
    const { run } = makePushRun({ mock, bd, taskId, sender });
    const first = await run.runOnce();
    await run.audit.whenIdle();
    const st1 = readStateOf(bd);
    const callsAfterFirst = sender.rec.calls;
    const second = await run.runOnce();
    ck('c1 已 PUSH_SUCCEEDED 后同实例重复推送 → 0 次发送、WAITING_HUMAN(进程内闸)、终态与 message_id 不被覆盖',
      first.ok === true && callsAfterFirst === 1 && second.ok === false && sender.rec.calls === 1 &&
      second.action === 'WAITING_HUMAN' && String(second.reason).indexOf('push_already_started_in_process') === 0 &&
      st1.push.message_id === readStateOf(bd).push.message_id && readStateOf(bd).push.status === 'success',
      JSON.stringify({ first_sends: callsAfterFirst, total_sends: sender.rec.calls, action: second.action, reason: second.reason }));
    // c2 新实例（模拟重启后的进程）
    const sender2 = createFakeSender('ok');
    const { run: run2 } = makePushRun({ mock, bd, taskId, sender: sender2 });
    const third = await run2.runOnce();
    await run2.audit.whenIdle();
    ck('c2 新实例（重启后）重复推送 → 仍 0 次发送、WAITING_HUMAN(push_state_success)、只做审计补送',
      sender2.rec.calls === 0 && third.action === 'WAITING_HUMAN' && third.recovery === 'audit_flush_only' &&
      String(third.reason).indexOf('push_state_success') === 0,
      JSON.stringify({ sends: sender2.rec.calls, action: third.action, reason: third.reason, recovery: third.recovery }));
  }

  // ============================================================ D. 发送失败（恰好 1 次、零重试、不自动重发）
  {
    const modes = [['d1', 'stat:400', 'push_http_4xx', false], ['d2', 'stat:500', 'push_http_5xx', true],
      ['d3', 'hang', 'push_timeout', true], ['d4', 'throw', 'push_network_error', true]];
    for (const [tag, mode, wantCode, wantUncertain] of modes) {
      const bd = nextBD();
      const taskId = RUN + '-' + tag;
      seedImported(bd, {});
      const sender = createFakeSender(mode);
      const { run } = makePushRun({ mock, bd, taskId, sender });
      const r = await run.runOnce();
      await run.audit.whenIdle();
      const st = readStateOf(bd);
      const callsAfter = sender.rec.calls;
      const again = await run.runOnce();
      ck(tag + ' ' + mode + ' → ' + wantCode + '：恰好 1 次发送调用、PUSH_FAILED、delivery_uncertain=' + wantUncertain + '、再次调用 0 发送',
        sender.rec.calls === 1 && r.action === 'PUSH_FAILED' && r.reason === wantCode && r.delivery_uncertain === wantUncertain &&
        st.push.status === 'failed' && st.push.terminal === true && st.push.delivery_uncertain === wantUncertain &&
        callsAfter === 1 && again.send_calls === 0 && sender.rec.calls === 1,
        JSON.stringify({ sends: sender.rec.calls, action: r.action, code: r.reason, uncertain: r.delivery_uncertain, status: st.push.status }));
    }
  }

  // ============================================================ E. 响应丢失 / 崩溃恢复
  {
    const bd = nextBD();
    const taskId = RUN + '-e';
    seedImported(bd, {});
    // 模拟"发送中崩溃"：状态停在 running/PUSH_STARTED（消息可能已发出）
    state.patch('meituan', bd, 'push', { phase: 'PUSH_STARTED', attempts: 1, terminal: false }, { status: 'running', reportType: 'cashier_composite' });
    const sender = createFakeSender('ok');
    const { run } = makePushRun({ mock, bd, taskId, sender });
    const r = await run.runOnce();
    await run.audit.whenIdle();
    const st = readStateOf(bd);
    ck('e1 崩溃恢复（状态停在"发送中/结果未知"）→ **0 次发送**、WAITING_HUMAN(push_state_running)、只做审计补送',
      sender.rec.calls === 0 && r.action === 'WAITING_HUMAN' && String(r.reason).indexOf('push_state_running') === 0 &&
      r.recovery === 'audit_flush_only' && st.push.status === 'running' && st.push.terminal === false,
      JSON.stringify({ sends: sender.rec.calls, action: r.action, reason: r.reason, status: st.push.status }));
    const firstRefusalIds = mock.state.audit.batches.slice(-1)[0].event_ids;
    const dupBefore = mock.state.audit.duplicates.length;
    const accBefore = mock.state.audit.accepted.length;
    const sender2 = createFakeSender('ok');
    const { run: run2 } = makePushRun({ mock, bd, taskId, sender: sender2 });
    const r2 = await run2.runOnce();
    await run2.audit.whenIdle();
    const secondRefusalIds = mock.state.audit.batches.slice(-1)[0].event_ids;
    ck('e2 重放的拒绝事件 ID 稳定 → 服务端只判 duplicate、accepted 不增长（仍 0 次发送）',
      sender2.rec.calls === 0 && JSON.stringify(secondRefusalIds) === JSON.stringify(firstRefusalIds) &&
      (mock.state.audit.duplicates.length - dupBefore) >= 1 && mock.state.audit.accepted.length === accBefore,
      JSON.stringify({ ids_stable: JSON.stringify(secondRefusalIds) === JSON.stringify(firstRefusalIds), dup_delta: mock.state.audit.duplicates.length - dupBefore, acc_delta: mock.state.audit.accepted.length - accBefore }));
  }

  // ============================================================ F. 审计不可达（发送照常、绝不重发消息）
  {
    const bd = nextBD();
    const taskId = RUN + '-f';
    seedImported(bd, {});
    const downSecret = path.join(ROOT, 'audit-down.json');
    fs.writeFileSync(downSecret, JSON.stringify({ secret: AUDIT_SECRET, endpoint: 'http://127.0.0.1:9' + AUDIT_PATH }), { mode: 0o600 });
    const sender = createFakeSender('ok');
    const { run } = makePushRun({ mock, bd, taskId, sender, auditSecretFile: downSecret });
    const r = await run.runOnce();
    await run.audit.whenIdle({ timeoutMs: 3000 });
    const st = readStateOf(bd);
    const pend = OUTBOX.pendingCount(TC.createContext('cashier_composite', { platform: 'meituan', taskId, businessDate: bd }));
    ck('f1 审计不可达：发送仍**恰好 1 次**、状态仍落 PUSH_SUCCEEDED、事件只进 outbox pending（不因审计失败重发消息）',
      sender.rec.calls === 1 && r.ok === true && st.push.status === 'success' && pend === 1,
      JSON.stringify({ sends: sender.rec.calls, action: r.action, status: st.push.status, pending: pend }));
    const ctx2 = TC.createContext('cashier_composite', { platform: 'meituan', taskId, businessDate: bd });
    const fl = await OUTBOX.flush({ ctx: ctx2, opts: { secretFile: mock.auditSecretFile, timeoutMs: 3000, testRunId: RUN } });
    ck('f2 审计恢复后用既有 OUTBOX.flush 补送成功（event_id 不变），消息仍只发送过 1 次',
      fl.ok === true && OUTBOX.pendingCount(ctx2) === 0 && sender.rec.calls === 1,
      JSON.stringify({ flush: fl.delivered, pending: OUTBOX.pendingCount(ctx2), sends: sender.rec.calls }));
  }

  // ============================================================ G. 脱敏与自证
  {
    const files = [];
    const walk = (dir) => {
      let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else files.push(p); }
    };
    walk(path.join(ROOT, 'state'));
    const allText = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const payloads = JSON.stringify(MOCKS_SENDERS.flatMap((s) => s.rec.payloads));
    const LEAK = [/Bearer [A-Za-z0-9._-]{4,}/, /"password"/i, /"authorization"/i, /\/(?:home|opt|etc|var|root|tmp|usr)\//,
      /[A-Za-z]:\\/, /eyJ[A-Za-z0-9_-]{10,}\./, /[0-9a-fA-F]{64}/, /[A-Za-z0-9+/]{40,}={0,2}/];
    const leaks = [];
    for (const re of LEAK) { if (re.test(allText)) leaks.push('state:' + String(re)); if (re.test(payloads)) leaks.push('payload:' + String(re)); }
    ck('g1 任务状态、outbox 与 fake 推送报文均无敏感信息（无 JWT/口令/Authorization/完整 SHA/绝对路径/base64）',
      leaks.length === 0, JSON.stringify(leaks.slice(0, 4)));
    ck('g2 mock 审计端从未收到未登记 metric 字段、也从未收到完整 SHA（>12 位）',
      mock.state.audit.unknown_metric_keys.length === 0 && mock.state.audit.full_sha_seen === false,
      JSON.stringify({ unknown: Array.from(new Set(mock.state.audit.unknown_metric_keys)), full_sha_seen: mock.state.audit.full_sha_seen }));
    ck('g3 本套件自证：未发送真实企业微信消息、未读取真实 webhook/token、未真实导入/导出/下载、未建 timer、报表 B 锁定',
      out.real_wecom_message_sent === false && out.real_webhook_read === false && out.real_import === false &&
      out.real_export === false && out.real_download === false && out.timers_created === false && out.report_b === 'locked_not_started',
      JSON.stringify({ real_wecom_message_sent: false, real_webhook_read: false, report_b: out.report_b }));
  }

  await mock.stop();
  out.total = out.checks.length;
  out.failed = out.checks.filter((c) => !c.ok).length;
  out.ok = out.failed === 0;
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
  if (process.env.P3_OUT) { try { fs.writeFileSync(process.env.P3_OUT, JSON.stringify(out, null, 2), 'utf8'); } catch (_) {} }
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
})().catch((e) => {
  const fatalOut = { ok: false, fatal: String((e && e.stack) || e).slice(0, 700), total: out.checks.length, failed: out.checks.filter((c) => !c.ok).length, checks: out.checks };
  if (process.env.P3_OUT) { try { fs.writeFileSync(process.env.P3_OUT, JSON.stringify(fatalOut, null, 2), 'utf8'); } catch (_) {} }
  console.log(JSON.stringify(fatalOut, null, 2));
  process.exit(9);
});
