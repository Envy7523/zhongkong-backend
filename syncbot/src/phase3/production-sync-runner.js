'use strict';
/**
 * 生产 **data-only 同步接线**（本文件是唯一新增的生产装配点）
 *
 * 契约：`_syncbot/schedule/CONTRACT-v2-上线冻结.md` §2.1
 *   · 只做报表 A（cashier_composite）「导出 → 归档 → 校验 → 导入项目数据库」；
 *   · **不发送企业微信、不持有任何推送凭据**：本模块不 require 任何推送模块，
 *     不读凭据文件，不产生 push 调用（push_calls 恒为 0）；
 *   · 报表 B（item_sales_detail）在**任何入口**一律拒绝（report_b_locked，零副作用）；
 *   · 缺依赖 / 未显式启用 ⇒ fail-closed，且**零副作用**（不建状态文件、不落锁、不发任何业务 HTTP）；
 *   · 本模块**不创建任何定时器/计划任务**（无 setInterval / cron / systemd 交互）。唯一一处
 *     延时是下载文件到达的轮询等待（waitForDownloadFile，与既有 phase2/real-download-run.js 同款），
 *     它不是调度器，且离线套件证明离线运行期间创建的定时器数量为 0。
 *
 * 结构：
 *   createRunner({reportType, platform, deps, env, logger})
 *     → { report_type:'cashier_composite', data_only:true, source, runOnce }
 *   runOnce({businessDate, workerId, idempotencyKey})
 *     ①报表B/报表类型守卫 → ②显式启用守卫 → ③adapter 工厂齐备守卫 → ④下载依赖守卫
 *     → ⑤G1 只读覆盖探测（命中 ⇒ WAITING_HUMAN，零下载） → ⑥委托
 *        schedule/worker.js::createWorkflowRunSyncRunner({deps:{adapterFactories,gates}})
 *        （即 workflow-run.js 的 data-only 全链路：G1 → download → G3 → import → COMPLETED）
 *
 * 覆盖闸门（契约 §2.2，**只读**）：
 *   GET /api/internal/syncbot/coverage?business_date=YYYY-MM-DD
 *   复用 schedule/zk-client.js 的 HMAC 客户端与 0600 密钥文件（只允许 http://127.0.0.1:3456；
 *   仅离线测试可显式打开 allowTestBase 换端口 mock）。
 *   · 阶段 1 中 G1 命中（covered=true）唯一结果是
 *     coverage_integrity_unverified → WAITING_HUMAN：零下载、零导入、零推送。
 *     原因是没有可靠的 batch_id × 归档摘要关联；不得以环境变量或其它
 *     运行时开关绕过该规则。与 provenance 有关的后续改造须经单独批准。
 *   · G3 命中 ⇒ 保守拒绝（g3_coverage_gate_hit），**不重复导入**，转人工。
 *   · 覆盖查询失败/异常 ⇒ fail-closed（g1_coverage_gate_failed），零业务副作用。
 */
const fs = require('fs');
const path = require('path');
const TC = require('../task-context');
const PLAN = require('../schedule/plan.js');
const WK = require('../schedule/worker.js');
const ZK = require('../schedule/zk-client.js');
const P = require('../paths');

const REPORT_TYPE = 'cashier_composite';
const PLATFORM = 'meituan';
/** 显式启用开关（与 workflow-production-adapters 同一开关，未置位 ⇒ fail-closed） */
const ENV_ENABLE_KEY = 'SYNCBOT_WORKFLOW_PROD_ADAPTERS';
/** 中控只读覆盖接口（契约 §2.2）：G1/G3 闸门 + active_stores 五态（唯一权威在营清单来源） */
const COVERAGE_PATH = '/api/internal/syncbot/coverage';
/** 阶段 1 唯一的 G1 命中断言：既有数据**不可核验** ⇒ 保守转人工（零下载零导入零推送） */
const INTEGRITY_UNVERIFIED = 'coverage_integrity_unverified';
/** download 适配器必需的真实依赖（缺一 ⇒ fail-closed） */
const DOWNLOAD_DEP_KEYS = ['client', 'flow', 'approvals', 'rules', 'selectors'];
/** data-only：只允许这两段适配器 */
const ADAPTER_KEYS = ['download', 'import'];
const SOURCE = 'app/src/phase3/production-sync-runner.js（唯一生产装配点）→ schedule/worker.js::createWorkflowRunSyncRunner + phase3/workflow-production-adapters.js（download/import，data-only）';
const ABS_PATH_RE = /(^|[\s"'(=])(\/(?:home|opt|etc|var|root|tmp|usr)\/[^\s"')]*)|([A-Za-z]:\\[^\s"')]*)/g;
const REASON_RE = /^[A-Za-z][A-Za-z0-9_.:=-]{0,79}$/;
/** 绝不允许注入的推送/发送类依赖（构造期即拒绝；本入口根本没有发送通道的概念） */
const FORBIDDEN_DEP_RE = /(?:^|_)(?:push|sender|notify|notifier|hook|mailer|smtp)(?:$|_)/i;

/** 统一的 fail-closed 返回（零副作用：无状态文件、无锁、无业务 HTTP） */
function refused(reason, extra) {
  return Object.assign({
    ok: false, action: 'REFUSED', reason: String(reason), side_effects: false,
    push_calls: 0, stage_calls: { download: 0, import: 0 }, report_type: REPORT_TYPE,
  }, extra || {});
}

/**
 * **需要人工**的 fail-closed 返回（契约 §G 语义校正）：
 * G1 命中后**无法严格证明**归属（provenance 不可证 / 核验不通过）时，绝不能"顺手跑一次完整同步"
 * （同日先删后插有覆盖风险），必须转人工：零下载、零导入、零推送，**终态 WAITING_HUMAN**（不是 refused、不是 success）。
 * side_effects 仍如实为 false（确实什么都没做）；由显式 requires_human 让调度 worker 落 waiting_human 且**绝不自动重做**。
 */
function humanRequired(reason, extra) {
  return Object.assign({
    ok: false, action: 'WAITING_HUMAN', reason: String(reason), side_effects: false,
    requires_human: true, auto_retry: false,
    push_calls: 0, stage_calls: { download: 0, import: 0 }, report_type: REPORT_TYPE,
  }, extra || {});
}

/**
 * 业务日期 → 日期级运行锁名。**委托** workflow-run 的唯一定义（single source of truth），
 * 绝不在此另写一份锁名规则 ⇒ 手工 CLI 与未来调度包装层天然共用同一把锁。
 */
function lockNameOf(businessDate) {
  try { return require('./workflow-run.js').lockNameFor(businessDate); } catch (e) { return null; }
}

/** 与 workflow 一致的 task_id 前缀（worker 的内置 runner 恒用 'sched'） */
const TASK_ID_PREFIX = 'sched';

function sha16OfFile(file) {
  try { return require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16); } catch (e) { return null; }
}
function digest12OfText(text) {
  try { return require('crypto').createHash('sha256').update(String(text)).digest('hex').slice(0, 12); } catch (e) { return null; }
}

