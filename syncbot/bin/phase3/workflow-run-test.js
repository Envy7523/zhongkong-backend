#!/usr/bin/env node
'use strict';
/**
 * 全链路总编排入口 · **纯离线 fixture / fake adapter 套件**
 *
 * 边界：下载用**真实编排器 + fake adapters**（不访问美团、不导出、不下载），导入用**随机端口 mock 中控**。
 *
 * **data-only 收口断言**：本入口只做「导出/归档/校验 → 导入项目数据库」，
 * 成功终点是 IMPORT_SUCCEEDED → COMPLETED；**不存在推送阶段**：
 *   · workflow 不装配/不调用/不接受 push adapter（传 stagePush 直接拒绝）；
 *   · 全程不读 webhook/token，不产生任何 PUSH_* 审计事件；
 *   · 套件里创建的 fake sender **调用次数必须恒为 0**（含成功、失败、崩溃恢复所有路径）；
 *   · 缺 sender 不阻塞下载与导入。
 * 上午 9 点日报推送归**项目现有机器人**（中控侧，持有企业微信 webhook）。不建 timer、不重启服务；报表 B 保持锁定。
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p5wf-'));
process.env.SYNCBOT_ROOT = ROOT;

const BOT = process.env.SYNCBOT_BOT || '/opt/zhongkong-sync-bot';
const P = require(BOT + '/app/src/paths.js');
const TC = require(BOT + '/app/src/task-context.js');
const state = require(BOT + '/app/src/state.js');
const lock = require(BOT + '/app/src/lock.js');
const IC = require(BOT + '/app/src/phase3/import-client.js');
const OUTBOX = require(BOT + '/app/src/phase3/audit-outbox.js');
const WIRING = require(BOT + '/app/src/phase3/real-download-audit.js');
const RUNMOD = require(BOT + '/app/src/phase3/import-run.js');
const WFMOD = require(BOT + '/app/src/phase3/workflow-run.js');
// data-only：本套件**不再** require push-run.js / push-client.js（生产链路无推送调用路径）
const WF_SRC = BOT + '/app/src/phase3/workflow-run.js';
const ADAPTERS_SRC = BOT + '/app/src/phase3/workflow-production-adapters.js';
const { createOrchestrator } = require(BOT + '/app/src/phase2/real-download.js');

const AUDIT_SECRET = crypto.randomBytes(32).toString('hex');
const TOKEN = 'tok-' + crypto.randomBytes(12).toString('hex');
const RUN = 'test-wf-' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');

const out = {
  suite: 'phase5-workflow-fixture', fixture: true, offline: true,
  real_meituan_run: false, real_export: false, real_download: false, real_import: false,
  real_wecom_message_sent: false, real_webhook_read: false, timers_created: false, report_b: 'locked_not_started',
  data_only: true, push_owner: 'project_daily_report_bot（中控侧 9 点日报推送）', push_calls_total: 0,
  test_run_id: RUN, checks: [],
};
const ck = (n, ok, d) => out.checks.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });
/** 去掉注释后看"可执行代码"（静态自检用） */
const stripComments = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

let SEQ = 0;
function nextBD() { SEQ += 1; return new Date(Date.UTC(2026, 9, 1 + SEQ)).toISOString().slice(0, 10); }
const AUDIT_PATH = '/api/internal/syncbot/events';
const LOGIN_PATH = '/api/auth/login';
const IMPORT_PATH = '/api/business-analytics/import';

function createMock() {
  const st = { audit_requests: 0, import_requests: 0, import_modes: [], audit: { accepted: [], duplicates: [], stages: [], batches: [], full_sha_seen: false, unknown_metric_keys: [] } };
  let importMode = 'ok';
  const seen = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = String(req.url || '').split('?')[0];
      if (url === LOGIN_PATH) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, token: TOKEN, user: { id: 9 } })); return; }
      if (url === IMPORT_PATH) {
        st.import_requests += 1;
        st.import_modes.push(importMode);
        if (String(req.headers.authorization || '') !== 'Bearer ' + TOKEN) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '未登录' })); return; }
        if (importMode === 'hang') return;
        if (String(importMode).startsWith('stat:')) { const c2 = Number(String(importMode).split(':')[1]); res.writeHead(c2, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'mock_' + c2 })); return; }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, batch_id: 990001, amount_db: { recorded_amount: 12345.67 }, amount_basis: { scope: 'import_batch_id', mappings: [ { file_column: '营业收入(元)', db_column: 'recorded_amount' }, { file_column: '营业额(元)', db_column: 'gross_amount' }, { file_column: '优惠金额(元)', db_column: 'discount_amount' } ] }, data_kind: 'cashier_composite', imported: 154, raw_imported: 22, matched_stores: 22, skipped: 0, errors: [], resolved_channels: ['店内销售'], income_composition_fields: ['美团团购'] }));
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
        const accepted = []; const duplicates = []; const batchSeen = new Set();
        for (const e of events) {
          if (seen.has(e.event_id) || batchSeen.has(e.event_id)) duplicates.push(e.event_id); else { accepted.push(e.event_id); batchSeen.add(e.event_id); }
          const mm = (e && e.metrics) || {};
          for (const [k, v] of Object.entries(mm)) { if (k === 'sha256' && String(v || '').length > 12) st.audit.full_sha_seen = true; }
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
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' }));
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
    setImport(m) { importMode = m; },
    async stop() { await new Promise((r) => server.close(r)); },
  };
}

