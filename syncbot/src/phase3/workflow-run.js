'use strict';
/**
 * **全链路总编排入口**（阶段5）：把既有下载与 import-run 串成一条 **data-only** 链
 *
 *   G1 覆盖闸门 → 下载/归档/文件校验 → G3 覆盖闸门 → 导入 → IMPORT_SUCCEEDED → COMPLETED
 *
 * **架构目标（收口）**：syncbot 只负责"美团报表 A 导出、校验、导入项目数据库"；
 * 上午 9 点日报推送由**项目现有机器人**（中控侧，持有企业微信 webhook）承担。
 * 因此本入口：
 *   · **不装配、不调用、也不要求任何 push adapter**（传 `stagePush` 直接抛错）；
 *   · 不读取 webhook/token、不发送企业微信、不产生 PUSH_SUCCEEDED / PUSH_FAILED 事件；
 *   · 缺少 sender **不会**阻止下载与导入（本入口根本不引用 sender）；
 *   · 导入成功后把任务置为 COMPLETED，并把 state.js 的 ready_to_push 留给项目侧日报任务使用。
 * （stage3 的 push-run.js / push-client.js 仍在仓库中保留其离线套件，但**无任何生产调用路径**。）

 * 硬性约束（逐条对应本轮要求）：
 *  1. **只接受 report_type=cashier_composite + 显式业务日期**：日期必须显式传入且合法，
 *     绝不推断/默认；配置与调用参数都做**白名单校验**（多传一个未知参数即抛错）。
 *  2. **一个业务日期 = 一个持久化 workflow task_id + 一把锁 + 可恢复状态**：
 *     task_id 首次生成后落盘复用（同日期换 id 直接拒绝）；锁名按日期区分；状态写在
 *     state/tasks/<platform>/<report_type>/<date>.json 的 workflow 段（src/state.js 原子写）。
 *  3. 下载失败（含 precheck/query/export/下载/校验/归档任一失败点）→ **导入与推送调用数均为 0**。
 *  4. 导入失败或 WAITING_HUMAN → **推送调用数为 0**。
 *  5. 推送失败 → **绝不回滚、绝不重试导入/下载**（阶段终态即停）。
 *  6. `historical_backfill` **永远不得进入真实导入或推送成功路径**（总入口前置即拒绝，0 调用）。
 *  7. 崩溃恢复**不得重复 export / import / 消息发送**：
 *     · 已完成（success）的阶段一律跳过；
 *     · 停在 running（结果未知）的阶段一律拒绝并转人工；
 *     · 下载阶段曾失败但**已提交过导出**（export_submitted）时不再重跑（避免二次导出）；
 *     · 只允许审计补送（既有 OUTBOX.flush）或人工处理。
 *  8. 所有边界继续由既有模块发出审计事件（批量检查点 + sha256_prefix 脱敏规则），
 *     总入口自身不新造阶段、不写原始敏感字段。
 *  9. 总入口**不创建任何 cron/timer**；真实运行必须由显式 `confirm` 参数触发
 *     （CLI 亦然：缺少 `--confirm` 直接拒绝）。
 */
const TC = require('../task-context');
const state = require('../state');
const lock = require('../lock');
const OUTBOX = require('./audit-outbox');
const PROD_ADAPTERS = require('./workflow-production-adapters');
const { scrubText } = require('./real-download-audit');

const ALLOWED_REPORT_TYPES = ['cashier_composite', 'item_sales_detail', 'pos_bookkeeping_daily'];
const REPORT_B_MANUAL_MODE = 'manual_catchup';
const REPORT_B_SCHEDULED_MODE = 'scheduled';
const ALLOWED_PLATFORMS = ['meituan'];
const SECTION = 'workflow';
const STAGE_KEYS = ['download', 'import'];           // data-only：不含 push
/** 构造参数白名单（多传未知参数 → 直接拒绝） */
const ALLOWED_CONFIG_KEYS = new Set(['reportType', 'businessDate', 'platform', 'taskId', 'confirm', 'backfill', 'platformChannel',
  'gates', 'stageDownload', 'stageImport', 'lockName', 'staleMs', 'logger', 'outbox', 'taskIdPrefix', 'production', 'reportBMode', 'reportCMode']);
// 注意：**不接受** stagePush/push 之类的键 —— 生产 workflow 不装配 push adapter（传入即抛错）。
/** runOnce 参数白名单 */
const ALLOWED_RUN_KEYS = new Set(['confirm', 'resumeExisting', 'retryPreExport', 'resumeValidated', 'resumePreviewRejected']);

