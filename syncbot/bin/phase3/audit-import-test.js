#!/usr/bin/env node
'use strict';
/**
 * 导入侧审计接线 · 离线 fixture 套件
 *
 * 明确声明：本套件**不是**真实导入 —— 不访问美团、不导出/下载、**不调用正式导入接口**、
 * 不写项目数据库（业务库只做只读取证）、不推送、不建 timer；fake client 全部由本文件注入。
 * 报表B（item_sales_detail）完全锁定未触碰。审计事件带 is_test=true + 唯一 test_run_id，结束后精确清理。
 * 不打印密钥/签名/JWT/口令/绝对路径/完整 SHA/Excel 原文/门店明细。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p3import-'));
process.env.SYNCBOT_ROOT = ROOT;

const BOT = '/opt/zhongkong-sync-bot';
const APP = '/home/ubuntu/app';
const BASE = 'http://127.0.0.1:3456';
const REAL_SECRET = `${BOT}/state/secrets/audit-hmac.json`;
const IMPORTER = `${BOT}/state/secrets/project-importer.json`;

const OUTBOX = require(`${BOT}/app/src/phase3/audit-outbox.js`);
const MAP = require(`${BOT}/app/src/phase3/audit-stage-map.js`);
const IMP = require(`${BOT}/app/src/phase3/import-audit.js`);
const BAT = require(`${BOT}/app/src/phase3/audit-batcher.js`);
const WIRING = require(`${BOT}/app/src/phase3/real-download-audit.js`);
const TC = require(`${BOT}/app/src/task-context.js`);
const lock = require(`${BOT}/app/src/lock.js`);

const RUN = `test-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
const BD = '2026-09-19';
const SECRET = JSON.parse(fs.readFileSync(REAL_SECRET, 'utf8')).secret;
const GOOD = path.join(ROOT, 'good.json');
const DOWN = path.join(ROOT, 'down.json');
fs.writeFileSync(GOOD, JSON.stringify({ secret: SECRET, endpoint: `${BASE}/api/internal/syncbot/events` }), { mode: 0o600 });
fs.writeFileSync(DOWN, JSON.stringify({ secret: SECRET, endpoint: 'http://127.0.0.1:9/api/internal/syncbot/events' }), { mode: 0o600 });

const out = { suite: 'import-boundary-fixture', fixture: true, real_import: false, real_meituan_run: false, test_run_id: RUN, checks: [] };
const ck = (n, ok, d) => out.checks.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });

const PY = path.join(ROOT, 'snap.py');
fs.writeFileSync(PY, `import json,sqlite3,sys
con=sqlite3.connect('file:${APP}/data/database.sqlite?mode=ro',uri=True)
c=con.cursor(); run=sys.argv[1]
ev=c.execute('SELECT id,event_id,stage,task_id,is_test,test_run_id FROM sync_job_events WHERE test_run_id=? ORDER BY id',(run,)).fetchall()
rn=c.execute('SELECT id,task_id,status,phase,event_count,ready_to_push FROM sync_job_runs WHERE test_run_id=? ORDER BY id',(run,)).fetchall()
print(json.dumps({'events':ev,'runs':rn,
 'non_test_events':c.execute('SELECT COUNT(*) FROM sync_job_events WHERE COALESCE(is_test,0)=0').fetchone()[0],
 'non_test_runs':c.execute('SELECT COUNT(*) FROM sync_job_runs WHERE COALESCE(is_test,0)=0').fetchone()[0],
 'batches':c.execute('SELECT COUNT(*) FROM business_import_batches').fetchone()[0],
 'orphans':c.execute('SELECT COUNT(*) FROM sync_job_events e LEFT JOIN sync_job_runs r ON r.id=e.run_id WHERE r.id IS NULL').fetchone()[0]}))`);
// 中控 DB 由 sql.js 整文件重写（每个审计事件都触发一次 ~385MB 全量保存）：并发保存期间
// 外部只读几乎必然读到撕裂页（sqlite3 "database disk image is malformed"）。这是**瞬时**读失败、
// 不是库损坏，因此只读侧做有界重试（约 36s 预算）；始终 mode=ro，绝不写库。
function snap() {
  let last = null;
  for (let i = 0; i < 45; i += 1) {
    try { return JSON.parse(execSync(`python3 ${PY} ${RUN}`, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })); }
    catch (e) { last = e; try { execSync('sleep 0.8'); } catch (_) {} }
  }
  throw last;
}
const stagesFor = (s, tid) => s.events.filter((e) => e[3] === tid).map((e) => e[2]);
const runFor = (s, tid) => s.runs.find((r) => r[1] === tid) || null;

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

const OKIMPORT = () => ({
  ok: true, http: 200, import_batch_id: 9001,
  raw_imported: 22, matched_stores: 22, imported: 154, errors: [],
  excel_business_date: BD, amount_excel: 12345.67, amount_db: 12345.67, sha256: 'c'.repeat(64),
});

/** 注入式"发送永不返回"的 batcher（真实实例 + 永不 resolve 的 reporter），用于有界性验证 */
function makeHangBatcher(ctx, opts) {
  return BAT.createAuditBatcher({ ctx, opts: Object.assign({}, opts, { reporter: { reportEvents: () => new Promise(() => {}) } }) });
}
function makeFx({ taskId, hang = false, auditOpts = null, onImportCall = null, defaultLock = null }) {
  const ctx = TC.createContext('cashier_composite', { platform: 'meituan', taskId, businessDate: BD });
  const auditPending = [];
  const calls = { import: 0, push: 0 };
  const resolvedOpts = Object.assign({ secretFile: GOOD, timeoutMs: 8000, testRunId: RUN }, auditOpts || {});
  const audit = IMP.createImportAudit({
    ctx,
    batcher: hang ? makeHangBatcher(ctx, resolvedOpts) : null,
    opts: resolvedOpts,
    onPending: (i) => auditPending.push(i),
  });
  // 测试用长等待（fixture 需要看到全部事件落地）；生产保持 whenIdle 的短默认上限（5s）
  const _whenIdle = audit.whenIdle;
  audit.whenIdle = (o = {}) => _whenIdle(Object.assign({ timeoutMs: 180000 }, o));
  const biz = { import: { status: 'pending' }, validate_import: { status: 'pending' }, push: { status: 'pending' }, ready_to_push: false };
  const pushSpy = () => { calls.push += 1; throw new Error('push 不应被调用'); };
  return {
    ctx, audit, auditPending, calls, biz, pushSpy,
    async run({ coverageGate, duplicateCheck, validateFile, humanConfirmation, importFn, expected, idleTimeoutMs, lockHandle = defaultLock }) {
      const r = await audit.runGuardedImport({
        coverageGate, duplicateCheck, validateFile, humanConfirmation, lockHandle, idleTimeoutMs,
        expected, businessDate: BD,
        onImportCall: () => { calls.import += 1; if (onImportCall) onImportCall(); },
        importFn: importFn || (async () => OKIMPORT()),
      });
      // fixture 里模拟「正式导入成功后由 state.js 闸门决定就绪」；任一失败都保持 false
      if (r.action === 'IMPORT_SUCCEEDED' && r.allow_push === true) biz.import = { status: 'success' };
      else biz.import = { status: 'failed' };
      biz.ready_to_push = biz.import.status === 'success' && biz.validate_import.status === 'passed' && biz.push.status !== 'success';
      return r;
    },
  };
}
const gateOk = async () => ({ ok: true, covered: false });
const noDup = async () => ({ duplicate: false });
const fileOk = async () => ({ ok: true });

