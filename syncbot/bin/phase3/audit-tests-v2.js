#!/usr/bin/env node
'use strict';
/**
 * 审计 API + 测试 fixture 精确清理 验收 v2（可重复运行；只清理本次运行创建的 fixture）
 * 不访问美团、不导出/下载/导入业务 Excel、不推送、不建 timer、不触碰报表 B；不打印密钥/签名/口令。
 *
 * 设计要点：
 *  - 每次运行生成唯一 test_run_id；task_id/event_id 带 test- 前缀并含该 run id；
 *  - 事件带 is_test=true + test_run_id；
 *  - 断言只针对**本次 run** 的记录，不依赖绝对总数 → 可重复运行；
 *  - 清理只按 (is_test=1 AND test_run_id=<本次>) 精确删除；
 *  - 清理前后对**非 test 记录**整表指纹比对，证明真实任务/历史补录逐条未变。
 */
const crypto = require('crypto');
const fs = require('fs');
const { execSync } = require('child_process');

const APP = '/home/ubuntu/app';
const SECRET = JSON.parse(fs.readFileSync('/opt/zhongkong-sync-bot/state/secrets/audit-hmac.json', 'utf8')).secret;
const BASE = 'http://127.0.0.1:3456';
const EV = '/api/internal/syncbot/events';
const CLEAN = '/api/internal/syncbot/test-cleanup';
const PERM_REPORT = 'cashier_composite';
const HIST_TASK = 'fixture-backfill-20260917';

const RUN = `test-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
const out = { test_run_id: RUN, checks: [] };
const ck = (n, ok, d) => out.checks.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });

function sign(rawBody) {
  const ts = String(Date.now());
  return { ts, sig: crypto.createHmac('sha256', SECRET).update(`${ts}.${rawBody}`, 'utf8').digest('hex') };
}
async function post(url, body, opt = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  let { ts, sig } = sign(raw);
  if (opt.badSig) sig = sig.replace(/.$/, sig.endsWith('0') ? '1' : '0');
  const headers = { 'Content-Type': 'application/octet-stream', 'X-Syncbot-Timestamp': ts, 'X-Syncbot-Signature': sig };
  const res = await fetch(BASE + url, { method: 'POST', headers, body: Buffer.from(raw, 'utf8') });
  let j = null; try { j = JSON.parse(await res.text()); } catch {}
  return { status: res.status, json: j };
}
function snapshot() {
  const py = '/tmp/p3audit/snap.py';
  fs.writeFileSync(py, `import hashlib, json, sqlite3
