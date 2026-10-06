'use strict';
/**
 * TaskContext：任务上下文（双报表架构）
 *
 * 硬规则：
 *  - report_type 必须由**任务入口显式创建**，并逐层作为参数透传；
 *  - 禁止使用全局可变状态 / 环境变量 / 隐式上下文推断报表类型；
 *  - 未授权报表（item_sales_detail，authorized=false）在此即被拒绝，
 *    不得创建任务、锁、状态、下载目录、截图目录或归档元数据。
 */
const P = require('./paths');

/** 创建任务上下文（入口专用）。reportType 必填且必须已注册、已授权。 */
function createContext(reportType, { platform = 'meituan', taskId, businessDate } = {}) {
  if (!reportType) throw new Error('createContext 必须显式传入 reportType（禁止推断，禁止默认）');
  const rt = P.assertReportType(reportType);
  if (!P.REPORT_TYPES[rt].authorized) {
    throw new Error(`report_type「${rt}」未授权（authorized=false / locked_not_started）：禁止创建任务上下文、锁、状态、下载目录、截图目录或归档元数据`);
  }
  if (!taskId) throw new Error('createContext 必须显式传入 taskId');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate || ''))) throw new Error(`createContext 的业务日期非法：${businessDate}`);
  return Object.freeze({ reportType: rt, platform, taskId, businessDate: String(businessDate) });
}

/** 校验一个已存在的 context（穿透式校验；不接受裸字符串以外的隐式来源） */
function assertContext(ctx) {
  if (!ctx || typeof ctx !== 'object') throw new Error('缺少 TaskContext：必须由任务入口显式创建并逐层透传');
  const { reportType, platform, taskId, businessDate } = ctx;
  if (!reportType || !platform || !taskId || !businessDate) throw new Error('TaskContext 字段不完整：需要 { reportType, platform, taskId, businessDate }');
  const rt = P.assertReportType(reportType);
  if (!P.REPORT_TYPES[rt].authorized) throw new Error(`report_type「${rt}」未授权：拒绝路径/文件操作`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate))) throw new Error(`TaskContext 业务日期非法：${businessDate}`);
  return ctx;
}

/** 仅用于「常驻服务」路径：不是任务，report_type 固定为显式传入值，禁止推断 */
function assertResidentReportType(reportType) {
  if (!reportType) throw new Error('常驻服务必须显式传入 reportType（禁止推断）');
  const rt = P.assertReportType(reportType);
  if (!P.REPORT_TYPES[rt].authorized) throw new Error(`report_type「${rt}」未授权：拒绝常驻服务写路径`);
  return rt;
}

module.exports = { createContext, assertContext, assertResidentReportType };