function assertPlainDate(v) {
  const s = String(v == null ? '' : v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('businessDate 必须是显式 YYYY-MM-DD（禁止推断/默认）');
  return s;
}
function assertNoUnknown(obj, allowed, what) {
  const unknown = Object.keys(obj || {}).filter((k) => !allowed.has(k));
  if (unknown.length) throw new Error(what + ' 含未知参数（已拒绝）：' + unknown.join(','));
}

function createWorkflowRun(config = {}) {
  assertNoUnknown(config, ALLOWED_CONFIG_KEYS, 'workflow 配置');
  const { reportType, businessDate, platform = 'meituan', taskId = null, confirm = false, backfill = false, gates = {},
    staleMs = undefined, logger = null, outbox = OUTBOX, production = null } = config;
  // 生产适配器只能由显式工厂（phase3/workflow-production-adapters.js）装配后注入；
  // 未显式启用/未齐备时一律 fail-closed（构造期直接抛错，零副作用）。
  let stageDownload = config.stageDownload || null;
  let stageImport = config.stageImport || null;
  let productionInfo = { enabled: false, source: 'injected-stage-runners' };
  if (production) {
    if (production.enabled !== true) throw new Error('production.enabled 必须显式为 true（未显式启用生产适配器 → fail-closed）');
    const a = production.adapters || {};
    if (a.push) throw new Error('data-only：生产 workflow 不得装配 push adapter');
    if (!a.download || typeof a.download.run !== 'function') throw new Error('生产装配不完整：缺 download.run');
    if (!a.import || typeof a.import.runOnce !== 'function') throw new Error('生产装配不完整：缺 import.runOnce');
    stageDownload = a.download; stageImport = a.import;
    productionInfo = { enabled: true, source: 'workflow-production-adapters', mode: 'data-only', whitelist: production.whitelist || null };
  }
  const bd = assertPlainDate(businessDate);                    // 显式业务日期
  if (!ALLOWED_REPORT_TYPES.includes(String(reportType))) throw new Error('全链路总入口只接受 report_type=' + ALLOWED_REPORT_TYPES.join('/') + '（收到：' + reportType + '）');
  if (reportType === 'item_sales_detail' && (!((config.reportBMode === REPORT_B_MANUAL_MODE && backfill === true)
    || (config.reportBMode === REPORT_B_SCHEDULED_MODE && backfill === false))
    || !config.stageDownload || !config.stageImport || !gates.g1 || !gates.g3))
    throw new Error('报表 B 仅允许显式 manual_catchup/backfill 或 scheduled/realtime + 双覆盖闸门 + 双阶段适配器');
  if (reportType === 'pos_bookkeeping_daily' && (!((config.reportCMode === REPORT_B_MANUAL_MODE && backfill === true)
    || (config.reportCMode === REPORT_B_SCHEDULED_MODE && backfill === false))
    || config.reportBMode !== undefined || !config.stageDownload || !config.stageImport || !gates.g1 || !gates.g3))
    throw new Error('报表 C 仅允许显式 manual_catchup/backfill 或 scheduled/realtime + 双覆盖闸门 + 双阶段适配器');
  if (reportType === 'cashier_composite' && config.reportBMode !== undefined)
    throw new Error('报表 A 不接受 reportBMode');
  if (reportType !== 'pos_bookkeeping_daily' && config.reportCMode !== undefined)
    throw new Error('只有报表 C 接受 reportCMode');
  if (!ALLOWED_PLATFORMS.includes(String(platform))) throw new Error('不支持的平台：' + platform);
  TC.assertResidentReportType(reportType);                     // 未授权报表（报表 B）在此被拒
  const lockName = config.lockName || ('phase3-workflow.' + bd);
  const timeline = [];
  let ranInProcess = false;

  function ctxOf(id) { return TC.createContext(reportType, { platform, taskId: id, businessDate: bd }); }
  const readWf = () => state.read(platform, bd, reportType)[SECTION] || {};
  function patchWf(data, status) { return state.patch(platform, bd, SECTION, data, { status, reportType }); }
  function note(step, data) {
    const rec = Object.assign({ at: new Date().toISOString(), step, business_date: bd }, data || {});
    timeline.push(rec);
    if (logger && typeof logger.info === 'function') { try { logger.info('workflow.' + step, rec); } catch (_) {} }
    return rec;
  }
  function baseWf(extra) {
    const cur = readWf();
    return Object.assign({
      task_id: cur.task_id || null, report_type: reportType, platform, business_date: bd,
      phase: cur.phase || null, status: cur.status || 'created',
      g1: cur.g1 || null, g3: cur.g3 || null,
      stages: Object.assign({ download: { status: 'pending', attempts: 0 }, import: { status: 'pending', attempts: 0 } }, cur.stages || {}),
      failure_reason: cur.failure_reason || null, terminal: cur.terminal === true,
      manual_catchup: reportType === 'item_sales_detail' && config.reportBMode === REPORT_B_MANUAL_MODE,
      scheduled_report_b: reportType === 'item_sales_detail' && config.reportBMode === REPORT_B_SCHEDULED_MODE,
      manual_catchup_c: reportType === 'pos_bookkeeping_daily' && config.reportCMode === REPORT_B_MANUAL_MODE,
      scheduled_report_c: reportType === 'pos_bookkeeping_daily' && config.reportCMode === REPORT_B_SCHEDULED_MODE,
      created_at: cur.created_at || new Date().toISOString(), updated_at: new Date().toISOString(),
    }, extra || {});
  }
  /** 确保"一个业务日期一个持久化 task_id" */
  function ensureTaskId() {
    const cur = readWf();
    const persisted = cur.task_id ? String(cur.task_id) : null;
    const prefix = config.taskIdPrefix || 'wf';
    const derived = persisted || (taskId ? String(taskId) : (prefix + '-' + platform + '-' + reportType + '-' + bd));
    if (persisted && taskId && String(taskId) !== persisted) {
      throw new Error('同一业务日期只允许一个 workflow task_id（已持久化 ' + persisted + '，收到 ' + taskId + '）');
    }
    if (!persisted) patchWf(baseWf({ task_id: derived, phase: 'CREATED', status: 'created' }), 'created');
    return derived;
  }

  /** 拒绝：0 阶段调用；不覆盖既有终态；不伪造任何 ready_to_push */
  async function refuse(reason, { detail = {}, recoverAudit = false, calls = null, failure = null } = {}) {
    const cur = readWf();
    const id = cur.task_id || taskId || ('wf-pending-' + bd);
    if (recoverAudit) {
      try {
        const r = await outbox.flush({ ctx: ctxOf(id), opts: config.outboxOpts || {} });
        note('audit_flush_only', { reason, attempted: r && r.attempted, delivered: r && r.delivered, failed: r && r.failed });
      } catch (e) { note('audit_flush_error', { reason, error: scrubText(e && e.message, 80) }); }
    }
    const terminalStatuses = ['success', 'failed', 'waiting_human'];
    if (terminalStatuses.includes(String(cur.status))) {
      // 已是终态：只追加拒绝记录（绝不改写终态证据）
      patchWf(baseWf({ last_refusal: { reason, at: new Date().toISOString() } }), cur.status);
    } else {
      patchWf(baseWf(Object.assign({ phase: 'REFUSED', failure_reason: reason, terminal: true, gate_detail: detail.gate_detail || null }, detail.state || {})), 'waiting_human');
    }
    note('refused', { reason, gate_detail: detail.gate_detail || null });
    // stage_calls 必须反映**本次真实发生过**的阶段调用（拒绝可能发生在阶段之后，如导入失败后的转人工）
    // failure_stage / failure_reason：脱敏后的**失败阶段与原因透传**（不得只保留笼统 download_failed）
    return { ok: false, action: 'WAITING_HUMAN', reason, stage_calls: calls || { download: 0, import: 0 }, state: readWf(), timeline,
      failure_stage: (failure && failure.stage) ? String(failure.stage).slice(0, 40) : null,
      failure_reason: (failure && failure.reason) ? String(failure.reason).slice(0, 80) : null };
  }

  function stagePatch(key, data) {
    const cur = readWf();
    const stages = Object.assign({}, (cur.stages || {}), { [key]: Object.assign({}, ((cur.stages || {})[key] || {}), data) });
    return stages;
  }

  /**
   * 跑一次全链路。**永不抛出**（参数校验错误会抛，便于调用方立刻发现误用）。
   */
  async function runOnce(runArgs = {}) {
    assertNoUnknown(runArgs, ALLOWED_RUN_KEYS, 'runOnce 参数');
    const useConfirm = runArgs.confirm === undefined ? confirm === true : runArgs.confirm === true;
    const id = ensureTaskId();
    const cur0 = readWf();
    // 已完成的 workflow：0 调用（只允许审计补送/人工处理）
    if (cur0.status === 'success') return refuse('workflow_already_completed', { recoverAudit: true });
    if (runArgs.resumePreviewRejected === true) {
      const priorDownload = cur0.stages?.download || {};
      const priorImport = cur0.stages?.import || {};
      if (reportType !== 'pos_bookkeeping_daily' || config.reportCMode !== REPORT_B_MANUAL_MODE
        || bd !== '2026-09-24' || runArgs.resumeValidated !== true
        || runArgs.resumeExisting === true || runArgs.retryPreExport === true
        || !(cur0.status === 'waiting_human'
          || (cur0.status === 'running' && cur0.phase === 'G1_CHECK'))
        || priorDownload.status !== 'success'
        || priorDownload.export_submitted !== true || priorImport.status !== 'waiting_human'
        || priorImport.reason !== 'report_c_import_preview_not_ready'
        || priorImport.import_batch_id || Number(priorImport.attempts) !== 1)
        return refuse('report_c_preview_recovery_not_safe', { recoverAudit: true });
    } else if (cur0.stages?.import?.status === 'waiting_human') {
      return refuse('import_previously_waiting_human', { recoverAudit: true });
    }
    // --resume-existing 是「只消费既有导出」而不是「允许新跑」：没有持久化的提交证据则零阶段调用。
    if (runArgs.resumeExisting === true) {
      const prior = ((cur0.stages || {}).download) || {};
      if (prior.status !== 'failed' || prior.export_submitted !== true) {
        return refuse('resume_existing_export_not_found', { recoverAudit: true });
      }
    }
    if (runArgs.retryPreExport === true) {
      const prior = ((cur0.stages || {}).download) || {};
      if (reportType !== 'item_sales_detail' || config.reportBMode !== REPORT_B_MANUAL_MODE
        || runArgs.resumeExisting === true || prior.status !== 'failed' || prior.export_submitted !== false
        || (((cur0.stages || {}).import || {}).attempts || 0) !== 0) {
        return refuse('pre_export_retry_not_safe', { recoverAudit: true });
      }
    }
    if (runArgs.resumeValidated === true) {
      const prior = ((cur0.stages || {}).download) || {};
      const imp = ((cur0.stages || {}).import) || {};
      if (!((reportType === 'item_sales_detail' && config.reportBMode === REPORT_B_MANUAL_MODE)
        || (reportType === 'pos_bookkeeping_daily' && config.reportCMode === REPORT_B_MANUAL_MODE))
        || runArgs.resumeExisting === true || runArgs.retryPreExport === true
        || prior.status !== 'success' || !cur0.download_result || cur0.download_result.ok !== true
        || !(imp.status === 'pending' && Number(imp.attempts || 0) === 0
          || runArgs.resumePreviewRejected === true && imp.status === 'waiting_human' && Number(imp.attempts || 0) === 1)
        || !stageDownload || typeof stageDownload.resumeValidated !== 'function')
        return refuse('resume_validated_not_safe', { recoverAudit: true });
    }
    // 崩溃恢复：只有"阶段停在 running（结果未知）"才必须转人工；其余情况可安全续跑（跳过的到已完成阶段）
    const uncertainStages = STAGE_KEYS.filter((k) => (((cur0.stages || {})[k] || {}).status) === 'running');
    if (uncertainStages.length) return refuse('workflow_stage_in_flight_uncertain:' + uncertainStages.join(','), { recoverAudit: true });
    if (ranInProcess) return refuse('workflow_already_started_in_process');
    // ⑨ 显式 confirm（真实运行必须由 CLI --confirm 触发）
    if (!useConfirm) return refuse('confirm_required');
    // ⑥ 历史回填绝不进入真实导入/推送成功路径
    if (backfill === true && !((reportType === 'item_sales_detail' && config.reportBMode === REPORT_B_MANUAL_MODE)
      || (reportType === 'pos_bookkeeping_daily' && config.reportCMode === REPORT_B_MANUAL_MODE)))
      return refuse('historical_backfill_not_realtime');

    let lockHandle = null;
    try { lockHandle = lock.acquire(lockName, reportType, { staleMs, meta: { task_id: id, business_date: bd, purpose: 'phase3-workflow' } }); }
    catch (e) { return refuse('workflow_locked', { detail: { gate_detail: 'lock', state: { lock_error: scrubText(e && e.message, 100) } } }); }

    const calls = { download: 0, import: 0 };   // data-only：没有 push 调用计数
    try {
      ranInProcess = true;
      const ctx = ctxOf(id);
      patchWf(baseWf({ task_id: id, phase: 'G1_CHECK', status: 'running', lock: { name: lockName, at: new Date().toISOString() } }), 'running');
      note('lock_acquired', { lock: lockName });

      // ---------- G1 覆盖闸门 ----------
      let g1 = null;
      try { g1 = gates.g1 ? await gates.g1({ businessDate: bd, platform, reportType, taskId: id }) : { ok: false, coverage_hit: false, reason: 'g1_not_configured' }; }
      catch (e) { g1 = { ok: false, coverage_hit: false, reason: 'g1_exception:' + scrubText(e && e.message, 60) }; }
      patchWf(baseWf({ g1: { ok: g1 && g1.ok === true, coverage_hit: !!(g1 && g1.coverage_hit), reason: g1 && g1.reason ? scrubText(g1.reason, 80) : null, at: new Date().toISOString() } }), 'running');
      note('g1_checked', { ok: !!(g1 && g1.ok === true), coverage_hit: !!(g1 && g1.coverage_hit) });
      if (!g1 || g1.ok !== true) {
        return await refuse(g1 && g1.coverage_hit ? 'g1_coverage_gate_hit' : 'g1_coverage_gate_failed',
          { detail: { gate_detail: 'g1', state: { stage_counts: calls } }, recoverAudit: false });
      }

      // ---------- 阶段1：下载 / 归档 / 文件校验 ----------
      const st1 = readWf();
      const dl = (st1.stages && st1.stages.download) || { status: 'pending', attempts: 0 };
      let downloadResult = null;   // 只能由本次下载阶段（或已 success 的持久化结果）填充
      let runDownloadStage = false;
      if (dl.status === 'success') {
        note('download_skipped', { reason: 'already_succeeded' });
        if (runArgs.resumeValidated === true) {
          const previous = st1.download_result || {};
          downloadResult = await stageDownload.resumeValidated({ ctx,
            archivedName: previous.archived_name, shaPrefix: previous.sha256_prefix,
            allowException: runArgs.resumePreviewRejected === true });
          if (!downloadResult || downloadResult.ok !== true)
            return await refuse('validated_archive_recovery_failed',
              { detail: { gate_detail: 'download', state: { stage_counts: calls } }, recoverAudit: true });
          note('validated_archive_resumed', { report_type: reportType, browser_calls: 0 });
          if (reportType === 'pos_bookkeeping_daily' && runArgs.resumePreviewRejected === true)
            patchWf(baseWf({ download_result: sanitizeDownload(downloadResult),
              exception_evidence: downloadResult.exception_evidence || null }), 'running');
        } else {
          if (reportType === 'item_sales_detail' || reportType === 'pos_bookkeeping_daily')
            return await refuse('validated_archive_resume_required',
              { detail: { gate_detail: 'download', state: { stage_counts: calls } }, recoverAudit: true });
          downloadResult = st1.download_result || null;   // 旧行为；不重跑已完成下载
        }
      } else if (dl.status === 'running') {
        return await refuse('download_in_flight_uncertain', { detail: { gate_detail: 'download', state: { stage_counts: calls } }, recoverAudit: true });
      } else if (dl.status === 'failed' && dl.export_submitted === true) {
        // 默认（保护不变）：已提交过导出的失败下载阶段一律拒绝，绝不重跑 ⇒ 防二次导出。
        // 仅当调用方**显式** resumeExisting=true 时放行，并且仍然不提交任何导出：
        //   编排层会用既有文件/清单续取，canSubmitExport 由 export_submitted_at 阻断。
        if (runArgs.resumeExisting !== true) {
          return await refuse('download_previously_submitted_export', { detail: { gate_detail: 'download', state: { stage_counts: calls } }, recoverAudit: true });
        }
        note('download_resume_existing', { export_submitted: true, resume_existing: true });
        runDownloadStage = true;   // 续跑必须实际再跑一次下载阶段，取得本次正式校验结果
      } else if (dl.status === 'failed' && runArgs.retryPreExport !== true) {
        return await refuse('download_previously_failed_requires_explicit_retry',
          { detail: { gate_detail: 'download', state: { stage_counts: calls } }, recoverAudit: true });
      } else {
        runDownloadStage = true;
      }
      if (runDownloadStage) {
        if (!stageDownload || typeof stageDownload.run !== 'function') return await refuse('download_runner_not_configured');
        calls.download += 1;
        patchWf(baseWf({ phase: 'DOWNLOAD_RUNNING', stages: stagePatch('download', { status: 'running', started_at: new Date().toISOString(), attempts: (dl.attempts || 0) + 1 }) }), 'running');
        let dres = null;
        try { dres = await stageDownload.run({ ctx, workflow: { task_id: id, business_date: bd }, businessDate: bd, taskId: id,
          resumeExisting: runArgs.resumeExisting === true, retryPreExport: runArgs.retryPreExport === true }); }
        catch (e) { dres = { ok: false, failure_reason: 'download_exception:' + scrubText(e && e.message, 60), export_submitted: false }; }
        downloadResult = dres || null;
        // G3 前置：本次下载结果必须存在 ⇒ 绝不把空/旧结果交给覆盖闸门与导入阶段
        if (!downloadResult) return await refuse('download_result_missing', { detail: { gate_detail: 'download', state: { stage_counts: calls } }, calls, recoverAudit: true });
        const dlStatus = dres && dres.ok === true ? 'success' : 'failed';
        patchWf(baseWf({
          phase: dlStatus === 'success' ? 'DOWNLOAD_DONE' : 'DOWNLOAD_FAILED',
          download_result: sanitizeDownload(dres),
          stages: stagePatch('download', { status: dlStatus, finished_at: new Date().toISOString(), phase: dres && dres.phase ? String(dres.phase).slice(0, 40) : null,
            export_submitted: dres && dres.export_submitted === true, reason: dres && dres.failure_reason ? scrubText(dres.failure_reason, 120) : null }),
        }), 'running');
        note('download_finished', { ok: dlStatus === 'success', export_submitted: !!(dres && dres.export_submitted) });
        if (dlStatus !== 'success') {
          // ③ 下载失败 → 导入调用数为 0（本入口没有推送阶段）
          // 失败阶段/原因具体化：下载侧给出具体码时，顶层 reason 也带上（download_failed:<stage>:<code>），
          // 同时以 failure_stage / failure_reason 字段透传（旧调用方仍可用前缀 'download_failed' 匹配）。
          const fstage = (dres && dres.failure_stage) ? scrubText(dres.failure_stage, 40) : null;
          const freason = (dres && dres.failure_reason) ? scrubText(dres.failure_reason, 80) : null;
          const detailReason = (fstage && freason && /^[A-Za-z][A-Za-z0-9_.:-]{0,39}$/.test(fstage) && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(freason))
            ? ('download_failed:' + fstage + ':' + freason).slice(0, 120)
            : 'download_failed';
          return await refuse(detailReason, { detail: { gate_detail: 'download', state: { stage_counts: calls } }, calls,
            failure: { stage: fstage, reason: freason } });
        }
      }

      // ---------- G3 覆盖闸门（紧邻导入） ----------
      let g3 = null;
      try { g3 = gates.g3 ? await gates.g3({ businessDate: bd, platform, reportType, taskId: id, download: downloadResult }) : { ok: false, coverage_hit: false, reason: 'g3_not_configured' }; }
      catch (e) { g3 = { ok: false, coverage_hit: false, reason: 'g3_exception:' + scrubText(e && e.message, 60) }; }
      patchWf(baseWf({ phase: 'G3_CHECKED', g3: { ok: g3 && g3.ok === true, coverage_hit: !!(g3 && g3.coverage_hit), reason: g3 && g3.reason ? scrubText(g3.reason, 80) : null, at: new Date().toISOString() } }), 'running');
      note('g3_checked', { ok: !!(g3 && g3.ok === true), coverage_hit: !!(g3 && g3.coverage_hit) });
      if (!g3 || g3.ok !== true) {
        return await refuse(g3 && g3.coverage_hit ? 'g3_coverage_gate_hit' : 'g3_coverage_gate_failed',
          { detail: { gate_detail: 'g3', state: { stage_counts: calls } }, calls });
      }

      // ---------- 阶段2：导入 ----------
      const st2 = readWf();
      const im = (st2.stages && st2.stages.import) || { status: 'pending', attempts: 0 };
      let importAction = im.status === 'success' ? 'IMPORT_SUCCEEDED' : null;
      if (im.status === 'success') {
        note('import_skipped', { reason: 'already_succeeded' });
      } else {
        if (!stageImport || typeof stageImport.runOnce !== 'function') return await refuse('import_runner_not_configured');
        calls.import += 1;
        patchWf(baseWf({ phase: 'IMPORT_RUNNING', stages: stagePatch('import', { status: 'running', started_at: new Date().toISOString(), attempts: (im.attempts || 0) + 1 }) }), 'running');
        let ires = null;
        try { ires = await stageImport.runOnce({ ctx, workflow: { task_id: id, business_date: bd }, businessDate: bd, g3, download: downloadResult }); }
        catch (e) { ires = { ok: false, action: 'IMPORT_FAILED', reason: 'import_exception:' + scrubText(e && e.message, 60), http_requests: 0 }; }
        importAction = ires && ires.action ? String(ires.action) : 'IMPORT_FAILED';
        const imStatus = importAction === 'IMPORT_SUCCEEDED' ? 'success' : (importAction === 'IMPORT_FAILED' ? 'failed' : 'waiting_human');
        patchWf(baseWf({
          phase: imStatus === 'success' ? 'IMPORT_DONE' : imStatus === 'failed' ? 'IMPORT_FAILED' : 'IMPORT_WAITING_HUMAN',
          stages: stagePatch('import', { status: imStatus, finished_at: new Date().toISOString(), action: importAction,
            http_requests: Number.isFinite(Number(ires && ires.http_requests)) ? Number(ires.http_requests) : 0,
            import_batch_id: (ires && ires.import_batch_id) || null,
            reason: ires && ires.reason ? scrubText(ires.reason, 120) : null }),
        }), 'running');
        note('import_finished', { action: importAction, http_requests: (ires && ires.http_requests) || 0 });
        if (imStatus !== 'success') {
          // ④ 导入失败或 WAITING_HUMAN → 到此结束，绝不触发任何推送动作
          return await refuse('import_' + imStatus, { detail: { gate_detail: 'import', state: { stage_counts: calls } }, calls });
        }
      }

      // ---------- 链尾：导入成功即 COMPLETED（data-only，不存在推送阶段） ----------
      // ⑤ 本入口到此结束：不装配/不调用任何 push adapter，不读 webhook/token，
      //    不发送企业微信，也不产生 PUSH_SUCCEEDED / PUSH_FAILED 事件。
      //    上午 9 点日报推送由项目现有机器人（中控侧）负责，syncbot 只把数据落进项目数据库。
      patchWf(baseWf({ phase: 'COMPLETED', terminal: true, failure_reason: null,
        gate_detail: null, stage_counts: calls }), 'success');
      note('workflow_completed', { action: 'IMPORT_SUCCEEDED', data_only: true, push_calls: 0 });
      return { ok: true, action: 'COMPLETED', reason: importAction === 'IMPORT_SUCCEEDED' && im.status === 'success' ? 'already_imported' : null,
        stage_calls: calls, push_calls: 0, data_only: true, state: readWf(), timeline };
    } finally {
      try { if (lockHandle) lockHandle.release(); } catch (_) {}
    }
  }

  function sanitizeDownload(d) {
    if (!d) return null;
    return {
      ok: d.ok === true, result: d.result ? String(d.result).slice(0, 40) : null,
      phase: d.phase ? String(d.phase).slice(0, 40) : null,
      export_submitted: d.export_submitted === true,
      failure_stage: d.failure_stage ? scrubText(d.failure_stage, 40) : null,
      confirmation_mode: d.confirmation_mode ? scrubText(d.confirmation_mode, 40) : null,
      archived_name: d.archived_name ? String(d.archived_name).slice(0, 120) : (d.file ? String(d.file).split(/[\\/]/).pop().slice(0, 120) : null),
      sha256_prefix: /^[0-9a-f]{1,12}$/i.test(String(d.sha256_prefix || '')) ? String(d.sha256_prefix).toLowerCase() : null,
      failure_reason: d.failure_reason ? scrubText(d.failure_reason, 120) : null,
    };
  }

  function summary() {
    const st = state.read(platform, bd, reportType);
    return {
      ctx: { task_id: readWf().task_id || taskId || null, report_type: reportType, platform, business_date: bd },
      workflow: st[SECTION] || null,
      lock_name: lockName,
      // push / ready_to_push 仅**只读展示**（供项目侧日报任务使用），本入口从不写入 push 状态
      data_only: true, push_owner: 'project_daily_report_bot(中控 9 点日报推送)',
      top_level: { import: st.import && st.import.status, validate_import: st.validate_import && st.validate_import.status, push: st.push && st.push.status, ready_to_push: st.ready_to_push === true },
      timeline: timeline.slice(),
    };
  }
  return { runOnce, ensureTaskId, readWf, summary, timeline, lockName, SECTION };
}

// ---------------- CLI（生产运行必须三个参数齐全；绝不创建 cron/timer） ----------------
const CLI_USAGE = [
  '用法: node src/phase3/workflow-run.js --confirm-real-workflow --report-type=cashier_composite --date=YYYY-MM-DD',
  '说明: 三个参数缺一不可，且不接受任何其它参数（多余参数一律 exit 2）。',
  '      日期必须显式给出，绝不推断"今天/昨天"；本入口不创建任何定时任务/timer。',
  '      本入口为 data-only：只做「导出/归档/校验 → 导入项目数据库」，不含也不调用任何推送通道。',
].join('\n');

/** 严格解析 CLI：返回 {ok:true,reportType,businessDate} 或 {ok:false,reason} */
function parseProductionCli(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const seen = {};
  for (const raw of args) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(String(raw));
    if (!m) return { ok: false, reason: 'unexpected_argument:' + String(raw).slice(0, 40) };
    const name = m[1];
    const value = m[2];
    if (name === 'confirm-real-workflow') {
      if (value !== undefined) return { ok: false, reason: 'flag_takes_no_value:confirm-real-workflow' };
      seen.confirmRealWorkflow = true;
      continue;
    }
    if (name === 'report-type' || name === 'date') {
      if (value === undefined || value === '') return { ok: false, reason: 'flag_requires_value:' + name };
      if (seen[name] !== undefined) return { ok: false, reason: 'duplicate_flag:' + name };
      seen[name] = value;
      continue;
    }
    return { ok: false, reason: 'unknown_flag:' + name };
  }
  if (seen.confirmRealWorkflow !== true) return { ok: false, reason: 'missing_flag:--confirm-real-workflow' };
  if (seen['report-type'] === undefined) return { ok: false, reason: 'missing_flag:--report-type' };
  if (seen.date === undefined) return { ok: false, reason: 'missing_flag:--date' };
  if (seen['report-type'] !== 'cashier_composite') return { ok: false, reason: 'report_type_not_allowed:' + seen['report-type'] };
  const d = String(seen.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, reason: 'business_date_format_invalid' };
  const dt = new Date(d + 'T00:00:00Z');
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== d) return { ok: false, reason: 'business_date_not_a_real_date' };
  return { ok: true, reportType: 'cashier_composite', businessDate: d };
}

