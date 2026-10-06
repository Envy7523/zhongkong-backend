#!/usr/bin/env node
'use strict';
/**
 * 审计检查点批量（audit-batcher）· **纯离线 mock 套件**
 *
 * 边界声明（与冻结方案逐条对应）：
 *  - **不接触真实中控 3456**：本文件自带一个**进程内 mock 中控**，绑定 127.0.0.1 的**随机端口**，
 *    按中控 `POST /api/internal/syncbot/events` 的真实契约（HMAC-SHA256 覆盖原始字节、
 *    events ≤200、event_id 幂等、accepted/duplicates/rejected、**一次请求最多一次 db.save**）实现；
 *  - **不写真实审计库 / 不写项目数据库 / 不访问美团 / 不导出 / 不下载 / 不导入 / 不推送 / 不建 timer**；
 *  - 报表 B（item_sales_detail）完全锁定未触碰；所有事件带 is_test=true + 唯一 test_run_id；
 *  - 本套件不调用真实 3456、不创建真实 test event、不写真实审计库；
 *  - 输出不含 JWT/HMAC/签名/Cookie/口令/base64/绝对路径/完整 SHA（合成密钥亦不回显）。
 *
 * 证据口径：批量写出的 JSONL **必须**能被既有 `OUTBOX.pendingEvents()` / `pendingCount()`
 * 原样读取 —— 已送达事件不得再 pending，rejected / 网络失败事件必须 pending；
 * 崩溃前只落了 event 行（从未 flush）时，既有 `OUTBOX.flush()` 仍可恢复发送。
 *
 * 运行：SYNCBOT_BOT=<bot root> node audit-batcher-test.js   （默认 /opt/zhongkong-sync-bot）
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p3batch-'));
process.env.SYNCBOT_ROOT = ROOT;

const BOT = process.env.SYNCBOT_BOT || '/opt/zhongkong-sync-bot';
const OUTBOX = require(BOT + '/app/src/phase3/audit-outbox.js');
const BAT = require(BOT + '/app/src/phase3/audit-batcher.js');
const WIRING = require(BOT + '/app/src/phase3/real-download-audit.js');
const IMP = require(BOT + '/app/src/phase3/import-audit.js');
const MAP = require(BOT + '/app/src/phase3/audit-stage-map.js');
const TC = require(BOT + '/app/src/task-context.js');
const { createOrchestrator } = require(BOT + '/app/src/phase2/real-download.js');

/** 合成 HMAC 密钥（**非生产密钥**，只存在于本进程与临时目录，绝不进入输出） */
const SECRET = crypto.randomBytes(32).toString('hex');
const RUN = 'batch-' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');

const out = {
  suite: 'audit-batcher-offline-mock',
  fixture: true, offline: true,
  real_3456_touched: false, real_audit_db_written: false, real_meituan_run: false,
  real_export: false, real_download: false, real_import: false, real_push: false, timers_created: false,
  test_run_id: RUN, checks: [],
};
const ck = (n, ok, d) => out.checks.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });

let BD_SEQ = 0;
/** 每个场景独占一个业务日期 → 独占一个 outbox JSONL（避免跨场景 pending 互相污染） */
function nextBD() {
  BD_SEQ += 1;
  const d = new Date(Date.UTC(2026, 0, 1 + BD_SEQ));
  return d.toISOString().slice(0, 10);
}
let SEC_SEQ = 0;

// ---------------------------------------------------------------- mock 中控
/**
 * mode:
 *   ok           正常：accepted/duplicates/rejected 按契约返回
 *   partial      由 shouldReject(event) 决定哪些事件被 rejected（其余 accepted）
 *   drop         收到请求后**直接销毁连接**（响应丢失）
 *   hang         收到请求后**永不响应**（网络超时）
 *   save_fail    一次请求内"落库"失败 → 整请求 500，且**不写入幂等集合**（accepted 不算数）
 *   save_fail_once 同上，仅第一次失败
 */