let SENDER_CALLS = 0;   // data-only：任何路径下都必须保持 0
function createFakeSender(mode = 'ok') {
  const rec = { calls: 0, payloads: [], mode, state_at_send: null, stateFileGetter: null };
  return {
    rec, setMode(m) { rec.mode = m; }, watchStateFile(fn) { rec.stateFileGetter = fn; },
    async send(payload) {
      rec.calls += 1; SENDER_CALLS += 1; rec.payloads.push(JSON.parse(JSON.stringify(payload)));
      if (rec.stateFileGetter) { try { rec.state_at_send = (JSON.parse(fs.readFileSync(rec.stateFileGetter(), 'utf8')).workflow || {}).stages; } catch { rec.state_at_send = 'READ_ERROR'; } }
      if (rec.mode === 'hang') return new Promise(() => {});
      if (rec.mode === 'throw') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      if (String(rec.mode).startsWith('stat:')) return { ok: false, http: Number(String(rec.mode).split(':')[1]), error: 'mock_wecom' };
      return { ok: true, http: 200, message_id: 'msg-' + crypto.randomBytes(6).toString('hex') };
    },
  };
}

// ---------------------------------------------------------------- 下载阶段：真实编排器 + fake adapters
function makeDownloadStage({ ctx, mock, failAt = null, secretFile = null }) {
  const audit = WIRING.createRealDownloadAudit({ ctx, opts: { secretFile: secretFile || mock.auditSecretFile, timeoutMs: 3000, testRunId: RUN } });
  const counts = { precheck: 0, query: 0, export: 0, passive: 0, download: 0, archive: 0, validate: 0 };
  const TMP = fs.mkdtempSync(path.join(ROOT, 'fx-'));
  let last = null;
  const store = { load: () => last, save: audit.wrapSave((v) => { last = JSON.parse(JSON.stringify(v)); }) };
  const picked = ctx.businessDate.replace(/-/g, '/');
  const future = () => new Date(Date.now() + 3600000).toISOString().slice(0, 19).replace('T', ' ');
  // 归档文件必须落在**真实归档目录**（downloads/meituan/cashier_composite/<date>/）——导入阶段的归档闸门会校验这一点
  const dayDir = P.dayDownloads('meituan', 'cashier_composite', ctx.businessDate);
  P.ensureDir(dayDir);
  const archived = path.join(dayDir, '美团_综合营业统计_' + ctx.businessDate + '.xlsx');
  const sha = crypto.createHash('sha256').update('ARCHIVE-' + ctx.businessDate).digest('hex');
  const adapters = {
    precheck: async () => { counts.precheck += 1; return failAt === 'precheck' ? { ok: false, reason: '前置校验未通过：页面元素缺失' } : { ok: true }; },
    probeDownloadList: async () => ({ ok: true }),
    navigateAndQuery: async () => { counts.query += 1; return failAt === 'query' ? { ok: false, reason: '查询校验未通过：行数与声明不符' } : { ok: true, declared_count: 22 }; },
    submitExport: async () => { counts.export += 1; return failAt === 'export' ? { ok: false, reason: '导出提交失败：对话框未出现' } : { ok: true, dialog_text: '本次导出数据共22条' }; },
    readDownloadRows: async () => ({
      rows: [
        { cells: ['序号'], rect: { x: 0, y: 0, w: 1, h: 1 }, controls: [] },
        { cells: ['1', '报表中心', '综合营业统计(营业日期【' + picked + '-' + picked + '】)', 'LongXia', future(), future(), '导出完成', '下载'], rect: { x: 0, y: 20, w: 100, h: 20 }, controls: [{ text: '下载', selector: '#d', rect: { x: 20, y: 24, w: 20, h: 12 } }] },
      ],
    }),
    waitForPassiveFile: async () => { counts.passive += 1; return failAt === 'download' ? { ok: false, reason: '被动下载等待超时 120s' } : { ok: true, file: archived, name: 'archived.xlsx', size: 24952, elapsed_ms: 12 }; },
    observeDownloadList: async () => ({ ok: true, read_only: true, outcome: 'wait', detail: '只读观察', clicked: false }),
    downloadFile: async () => { counts.download += 1; return { ok: true, file: archived, suggested_name: 'archived.xlsx' }; },
    archive: async () => { counts.archive += 1; if (failAt === 'archive') return { ok: false, reason: '归档失败：目标目录不可写' }; fs.writeFileSync(archived, 'ARCHIVE-' + ctx.businessDate); return { ok: true, archived_path: archived, archived_name: path.basename(archived), size: fs.statSync(archived).size, sha256: sha }; },
    validateFile: async () => { counts.validate += 1; return failAt === 'validate' ? { ok: false, errors: ['行数不符'] } : { ok: true, checks: {} }; },
    screenshot: async () => ({ ok: true }), setApprovals: async () => {}, resetApprovals: async () => {},
  };
  const orch = createOrchestrator({ ctx, store, adapters, sleep: async () => {}, wait: { initialWaitMs: 0, pollIntervalMs: 0, maxWaitMs: 3 } });
  return {
    counts, audit,
    async run() {
      const r = await orch.run({ applicant: 'LongXia' });
      await audit.whenIdle({ timeoutMs: 60000 });
      const phaseList = Array.isArray(r.phases) ? r.phases : [];
      const exportSubmitted = phaseList.some((x) => x && x.phase === 'EXPORT_SUBMITTED' && x.ok === true);
      if (r.ok === true && r.result === 'FILE_VALIDATED') fs.writeFileSync(archived, 'ARCHIVE-' + ctx.businessDate);
      return {
        ok: r.ok === true && r.result === 'FILE_VALIDATED', result: r.result, phase: r.result,
        export_submitted: exportSubmitted, failure_reason: r.error || null,
        file: archived, sha256: sha, size: (fs.existsSync(archived) ? fs.statSync(archived).size : 0),
        validation: { ok: true, checks: { row2_metadata: { ok: true, items: [{ name: '营业日期=目标日期', ok: true }] } }, store_count: 22 },
      };
    },
  };
}