/**
 * 入口自证（离线/审计用）：任选一个入口调用，得到的身份与关键规则串必须**逐字节相同**。
 * 用于证明「手工 CLI / 未来调度包装层」共享**同一个工厂·同一个模块版本·同一个 runOnce 实现**，
 * 以及锁名 / 状态文件键 / task_id 规则 / event_id 规则四项完全一致。
 * 注意：本函数的输出含模块绝对路径 ⇒ 仅用于离线证据，不进入正式运行计划输出。
 */
function identityFor(businessDate, opts = {}) {
  const bd = String(businessDate);
  const WF = require('./workflow-run.js');
  const OUTBOX = require('./audit-outbox.js');
  const selfPath = require.resolve('./production-sync-runner.js');
  const r = createRunner({});
  const stateFile = P.taskStateFile(PLATFORM, REPORT_TYPE, bd);
  const rootPrefix = path.resolve(P.root) + path.sep;
  const resolved = path.resolve(stateFile);
  const rel = resolved.indexOf(rootPrefix) === 0 ? resolved.slice(rootPrefix.length).split(path.sep).join('/') : null;
  const taskId = WF.taskIdFor({ prefix: TASK_ID_PREFIX, platform: PLATFORM, reportType: REPORT_TYPE, businessDate: bd });
  return {
    entry: String((opts && opts.entry) || 'unknown'),
    business_date: bd,
    runner_module_path: selfPath,
    runner_module_sha16: sha16OfFile(selfPath),
    runner_source: r.source,
    run_once_digest12: digest12OfText(r.runOnce.toString()),
    lock_name: lockNameOf(bd),
    state_file_key: rel,
    task_id: taskId,
    event_id_rule_sample: OUTBOX.stableEventId({ taskId: taskId, reportType: REPORT_TYPE, businessDate: bd, stage: 'IMPORT_SUCCEEDED', seq: 1 }),
  };
}

/**
 * 人工/调度触发来源写入**既有**运行记录（state/tasks/<platform>/<report_type>/<date>.json 的 workflow 段）。
 * 不新增任何状态文件/锁；只在**真正进入数据路径**（委托 workflow 之前）记录一次。
 */
function recordTrigger({ platform = PLATFORM, reportType = REPORT_TYPE, businessDate, trigger, workerId }) {
  if (!trigger) return false;
  try {
    const ST = require('../state.js');
    ST.patch(platform, businessDate, 'workflow', {
      trigger: String(trigger).slice(0, 40),
      trigger_at: new Date().toISOString(),
      trigger_worker: workerId ? String(workerId).slice(0, 80) : null,
    }, { reportType: reportType });
    return true;
  } catch (e) { return false; }
}

/** 脱敏（只用于输出/日志；绝不外泄绝对路径与凭据） */
function scrub(value, max) {
  const s = String(value === undefined || value === null ? '' : value).replace(ABS_PATH_RE, '$1[path]');
  return s.slice(0, max || 120);
}
function safeReason(value) {
  const s = scrub(value, 80);
  return REASON_RE.test(s) ? s : 'unrecognized_reason';
}

/** data-only 守卫：拒绝任何推送/发送/通知类依赖注入（本入口根本没有这种概念） */
function assertNoForbiddenDeps(deps) {
  const bad = Object.keys(deps || {}).filter((k) => FORBIDDEN_DEP_RE.test(String(k)));
  if (bad.length) throw new Error('data-only：禁止注入推送/发送/通知依赖（' + bad.join(',') + '）');
}

// ------------------------------------------------------------------ 只读覆盖探测（G1/G3）
/** 解析覆盖客户端：优先注入；否则复用 zk-client（HMAC + 0600 密钥文件 + 只允许回环） */
function resolveCoverageClient({ deps = {}, env = process.env } = {}) {
  const injected = deps.coverageClient || deps.coverage;
  if (injected && typeof injected.coverage === 'function') return { ok: true, client: injected, source: 'injected' };
  let client = null;
  try {
    client = ZK.createZkClient({
      base: deps.coverageBase || deps.zkBase || deps.base,
      secretFile: deps.secretFile,
      timeoutMs: deps.coverageTimeoutMs || deps.timeoutMs,
      allowTestBase: deps.allowTestBase === true || deps.testBase === true,
      env,
    });
  } catch (e) {
    return { ok: false, reason: 'coverage_client_failed' };
  }
  if (client.base_ok !== true) return { ok: false, reason: safeReason(client.base_reason || 'base_not_allowed') };
  if (typeof client.coverage !== 'function') return { ok: false, reason: 'coverage_not_supported' };
  return { ok: true, client, source: 'zk-client' };
}

/**
 * 中控覆盖应答 → 内部判定。
 *
 * `has_records` 是中控 coverage 契约中唯一的“该业务日期已有数据”事实；
 * `safe_to_skip_sync=false` / `report_eligible=false` 是阶段 1 的静态安全属性，
 * 不能被误读成“已有数据”。因此只有 has_records=true 时，才把不可核验信号
 * 提升为 G1 命中；字段缺失、类型错误或与兼容字段 covered 冲突一律 fail-closed。
 */
function normalizeCoverage(res, businessDate) {
  const bd = String(businessDate);
  if (!res || res.ok !== true) {
    const why = res && res.unknown === true ? 'unknown' : safeReason((res && res.reason) || 'failed');
    return { ok: false, covered: false, reason: 'coverage_query_failed:' + why, business_date: bd };
  }
  const b = res.body || {};
  if (String(b.business_date || '') !== bd) return { ok: false, covered: false, reason: 'coverage_business_date_mismatch', business_date: bd };
  const ev = b.evidence && typeof b.evidence === 'object' ? b.evidence : {};
  const evidence = {
    revenue_records: Number(ev.revenue_records) || 0,
    product_sales: Number(ev.product_sales) || 0,
    batches: Number(ev.batches) || 0,
  };
  if (typeof b.has_records !== 'boolean') {
    return { ok: false, covered: false, reason: 'coverage_response_invalid', business_date: bd };
  }
  // A legacy covered field is accepted only as a consistency check; it is never
  // the source of truth because the deployed middle-control provider omits it.
  if (b.covered !== undefined && (typeof b.covered !== 'boolean' || b.covered !== b.has_records)) {
    return { ok: false, covered: false, reason: 'coverage_response_inconsistent', business_date: bd };
  }
  if (b.has_records === false) {
    return { ok: true, covered: false, reason: 'not_covered', evidence: evidence, business_date: bd };
  }
  // Here has_records=true: a G1 hit is never a successful prior sync in Phase 1.
  if (b.provenance !== undefined && b.provenance !== null && String(b.provenance).trim().toLowerCase() === 'unverifiable') {
    return { ok: false, covered: true, reason: 'coverage_provenance_unverifiable', evidence: evidence, business_date: bd };
  }
  if (b.safe_to_skip_sync === false) return { ok: false, covered: true, reason: 'coverage_not_safe_to_skip', evidence: evidence, business_date: bd };
  if (b.report_eligible === false) return { ok: false, covered: true, reason: 'coverage_not_report_eligible', evidence: evidence, business_date: bd };
  return { ok: true, covered: true, reason: 'coverage_hit', evidence: evidence, business_date: bd };
}