function createMock({ mode: initMode = 'ok', shouldReject = null } = {}) {
  let mode = initMode;
  const state = {
    posts: 0, saves: 0, save_attempts: 0, events_received: 0, bytes_received: 0,
    accepted: [], duplicates: [], rejected: [], batches: [], payloads: [],
  };
  const seen = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      state.posts += 1;
      const raw = Buffer.concat(chunks).toString('utf8');
      const ts = String(req.headers['x-syncbot-timestamp'] || '');
      const sig = String(req.headers['x-syncbot-signature'] || '');
      if (mode === 'drop') { try { req.socket.destroy(); } catch (_) {} return; }
      if (mode === 'hang') { return; }
      const want = crypto.createHmac('sha256', SECRET).update(ts + '.' + raw, 'utf8').digest('hex');
      if (!sig || sig.length !== want.length) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'signature_invalid' })); return; }
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'signature_invalid' })); return; }
      let body = null;
      try { body = JSON.parse(raw); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'bad_json' })); return; }
      const events = Array.isArray(body && body.events) ? body.events : null;
      if (!events || !events.length) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'events_required' })); return; }
      if (events.length > 200) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'too_many_events' })); return; }
      const bytes = Buffer.byteLength(raw, 'utf8');
      state.events_received += events.length;
      state.bytes_received += bytes;
      state.payloads.push(events.length <= 10
        ? events.map((e) => ({ event_id: e && e.event_id, stage: e && e.stage, seq: e && e.seq, at: e && e.at, task_id: e && e.task_id, is_test: e && e.is_test, metrics: e && e.metrics }))
        : [{ truncated_batch: events.length }]);
      const accepted = []; const duplicates = []; const rejected = [];
      const batchSeen = new Set();   // 与中控一致：同批内先插入的 event_id，其后同批出现必须判 duplicate
      for (const e of events) {
        if (shouldReject && shouldReject(e)) { rejected.push({ event_id: e && e.event_id, reasons: ['mock_rejected_by_contract'] }); continue; }
        if (seen.has(e.event_id) || batchSeen.has(e.event_id)) duplicates.push(e.event_id);
        else { accepted.push(e.event_id); batchSeen.add(e.event_id); }
      }
      if (accepted.length || duplicates.length) {
        state.save_attempts += 1;
        const failNow = mode === 'save_fail' || (mode === 'save_fail_once' && state.save_attempts === 1);
        if (failNow) {
          // 落库失败：整请求失败，且幂等集合**不推进** —— accepted 绝不能被当成成功
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'db_save_failed' }));
          return;
        }
        state.saves += 1;
        for (const id of accepted) seen.add(id);
      }
      state.accepted.push.apply(state.accepted, accepted);
      state.duplicates.push.apply(state.duplicates, duplicates);
      state.rejected.push.apply(state.rejected, rejected.map((r) => r.event_id));
      state.batches.push({
        events: events.length, accepted: accepted.length, duplicates: duplicates.length,
        rejected: rejected.length, stages: events.map((e) => e.stage), bytes,
      });
      const status = accepted.length ? 201 : (rejected.length === events.length ? 400 : 200);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: rejected.length === 0, accepted: accepted.length, duplicates: duplicates.length, rejected }));
    });
  });
  return {
    server, state,
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      SEC_SEQ += 1;
      const f = path.join(ROOT, 'secret-' + SEC_SEQ + '.json');
      fs.writeFileSync(f, JSON.stringify({ secret: SECRET, endpoint: 'http://127.0.0.1:' + server.address().port + '/api/internal/syncbot/events' }), { mode: 0o600 });
      this.secretFile = f;
      return this;
    },
    async stop() { await new Promise((r) => server.close(r)); },
    setMode(m) { mode = m; },
    /** 证据用摘要（不含密钥/签名/路径） */
    summary() {
      return {
        posts: state.posts, saves: state.saves, events_received: state.events_received,
        accepted: state.accepted.length, duplicates: state.duplicates.length, rejected: state.rejected.length,
        batches: state.batches.map((b) => ({ n: b.events, acc: b.accepted, dup: b.duplicates, rej: b.rejected, stages: b.stages, bytes: b.bytes })),
      };
    },
  };
}

// ---------------------------------------------------------------- 下载侧夹具
function makeDownloadFx({ taskId, bd, secretFile, failAt = null, timeoutMs = 3000, boom = false }) {
  const TMP = fs.mkdtempSync(path.join(ROOT, 'fx-'));
  const ctx = TC.createContext('cashier_composite', { platform: 'meituan', taskId, businessDate: bd });
  const auditPending = [];
  const counts = { precheck: 0, query: 0, export: 0, passive: 0, download: 0, archive: 0, validate: 0 };
  const resolvedOpts = { secretFile, timeoutMs, testRunId: RUN };
  let injected = null;
  if (boom) {
    injected = BAT.createAuditBatcher({ ctx, opts: resolvedOpts });
    injected.add = () => { throw new Error('boom at /opt/zhongkong-sync-bot/x.js sha256=' + 'b'.repeat(64)); };
  }
  const audit = WIRING.createRealDownloadAudit({
    ctx,
    batcher: injected,
    opts: resolvedOpts,
    onPending: (i) => auditPending.push(i),
  });
  let last = null;
  const store = { load: () => last, save: audit.wrapSave((v) => { last = JSON.parse(JSON.stringify(v)); }) };
  const picked = bd.replace(/-/g, '/');
  const future = () => new Date(Date.now() + 3600000).toISOString().slice(0, 19).replace('T', ' ');
  const adapters = {
    precheck: async () => { counts.precheck += 1; return failAt === 'precheck' ? { ok: false, reason: '前置校验未通过：页面元素缺失' } : { ok: true }; },
    probeDownloadList: async () => ({ ok: true }),
    navigateAndQuery: async () => { counts.query += 1; return failAt === 'query' ? { ok: false, reason: '查询校验未通过：行数与声明不符' } : { ok: true, declared_count: 22 }; },
    submitExport: async () => { counts.export += 1; return failAt === 'export' ? { ok: false, reason: '导出提交失败：对话框未出现' } : { ok: true, dialog_text: '本次导出数据共22条' }; },
    readDownloadRows: async () => ({
      rows: [
        { cells: ['序号', '业务模块', '申请内容', '申请人', '申请时间', '更新时间', '状态', '操作'], rect: { x: 0, y: 0, w: 10, h: 10 }, controls: [] },
        { cells: ['1', '报表中心', '综合营业统计(营业日期【' + picked + '-' + picked + '】)', 'LongXia', future(), future(), '导出完成', '下载'], rect: { x: 0, y: 20, w: 100, h: 20 }, controls: [{ text: '下载', selector: '#d', rect: { x: 20, y: 24, w: 20, h: 12 } }] },
      ],
    }),
    waitForPassiveFile: async () => { counts.passive += 1; return failAt === 'download' ? { ok: false, reason: '被动下载等待超时 120s' } : { ok: true, file: path.join(TMP, 'a.xlsx'), name: 'a.xlsx', size: 24952, elapsed_ms: 12 }; },
    observeDownloadList: async () => ({ ok: true, read_only: true, outcome: 'wait', detail: '只读观察', clicked: false }),
    downloadFile: async () => { counts.download += 1; return { ok: true, file: path.join(TMP, 'd.xlsx'), suggested_name: 'd.xlsx' }; },
    archive: async () => { counts.archive += 1; return failAt === 'archive' ? { ok: false, reason: '归档失败：目标目录不可写' } : { ok: true, archived_path: path.join(TMP, 'arch.xlsx'), archived_name: 'arch.xlsx', size: 1, sha256: 'b'.repeat(64) }; },
    validateFile: async () => { counts.validate += 1; return failAt === 'validate' ? { ok: false, errors: ['行数不符'] } : { ok: true, checks: {} }; },
    screenshot: async () => ({ ok: true }),
    setApprovals: async () => {},
    resetApprovals: async () => {},
  };
  const orch = createOrchestrator({ ctx, store, adapters, sleep: async () => {}, wait: { initialWaitMs: 0, pollIntervalMs: 0, maxWaitMs: 3 } });
  return { ctx, audit, auditPending, counts, run: () => orch.run({ applicant: 'LongXia' }) };
}