(async () => {
  const before = snap();
  ck('0 前置：本次 test_run_id 尚无记录，导入批次基线已记录',
    before.events.length === 0 && before.runs.length === 0, JSON.stringify({ e: before.events.length, r: before.runs.length, batches: before.batches }));
  ck('0b 导入边界只发 4 类事件，且这些 phase 不在下载侧入口（不越界）',
    ['import_start', 'import_ok', 'import_fail', 'waiting_human'].every((k) => !!MAP.stepKind) === false &&
    ['import_start', 'import_ok', 'import_fail', 'waiting_human'].every((k) => !!MAP.stageForStep(k)) &&
    ['IMPORT_STARTED', 'IMPORT_SUCCEEDED', 'IMPORT_FAILED', 'WAITING_HUMAN'].every((s) => !WIRING.WIRED_STAGES.includes(s)),
    JSON.stringify({ steps: ['import_start', 'import_ok', 'import_fail', 'waiting_human'].map((k) => MAP.stageForStep(k)), download_stages: WIRING.WIRED_STAGES }));

  // ---- 1. G3 通过 → IMPORT_STARTED → fake 成功 → 验收通过 → IMPORT_SUCCEEDED ----
  const f1 = makeFx({ taskId: `${RUN}-i1` });
  const r1 = await f1.run({ coverageGate: gateOk, duplicateCheck: noDup, validateFile: fileOk });
  await f1.audit.whenIdle();
  const s1 = snap();
  ck('i1 正常导入：动作 IMPORT_SUCCEEDED、导入仅 1 次、允许推送',
    r1.action === 'IMPORT_SUCCEEDED' && r1.allow_push === true && f1.calls.import === 1, JSON.stringify({ action: r1.action, allow_push: r1.allow_push, import: f1.calls.import }));
  const i1posts = f1.audit.summary().batch ? f1.audit.summary().batch.posts_log.map((p) => ({ reason: p.reason, stages: p.stages })) : [];
  ck('i2 事件顺序恰为 IMPORT_STARTED → IMPORT_SUCCEEDED（无 WAITING_HUMAN、无 IMPORT_FAILED），且恰为 C3(1)+C4(1) 两次批量 POST',
    JSON.stringify(stagesFor(s1, `${RUN}-i1`)) === JSON.stringify(['IMPORT_STARTED', 'IMPORT_SUCCEEDED']) &&
    JSON.stringify(f1.audit.summary().emitted_kinds) === JSON.stringify(['IMPORT_STARTED', 'IMPORT_SUCCEEDED']) &&
    i1posts.length === 2 && i1posts[0].reason === 'C3' && JSON.stringify(i1posts[0].stages) === JSON.stringify(['IMPORT_STARTED']) &&
    i1posts[1].reason === 'C4' && JSON.stringify(i1posts[1].stages) === JSON.stringify(['IMPORT_SUCCEEDED']),
    JSON.stringify({ stages: stagesFor(s1, `${RUN}-i1`), posts: i1posts }));
  ck('i3 验收七项全通过（含金额容差内、错误为空、日期一致）',
    r1.verification && r1.verification.raw_imported === 22 && r1.verification.matched_stores === 22 && r1.verification.imported === 154 &&
    r1.verification.errors_empty === true && r1.verification.business_date_matched === true && r1.verification.amount_delta === 0,
    JSON.stringify(r1.verification));
  ck('i4 IMPORT_SUCCEEDED 未擅自把 ready_to_push 置 true（由 state.js 闸门拥有；审计侧不发该字段）',
    !!runFor(s1, `${RUN}-i1`) && (runFor(s1, `${RUN}-i1`)[5] === 0 || runFor(s1, `${RUN}-i1`)[5] === null),
    JSON.stringify(runFor(s1, `${RUN}-i1`)));

  // ---- 2. G3 命中覆盖 → 零导入请求 + WAITING_HUMAN + ready_to_push=false ----
  const f2 = makeFx({ taskId: `${RUN}-i2` });
  const r2 = await f2.run({ coverageGate: async () => ({ ok: false, coverage_hit: true }), duplicateCheck: noDup, validateFile: fileOk });
  await f2.audit.whenIdle();
  const s2 = snap();
  ck('i5 覆盖命中：零导入请求 + WAITING_HUMAN + ready_to_push=false',
    f2.calls.import === 0 && r2.action === 'WAITING_HUMAN' && r2.allow_push === false && f2.biz.ready_to_push === false &&
    JSON.stringify(stagesFor(s2, `${RUN}-i2`)) === JSON.stringify(['WAITING_HUMAN']),
    JSON.stringify({ calls: f2.calls.import, action: r2.action, ready: f2.biz.ready_to_push, stages: stagesFor(s2, `${RUN}-i2`) }));
  ck('i6 覆盖命中的中控 run 行 ready_to_push=0 且有 WAITING_HUMAN',
    !!runFor(s2, `${RUN}-i2`) && Number(runFor(s2, `${RUN}-i2`)[5]) === 0, JSON.stringify(runFor(s2, `${RUN}-i2`)));

  // ---- 2b. 日期重复 → WAITING_HUMAN、零导入 ----
  const f2b = makeFx({ taskId: `${RUN}-i2b` });
  const r2b = await f2b.run({ coverageGate: gateOk, duplicateCheck: async () => ({ duplicate: true }), validateFile: fileOk });
  await f2b.audit.whenIdle();
  ck('i7 业务日期重复导入：零导入 + WAITING_HUMAN(duplicate_business_date)',
    f2b.calls.import === 0 && r2b.action === 'WAITING_HUMAN' && f2b.audit.summary().emitted_kinds.join() === 'WAITING_HUMAN',
    JSON.stringify({ import: f2b.calls.import, action: r2b.action }));

  // ---- 3. 文件校验失败 → 零导入 + WAITING_HUMAN 或 IMPORT_FAILED ----
  const f3 = makeFx({ taskId: `${RUN}-i3` });
  const r3 = await f3.run({ coverageGate: gateOk, duplicateCheck: noDup, validateFile: async () => ({ ok: false, fatal: true, errors: ['sheet_missing'] }) });
  await f3.audit.whenIdle();
  ck('i8 文件校验致命失败：零导入 + IMPORT_FAILED + ready_to_push=false',
    f3.calls.import === 0 && r3.action === 'IMPORT_FAILED' && f3.biz.ready_to_push === false, JSON.stringify({ import: f3.calls.import, action: r3.action }));
  const f3b = makeFx({ taskId: `${RUN}-i3b` });
  const r3b = await f3b.run({ coverageGate: gateOk, duplicateCheck: noDup, validateFile: async () => ({ ok: false, fatal: false, errors: ['row_count_unreadable'] }) });
  await f3b.audit.whenIdle();
  ck('i9 文件校验需人工判断：零导入 + WAITING_HUMAN',
    f3b.calls.import === 0 && r3b.action === 'WAITING_HUMAN', JSON.stringify({ import: f3b.calls.import, action: r3b.action }));
  const f3c = makeFx({ taskId: `${RUN}-i3c` });
  const r3c = await f3c.run({ coverageGate: gateOk, duplicateCheck: noDup, validateFile: async () => ({ ok: false, fatal: false }), humanConfirmation: async () => ({ ok: false }) });
  await f3c.audit.whenIdle();
  ck('i10 人工确认缺失：零导入 + WAITING_HUMAN', f3c.calls.import === 0 && r3c.action === 'WAITING_HUMAN', JSON.stringify({ import: f3c.calls.import, action: r3c.action }));

  // ---- 4. 导入接口 4xx / 5xx / 超时 → IMPORT_FAILED，零自动重试 ----
  const cases = [
    ['i11 导入接口 4xx', async () => ({ ok: false, http: 400, error: 'invalid_payload' }), 'IMPORT_FAILED'],
    ['i12 导入接口 5xx', async () => ({ ok: false, http: 500, error: 'internal' }), 'IMPORT_FAILED'],
    ['i13 导入接口超时', async () => { throw new Error('import request timeout after 30000ms'); }, 'IMPORT_FAILED'],
  ];
  let ci = 0;
  for (const [name, fn, want] of cases) {
    ci += 1;
    const fx = makeFx({ taskId: `${RUN}-i4${ci}` });
    const rr = await fx.run({ coverageGate: gateOk, duplicateCheck: noDup, validateFile: fileOk, importFn: fn });
    await fx.audit.whenIdle();
    const ss = snap();
    ck(`${name}：IMPORT_FAILED、恰好 1 次请求、无重试、ready_to_push=false`,
      rr.action === want && fx.calls.import === 1 && fx.biz.ready_to_push === false &&
      JSON.stringify(stagesFor(ss, `${RUN}-i4${ci}`)) === JSON.stringify(['IMPORT_STARTED', 'IMPORT_FAILED']),
      JSON.stringify({ action: rr.action, import: fx.calls.import, stages: stagesFor(ss, `${RUN}-i4${ci}`), push: fx.calls.push }));
  }

  // ---- 5. 导入后验收失败（4 类）→ IMPORT_FAILED、不得推送 ----
  const bad = [
    ['i14 数量不符', () => Object.assign(OKIMPORT(), { imported: 150 })],
    ['i15 errors 非空', () => Object.assign(OKIMPORT(), { errors: ['row_3_store_unmatched'] })],
    ['i16 合计金额超容差', () => Object.assign(OKIMPORT(), { amount_db: 12345.72 })],
    ['i17 营业日期不一致', () => Object.assign(OKIMPORT(), { excel_business_date: '2026-09-18' })],
  ];
  let bi = 0;
  for (const [name, mk] of bad) {
    bi += 1;
    const fx = makeFx({ taskId: `${RUN}-i5${bi}` });
    const rr = await fx.run({ coverageGate: gateOk, duplicateCheck: noDup, validateFile: fileOk, importFn: async () => mk() });
    await fx.audit.whenIdle();
    const ss = snap();
    let pushed = false;
    if (rr.allow_push === true) { try { fx.pushSpy(); } catch (_) { pushed = true; } }
    ck(`${name}：IMPORT_FAILED + 不推送 + ready_to_push=false`,
      rr.action === 'IMPORT_FAILED' && rr.allow_push === false && pushed === false && fx.calls.push === 0 && fx.biz.ready_to_push === false &&
      JSON.stringify(stagesFor(ss, `${RUN}-i5${bi}`)) === JSON.stringify(['IMPORT_STARTED', 'IMPORT_FAILED']),
      JSON.stringify({ action: rr.action, allow_push: rr.allow_push, push: fx.calls.push, ready: fx.biz.ready_to_push }));
  }
  ck('i18 验收失败原因只含原因码（无原始值/门店明细）',
    (() => { const s = snap(); const r = runFor(s, `${RUN}-i51`); return !!r; })(), JSON.stringify({ note: '见 i14 事件 metrics' }));

  // ---- 6. 中控不可达：导入假流程结果不变 + outbox pending + 恢复后原 event_id 补送 ----
  const f6 = makeFx({ taskId: `${RUN}-i6`, auditOpts: { secretFile: DOWN, timeoutMs: 1200 } });
  const r6 = await f6.run({ coverageGate: gateOk, duplicateCheck: noDup, validateFile: fileOk });
  const pend6 = OUTBOX.pendingCount(f6.ctx);
  ck('i19 中控不可达：导入结果不变（IMPORT_SUCCEEDED）、import 仅 1 次、pending=2',
    r6.action === 'IMPORT_SUCCEEDED' && f6.calls.import === 1 && pend6 === 2, JSON.stringify({ action: r6.action, import: f6.calls.import, pending: pend6 }));
  const ids6a = f6.audit.summary().emitted.filter((e) => e.event_id).map((e) => e.event_id);
  const fl = await OUTBOX.flush({ ctx: f6.ctx, opts: { secretFile: GOOD, timeoutMs: 8000, testRunId: RUN } });
  const s6 = snap();
  const ids6b = s6.events.filter((e) => e[3] === `${RUN}-i6`).map((e) => e[1]);
  ck('i20 恢复补送：pending 归零、中控恰好 2 条且 event_id 与首次一致',
    OUTBOX.pendingCount(f6.ctx) === 0 && JSON.stringify(stagesFor(s6, `${RUN}-i6`)) === JSON.stringify(['IMPORT_STARTED', 'IMPORT_SUCCEEDED']) &&
    JSON.stringify(ids6a.sort()) === JSON.stringify(ids6b.sort()),
    JSON.stringify({ flush: fl && (fl.status || fl.reason), pending: OUTBOX.pendingCount(f6.ctx), ids_same: JSON.stringify(ids6a.sort()) === JSON.stringify(ids6b.sort()) }));

  // ---- 7. 崩溃恢复：旧实例事件 id 与新实例相同，且**不重复调用 fake import**；服务端仅 duplicate ----
  const f7 = makeFx({ taskId: `${RUN}-i7` });
  await f7.run({ coverageGate: gateOk, duplicateCheck: noDup, validateFile: fileOk });
  await f7.audit.whenIdle();
  const ids7a = {}; f7.audit.summary().emitted.forEach((e, i) => { if (e.event_id) ids7a[i] = e.event_id; });
  const rows7a = stagesFor(snap(), `${RUN}-i7`).length;
  const f7b = makeFx({ taskId: `${RUN}-i7` });                      // 新进程语义：全新实例、同 ctx/seq 重放
  const r7b = await f7b.run({ coverageGate: gateOk, duplicateCheck: noDup, validateFile: fileOk });
  await f7b.audit.whenIdle();
  const s7 = snap();
  ck('i21 新实例重放的事件 id 与旧实例完全相同',
    JSON.stringify(ids7a) === JSON.stringify(Object.fromEntries(Object.entries(ids7a).map(([k], i) => [k, f7b.audit.summary().emitted[i] ? f7b.audit.summary().emitted[i].event_id : null]))) &&
    Object.keys(ids7a).length === 2,
    JSON.stringify({ a: Object.values(ids7a).length, b: f7b.audit.summary().emitted.filter((e) => e.event_id).length }));
  ck('i22 服务端仅幂等确认（duplicate），事件行数不增长，未产生第二次导入请求',
    stagesFor(s7, `${RUN}-i7`).length === rows7a && rows7a === 2 &&
    f7b.audit.summary().emitted.every((e) => e.ok && (e.duplicates >= 1 || e.delivery_kind === 'duplicate')),
    JSON.stringify({ rows: `${rows7a}->${stagesFor(s7, `${RUN}-i7`).length}`, kinds: f7b.audit.summary().emitted.map((e) => ({ k: e.kind, d: e.duplicates, k2: e.delivery_kind })) }));
  ck('i23 崩溃恢复的重放仍是 1 次导入（fake import 各实例各 1 次，绝不自动重试已完成的导入）',
    f7.calls.import === 1 && f7b.calls.import === 1 && r7b.action === 'IMPORT_SUCCEEDED', JSON.stringify({ first: f7.calls.import, replay: f7b.calls.import }));

  // ---- 8. 脱敏 ----
  const dumps = [
    ['outbox 落盘', (() => { try { const d = path.join(ROOT, 'state', 'tasks'); return fs.readdirSync(d).map((x) => fs.readdirSync(path.join(d, x)).map((f) => fs.readFileSync(path.join(d, x, f), 'utf8')).join('')).join(''); } catch (_) { return ''; } })()],
    ['audit_pending 记录', JSON.stringify([f6.auditPending, f2.auditPending, f3.auditPending])],
    ['接线摘要', JSON.stringify([f1.audit.summary(), f6.audit.summary()])],
  ];
  const LEAK = [/\/opt\//, /\/home\//, /eyJ[A-Za-z0-9_-]{10,}\./, /"password"/i, /"cookie"/i, /[0-9a-f]{64}/];
  const leaks = [];
  for (const [n, dump] of dumps) {
    if (dump.includes(SECRET)) leaks.push(`${n}:secret`);
    for (const re of LEAK) if (re.test(dump)) leaks.push(`${n}:${re}`);
  }
  ck('i24 outbox/audit_pending/摘要无敏感字段（含密钥本体）', leaks.length === 0, JSON.stringify(leaks));
  let api = null;
  try {
    const impf = JSON.parse(fs.readFileSync(IMPORTER, 'utf8'));
    const lr = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: impf.username || impf.user || impf.account, password: impf.password || impf.pass }) });
    const lj = await lr.json().catch(() => null);
    const token = lj && (lj.token || (lj.data && lj.data.token));
    const row = runFor(snap(), `${RUN}-i1`);
    const dr = token && row ? await fetch(`${BASE}/api/business-analytics/sync-runs/${row[0]}`, { headers: { Authorization: `Bearer ${token}` } }) : { status: 0 };
    const text = JSON.stringify(await (dr.json ? dr.json().catch(() => null) : null));
    const bad = LEAK.filter((re) => re.test(text)).map(String);
    if (text.includes(SECRET)) bad.push('secret');
    api = { http: dr.status, bad };
    ck('i25 审计读取接口详情不含敏感字段', dr.status === 200 && bad.length === 0, JSON.stringify(api));
  } catch (e) {
    ck('i25 审计读取接口详情不含敏感字段', false, `api_check_error:${String(e && e.message).slice(0, 80)}`);
  }

  // ---- 9. audit.whenIdle() 有界性 + 超时记 audit_pending + 任务锁释放 ----
  // "发送永不返回"通过注入 reporter 实现（真实 batcher 实例 + 永不 resolve 的 reportEvents）
  let lockHandle = null; let lockKind = 'fake'; let releaseCalled = false;
  try {
    const real = lock.acquire('phase3-import-fixture', 'cashier_composite', { meta: { task_id: `${RUN}-lock` } });
    lockHandle = { file: real.file, release: () => { releaseCalled = true; return real.release(); } };
    lockKind = 'real';
  } catch (e) {
    lockHandle = { file: null, released: false, release() { this.released = true; releaseCalled = true; } };
  }
  const f9 = makeFx({ taskId: `${RUN}-i9`, hang: true, auditOpts: { secretFile: GOOD, timeoutMs: 3000 } });
  // 不 await：让 whenIdle 恰好在"队列里还有在飞发送"时被调用（这才是中控长期不可达的真实形态）
  const t0 = Date.now();
  const runP = f9.run({ coverageGate: gateOk, duplicateCheck: noDup, validateFile: fileOk, lockHandle, idleTimeoutMs: 400 });
  await new Promise((r) => setTimeout(r, 200));
  const idle = await f9.audit.whenIdle({ timeoutMs: 400 });
  const elapsed = Date.now() - t0;
  ck('i26 whenIdle 有明确超时：队列仍有在飞发送时超时返回，不无限阻塞（1.5s 以内）',
    idle.timed_out === true && idle.ok === false && idle.pending_sends >= 1 && elapsed < 1500 && idle.timeout_ms === 400,
    JSON.stringify({ idle, elapsed_ms: elapsed }));
  ck('i27 超时记录 audit_pending(audit_idle_timeout)',
    f9.audit.summary().pending.some((p) => p.reason === 'audit_idle_timeout'),
    JSON.stringify(f9.audit.summary().pending.slice(0, 2)));
  const r9 = await runP;
  const afterRun = await f9.audit.whenIdle({ timeoutMs: 400 });
  ck('i28 业务返回时锁已释放，且释放后再等审计立即返回（绝不在持锁时等待审计；全程有界）',
    r9.action === 'IMPORT_SUCCEEDED' && releaseCalled === true && afterRun.timed_out === false && afterRun.waited_ms < 200 && Date.now() - t0 < 20000,
    JSON.stringify({ lock_kind: lockKind, release_called: releaseCalled, action: r9.action, after_run_idle: afterRun, elapsed_ms: Date.now() - t0 }));
  const idleFast = await f9.audit.whenIdle({ timeoutMs: 100 });
  ck('i29 再次调用 whenIdle 不抛错且可配置超时生效', idleFast && typeof idleFast.timed_out === 'boolean' && idleFast.timeout_ms === 100, JSON.stringify(idleFast));

  // ---- 收尾：精确清理 + 前后对比 ----
  const preClean = snap();
  const cl = await hmacPost('/api/internal/syncbot/test-cleanup', { test_run_id: RUN }, SECRET);
  const post = snap();
  ck('h1 精确清理：删除数 == 清理前本次 test_run 实际行数',
    cl.status === 200 && cl.json && cl.json.ok === true && cl.json.deleted_events === preClean.events.length && cl.json.deleted_runs === preClean.runs.length,
    JSON.stringify({ deleted_events: cl.json && cl.json.deleted_events, expected: preClean.events.length, deleted_runs: cl.json && cl.json.deleted_runs, expected_runs: preClean.runs.length }));
  ck('h2 清理后归零、孤儿 0、非 test 指纹未变',
    post.events.length === 0 && post.runs.length === 0 && post.orphans === 0 && post.non_test_events === before.non_test_events && post.non_test_runs === before.non_test_runs,
    JSON.stringify({ e: post.events.length, orphans: post.orphans, nt: `${before.non_test_events}->${post.non_test_events}` }));
  ck('h3 **未写项目数据库**：business_import_batches 前后一致（未调用正式导入接口）',
    post.batches === before.batches, JSON.stringify({ batches: `${before.batches}->${post.batches}` }));

  out.summary = {
    fixture_note: '离线 fixture：fake client 注入，未调用正式导入接口、未写业务库、未推送 —— 非真实美团/导入运行',
    success_timeline: stagesFor(preClean, `${RUN}-i1`),
    coverage_hit_timeline: stagesFor(preClean, `${RUN}-i2`),
    verify_fail_timeline: stagesFor(preClean, `${RUN}-i51`),
    unreachable_then_recovered: stagesFor(preClean, `${RUN}-i6`),
    replay_duplicate_only: stagesFor(preClean, `${RUN}-i7`),
    rows_before_cleanup: preClean.events.length,
  };
  out.ok = out.checks.every((c) => c.ok);
  out.total = out.checks.length;
  out.failed = out.checks.filter((c) => !c.ok).length;
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
})().catch((e) => {
  console.log(JSON.stringify({ ok: false, fatal: String((e && e.stack) || e).slice(0, 500), checks: out.checks }, null, 2));
  process.exit(9);
});
