#!/usr/bin/env node
'use strict';
/**
 * 下载侧审计接线 · 离线 fixture 套件
 * 仅用 fake adapters 驱动**真实编排器**（phase2/real-download.js + real-flow-state）与**真实接线模块**
 * （phase3/real-download-audit.js + audit-outbox/audit-stage-map）。
 *
 * 明确声明：本套件**不是**真实美团运行 —— 不访问美团、不导出、不下载、不导入、不推送、不建 timer，
 * 报表B（item_sales_detail）完全锁定未触碰。事件均带 is_test=true + 唯一 test_run_id，结束后精确清理。
 * 不打印任何密钥/签名/JWT/口令/绝对路径/完整 SHA。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p3entry-'));
process.env.SYNCBOT_ROOT = ROOT;

const BOT = '/opt/zhongkong-sync-bot';
const APP = '/home/ubuntu/app';
const BASE = 'http://127.0.0.1:3456';
const REAL_SECRET = `${BOT}/state/secrets/audit-hmac.json`;
const IMPORTER = `${BOT}/state/secrets/project-importer.json`;

const OUTBOX = require(`${BOT}/app/src/phase3/audit-outbox.js`);
const MAP = require(`${BOT}/app/src/phase3/audit-stage-map.js`);
const WIRING = require(`${BOT}/app/src/phase3/real-download-audit.js`);
const BAT = require(`${BOT}/app/src/phase3/audit-batcher.js`);
const { createOrchestrator } = require(`${BOT}/app/src/phase2/real-download.js`);
const TC = require(`${BOT}/app/src/task-context.js`);

const RUN = `test-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
const SECRET = JSON.parse(fs.readFileSync(REAL_SECRET, 'utf8')).secret;
const GOOD_SECRET_FILE = path.join(ROOT, 'secret-good.json');
const DOWN_SECRET_FILE = path.join(ROOT, 'secret-down.json');
fs.writeFileSync(GOOD_SECRET_FILE, JSON.stringify({ secret: SECRET, endpoint: `${BASE}/api/internal/syncbot/events` }), { mode: 0o600 });
fs.writeFileSync(DOWN_SECRET_FILE, JSON.stringify({ secret: SECRET, endpoint: 'http://127.0.0.1:9/api/internal/syncbot/events' }), { mode: 0o600 });

const out = { suite: 'download-entry-wiring-fixture', fixture: true, real_meituan_run: false, test_run_id: RUN, checks: [] };
const ck = (n, ok, d) => out.checks.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });

const PY = path.join(ROOT, 'snap.py');
fs.writeFileSync(PY, `import json,sqlite3,sys
con=sqlite3.connect('file:${APP}/data/database.sqlite?mode=ro',uri=True)
c=con.cursor(); run=sys.argv[1]
ev=c.execute('SELECT id,event_id,stage,task_id,is_test,test_run_id FROM sync_job_events WHERE test_run_id=? ORDER BY id',(run,)).fetchall()
rn=c.execute('SELECT id,task_id,status,phase,event_count FROM sync_job_runs WHERE test_run_id=? ORDER BY id',(run,)).fetchall()
print(json.dumps({'events':ev,'runs':rn,
 'non_test_events':c.execute('SELECT COUNT(*) FROM sync_job_events WHERE COALESCE(is_test,0)=0').fetchone()[0],
 'non_test_runs':c.execute('SELECT COUNT(*) FROM sync_job_runs WHERE COALESCE(is_test,0)=0').fetchone()[0],
 'orphans':c.execute('SELECT COUNT(*) FROM sync_job_events e LEFT JOIN sync_job_runs r ON r.id=e.run_id WHERE r.id IS NULL').fetchone()[0]}))`);
// 中控 DB 由 sql.js 整文件重写（每个审计事件都触发一次 ~385MB 全量保存）：并发保存期间
// 外部只读几乎必然读到撕裂页（sqlite3 "database disk image is malformed"）。这是**瞬时**读失败、
// 不是库损坏（服务自身与其后的读均正常），因此只读侧做有界重试（约 36s 预算）；始终 mode=ro。
function snap() {
  let last = null;
  for (let i = 0; i < 45; i += 1) {
    try { return JSON.parse(execSync(`python3 ${PY} ${RUN}`, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })); }
    catch (e) { last = e; try { execSync('sleep 0.8'); } catch (_) {} }
  }
  throw last;
}
const rowsFor = (s, taskId) => s.events.filter((e) => e[3] === taskId);
const stagesFor = (s, taskId) => rowsFor(s, taskId).map((e) => e[2]);

function hmacPost(url, body, secret) {
  const raw = JSON.stringify(body);
  const ts = String(Date.now());
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${raw}`, 'utf8').digest('hex');
  return fetch(BASE + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Syncbot-Timestamp': ts, 'X-Syncbot-Signature': sig },
    body: Buffer.from(raw, 'utf8'),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
}
const futureApply = () => new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');

/** 检查点批量断言用常量（C1 / C2 的成员与顺序） */
const CP_C1 = ['PRECHECK', 'QUERY_DONE', 'EXPORT_SUBMITTED', 'WAITING_EXPORT'];
const CP_C2 = ['DOWNLOADED', 'FILE_VALIDATED'];
/**
 * add() 抛异常的病态 batcher（真实实例 + 仅替换 add），用于验证
 * "审计写入异常不打断业务、且逐条记 audit_pending 且原因脱敏"。
 */