/**
 * 中控覆盖应答 → **在营门店清单**（口径冻结 §4，唯一权威来源）。
 * 只认 `body.active_stores:[{id,name}]`；字段缺失/为空/查询失败 ⇒ **fail-closed**（返回 ok:false）。
 * 本函数**不直连项目库**、不做任何在营状态推断。
 */
function normalizeActiveStores(res, businessDate) {
  const bd = String(businessDate);
  if (!res || res.ok !== true) {
    const why = res && res.unknown === true ? 'unknown' : safeReason((res && res.reason) || 'failed');
    return { ok: false, active_stores: null, reason: 'active_stores_query_failed:' + why, business_date: bd };
  }
  const b = res.body || {};
  if (b.business_date !== undefined && b.business_date !== null && String(b.business_date) !== bd) {
    return { ok: false, active_stores: null, reason: 'active_stores_business_date_mismatch', business_date: bd };
  }
  const arr = Array.isArray(b.active_stores) ? b.active_stores : null;
  if (!arr) return { ok: false, active_stores: null, reason: 'active_stores_missing', business_date: bd };
  const seen = new Set();
  const list = [];
  for (const s of arr) {
    const id = Number(s && (s.id !== undefined ? s.id : s.store_id));
    const name = String((s && (s.name || s.store_name)) || '').trim();
    if (!Number.isFinite(id) || !name || seen.has(id)) continue;
    seen.add(id);
    list.push({ id: id, name: name });
  }
  if (!list.length) return { ok: false, active_stores: null, reason: 'active_stores_empty', business_date: bd };
  list.sort((a, b2) => a.id - b2.id);
  return { ok: true, active_stores: list, reason: 'active_stores_ok', business_date: bd };
}

/**
 * 中控覆盖应答 → **原样覆盖快照**（在营清单可信度判定**不在本层做**）。
 * 单点裁决：app/src/phase2/store-mapping-coverage.assessActiveStores ——
 *   ok!==true / active_stores===null / truncated===true / active_stores_basis 缺失或为空
 *   ⇒ 不可信 ⇒ 文件校验失败 ⇒ WAITING_HUMAN（零导入、零推送）。
 * 本层只传递字段 + 业务日期一致性，**绝不**把 null / 空数组 / 截断清单“美化”成可用清单。
 */
function coverageSnapshotFrom(res, businessDate) {
  const bd = String(businessDate);
  const transportOk = !!(res && res.ok === true);
  const b = (transportOk && res.body && typeof res.body === 'object') ? res.body : {};
  if (transportOk && b.business_date !== undefined && b.business_date !== null && String(b.business_date) !== bd) {
    return { ok: false, business_date: bd, active_stores: null, truncated: true, active_stores_basis: null, active_stores_basis_confirmed: false, reason: 'active_stores_business_date_mismatch' };
  }
  return {
    ok: transportOk,
    business_date: bd,
    active_stores: b.active_stores === undefined ? null : b.active_stores,
    truncated: b.truncated === true,
    active_stores_basis: (b.active_stores_basis === undefined || b.active_stores_basis === null) ? null : String(b.active_stores_basis),
    active_stores_basis_confirmed: b.active_stores_basis_confirmed === true,
    reason: transportOk ? null : ('active_stores_query_failed:' + (res && res.unknown === true ? 'unknown' : safeReason((res && res.reason) || 'failed'))),
  };
}

/** 在营门店清单 provider（同一业务日期默认只查一次；返回**覆盖快照**，不美化、不猜测） */
function createActiveStoresProvider({ client }) {
  const cache = new Map();
  async function query(businessDate, opts = {}) {
    const bd = String(businessDate);
    if (opts.fresh !== true && cache.has(bd)) return cache.get(bd);
    let res = null;
    try { res = await client.coverage({ business_date: bd }); }
    catch (e) { res = { ok: false, reason: 'active_stores_query_threw', unknown: true }; }
    const cov = coverageSnapshotFrom(res, bd);
    const out = { ok: cov.ok === true, coverage: cov, reason: cov.reason, business_date: bd };
    cache.set(bd, out);
    return out;
  }
  return { query: query, size: () => cache.size };
}

/** 覆盖探测（同一业务日期默认只查一次；fresh=true 强制重查 —— G3 紧邻导入，必须看最新） */
function createCoverageProbe({ client }) {
  const cache = new Map();
  async function query(businessDate, opts = {}) {
    const bd = String(businessDate);
    if (opts.fresh !== true && cache.has(bd)) return cache.get(bd);
    let res = null;
    try { res = await client.coverage({ business_date: bd }); }
    catch (e) { res = { ok: false, reason: 'coverage_query_threw', unknown: true }; }
    const out = normalizeCoverage(res, bd);
    cache.set(bd, out);
    return out;
  }
  return { query, size: () => cache.size };
}

/** 门店映射台账（只读 config/store-mapping.json；可注入 deps.storeMapping 供离线套件使用） */
function resolveStoreMapping(deps = {}) {
  if (deps.storeMapping && typeof deps.storeMapping === 'object') return { ok: true, json: deps.storeMapping, source: 'injected' };
  try {
    const file = path.join(P.config, 'store-mapping.json');
    if (!fs.existsSync(file)) return { ok: false, reason: 'store_mapping_ledger_unavailable' };
    return { ok: true, json: JSON.parse(fs.readFileSync(file, 'utf8')), source: 'config' };
  } catch (e) { return { ok: false, reason: 'store_mapping_ledger_unreadable' }; }
}


// ------------------------------------------------------------------ 真实依赖装载
/** 绑定的 approvals 存储（任务绑定 + 40 分钟过期保护；读写 state/runtime/approvals.json） */
function createFileApprovals({ file = null, ttlMs = 40 * 60 * 1000 } = {}) {
  const target = file || path.join(P.runtime, 'approvals.json');
  let boundTask = null;
  const readRaw = () => { try { return JSON.parse(fs.readFileSync(target, 'utf8')); } catch (e) { return {}; } };
  const writeRaw = (o) => {
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch (e) {}
    fs.writeFileSync(target, JSON.stringify(o, null, 2));
  };
  return {
    file: target,
    readRaw, writeRaw,
    /** 供下载适配器在 run() 里绑定本次 task_id */
    bind(taskId) { boundTask = taskId ? String(taskId) : null; return boundTask; },
    async read() {
      const o = readRaw();
      const until = Date.parse(o.temporary_until || '');
      const fresh = Number.isFinite(until) && Date.now() < until;
      const bound = !!(boundTask && String(o.temporary_for_task || '') === boundTask);
      const anyTrue = ['export_submit', 'download_list', 'download_file'].some((k) => o[k] === true);
      if (anyTrue && !(bound && fresh)) {
        // 过期/非本任务绑定的遗留授权 ⇒ 绝不使用，并就地复位
        writeRaw(Object.assign({}, o, { export_submit: false, download_list: false, download_file: false, temporary_for_task: null, temporary_until: null, stale_reset_at: new Date().toISOString() }));
        return { export_submit: false, download_list: false, download_file: false };
      }
      return { export_submit: o.export_submit === true, download_list: o.download_list === true, download_file: o.download_file === true };
    },
    async write(next) {
      const o = readRaw();
      const merged = Object.assign({}, o, next || {});
      const on = merged.export_submit === true || merged.download_list === true || merged.download_file === true;
      if (on) {
        const owner = String((next && next.task_id) || boundTask || '');
        if (!owner) throw new Error('approvals 必须绑定 task_id 才能开启');
        merged.temporary_for_task = owner;
        merged.temporary_until = new Date(Date.now() + ttlMs).toISOString();
      } else {
        merged.export_submit = false; merged.download_list = false; merged.download_file = false;
        merged.temporary_for_task = null; merged.temporary_until = null;
      }
      writeRaw(merged);
    },
  };
}

