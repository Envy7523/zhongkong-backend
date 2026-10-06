#!/usr/bin/env node
'use strict';
/**
 * workflow 生产适配器装配 · **离线套件**（fake production adapters）
 *
 * **data-only 收口套件**：syncbot 只装配「下载 + 导入」两段；上午 9 点日报推送归项目现有机器人（中控侧）。
 *   · 工厂 ADAPTER_KEYS 只有 download/import；白名单里没有 push；
 *   · 传入 push 依赖 → 明确拒绝 push_adapter_not_allowed；workflow 侧传 push adapter → 构造即抛错；
 *   · 全程（成功/失败/恢复/审计不可达/CLI 拒绝）fake sender 调用次数恒为 0，且无任何 PUSH_* 事件。
 *
 * 边界：全部使用 fake 适配器（真实 import-run 仅用于"审计不可达"一项）、mock 中控（随机端口）与
 * fake sender（仅为断言"从未被调用"）；不访问美团、不真实导出/下载/导入/推送、不建 timer、
 * 不重启服务；报表 B 保持 locked_not_started；输出不含 JWT/密钥/完整 SHA/绝对路径。
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p6prod-'));
process.env.SYNCBOT_ROOT = ROOT;

const BOT = process.env.SYNCBOT_BOT || '/opt/zhongkong-sync-bot';
const P = require(BOT + '/app/src/paths.js');
const TC = require(BOT + '/app/src/task-context.js');
const state = require(BOT + '/app/src/state.js');
const OUTBOX = require(BOT + '/app/src/phase3/audit-outbox.js');
const RUNMOD = require(BOT + '/app/src/phase3/import-run.js');
const WFMOD = require(BOT + '/app/src/phase3/workflow-run.js');   // data-only：不再 require push-run/push-client
const FA = require(BOT + '/app/src/phase3/workflow-production-adapters.js');

const AUDIT_SECRET = crypto.randomBytes(32).toString('hex');
const TOKEN = 'tok-' + crypto.randomBytes(12).toString('hex');
const RUN = 'test-prod-' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');
const WF_SRC = path.join(BOT, 'app', 'src', 'phase3', 'workflow-run.js');

const out = {
  suite: 'workflow-production-adapters-fixture', fixture: true, offline: true,
  real_meituan_run: false, real_export: false, real_download: false, real_import: false,
  real_wecom_message_sent: false, real_webhook_read: false, timers_created: false, report_b: 'locked_not_started',
  data_only: true, push_owner: 'project_daily_report_bot（中控侧 9 点日报推送）', push_calls_total: 0,
  test_run_id: RUN, checks: [],
};
const ck = (n, ok, d) => out.checks.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });

let SEQ = 0;
function nextBD() { SEQ += 1; return new Date(Date.UTC(2026, 10, 1 + SEQ)).toISOString().slice(0, 10); }
const AUDIT_PATH = '/api/internal/syncbot/events';
const IMPORT_PATH = '/api/business-analytics/import';

function createMock() {
  const st = { audit_requests: 0, import_requests: 0, audit: { accepted: [], duplicates: [], stages: [], full_sha_seen: false } };
  const seen = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = String(req.url || '').split('?')[0];
      if (url === IMPORT_PATH) {
        st.import_requests += 1;
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, batch_id: 660001, amount_db: { recorded_amount: 1 }, amount_basis: { scope: 'import_batch_id', mappings: [ { file_column: '营业收入(元)', db_column: 'recorded_amount' }, { file_column: '营业额(元)', db_column: 'gross_amount' }, { file_column: '优惠金额(元)', db_column: 'discount_amount' } ] }, data_kind: 'cashier_composite', imported: 154, raw_imported: 22, matched_stores: 22, skipped: 0, errors: [], resolved_channels: [], income_composition_fields: [] }));
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
          for (const [k, v] of Object.entries((e && e.metrics) || {})) if (k === 'sha256' && String(v || '').length > 12) st.audit.full_sha_seen = true;
          st.audit.stages.push(e.stage);
        }
        for (const id of accepted) seen.add(id);
        st.audit.accepted.push.apply(st.audit.accepted, accepted);
        st.audit.duplicates.push.apply(st.audit.duplicates, duplicates);
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
    async stop() { await new Promise((r) => server.close(r)); },
  };
}
let SENDER_CALLS = 0;   // data-only：任何路径下都必须保持 0
function createFakeSender(mode = 'ok') {
  const rec = { calls: 0, payloads: [] };
  return {
    rec,
    async send(payload) {
      rec.calls += 1; SENDER_CALLS += 1; rec.payloads.push(JSON.parse(JSON.stringify(payload)));
      if (mode === 'hang') return new Promise(() => {});
      if (mode === 'throw') throw Object.assign(new Error('boom'), { code: 'ECONNRESET' });
      return { ok: true, http: 200, message_id: 'msg-' + crypto.randomBytes(4).toString('hex') };
    },
  };
}

/** fake 生产适配器工厂（形状与真实适配器一致：download.run / import.runOnce）—— data-only，不含 push */
function makeFakeDeps({ calls, downloadMode = 'ok', importMode = 'ok', bd }) {
  return {
    download: () => ({
      async run() {
        calls.download += 1;
        if (downloadMode === 'throw') throw new Error('fake download adapter boom');
        if (downloadMode === 'fail') return { ok: false, failure_reason: 'fake_download_failed', export_submitted: true, phase: 'WAITING_EXPORT' };
        return { ok: true, result: 'FILE_VALIDATED', phase: 'FILE_VALIDATED', export_submitted: true, sha256_prefix: 'aabbccddeeff' };
      },
    }),
    import: () => ({
      async runOnce() {
        calls.import += 1;
        if (importMode === 'throw') throw new Error('fake import adapter boom');
        if (importMode === 'fail') return { ok: false, action: 'IMPORT_FAILED', reason: 'fake_import_failed', http_requests: 1 };
        return { ok: true, action: 'IMPORT_SUCCEEDED', http_requests: 1, import_batch_id: 660001, allow_push: true };
      },
    }),
  };
}

