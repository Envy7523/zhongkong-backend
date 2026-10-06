'use strict';
/**
 * 真实下载流程的可恢复状态机（**纯逻辑 + 显式注入的持久化读写**，便于离线测试）
 *
 * 状态：PRECHECK → QUERY_DONE → EXPORT_SUBMITTED → WAITING_EXPORT → EXPORT_READY
 *       → DOWNLOADED → FILE_VALIDATED → STOPPED / FAILED
 *
 * 不可逆动作：提交导出（export_submit）。硬规则：
 *  - 仅在 PRECHECK、查询校验、下载清单探测三者都通过后才允许；
 *  - state.export_submitted_at 必须为空才允许提交；
 *  - 已提交标记存在时，恢复只能进入 WAITING_EXPORT 轮询，绝不再次提交；
 *  - 任何异常 → FAILED + 复位 approvals，绝不自动重试提交导出。
 */

const STATES = [
  'PENDING',
  'PRECHECK',
  'PRECHECK_OK',
  'QUERY_DONE',
  'EXPORT_SUBMITTED',
  'WAITING_EXPORT',
  'EXPORT_READY',
  'DOWNLOADED',
  'FILE_VALIDATED',
  'STOPPED',
  'FAILED',
];

/** 允许的迁移 */
const ALLOWED = {
  PENDING: ['PRECHECK', 'FAILED', 'STOPPED'],
  PRECHECK: ['PRECHECK_OK', 'FAILED', 'STOPPED'],
  PRECHECK_OK: ['QUERY_DONE', 'FAILED', 'STOPPED'],
  QUERY_DONE: ['EXPORT_SUBMITTED', 'FAILED', 'STOPPED'],
  EXPORT_SUBMITTED: ['WAITING_EXPORT', 'FAILED', 'STOPPED'],
  WAITING_EXPORT: ['EXPORT_READY', 'FAILED', 'STOPPED'],
  EXPORT_READY: ['DOWNLOADED', 'FAILED', 'STOPPED'],
  DOWNLOADED: ['FILE_VALIDATED', 'FAILED', 'STOPPED'],
  FILE_VALIDATED: ['STOPPED', 'FAILED'],
  // FAILED → WAITING_EXPORT：**仅**用于「显式复用既有导出」的续跑（opts.resumeExisting）。
  // 语义同 EXPORT_SUBMITTED → WAITING_EXPORT（继续轮询既有那一次导出）；
  // canSubmitExport 仍因 export_submitted_at 非空而永久禁止二次提交导出。
  FAILED: ['STOPPED', 'WAITING_EXPORT'],
  STOPPED: [],
};

const TERMINAL = ['FILE_VALIDATED', 'FAILED', 'STOPPED'];

function isTerminal(s) { return TERMINAL.includes(s); }

function canTransition(from, to) {
  if (!STATES.includes(to)) return { ok: false, reason: `未知状态：${to}` };
  if (from === to) return { ok: true, reason: 'noop' };
  const allowed = ALLOWED[from] || [];
  if (!allowed.includes(to)) return { ok: false, reason: `不允许的迁移：${from} → ${to}（允许：${allowed.join('/') || '无'}）` };
  return { ok: true };
}

/** 是否允许提交导出（不可逆动作的唯一闸门） */
function canSubmitExport(state, { precheckOk, queryOk, downloadListProbed } = {}) {
  if (!state) return { ok: false, reason: '缺少任务状态' };
  if (state.export_submitted_at) return { ok: false, reason: `导出已提交于 ${state.export_submitted_at}，禁止二次提交（不可逆）` };
  if (state.phase !== 'QUERY_DONE') return { ok: false, reason: `当前状态 ${state.phase} 不允许提交导出（需 QUERY_DONE）` };
  if (!precheckOk) return { ok: false, reason: '前置校验未通过，禁止提交导出' };
  if (!queryOk) return { ok: false, reason: '查询校验未通过，禁止提交导出' };
  if (!downloadListProbed) return { ok: false, reason: '下载清单探测未通过，禁止提交导出' };
  return { ok: true, reason: '允许提交导出（唯一一次）' };
}

