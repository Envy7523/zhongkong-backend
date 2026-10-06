'use strict';
/**
 * 真实下载流程 · 编排层（把已验收的零部件串联起来）
 *
 * 本文件**只做编排**：
 *   - 状态机     → ./real-flow-state.js（已验收）
 *   - 目标行匹配 → ./download-list-match.js（已验收）
 *   - 文件校验   → ./report-a-file-validate.js（已验收）
 *   - 浏览器动作 → 由调用方注入 adapters（生产用 client/flow/probe；离线测试用 fixture）
 *
 * 硬规则（在编排层强制，不依赖适配器自觉）：
 *   - 导出提交是不可逆动作，唯一入口 submitExportOnce()，经状态机闸门校验；
 *   - 已存在提交标记时**只允许**进入清单轮询，绝不再次提交；
 *   - 任一异常 / 歧义 / 超时 / 校验失败 → FAILED 并立即停止，不重试提交；
 *   - finally 无条件复位 approvals 为 false；
 *   - 绝不调用 import / validate_import / push（编排层根本不持有这些适配器）。
 */
const SM = require('./real-flow-state');
const M = require('./download-list-match');

const DEFAULTS = {
  initialWaitMs: 60 * 1000,
  pollIntervalMs: 60 * 1000,
  maxWaitMs: 25 * 60 * 1000,
};

/** 供离线测试断言：编排层允许调用的适配器白名单 */
const ALLOWED_ADAPTERS = [
  'precheck', 'probeDownloadList', 'navigateAndQuery', 'submitExport',
  'readDownloadRows', 'waitForPassiveFile', 'observeDownloadList', 'downloadFile', 'retrieveFromDownloadList', 'archive', 'validateFile',
  'screenshot', 'setApprovals', 'resetApprovals',
];
/** 明令禁止：编排层不得持有或调用（出现即视为缺陷） */
const FORBIDDEN_ADAPTERS = ['import', 'importWorkbook', 'validateImport', 'push', 'createTimer'];