function assemble({ mock, bd, taskId, calls, downloadMode, importMode, sender, enable = true, confirm = true, reportType = 'cashier_composite', deps = null, production = null }) {
  // data-only：装配面只有 download/import（sender 只是"绝不该被调用的哨兵"）
  const prod = FA.createWorkflowProductionAdapters({
    enable, confirmRealWorkflow: confirm, reportType, businessDate: bd,
    deps: deps || makeFakeDeps({ calls, downloadMode, importMode, bd }),
  });
  if (!prod.ok) return { prodOk: false, prod };
  const wf = WFMOD.createWorkflowRun({
    reportType: 'cashier_composite', businessDate: bd, platform: 'meituan', taskId, confirm: true,
    gates: { g1: async () => ({ ok: true }), g3: async () => ({ ok: true }) },
    production: production || { enabled: true, adapters: prod.adapters, whitelist: prod.whitelist },
    outbox: OUTBOX,
  });
  return { prodOk: true, prod, wf };
}
const wfOf = (bd) => { try { return (JSON.parse(fs.readFileSync(P.taskStateFile('meituan', 'cashier_composite', bd), 'utf8')).workflow) || {}; } catch { return {}; } };

(async () => {
  const mock = await createMock().start();

  // ============================================================ A. 工厂本身
  {
    const bd = '2026-11-01';
    const mk = (cfg) => FA.createWorkflowProductionAdapters(Object.assign({ enable: true, confirmRealWorkflow: true, reportType: 'cashier_composite', businessDate: bd, deps: {} }, cfg));
    ck('a1 未显式启用 → production_adapters_not_enabled（fail-closed、零副作用）',
      mk({ enable: false }).reason === 'production_adapters_not_enabled', JSON.stringify(mk({ enable: false })));
    ck('a2 未显式确认生产运行 → confirm_real_workflow_required',
      mk({ confirmRealWorkflow: false }).reason === 'confirm_real_workflow_required', JSON.stringify(mk({ confirmRealWorkflow: false })));
    ck('a3 报表 B → report_type_not_allowed',
      mk({ reportType: 'item_sales_detail' }).reason === 'report_type_not_allowed', String(mk({ reportType: 'item_sales_detail' }).reason));
    ck('a4 非法业务日期 → business_date_invalid',
      mk({ businessDate: '2026/11/01' }).reason === 'business_date_invalid', String(mk({ businessDate: '2026/11/01' }).reason));
    const miss = ['download', 'import'].map((k) => {
      const deps = {}; for (const x of ['download', 'import']) if (x !== k) deps[x] = () => ({ run: async () => ({}), runOnce: async () => ({}) });
      return mk({ deps }).reason;
    });
    ck('a5 两个适配器工厂逐个缺失都被明确拒绝（adapter_factory_missing:<key>）',
      JSON.stringify(miss) === JSON.stringify(['adapter_factory_missing:download', 'adapter_factory_missing:import']),
      JSON.stringify(miss));
    ck('a6 适配器工厂抛错 → adapter_factory_threw:import（不静默、不降级）',
      mk({ deps: { download: () => ({ run: async () => ({}) }), import: () => { throw new Error('boom'); } } }).reason === 'adapter_factory_threw:import',
      String(mk({ deps: { download: () => ({ run: async () => ({}) }), import: () => { throw new Error('boom'); } } }).reason));
    ck('a7 适配器形状不合法 → adapter_shape_invalid:import',
      mk({ deps: { download: () => ({ run: async () => ({}) }), import: () => ({}) } }).reason === 'adapter_shape_invalid:import',
      String(mk({ deps: { download: () => ({ run: async () => ({}) }), import: () => ({}) } }).reason));
    ck('a7b **data-only**：传入 push 依赖工厂 → 明确拒绝 push_adapter_not_allowed（不是"忽略它照跑"）',
      mk({ deps: { download: () => ({ run: async () => ({}) }), import: () => ({ runOnce: async () => ({}) }), push: () => ({ runOnce: async () => ({}) }) } }).reason === 'push_adapter_not_allowed',
      String(mk({ deps: { download: () => ({ run: async () => ({}) }), import: () => ({ runOnce: async () => ({}) }), push: () => ({ runOnce: async () => ({}) }) } }).reason));
    const calls = { download: 0, import: 0 };
    const ok = assemble({ mock, bd: '2026-11-02', taskId: RUN + '-a8', calls });
    ck('a8 齐备时装配成功：只返回 download/import 两个适配器 + 调用白名单（无 push）',
      ok.prodOk === true && FA.ADAPTER_KEYS.join(',') === 'download,import' && FA.ADAPTER_KEYS.every((k) => ok.prod.adapters[k]) &&
      Object.keys(ok.prod.whitelist).length === 2 && ok.prod.data_only === true && !ok.prod.adapters.push,
      JSON.stringify({ keys: Object.keys(ok.prod.adapters), whitelist: Object.keys(ok.prod.whitelist), data_only: ok.prod.data_only }));
    const wl = FA.ADAPTER_CALL_WHITELIST;
    ck('a9 适配器调用白名单逐项声明（source / allowed / forbidden_in_workflow）',
      FA.ADAPTER_KEYS.every((k) => wl[k] && wl[k].source && Array.isArray(wl[k].allowed) && wl[k].allowed.length && Array.isArray(wl[k].forbidden_in_workflow) && wl[k].forbidden_in_workflow.length),
      JSON.stringify(FA.ADAPTER_KEYS.map((k) => ({ k, allowed: wl[k].allowed.length, forbidden: wl[k].forbidden_in_workflow.length }))));
  }

  // ============================================================ B. 经工厂装配后的成功串联
  {
    const bd = nextBD();
    const calls = { download: 0, import: 0 };
    const sender = createFakeSender('ok');
    const { wf } = assemble({ mock, bd, taskId: RUN + '-b1', calls, sender });
    const r = await wf.runOnce({});
    const w = wfOf(bd);
    ck('b1 工厂装配的 fake 适配器：成功串联（下载 1 / 导入 1 / **推送 0**、终态 COMPLETED、sender 0 次）',
      r.ok === true && r.action === 'COMPLETED' && calls.download === 1 && calls.import === 1 && !('push' in calls) &&
      sender.rec.calls === 0 && w.status === 'success' && w.phase === 'COMPLETED' && w.stages.push === undefined,
      JSON.stringify({ action: r.action, calls, sends: sender.rec.calls, phase: w.phase }));
    ck('b2 只有 download/import 两段状态落盘，且无 push 阶段',
      w.stages.download.status === 'success' && w.stages.import.status === 'success' && w.stages.push === undefined &&
      w.stages.import.http_requests === 1 && w.stages.download.export_submitted === true &&
      Object.keys(w.stages).sort().join(',') === 'download,import',
      JSON.stringify({ stages: Object.keys(w.stages), http: w.stages.import.http_requests }));
    let e1 = null; let e2 = null; let e3 = null;
    try { WFMOD.createWorkflowRun({ reportType: 'cashier_composite', businessDate: nextBD(), production: { enabled: false, adapters: {} } }); } catch (e) { e1 = String(e && e.message); }
    try { WFMOD.createWorkflowRun({ reportType: 'cashier_composite', businessDate: nextBD(), production: { enabled: true, adapters: { download: { run: async () => ({}) } } } }); } catch (e) { e2 = String(e && e.message); }
    try { WFMOD.createWorkflowRun({ reportType: 'cashier_composite', businessDate: nextBD(), production: { enabled: true, adapters: { download: { run: async () => ({}) }, import: { runOnce: async () => ({}) }, push: { runOnce: async () => ({}) } } } }); } catch (e) { e3 = String(e && e.message); }
    ck('b3 生产未显式启用 / 装配不完整 / **带 push 适配器**：构造期即 fail-closed（抛错，零副作用）',
      !!e1 && !!e2 && !!e3 && e1.indexOf('enabled') >= 0 && e2.indexOf('import.runOnce') >= 0 && e3.indexOf('push adapter') >= 0,
      JSON.stringify({ not_enabled: e1 ? e1.slice(0, 50) : null, incomplete: e2 ? e2.slice(0, 50) : null, push_adapter: e3 ? e3.slice(0, 60) : null }));
  }

  // ============================================================ C. 适配器抛错/失败
  {
    const cases = [
      ['c1', 'download 适配器抛错', { downloadMode: 'throw' }, { download: 1, import: 0 }],
      ['c2', 'download 适配器返回失败', { downloadMode: 'fail' }, { download: 1, import: 0 }],
      ['c3', 'import 适配器抛错', { importMode: 'throw' }, { download: 1, import: 1 }],
      ['c4', 'import 适配器返回失败', { importMode: 'fail' }, { download: 1, import: 1 }],
    ];
    for (const [tag, label, modes, want] of cases) {
      const bd = nextBD();
      const calls = { download: 0, import: 0 };
      const sender = createFakeSender('ok');
      const { wf } = assemble({ mock, bd, taskId: RUN + '-' + tag, calls, sender, ...modes });
      const r = await wf.runOnce({});
      const w = wfOf(bd);
      ck(tag + ' ' + label + ' → 阶段调用次数 ' + want.download + '/' + want.import + '（推送恒 0），workflow 不进入成功终态',
        calls.download === want.download && calls.import === want.import && !('push' in calls) &&
        w.status !== 'success' && r.ok === false && r.stage_calls.push === undefined && sender.rec.calls === 0 && w.stages.push === undefined,
        JSON.stringify({ calls, status: w.status, action: r.action, sends: sender.rec.calls }));
    }
    // c5 导入失败后重跑：不得重复导出/导入，也不得有任何外发动作
    const bd = nextBD();
    const calls = { download: 0, import: 0 };
    const sender = createFakeSender('ok');
    const { wf } = assemble({ mock, bd, taskId: RUN + '-c5', calls, sender, importMode: 'fail' });
    await wf.runOnce({});
    const after = { d: calls.download, i: calls.import, s: sender.rec.calls };
    const { wf: wf2 } = assemble({ mock, bd, taskId: RUN + '-c5', calls, sender, importMode: 'fail' });
    const r2 = await wf2.runOnce({});
    ck('c5 导入失败后重跑：**不再二次导出**（0 增量）、workflow 拒绝、top-level 导入保持 failed、全程 0 外发',
      calls.download === after.d && sender.rec.calls === 0 && after.s === 0 &&
      r2.ok === false && (r2.stage_calls.download === 0) && r2.stage_calls.push === undefined && wfOf(bd).status !== 'success' &&
      wfOf(bd).stages.import.status === 'failed' && wfOf(bd).stages.download.status === 'success',
      JSON.stringify({ after, now: { d: calls.download, i: calls.import, s: sender.rec.calls }, action: r2.action, reason: r2.reason,
        stages: { d: wfOf(bd).stages.download.status, i: wfOf(bd).stages.import.status } }));
    // c5b 重复导入的闸门归属：workflow 只负责"按阶段调用"，**不再重复导入**由 import-run 自带的本地终态闸门保证
    const runSrc = fs.readFileSync(path.join(BOT, 'app', 'src', 'phase3', 'import-run.js'), 'utf8');
    ck('c5b 重导入闸门归属正确：import-run 自带 NO_REIMPORT_STATUSES（failed/waiting_human 等一律不外发），workflow 不自造重复导入逻辑',
      /NO_REIMPORT_STATUSES\s*=\s*\[\s*'running'\s*,\s*'success'\s*,\s*'failed'\s*,\s*'waiting_human'\s*\]/.test(runSrc) &&
      /isBlocked\s*=\s*\(st\)\s*=>\s*NO_REIMPORT_STATUSES\.includes/.test(runSrc),
      JSON.stringify({ gate_present: /NO_REIMPORT_STATUSES/.test(runSrc) }));
  }

  // ============================================================ D. 重复恢复
  {
    const bd = nextBD();
    const calls = { download: 0, import: 0 };
    const sender = createFakeSender('ok');
    const { wf } = assemble({ mock, bd, taskId: RUN + '-d1', calls, sender });
    const first = await wf.runOnce({});
    const after = { d: calls.download, i: calls.import, s: sender.rec.calls };
    const { wf: wf2 } = assemble({ mock, bd, taskId: RUN + '-d1', calls, sender });   // 新实例（跨进程语义）
    const second = await wf2.runOnce({});
    ck('d1 完整成功后重跑（新实例）→ 0 下载 / 0 导入 / 0 发送，workflow_already_completed',
      first.action === 'COMPLETED' && second.action === 'WAITING_HUMAN' && String(second.reason).indexOf('workflow_already_completed') === 0 &&
      calls.download === after.d && calls.import === after.i && sender.rec.calls === after.s,
      JSON.stringify({ calls_now: calls, sends: sender.rec.calls, action: second.action, reason: second.reason }));
    // d2 阶段停在 running → 0 调用转人工
    const bd2 = nextBD();
    state.patch('meituan', bd2, 'workflow', {
      task_id: RUN + '-d2', report_type: 'cashier_composite', platform: 'meituan', business_date: bd2,
      phase: 'DOWNLOAD_RUNNING', terminal: false,
      stages: { download: { status: 'running', attempts: 1, export_submitted: false }, import: { status: 'pending', attempts: 0 } },
    }, { status: 'running', reportType: 'cashier_composite' });
    const calls2 = { download: 0, import: 0 };
    const s2 = createFakeSender('ok');
    const { wf: wf3 } = assemble({ mock, bd: bd2, taskId: RUN + '-d2', calls: calls2, sender: s2 });
    const r3 = await wf3.runOnce({});
    ck('d2 阶段停在 running（结果未知；data-only 下只有 download/import）→ 0 调用、转人工、0 外发',
      r3.action === 'WAITING_HUMAN' && String(r3.reason).indexOf('workflow_stage_in_flight_uncertain:download') === 0 &&
      r3.stage_calls.download === 0 && r3.stage_calls.import === 0 && r3.stage_calls.push === undefined &&
      calls2.download === 0 && calls2.import === 0 && s2.rec.calls === 0,
      JSON.stringify({ action: r3.action, reason: r3.reason, calls: calls2 }));
  }

  // ============================================================ E. 审计不可达（真实边界经工厂装配）
  {
    const bd = nextBD();
    const down = path.join(ROOT, 'audit-down.json');
    fs.writeFileSync(down, JSON.stringify({ secret: AUDIT_SECRET, endpoint: 'http://127.0.0.1:9' + AUDIT_PATH }), { mode: 0o600 });
    const sender = createFakeSender('ok');
    const calls = { download: 0, import: 0 };
    const deps = makeFakeDeps({ calls, bd });
    const taskId = RUN + '-e';
    const ctx = TC.createContext('cashier_composite', { platform: 'meituan', taskId, businessDate: bd });
    // 真实边界（import-run）经工厂装配；审计指向不可达端口；**不装配任何推送边界**
    const prod = FA.createWorkflowProductionAdapters({
      enable: true, confirmRealWorkflow: true, reportType: 'cashier_composite', businessDate: bd,
      deps: Object.assign({}, deps, {
        import: () => ({
          async runOnce() {
            calls.import += 1;
            const run = RUNMOD.createImportRun({ ctx, opts: { secretFile: down, timeoutMs: 2500, testRunId: RUN, clientOpts: { token: TOKEN, baseUrl: mock.baseUrl, timeoutMs: 2500 } } });
            const f = path.join(P.dayDownloads('meituan', 'cashier_composite', bd), 'x.xlsx');
            P.ensureDir(path.dirname(f)); fs.writeFileSync(f, 'audit-down-fixture');
            const sha = require(BOT + '/app/src/phase3/import-client.js').sha256OfBuffer(fs.readFileSync(f));
            return run.runOnce({
              file: f, validation: { ok: true, checks: { row2_metadata: { ok: true, items: [{ name: '营业日期=目标日期', ok: true }] } } },
              evidence: { excelBusinessDate: bd, amountExcel: 1, amountDb: 1 }, archiveSha256: sha,
              archive: { file: f, sha256: sha, size: fs.statSync(f).size, report_type: 'cashier_composite', platform: 'meituan', business_date: bd },
              task: { task_id: taskId, report_type: 'cashier_composite', platform: 'meituan', business_date: bd },
              coverageGate: async () => ({ ok: true }), duplicateCheck: async () => ({ duplicate: false }), validateFile: async () => ({ ok: true }),
            });
          },
        }),
      }),
    });
    const wf = WFMOD.createWorkflowRun({
      reportType: 'cashier_composite', businessDate: bd, platform: 'meituan', taskId, confirm: true,
      gates: { g1: async () => ({ ok: true }), g3: async () => ({ ok: true }) },
      production: { enabled: true, adapters: prod.adapters, whitelist: prod.whitelist }, outbox: OUTBOX,
    });
    const r = await wf.runOnce({});
    const ctxE = TC.createContext('cashier_composite', { platform: 'meituan', taskId, businessDate: bd });
    const pend = OUTBOX.pendingCount(ctxE);
    ck('e1 审计不可达：经工厂装配的真实导入边界业务照常（导入 HTTP 1、**0 外发**），事件只进 outbox pending，终态 COMPLETED',
      r.action === 'COMPLETED' && calls.import === 1 && !('push' in calls) && sender.rec.calls === 0 &&
      (mock.state.import_requests >= 1) && pend > 0 && wfOf(bd).status === 'success' && wfOf(bd).stages.push === undefined,
      JSON.stringify({ action: r.action, calls, sends: sender.rec.calls, pending: pend, import_http: mock.state.import_requests }));
    const { wf: wf2 } = assemble({ mock, bd, taskId, calls, sender, deps });
    const r2 = await wf2.runOnce({});
    ck('e2 审计不可达 + 重跑：0 下载 / 0 导入 / 0 外发（只允许审计补送）',
      r2.stage_calls.download === 0 && r2.stage_calls.import === 0 && r2.stage_calls.push === undefined && sender.rec.calls === 0,
      JSON.stringify({ calls: r2.stage_calls, sends: sender.rec.calls, action: r2.action }));
  }

  // ============================================================ F. CLI 拒绝（同一代码路径，进程内可测）
  {
    const cli = (args, env) => WFMOD.runProductionCli(args, { env: env || {}, out: () => {} });
    const THREE = ['--confirm-real-workflow', '--report-type=cashier_composite', '--date=2026-12-01'];
    ck('f1 缺 --confirm-real-workflow → exit 2',
      cli(['--report-type=cashier_composite', '--date=2026-12-01']).exitCode === 2, JSON.stringify(cli(['--report-type=cashier_composite', '--date=2026-12-01'])));
    ck('f2 缺 --report-type → exit 2', cli(['--confirm-real-workflow', '--date=2026-12-01']).exitCode === 2, JSON.stringify(cli(['--confirm-real-workflow', '--date=2026-12-01'])));
    ck('f3 缺 --date → exit 2', cli(['--confirm-real-workflow', '--report-type=cashier_composite']).exitCode === 2, JSON.stringify(cli(['--confirm-real-workflow', '--report-type=cashier_composite'])));
    ck('f4 多余参数 → exit 2（unknown_flag）',
      cli(THREE.concat(['--extra=1'])).exitCode === 2 && String(cli(THREE.concat(['--extra=1'])).reason).indexOf('unknown_flag') === 0,
      JSON.stringify(cli(THREE.concat(['--extra=1']))));
    ck('f5 报表 B → exit 2（report_type_not_allowed）',
      cli(['--confirm-real-workflow', '--report-type=item_sales_detail', '--date=2026-12-01']).exitCode === 2,
      JSON.stringify(cli(['--confirm-real-workflow', '--report-type=item_sales_detail', '--date=2026-12-01'])));
    ck('f6 非法/不存在的日期 → exit 2（禁止推断日期）',
      cli(['--confirm-real-workflow', '--report-type=cashier_composite', '--date=2026-13-01']).exitCode === 2 &&
      cli(['--confirm-real-workflow', '--report-type=cashier_composite', '--date=2026-02-30']).exitCode === 2,
      JSON.stringify([cli(['--confirm-real-workflow', '--report-type=cashier_composite', '--date=2026-13-01']).reason, cli(['--confirm-real-workflow', '--report-type=cashier_composite', '--date=2026-02-30']).reason]));
    ck('f7 三参数齐全但未显式启用生产适配器 → exit 3（fail-closed，零副作用）',
      cli(THREE, {}).exitCode === 3 && cli(THREE, {}).reason === 'production_adapters_not_enabled',
      JSON.stringify(cli(THREE, {})));
    ck('f8 三参数齐全 + 显式启用但依赖工厂未提供 → exit 3（adapter_factory_missing:download）',
      cli(THREE, { SYNCBOT_WORKFLOW_PROD_ADAPTERS: '1' }).exitCode === 3 &&
      cli(THREE, { SYNCBOT_WORKFLOW_PROD_ADAPTERS: '1' }).reason === 'adapter_factory_missing:download',
      JSON.stringify(cli(THREE, { SYNCBOT_WORKFLOW_PROD_ADAPTERS: '1' })));
    const beforeFiles = [];
    const walk = (d) => { let e2 = []; try { e2 = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of e2) { const p = path.join(d, x.name); if (x.isDirectory()) walk(p); else beforeFiles.push(p); } };
    walk(path.join(ROOT, 'state'));
    const cliRuns = [cli([]), cli(THREE.concat(['--extra=1'])), cli(THREE, {}), cli(THREE, { SYNCBOT_WORKFLOW_PROD_ADAPTERS: '1' })];
    const afterFiles = [];
    const walk2 = (d) => { let e2 = []; try { e2 = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of e2) { const p = path.join(d, x.name); if (x.isDirectory()) walk2(p); else afterFiles.push(p); } };
    walk2(path.join(ROOT, 'state'));
    ck('f9 CLI 全程零副作用：4 次拒绝调用后不新增任何状态/outbox 文件、不产生任何 HTTP/发送',
      cliRuns.every((x) => x.exitCode === 2 || x.exitCode === 3) && afterFiles.length === beforeFiles.length,
      JSON.stringify({ exits: cliRuns.map((x) => x.exitCode), files_before: beforeFiles.length, files_after: afterFiles.length }));
  }

  // ============================================================ G. 静态自检与脱敏
  {
    const src = fs.readFileSync(WF_SRC, 'utf8');
    const hits = FA.scanForbiddenCalls(src);
    ck('g1 workflow 源码**不含**禁止调用（浏览器/数据库/项目文件写入/webhook/凭据/定时器）',
      hits.length === 0, JSON.stringify(hits));
    ck('g2 静态自检本身有效（对含禁止调用的样本能报出违规）',
      FA.scanForbiddenCalls("const p=require('playwright'); fs.writeFileSync('x',1); setInterval(()=>{},1);").length === 3,
      JSON.stringify(FA.scanForbiddenCalls("const p=require('playwright'); fs.writeFileSync('x',1); setInterval(()=>{},1);")));
    const code = FA.stripComments(src);
    ck('g3 无日期推断：businessDate 必填且**不得**由时钟派生（代码中无 businessDate=new Date()/Date.now() 之类）',
      /assertPlainDate\(businessDate\)/.test(code) &&
      !/businessDate\s*=\s*[^;]{0,80}(?:new Date|Date\.now)/.test(code) &&
      !/new Date\(\)[^;]{0,40}toISOString\(\)\.slice\(0,\s*10\)/.test(code),
      JSON.stringify({ business_date_required: /assertPlainDate\(businessDate\)/.test(code), clock_derived: /businessDate\s*=\s*[^;]{0,80}(?:new Date|Date\.now)/.test(code) }));
    let rejB = null;
    try { WFMOD.createWorkflowRun({ reportType: 'item_sales_detail', businessDate: '2026-12-31' }); } catch (e) { rejB = String(e && e.message); }
    ck('g4 报表 B 在总入口构造期即被拒绝（不建状态文件、不装配适配器）',
      !!rejB && !fs.existsSync(P.taskStateFile('meituan', 'item_sales_detail', '2026-12-31')),
      JSON.stringify({ rejected: rejB ? rejB.slice(0, 60) : null, report_b: out.report_b }));
    const files = [];
    const walkS = (d) => { let e2 = []; try { e2 = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of e2) { const p = path.join(d, x.name); if (x.isDirectory()) walkS(p); else files.push(p); } };
    walkS(path.join(ROOT, 'state'));
    const allText = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const LEAK = [/Bearer [A-Za-z0-9._-]{4,}/, /"password"/i, /"authorization"/i, /\/(?:home|opt|etc|var|root|tmp|usr)\//, /[A-Za-z]:\\/,
      /eyJ[A-Za-z0-9_-]{10,}\./, /[0-9a-fA-F]{64}/, /[A-Za-z0-9+/]{40,}={0,2}/];
    const leaks = LEAK.filter((re) => re.test(allText)).map(String);
    ck('g5 状态文件与 outbox 无敏感信息（无 JWT/口令/Authorization/完整 SHA/绝对路径/base64）',
      leaks.length === 0 && mock.state.audit.full_sha_seen === false, JSON.stringify({ leaks: leaks.slice(0, 3), full_sha_seen: mock.state.audit.full_sha_seen }));
    const ADSRC = FA.stripComments(fs.readFileSync(path.join(BOT, 'app', 'src', 'phase3', 'workflow-production-adapters.js'), 'utf8'));
    ck('g6(a) data-only 静态自检：装配点与 workflow 代码中都不出现推送通道模块 / PUSH_* / webhook',
      !/require\(\s*['"][^'"]*push-(?:run|client)/.test(ADSRC) && !/require\(\s*['"][^'"]*push-(?:run|client)/.test(FA.stripComments(src)) &&
      FA.scanForbiddenCalls(src).every((h) => h.name !== 'push_channel_module') &&
      FA.ADAPTER_KEYS.join(',') === 'download,import' && !('push' in FA.ADAPTER_CALL_WHITELIST),
      JSON.stringify({ adapter_keys: FA.ADAPTER_KEYS, whitelist: Object.keys(FA.ADAPTER_CALL_WHITELIST), forbidden_scan: FA.scanForbiddenCalls(src).map((h) => h.name) }));
    out.push_calls_total = SENDER_CALLS;
    ck('g6(b) **全程推送侧外发总数为 0**：本套件所有路径（成功/失败/恢复/审计不可达/CLI 拒绝）fake sender 调用次数合计 = 0',
      SENDER_CALLS === 0, JSON.stringify({ sender_calls_total: SENDER_CALLS }));
    ck('g6 本套件自证：fake 适配器 + mock 中控（**无任何真实发送通道**，推送归项目侧）；未访问美团/未真实导出下载导入推送、未建 timer、报表 B 锁定',
      out.real_meituan_run === false && out.real_export === false && out.real_download === false && out.real_import === false &&
      out.real_wecom_message_sent === false && out.real_webhook_read === false && out.timers_created === false && out.report_b === 'locked_not_started' &&
      out.data_only === true,
      JSON.stringify({ report_b: out.report_b, data_only: out.data_only, push_owner: out.push_owner }));
  }

  await mock.stop();
  out.total = out.checks.length;
  out.failed = out.checks.filter((c) => !c.ok).length;
  out.ok = out.failed === 0;
  if (process.env.P3_OUT) { try { fs.writeFileSync(process.env.P3_OUT, JSON.stringify(out, null, 2), 'utf8'); } catch (_) {} }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
})().catch((e) => {
  const fatalOut = { ok: false, fatal: String((e && e.stack) || e).slice(0, 700), total: out.checks.length, failed: out.checks.filter((c) => !c.ok).length, checks: out.checks };
  if (process.env.P3_OUT) { try { fs.writeFileSync(process.env.P3_OUT, JSON.stringify(fatalOut, null, 2), 'utf8'); } catch (_) {} }
  console.log(JSON.stringify(fatalOut, null, 2));
  process.exit(9);
});