/** 恢复判定：进程中断后重跑时决定从哪继续 */
function resumePoint(state) {
  if (!state) return { resume: 'PENDING', mustNotSubmitExport: false, reason: '无状态，全新开始' };
  if (state.export_submitted_at || ['EXPORT_SUBMITTED', 'WAITING_EXPORT', 'EXPORT_READY'].includes(state.phase)) {
    const phase = state.phase === 'EXPORT_READY' ? 'EXPORT_READY' : 'WAITING_EXPORT';
    return {
      resume: phase,
      mustNotSubmitExport: true,
      reason: `检测到已提交导出标记（export_submitted_at=${state.export_submitted_at || 'phase 标记'}）：只能从下载清单恢复轮询，绝不再次提交`,
    };
  }
  if (['DOWNLOADED', 'FILE_VALIDATED', 'STOPPED', 'FAILED'].includes(state.phase)) {
    return { resume: state.phase, mustNotSubmitExport: true, reason: `已处于终态 ${state.phase}，不重跑` };
  }
  return { resume: state.phase, mustNotSubmitExport: false, reason: `从 ${state.phase} 继续（尚未提交导出）` };
}

/**
 * 状态机实例：所有读写经注入的 store（离线测试用内存 store，生产用 task-state）
 * @param {{load:Function, save:Function, now:Function}} deps
 */
function createMachine({ load, save, now = () => new Date().toISOString() }) {
  let state = load() || {
    phase: 'PENDING',
    export_submitted_at: null,
    irreversible: { export_submit: false, download_click_attempted: false },
    history: [],
    screenshots: [],
    created_at: now(),
    updated_at: now(),
  };
  function persist() { state.updated_at = now(); save(state); return state; }
  function transition(to, detail = {}) {
    const chk = canTransition(state.phase, to);
    if (!chk.ok) throw new Error(chk.reason);
    if (state.phase === 'FAILED' && to === 'WAITING_EXPORT' && !state.export_submitted_at) {
      throw new Error('缺少既有导出提交标记，禁止从 FAILED 续跑');
    }
    const from = state.phase;
    state.phase = to;
    state.history.push({ from, to, at: now(), ...detail });
    return persist();
  }
  return {
    get state() { return state; },
    transition,
    /** 仅人工显式允许：失败发生在任何导出/下载点击之前，保留旧证据并重新预检。 */
    restartBeforeExport(reason) {
      const history = Array.isArray(state.history) ? state.history : [];
      if (state.phase !== 'FAILED' || state.export_submitted_at
        || (state.irreversible && (state.irreversible.export_submit || state.irreversible.download_click_attempted))
        || history.some(h => ['EXPORT_SUBMITTED', 'WAITING_EXPORT', 'EXPORT_READY', 'DOWNLOADED', 'FILE_VALIDATED'].includes(h.to)))
        throw new Error('PRE_EXPORT_RESTART_NOT_SAFE');
      const at = now();
      if (state.failure) {
        if (!Array.isArray(state.prior_failures)) state.prior_failures = [];
        state.prior_failures.push(state.failure);
        state.failure = null;
      }
      state.phase = 'PENDING';
      state.history.push({ from: 'FAILED', to: 'PENDING', at, action: 'explicit_pre_export_restart', reason: String(reason || '').slice(0, 120) });
      return persist();
    },
    /** 标记不可逆动作：提交导出 */
    markExportSubmitted(evidence = {}) {
      const chk = canSubmitExport(state, evidence.gates || {});
      if (!chk.ok) throw new Error(chk.reason);
      if (state.irreversible.export_submit) throw new Error('导出提交标记已存在，禁止二次提交');
      state.irreversible.export_submit = true;
      state.export_submitted_at = now();
      state.export_evidence = evidence.record || null;
      transition('EXPORT_SUBMITTED', { action: 'export_submit', irreversible: true });
      return state;
    },
    /** 下载按钮也只能尝试一次：先持久化意图，再向宿主下发点击。 */
    markDownloadClickAttempt() {
      if (state.phase !== 'WAITING_EXPORT') throw new Error('下载点击只允许在 WAITING_EXPORT');
      if (!state.export_submitted_at) throw new Error('缺少既有导出提交标记，禁止下载点击');
      state.irreversible = state.irreversible || {};
      if (state.irreversible.download_click_attempted) throw new Error('下载点击已尝试，禁止再次点击');
      state.irreversible.download_click_attempted = true;
      state.download_click_attempted_at = now();
      return persist();
    },
    addScreenshot(s) {
      if (!Array.isArray(state.screenshots)) state.screenshots = [];
      state.screenshots.push(s);
      return persist();
    },
    fail(reason, extra = {}) {
      if (isTerminal(state.phase)) return persist();
      state.failure = { at: now(), reason, ...extra };
      state.phase = 'FAILED';
      state.history.push({ from: state.history.length ? state.history[state.history.length - 1].to : 'PENDING', to: 'FAILED', at: now(), reason });
      return persist();
    },
    stop(reason) {
      state.stopped = { at: now(), reason };
      state.phase = 'STOPPED';
      return persist();
    },
  };
}

module.exports = { STATES, ALLOWED, TERMINAL, isTerminal, canTransition, canSubmitExport, resumePoint, createMachine };