function createOrchestrator(opts) {
  const {
    ctx,
    store,
    adapters = {},
    now = () => new Date().toISOString(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    wait = DEFAULTS,
    reportName = '综合营业统计',
  } = opts || {};

  if (!ctx || !ctx.reportType || !ctx.businessDate || !ctx.taskId) throw new Error('createOrchestrator 需要完整 TaskContext');
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') throw new Error('createOrchestrator 需要 store{load,save}');

  const bad = FORBIDDEN_ADAPTERS.filter((k) => typeof adapters[k] === 'function');
  if (bad.length) throw new Error(`编排层禁止持有以下适配器：${bad.join(', ')}（import/推送/timer 不在本流程范围内）`);
  const unknown = Object.keys(adapters).filter((k) => !ALLOWED_ADAPTERS.includes(k));
  if (unknown.length) throw new Error(`未知适配器：${unknown.join(', ')}（白名单：${ALLOWED_ADAPTERS.join(', ')}）`);

  const call = async (name, ...args) => {
    const fn = adapters[name];
    if (typeof fn !== 'function') throw new Error(`缺少适配器：${name}`);
    return fn(...args);
  };
  const snap = async (nn, step) => {
    if (typeof adapters.screenshot !== 'function') return;
    try {
      const shot = await adapters.screenshot({ ctx, nn, step });
      if (shot && shot.path) machine.addScreenshot({ at: now(), step, path: shot.path });
    } catch (_) { /* 取证失败不得改变导出/下载状态；主错误继续保留 */ }
  };

  const machine = SM.createMachine({ load: store.load, save: store.save, now });
  const calls = { exportSubmit: 0, download: 0, delete: 0, poll: 0, approvalsReset: 0, approvalsOn: 0 };

  async function submitExportOnce(gates) {
    // 不可逆闸门：状态机内部再次校验 export_submitted_at / phase / 三项前置
    const chk = SM.canSubmitExport(machine.state, gates);
    if (!chk.ok) return { ok: false, submitted: false, uncertain: false, stage: null, reason: chk.reason };
    calls.exportSubmit += 1;
    let r = null;
    try { r = await call('submitExport', { ctx }); }
    catch (e) { r = { ok: false, stage: 'export_click', reason: 'submit_export_threw', export_clicked: false, host_error: String((e && e.message) || '').slice(0, 160) }; }
    // 关键（2026-09-23 导出确认弹窗修复）：只要 export 点击已下发，就必须落下**不可逆**「已提交」标记 ——
    // 即使确认弹窗失败，后续任何路径与任何重跑都不得再次点击导出（fail-closed：状态不确定 ⇒ 转人工）。
    const exportClicked = !!(r && (r.export_clicked === true || r.ok === true));
    if (exportClicked) {
      try { machine.markExportSubmitted({ gates, record: (r && r.record) || null }); } catch (_) { /* 标记失败也继续 fail-closed */ }
    }
    if (!r || !r.ok) {
      return {
        ok: false, submitted: exportClicked, uncertain: exportClicked,
        stage: (r && r.stage) || 'submit_export',
        reason: (r && r.reason) || 'unknown',
        host_error: (r && r.host_error) || null,
        detail: (r && r.detail) || null,
        // 失败路径同样透传"confirm 实际点击次数"（0=未点击/1=单次点击；绝不 >1）
        confirm_click_calls: Number((r && r.confirm_click_calls) || 0),
      };
    }
    return { ok: true, submitted: true, uncertain: false, stage: r.stage || 'export_dialog_confirm', reason: null,
      dialog: r.dialog_text || null, confirm_click_calls: Number(r.confirm_click_calls) || 0,
      confirmation_mode: (r && r.confirmation_mode) || null };
  }

  async function pollDownloadRows({ taskStartedAt, applicant }) {
    const deadline = Date.now() + wait.maxWaitMs;
    await sleep(wait.initialWaitMs);
    for (;;) {
      calls.poll += 1;
      const fixture = await call('readDownloadRows', { ctx });
      const sel = M.selectTargetRow(fixture, { businessDate: ctx.businessDate, taskStartedAt, applicant, reportName });
      if (sel.outcome === 'ready') return sel;
      if (sel.outcome === 'fail') return sel;
      if (Date.now() >= deadline) {
        return { outcome: 'fail', reason: `轮询超时（上限 ${Math.round(wait.maxWaitMs / 1000)}s，已轮询 ${calls.poll} 次）：${sel.reason}` };
      }
      await sleep(wait.pollIntervalMs);
    }
  }

  /**
   * @param {{applicant?:string, resumeExisting?:boolean}} opts
   *   resumeExisting=true：调用方**显式**要求复用"已提交过导出"的既有运行。
   *   只允许从终态 FAILED 恢复到 WAITING_EXPORT 继续轮询既有导出；
   *   绝不提交新导出（仍受 canSubmitExport / export_submitted_at 永久阻断）。
   */
  async function run({ applicant, resumeExisting, retryPreExport } = {}) {
    const summary = {
      task_id: ctx.taskId, report_type: ctx.reportType, business_date: ctx.businessDate,
      result: null, phases: [], export_submitted_at: null, exportSubmitCalls: 0,
      download_calls: 0, delete_calls: 0, poll_counts: 0, approvals_reset: false,
      imported: false, pushed: false, timer_created: false,
      // 失败阶段/原因（脱敏透传；成功路径保持 null）
      failure_stage: null, failure_reason: null, export_submitted_uncertain: false, confirm_click_calls: 0,
      // 导出反馈模式：dialog_confirmed（按钮单击）/ async_notice_observed（异步通知可见但无安全按钮）/
      // absent_direct_download（未见确认按钮或异步通知；继续观察，不等于已确认直下）
      confirmation_mode: null,
    };
    let approvalsTurnedOn = false;
    const downloadClickAlreadyAttempted = !!(machine.state.irreversible && machine.state.irreversible.download_click_attempted);
    try {
      if (retryPreExport === true) {
        if (ctx.reportType !== 'item_sales_detail' || resumeExisting === true)
          throw new Error('PRE_EXPORT_RESTART_REPORT_NOT_ALLOWED');
        machine.restartBeforeExport('manual_report_b_pre_export_retry');
      }
      // 断点恢复：已提交过导出 → 只做轮询
      const rp = SM.resumePoint(machine.state);
      summary.resume = rp;

      // 第二道保护：调用方误把续跑开关用于全新任务时，也绝不能提交新导出。
      if (resumeExisting === true && machine.state.phase === 'PENDING') {
        throw new Error('RESUME_EXISTING_EXPORT_NOT_FOUND');
      }

      if (machine.state.phase === 'PENDING') {
        machine.transition('PRECHECK');
        const pc = await call('precheck', { ctx });
        summary.phases.push({ phase: 'PRECHECK', ok: !!(pc && pc.ok), detail: (pc && pc.detail) || null });
        if (!pc || !pc.ok) { machine.fail(`前置校验未通过：${(pc && pc.reason) || '未知'}`); throw new Error('PRECHECK_FAILED'); }
        machine.transition('PRECHECK_OK');

        // 下载清单探测只包含受控的只读导航/读取，但 host 仍要求 download_list
        // 这一项授权。必须先于 probe 打开；导出与实际下载授权仍严格等到查询成功后。
        if (typeof adapters.setApprovals === 'function') {
          await adapters.setApprovals({ export_submit: false, download_list: true, download_file: false, task_id: ctx.taskId });
          approvalsTurnedOn = true;
          calls.approvalsOn += 1;
        }

        const dlp = await call('probeDownloadList', { ctx });
        summary.phases.push({ phase: 'DOWNLOAD_LIST_PROBE', ok: !!(dlp && dlp.ok), detail: (dlp && dlp.detail) || null });
        if (!dlp || !dlp.ok) { machine.fail('下载清单探测未通过（不提交导出）'); throw new Error('PROBE_FAILED'); }

        const nav = await call('navigateAndQuery', { ctx });
        // 本次运行实际声明的有效门店数（动态期望值来源）；只在运行结果里透传，绝不写回冻结的 ctx
        summary.declared_dynamic = (nav && Number.isFinite(Number(nav.declared_dynamic))) ? Number(nav.declared_dynamic) : null;
        summary.phases.push({ phase: 'QUERY', ok: !!(nav && nav.ok), detail: (nav && (nav.declared_dynamic || nav.declared_count)) || null });
        if (!nav || !nav.ok) { machine.fail(`查询校验未通过：${(nav && nav.reason) || '未知'}`); throw new Error('QUERY_FAILED'); }
        machine.transition('QUERY_DONE');

        // 仅此一处可开启授权，且仅三项
        if (typeof adapters.setApprovals === 'function') {
          await adapters.setApprovals({ export_submit: true, download_list: true, download_file: true, task_id: ctx.taskId });
          approvalsTurnedOn = true;
          calls.approvalsOn += 1;
        }
        await snap('10', 'before-export');
        const sub = await submitExportOnce({ precheckOk: true, queryOk: true, downloadListProbed: true });
        if (!sub.ok) {
          // 失败阶段/原因透传（脱敏后由 production-sync-runner → workflow-run → CLI 逐层保留，
          // 不再只留笼统的 download_failed）
          summary.failure_stage = sub.stage || null;
          summary.failure_reason = sub.reason || null;
          summary.export_submitted_uncertain = sub.uncertain === true;
          summary.confirm_click_calls = Number(sub.confirm_click_calls) || 0;
          machine.fail(`导出提交失败（stage=${sub.stage || 'n/a'}，reason=${sub.reason || 'n/a'}）`,
            { failure_stage: sub.stage || null, failure_reason: sub.reason || null });
          throw new Error(sub.uncertain ? 'EXPORT_SUBMIT_UNCERTAIN' : 'EXPORT_GATE_REFUSED');
        }
        summary.confirmation_mode = sub.confirmation_mode || null;
        summary.phases.push({ phase: 'EXPORT_SUBMITTED', ok: true, detail: sub.dialog });
        await snap('11', 'export-submitted');
      } else if (rp.mustNotSubmitExport) {
        summary.phases.push({ phase: 'RESUME', ok: true, detail: rp.reason });
      }

      // ===== 先观察被动下载；超时后按平台异步流程到下载清单取件 =====
      // 清单取件须唯一匹配且持久化点击意图；再次续跑只观察文件，不重复点击。
      const alreadyReady = machine.state.phase === 'EXPORT_READY';
      // 显式续跑：仅当调用方要求、且确实处于终态、且已提交过导出时，才允许恢复到 WAITING_EXPORT 继续轮询。
      // 未显式要求时：处于终态一律明确拒绝（保留补丁前"终态不重跑"的语义，绝不静默继续）。
      const resumingFromTerminal = resumeExisting === true
        && rp.mustNotSubmitExport === true
        && SM.isTerminal(machine.state.phase);
      if (resumingFromTerminal) {
        machine.transition('WAITING_EXPORT');
        summary.resumed_from_terminal = true;
        summary.resume = Object.assign({}, rp, { resumed_from_terminal: true });
        // 【修正】终态续跑跳过 PENDING 段 ⇒ 授权不会按任务开启。续跑仍需
        //   download_list（清单导航）与 download_file（该行下载）；
        //   **绝不**开启 export_submit（结构上不可能提交新导出）。
        //   必须绑定 ctx.taskId；finally 中的 resetApprovals 会无条件复原，不依赖残留授权。
        if (typeof adapters.setApprovals === 'function') {
          await adapters.setApprovals({ export_submit: false, download_list: true, download_file: true, task_id: ctx.taskId });
          approvalsTurnedOn = true;
          calls.approvalsOn += 1;
          summary.approvals_opened_on_resume = { export_submit: false, download_list: true, download_file: true, task_id: ctx.taskId };
        }
      } else if (SM.isTerminal(machine.state.phase)) {
        throw new Error('RESUME_REQUIRED_FROM_TERMINAL:' + machine.state.phase);
      } else if (!alreadyReady) machine.transition('WAITING_EXPORT');
      const taskStartedAt = Date.parse(machine.state.created_at || machine.state.export_submitted_at);
      let pf = null;
      if (!alreadyReady) {
        const priorDownloaded = resumingFromTerminal
          ? [...(machine.state.history || [])].reverse().find(h => h.to === 'DOWNLOADED' && h.file && h.via !== 'archived')
          : null;
        pf = await call('waitForPassiveFile', {
          // 导出点击后确认探针可持续几十秒；直下文件可能先于“确认结束”落盘。
          // 起点必须是点击前记下的时间，而非延迟写入的提交标记。
          ctx, sinceMs: Date.parse((machine.state.export_evidence && machine.state.export_evidence.export_click_started_at)
            || ([...(machine.state.history || [])].reverse().find(h => h.to === 'QUERY_DONE') || {}).at
            || machine.state.export_submitted_at || machine.state.created_at),
          resumeArchived: !!priorDownloaded,
          priorDownloadedFile: priorDownloaded && priorDownloaded.file,
          priorDownloadedAt: priorDownloaded && priorDownloaded.at,
        });
        if (priorDownloaded && (!pf || pf.ok !== true)) {
          machine.fail('既有归档文件恢复失败；禁止重新点击下载或导出');
          throw new Error('RECORDED_ARCHIVE_RECOVERY_FAILED');
        }
        summary.passive_wait = { ok: !!(pf && pf.ok), file: (pf && pf.file) || null, elapsed_ms: (pf && pf.elapsed_ms) || null, reason: (pf && pf.reason) || null };
        if (pf && pf.reason === 'ambiguous_new_download_files') {
          summary.failure_stage = 'passive_download';
          summary.failure_reason = 'ambiguous_new_download_files';
          machine.fail('导出后出现多个新文件，无法安全认定目标文件',
            { failure_stage: summary.failure_stage, failure_reason: summary.failure_reason });
          throw new Error('AMBIGUOUS_NEW_DOWNLOAD_FILES');
        }
        // 【新增·异步受理路径】被动窗口内没有新文件 ⇒ 先按设计取件：
        //   下载清单唯一匹配 → 该行状态必须「导出完成」→ 点该行「下载」（purpose=download，受 approvals.download_file 约束）。
        //   全程**不点击导出、不再提交申请**；取件失败则保持原有 fail-closed 语义不变。
        let rl = null;
        if (!pf || !pf.ok) {
          if (machine.state.irreversible && machine.state.irreversible.download_click_attempted) {
            rl = { ok: false, reason: 'download_click_already_attempted_no_file', download_click_attempted: true };
          } else {
            try { rl = await call('retrieveFromDownloadList', { ctx, taskStartedAt, applicant,
              markDownloadClickAttempt: () => machine.markDownloadClickAttempt() }); }
            catch (e) { rl = { ok: false, reason: 'retrieve_exception:' + String((e && e.message) || e).slice(0, 80) }; }
          }
          if (!downloadClickAlreadyAttempted && machine.state.irreversible && machine.state.irreversible.download_click_attempted) {
            calls.download = 1;
            summary.download_calls = 1;
          }
          summary.list_retrieval = rl;
          if (rl && rl.ok === true && rl.file) { pf = { ok: true, file: rl.file, name: rl.suggested_name || null, via: 'download_list' }; }
        }
        if (!pf || !pf.ok) {
          // 兜底：只读观察下载清单（诊断用途，不点击任何按钮）
          let obs = null;
          try { obs = await call('observeDownloadList', { ctx, taskStartedAt, applicant }); } catch (e) { obs = { ok: false, error: e.message }; }
          summary.list_observation = obs;
          if (rl && rl.download_click_attempted === true) {
            summary.failure_stage = 'download_list';
            summary.failure_reason = rl.reason === 'download_file_not_landed'
              ? 'download_file_not_landed' : 'download_click_already_attempted_no_file';
            machine.fail('下载按钮已尝试但未找到完整文件；禁止再次点击下载',
              { failure_stage: summary.failure_stage, failure_reason: summary.failure_reason });
            throw new Error('DOWNLOAD_CLICK_ATTEMPTED_NO_FILE');
          }
          // v0.3.2：若站内确认弹窗本就不存在（absent_direct_download）且等待窗口内**也没有**
          // 新的完整文件，才返回专门的 fail-closed 码；有确认弹窗却等不到文件时保持既有语义。
          // 此处观察本身只读；此前的清单取件可能已尝试过一次下载按钮。
          if (summary.confirmation_mode === 'absent_direct_download') {
            summary.failure_stage = 'export_direct_download';
            summary.failure_reason = 'export_direct_download_not_observed';
            machine.fail(`未发现站内确认弹窗且未出现新的完整报表文件；清单只读观察：${obs && obs.detail ? obs.detail : (obs && obs.error) || 'n/a'}`,
              { failure_stage: 'export_direct_download', failure_reason: 'export_direct_download_not_observed', confirmation_mode: summary.confirmation_mode });
            throw new Error('EXPORT_DIRECT_DOWNLOAD_NOT_OBSERVED');
          }
          machine.fail(`未收到被动下载文件；清单只读观察：${obs && obs.detail ? obs.detail : (obs && obs.error) || 'n/a'}`);
          throw new Error('PASSIVE_DOWNLOAD_TIMEOUT');
        }
        machine.transition('EXPORT_READY');
      } else {
        summary.passive_wait = { ok: true, file: null, note: '从 EXPORT_READY 恢复' };
      }
      await snap('12', 'passive-file-received');

      const downloadVia = pf && pf.via === 'download_list' ? 'download_list'
        : pf && pf.via === 'archived' ? 'archived' : 'passive_download';
      machine.transition('DOWNLOADED', { via: downloadVia, file: (pf && pf.file) || null });
      if (downloadVia === 'download_list') calls.download = 1;
      summary.download_calls = downloadVia === 'download_list' ? 1 : 0;
      await snap('13', 'downloaded');

      const ar = await call('archive', { ctx, file: (pf && pf.file) || summary.passive_wait.file,
        suggestedName: (pf && pf.name) || null, recoveredArchive: downloadVia === 'archived' });
      if (!ar || !ar.ok) { machine.fail(`归档失败：${(ar && ar.reason) || '未知'}`); throw new Error('ARCHIVE_FAILED'); }
      summary.archived = { path: ar.archived_path, name: ar.archived_name, size: ar.size, sha256: ar.sha256, overwrite_avoided: !!ar.overwrite_avoided };

      const v = await call('validateFile', { ctx, file: ar.archived_path });
      summary.validation = {
        ok: !!(v && v.ok), checks: (v && v.checks) || null, errors: (v && v.errors) || null,
        amount_evidence: (v && v.amount_evidence) || null,
        store_count: v && v.store_count != null && Number.isFinite(Number(v.store_count)) ? Number(v.store_count) : null,
        report_type: v && v.report_type || null,
        business_date: v && v.business_date || null,
        source_rows: v && v.source_rows != null && Number.isFinite(Number(v.source_rows)) ? Number(v.source_rows) : null,
        order_count: v && v.order_count != null && Number.isFinite(Number(v.order_count)) ? Number(v.order_count) : null,
        amounts: (v && v.amounts) || null,
        metadata_checks: (v && v.metadata_checks) || null,
        header_columns: v && v.header_columns || null,
        declared_dynamic: v && v.declared_dynamic_used != null && Number.isFinite(Number(v.declared_dynamic_used)) ? Number(v.declared_dynamic_used) : null,
        data_row_count: v && v.data_row_count != null && Number.isFinite(Number(v.data_row_count)) ? Number(v.data_row_count) : null,
        absent_stores: (v && v.absent_stores) || null,
        absent_status: (v && v.absent_status) || null,
      };
      if (!v || !v.ok) { machine.fail(`文件校验失败：${JSON.stringify((v && v.errors) || [])}`); throw new Error('VALIDATE_FAILED'); }
      if (ctx.reportType === 'item_sales_detail' && v.effective_file) {
        summary.archived = { path: v.effective_file, name: require('path').basename(v.effective_file),
          size: v.effective_size, sha256: v.effective_sha256, overwrite_avoided: true,
          derived_from: ar.archived_path, exception: v.exception_evidence || null };
      }
      machine.transition('FILE_VALIDATED');

      machine.transition('STOPPED', { reason: '流程完成，未执行导入/推送' });
      summary.result = 'FILE_VALIDATED';
      summary.ok = true;
    } catch (e) {
      if (!SM.isTerminal(machine.state.phase)) machine.fail(`编排中止：${e.message}`);
      await snap('99', 'failure');
      summary.result = machine.state.phase;
      summary.ok = false;
      summary.error = e.message;
    } finally {
      // 无条件复位三项授权（即使抛错、即使已提交过导出）
      try {
        if (typeof adapters.resetApprovals === 'function') {
          await adapters.resetApprovals({ export_submit: false, download_list: false, download_file: false });
          calls.approvalsReset += 1;
        }
        summary.approvals_reset = true;
      } catch (e2) {
        summary.approvals_reset = false;
        summary.approvals_reset_error = e2.message;
      }
    }
    summary.export_submitted_at = machine.state.export_submitted_at || null;
    summary.exportSubmitCalls = calls.exportSubmit;
    summary.delete_calls = calls.delete;
    summary.phases_final = machine.state.phase;
    summary.history = machine.state.history;
    return summary;
  }

  return { run, state: () => machine.state, calls, submitExportOnce, pollDownloadRows };
}

module.exports = { createOrchestrator, ALLOWED_ADAPTERS, FORBIDDEN_ADAPTERS, DEFAULTS };