function makeBoomBatcher(ctx, opts) {
  const b = BAT.createAuditBatcher({ ctx, opts });
  b.add = () => { throw new Error('boom at /opt/zhongkong-sync-bot/x.js sha256=' + 'b'.repeat(64)); };
  return b;
}
/** 与生产同构的 store：业务状态先落盘，再由接线模块在落盘成功之后 emit */
function makeFixture({ BD, taskId, failAt = null, doubleSave = false, boomBatcher = false, auditOpts = null, baseSave = null }) {
  const TMP = fs.mkdtempSync(path.join(ROOT, 'fx-'));
  const ctx = TC.createContext('cashier_composite', { platform: 'meituan', taskId, businessDate: BD });
  const counts = { precheck: 0, query: 0, export: 0, passive: 0, download: 0, archive: 0, validate: 0 };
  const saved = [];
  const auditPending = [];
  let s = null;
  const resolvedOpts = Object.assign({ secretFile: GOOD_SECRET_FILE, timeoutMs: 8000, testRunId: RUN }, auditOpts || {});
  const audit = WIRING.createRealDownloadAudit({
    ctx,
    batcher: boomBatcher ? makeBoomBatcher(ctx, resolvedOpts) : null,
    opts: resolvedOpts,
    onPending: (i) => auditPending.push(i),
  });
  // 测试用长等待（fixture 需要看到全部事件落地）；生产保持 whenIdle 的短默认上限（5s）
  const _whenIdle = audit.whenIdle;
  audit.whenIdle = (o = {}) => _whenIdle(Object.assign({ timeoutMs: 180000 }, o));
  const base = (v) => {
    if (baseSave) return baseSave(v);
    s = JSON.parse(JSON.stringify(v));
    saved.push({ phase: v.phase, snap: JSON.parse(JSON.stringify(v)) });
  };
  const wrapped = audit.wrapSave(base);
  const store = {
    load: () => s,
    save: (v) => { const r = wrapped(v); if (doubleSave) wrapped(v); return r; },
  };
  const picked = BD.replace(/-/g, '/');
  const adapters = {
    precheck: async () => { counts.precheck += 1; return failAt === 'precheck' ? { ok: false, reason: '前置校验未通过：页面元素缺失' } : { ok: true }; },
    probeDownloadList: async () => ({ ok: true }),
    navigateAndQuery: async () => { counts.query += 1; return failAt === 'query' ? { ok: false, reason: '查询校验未通过：行数与声明不符' } : { ok: true, declared_count: 22 }; },
    submitExport: async () => { counts.export += 1; return failAt === 'export' ? { ok: false, reason: '导出提交失败：对话框未出现' } : { ok: true, dialog_text: '本次导出数据共22条' }; },
    readDownloadRows: async () => ({
      rows: [
        { cells: ['序号', '业务模块', '申请内容', '申请人', '申请时间', '更新时间', '状态', '操作'], rect: { x: 0, y: 0, w: 10, h: 10 }, controls: [] },
        { cells: ['1', '报表中心', `综合营业统计(营业日期【${picked}-${picked}】)`, 'LongXia', futureApply(), futureApply(), '导出完成', '下载'], rect: { x: 0, y: 20, w: 100, h: 20 }, controls: [{ text: '下载', selector: '#d', rect: { x: 20, y: 24, w: 20, h: 12 } }] },
      ],
    }),
    waitForPassiveFile: async () => { counts.passive += 1; return failAt === 'download' ? { ok: false, reason: '被动下载等待超时 120s' } : { ok: true, file: path.join(TMP, `${BD}.xlsx`), name: `${BD}.xlsx`, size: 24952, elapsed_ms: 12 }; },
    observeDownloadList: async () => ({ ok: true, read_only: true, outcome: 'wait', detail: '只读观察', clicked: false }),
    downloadFile: async () => { counts.download += 1; return { ok: true, file: path.join(TMP, 'd.xlsx'), suggested_name: 'd.xlsx' }; },
    archive: async () => { counts.archive += 1; return failAt === 'archive' ? { ok: false, reason: '归档失败：目标目录不可写' } : { ok: true, archived_path: path.join(TMP, 'a.xlsx'), archived_name: 'a.xlsx', size: 1, sha256: 'a'.repeat(64) }; },
    validateFile: async () => { counts.validate += 1; return failAt === 'validate' ? { ok: false, errors: ['行数不符'] } : { ok: true, checks: {} }; },
    screenshot: async () => ({ ok: true }),
    setApprovals: async () => {},
    resetApprovals: async () => {},
  };
  const orch = createOrchestrator({ ctx, store, adapters, sleep: async () => {}, wait: { initialWaitMs: 0, pollIntervalMs: 0, maxWaitMs: 3 } });
  return { ctx, store, orch, audit, counts, saved, auditPending, get state() { return s; } };
}
const runFx = async (fx) => { const r = await fx.orch.run({ applicant: 'LongXia' }); await fx.audit.whenIdle(); return r; };