// ---------------------------------------------------------------- 导入侧夹具
function okImport(bd) {
  return {
    ok: true, http: 200, import_batch_id: 9001, amount_excel: 75997.23, amount_db: 75997.23, import_batch_id: 180, amount_basis: { scope: 'import_batch_id', mappings: [{ file_column: '营业收入(元)', db_column: 'recorded_amount' }, { file_column: '营业额(元)', db_column: 'gross_amount' }, { file_column: '优惠金额(元)', db_column: 'discount_amount' }] }, raw_imported: 22, matched_stores: 22, imported: 154,
    errors: [], excel_business_date: bd, amount_excel: 12345.67, amount_db: 12345.67, sha256: 'c'.repeat(64),
  };
}
function makeImportFx({ taskId, bd, secretFile, importFn = null, timeoutMs = 3000 }) {
  const ctx = TC.createContext('cashier_composite', { platform: 'meituan', taskId, businessDate: bd });
  const auditPending = [];
  const calls = { import: 0 };
  const audit = IMP.createImportAudit({
    ctx,
    opts: { secretFile, timeoutMs, testRunId: RUN },
    onPending: (i) => auditPending.push(i),
  });
  return {
    ctx,
    audit,
    auditPending,
    get importCalls() { return calls.import; },
    run: (o = {}) => audit.runGuardedImport(Object.assign({
      coverageGate: async () => ({ ok: true, covered: false }),
      duplicateCheck: async () => ({ duplicate: false }),
      validateFile: async () => ({ ok: true }),
      businessDate: bd,
      onImportCall: () => { calls.import += 1; },
      importFn: importFn || (async () => okImport(bd)),
    }, o)),
  };
}

/** 直接驱动 batcher（用于排序 / 分片 / 失败语义的定点验证） */
function makeBatcher({ taskId, bd, secretFile, timeoutMs = 3000, opts: extra = {} }) {
  const ctx = TC.createContext('cashier_composite', { platform: 'meituan', taskId, businessDate: bd });
  const batch = BAT.createAuditBatcher({
    ctx,
    opts: Object.assign({ secretFile, timeoutMs, testRunId: RUN }, extra),
  });
  return { ctx, batch };
}

const postsOf = (summary) => summary.batch.posts_log.map((p) => ({ reason: p.reason, stages: p.stages, delivered: p.delivered.length, pending: p.pending.length, status: p.status, bytes: p.bytes }));
const terminalLines = (ctx, type) => {
  const f = OUTBOX.outboxFile(ctx.platform, ctx.reportType, ctx.businessDate);
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).filter((l) => l.type === type);
};
const jsonlOf = (ctx) => {
  const f = OUTBOX.outboxFile(ctx.platform, ctx.reportType, ctx.businessDate);
  return fs.readFileSync(f, 'utf8');
};

const MOCKS = [];
const newMock = async (o) => { const m = await createMock(o).start(); MOCKS.push(m); return m; };

const C1_STAGES = ['PRECHECK', 'QUERY_DONE', 'EXPORT_SUBMITTED', 'WAITING_EXPORT'];
const C2_STAGES = ['DOWNLOADED', 'FILE_VALIDATED'];
const OK6 = C1_STAGES.concat(C2_STAGES);

