'use strict';
/**
 * 阶段2：任务状态机（与现有 state/tasks/meituan-<业务日期>.json 共存）
 *
 * 现有 state.js 负责 download/validate_file/import/validate_import/push 五段闸门；
 * 本模块在同一文件内新增 `phase2` 小节，记录阶段2 的状态机、步骤、导出申请标识与失败原因，
 * **不覆盖**既有键，保证阶段3 仍可复用同一文件。
 */
const fs = require('fs');
const path = require('path');
const P = require('../paths');
const state = require('../state');
const TC = require('../task-context');

const STATES = [
  'PENDING',
  'PRECHECK_OK',
  'NAVIGATING',
  'FILTERS_OK',
  'QUERY_OK',
  'DRY_RUN_DONE',
  'EXPORT_SUBMITTED',
  'WAITING_EXPORT',
  'EXPORT_READY',
  'REUSE_REQUEST',
  'DOWNLOADING',
  'DOWNLOADED',
  'ARCHIVED',
  'DONE',
];

/** report_type 必须显式传入（禁止推断） */
function fileFor(date, reportType) {
  const rt2 = TC.assertResidentReportType(reportType);
  return state.stateFile('meituan', date, rt2);
}

/** 该业务日期下所有 report_type 的状态文件（供 legacy 证据保留与跨报表只读查看） */
function legacyFileFor(date) {
  return path.join(P.tasks, `meituan-${date}.json`);
}

function read(date, reportType) {
  TC.assertResidentReportType(reportType);
  const st = state.read('meituan', date, reportType);
  if (!st.phase2) {
    st.phase2 = {
      state: 'PENDING',
      dry_run: false,
      attempt: 0,
      task_id: null,
      started_at: null,
      finished_at: null,
      steps: [],
      export_request: null,
      export_ready: null,
      download: null,
      failure: null,
      history: [],
    };
  }
  return st;
}

function write(date, st, reportType) {
  TC.assertResidentReportType(reportType);
  st.updated_at = new Date().toISOString();
  const file = fileFor(date, reportType);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

function begin(date, { task_id, dry_run, business_date }, reportType) {
  const st = read(date, reportType);
  st.phase2.state = 'PENDING';
  st.phase2.dry_run = !!dry_run;
  st.phase2.attempt = (st.phase2.attempt || 0) + 1;
  st.phase2.task_id = task_id;
  st.phase2.started_at = new Date().toISOString();
  st.phase2.finished_at = null;
  st.phase2.steps = [];
  st.phase2.failure = null;
  st.phase2.business_date = business_date || date;
  if (!dry_run) st.phase2.export_request = null;
  write(date, st, reportType);
  return st;
}

function setState(date, next, extra = {}, reportType) {
  if (!STATES.includes(next) && !/^FAILED_/.test(next)) {
    throw new Error(`非法状态：${next}`);
  }
  const st = read(date, reportType);
  const prev = st.phase2.state;
  st.phase2.state = next;
  st.phase2.history = st.phase2.history || [];
  st.phase2.history.push({ from: prev, to: next, at: new Date().toISOString(), ...extra });
  if (/^FAILED_/.test(next)) {
    st.phase2.failure = { state: next, at: new Date().toISOString(), ...extra };
    st.phase2.finished_at = new Date().toISOString();
  }
  if (['DONE', 'DRY_RUN_DONE'].includes(next)) st.phase2.finished_at = new Date().toISOString();
  write(date, st, reportType);
  return st;
}

function step(date, rec, reportType) {
  const st = read(date, reportType);
  st.phase2.steps.push({ at: new Date().toISOString(), ...rec });
  write(date, st, reportType);
  return st;
}

function patch(date, obj, reportType) {
  const st = read(date, reportType);
  Object.assign(st.phase2, obj);
  write(date, st, reportType);
  return st;
}

function fail(date, cause, detail = {}, reportType) {
  return setState(date, `FAILED_${cause}`, detail);
}

/**
 * 任务级绑定：显式传入 reportType 后返回一组已绑定该 report_type 的状态函数。
 * 目的：**不使用全局可变状态**；调用方必须显式给出 report_type。
 */
function forReport(reportType) {
  const rt2 = TC.assertResidentReportType(reportType);
  return {
    fileFor: (date) => fileFor(date, rt2),
    legacyFileFor,
    read: (date) => read(date, rt2),
    write: (date, st) => write(date, st, rt2),
    begin: (date, opts) => begin(date, opts, rt2),
    setState: (date, next, extra) => setState(date, next, extra, rt2),
    step: (date, rec) => step(date, rec, rt2),
    patch: (date, obj) => patch(date, obj, rt2),
    fail: (date, cause, detail) => fail(date, cause, detail, rt2),
    reportType: rt2,
  };
}

module.exports = { STATES, fileFor, legacyFileFor, read, write, begin, setState, step, patch, fail, forReport };