const EVIDENCE = (bd) => ({ excelBusinessDate: bd, amountExcel: 12345.67, amountDb: 12345.67 });
function makeImportStage({ mock, bd, secretFile = null }) {
  return {
    async runOnce({ ctx, g3, download }) {
      const run = RUNMOD.createImportRun({ ctx, opts: { secretFile: secretFile || mock.auditSecretFile, timeoutMs: 3000, testRunId: RUN, clientOpts: { token: TOKEN, baseUrl: mock.baseUrl, timeoutMs: 3000 } } });
      // 恢复场景：上一次进程的返回值不可得 → 从**归档目录 + 归档元数据**重新解析已归档文件（真实边界同样如此）
      let file = download && download.file;
      if (!file) {
        const dir = P.dayDownloads('meituan', 'cashier_composite', bd);
        const cands = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(xlsx|xls|csv)$/i.test(f)).sort() : [];
        if (cands.length) file = path.join(dir, cands[cands.length - 1]);
      }
      const sha = file && fs.existsSync(file) ? IC.sha256OfBuffer(fs.readFileSync(file)) : null;
      const size = file && fs.existsSync(file) ? fs.statSync(file).size : null;
      const validation = (download && download.validation) || { ok: true, checks: { row2_metadata: { ok: true, items: [{ name: '营业日期=目标日期', ok: true }] } }, store_count: 22 };
      return run.runOnce({
        file, validation,
        evidence: EVIDENCE(bd), archiveSha256: sha,
        archive: { file, sha256: sha, size, report_type: 'cashier_composite', platform: 'meituan', business_date: bd },
        task: { task_id: ctx.taskId, report_type: 'cashier_composite', platform: 'meituan', business_date: bd },
        coverageGate: async () => g3, duplicateCheck: async () => ({ duplicate: false }), validateFile: async () => ({ ok: true }),
      });
    },
  };
}
function makeWorkflow({ mock, bd, taskId, sender, failAt = null, g1 = true, g3 = true, importMode = 'ok', auditSecretFile = null, backfill = false, confirm = true, reuseStage = null }) {
  mock.setImport(importMode);
  if (sender) sender.watchStateFile(() => stateFileOf(bd));
  const ctx = TC.createContext('cashier_composite', { platform: 'meituan', taskId, businessDate: bd });
  const dl = reuseStage || makeDownloadStage({ ctx, mock, failAt, secretFile: auditSecretFile });
  const wf = WFMOD.createWorkflowRun({
    reportType: 'cashier_composite', businessDate: bd, platform: 'meituan', taskId, confirm, backfill,
    gates: {
      g1: async () => (g1 === 'hit' ? { ok: false, coverage_hit: true } : g1 === 'fail' ? { ok: false, coverage_hit: false } : { ok: true }),
      g3: async () => (g3 === 'hit' ? { ok: false, coverage_hit: true } : g3 === 'fail' ? { ok: false, coverage_hit: false } : { ok: true }),
    },
    stageDownload: dl,
    stageImport: makeImportStage({ mock, bd, secretFile: auditSecretFile }),
    // data-only：**没有** stagePush —— 生产链路不存在推送阶段（sender 仅用于断言"从未被调用"）
    outbox: OUTBOX,
  });
  return { wf, dl, ctx };
}
const stateFileOf = (bd) => P.taskStateFile('meituan', 'cashier_composite', bd);
const readStateOf = (bd) => { try { return JSON.parse(fs.readFileSync(stateFileOf(bd), 'utf8')); } catch { return null; } };
const wfOf = (bd) => (readStateOf(bd) || {}).workflow || {};