(async () => {
  // ============================================================ A. 正常成功路径
  {
    const m = await newMock({ mode: 'ok' });
    const bd = nextBD();
    const taskId = RUN + '-a';
    const D = makeDownloadFx({ taskId, bd, secretFile: m.secretFile });
    const rD = await D.run();
    await D.audit.whenIdle();
    const postsAfterDownloadIdle = m.state.posts;
    const I = makeImportFx({ taskId, bd, secretFile: m.secretFile });
    const rI = await I.run();
    await I.audit.whenIdle();
    const finalPosts = m.state.posts;
    const dp = postsOf(D.audit.summary());
    const ip = postsOf(I.audit.summary());
    ck('a1 下载编排器业务结果仍是 FILE_VALIDATED（批量不改状态机/不改业务动作）',
      rD.ok === true && rD.result === 'FILE_VALIDATED' && D.counts.export === 1 && D.counts.passive === 1 && D.counts.download === 0,
      JSON.stringify({ result: rD.result, counts: D.counts }));
    ck('a2 C1 批量成员与顺序精确匹配（4 条 / seq ASC）',
      dp.length === 2 && dp[0].reason === 'C1' && JSON.stringify(dp[0].stages) === JSON.stringify(C1_STAGES),
      JSON.stringify(dp));
    ck('a3 C2 批量成员与顺序精确匹配（2 条 / seq ASC）',
      dp.length === 2 && dp[1].reason === 'C2' && JSON.stringify(dp[1].stages) === JSON.stringify(C2_STAGES),
      JSON.stringify(dp));
    ck('a4 C3 = IMPORT_STARTED（立即发）；C4 = IMPORT_SUCCEEDED（立即发）',
      ip.length === 2 && ip[0].reason === 'C3' && JSON.stringify(ip[0].stages) === JSON.stringify(['IMPORT_STARTED']) &&
      ip[1].reason === 'C4' && JSON.stringify(ip[1].stages) === JSON.stringify(['IMPORT_SUCCEEDED']) && rI.action === 'IMPORT_SUCCEEDED',
      JSON.stringify({ posts: ip, action: rI.action }));
    ck('a5 正常成功路径恰好 4 次 POST / 4 次 mock save',
      m.state.posts === 4 && m.state.saves === 4 && m.state.save_attempts === 4,
      JSON.stringify({ posts: m.state.posts, saves: m.state.saves, save_attempts: m.state.save_attempts }));
    ck('a6 whenIdle / 退出路径只等不造：2 次 POST 后 whenIdle 未产生第 3 次，收尾也未产生第 5 次',
      postsAfterDownloadIdle === 2 && finalPosts === 4,
      JSON.stringify({ after_download_idle: postsAfterDownloadIdle, final: finalPosts }));
    ck('a7 4 次请求共 8 条事件全部被接受，无 duplicate / 无 rejected',
      m.state.events_received === 8 && m.state.accepted.length === 8 && m.state.duplicates.length === 0 && m.state.rejected.length === 0,
      JSON.stringify({ events: m.state.events_received, accepted: m.state.accepted.length, dup: m.state.duplicates.length, rej: m.state.rejected.length }));
    ck('a8 已送达事件不得再 pending（既有 pendingEvents/pendingCount 读真实 JSONL）',
      OUTBOX.pendingCount(D.ctx) === 0 && OUTBOX.pendingEvents(OUTBOX.outboxFile(D.ctx.platform, D.ctx.reportType, D.ctx.businessDate)).length === 0,
      JSON.stringify({ pending: OUTBOX.pendingCount(D.ctx) }));
    ck('a9 JSONL 终态行：8 行 delivered、0 行 audit_pending',
      terminalLines(D.ctx, 'delivered').length === 8 && terminalLines(D.ctx, 'audit_pending').length === 0,
      JSON.stringify({ delivered: terminalLines(D.ctx, 'delivered').length, pending: terminalLines(D.ctx, 'audit_pending').length }));
    ck('a10 下载侧 emitted_stages 仍为既有 6 阶段顺序；导入侧仍为 2 类',
      JSON.stringify(D.audit.summary().emitted_stages) === JSON.stringify(OK6) &&
      JSON.stringify(I.audit.summary().emitted_kinds) === JSON.stringify(['IMPORT_STARTED', 'IMPORT_SUCCEEDED']),
      JSON.stringify({ d: D.audit.summary().emitted_stages, i: I.audit.summary().emitted_kinds }));
    out.summary = Object.assign(out.summary || {}, {
      normal_path_posts: dp.concat(ip).map((p) => ({ reason: p.reason, stages: p.stages, status: p.status })),
      normal_path_mock: m.summary(),
    });
  }

  // ============================================================ B. 下载失败 2/2
  {
    const m = await newMock({ mode: 'ok' });
    const D = makeDownloadFx({ taskId: RUN + '-b', bd: nextBD(), secretFile: m.secretFile, failAt: 'download' });
    const rD = await D.run();
    await D.audit.whenIdle();
    const dp = postsOf(D.audit.summary());
    ck('b1 下载失败（WAITING_EXPORT 后等待超时）：业务结果 FAILED，导出仍只提交一次',
      rD.ok === false && rD.result === 'FAILED' && D.counts.export === 1,
      JSON.stringify({ result: rD.result, export: D.counts.export }));
    ck('b2 下载失败 = C1(4 条) + FAILED 立即 flush(1 条) → 2 POST / 2 mock save',
      dp.length === 2 && JSON.stringify(dp[0].stages) === JSON.stringify(C1_STAGES) &&
      dp[1].reason === 'FAILED' && JSON.stringify(dp[1].stages) === JSON.stringify(['FAILED']) &&
      m.state.posts === 2 && m.state.saves === 2,
      JSON.stringify({ posts: m.state.posts, saves: m.state.saves, log: dp }));
    const failedEv = m.state.payloads.flat().find((e) => e && e.stage === 'FAILED');
    ck('b3 FAILED 事件带原 phase=WAITING_EXPORT 且原因已脱敏（无路径/无完整 SHA）',
      !!failedEv && failedEv.metrics && failedEv.metrics.phase === 'WAITING_EXPORT' &&
      !/(\/(?:home|opt|etc|var|root|tmp|usr)\/)|([A-Za-z]:\\)|[0-9a-fA-F]{32,}/.test(JSON.stringify(failedEv.metrics)),
      JSON.stringify(failedEv ? failedEv.metrics : null));
    ck('b4 下载失败后无事件滞留 pending',
      OUTBOX.pendingCount(D.ctx) === 0, JSON.stringify({ pending: OUTBOX.pendingCount(D.ctx) }));
  }

  // ============================================================ C. G3 拦截 3/3
  {
    const m = await newMock({ mode: 'ok' });
    const bd = nextBD();
    const taskId = RUN + '-c';
    const D = makeDownloadFx({ taskId, bd, secretFile: m.secretFile });
    await D.run();
    await D.audit.whenIdle();
    const I = makeImportFx({ taskId, bd, secretFile: m.secretFile });
    const rI = await I.run({ coverageGate: async () => ({ ok: false, coverage_hit: true }) });
    await I.audit.whenIdle();
    ck('c1 G3 覆盖命中：零导入请求 + WAITING_HUMAN + ready_to_push=false',
      rI.action === 'WAITING_HUMAN' && rI.allow_push === false && I.importCalls === 0,
      JSON.stringify({ action: rI.action, import_calls: I.importCalls }));
    ck('c2 G3 拦截 = C1(4) + C2(2) + WAITING_HUMAN(1) → 3 POST / 3 mock save',
      m.state.posts === 3 && m.state.saves === 3 && JSON.stringify(postsOf(I.audit.summary())[0].stages) === JSON.stringify(['WAITING_HUMAN']),
      JSON.stringify({ posts: m.state.posts, saves: m.state.saves, last: postsOf(I.audit.summary())[0] }));
    const wh = m.state.payloads.flat().find((e) => e && e.stage === 'WAITING_HUMAN');
    ck('c3 WAITING_HUMAN 事件显式 ready_to_push=0（审计侧不放行推送）',
      !!wh && wh.metrics && Number(wh.metrics.ready_to_push) === 0,
      JSON.stringify(wh ? wh.metrics : null));
  }

  // ============================================================ D. 导入失败 4/4
  {
    const m = await newMock({ mode: 'ok' });
    const bd = nextBD();
    const taskId = RUN + '-d';
    const D = makeDownloadFx({ taskId, bd, secretFile: m.secretFile });
    await D.run();
    await D.audit.whenIdle();
    const I = makeImportFx({ taskId, bd, secretFile: m.secretFile, importFn: async () => ({ ok: false, http: 500, error: 'mock_import_5xx' }) });
    const rI = await I.run();
    await I.audit.whenIdle();
    const ip = postsOf(I.audit.summary());
    ck('d1 导入失败 = C1+C2+C3+C4 → 4 POST / 4 mock save',
      m.state.posts === 4 && m.state.saves === 4,
      JSON.stringify({ posts: m.state.posts, saves: m.state.saves }));
    ck('d2 C4 = IMPORT_FAILED，导入请求恰好 1 次（绝不自动重试），ready_to_push=false',
      rI.action === 'IMPORT_FAILED' && rI.allow_push === false && I.importCalls === 1 &&
      ip.length === 2 && ip[1].reason === 'C4' && JSON.stringify(ip[1].stages) === JSON.stringify(['IMPORT_FAILED']),
      JSON.stringify({ action: rI.action, import_calls: I.importCalls, posts: ip }));
    ck('d3 导入失败后无事件滞留 pending（终态事件均已送达）',
      OUTBOX.pendingCount(I.ctx) === 0, JSON.stringify({ pending: OUTBOX.pendingCount(I.ctx) }));
  }

  // ============================================================ E. 排序 / 分片
  {
    const m = await newMock({ mode: 'ok' });

    // E1 逆序入缓冲
    {
      const { ctx, batch } = makeBatcher({ taskId: RUN + '-e1', bd: nextBD(), secretFile: m.secretFile });
      const rev = C1_STAGES.concat(['DOWNLOADED']).slice().reverse();
      rev.forEach((st, i) => { batch.add(batch.buildEvent({ stage: st, seq: rev.length - i, metrics: {} })); });
      const jsonlOrder = terminalLines(ctx, 'event').map((l) => l.event.stage);
      await batch.flush('E1');
      ck('e1 逆序 pending 仍按 seq ASC 发送（JSONL 落盘顺序为逆序，发送顺序为升序）',
        JSON.stringify(m.state.batches[0].stages) === JSON.stringify(rev.slice().reverse()) &&
        JSON.stringify(jsonlOrder) === JSON.stringify(rev),
        JSON.stringify({ jsonl: jsonlOrder, sent: m.state.batches[0].stages }));
    }

    // E2 重复 seq
    {
      const { batch } = makeBatcher({ taskId: RUN + '-e2', bd: nextBD(), secretFile: m.secretFile });
      const a = batch.buildEvent({ stage: 'PRECHECK', seq: 2 }); a.at = '2026-01-01T00:00:09.000Z';
      const b = batch.buildEvent({ stage: 'QUERY_DONE', seq: 2 }); b.at = '2026-01-01T00:00:03.000Z';
      const c = batch.buildEvent({ stage: 'EXPORT_SUBMITTED', seq: 2 }); c.at = '2026-01-01T00:00:03.000Z';
      const tie = b.event_id < c.event_id ? [b, c] : [c, b];
      const expected = tie.concat([a]).map((e) => e.stage);
      [a, b, c].forEach((e) => batch.add(e));
      await batch.flush('E2');
      ck('e2 重复 seq：按 at ASC 再 event_id ASC 稳定定序',
        JSON.stringify(m.state.batches[1].stages) === JSON.stringify(expected),
        JSON.stringify({ expected, sent: m.state.batches[1].stages }));
    }

    // E3 缺 seq
    {
      const { batch } = makeBatcher({ taskId: RUN + '-e3', bd: nextBD(), secretFile: m.secretFile });
      const x = batch.buildEvent({ stage: 'PRECHECK', seq: 3 });
      const y = batch.buildEvent({ stage: 'QUERY_DONE', seq: 1 }); delete y.seq;
      const z = batch.buildEvent({ stage: 'EXPORT_SUBMITTED', seq: 1 });
      [x, y, z].forEach((e) => batch.add(e));
      await batch.flush('E3');
      ck('e3 缺 seq 排最前（其后按 seq ASC）',
        JSON.stringify(m.state.batches[2].stages) === JSON.stringify(['QUERY_DONE', 'EXPORT_SUBMITTED', 'PRECHECK']),
        JSON.stringify(m.state.batches[2].stages));
    }

    // E4 同批重复 event_id
    {
      const { ctx, batch } = makeBatcher({ taskId: RUN + '-e4', bd: nextBD(), secretFile: m.secretFile });
      const ev = batch.buildEvent({ stage: 'PRECHECK', seq: 1 });
      batch.add(ev); batch.add(ev);
      const res = await batch.flush('E4');
      const dl = terminalLines(ctx, 'delivered').filter((l) => l.event_id === ev.event_id);
      ck('e4 同批重复 event_id：服务端 accepted 1 + duplicate 1，仅写一行 delivered，pending 归零',
        m.state.batches[3].accepted === 1 && m.state.batches[3].duplicates === 1 && dl.length === 1 &&
        OUTBOX.pendingCount(ctx) === 0 && res.results.length === 2 && res.results.every((r) => r.ok),
        JSON.stringify({ batch: m.state.batches[3], delivered_lines: dl.length, pending: OUTBOX.pendingCount(ctx) }));
    }

    // E5 分片：201 条 → 200 + 1
    {
      const { ctx, batch } = makeBatcher({ taskId: RUN + '-e5', bd: nextBD(), secretFile: m.secretFile });
      for (let i = 1; i <= 201; i += 1) batch.add(batch.buildEvent({ stage: 'PRECHECK', seq: i }));
      await batch.flush('E5');
      const sizes = m.state.batches.slice(4).map((b) => b.events);
      ck('e5 分片：201 条拆成 200 + 1，每片 ≤200 条，全部送达且无重复终态行',
        JSON.stringify(sizes) === JSON.stringify([200, 1]) &&
        m.state.batches.slice(4).every((b) => b.events <= 200) &&
        terminalLines(ctx, 'delivered').length === 201 && OUTBOX.pendingCount(ctx) === 0,
        JSON.stringify({ sizes, delivered_lines: terminalLines(ctx, 'delivered').length, pending: OUTBOX.pendingCount(ctx) }));
    }

    // E6 分片：单条超半上限 → 每条独占一片，且每片 ≤512KiB
    {
      const { batch } = makeBatcher({ taskId: RUN + '-e6', bd: nextBD(), secretFile: m.secretFile });
      const big = (n) => { const o = {}; for (let i = 0; i < n; i += 1) o['k' + i] = ('x'.repeat(20) + '-').repeat(19); return o; };
      const evs = [1, 2, 3].map((i) => batch.buildEvent({ stage: 'PRECHECK', seq: i, metrics: big(700) }));
      const oneSize = Buffer.byteLength(JSON.stringify(evs[0]), 'utf8');
      evs.forEach((e) => batch.add(e));
      await batch.flush('E6');
      const group = m.state.batches.slice(m.state.batches.length - 3);
      const cap = 512 * 1024;
      ck('e6 分片：超大事件每条独占一片，每片请求体 ≤512KiB（严格小于中控 1mb 上限）',
        oneSize > cap / 2 && group.length === 3 && group.every((b) => b.events === 1 && b.bytes <= cap),
        JSON.stringify({ one_event_bytes: oneSize, cap, shards: group.map((b) => ({ n: b.events, bytes: b.bytes })) }));
    }
  }

  // ============================================================ F. 失败 / 恢复
  {
    // F1 部分 rejected
    const m1 = await newMock({ mode: 'partial', shouldReject: (e) => e.stage === 'QUERY_DONE' });
    const { ctx: c1, batch: b1 } = makeBatcher({ taskId: RUN + '-f1', bd: nextBD(), secretFile: m1.secretFile });
    b1.add(b1.buildEvent({ stage: 'PRECHECK', seq: 1 }));
    b1.add(b1.buildEvent({ stage: 'QUERY_DONE', seq: 2 }));
    b1.add(b1.buildEvent({ stage: 'EXPORT_SUBMITTED', seq: 3 }));
    const r1 = await b1.flush('F1');
    const pend1 = OUTBOX.pendingEvents(OUTBOX.outboxFile(c1.platform, c1.reportType, c1.businessDate));
    const pLines = terminalLines(c1, 'audit_pending');
    ck('f1 部分 rejected：被拒 event_id 记 pending，其余 event_id 照常 delivered（不整批降级）',
      r1.results.filter((r) => r.ok).length === 2 && r1.results.filter((r) => !r.ok).length === 1 &&
      m1.state.batches[0].accepted === 2 && m1.state.batches[0].rejected === 1 &&
      terminalLines(c1, 'delivered').length === 2 && pLines.length === 1 &&
      pend1.length === 1 && pend1[0].stage === 'QUERY_DONE',
      JSON.stringify({ results: r1.results.map((r) => ({ s: r.stage, ok: r.ok })), delivered: terminalLines(c1, 'delivered').length, pending: pend1.length }));
    ck('f2 pending 行沿用既有格式（type/at/event_id/stage/reason/rejected_count/rejected_reasons）且原因已脱敏',
      pLines.length === 1 && pLines[0].type === 'audit_pending' && !!pLines[0].at && !!pLines[0].event_id && pLines[0].stage === 'QUERY_DONE' &&
      pLines[0].rejected_count === 1 && Array.isArray(pLines[0].rejected_reasons) && pLines[0].reason === 'rejected' &&
      !/(\/(?:home|opt|etc|var|root|tmp|usr)\/)|([A-Za-z]:\\)|[0-9a-fA-F]{32,}|eyJ/.test(String(pLines[0].reason) + ' ' + JSON.stringify(pLines[0].rejected_reasons || [])),
      JSON.stringify(pLines[0] ? { reason: pLines[0].reason, rejected_count: pLines[0].rejected_count } : null));

    // F3 响应丢失（连接被销毁）
    const m2 = await newMock({ mode: 'drop' });
    const { ctx: c2, batch: b2 } = makeBatcher({ taskId: RUN + '-f3', bd: nextBD(), secretFile: m2.secretFile });
    b2.add(b2.buildEvent({ stage: 'PRECHECK', seq: 1 }));
    b2.add(b2.buildEvent({ stage: 'QUERY_DONE', seq: 2 }));
    const r2 = await b2.flush('F3');
    ck('f3 响应丢失（连接被销毁）：全部 event_id 记 pending，绝无 delivered',
      r2.results.every((r) => !r.ok) && OUTBOX.pendingCount(c2) === 2 && terminalLines(c2, 'delivered').length === 0 && m2.state.saves === 0,
      JSON.stringify({ pending: OUTBOX.pendingCount(c2), delivered: terminalLines(c2, 'delivered').length, saves: m2.state.saves }));

    // F4 网络超时
    const m3 = await newMock({ mode: 'hang' });
    const { ctx: c3, batch: b3 } = makeBatcher({ taskId: RUN + '-f4', bd: nextBD(), secretFile: m3.secretFile, timeoutMs: 800 });
    b3.add(b3.buildEvent({ stage: 'PRECHECK', seq: 1 }));
    b3.add(b3.buildEvent({ stage: 'QUERY_DONE', seq: 2 }));
    const t3 = Date.now();
    const r3 = await b3.flush('F4');
    const el3 = Date.now() - t3;
    const pl3 = terminalLines(c3, 'audit_pending');
    ck('f4 网络超时（服务端挂住不返回）：有界返回且全部记 pending，不无限阻塞',
      r3.results.every((r) => !r.ok) && OUTBOX.pendingCount(c3) === 2 && el3 < 6000 &&
      pl3.every((l) => !/(\/(?:home|opt|etc|var|root|tmp|usr)\/)|([A-Za-z]:\\)|[0-9a-fA-F]{32,}|eyJ/.test(String(l.reason) + ' ' + JSON.stringify(l.rejected_reasons || []))),
      JSON.stringify({ elapsed_ms: el3, pending: OUTBOX.pendingCount(c3) }));

    // F5 db.save 失败 → 绝不把 accepted 当成功；恢复后重发只能一次 accepted
    const m4 = await newMock({ mode: 'save_fail' });
    const { ctx: c4, batch: b4 } = makeBatcher({ taskId: RUN + '-f5', bd: nextBD(), secretFile: m4.secretFile });
    const evs4 = [1, 2, 3].map((i) => b4.buildEvent({ stage: 'PRECHECK', seq: i }));
    evs4.forEach((e) => b4.add(e));
    const r4 = await b4.flush('F5');
    ck('f5 db.save 失败（整请求 500）：全部记 pending，绝不把 accepted 当成功',
      r4.results.every((r) => !r.ok) && OUTBOX.pendingCount(c4) === 3 &&
      terminalLines(c4, 'delivered').length === 0 && m4.state.save_attempts === 1 && m4.state.saves === 0 && m4.state.accepted.length === 0,
      JSON.stringify({ pending: OUTBOX.pendingCount(c4), delivered: terminalLines(c4, 'delivered').length, save_attempts: m4.state.save_attempts, saves: m4.state.saves }));

    m4.setMode('ok');
    const fl4 = await OUTBOX.flush({ ctx: c4, opts: { secretFile: m4.secretFile, timeoutMs: 3000, testRunId: RUN } });
    ck('f6 恢复后用**既有** OUTBOX.flush 补送：pending 归零，每个 event_id 恰好被接受一次',
      fl4.ok === true && fl4.delivered === 3 && OUTBOX.pendingCount(c4) === 0 &&
      m4.state.accepted.length === 3 && m4.state.duplicates.length === 0 && terminalLines(c4, 'delivered').length === 3,
      JSON.stringify({ flush_delivered: fl4.delivered, pending: OUTBOX.pendingCount(c4), accepted: m4.state.accepted.length, dup: m4.state.duplicates.length }));

    const acceptedBefore = m4.state.accepted.length;
    const b4b = BAT.createAuditBatcher({ ctx: c4, opts: { secretFile: m4.secretFile, timeoutMs: 3000, testRunId: RUN } });
    evs4.forEach((e) => b4b.add(b4b.buildEvent({ stage: e.stage, seq: e.seq })));
    const r4b = await b4b.flush('F6');
    ck('f7 再发同一批（event_id 稳定）：全部 duplicate，accepted 不增长，pending 仍为 0',
      m4.state.duplicates.length === 3 && m4.state.accepted.length === acceptedBefore &&
      r4b.results.every((r) => r.ok && r.delivery_kind === 'duplicate') && OUTBOX.pendingCount(c4) === 0,
      JSON.stringify({ accepted: m4.state.accepted.length, dup: m4.state.duplicates.length, kinds: r4b.results.map((r) => r.delivery_kind) }));

    // F8 崩溃前仅落 event 行 → 既有 flush 仍可恢复发送
    const m5 = await newMock({ mode: 'ok' });
    const { ctx: c5, batch: b5 } = makeBatcher({ taskId: RUN + '-f8', bd: nextBD(), secretFile: m5.secretFile });
    [1, 2, 3].forEach((i) => b5.add(b5.buildEvent({ stage: ['PRECHECK', 'QUERY_DONE', 'EXPORT_SUBMITTED'][i - 1], seq: i })));
    const pend5 = OUTBOX.pendingEvents(OUTBOX.outboxFile(c5.platform, c5.reportType, c5.businessDate));
    ck('f8 崩溃前仅落 event 行（从未 flush）：既有 pendingEvents/pendingCount 可原样恢复识别',
      pend5.length === 3 && OUTBOX.pendingCount(c5) === 3 && m5.state.posts === 0 &&
      terminalLines(c5, 'delivered').length === 0 && terminalLines(c5, 'audit_pending').length === 0,
      JSON.stringify({ pending: pend5.length, posts: m5.state.posts }));
    const idsBefore = pend5.map((e) => e.event_id).sort();
    const fl5 = await OUTBOX.flush({ ctx: c5, opts: { secretFile: m5.secretFile, timeoutMs: 3000, testRunId: RUN } });
    ck('f9 既有 flush 恢复补送成功，且补送的 event_id 与落盘时完全一致（服务端幂等）',
      fl5.ok === true && OUTBOX.pendingCount(c5) === 0 && JSON.stringify(m5.state.accepted.slice().sort()) === JSON.stringify(idsBefore),
      JSON.stringify({ flush_ok: fl5.ok, pending: OUTBOX.pendingCount(c5), ids_same: JSON.stringify(m5.state.accepted.slice().sort()) === JSON.stringify(idsBefore) }));
  }

  // ============================================================ H. 病态 batcher（add 抛异常）
  {
    const m = await newMock({ mode: 'ok' });
    const D = makeDownloadFx({ taskId: RUN + '-h', bd: nextBD(), secretFile: m.secretFile, boom: true });
    const rD = await D.run();
    await D.audit.whenIdle();
    ck('h1 审计写入（add）抛异常不打断业务：仍 FILE_VALIDATED，导出/下载未重跑',
      rD.ok === true && rD.result === 'FILE_VALIDATED' && D.counts.export === 1 && D.counts.passive === 1 && D.counts.download === 0,
      JSON.stringify({ result: rD.result, counts: D.counts }));
    ck('h2 add 异常逐条记 audit_pending（6 条）且原因已脱敏（无绝对路径/无完整 SHA）',
      D.auditPending.length === 6 && D.auditPending.every((x) => !/(\/(?:home|opt|etc|var|root|tmp|usr)\/)|([A-Za-z]:\\)|[0-9a-fA-F]{64}/.test(String(x.reason)) && /\[/.test(String(x.reason))),
      JSON.stringify({ n: D.auditPending.length, sample: D.auditPending[0] ? D.auditPending[0].reason : null }));
    ck('h3 病态 add 期间绝不产生任何 POST（宁可滞留 audit_pending，也绝不伪造"已发出"）',
      m.state.posts === 0 && m.state.saves === 0 && OUTBOX.pendingCount(D.ctx) === 0,
      JSON.stringify({ posts: m.state.posts, saves: m.state.saves, pending: OUTBOX.pendingCount(D.ctx) }));
  }

  // ============================================================ G. 脱敏
  {
    const files = [];
    const walk = (dir) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.jsonl$/.test(e.name)) files.push(p); }
    };
    walk(path.join(ROOT, 'state'));
    const jsonlText = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    // event 行的 metrics.sha256 是**契约规定**的完整摘要（中控落库时自行截取 12 位前缀），单独核准后从脱敏扫描中屏蔽
    let shaContractOnly = true;
    for (const line of jsonlText.split('\n').filter(Boolean)) {
      let l = null; try { l = JSON.parse(line); } catch { continue; }
      if (l.type !== 'event' || !l.event) continue;
      for (const [k, v] of Object.entries(l.event.metrics || {})) {
        if (k === 'sha256') continue;
        if (/[0-9a-fA-F]{64}/.test(String(v))) shaContractOnly = false;
      }
    }
    const masked = jsonlText.replace(/"sha256":"[0-9a-fA-F]{64}"/g, '"sha256":"[by_contract_digest]"');
    const dumps = [
      ['套件输出', JSON.stringify(out.checks)],
      ['接线摘要与 posts_log', JSON.stringify(MOCKS.map((m) => m.summary()))],
      ['JSONL 终态行（sha256 契约字段已屏蔽）', masked],
      ['mock 收到的载荷（事件字段，契约 sha256 已屏蔽）', JSON.stringify(MOCKS.flatMap((m) => m.state.payloads).map((p) => p.map((e) => (e ? { stage: e.stage, seq: e.seq, is_test: e.is_test, task_id: e.task_id, metrics: e.metrics && e.metrics.sha256 ? Object.assign({}, e.metrics, { sha256: '[by_contract_digest]' }) : e.metrics } : null))))],
    ];
    const LEAK = [
      ['secret', null], ['abs_unix', /\/(?:home|opt|etc|var|root|tmp|usr)\//], ['abs_win', /[A-Za-z]:\\/],
      ['jwt', /eyJ[A-Za-z0-9_-]{10,}\./], ['cookie', /"cookie"/i], ['password', /"pass(word|wd)?"/i],
      ['hmac', /"hmac"/i], ['signature', /"signature"/i], ['sha256_full', /[0-9a-fA-F]{64}/],
      ['base64_run', /[A-Za-z0-9+/]{40,}={0,2}/], ['private_key', /PRIVATE KEY/],
    ];
    const leaks = [];
    for (const [name, dump] of dumps) {
      if (dump.includes(SECRET)) leaks.push(name + ':secret_value');
      for (const [label, re] of LEAK) { if (re && re.test(dump)) leaks.push(name + ':' + label); }
    }
    ck('g1 全部输出（套件输出 / 摘要 / JSONL / 载荷）无密钥、HMAC、JWT、Cookie、口令、base64、绝对路径、完整 SHA', leaks.length === 0, JSON.stringify(leaks));
    ck('g2 唯一例外已核准：event.metrics.sha256 是契约字段（中控落库时截取 12 位前缀），其余字段绝无 64 位摘要',
      shaContractOnly === true, JSON.stringify({ sha_contract_only: shaContractOnly }));
    ck('g3 套装自证：未接触真实 3456 / 未写真实审计库 / 未访问美团 / 未导入导出推送 / 未建 timer',
      out.real_3456_touched === false && out.real_audit_db_written === false && out.real_meituan_run === false &&
      out.real_export === false && out.real_download === false && out.real_import === false && out.real_push === false && out.timers_created === false,
      JSON.stringify({ real_3456_touched: out.real_3456_touched, real_audit_db_written: out.real_audit_db_written }));
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
  const fatalOut = { ok: false, fatal: String((e && e.stack) || e).slice(0, 600), checks: out.checks };
  if (process.env.P3_OUT) { try { fs.writeFileSync(process.env.P3_OUT, JSON.stringify(fatalOut, null, 2), 'utf8'); } catch (_) {} }
  console.log(JSON.stringify(fatalOut, null, 2));
  process.exit(9);
});
