#!/usr/bin/env node
'use strict';
/**
 * 阶段3 审计接线 · fixture 测试（不访问美团、不导出/下载/导入、不推送、不建 timer、不触碰报表B）
 * 覆盖：13 阶段映射 / event_id 幂等 / 接口不可用时 outbox 保留 / 恢复后补送 /
 *       HMAC 拒绝不泄露密钥 / FAILED 与 WAITING_HUMAN 不触发导入或推送 / 补录不伪装实时成功。
 * 不打印任何密钥、签名、口令；outbox 落在临时 SYNCBOT_ROOT，隔离于生产。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p3stage-'));
process.env.SYNCBOT_ROOT = ROOT;

const APP = '/home/ubuntu/app';
const REAL_SECRET = '/opt/zhongkong-sync-bot/state/secrets/audit-hmac.json';
const BASE = 'http://127.0.0.1:3456';
const CLEAN = '/api/internal/syncbot/test-cleanup';
const HIST_TASK = 'fixture-backfill-20260917';

const OUTBOX = require('/opt/zhongkong-sync-bot/app/src/phase3/audit-outbox.js');
const MAP = require('/opt/zhongkong-sync-bot/app/src/phase3/audit-stage-map.js');
const REPORTER = require('/opt/zhongkong-sync-bot/app/src/phase3/audit-reporter.js');

const RUN = `test-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
const CTX = Object.freeze({ reportType: 'cashier_composite', platform: 'meituan', taskId: RUN, businessDate: '2026-09-19' });
const SECRET = JSON.parse(fs.readFileSync(REAL_SECRET, 'utf8')).secret;
const O = { secretFile: REAL_SECRET, timeoutMs: 8000 };

const out = { test_run_id: RUN, checks: [], stages_emitted: [] };
const ck = (n, ok, d) => out.checks.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });

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
function snap() {
  const py = path.join(ROOT, 'snap.py');
  fs.writeFileSync(py, `import hashlib, json, sqlite3
def _con():
    for u in ('file:${APP}/data/database.sqlite?mode=ro', 'file:${APP}/data/database.sqlite?mode=ro&immutable=1'):
        try:
            k = sqlite3.connect(u, uri=True); k.execute('PRAGMA query_only=ON'); return k
        except Exception:
            pass
    raise SystemExit('db_unreadable')
con = _con(); c = con.cursor()
test_ids = set(r[0] for r in c.execute('SELECT id FROM sync_job_runs WHERE is_test=1'))
runs = c.execute('SELECT id,task_id,status,phase,event_count FROM sync_job_runs ORDER BY id').fetchall()
evs = c.execute('SELECT event_id,run_id,stage FROM sync_job_events ORDER BY id').fetchall()
ntr = [r for r in runs if r[0] not in test_ids]; nte = [e for e in evs if e[1] not in test_ids]
print(json.dumps({'runs_total': len(runs), 'events_total': len(evs),
 'non_test_fp': hashlib.sha256(json.dumps([ntr, nte], ensure_ascii=False, default=str).encode()).hexdigest(),
 'non_test_runs': len(ntr), 'non_test_events': len(nte),
 'this_run_runs': c.execute('SELECT COUNT(*) FROM sync_job_runs WHERE test_run_id=?', ('${RUN}',)).fetchone()[0],
 'this_run_events': c.execute('SELECT COUNT(*) FROM sync_job_events WHERE test_run_id=?', ('${RUN}',)).fetchone()[0],
 'this_run_stages': [r[0] for r in c.execute('SELECT stage FROM sync_job_events WHERE test_run_id=? ORDER BY id', ('${RUN}',))],
 'hist': c.execute('SELECT task_id,is_backfill,reconstructed,not_a_realtime_success,ready_to_push,status,event_count FROM sync_job_runs WHERE task_id=?', ('${HIST_TASK}',)).fetchall(),
 'bf_row': c.execute('SELECT status,is_backfill,reconstructed,not_a_realtime_success,ready_to_push FROM sync_job_runs WHERE test_run_id=? AND task_id LIKE ?', ('${RUN}','%-bf')).fetchall(),
}, ensure_ascii=False))`);
  return JSON.parse(execSync(`python3 ${py}`, { encoding: 'utf8' }));
}

(async () => {
  // ---- 1) 13 阶段映射 ----
  const cov = MAP.coverage();
  ck('1a 13 阶段映射全覆盖（无缺失、无越界）', cov.ok && cov.total === 13 && cov.produced === 13, JSON.stringify(cov));
  const phaseExpect = { PRECHECK: 'PRECHECK', QUERY: 'QUERY_DONE', EXPORT_SUBMITTED: 'EXPORT_SUBMITTED', WAITING_EXPORT: 'WAITING_EXPORT', DOWNLOADED: 'DOWNLOADED', FILE_VALIDATED: 'FILE_VALIDATED', FAILED: 'FAILED' };
  const badPhase = Object.entries(phaseExpect).filter(([p, s]) => MAP.stageForPhase(p) !== s);
  ck('1b 编排器 7 个 phase 映射正确', badPhase.length === 0, JSON.stringify(badPhase));
  ck('1c 中间态（PENDING/PRECHECK_OK/PROBE/EXPORT_READY/STOPPED）不发事件',
    ['PENDING', 'PRECHECK_OK', 'DOWNLOAD_LIST_PROBE', 'EXPORT_READY', 'STOPPED'].every((p) => MAP.stageForPhase(p) === null), '');
  const stepExpect = { import_start: 'IMPORT_STARTED', import_ok: 'IMPORT_SUCCEEDED', import_fail: 'IMPORT_FAILED', push_ok: 'PUSH_SUCCEEDED', push_fail: 'PUSH_FAILED', waiting_human: 'WAITING_HUMAN' };
  ck('1d 导入/推送/等待人工 6 个 step 映射正确', Object.entries(stepExpect).every(([k, s]) => MAP.stageForStep(k) === s), '');

  const before = snap();
  ck('2 前置：本次 test_run_id 尚无记录（可重复运行）', before.this_run_runs === 0 && before.this_run_events === 0, JSON.stringify({ r: before.this_run_runs, e: before.this_run_events }));

  // ---- 3) 13 阶段全部产生事件 ----
  const now = new Date().toISOString();
  const seq = {};
  const emitStage = async (stage, metrics = {}, testRunId = RUN) => {
    seq[stage] = (seq[stage] || 0) + 1;
    const r = await OUTBOX.emit({ ctx: CTX, stage, seq: seq[stage], metrics: Object.assign({ note: `test_run:${RUN}` }, metrics), opts: Object.assign({ testRunId }, O) });
    out.stages_emitted.push({ stage, ok: r.ok, event_id: r.event_id });
    return r;
  };
  for (const s of OUTBOX.STAGES) await emitStage(s, { started_at: now });
  const mid = snap();
  ck('3 13 个阶段事件全部被中控接受并落库', mid.this_run_events === 13 && mid.this_run_stages.length === 13,
    `events=${mid.this_run_events} stages=${JSON.stringify(mid.this_run_stages)}`);
  ck('3b 落库阶段名与契约完全一致', OUTBOX.STAGES.every((s) => mid.this_run_stages.includes(s)), '');

  // ---- 4) event_id 稳定 + 重发幂等 ----
  const r1 = await OUTBOX.emit({ ctx: CTX, stage: 'PRECHECK', seq: 1, metrics: { note: `test_run:${RUN}` }, opts: Object.assign({ testRunId: RUN }, O) });
  ck('4a 相同(任务/阶段/seq) 得同一 event_id', r1.event_id === out.stages_emitted[0].event_id, `${r1.event_id} vs ${out.stages_emitted[0].event_id}`);
  const dup = await hmacPost('/api/internal/syncbot/events', { events: [{ event_id: r1.event_id, task_id: CTX.taskId, report_type: CTX.reportType, business_date: CTX.businessDate, platform: 'meituan', stage: 'PRECHECK', at: now, seq: 1, is_test: true, test_run_id: RUN, metrics: { note: `test_run:${RUN}` } }] }, SECRET);
  ck('4b 重发同一 event_id → 服务端幂等（duplicates=1, accepted=0）', dup.json && dup.json.duplicates === 1 && dup.json.accepted === 0, JSON.stringify(dup.json));
  const afterDup = snap();
  ck('4c 重发未新增事件行', afterDup.this_run_events === 13, `events=${afterDup.this_run_events}`);

  // ---- 5) 接口不可用 → outbox 保留（不伪造成功）----
  const bad = await OUTBOX.emit({ ctx: CTX, stage: 'QUERY_DONE', seq: 99, metrics: { note: `test_run:${RUN}` }, opts: Object.assign({ testRunId: RUN }, O, { endpoint: 'http://127.0.0.1:9/nope' }) });
  ck('5a 接口不可用时返回 ok=false 且 queued=true（未伪造成功）', bad.ok === false && bad.queued === true, JSON.stringify(bad));
  ck('5b 该事件已保留在本地 outbox（pendingCount=1）', OUTBOX.pendingCount(CTX) === 1, `pending=${OUTBOX.pendingCount(CTX)}`);
  const of = OUTBOX.outboxFile(CTX.platform, CTX.reportType, CTX.businessDate);
  const obTxt = fs.readFileSync(of, 'utf8');
  ck('5c outbox 内含 audit_pending 记录', /"type":"audit_pending"/.test(obTxt), '');
  ck('5d outbox 文件权限 0600', (fs.statSync(of).mode & 0o777) === 0o600, (fs.statSync(of).mode & 0o777).toString(8));

  // ---- 6) 恢复后补送一次 ----
  const fl = await OUTBOX.flush({ ctx: CTX, opts: O });
  ck('6a 恢复后补送成功（delivered=1）', fl.ok === true && fl.delivered === 1 && fl.failed === 0, JSON.stringify(fl));
  ck('6b 补送后 pending 归零', OUTBOX.pendingCount(CTX) === 0, `pending=${OUTBOX.pendingCount(CTX)}`);
  const afterFlush = snap();
  ck('6c 补送后本次 run 事件数=14（13 阶段 + 补送的 1 条）', afterFlush.this_run_events === 14, `events=${afterFlush.this_run_events}`);

  // ---- 7) HMAC 拒绝不泄露密钥 ----
  const wrongFile = path.join(ROOT, 'wrong-secret.json');
  fs.writeFileSync(wrongFile, JSON.stringify({ secret: 'WRONG-SECRET-0123456789abcdef' }), { mode: 0o600 });
  const badHmac = await OUTBOX.emit({ ctx: CTX, stage: 'DOWNLOADED', seq: 77, metrics: { note: `test_run:${RUN}` }, opts: Object.assign({ testRunId: RUN }, O, { secretFile: wrongFile }) });
  ck('7a 错误密钥上报被拒且入 outbox', badHmac.ok === false && badHmac.queued === true, JSON.stringify(badHmac));
  const wholeOutbox = fs.readFileSync(of, 'utf8');
  const leaked = ['WRONG-SECRET-0123456789abcdef', SECRET].some((s) => JSON.stringify(badHmac).includes(s) || wholeOutbox.includes(s));
  ck('7b 返回值与 outbox 均不含任何密钥明文', leaked === false, '');
  ck('7c 拒绝原因只给字符串标记，不含签名', /signature_mismatch|hmac|401/i.test(JSON.stringify(badHmac)) === true && !/[0-9a-f]{64}/.test(JSON.stringify(badHmac)), JSON.stringify(badHmac).slice(0, 120));
  await OUTBOX.flush({ ctx: CTX, opts: O });   // 用正确密钥补送，清空 pending

  // ---- 8) FAILED / WAITING_HUMAN 不触发导入或推送 ----
  ck('8a FAILED 不授权任何业务动作', Array.isArray(MAP.allowedBusinessActions('FAILED')) && MAP.allowedBusinessActions('FAILED').length === 0, '');
  ck('8b WAITING_HUMAN 不授权任何业务动作', MAP.allowedBusinessActions('WAITING_HUMAN').length === 0, '');
  ck('8c isNeverBusinessAction 对两态均为真', MAP.isNeverBusinessAction('FAILED') && MAP.isNeverBusinessAction('WAITING_HUMAN'), '');
  const snap8a = snap();
  const fk = await MAP.emitForPhase({ outbox: OUTBOX, ctx: CTX, phase: 'FAILED', seq: 50, metrics: { note: `test_run:${RUN}`, failure_reason: '仅测试：不触发任何业务动作' }, opts: Object.assign({ testRunId: RUN }, O) });
  ck('8d 发 FAILED 事件本身成功', fk.ok === true, JSON.stringify(fk));
  const snap8b = snap();
  const cntOf = (s, st) => s.this_run_stages.filter((x) => x === st).length;
  const addedStages = OUTBOX.STAGES.filter((s) => cntOf(snap8b, s) > cntOf(snap8a, s));
  ck('8e 该次调用只新增 FAILED，未连带产生任何 IMPORT_/PUSH_ 阶段事件（按落盘事件断言，不用旁路数组）',
    addedStages.length === 1 && addedStages[0] === 'FAILED' && !/^IMPORT_|^PUSH_/.test(addedStages[0]),
    JSON.stringify(addedStages));

  // ---- 9) 历史补录不伪装实时成功 ----
  const bfCtx = Object.freeze({ reportType: 'cashier_composite', platform: 'meituan', taskId: `${RUN}-bf`, businessDate: '2026-09-17' });
  const bf = await OUTBOX.emit({ ctx: bfCtx, stage: 'FILE_VALIDATED', seq: 1, metrics: {
    note: `test_run:${RUN}`, original_filename: '鹅太公_综合营业统计_selftest.xlsx', file_size: 24952, sha256: '4bf6ac763b23e84a3c2b971fda97e340',
    is_backfill: 1, reconstructed: 1, not_a_realtime_success: 1, ready_to_push: 0, validation: { ok: true, store_rows: 22 } }, opts: Object.assign({ testRunId: RUN }, O) });
  // 上报口径回归：不得再向中控发送派生字段 sha256_prefix（中控自行由 sha256 派生）
  const nm = REPORTER.normalizeMetrics({ sha256: 'a'.repeat(64), original_filename: '/opt/x/y.xlsx' });
  const wireOk = nm.sha256_prefix === undefined && typeof nm.sha256 === 'string' && nm.sha256.length === 64 && nm.original_filename === 'y.xlsx';
  ck('9a 补录事件上报成功（上报口径已去派生字段 sha256_prefix）', bf.ok === true && wireOk,
    JSON.stringify({ ok: bf.ok, event_id: bf.event_id, status: bf.status, queued: bf.queued, delivery_kind: bf.delivery_kind, reason: bf.reason || null, rejected_count: bf.rejected_count || 0, rejected_reasons: bf.rejected_reasons || [], wire_metrics_keys: Object.keys(nm).sort() }));
  const bfSnap = snap();
  const row = (bfSnap.bf_row && bfSnap.bf_row[0]) || null;
  ck('9b 补录记录三标记齐全且 ready_to_push=false（未伪装实时成功）',
    !!row && Number(row[1]) === 1 && Number(row[2]) === 1 && Number(row[3]) === 1 && Number(row[4]) === 0,
    JSON.stringify({ status: row && row[0], is_backfill: row && row[1], reconstructed: row && row[2], not_a_realtime: row && row[3], ready_to_push: row && row[4] }));
  ck('9c 历史补录示例记录未被触碰', JSON.stringify(bfSnap.hist) === JSON.stringify(before.hist), JSON.stringify(bfSnap.hist));

  // ---- 9d) 用页面读取接口验证阶段时间线（只打印状态码与阶段名，不打印任何凭据）----
  try {
    const imp = JSON.parse(fs.readFileSync('/opt/zhongkong-sync-bot/state/secrets/project-importer.json', 'utf8'));
    const lg = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: imp.username, password: imp.password }) });
    const lj = await lg.json().catch(() => null);
    ck('9d 读取接口登录（只读，仅报状态码）', lg.status === 200 && !!(lj && lj.token), `http=${lg.status}`);
    const tok = lj && lj.token;
    const list = await fetch(BASE + '/api/business-analytics/sync-runs?page_size=100', { headers: { Authorization: 'Bearer ' + tok } });
    const ljr = await list.json().catch(() => null);
    const row = ljr && (ljr.runs || []).find((r) => r.task_id === CTX.taskId);
    ck('9e 列表接口能看到本次任务', list.status === 200 && !!row, `http=${list.status} task=${row ? row.task_id : 'not_found'}`);
    const det = await fetch(BASE + '/api/business-analytics/sync-runs/' + (row && row.id), { headers: { Authorization: 'Bearer ' + tok } });
    const djr = await det.json().catch(() => null);
    const stages = ((djr && djr.events) || []).map((e) => e.stage);
    out.api_timeline = { http: det.status, task_id: row && row.task_id, event_count: stages.length, stages, status: djr && djr.run && djr.run.status, phase: djr && djr.run && djr.run.phase };
    ck('9f 详情接口返回完整阶段时间线（13 阶段全覆盖）',
      det.status === 200 && OUTBOX.STAGES.every((s) => stages.includes(s)),
      `http=${det.status} n=${stages.length}`);
    const dump = JSON.stringify(djr || {});
    const leaks2 = [/\/opt\//, /\/home\//, /eyJ[A-Za-z0-9_-]{10,}\./, /"password"/, /cookie/i, /[0-9a-f]{64}/].filter((re) => re.test(dump));
    ck('9g 读取接口响应不含绝对路径/JWT/口令/Cookie/完整 SHA-256', leaks2.length === 0, leaks2.map(String).join(','));
  } catch (e) { ck('9d-9g 读取接口验证', false, String(e && e.message).slice(0, 120)); }

  // ---- 10) 精确清理本次 fixture ----
  // 清理前的实际行数作为唯一真值来源（不硬编码 14/16）
  const preClean = snap();
  const cl = await hmacPost(CLEAN, { test_run_id: RUN }, SECRET);
  ck('10a 精确清理：删除数 == 清理前本次 test_run 的实际 run/event 行数（不硬编码）',
    cl.status === 200 && cl.json && cl.json.ok === true &&
    cl.json.deleted_runs === preClean.this_run_runs && cl.json.deleted_events === preClean.this_run_events,
    JSON.stringify({ deleted_runs: cl.json && cl.json.deleted_runs, deleted_events: cl.json && cl.json.deleted_events, expected_runs: preClean.this_run_runs, expected_events: preClean.this_run_events }));
  out.cleanup_model = { runs_before_clean: preClean.this_run_runs, events_before_clean: preClean.this_run_events, deleted_runs: cl.json && cl.json.deleted_runs, deleted_events: cl.json && cl.json.deleted_events, stage_rows: preClean.this_run_stages };
  const after = snap();
  ck('10b 本次 run 记录归零', after.this_run_runs === 0 && after.this_run_events === 0, JSON.stringify({ r: after.this_run_runs, e: after.this_run_events }));
  ck('10c 非 test 记录整表指纹未变', after.non_test_fp === before.non_test_fp && after.non_test_runs === before.non_test_runs && after.non_test_events === before.non_test_events,
    `fp ${String(before.non_test_fp).slice(0, 12)} -> ${String(after.non_test_fp).slice(0, 12)}`);

  out.counts = { before_events: before.events_total, after_events: after.events_total, created_events: preClean.this_run_events, cleaned_runs: cl.json && cl.json.deleted_runs, cleaned_events: cl.json && cl.json.deleted_events, residual_this_run: after.this_run_events };
  out.ok = out.checks.every((c) => c.ok);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
})().catch((e) => { console.log(JSON.stringify({ ok: false, fatal: String(e && e.message).slice(0, 200), checks: out.checks }, null, 2)); process.exit(9); });
