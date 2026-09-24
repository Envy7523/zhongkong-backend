'use strict';
/**
 * sync_job_audit 自检（本地隔离副本；不接触线上数据库、不访问美团、不导出/导入）
 *
 * 做法：把 lib/ 复制到仓库内的临时目录，使其 DB_PATH 指向新的 data/database.sqlite，
 *       再调用**项目正式的 init() 建表路径**，从而同时验证：
 *         (a) 新增的 sync_job_runs / sync_job_events 迁移可被正式机制创建；
 *         (b) 审计模块的校验、幂等、脱敏、状态推导与读取接口。
 *
 * 运行：node scripts/test-sync-job-audit.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const results = [];
const ck = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

const WORK = fs.mkdtempSync(path.join(ROOT, '_tmp-syncjob-'));
const LIB = 'lib';

function stage() {
  fs.cpSync(path.join(ROOT, LIB), path.join(WORK, LIB), { recursive: true });
  return {
    db: require(path.join(WORK, LIB, 'db.js')),
    audit: require(path.join(WORK, LIB, 'sync-job-audit.js')),
  };
}

const SECRET = 'test-secret-0123456789abcdef';

(async () => {
  const { db, audit } = stage();
  try {
    await db.init();
    ck('1 init() 正式建表路径执行成功', true, '');

    // ---- 迁移：新表与其约束 ----
    const tables = db.queryAll("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
    ck('2a sync_job_runs 已由 init() 创建', tables.includes('sync_job_runs'), tables.filter((t) => t.startsWith('sync_')).join(','));
    ck('2b sync_job_events 已由 init() 创建', tables.includes('sync_job_events'), '');
    const runCols = db.queryAll('PRAGMA table_info(sync_job_runs)').map((c) => c.name);
    const evCols = db.queryAll('PRAGMA table_info(sync_job_events)').map((c) => c.name);
    for (const col of ['run_key', 'task_id', 'platform', 'report_type', 'business_date', 'status', 'sha256_prefix', 'import_batch_id', 'raw_store_count', 'matched_store_count', 'ready_to_push', 'is_backfill', 'reconstructed', 'not_a_realtime_success']) {
      ck(`2c runs 含列 ${col}`, runCols.includes(col), '');
    }
    for (const col of ['event_id', 'run_id', 'stage', 'at', 'seq', 'detail_json']) {
      ck(`2d events 含列 ${col}`, evCols.includes(col), '');
    }
    const evIdx = db.queryAll('PRAGMA index_list(sync_job_events)');
    const uniq = evIdx.filter((i) => Number(i.unique) === 1);
    ck('2e event_id 唯一约束存在（幂等基础）', uniq.length >= 1, JSON.stringify(evIdx.map((i) => `${i.name}:${i.unique}`)));
    const bizCols = db.queryAll('PRAGMA table_info(business_revenue_records)').map((c) => c.name);
    ck('2f 未改动业务表 business_revenue_records 结构', !bizCols.includes('sync_status') && bizCols.includes('channel'), `cols=${bizCols.length}`);

    // ---- 纯函数：状态推导覆盖 13 个阶段 ----
    const expectStatus = {
      PRECHECK: 'running', QUERY_DONE: 'running', EXPORT_SUBMITTED: 'running', WAITING_EXPORT: 'running',
      DOWNLOADED: 'running', FILE_VALIDATED: 'running', IMPORT_STARTED: 'running',
      IMPORT_SUCCEEDED: 'success', PUSH_SUCCEEDED: 'success',
      IMPORT_FAILED: 'failed', PUSH_FAILED: 'failed', FAILED: 'failed', WAITING_HUMAN: 'waiting_human',
    };
    const stageBad = Object.entries(expectStatus).filter(([s, want]) => audit.deriveStatus(s) !== want);
    ck('3a 13 个阶段的状态推导全部正确', stageBad.length === 0 && Object.keys(expectStatus).length === 13, JSON.stringify(stageBad));

    // ---- HMAC ----
    const ts = String(Date.now());
    const body = JSON.stringify({ events: [] });
    const good = audit.signPayload({ secret: SECRET, timestamp: ts, rawBody: body });
    ck('4a 正确签名通过', audit.verifySignature({ secret: SECRET, timestamp: ts, signature: good, rawBody: body }).ok === true, '');
    ck('4b 错误签名被拒', audit.verifySignature({ secret: SECRET, timestamp: ts, signature: good.replace(/.$/, '0'), rawBody: body }).ok === false, '');
    ck('4c 篡改 body 后签名失效', audit.verifySignature({ secret: SECRET, timestamp: ts, signature: good, rawBody: body + ' ' }).ok === false, '');
    ck('4d 未配置密钥时拒绝', audit.verifySignature({ secret: '', timestamp: ts, signature: good, rawBody: body }).ok === false, '');
    ck('4e 过期时间戳被拒', audit.timestampAcceptable(String(Date.now() - 10 * 60 * 1000)).ok === false, '');
    ck('4f 新鲜时间戳通过', audit.timestampAcceptable(ts).ok === true, '');

    // ---- 事件校验：白名单/脱敏/report_type ----
    const base = (over = {}) => Object.assign({
      event_id: `evt-${crypto.randomUUID()}`, task_id: 'real-test0001', report_type: 'cashier_composite',
      business_date: '2026-09-19', platform: 'meituan', stage: 'QUERY_DONE', at: new Date().toISOString(), seq: 2,
    }, over);
    ck('5a 合法事件通过校验', audit.validateEvent(base()).ok === true, '');
    ck('5b 报表B(item_sales_detail) 被拒', audit.validateEvent(base({ report_type: 'item_sales_detail' })).ok === false, '');
    ck('5c 未授权 report_type 被拒', audit.validateEvent(base({ report_type: 'unknown_rep' })).ok === false, '');
    ck('5d 非法阶段被拒', audit.validateEvent(base({ stage: 'SOMETHING_ELSE' })).ok === false, '');
    ck('5e 未知顶层字段被拒', audit.validateEvent(base({ extra_field: 1 })).ok === false, '');
    ck('5f 含 password 字段被拒', audit.validateEvent(base({ metrics: { password: 'x' } })).ok === false, '');
    ck('5g 含 token 字段被拒', audit.validateEvent(base({ detail: { token: 'x' } })).ok === false, '');
    // 要求「接口只接受脱敏字段」：携带绝对服务器路径的事件必须整体拒绝（不是静默改写）
    const withPath = audit.validateEvent(base({ metrics: { original_filename: '/home/ubuntu/app/data/secret/鹅太公.xlsx' } }));
    ck('5h 携带绝对路径的事件被拒（只接受脱敏字段）', withPath.ok === false && JSON.stringify(withPath.reasons).includes('absolute_path'), JSON.stringify(withPath.reasons));
    const pathInReason = audit.validateEvent(base({ metrics: { failure_reason: '读取 /opt/zhongkong-sync-bot/x 失败' } }));
    ck('5j failure_reason 含绝对路径同样被拒', pathInReason.ok === false, JSON.stringify(pathInReason.reasons));
    const withBase = audit.validateEvent(base({ metrics: { original_filename: '鹅太公_综合营业统计.xlsx' } }));
    ck('5h2 仅文件名（已脱敏）被接受', withBase.ok === true && withBase.clean.metrics.original_filename === '鹅太公_综合营业统计.xlsx', JSON.stringify(withBase.clean && withBase.clean.metrics));
    const withSha = audit.validateEvent(base({ metrics: { sha256: 'abcdef0123456789abcdef0123456789' } }));
    ck('5i sha256 只保留 12 位前缀', withSha.ok === true && withSha.clean.metrics.sha256_prefix === 'abcdef012345', JSON.stringify(withSha.clean && withSha.clean.metrics));

    // ---- 入库：成功 / 失败 / 历史补录 ----
    const now = new Date().toISOString();
    const batch1 = [
      base({ event_id: 'run-ok-1', task_id: 'real-ok0001', stage: 'PRECHECK', seq: 1, at: now, metrics: { started_at: now } }),
      base({ event_id: 'run-ok-2', task_id: 'real-ok0001', stage: 'FILE_VALIDATED', seq: 2, at: now, metrics: { original_filename: '鹅太公_综合营业统计.xlsx', file_size: 24952, sha256: 'deadbeefcafe12345678', screenshot_count: 3, validation: { ok: true, store_rows: 22 }, ready_to_push: true } }),
      base({ event_id: 'run-ok-3', task_id: 'real-ok0001', stage: 'IMPORT_SUCCEEDED', seq: 3, at: now, metrics: { import_batch_id: 140, raw_store_count: 22, matched_store_count: 22, imported: 1, finished_at: now, duration_ms: 12345 } }),
    ];
    const r1 = audit.ingestEvents(db, batch1);
    ck('6a 成功链路事件全部接收', r1.accepted.length === 3 && r1.rejected.length === 0, JSON.stringify(r1));

    const batch2 = [
      base({ event_id: 'run-fail-1', task_id: 'real-fail001', stage: 'PRECHECK', seq: 1, at: now }),
      base({ event_id: 'run-fail-2', task_id: 'real-fail001', stage: 'FAILED', seq: 2, at: now, metrics: { failure_reason: '查询声明总数 20 ≠ 22', finished_at: now } }),
    ];
    const r2 = audit.ingestEvents(db, batch2);
    ck('6b 失败链路事件接收', r2.accepted.length === 2 && r2.rejected.length === 0, JSON.stringify(r2));

    const batch3 = [
      base({ event_id: 'run-bf-1', task_id: 'backfill-20260917', business_date: '2026-09-17', stage: 'FILE_VALIDATED', seq: 1, at: now, metrics: { original_filename: '鹅太公_综合营业统计_20260919_0003.xlsx', file_size: 24952, sha256: '4bf6ac763b23e84a3c2b971fda97e340', is_backfill: 1, reconstructed: 1, not_a_realtime_success: 1, ready_to_push: 0, validation: { ok: true, store_rows: 22 } } }),
    ];
    const r3 = audit.ingestEvents(db, batch3);
    ck('6c 历史补录事件接收', r3.accepted.length === 1 && r3.rejected.length === 0, JSON.stringify(r3));

    // ---- 幂等 ----
    const before = db.queryOne('SELECT COUNT(*) AS n FROM sync_job_events').n;
    const again = audit.ingestEvents(db, batch1);
    const after = db.queryOne('SELECT COUNT(*) AS n FROM sync_job_events').n;
    ck('7a 重复 event_id 不产生重复行', again.accepted.length === 0 && again.duplicates.length === 3, JSON.stringify(again));
    ck('7b 事件表行数未变化', before === after, `before=${before} after=${after}`);
    const runsCount = db.queryOne('SELECT COUNT(*) AS n FROM sync_job_runs').n;
    ck('7c 运行表未因重复上报新增', runsCount === 3, `runs=${runsCount}`);

    // ---- 读取：筛选/详情/概览 ----
    const okRun = db.queryOne("SELECT * FROM sync_job_runs WHERE task_id='real-ok0001'");
    ck('8a 成功运行汇总字段正确', okRun.status === 'success' && okRun.import_batch_id === 140 && okRun.matched_store_count === 22 && okRun.ready_to_push === 1 && okRun.imported === 1, JSON.stringify({ s: okRun.status, b: okRun.import_batch_id, m: okRun.matched_store_count, r: okRun.ready_to_push }));
    ck('8b 文件名已脱敏为 basename', okRun.original_filename === '鹅太公_综合营业统计.xlsx', okRun.original_filename);
    ck('8c sha256 前缀已截断', okRun.sha256_prefix === 'deadbeefcafe', okRun.sha256_prefix);
    const failRun = db.queryOne("SELECT * FROM sync_job_runs WHERE task_id='real-fail001'");
    ck('8d 失败运行状态与原因', failRun.status === 'failed' && /20 ≠ 22/.test(failRun.failure_reason), `${failRun.status} | ${failRun.failure_reason}`);
    const bfRun = db.queryOne("SELECT * FROM sync_job_runs WHERE task_id='backfill-20260917'");
    ck('8e 历史补录三标记齐全', bfRun.is_backfill === 1 && bfRun.reconstructed === 1 && bfRun.not_a_realtime_success === 1 && bfRun.ready_to_push === 0, JSON.stringify({ b: bfRun.is_backfill, r: bfRun.reconstructed, n: bfRun.not_a_realtime_success, p: bfRun.ready_to_push }));

    const list = audit.listRuns(db, {});
    ck('9a 列表返回 3 条', list.total === 3 && list.runs.length === 3, `total=${list.total}`);
    ck('9b 按状态筛选可行', audit.listRuns(db, { status: 'failed' }).total === 1, '');
    ck('9c 按补录筛选可行', audit.listRuns(db, { is_backfill: '1' }).total === 1, '');
    ck('9d 按已导入筛选可行', audit.listRuns(db, { imported: '1' }).total === 1, '');
    const ov = audit.overview(db);
    ck('9e 概览含最近一次与待处理异常数', !!ov.latest && typeof ov.pending_exceptions === 'number', JSON.stringify({ latest: ov.latest && ov.latest.task_id, pending: ov.pending_exceptions, today: ov.today_counts }));
    const detail = audit.getRun(db, okRun.id);
    ck('9f 详情含 3 个阶段且按 seq 排序', detail.events.length === 3 && detail.events.map((e) => e.stage).join('>') === 'PRECHECK>FILE_VALIDATED>IMPORT_SUCCEEDED', detail.events.map((e) => e.stage).join('>'));

    // ---- 输出脱敏：整份响应里不得出现敏感值/绝对路径 ----
    const dump = JSON.stringify({ list, ov, detail });
    const leakPatterns = [
      [/\/opt\//, '绝对路径 /opt/'], [/\/home\//, '绝对路径 /home/'],
      [/qyapi\.weixin\.qq\.com/, 'Webhook'], [/eyJ[A-Za-z0-9_-]{10,}/, 'JWT'],
      [/"password"/, 'password'], [/"token"/, 'token'], [/"cookie"/i, 'cookie'],
    ];
    const leaks = leakPatterns.filter(([re]) => re.test(dump)).map(([, label]) => label);
    ck('10 读取接口输出不含敏感字段与绝对路径', leaks.length === 0, leaks.join(','));
  } catch (e) {
    ck('FATAL', false, `${e.message}\n${e.stack}`);
  } finally {
    try { db.close(); } catch (_) {}
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (_) {}
  }
  const ok = results.every((r) => r.ok);
  console.log(JSON.stringify({ ok, total: results.length, failed: results.filter((r) => !r.ok).length, results }, null, 2));
  process.exit(ok ? 0 : 1);
})();
