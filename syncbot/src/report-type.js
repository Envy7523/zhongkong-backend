'use strict';
/**
 * 【已弃用】旧版 report_type 隐式上下文模块。
 *
 * 按需求（2026-09-18）要求：所有业务路径**不得**依赖全局可变状态 / 环境变量 / 隐式上下文。
 * report_type 必须由任务入口经 task-context.js 显式创建并逐层透传。
 *
 * 本文件仅保留为兼容占位：**任何调用都会立即抛出明确错误**，
 * 以便 grep 与自检能证明生产路径中不存在调用点。
 */
const P = require('./paths');

function deprecatedWhat() {
  return 'report-type.current()/set() 已弃用：report_type 必须由任务入口显式创建 TaskContext 并逐层透传（见 src/task-context.js）';
}

function current() {
  throw new Error(`${deprecatedWhat()} 调用点必须改为传入 ctx 或显式 reportType。`);
}

function set() {
  throw new Error(`${deprecatedWhat()} 不得使用「入口先 set、下层再读」的隐式传播。`);
}

function isAuthorized(reportType) {
  // 纯查询函数不涉及路径/文件，允许保留（用于报告展示与入口校验）
  const rt = P.assertReportType(reportType);
  return P.REPORT_TYPES[rt].authorized === true;
}

function assertAuthorized(reportType) {
  if (!reportType) throw new Error('assertAuthorized 必须显式传入 reportType');
  const rt = P.assertReportType(reportType);
  if (!isAuthorized(rt)) throw new Error(`report_type「${rt}」未授权（authorized=false / locked_not_started）：拒绝`);
  return rt;
}

module.exports = { current, set, isAuthorized, assertAuthorized, DEPRECATED: true };