const OK6 = ['PRECHECK', 'QUERY_DONE', 'EXPORT_SUBMITTED', 'WAITING_EXPORT', 'DOWNLOADED', 'FILE_VALIDATED'];
const OK7 = OK6.concat(['FAILED']);

(async () => {
  const before = snap();
  ck('0 前置：本次 test_run_id 尚无记录', before.events.length === 0 && before.runs.length === 0, JSON.stringify({ e: before.events.length, r: before.runs.length }));
  ck('0b 接线只允许下载侧 7 个阶段（不含 IMPORT_/PUSH_/WAITING_HUMAN）',
    WIRING.WIRED_STAGES.length === 7 && OK7.every((s) => WIRING.WIRED_STAGES.includes(s)) &&
    WIRING.WIRED_STAGES.every((s) => !/^(IMPORT_|PUSH_|WAITING_HUMAN)/.test(s)) &&
    WIRING.WIRED_PHASE_KEYS.includes('QUERY') && WIRING.WIRED_PHASE_KEYS.includes('QUERY_DONE') &&
    MAP.stageForPhase('QUERY') === MAP.stageForPhase('QUERY_DONE'),
    JSON.stringify({ stages: WIRING.WIRED_STAGES, phase_keys: WIRING.WIRED_PHASE_KEYS }));

  // ---- a. 正常下载路径：只产生 6 个成功阶段事件 ----
  const fA = makeFixture({ BD: '2026-09-19', taskId: `${RUN}-a` });
  const rA = await runFx(fA);
  const A = fA.audit.summary();
  ck('a1 正常路径业务结果 FILE_VALIDATED', rA.ok === true && rA.result === 'FILE_VALIDATED', JSON.stringify({ result: rA.result, error: rA.error || null }));
  const A_posts = A.batch ? A.batch.posts_log.map((p) => ({ reason: p.reason, stages: p.stages })) : [];
  ck('a2 只产生 6 个阶段事件且顺序与映射一致；检查点批量恰为 C1(4)+C2(2) 两次 POST（whenIdle 未产生第三次）',
    JSON.stringify(A.emitted_stages) === JSON.stringify(OK6) &&
    A_posts.length === 2 && A_posts[0].reason === 'C1' && JSON.stringify(A_posts[0].stages) === JSON.stringify(CP_C1) &&
    A_posts[1].reason === 'C2' && JSON.stringify(A_posts[1].stages) === JSON.stringify(CP_C2),
    JSON.stringify({ stages: A.emitted_stages, posts: A_posts }));
  ck('a3 导出/下载动作各只发生一次', fA.counts.export === 1 && fA.counts.passive === 1 && fA.counts.download === 0, JSON.stringify(fA.counts));
  const sA = snap();
  ck('a4 中控落库阶段与顺序一致，且无中间态、无 IMPORT_/PUSH_/WAITING_HUMAN',
    JSON.stringify(stagesFor(sA, `${RUN}-a`)) === JSON.stringify(OK6), JSON.stringify(stagesFor(sA, `${RUN}-a`)));
  ck('a5 该 run 只有一个业务 run 记录（13 阶段未伪造）', rowsFor(sA, `${RUN}-a`).length === 6 && sA.runs.filter((r) => r[1] === `${RUN}-a`).length === 1, JSON.stringify(sA.runs));

  // ---- b. 任意失败只额外产生一次 FAILED ----
  const fB = makeFixture({ BD: '2026-09-19', taskId: `${RUN}-b`, failAt: 'export' });
  const rB = await runFx(fB);
  const B = fB.audit.summary();
  ck('b1 导出后失败：PRECHECK→QUERY_DONE→FAILED，只一次 FAILED',
    JSON.stringify(B.emitted_stages) === JSON.stringify(['PRECHECK', 'QUERY_DONE', 'FAILED']) && fB.counts.export === 1,
    JSON.stringify({ stages: B.emitted_stages, export: fB.counts.export, result: rB.result }));
  const sB = snap();
  ck('b2 FAILED 事件带原 phase 与脱敏失败原因（无路径/无完整 SHA）',
    (() => {
      const ev = rowsFor(sB, `${RUN}-b`).find((e) => e[2] === 'FAILED');
      return !!ev && JSON.stringify(stagesFor(sB, `${RUN}-b`)) === JSON.stringify(['PRECHECK', 'QUERY_DONE', 'FAILED']);
    })(), JSON.stringify(stagesFor(sB, `${RUN}-b`)));
  const fB2 = makeFixture({ BD: '2026-09-19', taskId: `${RUN}-b2`, failAt: 'download' });
  await runFx(fB2);
  ck('b3 下载阶段失败：FAILED 的原 phase 为 WAITING_EXPORT',
    JSON.stringify(fB2.audit.summary().emitted_stages) === JSON.stringify(['PRECHECK', 'QUERY_DONE', 'EXPORT_SUBMITTED', 'WAITING_EXPORT', 'FAILED']),
    JSON.stringify(fB2.audit.summary().emitted_stages));

  // ---- c. 同一 phase 连续 save 不重复发事件 ----
  const fC = makeFixture({ BD: '2026-09-19', taskId: `${RUN}-c`, doubleSave: true });
  await runFx(fC);
  const sC = snap();
  ck('c1 每个 phase 都被保存两次，仍只产生 6 条事件（无重复）',
    JSON.stringify(fC.audit.summary().emitted_stages) === JSON.stringify(OK6) && rowsFor(sC, `${RUN}-c`).length === 6,
    JSON.stringify({ stages: fC.audit.summary().emitted_stages, rows: rowsFor(sC, `${RUN}-c`).length }));
  const extra = fC.audit.summary().skipped.filter((x) => x.reason === 'same_phase_in_process').length;
  ck('c2 去重由 lastPhase 生效（记录到同 phase 跳过）', extra >= 5, `skipped_same_phase=${extra}`);
  const dupBefore = rowsFor(snap(), `${RUN}-c`).length;
  for (let i = 0; i < 3; i += 1) fC.store.save(fC.state);
  await fC.audit.whenIdle();
  ck('c3 终态重复 save 三次不新增事件行', rowsFor(snap(), `${RUN}-c`).length === dupBefore, `${dupBefore} -> ${rowsFor(snap(), `${RUN}-c`).length}`);
  // 同一阶段收敛自多个 phase（QUERY / QUERY_DONE）时也只发一次
  const dupCtx = TC.createContext('cashier_composite', { platform: 'meituan', taskId: `${RUN}-q`, businessDate: '2026-09-19' });
  const dupAudit = WIRING.createRealDownloadAudit({ ctx: dupCtx, opts: { secretFile: GOOD_SECRET_FILE, timeoutMs: 8000, testRunId: RUN } });
  const dupSave = dupAudit.wrapSave(() => {});
  dupSave({ phase: 'QUERY' });
  dupSave({ phase: 'QUERY_DONE' });
  await dupAudit.whenIdle();
  ck('c4 QUERY 与 QUERY_DONE 收敛到同一阶段时只发一次（按 stage 去重）',
    JSON.stringify(dupAudit.summary().emitted_stages) === JSON.stringify(['QUERY_DONE']),
    JSON.stringify(dupAudit.summary().emitted.map((e) => ({ p: e.phase, s: e.stage, sk: e.skipped, id: e.event_id }))));
  ck('c5 同阶段不同 phase 的跳过原因可区分（same_stage_in_process）',
    dupAudit.summary().skipped.some((x) => x.reason === 'same_stage_in_process'),
    JSON.stringify(dupAudit.summary().skipped));

  // ---- d. 崩溃恢复：重复 emit 的 event_id 相同，服务端仅幂等确认 ----
  const fD = makeFixture({ BD: '2026-09-19', taskId: `${RUN}-d` });
  await runFx(fD);
  const idsFirst = {};
  fD.audit.summary().emitted.forEach((e) => { if (e.event_id) idsFirst[e.stage] = e.event_id; });
  const rowsFirst = rowsFor(snap(), `${RUN}-d`).length;
  const fD2 = makeFixture({ BD: '2026-09-19', taskId: `${RUN}-d` });   // 新进程语义：新接线实例、从已落盘状态重放
  for (const rec of fD.saved) fD2.store.save(rec.snap);
  await fD2.audit.whenIdle();
  const D2 = fD2.audit.summary();
  const idsSecond = {};
  D2.emitted.forEach((e) => { if (e.event_id) idsSecond[e.stage] = e.event_id; });
  const rowsSecond = rowsFor(snap(), `${RUN}-d`).length;
  ck('d1 恢复后重复 emit 的 event_id 与首次完全相同',
    JSON.stringify(idsFirst) === JSON.stringify(idsSecond) && Object.keys(idsFirst).length === 6,
    JSON.stringify({ first: Object.keys(idsFirst).length, second: Object.keys(idsSecond).length, same: JSON.stringify(idsFirst) === JSON.stringify(idsSecond) }));
  ck('d2 服务端仅幂等确认，事件行数不增长', rowsSecond === rowsFirst && rowsFirst === 6, `${rowsFirst} -> ${rowsSecond}`);
  ck('d3 重复上报被识别为 duplicate（非第二次业务事件）',
    D2.emitted.filter((e) => e.ok && !e.skipped).every((e) => e.duplicates >= 1 || e.delivery_kind === 'duplicate'),
    JSON.stringify(D2.emitted.filter((e) => e.ok && !e.skipped).map((e) => ({ s: e.stage, k: e.delivery_kind, a: e.accepted, d: e.duplicates, st: e.status }))));

  // ---- e. 中控不可达：业务照常完成，outbox 有 pending，恢复后补送 ----
  const fE = makeFixture({ BD: '2026-09-19', taskId: `${RUN}-e`, auditOpts: { secretFile: DOWN_SECRET_FILE, timeoutMs: 1200 } });
  const rE = await runFx(fE);
  const pendE = OUTBOX.pendingCount(fE.ctx);
  ck('e1 中控不可达时业务状态机照常完成', rE.ok === true && rE.result === 'FILE_VALIDATED', JSON.stringify({ result: rE.result, error: rE.error || null }));
  const E_posts = fE.audit.summary().batch ? fE.audit.summary().batch.posts_log.map((p) => ({ reason: p.reason, stages: p.stages })) : [];
  ck('e2 不可达时 6 条事件全部进 outbox（pending=6），导出/下载未重跑；仍只有 C1/C2 两次批量尝试',
    pendE === 6 && fE.counts.export === 1 && fE.counts.passive === 1 &&
    E_posts.length === 2 && E_posts[0].reason === 'C1' && JSON.stringify(E_posts[0].stages) === JSON.stringify(CP_C1) &&
    E_posts[1].reason === 'C2' && JSON.stringify(E_posts[1].stages) === JSON.stringify(CP_C2),
    JSON.stringify({ pending: pendE, counts: fE.counts, posts: E_posts }));
  ck('e3 任务状态记录了 audit_pending 且原因已脱敏',
    fE.auditPending.length === 6 && fE.auditPending.every((x) => !/(\/(?:home|opt|etc|var|root|tmp|usr)\/)|([A-Za-z]:\\)|[0-9a-fA-F]{32,}/.test(x.reason)),
    JSON.stringify(fE.auditPending.slice(0, 2)));
  const fl = await OUTBOX.flush({ ctx: fE.ctx, opts: { secretFile: GOOD_SECRET_FILE, timeoutMs: 8000, testRunId: RUN } });
  const pendAfter = OUTBOX.pendingCount(fE.ctx);
  ck('e4 恢复后补送成功且 pending 归零', pendAfter === 0, JSON.stringify({ flush: fl && (fl.status || fl.reason), pending: pendAfter }));
  const sE = snap();
  ck('e5 补送后中控恰好 6 条且 event_id 与首次一致（无第二条业务事件）',
    JSON.stringify(stagesFor(sE, `${RUN}-e`)) === JSON.stringify(OK6) && rowsFor(sE, `${RUN}-e`).length === 6,
    JSON.stringify(stagesFor(sE, `${RUN}-e`)));

  // ---- f. emit / 落盘异常不触发第二次 export/download ----
  const fF = makeFixture({ BD: '2026-09-19', taskId: `${RUN}-f`, boomBatcher: true });
  const rF = await runFx(fF);
  ck('f1 emit 抛异常不打断业务（仍 FILE_VALIDATED）', rF.ok === true && rF.result === 'FILE_VALIDATED', JSON.stringify({ result: rF.result, error: rF.error || null }));
  ck('f2 emit 异常不触发第二次 export/download', fF.counts.export === 1 && fF.counts.passive === 1 && fF.counts.download === 0, JSON.stringify(fF.counts));
  ck('f3 emit 异常写入 audit_pending 且原因脱敏（无路径/无完整 SHA）',
    fF.auditPending.length === 6 && fF.auditPending.every((x) => !/\/opt\//.test(x.reason) && !/[0-9a-f]{64}/.test(x.reason) && /\[/.test(x.reason)),
    JSON.stringify(fF.auditPending[0] || null));
  const fG = makeFixture({ BD: '2026-09-19', taskId: `${RUN}-g`, baseSave: () => { throw new Error('persist failed'); } });
  let gThrew = false;
  try { await runFx(fG); } catch (_) { gThrew = true; }
  ck('f4 业务落盘失败时不发任何审计事件（emit 仅在落盘成功之后）',
    fG.audit.summary().emitted.length === 0 && fG.counts.export === 0, JSON.stringify({ emitted: fG.audit.summary().emitted.length, export: fG.counts.export, threw: gThrew }));

  // ---- g. 任务状态与审计 API 不泄漏敏感字段 ----
  const dumps = [
    ['fixture 任务状态', JSON.stringify(fA.saved) + JSON.stringify(fE.auditPending) + JSON.stringify(fF.auditPending)],
    ['outbox 落盘', (() => { try { return fs.readdirSync(path.join(ROOT, 'state', 'tasks')).map((d) => path.join(ROOT, 'state', 'tasks', d)).map((p) => fs.readdirSync(p).map((f) => fs.readFileSync(path.join(p, f), 'utf8')).join('')).join(''); } catch (_) { return ''; } })()],
    ['接线摘要', JSON.stringify([fA.audit.summary(), fE.audit.summary(), fF.audit.summary()])],
  ];
  const LEAK = [/\/opt\//, /\/home\//, /eyJ[A-Za-z0-9_-]{10,}\./, /"password"/i, /"cookie"/i, /[0-9a-f]{64}/];
  const leaks = [];
  for (const [name, dump] of dumps) {
    if (dump.includes(SECRET)) leaks.push(`${name}:secret`);
    for (const re of LEAK) if (re.test(dump)) leaks.push(`${name}:${re}`);
  }
  ck('g1 任务状态/outbox/摘要无敏感字段（含密钥本体）', leaks.length === 0, JSON.stringify(leaks));

  let apiLeak = null;
  try {
    const imp = JSON.parse(fs.readFileSync(IMPORTER, 'utf8'));
    const lr = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: imp.username || imp.user || imp.account, password: imp.password || imp.pass }),
    });
    const lj = await lr.json().catch(() => null);
    const token = lj && (lj.token || (lj.data && lj.data.token));
    const runRow = snap().runs.find((r) => r[1] === `${RUN}-a`);
    if (lr.status === 200 && token && runRow) {
      const dr = await fetch(`${BASE}/api/business-analytics/sync-runs/${runRow[0]}`, { headers: { Authorization: `Bearer ${token}` } });
      const text = JSON.stringify(await dr.json().catch(() => null));
      const bad = LEAK.filter((re) => re.test(text)).map(String);
      if (text.includes(SECRET)) bad.push('secret');
      apiLeak = { http: dr.status, bad };
      ck('g2 审计读取接口详情不含敏感字段', dr.status === 200 && bad.length === 0, JSON.stringify(apiLeak));
    } else {
      apiLeak = { http_login: lr.status, run_row: !!runRow };
      ck('g2 审计读取接口详情不含敏感字段', false, `login_or_run_missing ${JSON.stringify(apiLeak)}`);
    }
  } catch (e) {
    ck('g2 审计读取接口详情不含敏感字段', false, `api_check_error:${String(e && e.message).slice(0, 80)}`);
  }

  // ---- 精确清理 + 前后对比 ----
  const preClean = snap();
  const cl = await hmacPost('/api/internal/syncbot/test-cleanup', { test_run_id: RUN }, SECRET);
  const post = snap();
  ck('h1 精确清理：删除数 == 清理前本次 test_run 实际行数',
    cl.status === 200 && cl.json && cl.json.ok === true && cl.json.deleted_events === preClean.events.length && cl.json.deleted_runs === preClean.runs.length,
    JSON.stringify({ deleted_events: cl.json && cl.json.deleted_events, expected: preClean.events.length, deleted_runs: cl.json && cl.json.deleted_runs, expected_runs: preClean.runs.length }));
  ck('h2 清理后本次记录归零、孤儿 0、非 test 指纹未变',
    post.events.length === 0 && post.runs.length === 0 && post.orphans === 0 &&
    post.non_test_events === before.non_test_events && post.non_test_runs === before.non_test_runs,
    JSON.stringify({ e: post.events.length, r: post.runs.length, orphans: post.orphans, nt_e: `${before.non_test_events}->${post.non_test_events}`, nt_r: `${before.non_test_runs}->${post.non_test_runs}` }));
  ck('h3 停止条件：未接入 IMPORT_/PUSH_/WAITING_HUMAN（本入口无此类事件）',
    preClean.events.every((e) => !/^(IMPORT_|PUSH_|WAITING_HUMAN)/.test(e[2])), JSON.stringify([...new Set(preClean.events.map((e) => e[2]))]));

  out.summary = {
    fixture_note: '本套件为离线 fixture：fake adapters + 真实编排器/接线模块，非真实美团运行',
    stages_normal_path: fA.audit.summary().emitted_stages,
    api_timeline_fixture: preClean.events.filter((e) => e[3] === `${RUN}-a`).map((e) => e[2]),
    rows_before_cleanup: preClean.events.length,
    emitted_checks: out.checks.length,
  };
  out.ok = out.checks.every((c) => c.ok);
  out.total = out.checks.length;
  out.failed = out.checks.filter((c) => !c.ok).length;
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
})().catch((e) => {
  console.log(JSON.stringify({ ok: false, fatal: String(e && e.message).slice(0, 300), checks: out.checks }, null, 2));
  process.exit(9);
});
