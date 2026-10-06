'use strict';
/**
 * 编排状态机 phase → 审计阶段(STAGE) 的**单一映射**（13 阶段全覆盖）
 *
 * 为什么单独一个模块：13 个阶段并不都由"下载编排器"发出 —— 导入/推送阶段属于后续步骤。
 * 这里把映射集中一处，避免各调用点各写一份、逐渐漂移。
 *
 * 关键约束：
 *  - 纯映射函数，不做 I/O，便于离线穷举测试；
 *  - FAILED / WAITING_HUMAN **不授权任何业务动作**（不触发导入、不触发推送）——
 *    由 allowedBusinessActions() 明确表达，而不是靠调用方自觉。
 */
const { STAGES } = require('./audit-outbox');

/** 下载编排器（real-download.js）phase → STAGE；null = 该中间态不发事件 */
const PHASE_TO_STAGE = {
  PENDING: null,
  PRECHECK: 'PRECHECK',
  PRECHECK_OK: null,
  DOWNLOAD_LIST_PROBE: null,
  QUERY: 'QUERY_DONE',
  QUERY_DONE: 'QUERY_DONE',
  EXPORT_SUBMITTED: 'EXPORT_SUBMITTED',
  WAITING_EXPORT: 'WAITING_EXPORT',
  EXPORT_READY: null,
  DOWNLOADED: 'DOWNLOADED',
  FILE_VALIDATED: 'FILE_VALIDATED',
  STOPPED: null,
  FAILED: 'FAILED',
};

/** 导入/推送/等待人工 —— 由后续步骤显式发出，不由下载编排器发出 */
const STEP_STAGE = {
  import_start: 'IMPORT_STARTED',
  import_ok: 'IMPORT_SUCCEEDED',
  import_fail: 'IMPORT_FAILED',
  push_ok: 'PUSH_SUCCEEDED',
  push_fail: 'PUSH_FAILED',
  waiting_human: 'WAITING_HUMAN',
};

/** 终态/异常态一律不授权任何后续业务动作 */
const NO_BUSINESS_ACTION_STAGES = new Set(['FAILED', 'WAITING_HUMAN']);

function stageForPhase(phase) {
  return Object.prototype.hasOwnProperty.call(PHASE_TO_STAGE, phase) ? PHASE_TO_STAGE[phase] : null;
}
function stageForStep(kind) {
  return STEP_STAGE[kind] || null;
}
/** 该阶段是否允许触发导入/推送等业务动作 */
function allowedBusinessActions(stage) {
  return NO_BUSINESS_ACTION_STAGES.has(stage) ? [] : null; // null = 未受限
}
function isNeverBusinessAction(stage) {
  return NO_BUSINESS_ACTION_STAGES.has(stage);
}
/** 映射覆盖自检：13 个阶段是否都能被某个来源产生 */
function coverage() {
  const produced = new Set(Object.values(PHASE_TO_STAGE).filter(Boolean).concat(Object.values(STEP_STAGE)));
  const missing = STAGES.filter((s) => !produced.has(s));
  const extra = Array.from(produced).filter((s) => !STAGES.includes(s));
  return { total: STAGES.length, produced: produced.size, missing, extra, ok: missing.length === 0 && extra.length === 0 };
}

/** 按 phase 发事件（不发则视为成功跳过，绝不影响业务流程）；opts 必须透传（密钥路径/超时/测试标记） */
async function emitForPhase({ outbox, ctx, phase, seq, metrics, opts = {} }) {
  const stage = stageForPhase(phase);
  if (!stage) return { ok: true, skipped: true, phase };
  return outbox.emit({ ctx, stage, seq, metrics, opts });
}
/** 导入 / 推送 / 等待人工 专用 */
async function emitForStep({ outbox, ctx, kind, seq, metrics, opts = {} }) {
  const stage = stageForStep(kind);
  if (!stage) return { ok: false, queued: false, reason: `unknown_step_kind:${kind}` };
  return outbox.emit({ ctx, stage, seq, metrics, opts });
}

module.exports = {
  PHASE_TO_STAGE, STEP_STAGE, NO_BUSINESS_ACTION_STAGES,
  stageForPhase, stageForStep, allowedBusinessActions, isNeverBusinessAction, coverage,
  emitForPhase, emitForStep,
};