/** 等待被动下载文件落盘（把导出后的文件从 _incoming 目录里等出来；不点击任何按钮） */
async function defaultWaitForDownloadFile({ dir, timeoutMs = 120000, pollMs = 2000, startedAt = Date.now(), excludeNames = null, stablePolls = 1 } = {}) {
  // v0.3.2：只接受"本次 export 后新产生"的**完整**文件
  //   · excludeNames：export 前目录快照中的文件名一律排除（旧文件绝不误认成本轮产物）
  //   · stablePolls≥2：同一文件大小需在连续轮询中保持不变（仍在写入的文件不算）
  //   · .crdownload 永远排除；size>0 必须
  // 不传这两个选项时行为与旧版**逐字节一致**（stablePolls 默认 1）。
  const exclude = Array.isArray(excludeNames) ? new Set(excludeNames.map(String)) : null;
  const minStable = Number(stablePolls) > 1 ? Number(stablePolls) : 1;
  const seen = new Map();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { names = []; }
    const cand = names
      .filter((n) => !/\.crdownload$/i.test(n))
      .filter((n) => !(exclude && exclude.has(String(n))))
      .filter((n) => /\.(xlsx|xls|csv)$/i.test(n))
      .map((n) => { try { return { n, st: fs.statSync(path.join(dir, n)) }; } catch (e) { return null; } })
      // 注：旧代码用 `x.st.startsWith` 过滤，而 fs.Stats 上**并不存在** startsWith ⇒ 该条件恒为假，
      // 导致"文件已落盘却永远等不到"（v0.3.2 修复：改为 isFile()）。
      .filter((x) => x && x.st.isFile() && x.st.mtimeMs >= startedAt - 3000 && x.st.size > 0)
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    // 多个新文件都满足时间/扩展名条件时，不能靠「最新 mtime」猜本次导出。
    if (cand.length > 1) return { ok: false, reason: 'ambiguous_new_download_files', candidate_count: cand.length };
    if (cand.length) {
      const top = cand[0];
      if (minStable <= 1) return { ok: true, file: path.join(dir, top.n), name: top.n, size: top.st.size, stable_polls: 1 };
      const prev = seen.get(top.n);
      const count = (prev && prev.size === top.st.size) ? prev.count + 1 : 1;
      seen.set(top.n, { size: top.st.size, count: count });
      if (count >= minStable) return { ok: true, file: path.join(dir, top.n), name: top.n, size: top.st.size, stable_polls: count };
    }
    if (Date.now() >= deadline) return { ok: false, reason: 'wait_download_file_timeout' };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * 装载 download 适配器的真实依赖。
 * @returns {{ok:true, source:string, bundle:object}|{ok:false, reason:'download_adapter_deps_missing', missing:string[]}}
 */
function resolveDownloadDeps({ deps = {}, env = process.env, reportType = REPORT_TYPE, platform = PLATFORM } = {}) {
  const injected = deps.downloadDeps || deps.download || null;
  if (injected) {
    const missing = DOWNLOAD_DEP_KEYS.filter((k) => !injected[k]);
    if (missing.length) return { ok: false, reason: 'download_adapter_deps_missing', missing: missing };
    if (!injected.approvals.read || !injected.approvals.write) return { ok: false, reason: 'download_adapter_deps_missing', missing: ['approvals.read/write'] };
    // 在营门店清单 / 映射台账：允许离线套件注入静态 fake；生产由 runner 注入 coverage 接口的 provider
    const passthrough = {
      activeStores: Array.isArray(deps.activeStores) ? deps.activeStores : null,
      activeStoresProvider: deps.activeStoresProvider || injected.activeStoresProvider || null,
      storeMapping: deps.storeMapping || injected.storeMapping || null,
      coverageRequired: deps.coverageRequired === undefined ? true : deps.coverageRequired === true,
    };
    return { ok: true, source: 'injected', bundle: Object.assign({}, injected, passthrough) };
  }
  // 生产默认：装载真实模块（构造期零 I/O、零浏览器、零 HTTP）
  const missing = [];
  let client = null; let flow = null; let selectorsMod = null; let configMod = null;
  let validateMod = null; let archiveMod = null;
  try { client = require('../phase2/client.js'); } catch (e) { missing.push('client'); }
  try { flow = require('../phase2/meituan-flow.js'); } catch (e) { missing.push('flow'); }
  try { selectorsMod = require('../phase2/selectors.js'); } catch (e) { missing.push('selectors'); }
  try { configMod = require('../config.js'); } catch (e) { missing.push('rules'); }
  try { validateMod = require('../phase2/report-a-file-validate.js'); } catch (e) { missing.push('validateFileFn'); }
  try { archiveMod = require('../archive.js'); } catch (e) { missing.push('archiveFn'); }
  if (missing.length) return { ok: false, reason: 'download_adapter_deps_missing', missing: missing };
  let rules = null;
  try { rules = configMod.load('meituan-rules'); } catch (e) { return { ok: false, reason: 'download_adapter_deps_missing', missing: ['rules'] }; }
  let selRegistry = null;
  try { selRegistry = selectorsMod.load(); } catch (e) { return { ok: false, reason: 'download_adapter_deps_missing', missing: ['selectors'] }; }
  // 签名守卫：selectors.get 必须以「已绑定注册表」的 1 参形式注入
  const boundSelectors = { get: (key) => selectorsMod.get(selRegistry, key) };
  if (boundSelectors.get.length !== 1) return { ok: false, reason: 'download_adapter_deps_missing', missing: ['selectors.get(arity)'] };
  let incomingDir = null;
  try { incomingDir = P.incoming(platform, reportType); } catch (e) { return { ok: false, reason: 'download_adapter_deps_missing', missing: ['incomingDir'] }; }
  return {
    ok: true, source: 'real-modules',
    bundle: {
      client: client, flow: flow, rules: rules, selectors: boundSelectors,
      approvals: (deps.downloadApprovalsFile || null) ? createFileApprovals({ file: deps.downloadApprovalsFile }) : createFileApprovals({}),
      validateFileFn: (f, o) => validateMod.validateReportAFile(f, o),
      archiveFn: (a) => archiveMod.archive(a),
      waitForDownloadFile: (o) => defaultWaitForDownloadFile(Object.assign({ startedAt: Date.now() - 60000 }, o || {})),
      incomingDir: incomingDir,
      expectedStoreNames: deps.expectedStoreNames || undefined,
      // 在营门店清单 / 映射台账 / 覆盖率 fail-closed 由调用方注入（默认：不注入 ⇒ 覆盖率校验失败 ⇒ WAITING_HUMAN）
      activeStores: Array.isArray(deps.activeStores) ? deps.activeStores : null,
      // 源门店名精确映射台账：**生产装配处显式加载** config/store-mapping.json
      // （不再靠"未传就跳过名单闸门"；台账缺失 ⇒ 文件校验 fail-closed ⇒ 转人工）
      storeMapping: (resolveStoreMapping(deps).json) || null,
      // 在营门店清单：生产由 runner 注入的 activeStoresProvider（中控只读接口 coverage.active_stores）提供
      activeStoresProvider: deps.activeStoresProvider || null,
      coverageRequired: deps.coverageRequired === undefined ? true : deps.coverageRequired === true,
      // 【修正】原先恒为 null ⇒ download-list-match.reselectTargetRow 在 applicant 为空时
      // 直接 fail（'缺少期望申请人（当前登录账号），拒绝猜测'），这在 09-23 的失败文案里被原样记录。
      // 与 real-download-run.js:264/442 保持一致，默认取当前美团登录账号名。
      applicant: deps.applicant || 'LongXia',
    },
  };
}

// ------------------------------------------------------------------ 适配器工厂
/** 下载结果 → 既有约定形状（workflow 只读 ok/phase/export_submitted/sha256_prefix 等；导入侧需要 file/archive/task/validation） */
function mapDownloadResult(summary, ctx) {
  const s = summary || {};
  const archived = s.archived || null;
  const validation = s.validation || null;
  const ok = s.ok === true && String(s.result || '') === 'FILE_VALIDATED';
  const sha = archived && archived.sha256 ? String(archived.sha256) : null;
  const fileName = archived && (archived.name || archived.path) ? path.basename(String(archived.name || archived.path)) : null;
  return {
    ok: ok,
    result: s.result ? String(s.result).slice(0, 40) : null,
    phase: s.phases_final ? String(s.phases_final).slice(0, 40) : null,
    export_submitted: !!s.export_submitted_at,
    export_submit_calls: Number(s.exportSubmitCalls) || 0,
    download_calls: Number(s.download_calls) || 0,
    poll_counts: Number(s.poll_counts) || 0,
    approvals_reset: s.approvals_reset === true,
    // 供导入侧使用（workflow 只落脱敏字段；原始值仅在本进程内传递给 import-run）
    file: archived && archived.path ? String(archived.path) : null,
    archived_name: fileName,
    sha256_prefix: sha && /^[0-9a-f]{8,64}$/i.test(sha) ? sha.slice(0, 12) : null,
    archive: archived ? {
      file: archived.path || null, size: archived.size === undefined ? null : archived.size, sha256: sha,
      platform: ctx.platform, report_type: ctx.reportType, business_date: ctx.businessDate,
      historical_backfill: false,
    } : null,
    task: { task_id: ctx.taskId, report_type: ctx.reportType, platform: ctx.platform, business_date: ctx.businessDate, historical_backfill: false },
    // 动态门店数证据随运行结果透传到导入侧（imported 验收的期望值来源之一）
    declared_dynamic: s.declared_dynamic != null && Number.isFinite(Number(s.declared_dynamic)) ? Number(s.declared_dynamic) : null,
    validation: validation ? {
      ok: validation.ok === true, checks: validation.checks || null, errors: validation.errors || null,
      amount_evidence: validation.amount_evidence || null,
      store_count: validation.store_count != null && Number.isFinite(Number(validation.store_count)) ? Number(validation.store_count) : null,
      declared_dynamic: validation.declared_dynamic != null && Number.isFinite(Number(validation.declared_dynamic)) ? Number(validation.declared_dynamic)
        : (s.declared_dynamic != null && Number.isFinite(Number(s.declared_dynamic)) ? Number(s.declared_dynamic) : null),
      data_row_count: validation.data_row_count != null && Number.isFinite(Number(validation.data_row_count)) ? Number(validation.data_row_count) : null,
      absent_stores: Array.isArray(validation.absent_stores) ? validation.absent_stores : null,
      absent_status: validation.absent_status || null,
    } : null,
    // 失败阶段/原因（**脱敏透传**）：优先采用下载编排层给出的具体码（如 export_dialog_confirm_stale、
    // export_dialog_confirm_not_found），没有具体码时保持既有 download_<result> 约定（向后兼容）。
    // 目的：CLI / 任务状态 / 脱敏结果不得只保留笼统的 download_failed。
    failure_stage: ok ? null : (s.failure_stage ? safeReason(s.failure_stage) : null),
    failure_reason: ok ? null : (s.failure_reason
      ? safeReason(s.failure_reason)
      : ('download_' + safeReason(s.result || (s.error ? 'error' : 'failed'))).slice(0, 100)),
    export_submitted_uncertain: ok ? false : s.export_submitted_uncertain === true,
    confirm_click_calls: Number(s.confirm_click_calls) || 0,
    confirmation_mode: s.confirmation_mode ? String(s.confirmation_mode).slice(0, 40) : null,
  };
}

/** download 任务状态存储（与 phase2/real-download-run.js 同款：状态机落 report_type 分层的任务状态文件） */
function createFlowStore({ reportType, businessDate, taskId, taskState }) {
  const TS = require('../phase2/task-state.js');
  const ts = taskState || TS.forReport(reportType);
  return {
    load: () => { const st = ts.read(businessDate); return (st.phase2 && st.phase2.real_download) || null; },
    save: (v) => { ts.patch(businessDate, { real_download: Object.assign({}, v, { task_id: taskId, report_type: reportType, business_date: businessDate }) }); },
  };
}

/** 构造真实下载适配器工厂（契约 §2.1：createProductionAdapters + createOrchestrator） */
function wrapConstructionZeroException({ archiveFn, validateFileFn, businessDate, coverage, mapping }) {
  const zeroException = require('../phase2/construction-zero-exception.js');
  const derivedEvidence = new Map();
  const inspectArchived = (original) => {
    const originalFile = original && (original.file || original.archived_path);
    if (!originalFile || !/\.xlsx$/i.test(originalFile)) return original;
    const derived = zeroException.derive({ file: originalFile, businessDate, coverage, mapping });
    if (derived.ok !== true) throw new Error('construction_zero_exception:' + derived.reason);
    if (!derived.applicable) return original;
    derivedEvidence.set(derived.file, derived.evidence);
    return Object.assign({}, original, { file: derived.file, archived_path: derived.file, size: derived.size, sha256: derived.sha256 });
  };
  const wrappedArchive = async args => inspectArchived(await archiveFn(args));
  // A previous attempt may already have archived the file before validation
  // failed. Reinspect that exact file without moving it, including the same
  // construction-row exception and all its fail-closed checks.
  wrappedArchive.recoverArchived = async ({ srcFile }) => {
    const stat = require('fs').lstatSync(srcFile);
    if (!stat.isFile() || stat.size <= 0) throw new Error('recorded_archive_invalid');
    const sha256 = require('crypto').createHash('sha256').update(require('fs').readFileSync(srcFile)).digest('hex');
    return inspectArchived({ file: srcFile, archived_path: srcFile, size: stat.size, sha256, archived: false, duplicate: true });
  };
  return {
    archiveFn: wrappedArchive,
    validateFileFn: async (file, opts) => {
      const evidence = derivedEvidence.get(file);
      if (!evidence) return validateFileFn(file, opts);
      const adjusted = zeroException.adjustDeclaredDynamic(opts && opts.declaredDynamic, evidence);
      if (!adjusted.ok) return { ok: false, errors: [adjusted.reason], checks: { declared_dynamic: { ok: false, detail: adjusted.reason } } };
      return validateFileFn(file, Object.assign({}, opts, { declaredDynamic: adjusted.value }));
    },
  };
}

function createDownloadFactory({ bundle, reportType, platform, logger }) {
  return function downloadAdapterFactory() {
    return {
      async run({ ctx, workflow, businessDate, resumeExisting }) {
        const taskId = (workflow && workflow.task_id) || (ctx && ctx.taskId) || null;
        const useCtx = (ctx && ctx.taskId) ? ctx
          : TC.createContext(reportType, { platform: platform, taskId: taskId, businessDate: businessDate });
        const RA = require('../phase2/real-download-adapters.js');
        const RD = require('../phase2/real-download.js');
        if (bundle.approvals && typeof bundle.approvals.bind === 'function') bundle.approvals.bind(useCtx.taskId);
        // 在营门店清单：**在本业务日期上显式取得**（口径冻结 §4）。取到的是**原样覆盖快照**
        // （ok/active_stores/truncated/active_stores_basis/active_stores_basis_confirmed）；
        // 可信度由 store-mapping-coverage.assessActiveStores 单点裁决：不可信 ⇒ 文件校验失败
        // ⇒ WAITING_HUMAN（零导入、零推送）。这里**不做**任何“空/null 即无在营门店”的推断。
        let activeStoresCoverage = null;
        let activeStoresReason = null;
        if (bundle.activeStoresCoverage && typeof bundle.activeStoresCoverage === 'object') {
          activeStoresCoverage = bundle.activeStoresCoverage;
        } else if (Array.isArray(bundle.activeStores)) {
          // 仅“调用方已注入静态 fake”的路径：**无 basis** ⇒ 由裁决层判为不可信（fail-closed）
          activeStoresCoverage = { ok: true, active_stores: bundle.activeStores, truncated: false, active_stores_basis: null, active_stores_basis_confirmed: false };
        } else if (bundle.activeStoresProvider && typeof bundle.activeStoresProvider.query === 'function') {
          const a = await bundle.activeStoresProvider.query(useCtx.businessDate);
          activeStoresCoverage = (a && a.coverage) ? a.coverage : { ok: false, active_stores: null, truncated: false, active_stores_basis: null, active_stores_basis_confirmed: false, reason: (a && a.reason) || 'active_stores_unavailable' };
          if (!(a && a.ok === true)) activeStoresReason = (a && a.reason) || 'active_stores_unavailable';
        } else {
          activeStoresCoverage = { ok: false, active_stores: null, truncated: false, active_stores_basis: null, active_stores_basis_confirmed: false, reason: 'active_stores_provider_missing' };
          activeStoresReason = 'active_stores_provider_missing';
        }
        if (activeStoresReason && logger && typeof logger.info === 'function') {
          try { logger.info('production_sync.active_stores', { ok: false, reason: activeStoresReason, business_date: useCtx.businessDate }); } catch (e) {}
        }
        // 经人工确认的短期筹建门店全零例外：只在原件已归档后生成可审计派生件。
        // 未命中例外时保持原路径；身份/状态/非零/日期任何一项不符即 fail-closed。
        const exceptionFns = wrapConstructionZeroException({
          archiveFn: bundle.archiveFn, validateFileFn: bundle.validateFileFn,
          businessDate: useCtx.businessDate, coverage: activeStoresCoverage, mapping: bundle.storeMapping,
        });
        const adapters = RA.createProductionAdapters({
          client: bundle.client, flow: bundle.flow, approvals: bundle.approvals, rules: bundle.rules, selectors: bundle.selectors,
          validateFileFn: exceptionFns.validateFileFn, archiveFn: exceptionFns.archiveFn, waitForDownloadFile: bundle.waitForDownloadFile,
          incomingDir: bundle.incomingDir, expectedStoreNames: bundle.expectedStoreNames,
          activeStoresCoverage: activeStoresCoverage, storeMapping: bundle.storeMapping,
          coverageRequired: bundle.coverageRequired === undefined ? true : bundle.coverageRequired === true,
          audit: typeof bundle.audit === 'function' ? bundle.audit : () => {},
        });
        const store = createFlowStore({ reportType: useCtx.reportType, businessDate: useCtx.businessDate, taskId: useCtx.taskId });
        // 生产定时入口也必须给中控发下载阶段审计；I4 日报闸门要求同一 run 有 FILE_VALIDATED。
        // 先保存业务状态，再经 outbox 异步上报，失败只记 audit_pending，绝不重导出/重导入。
        const audit = require('./real-download-audit.js').createRealDownloadAudit({
          ctx: useCtx,
          onPending: info => {
            try {
              require('../phase2/task-state.js').forReport(useCtx.reportType).patch(useCtx.businessDate, {
                real_download_audit: { audit_pending: 1, phase: info.phase, stage: info.stage, reason: info.reason, at: info.at },
              });
            } catch (_) {}
          },
        });
        store.save = audit.wrapSave(store.save);
        const orch = RD.createOrchestrator({ ctx: useCtx, store: store, adapters: adapters });
        let summary = null;
        try {
          summary = await orch.run({ applicant: bundle.applicant || undefined, resumeExisting: resumeExisting === true });
        } catch (e) {
          summary = { ok: false, result: 'FAILED', error: scrub(e && e.message, 80), phases_final: 'FAILED',
            failure_stage: 'download_orchestrator', failure_reason: 'download_exception' };
        }
        try { await audit.whenIdle({ timeoutMs: 12000 }); } catch (_) {}
        if (logger && typeof logger.info === 'function') { try { logger.info('production_sync.download', { ok: !!(summary && summary.ok), result: summary && summary.result }); } catch (e) {} }
        return mapDownloadResult(summary, useCtx);
      },
    };
  };
}

/**
 * 导入侧「七项验收」用的**真实**文件校验器（与下载侧同一套动态口径 / 同一份门店台账 / 同一份在营清单快照）。
 * 缺失（校验器或台账不可用）⇒ 返回 null ⇒ import-run 自身 fail-closed（file_validation_needs_human）。
 */
function createImportValidateFile({ deps = {}, reportType = REPORT_TYPE, platform = PLATFORM, activeStoresProvider = null } = {}) {
  let RA = null;
  try { RA = require('../phase2/report-a-file-validate.js'); } catch (e) { return null; }
  let rules = null;
  try { rules = require('../config.js').load('meituan-rules'); } catch (e) { rules = null; }
  const provider = activeStoresProvider || deps.activeStoresProvider || null;
  return async function validateFileForImport({ file, businessDate, validation } = {}) {
    // 门店台账**每次调用重新读取**（台账可能刚部署/更新；绝不在装配期固化一份可能不存在的台账）
    const sm = resolveStoreMapping(deps);
    let snap = null;
    if (provider && typeof provider.query === 'function') {
      try { const r = await provider.query(businessDate); snap = (r && r.coverage) ? r.coverage : null; } catch (e) { snap = null; }
    }
    return RA.validateReportAFile(file, {
      businessDate: businessDate,
      expectedStores: rules && rules.report ? rules.report.expected_store_count : null,
      storeMapping: sm.ok ? sm.json : null,
      activeStoresCoverage: snap,
      coverageRequired: true,
    });
  };
}

/** 构造真实导入适配器工厂（契约 §2.1：createImportRun({ctx:TC.createContext(...), opts})） */
function createImportFactory({ deps = {}, logger, reportType, platform }) {
  const importOpts = (deps.importJob && deps.importJob.opts) || {};
  const importClient = (deps.importJob && deps.importJob.client) || null;
  const importValidateFile = (deps.importJob && typeof deps.importJob.validateFile === 'function') ? deps.importJob.validateFile : null;
  // 导入侧七项验收需要的**金额证据**（amountExcel 来自归档文件解析 / amountDb 来自中控只读聚合）。
  // 缺失即由 import-run 的验收 fail-closed（amount_missing）—— 绝不臆造金额。
  const importEvidence = (deps.importJob && deps.importJob.evidence && typeof deps.importJob.evidence === 'object') ? deps.importJob.evidence : {};
  return function importAdapterFactory() {
    return {
      async runOnce({ ctx, workflow, businessDate, download, g3 }) {
        const IR = require('./import-run.js');
        const taskId = (ctx && ctx.taskId) || (workflow && workflow.task_id) || null;
        const useCtx = (ctx && ctx.taskId) ? ctx
          : TC.createContext(reportType, { platform: platform, taskId: taskId, businessDate: businessDate });
        const ir = IR.createImportRun({ ctx: useCtx, opts: importOpts, importClient: importClient, logger: logger });
        const d = download || {};
        return ir.runOnce({
          // 紧邻导入前的覆盖闸门：**复用** workflow 已完成的 G3 只读复查结论（不重复发 HTTP）；
          // G3 未通过（或未提供）⇒ 传 null ⇒ import-run 自身 fail-closed（coverage_gate_not_configured），
          // 绝不放宽成"未配置也照导"。
          // 导入侧七项验收：必须注入**真实**动态校验器（与下载侧同口径）；缺失 ⇒ import-run fail-closed。
          // 注意：import-audit 的闸门是**零参**调用（fn()），因此这里必须传已绑定本次 file/业务日期的闭包。
          validateFile: typeof importValidateFile === 'function'
            ? async () => importValidateFile({ file: d.file || d.archived_path || null, businessDate: useCtx.businessDate, validation: d.validation || null })
            : null,
          coverageGate: (g3 && g3.ok === true && g3.coverage_hit !== true)
            ? async () => ({ ok: true, coverage_hit: false, reason: 'workflow_g3_passed' })
            : null,
          file: d.file || d.archived_path || null,
          archive: d.archive || null,
          task: d.task || { task_id: useCtx.taskId, report_type: useCtx.reportType, platform: useCtx.platform, business_date: useCtx.businessDate, historical_backfill: false },
          validation: d.validation || null,
          evidence: importEvidence,
        });
      },
    };
  };
}

// ------------------------------------------------------------------ 主入口
/**
 * 生产 data-only runner 工厂。
 * @param {{reportType?:string, platform?:string, deps?:object, env?:object, logger?:object}} opts
 * @returns {{report_type:string, data_only:true, source:string, runOnce:Function}}
 */
function createRunner(opts = {}) {
  const reportType = opts.reportType || REPORT_TYPE;
  const platform = opts.platform || PLATFORM;
  const deps = opts.deps || {};
  const env = opts.env || deps.env || process.env;
  const logger = opts.logger || deps.logger || null;

  async function runOnce(args = {}) {
    const requested = String(args.reportType || args.report_type || reportType || REPORT_TYPE);
    const businessDate = String(args.businessDate || '');

    // ① 报表 B / 非授权报表：任何入口一律拒绝（零 HTTP、零工厂调用）
    if (PLAN.containsLockedReport({ report_type: requested, reportType: requested })) return refused('report_b_locked');
    if (requested !== REPORT_TYPE) return refused('report_type_not_allowed');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return refused('business_date_invalid');

    // ② 显式启用守卫（未置位 ⇒ fail-closed，零副作用）
    if (String(env[ENV_ENABLE_KEY] || '') !== '1') return refused('production_adapters_not_enabled');

    // ③ data-only 守卫：绝不允许推送/发送类依赖被注入
    try { assertNoForbiddenDeps(deps); } catch (e) { return refused('push_adapter_not_allowed'); }

    // ④ adapter 工厂齐备守卫（缺一 ⇒ 零 HTTP、零副作用）
    const overrides = deps.adapterFactories || null;
    let downloadBundle = null;
    if (overrides) {
      const missing = ADAPTER_KEYS.filter((k) => typeof overrides[k] !== 'function');
      if (missing.length) return refused('adapter_factory_missing:' + missing[0]);
    } else {
      // 真实路径：download 依赖必须齐备（client/flow/approvals/rules/selectors）
      let dl = null;
      try { dl = resolveDownloadDeps({ deps: deps, env: env, reportType: REPORT_TYPE, platform: platform }); }
      catch (e) { dl = { ok: false, reason: 'download_adapter_deps_missing', missing: ['resolve_failed'] }; }
      if (!dl || dl.ok !== true) {
        return refused('download_adapter_deps_missing', { missing: (dl && dl.missing) || [] });
      }
      downloadBundle = dl.bundle;
    }

    // ⑤ 只读覆盖客户端（只允许 127.0.0.1:3456；非法 base ⇒ fail-closed，零业务副作用）
    const covc = resolveCoverageClient({ deps: deps, env: env });
    if (!covc.ok) return refused('coverage_client_unavailable:' + safeReason(covc.reason));
    const probe = createCoverageProbe({ client: covc.client });
    // ⑤b 在营门店清单 provider（口径冻结 §4）：**唯一**权威来源 = 中控只读接口 coverage.active_stores。
    //     由 runner 在装配处显式取得并注入下载适配器，**不再依赖"未传 deps 就跳过名单闸门"**。
    const activeStoresProvider = createActiveStoresProvider({ client: covc.client });

    const adapterFactories = overrides
      ? { download: overrides.download, import: overrides.import }
      : {
        download: createDownloadFactory({
          bundle: Object.assign({}, downloadBundle, { activeStoresProvider: activeStoresProvider }),
          reportType: REPORT_TYPE, platform: platform, logger: logger,
        }),
        import: createImportFactory({
          deps: Object.assign({}, deps, {
            importJob: Object.assign({}, deps.importJob, {
              validateFile: (deps.importJob && typeof deps.importJob.validateFile === 'function')
                ? deps.importJob.validateFile
                : createImportValidateFile({ deps: deps, reportType: REPORT_TYPE, platform: platform, activeStoresProvider: activeStoresProvider }),
            }),
          }),
          logger: logger, reportType: REPORT_TYPE, platform: platform,
        }),
      };

    // ⑥ G1 只读覆盖探测（**阶段 1 架构收口 · 冻结语义**）：
    //    `covered=true` 只表示"该业务日期存在部分数据"，**不得**据此推断数据完整 / 同步成功 / 日报可发送。
    //    阶段 1 没有可靠的「batch_id × 归档摘要」关联（归档文件对照与金额/行数比对属阶段 3），
    //    因此命中时**一律不可核验** ⇒ coverage_integrity_unverified ⇒ WAITING_HUMAN（不是 refused、不是 success）。
    //    绝不"顺手跑一次完整同步"（同日先删后插有覆盖风险）；零下载、零导入、零推送。
    const g1 = await probe.query(businessDate);
    // 覆盖应答里的否决信号（provenance=unverifiable / safe_to_skip_sync=false / report_eligible=false）
    // 即便 has_records=true 也一律 unverified ⇒ 转人工，零下载零导入零推送
    if (g1.covered && !g1.ok) {
      return humanRequired(INTEGRITY_UNVERIFIED, { coverage: { g1: 'hit_unverifiable', integrity: INTEGRITY_UNVERIFIED, evidence: { cause: g1.reason } } });
    }
    if (!g1.ok) return refused('g1_coverage_gate_failed', { coverage: { g1: g1.reason } });
    if (g1.covered) return humanRequired(INTEGRITY_UNVERIFIED, {
      coverage: {
        g1: 'hit_unverifiable', g3: 'not_run', integrity: INTEGRITY_UNVERIFIED,
        evidence: {
          cause: 'batch_archive_digest_link_missing',
          g1_outcome: 'not_verifiable_in_phase1',
          // 四项核验路径在阶段 1 **不存在**（设计稿见 _syncbot/schedule/方案1-G1核验-设计稿（未部署）.md）：
          // 没有可打开的开关，也没有任何环境变量能改变本结论 —— 一律 fail-closed 转人工。
        },
      },
    });

    // ⑦ 闸门：G1 复用已探测结果（不重复查询）；G3 紧邻导入必须重查（防"期间已被导入"）
    const gates = {
      async g1({ businessDate: bd }) {
        const c = await probe.query(bd);
        if (c.covered) return { ok: false, coverage_hit: true, reason: 'g1_coverage_gate_hit' };
        if (!c.ok) return { ok: false, coverage_hit: false, reason: 'g1_coverage_gate_failed' };
        return { ok: true, coverage_hit: false, reason: 'not_covered', evidence: c.evidence || null };
      },
      async g3({ businessDate: bd }) {
        const c = await probe.query(bd, { fresh: true });
        if (c.covered) return { ok: false, coverage_hit: true, reason: 'g3_coverage_gate_hit' };
        if (!c.ok) return { ok: false, coverage_hit: false, reason: 'g3_coverage_gate_failed' };
        return { ok: true, coverage_hit: false, reason: 'not_covered', evidence: c.evidence || null };
      },
    };

    // ⑧ 委托 data-only workflow 全链路（worker 侧唯一执行入口；本模块不再做任何别的动作）。
    //    进入数据路径前，把**触发来源**（如 trigger:'manual-cli'）写入既有运行记录（不新增状态/锁）。
    const triggerRecorded = recordTrigger({
      platform: platform, reportType: REPORT_TYPE, businessDate: businessDate,
      trigger: args.trigger || null, workerId: args.workerId || null,
    });
    try {
      const inner = WK.createWorkflowRunSyncRunner({ deps: { adapterFactories: adapterFactories, gates: gates }, env: env, logger: logger });
      const res = await inner.runOnce({ businessDate: businessDate, workerId: args.workerId, idempotencyKey: args.idempotencyKey, resumeExisting: args.resumeExisting === true });
      const out = Object.assign({}, res || {});
      out.push_calls = 0;                     // data-only：推送计数恒为 0
      out.data_only = true;
      out.coverage = { g1: 'not_covered', g3: 'checked', evidence: g1.evidence || null };
      out.trigger = args.trigger || null;
      out.trigger_recorded = triggerRecorded === true;
      out.lock_name = lockNameOf(businessDate);
      out.runner_source = SOURCE;
      return out;
    } catch (e) {
      // 委托本身抛错：无法判定是否已产生副作用 ⇒ 保守（waiting_human，绝不自动重做）
      // 委托抛错：无法判定是否已产生副作用 ⇒ 保守（waiting_human，绝不自动重做）。
      // 常见且可判定的一类：同一业务日期**并发**时输给对手（日期锁被占 / 状态文件竞争）⇒ 明确原因码转人工。
      const msg = scrub((e && e.message) || e, 120);
      if (/locked|lock_busy|acquire|SyntaxError|JSON parse|EPERM|EBUSY|EEXIST|rename/i.test(msg)) {
        return humanRequired('workflow_locked_or_state_conflict', { coverage: { g1: 'not_covered', g3: 'not_covered', evidence: { cause: 'concurrent_same_date' } } });
      }
      return { ok: false, action: 'WAITING_HUMAN', reason: 'production_sync_runner_threw', cause: msg, side_effects: true, push_calls: 0, data_only: true };
    }
  }

  return { report_type: REPORT_TYPE, data_only: true, source: SOURCE, runOnce: runOnce };
}

const defaultRunner = createRunner({});

module.exports = {
  createRunner,
  // 模块级默认 runner（供 loadRunnerFromModule 直接使用；生产路径优先用 createRunner）
  report_type: REPORT_TYPE, data_only: true, source: SOURCE,
  runOnce: (args) => defaultRunner.runOnce(args),
  // 供离线套件使用的纯函数与工厂
  resolveCoverageClient, normalizeCoverage, createCoverageProbe, resolveDownloadDeps, createFlowStore, mapDownloadResult,
  // 在营门店清单（口径冻结 §4）：应答归一 + provider（离线套件直接单元测试）
  normalizeActiveStores, coverageSnapshotFrom, createActiveStoresProvider,
  // 阶段 1 **没有**"既有数据核验"分支（G1 命中一律 WAITING_HUMAN）；download 侧门店映射台账仍需要它
  resolveStoreMapping,
  createFileApprovals, createDownloadFactory, wrapConstructionZeroException, createImportFactory, createImportValidateFile, mapDownloadResult,
  lockNameOf, recordTrigger, identityFor, TASK_ID_PREFIX,
  assertNoForbiddenDeps, refused, humanRequired, scrub, safeReason, defaultWaitForDownloadFile,
  REPORT_TYPE, PLATFORM, ENV_ENABLE_KEY, COVERAGE_PATH, DOWNLOAD_DEP_KEYS, ADAPTER_KEYS, SOURCE,
  INTEGRITY_UNVERIFIED,
};
