#!/usr/bin/env node
'use strict';

/**
 * A 表人工一次性入口（薄包装）。
 *
 * 这个文件只负责严格解析参数、输出脱敏计划并调用唯一的 data-runner。
 * 下载、归档、校验、闸门、导入、锁和恢复逻辑均不得出现在此处。
 */
const RUNNER = require('../src/phase3/production-sync-runner.js');

const REPORT_TYPE = 'cashier_composite';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value) {
  if (!DATE_RE.test(String(value || ''))) return false;
  const [y, m, d] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  let date = null;
  let reportType = REPORT_TYPE;
  let confirm = false;
  let resumeExisting = false;
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const raw = String(args[i]);
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(raw);
    if (!match) return { ok: false, reason: 'unexpected_argument' };
    const name = match[1];
    let value = match[2];
    if (seen.has(name)) return { ok: false, reason: 'duplicate_flag:' + name };
    seen.add(name);
    if (name === 'confirm') {
      if (value !== undefined) return { ok: false, reason: 'flag_takes_no_value:confirm' };
      confirm = true;
      continue;
    }
    if (name === 'resume-existing') {
      if (value !== undefined) return { ok: false, reason: 'flag_takes_no_value:resume-existing' };
      resumeExisting = true;
      continue;
    }
    if (name !== 'date' && name !== 'report-type') return { ok: false, reason: 'unknown_flag:' + name };
    if (value === undefined) value = args[++i];
    if (value === undefined || String(value).trim() === '') return { ok: false, reason: 'flag_requires_value:' + name };
    if (name === 'date') date = String(value);
    else reportType = String(value);
  }
  if (!confirm) return { ok: false, reason: 'confirm_required' };
  if (!date) return { ok: false, reason: 'date_required' };
  if (!validDate(date)) return { ok: false, reason: 'business_date_invalid' };
  if (reportType !== REPORT_TYPE) return { ok: false, reason: reportType === 'item_sales_detail' ? 'report_b_locked' : 'report_type_not_allowed' };
  return { ok: true, businessDate: date, reportType, confirm, resumeExisting };
}

function plan(parsed, runner) {
  return {
    ok: true,
    mode: 'manual-cli',
    trigger: 'manual-cli',
    report_type: parsed.reportType,
    business_date: parsed.businessDate,
    runner_source: String((runner && runner.source) || 'unknown').replace(/[\\/][^\\/]+/g, '[module]'),
    stages: ['download', 'archive', 'validate', 'g1_g3', 'import', 'audit'],
    data_only: true,
    resume_existing: parsed.resumeExisting === true,
  };
}

async function runCli(argv, options = {}) {
  const out = options.out || ((line) => console.log(line));
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    const payload = { ok: false, mode: 'manual-cli', exit_code: 2, reason: parsed.reason, side_effects: false };
    out(JSON.stringify(payload));
    return { exitCode: 2, payload };
  }
  const factory = options.runnerFactory || RUNNER.createRunner;
  let runner;
  try {
    runner = factory({ reportType: REPORT_TYPE, platform: 'meituan', deps: options.deps || {}, env: options.env || process.env, logger: options.logger || null });
  } catch (_) {
    const payload = { ok: false, mode: 'manual-cli', exit_code: 3, reason: 'runner_factory_failed', side_effects: false };
    out(JSON.stringify(payload));
    return { exitCode: 3, payload };
  }
  if (!runner || typeof runner.runOnce !== 'function' || runner.data_only !== true || runner.report_type !== REPORT_TYPE) {
    const payload = { ok: false, mode: 'manual-cli', exit_code: 3, reason: 'runner_shape_invalid', side_effects: false };
    out(JSON.stringify(payload));
    return { exitCode: 3, payload };
  }
  out(JSON.stringify(plan(parsed, runner)));
  let result;
  try {
    result = await runner.runOnce({ businessDate: parsed.businessDate, reportType: REPORT_TYPE, trigger: 'manual-cli', resumeExisting: parsed.resumeExisting === true });
  } catch (_) {
    result = { ok: false, action: 'WAITING_HUMAN', reason: 'runner_threw', side_effects: true, push_calls: 0 };
  }
  const safe = {
    ok: result && result.ok === true,
    mode: 'manual-cli',
    trigger: 'manual-cli',
    report_type: REPORT_TYPE,
    business_date: parsed.businessDate,
    action: result && result.action ? String(result.action) : null,
    reason: result && result.reason ? String(result.reason).slice(0, 80) : 'runner_bad_result',
    side_effects: result && result.side_effects === true,
    stage_calls: (result && result.stage_calls) || { download: 0, import: 0 },
    push_calls: 0,
    // 失败阶段/原因（脱敏透传；成功路径为 null）——不得只输出笼统 download_failed
    failure_stage: (result && result.failure_stage) ? String(result.failure_stage).slice(0, 40) : null,
    failure_reason: (result && result.failure_reason) ? String(result.failure_reason).slice(0, 80) : null,
  };
  safe.exit_code = safe.ok ? 0 : 3;
  out(JSON.stringify(safe));
  return { exitCode: safe.exit_code, payload: safe };
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then((r) => process.exit(r.exitCode)).catch(() => process.exit(9));
}

module.exports = { REPORT_TYPE, validDate, parseArgs, plan, runCli };
