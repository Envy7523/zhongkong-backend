#!/usr/bin/env node
'use strict';
/**
 * 调度 tick CLI（契约第 5 节）
 *
 *   node app/bin/schedule-tick.js --once                跑一次 tick 后退出（供 systemd Type=oneshot 调用）
 *   node app/bin/schedule-tick.js --loop --interval=30  常驻循环（**本轮不启用**：需显式 SYNCBOT_SCHEDULE_LOOP_ENABLED=1）
 *   node app/bin/schedule-tick.js --status              只读打印当前配置/本地状态（不执行任何作业）
 *   node app/bin/schedule-tick.js --dry-run             只计算到期与闸门（不 claim / 不执行 / 不写任何状态）
 *
 * 退出码：0 = 正常；2 = 参数错；3 = 被拒 / fail-closed；9 = 内部错误。
 *
 * **本文件不创建任何 cron/timer**：无 setInterval、无 cron、不写 .timer；
 * --loop 仅用 setTimeout 睡眠（且本轮默认拒绝启用）。
 */
const path = require('path');
const WORKER = require('../src/schedule/worker.js');
const PLAN = require('../src/schedule/plan.js');
const SSTATE = require('../src/schedule/state.js');

const USAGE = [
  '用法: node app/bin/schedule-tick.js [模式] [选项]',
  '',
  '模式（默认 --once）：',
  '  --once                 跑一次 tick 后退出（systemd Type=oneshot 用）',
  '  --loop --interval=N    常驻循环（本轮不启用；需 SYNCBOT_SCHEDULE_LOOP_ENABLED=1 才允许）',
  '  --status               只读打印当前配置与本地状态（不 claim / 不执行 / 不写状态）',
  '  --dry-run              只计算到期与闸门（不 claim / 不执行 / 不写状态）',
  '',
  '选项：',
  '  --interval=N           循环间隔秒数（5-3600，默认 30）',
  '  --worker-id=NAME       覆盖 worker 标识（默认 syncbot-schedule@<host>#<pid>）',
  '  --now=YYYY-MM-DD HH:mm:ss   仅离线验收用：与 --dry-run/--status 搭配，模拟上海本地时间',
  '',
  '说明：本 CLI 不创建、不安装、不启用任何定时器（无系统定时单元、无常驻调度）；报表 B（item_sales_detail）永远锁定。',
].join('\n');

/** 严格解析参数：未知参数/重复参数/非法组合一律 exit 2 */
function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv.slice() : [];
  const seen = {};
  const modes = [];
  let interval = null;
  let workerId = null;
  let now = null;
  for (let i = 0; i < list.length; i++) {
    const raw = String(list[i]);
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(raw);
    if (!m) return { ok: false, reason: 'unexpected_argument' };
    const name = m[1];
    let value = m[2];
    if (seen[name] !== undefined) return { ok: false, reason: 'duplicate_flag:' + name };
    seen[name] = true;
    if (name === 'once' || name === 'loop' || name === 'status' || name === 'dry-run') {
      if (value !== undefined) return { ok: false, reason: 'flag_takes_no_value:' + name };
      modes.push(name);
      continue;
    }
    if (name === 'interval' || name === 'worker-id' || name === 'now') {
      if (value === undefined) { i += 1; value = list[i]; }
      if (value === undefined || String(value) === '') return { ok: false, reason: 'flag_requires_value:' + name };
      if (name === 'interval') {
        const n = Number(String(value));
        if (!Number.isInteger(n) || n < 5 || n > 3600) return { ok: false, reason: 'interval_invalid' };
        interval = n;
      } else if (name === 'worker-id') {
        workerId = String(value);
      } else {
        if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(String(value))) return { ok: false, reason: 'now_format_invalid' };
        now = String(value);
      }
      continue;
    }
    return { ok: false, reason: 'unknown_flag:' + name };
  }
  if (modes.length > 1) return { ok: false, reason: 'conflicting_modes:' + modes.join('+') };
  const mode = modes[0] || 'once';
  if (now !== null && mode !== 'dry-run' && mode !== 'status') return { ok: false, reason: 'now_only_with_dry_run_or_status' };
  if (mode === 'loop' && interval === null) interval = 30;
  if (mode !== 'loop' && seen.interval !== undefined) return { ok: false, reason: 'interval_only_with_loop' };
  return { ok: true, mode, interval, workerId, now };
}

/** 只读状态摘要（绝不包含绝对路径/密钥/签名） */
function localStateSummary() {
  return SSTATE.list().map((r) => ({
    job: r.job, business_date: r.business_date, status: r.status,
    attempt: r.attempt, reason: r.reason, updated_at: r.updated_at, worker_id: r.worker_id,
  }));
}