(async () => {
  const mock = await createMock().start();

  // ============================================================ A. 完整成功路径
  const success = {};
  {
    const bd = nextBD();
    const taskId = RUN + '-a';
    const sender = createFakeSender('ok');
    const { wf, dl } = makeWorkflow({ mock, bd, taskId, sender });
    const beforeImport = mock.state.import_requests;
    const r = await wf.runOnce({});
    const st = readStateOf(bd);
    const w = st.workflow;
    const httpImport = mock.state.import_requests - beforeImport;
    success.bd = bd; success.taskId = taskId; success.sender = sender; success.wf = wf;
    ck('a1 完整成功路径：G1 → 下载/归档/校验 → G3 → 导入 → IMPORT_SUCCEEDED，workflow 终态 COMPLETED（data-only，无推送阶段）',
      r.ok === true && r.action === 'COMPLETED' && w.status === 'success' && w.phase === 'COMPLETED' && w.terminal === true,
      JSON.stringify({ action: r.action, status: w.status, phase: w.phase }));
    ck('a2 各阶段调用次数：下载 1 / 导入 1 / **推送恒为 0**（stage_calls 无 push 键、无 push 阶段、sender 0 次）',
      r.stage_calls.download === 1 && r.stage_calls.import === 1 && r.stage_calls.push === undefined && r.push_calls === 0 &&
      w.stages.download.status === 'success' && w.stages.import.status === 'success' && w.stages.push === undefined && sender.rec.calls === 0,
      JSON.stringify({ calls: r.stage_calls, push_calls: r.push_calls, stages: Object.keys(w.stages), sends: sender.rec.calls }));
    ck('a3 导出只提交 1 次；归档/文件校验各 1 次；下载动作 0 次（被动下载）',
      dl.counts.export === 1 && dl.counts.archive === 1 && dl.counts.validate === 1 && dl.counts.download === 0 && dl.counts.precheck === 1 && dl.counts.query === 1,
      JSON.stringify(dl.counts));
    ck('a4 导入 HTTP 恰好 1 次；**推送发送调用 0 次**（本入口不装配任何 sender）',
      httpImport === 1 && sender.rec.calls === 0 && w.stages.import.http_requests === 1 && w.stages.push === undefined,
      JSON.stringify({ import_http: httpImport, sends: sender.rec.calls, state_import_http: w.stages.import.http_requests }));
    ck('a5 一个业务日期一个持久化 task_id（= 传入值），且 workflow 只有 download/import 两段状态',
      w.task_id === taskId && w.business_date === bd && w.report_type === 'cashier_composite' &&
      ['download', 'import'].every((k) => w.stages[k] && w.stages[k].status) && Object.keys(w.stages).sort().join(',') === 'download,import',
      JSON.stringify({ task_id_matches: w.task_id === taskId, business_date: w.business_date, stages: Object.keys(w.stages) }));
    const stages = mock.state.audit.stages;
    const wantDl = ['PRECHECK', 'QUERY_DONE', 'EXPORT_SUBMITTED', 'WAITING_EXPORT', 'DOWNLOADED', 'FILE_VALIDATED'];
    const pushStages = stages.filter((s) => /^PUSH_/.test(String(s)));
    ck('a6 审计时间线：下载 6 阶段 + 导入 2 阶段，**终点是 IMPORT_SUCCEEDED、全程零 PUSH_* 事件**',
      wantDl.every((s) => stages.includes(s)) && stages.includes('IMPORT_STARTED') && stages.includes('IMPORT_SUCCEEDED') &&
      stages[stages.length - 1] === 'IMPORT_SUCCEEDED' && pushStages.length === 0,
      JSON.stringify({ received: Array.from(new Set(stages)).slice(-12), last: stages[stages.length - 1], push_stages: pushStages }));
    ck('a7 锁已释放（业务日期锁文件不存在）', !fs.existsSync(P.lockFile(wf.lockName, 'cashier_composite')),
      JSON.stringify({ lock: wf.lockName }));
    ck('a8 导入成功后顶层 push 仍非 success、ready_to_push=true（把推送留给项目侧 9 点日报任务），import=success、validate_import=passed',
      st.ready_to_push === true && st.import.status === 'success' && st.validate_import.status === 'passed' && !(st.push && st.push.status === 'success'),
      JSON.stringify({ top: { import: st.import.status, validate_import: st.validate_import.status, push: st.push ? st.push.status : null, ready: st.ready_to_push } }));
    out.summary = Object.assign(out.summary || {}, {
      success_timeline: r.timeline.map((t) => t.step),
      success_state: { phase: w.phase, status: w.status, stages: { d: w.stages.download.status, i: w.stages.import.status },
        push_stage: w.stages.push === undefined ? 'absent' : w.stages.push.status,
        export_submitted: w.stages.download.export_submitted, import_http: w.stages.import.http_requests, push_calls: 0, sends: sender.rec.calls },
      audit_stages: Array.from(new Set(stages)), audit_last_stage: stages[stages.length - 1],
      data_only: true, push_owner: 'project_daily_report_bot',
    });
  }

  // ============================================================ B. 下载各失败点 → 导入/推送调用 0
  {
    const points = [['b1', 'precheck'], ['b2', 'query'], ['b3', 'export'], ['b4', 'download'], ['b5', 'validate'], ['b6', 'archive']];
    for (const [tag, failAt] of points) {
      const bd = nextBD();
      const taskId = RUN + '-' + tag;
      const sender = createFakeSender('ok');
      const { wf, dl } = makeWorkflow({ mock, bd, taskId, sender, failAt });
      const beforeImport = mock.state.import_requests;
      const r = await wf.runOnce({});
      const w = wfOf(bd);
      ck(tag + ' 下载失败点 ' + failAt + ' → 导入 HTTP=0、推送发送=0、workflow 转人工',
        (mock.state.import_requests - beforeImport) === 0 && sender.rec.calls === 0 &&
        r.action === 'WAITING_HUMAN' && w.stages.download.status === 'failed' && w.stages.import.status === 'pending' && w.stages.push === undefined &&
        w.stages.download.export_submitted === (failAt === 'download' || failAt === 'validate' || failAt === 'archive'),
        JSON.stringify({ import_http: mock.state.import_requests - beforeImport, sends: sender.rec.calls, action: r.action,
          export_submitted: w.stages.download.export_submitted, reason: w.failure_reason }));
    }
    // b7：已提交过导出的下载失败再跑 → 拒绝（不得二次导出）
    const bd = nextBD();
    const taskId = RUN + '-b7';
    const sender = createFakeSender('ok');
    const { wf, dl } = makeWorkflow({ mock, bd, taskId, sender, failAt: 'download' });
    await wf.runOnce({});
    const exportCalls1 = dl.counts.export;
    const { wf: wfB } = makeWorkflow({ mock, bd, taskId, sender, failAt: 'download', reuseStage: dl });   // 新实例（跨进程语义）
    const r2 = await wfB.runOnce({});
    ck('b7 已提交过导出的下载失败：再次运行**不再二次导出**（0 次导出、0 次导入、0 次发送）',
      dl.counts.export === exportCalls1 && r2.stage_calls.download === 0 && r2.action === 'WAITING_HUMAN' &&
      String(r2.reason).indexOf('download_previously_submitted_export') === 0,
      JSON.stringify({ export_calls: dl.counts.export, action: r2.action, reason: r2.reason }));
  }

  // ============================================================ C. G1 / G3 覆盖命中
  {
    const bd1 = nextBD();
    const s1 = createFakeSender('ok');
    const { wf: w1, dl: d1 } = makeWorkflow({ mock, bd: bd1, taskId: RUN + '-c1', sender: s1, g1: 'hit' });
    const before1 = mock.state.import_requests;
    const r1 = await w1.runOnce({});
    ck('c1 G1 覆盖命中 → 下载/导入/推送调用均为 0（export=0、HTTP=0、发送=0）',
      r1.action === 'WAITING_HUMAN' && r1.stage_calls.download === 0 && r1.stage_calls.import === 0 && r1.stage_calls.push === undefined &&
      d1.counts.export === 0 && s1.rec.calls === 0 && (mock.state.import_requests - before1) === 0 && wfOf(bd1).g1.coverage_hit === true,
      JSON.stringify({ calls: r1.stage_calls, export: d1.counts.export, sends: s1.rec.calls }));

    const bd2 = nextBD();
    const s2 = createFakeSender('ok');
    const { wf: w2, dl: d2 } = makeWorkflow({ mock, bd: bd2, taskId: RUN + '-c2', sender: s2, g3: 'hit' });
    const before2 = mock.state.import_requests;
    const r2 = await w2.runOnce({});
    ck('c2 G3 覆盖命中 → 下载执行 1 次（导出 1 次）但导入 HTTP=0、推送发送=0',
      r2.action === 'WAITING_HUMAN' && d2.counts.export === 1 && (mock.state.import_requests - before2) === 0 && s2.rec.calls === 0 &&
      r2.stage_calls.import === 0 && r2.stage_calls.push === undefined && wfOf(bd2).g3.coverage_hit === true,
      JSON.stringify({ export: d2.counts.export, import_http: mock.state.import_requests - before2, sends: s2.rec.calls, calls: r2.stage_calls }));
    // c3 G3 闸门未配置 → fail-closed
    const bd3 = nextBD();
    const s3 = createFakeSender('ok');
    const { wf: w3, dl: d3 } = makeWorkflow({ mock, bd: bd3, taskId: RUN + '-c3', sender: s3, g3: 'fail' });
    const before3 = mock.state.import_requests;
    const r3 = await w3.runOnce({});
    ck('c3 G3 闸门失败（fail-closed）→ 导入 HTTP=0、推送发送=0',
      r3.action === 'WAITING_HUMAN' && d3.counts.export === 1 && (mock.state.import_requests - before3) === 0 && s3.rec.calls === 0,
      JSON.stringify({ export: d3.counts.export, import_http: mock.state.import_requests - before3, sends: s3.rec.calls }));
  }

  // ============================================================ D. 导入 4xx/5xx/超时 → 推送 0
  {
    for (const [tag, mode, want] of [['d1', 'stat:400', 'import_http_4xx'], ['d2', 'stat:500', 'import_http_5xx'], ['d3', 'hang', 'import_timeout']]) {
      const bd = nextBD();
      const taskId = RUN + '-' + tag;
      const sender = createFakeSender('ok');
      const { wf, dl } = makeWorkflow({ mock, bd, taskId, sender, importMode: mode });
      const before = mock.state.import_requests;
      const r = await wf.runOnce({});
      const w = wfOf(bd);
      ck(tag + ' 导入 ' + mode + '（' + want + '）→ 导出 1 次、导入 HTTP 恰好 1 次、推送发送 0 次',
        dl.counts.export === 1 && (mock.state.import_requests - before) === 1 && sender.rec.calls === 0 &&
        r.action === 'WAITING_HUMAN' && w.stages.import.status === 'failed' && w.stages.push === undefined,
        JSON.stringify({ export: dl.counts.export, import_http: mock.state.import_requests - before, sends: sender.rec.calls, import_status: w.stages.import.status }));
    }
    mock.setImport('ok');
  }

  // ============================================================ E. data-only：生产链路里根本不存在推送阶段
  {
    // e1 直接给 workflow 传 stagePush → 参数白名单当场拒绝（不是"忽略它照跑"）
    let rejPush = null;
    try {
      WFMOD.createWorkflowRun({ reportType: 'cashier_composite', businessDate: '2026-11-01',
        stagePush: { runOnce: async () => ({ ok: true, action: 'PUSH_SUCCEEDED', send_calls: 1 }) } });
    } catch (e) { rejPush = String(e && e.message); }
    ck('e1 传入 stagePush（push adapter）→ 构造即拒绝：生产 workflow 不得装配 push adapter',
      !!rejPush && rejPush.indexOf('stagePush') >= 0, JSON.stringify({ rejected: rejPush ? rejPush.slice(0, 90) : null }));

    // e2 静态自检：workflow-run.js **代码**中不出现任何推送字样（注释除外）
    const wfCode = stripComments(fs.readFileSync(WF_SRC, 'utf8'));
    const pushRe = /push-run|push-client|PUSH_SUCCEEDED|PUSH_FAILED|qyapi\.weixin\.qq\.com|webhook|corpsecret|\bsender\b/i;
    const pushHit = wfCode.match(pushRe);
    ck('e2 静态自检：workflow-run.js 代码中零推送字样（无 push-run/push-client/PUSH_*/webhook/corpsecret/sender）',
      !pushHit, JSON.stringify({ hit: pushHit ? String(pushHit[0]).slice(0, 40) : null }));

    // e3 成功路径：fake sender 已创建但**从未被装配**，调用次数必须为 0
    const bdE = nextBD();
    const sE = createFakeSender('ok');
    const { wf: wE, dl: dE } = makeWorkflow({ mock, bd: bdE, taskId: RUN + '-e3', sender: sE });
    const rE = await wE.runOnce({});
    const wE2 = wfOf(bdE);
    ck('e3 data-only 成功路径：导出 1 次 / 导入 1 次 / sender 0 次 / 无 push 阶段 / 终态 COMPLETED',
      rE.action === 'COMPLETED' && dE.counts.export === 1 && sE.rec.calls === 0 && wE2.stages.push === undefined &&
      wE2.phase === 'COMPLETED' && Object.keys(wE2.stages).sort().join(',') === 'download,import',
      JSON.stringify({ action: rE.action, export: dE.counts.export, sends: sE.rec.calls, stages: Object.keys(wE2.stages) }));

    // e4 完全不提供 sender → 缺 sender **不阻塞**下载与导入
    const bdE4 = nextBD();
    const { wf: wE4, dl: dE4 } = makeWorkflow({ mock, bd: bdE4, taskId: RUN + '-e4' });   // 不传 sender
    const rE4 = await wE4.runOnce({});
    ck('e4 项目侧不存在 sender 时：导出 1 / 导入 1 / COMPLETED（缺 sender 不阻塞数据链路）',
      rE4.action === 'COMPLETED' && dE4.counts.export === 1 && rE4.stage_calls.import === 1 && rE4.stage_calls.push === undefined &&
      wfOf(bdE4).status === 'success' && wfOf(bdE4).stages.push === undefined,
      JSON.stringify({ action: rE4.action, export: dE4.counts.export, calls: rE4.stage_calls }));
  }

  // ============================================================ F. 崩溃恢复
  {
    // f1 完整成功后再跑：0 导出 / 0 导入 / 0 发送
    const { bd, taskId, sender, wf, dl } = { bd: success.bd, taskId: success.taskId, sender: success.sender, wf: success.wf, dl: null };
    const exp = null;
    const bdF = nextBD();
    const sF = createFakeSender('ok');
    const { wf: wF, dl: dF } = makeWorkflow({ mock, bd: bdF, taskId: RUN + '-f1', sender: sF });
    const first = await wF.runOnce({});
    const afterFirst = { export: dF.counts.export, import: mock.state.import_requests, sends: sF.rec.calls };
    const dupBefore = mock.state.audit.duplicates.length;
    const second = await wF.runOnce({});
    ck('f1 已完成的全链路再次运行 → 0 导出 / 0 导入 HTTP / 0 发送；workflow 拒绝并只做审计补送',
      first.action === 'COMPLETED' && second.action === 'WAITING_HUMAN' && String(second.reason).indexOf('workflow_already_completed') === 0 &&
      dF.counts.export === afterFirst.export && mock.state.import_requests === afterFirst.import && sF.rec.calls === afterFirst.sends &&
      second.stage_calls.download === 0 && second.stage_calls.import === 0 && second.stage_calls.push === undefined,
      JSON.stringify({ first: first.action, second: second.action, reason: second.reason, calls: second.stage_calls }));

    // f2 中途恢复：下载已完成、导入未开始 → 跳过下载（0 导出），继续导入与推送
    const bdF2 = nextBD();
    const sF2 = createFakeSender('ok');
    const { wf: wF2, dl: dF2 } = makeWorkflow({ mock, bd: bdF2, taskId: RUN + '-f2', sender: sF2 });
    const beforeImport = mock.state.import_requests;
    // 造"下载阶段已完成、进程随后崩溃"的现场：归档文件已落盘 + 持久化状态记录了下载完成
    const dlDir = P.dayDownloads('meituan', 'cashier_composite', bdF2);
    P.ensureDir(dlDir);
    fs.writeFileSync(path.join(dlDir, '美团_综合营业统计_' + bdF2 + '.xlsx'), 'ARCHIVE-' + bdF2);
    state.patch('meituan', bdF2, 'workflow', {
      task_id: RUN + '-f2', report_type: 'cashier_composite', platform: 'meituan', business_date: bdF2,
      phase: 'DOWNLOAD_DONE', failure_reason: null, terminal: false,
      stages: { download: { status: 'success', attempts: 1, export_submitted: true, phase: 'FILE_VALIDATED' }, import: { status: 'pending', attempts: 0 } },
    }, { status: 'running', reportType: 'cashier_composite' });
    const rF2 = await wF2.runOnce({});
    ck('f2 中途崩溃恢复：下载阶段已完成 → **跳过下载（0 次导出）**，导入 HTTP 1 次、推送 0 次，最终 COMPLETED',
      dF2.counts.export === 0 && (mock.state.import_requests - beforeImport) === 1 && sF2.rec.calls === 0 &&
      rF2.action === 'COMPLETED' && rF2.stage_calls.download === 0 && rF2.stage_calls.import === 1 && rF2.stage_calls.push === undefined,
      JSON.stringify({ export: dF2.counts.export, import_http: mock.state.import_requests - beforeImport, sends: sF2.rec.calls, calls: rF2.stage_calls, action: rF2.action, reason: rF2.reason }));

    // f3 阶段停在 running（结果未知）→ 拒绝并转人工（0 调用）
    //    data-only 下唯一可能的"结果未知"阶段是 download / import（不存在 push 阶段）
    const bdF3 = nextBD();
    const sF3 = createFakeSender('ok');
    const { wf: wF3, dl: dF3 } = makeWorkflow({ mock, bd: bdF3, taskId: RUN + '-f3', sender: sF3 });
    state.patch('meituan', bdF3, 'workflow', {
      task_id: RUN + '-f3', report_type: 'cashier_composite', platform: 'meituan', business_date: bdF3,
      phase: 'DOWNLOAD_RUNNING', terminal: false,
      stages: { download: { status: 'running', attempts: 1, export_submitted: false }, import: { status: 'pending', attempts: 0 } },
    }, { status: 'running', reportType: 'cashier_composite' });
    const rF3 = await wF3.runOnce({});
    ck('f3 下载阶段停在 running（结果未知）→ **0 调用**、WAITING_HUMAN、不二次导出、0 发送',
      rF3.action === 'WAITING_HUMAN' && String(rF3.reason).indexOf('workflow_stage_in_flight_uncertain:download') === 0 &&
      rF3.stage_calls.download === 0 && rF3.stage_calls.import === 0 && rF3.stage_calls.push === undefined &&
      dF3.counts.export === 0 && sF3.rec.calls === 0,
      JSON.stringify({ action: rF3.action, reason: rF3.reason, calls: rF3.stage_calls, sends: sF3.rec.calls }));

    // f4 导入停在 running（结果未知）→ 导入 0 HTTP、推送 0
    const bdF4 = nextBD();
    const sF4 = createFakeSender('ok');
    const { wf: wF4, dl: dF4 } = makeWorkflow({ mock, bd: bdF4, taskId: RUN + '-f4', sender: sF4 });
    state.patch('meituan', bdF4, 'workflow', {
      task_id: RUN + '-f4', report_type: 'cashier_composite', platform: 'meituan', business_date: bdF4,
      phase: 'DOWNLOAD_DONE', terminal: false,
      stages: { download: { status: 'success', attempts: 1, export_submitted: true }, import: { status: 'pending', attempts: 0 } },
    }, { status: 'running', reportType: 'cashier_composite' });
    state.patch('meituan', bdF4, 'import', { status: 'running', phase: 'IMPORT_STARTED', attempts: 1, task_id: RUN + '-f4' }, { status: 'running', reportType: 'cashier_composite' });
    const beforeI4 = mock.state.import_requests;
    const rF4 = await wF4.runOnce({});
    ck('f4 导入停在 running（可能已发出、结果未知）→ 导入 HTTP=0、推送发送=0、转人工',
      (mock.state.import_requests - beforeI4) === 0 && sF4.rec.calls === 0 && rF4.action === 'WAITING_HUMAN' && dF4.counts.export === 0,
      JSON.stringify({ import_http: mock.state.import_requests - beforeI4, sends: sF4.rec.calls, action: rF4.action, reason: rF4.reason }));
  }

  // ============================================================ G. 审计不可达
  {
    const bd = nextBD();
    const taskId = RUN + '-g';
    const sender = createFakeSender('ok');
    const down = path.join(ROOT, 'audit-down.json');
    fs.writeFileSync(down, JSON.stringify({ secret: AUDIT_SECRET, endpoint: 'http://127.0.0.1:9' + AUDIT_PATH }), { mode: 0o600 });
    const { wf, dl } = makeWorkflow({ mock, bd, taskId, sender, auditSecretFile: down });
    const before = mock.state.import_requests;
    const r = await wf.runOnce({});
    const w = wfOf(bd);
    ck('g1 审计不可达：数据链路照常（导出 1、导入 HTTP 1、发送 0），状态仍 COMPLETED，事件只进 outbox pending',
      r.action === 'COMPLETED' && dl.counts.export === 1 && (mock.state.import_requests - before) === 1 && sender.rec.calls === 0 &&
      w.status === 'success' && OUTBOX.pendingCount(TC.createContext('cashier_composite', { platform: 'meituan', taskId, businessDate: bd })) > 0,
      JSON.stringify({ action: r.action, export: dl.counts.export, import_http: mock.state.import_requests - before, sends: sender.rec.calls,
        pending: OUTBOX.pendingCount(TC.createContext('cashier_composite', { platform: 'meituan', taskId, businessDate: bd })) }));
    // g2 重跑：不得重发消息/重复导入
    const r2 = await wf.runOnce({});
    ck('g2 审计不可达 + 重跑：仍 0 导出 / 0 导入 / 0 发送（只允许审计补送）',
      r2.stage_calls.download === 0 && r2.stage_calls.import === 0 && r2.stage_calls.push === undefined &&
      dl.counts.export === 1 && (mock.state.import_requests - before) === 1 && sender.rec.calls === 0,
      JSON.stringify({ calls: r2.stage_calls, sends: sender.rec.calls }));
    const ctxG = TC.createContext('cashier_composite', { platform: 'meituan', taskId, businessDate: bd });
    const fl = await OUTBOX.flush({ ctx: ctxG, opts: { secretFile: mock.auditSecretFile, timeoutMs: 3000, testRunId: RUN } });
    ck('g3 审计恢复后用既有 OUTBOX.flush 补送成功（业务侧无任何重发）',
      fl.ok === true && OUTBOX.pendingCount(ctxG) === 0 && sender.rec.calls === 0 && dl.counts.export === 1,
      JSON.stringify({ flush: fl.delivered, pending: OUTBOX.pendingCount(ctxG) }));
  }

  // ============================================================ H. 拒绝类：报表 B / 非法日期 / 多余参数 / 缺 confirm / backfill
  {
    const mk = (cfg) => { try { WFMOD.createWorkflowRun(cfg); return null; } catch (e) { return String(e && e.message); } };
    const rejB = mk({ reportType: 'item_sales_detail', businessDate: '2026-10-30' });
    ck('h1 报表 B（item_sales_detail）被拒绝，且不创建状态文件', !!rejB && !fs.existsSync(stateFileOf('2026-10-30')),
      JSON.stringify({ rejected: rejB ? rejB.slice(0, 60) : null, report_b: out.report_b }));
    const rejDate1 = mk({ reportType: 'cashier_composite', businessDate: '2026/10/30' });
    const rejDate2 = mk({ reportType: 'cashier_composite' });
    ck('h2 非法业务日期 / 缺业务日期 一律拒绝（禁止推断日期）', !!rejDate1 && !!rejDate2,
      JSON.stringify({ bad_format: !!rejDate1, missing: !!rejDate2 }));
    const rejExtra = mk({ reportType: 'cashier_composite', businessDate: '2026-10-31', sneaky_param: 1 });
    const bdH = nextBD();
    const sH = createFakeSender('ok');
    const { wf: wH } = makeWorkflow({ mock, bd: bdH, taskId: RUN + '-h', sender: sH });
    let rejRun = null;
    try { await wH.runOnce({ extra: 1 }); } catch (e) { rejRun = String(e && e.message); }
    ck('h3 多余参数一律拒绝（构造参数与 runOnce 参数都做白名单校验）', !!rejExtra && !!rejRun,
      JSON.stringify({ config_extra: !!rejExtra, run_extra: !!rejRun }));
    const bdH2 = nextBD();
    const sH2 = createFakeSender('ok');
    const { wf: wH2, dl: dH2 } = makeWorkflow({ mock, bd: bdH2, taskId: RUN + '-h2', sender: sH2, confirm: false });
    const rH2 = await wH2.runOnce({});
    ck('h4 缺少显式 confirm → 拒绝执行（0 下载/0 导入/0 发送）',
      rH2.action === 'WAITING_HUMAN' && rH2.reason === 'confirm_required' && rH2.stage_calls.download === 0 && dH2.counts.export === 0 && sH2.rec.calls === 0,
      JSON.stringify({ action: rH2.action, reason: rH2.reason }));
    const bdH3 = nextBD();
    const sH3 = createFakeSender('ok');
    const { wf: wH3, dl: dH3 } = makeWorkflow({ mock, bd: bdH3, taskId: RUN + '-h3', sender: sH3, backfill: true });
    const rH3 = await wH3.runOnce({});
    ck('h5 historical_backfill → 前置即拒绝（0 下载/0 导入/0 发送），绝不进入真实导入或推送成功路径',
      rH3.action === 'WAITING_HUMAN' && rH3.reason === 'historical_backfill_not_realtime' && rH3.stage_calls.download === 0 &&
      dH3.counts.export === 0 && sH3.rec.calls === 0 && wfOf(bdH3).status !== 'success',
      JSON.stringify({ action: rH3.action, reason: rH3.reason, export: dH3.counts.export, sends: sH3.rec.calls }));
    // h6 并发锁：不同实例、同一业务日期 → 第二次被锁拒绝
    const bdH4 = nextBD();
    const sH4 = createFakeSender('ok');
    const { wf: wH4, ctx: cH4 } = makeWorkflow({ mock, bd: bdH4, taskId: RUN + '-h4', sender: sH4 });
    const held = lock.acquire(wH4.lockName, 'cashier_composite', { meta: { purpose: 'test-hold' } });
    const rH4 = await wH4.runOnce({});
    held.release();
    ck('h6 同一业务日期并发：锁被占用时第二次执行被拒（0 阶段调用）',
      rH4.action === 'WAITING_HUMAN' && rH4.reason === 'workflow_locked' && rH4.stage_calls.download === 0 && sH4.rec.calls === 0,
      JSON.stringify({ action: rH4.action, reason: rH4.reason, lock: wH4.lockName }));
  }

  // ============================================================ I. 脱敏与自证
  {
    const files = [];
    const walk = (dir) => { let e2 = []; try { e2 = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const x of e2) { const p = path.join(dir, x.name); if (x.isDirectory()) walk(p); else files.push(p); } };
    walk(path.join(ROOT, 'state'));
    const allText = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const payloads = JSON.stringify([success.sender.rec.payloads]);
    const LEAK = [/Bearer [A-Za-z0-9._-]{4,}/, /"password"/i, /"authorization"/i, /\/(?:home|opt|etc|var|root|tmp|usr)\//, /[A-Za-z]:\\/,
      /eyJ[A-Za-z0-9_-]{10,}\./, /[0-9a-fA-F]{64}/, /[A-Za-z0-9+/]{40,}={0,2}/];
    const leaks = [];
    for (const re of LEAK) { if (re.test(allText)) leaks.push('state:' + String(re)); if (re.test(payloads)) leaks.push('payload:' + String(re)); }
    ck('i1 workflow 状态文件 / outbox / 推送报文均无敏感信息（无 JWT/口令/Authorization/完整 SHA/绝对路径/base64）',
      leaks.length === 0, JSON.stringify(leaks.slice(0, 4)));
    ck('i2 mock 审计端从未收到完整 SHA（>12 位）',
      mock.state.audit.full_sha_seen === false, JSON.stringify({ full_sha_seen: mock.state.audit.full_sha_seen }));
    ck('i3(a) 生产入口不含推送调用路径：workflow-run / workflow-production-adapters / import-run 均不 require push-run|push-client',
      (() => {
        const files = ['workflow-run.js', 'workflow-production-adapters.js', 'import-run.js'];
        const bad = files.filter((f) => {
          let s = ''; try { s = fs.readFileSync(BOT + '/app/src/phase3/' + f, 'utf8'); } catch { return false; }
          return /require\(\s*['"][^'"]*push-(?:run|client)/.test(stripComments(s));
        });
        return bad.length === 0;
      })(),
      JSON.stringify({ scanned: ['workflow-run.js', 'workflow-production-adapters.js', 'import-run.js'] }));
    const AD = require(ADAPTERS_SRC);
    const pushDep = AD.createWorkflowProductionAdapters({ enable: true, confirmRealWorkflow: true, reportType: 'cashier_composite', businessDate: '2026-11-02',
      deps: { download: () => ({ run: async () => ({}) }), import: () => ({ runOnce: async () => ({}) }), push: () => ({ runOnce: async () => ({}) }) } });
    ck('i3(b) 生产适配器装配：只有 download/import 两段、白名单无 push、传入 push 依赖 → push_adapter_not_allowed',
      AD.ADAPTER_KEYS.join(',') === 'download,import' && !Object.prototype.hasOwnProperty.call(AD.ADAPTER_CALL_WHITELIST, 'push') &&
      pushDep.ok === false && pushDep.reason === 'push_adapter_not_allowed',
      JSON.stringify({ keys: AD.ADAPTER_KEYS, whitelist: Object.keys(AD.ADAPTER_CALL_WHITELIST), push_dep: pushDep }));
    out.push_calls_total = SENDER_CALLS;
    ck('i4 **全程推送侧调用总数为 0**：本套件所有场景（成功/下载失败/闸门命中/导入失败/崩溃恢复/审计不可达/拒绝类）fake sender 调用次数合计 = 0',
      SENDER_CALLS === 0, JSON.stringify({ sender_calls_total: SENDER_CALLS }));
    ck('i3 本套件自证：fake adapters + mock 中控（无任何真实发送通道）；未访问美团/未真实导出下载导入推送、未建 timer、报表 B 锁定',
      out.real_meituan_run === false && out.real_export === false && out.real_download === false && out.real_import === false &&
      out.real_wecom_message_sent === false && out.real_webhook_read === false && out.timers_created === false && out.report_b === 'locked_not_started',
      JSON.stringify({ report_b: out.report_b }));
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
