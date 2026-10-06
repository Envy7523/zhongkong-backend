'use strict';
/**
 * 阶段2：选择器注册表装载与校验
 *
 * 策略（对应人工批准的「选择器现场采集 + 逐项核对」）：
 *  - 选择器只由**现场采集**生成（`config/selectors.json`），代码里不得散落选择器、不得写死猜测值；
 *  - `precheck` 要求必需项**存在**；`verified:false` 时给出醒目警告但仍允许 dry-run（dry-run 不提交导出申请）；
 *  - **真实运行（提交导出申请）**要求所有必需项 `verified:true`（由人工逐项核对后置位）。
 */
const fs = require('fs');
const path = require('path');
const P = require('../paths');

const FILE = path.join(P.config, 'selectors.json');

/** 阶段2 必需的选择器键（dry-run 用） */
const REQUIRED_DRY_RUN = [
  'nav.report_center',
  'nav.business_report',
  'report.query_scheme_area',
  'filter.panel',
  'filter.date_start',
  'filter.date_end',
  'action.query',
  'action.export_button',
];

/** 真实运行额外必需（提交导出申请、下载） */
const REQUIRED_REAL_RUN = [
  'export.dialog_confirm_text_anchor',
  'export.goto_download_list',
  'download_list.table',
  'download_list.refresh',
  'download_list.row_action_download',
];

/** 本轮明确延后采集（未获批准前不得访问下载清单页） */
const DEFERRED_KEYS = REQUIRED_REAL_RUN;

function load() {
  if (!fs.existsSync(FILE)) return { exists: false, file: FILE, selectors: {}, meta: null };
  const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  return { exists: true, file: FILE, selectors: j.selectors || {}, meta: j };
}

function get(sel, key) {
  const e = sel.selectors[key];
  if (!e || !e.chosen) return null;
  return e.chosen;
}

/**
 * @param {{forRealRun?:boolean}} opts
 * @returns {{ok:boolean, errors:string[], warnings:string[], missing:string[], unverified:string[]}}
 */
function validate(opts = {}) {
  const s = load();
  const errors = [];
  const warnings = [];
  const missing = [];
  const unverified = [];
  if (!s.exists) {
    errors.push(`选择器注册表不存在：${s.file}（请先执行 syncbot selectors collect）`);
    return { ok: false, errors, warnings, missing, unverified, file: s.file };
  }
  const need = [...REQUIRED_DRY_RUN, ...(opts.forRealRun ? REQUIRED_REAL_RUN : [])];
  for (const k of need) {
    const e = s.selectors[k];
    if (!e || !e.chosen) {
      if (DEFERRED_KEYS.includes(k) && !opts.forRealRun) continue;
      missing.push(k);
      continue;
    }
    if (e.verified !== true) unverified.push(k);
  }
  if (missing.length) errors.push(`缺少必需选择器：${missing.join(', ')}`);
  if (unverified.length) {
    if (opts.forRealRun) errors.push(`以下选择器尚未经人工核对（verified!=true），禁止真实运行：${unverified.join(', ')}`);
    else warnings.push(`以下选择器尚未经人工核对（verified!=true），dry-run 允许但需人工在本次输出中逐项确认：${unverified.join(', ')}`);
  }
  return { ok: errors.length === 0, errors, warnings, missing, unverified, file: s.file, meta: s.meta };
}

/**
 * 人工核对：把指定键（或全部）标为 verified。
 * @param {string[]|null} keys
 */
function markVerified(keys, by = 'human', note = '') {
  const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const at = new Date().toISOString();
  const list = keys && keys.length ? keys : Object.keys(j.selectors || {});
  let n = 0;
  for (const k of list) {
    const e = (j.selectors || {})[k];
    if (!e) continue;
    e.verified = true;
    e.verified_at = at;
    e.verified_by = by;
    if (note) e.verify_note = note;
    n += 1;
  }
  j.updated_at = at;
  j.verified_count = Object.values(j.selectors || {}).filter((e) => e.verified === true).length;
  fs.writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n');
  return { updated: n, file: FILE, verified_count: j.verified_count };
}

function summary() {
  const s = load();
  const rows = Object.entries(s.selectors).map(([k, e]) => ({
    key: k,
    page: e.page || null,
    text_basis: e.text_basis || null,
    chosen: e.chosen || null,
    candidates: (e.candidates || []).length,
    verified: e.verified === true,
    deferred: e.deferred === true,
    unique: e.chosen_unique === true,
  }));
  return { file: s.file, exists: s.exists, count: rows.length, verified: rows.filter((r) => r.verified).length, rows };
}

module.exports = { FILE, REQUIRED_DRY_RUN, REQUIRED_REAL_RUN, DEFERRED_KEYS, load, get, validate, markVerified, summary };