/**
 * CLI 主流程（**可被离线套件直接调用**，与真实 CLI 完全同一条代码路径）。
 * 返回 {exitCode, reason}；exitCode: 2 = 参数违规，3 = fail-closed，0 = 允许执行（本构建恒不可达）。
 */
function runProductionCli(argv, { env = process.env, out = (s) => console.error(s) } = {}) {
  const parsed = parseProductionCli(argv);
  if (!parsed.ok) {
    out(CLI_USAGE);
    out('拒绝执行（exit 2）：' + parsed.reason + '（未装配任何适配器、未触发浏览器/HTTP/任何外发动作）。');
    return { exitCode: 2, reason: parsed.reason };
  }
  // 显式启用生产适配器（env 未置位 → fail-closed）；依赖工厂必须由运维显式提供
  const prod = PROD_ADAPTERS.createWorkflowProductionAdapters({
    enable: env && env.SYNCBOT_WORKFLOW_PROD_ADAPTERS === '1',
    confirmRealWorkflow: true,
    reportType: parsed.reportType,
    businessDate: parsed.businessDate,
    deps: {},
  });
  if (!prod.ok) {
    out('拒绝执行（exit 3）：' + prod.reason + '（fail-closed：未显式启用生产适配器或装配不完整，零副作用）。');
    out('适配器调用白名单：' + Object.keys(PROD_ADAPTERS.ADAPTER_CALL_WHITELIST).join(' / '));
    return { exitCode: 3, reason: prod.reason };
  }
  // 装配成功也不会在本构建内自动跑真实日期任务：真实依赖（真实下载适配器 / 真实导入客户端）须由运维另行提供与批准。
  // data-only：本入口**不涉及**任何推送通道/凭据（推送由项目侧 9 点日报任务负责）。
  out('拒绝执行（exit 3）：三个参数与装配均通过，但本构建不承载真实运行入口（真实下载适配器与正式导入客户端须由运维显式提供）。');
  return { exitCode: 3, reason: 'real_run_not_provided_in_build' };
}

if (require.main === module) {
  process.exit(runProductionCli(process.argv.slice(2)).exitCode);
}

module.exports = { createWorkflowRun, parseProductionCli, runProductionCli, CLI_USAGE, ALLOWED_REPORT_TYPES, ALLOWED_PLATFORMS, SECTION, STAGE_KEYS, ALLOWED_CONFIG_KEYS };