/** 睡眠（--loop 专用；**不使用 setInterval**，也不创建任何 cron） */
function sleep(ms) {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); });
}

function statusPayload({ env, now, workerId, deps = {} }) {
  const n = PLAN.resolveNow(now);
  const zkc = WORKER.resolveZkClient({ deps: Object.assign({ env }, deps), env });
  const payload = {
    ok: true, mode: 'status', read_only: true, executed_jobs: 0,
    worker_id: workerId || WORKER.defaultWorkerId(),
    timezone: PLAN.TIMEZONE, now_local: n.local,
    center: { base_allowed: zkc.ok === true, reachable: false, config: null, now_local: null, error: zkc.ok ? null : String(zkc.reason || 'base_not_allowed') },
    local: { files: localStateSummary() },
    note: '只读：不 claim、不执行、不写任何状态；不创建定时器',
  };
  if (!zkc.ok) return payload;
  return zkc.client.getSchedule().then((res) => {
    payload.center.reachable = res && res.ok === true;
    if (res && res.ok === true) {
      const cfg = (res.body && res.body.config) || {};
      payload.center.config = {
        sync_enabled: cfg.sync_enabled === true || cfg.sync_enabled === 1,
        sync_time: WORKER.safeText(cfg.sync_time, 5),
        report_enabled: cfg.report_enabled === true || cfg.report_enabled === 1,
        report_time: WORKER.safeText(cfg.report_time, 5),
        version: Number.isFinite(Number(cfg.version)) ? Number(cfg.version) : null,
      };
      payload.center.now_local = WORKER.safeText(res.body && res.body.now_local, 19);
    } else {
      payload.center.error = WORKER.sanitizeReason(res && res.reason) || 'schedule_read_failed';
    }
    return payload;
  });
}

/**
 * CLI 主流程（**可被离线套件直接调用**，与真实 CLI 完全同一条代码路径）。
 * @returns {Promise<{exitCode:number, payload:object}>}
 */
async function runCli(argv, { env = process.env, out = (s) => console.log(s), deps = {}, now = undefined } = {}) {
  const emit = (payload, exitCode) => {
    try { out(JSON.stringify(payload, null, 2)); } catch (_) {}
    return { exitCode, payload };
  };
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    try { out(USAGE); } catch (_) {}
    return emit({ ok: false, mode: 'cli', exit_code: 2, reason: parsed.reason, note: '参数错误：未触发任何作业、未发任何 HTTP' }, 2);
  }
  const workerId = parsed.workerId || deps.workerId || WORKER.defaultWorkerId();
  const useNow = (parsed.now !== null && parsed.now !== undefined) ? parsed.now : now;

  if (parsed.mode === 'status') {
    const payload = await statusPayload({ env, now: useNow, workerId, deps });
    return emit(payload, payload.ok ? 0 : 3);
  }

  if (parsed.mode === 'loop' && env.SYNCBOT_SCHEDULE_LOOP_ENABLED !== '1') {
    return emit({
      ok: false, mode: 'loop', exit_code: 3, reason: 'loop_disabled',
      note: '本轮不启用常驻循环：需人工设置 SYNCBOT_SCHEDULE_LOOP_ENABLED=1 才允许（本 CLI 不创建定时器）',
    }, 3);
  }

  const tickDeps = Object.assign({ env }, deps);
  if (parsed.mode === 'dry-run') tickDeps.dryRun = true;

  async function once(dryRun) {
    const result = await WORKER.tick({ now: useNow, deps: tickDeps, workerId });
    return result;
  }

  if (parsed.mode !== 'loop') {
    const result = await once(parsed.mode === 'dry-run');
    return emit(result, result.exit_code);
  }

  // --loop：本轮默认不可达（上面已拦），仅作为未来的显式启用入口；不使用 setInterval
  let rounds = 0;
  for (;;) {
    const result = await once(false);
    rounds += 1;
    try { out(JSON.stringify(Object.assign({ mode: 'loop', round: rounds }, result), null, 2)); } catch (_) {}
    if (result.exit_code === 9) return { exitCode: 9, payload: result };
    await sleep(parsed.interval * 1000);
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then((r) => process.exit(r.exitCode)).catch((e) => {
    try { console.log(JSON.stringify({ ok: false, mode: 'cli', exit_code: 9, reason: 'internal_error', internal: WORKER.safeText((e && e.message) || e, 120) }, null, 2)); } catch (_) {}
    process.exit(9);
  });
}

module.exports = { runCli, parseArgs, statusPayload, localStateSummary, sleep, USAGE };