con = sqlite3.connect('file:${APP}/data/database.sqlite?mode=ro', uri=True)
con.execute('PRAGMA query_only=ON'); c = con.cursor()
runs_all = c.execute('SELECT id,task_id,status,phase,event_count FROM sync_job_runs ORDER BY id').fetchall()
evs_all = c.execute('SELECT event_id,run_id,stage FROM sync_job_events ORDER BY id').fetchall()
test_ids = set(r[0] for r in c.execute('SELECT id FROM sync_job_runs WHERE is_test=1'))
non_test_runs = [r for r in runs_all if r[0] not in test_ids]
non_test_evs = [e for e in evs_all if e[1] not in test_ids]
hist = c.execute('SELECT id,task_id,status,is_backfill,reconstructed,not_a_realtime_success,ready_to_push,event_count FROM sync_job_runs WHERE task_id=?', ('${HIST_TASK}',)).fetchall()
print(json.dumps({
  'runs_total': len(runs_all), 'events_total': len(evs_all),
  'test_runs': len(test_ids), 'non_test_runs': len(non_test_runs), 'non_test_events': len(non_test_evs),
  'non_test_fingerprint': hashlib.sha256(json.dumps([non_test_runs, non_test_evs], ensure_ascii=False, default=str).encode()).hexdigest(),
  'hist_row': hist[0] if hist else None,
  'runs_for_this_run': c.execute('SELECT COUNT(*) FROM sync_job_runs WHERE test_run_id=?', ('${RUN}',)).fetchone()[0],
  'events_for_this_run': c.execute('SELECT COUNT(*) FROM sync_job_events WHERE test_run_id=?', ('${RUN}',)).fetchone()[0],
}, ensure_ascii=False))`);
  return JSON.parse(execSync(`python3 ${py}`, { encoding: 'utf8' }));
}

const ev = (over = {}) => Object.assign({
  event_id: `${RUN}-e${crypto.randomBytes(3).toString('hex')}`,
  task_id: `${RUN}-ok`, report_type: PERM_REPORT, business_date: '2026-09-19', platform: 'meituan',
  stage: 'PRECHECK', at: new Date().toISOString(), seq: 1,
  is_test: true, test_run_id: RUN, metrics: { note: `test_run:${RUN}` },
}, over);

(async () => {
  const before = snapshot();
  out.before = before;
  ck('1 前置：本次 test_run_id 尚无记录（可重复运行前提）', before.runs_for_this_run === 0 && before.events_for_this_run === 0, JSON.stringify({ r: before.runs_for_this_run, e: before.events_for_this_run }));
  ck('2 前置：历史补录记录存在（用于证明清理不触碰它）', !!before.hist_row, JSON.stringify(before.hist_row));

  const now = new Date().toISOString();
  const okTask = `${RUN}-ok`, failTask = `${RUN}-fail`, bfTask = `${RUN}-bf`;
  const okBatch = [
    ev({ task_id: okTask, stage: 'PRECHECK', seq: 1, metrics: { started_at: now, note: `test_run:${RUN}` } }),
    ev({ task_id: okTask, stage: 'FILE_VALIDATED', seq: 2, metrics: { original_filename: '鹅太公_综合营业统计_selftest.xlsx', file_size: 24952, sha256: 'abcdef0123456789abcdef', screenshot_count: 3, validation: { ok: true, store_rows: 22 }, ready_to_push: true, note: `test_run:${RUN}` } }),
    ev({ task_id: okTask, stage: 'IMPORT_SUCCEEDED', seq: 3, metrics: { import_batch_id: 999, raw_store_count: 22, matched_store_count: 22, imported: 1, finished_at: now, duration_ms: 1000, note: `test_run:${RUN}` } }),
  ];
  const r1 = await post(EV, { events: okBatch });
  ck('3 成功类 fixture 写入（3 事件）', r1.status === 201 && r1.json.accepted === 3, `http=${r1.status} accepted=${r1.json && r1.json.accepted}`);

  const r2 = await post(EV, { events: [
    ev({ task_id: failTask, stage: 'PRECHECK', seq: 1, metrics: { note: `test_run:${RUN}` } }),
    ev({ task_id: failTask, stage: 'FAILED', seq: 2, metrics: { failure_reason: '查询声明总数 20 不等于 22', finished_at: now, note: `test_run:${RUN}` } }),
  ] });
  ck('4 失败类 fixture 写入（2 事件）', r2.status === 201 && r2.json.accepted === 2, `http=${r2.status}`);

  const r3 = await post(EV, { events: [
    ev({ task_id: bfTask, business_date: '2026-09-17', stage: 'FILE_VALIDATED', seq: 1, metrics: {
      original_filename: '鹅太公_综合营业统计_20260919_0003.xlsx', file_size: 24952, sha256: '4bf6ac763b23e84a3c2b971f', is_backfill: 1, reconstructed: 1,
      not_a_realtime_success: 1, ready_to_push: 0, screenshot_count: 2, validation: { ok: true, store_rows: 22 }, note: `test_run:${RUN}` } }),
  ] });
  ck('5 历史补录类 fixture 写入（1 事件）', r3.status === 201 && r3.json.accepted === 1, `http=${r3.status}`);

  const dup = await post(EV, { events: okBatch });
  ck('6 重复 event_id 幂等（duplicates=3, accepted=0）', dup.json && dup.json.duplicates === 3 && dup.json.accepted === 0, JSON.stringify(dup.json));

  // 说明：无 is_test 的事件是**合法生产事件**（要求 1：生产上报不得携带 is_test），必须被接受。
  // 这里用模型层断言，避免经 HTTP 写入一条真实记录污染库。
  const A = require(`${APP}/lib/sync-job-audit.js`);
  const vProd = A.validateEvent(ev({ is_test: undefined, test_run_id: undefined }));
  ck('7 生产风格事件（无 is_test）被接受且不获得测试标记',
    vProd.ok === true && vProd.clean.is_test === 0 && vProd.clean.test_run_id === '',
    JSON.stringify(vProd.ok ? { is_test: vProd.clean.is_test, test_run_id: vProd.clean.test_run_id } : vProd.reasons));
  const vMix = A.validateEvent(ev({ is_test: undefined }));
  ck('7b 仅带 test_run_id 而无 is_test 被拒', vMix.ok === false, JSON.stringify(vMix.reasons));
  const bad2 = await post(EV, { events: [ev({ test_run_id: 'real-xx-notest' })] });
  ck('8 非 test- 前缀 test_run_id 被拒', bad2.status === 400, `http=${bad2.status}`);
  const bad3 = await post(EV, { events: [ev({ task_id: 'real-task-1' })] });
  ck('9 task_id 无 test- 前缀的"测试"事件被拒', bad3.status === 400, `http=${bad3.status}`);
  const bad4 = await post(EV, { events: [ev({ report_type: 'item_sales_detail' })] });
  ck('10 报表B 事件仍被拒', bad4.status === 400, `http=${bad4.status}`);

  const mid = snapshot();
  out.mid = mid;
  ck('11 三类 fixture 已入库（本次 run 3 runs / 6 events）', mid.runs_for_this_run === 3 && mid.events_for_this_run === 6, JSON.stringify({ r: mid.runs_for_this_run, e: mid.events_for_this_run }));

  const noHmac = await fetch(BASE + CLEAN, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('{}') });
  ck('12 清理接口无 HMAC → 401', noHmac.status === 401, `http=${noHmac.status}`);
  const badSig = await post(CLEAN, { test_run_id: RUN }, { badSig: true });
  ck('13 清理接口错误签名 → 401', badSig.status === 401, `http=${badSig.status}`);
  const empt = await post(CLEAN, { test_run_id: '' });
  ck('14 空 test_run_id → 400 且 refused', empt.status === 400 && empt.json && empt.json.refused === true, JSON.stringify(empt.json));
  const fuzzy = await post(CLEAN, { test_run_id: 'test-' });
  ck('15 模糊/非法 test_run_id（test-）→ 400 拒绝', fuzzy.status === 400, `http=${fuzzy.status}`);
  const realTry = await post(CLEAN, { test_run_id: 'real-mu75auzr' });
  ck('16 用真实任务 ID 尝试清理 → 400 拒绝', realTry.status === 400, `http=${realTry.status}`);
  const histTry = await post(CLEAN, { test_run_id: HIST_TASK });
  ck('17 用历史补录 ID 尝试清理 → 400 拒绝', histTry.status === 400, `http=${histTry.status}`);

  const afterRefuse = snapshot();
  ck('18 6 次拒绝调用未删除任何记录', afterRefuse.runs_for_this_run === 3 && afterRefuse.events_for_this_run === 6 && afterRefuse.non_test_fingerprint === before.non_test_fingerprint,
    JSON.stringify({ r: afterRefuse.runs_for_this_run, e: afterRefuse.events_for_this_run }));

  const cl = await post(CLEAN, { test_run_id: RUN });
  out.cleanup = cl.json;
  ck('19 精确清理本次 run 成功并返回删除数量', cl.status === 200 && cl.json && cl.json.ok === true && cl.json.deleted_runs === 3 && cl.json.deleted_events === 6, JSON.stringify(cl.json));

  const after = snapshot();
  out.after = after;
  ck('20 本次 run 记录已归零（列表不残留 fixture）', after.runs_for_this_run === 0 && after.events_for_this_run === 0, JSON.stringify({ r: after.runs_for_this_run, e: after.events_for_this_run }));
  ck('21 非 test 记录整表指纹逐字节未变（真实任务/历史补录未被触碰）',
    after.non_test_fingerprint === before.non_test_fingerprint && after.non_test_runs === before.non_test_runs && after.non_test_events === before.non_test_events,
    `fp ${String(before.non_test_fingerprint).slice(0, 12)} -> ${String(after.non_test_fingerprint).slice(0, 12)}`);
  ck('22 历史补录记录前后逐字段相同', JSON.stringify(after.hist_row) === JSON.stringify(before.hist_row), `${JSON.stringify(before.hist_row)} -> ${JSON.stringify(after.hist_row)}`);

  out.counts = {
    runs_total_before: before.runs_total, runs_total_after: after.runs_total,
    events_total_before: before.events_total, events_total_after: after.events_total,
    created_runs: 3, created_events: 6,
    cleaned_runs: (cl.json && cl.json.deleted_runs) || 0, cleaned_events: (cl.json && cl.json.deleted_events) || 0,
    residual_this_run_runs: after.runs_for_this_run, residual_this_run_events: after.events_for_this_run,
    non_test_runs_unchanged: after.non_test_runs === before.non_test_runs,
    non_test_events_unchanged: after.non_test_events === before.non_test_events,
  };
  out.ok = out.checks.every((c) => c.ok);
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
})().catch((e) => { console.log(JSON.stringify({ ok: false, fatal: String(e && e.message).slice(0, 200), checks: out.checks }, null, 2)); process.exit(9); });
