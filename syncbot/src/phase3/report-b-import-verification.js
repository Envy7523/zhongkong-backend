'use strict';
/** 报表 B 导入后证据闭环，纯函数；不读取文件、不访问网络、不修改状态。 */
const REPORT_TYPE = 'item_sales_detail';
const DATA_KIND = 'pos_item_sales_detail';

function verifyReportBImport({ businessDate, fileName, validation, response, coverageBefore, coverageAfter } = {}) {
  const errors = [];
  const add = code => errors.push(code);
  const date = String(businessDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) add('business_date_invalid');
  if (!validation || validation.ok !== true || validation.report_type !== REPORT_TYPE
    || validation.business_date !== date || !Number.isInteger(validation.source_rows)
    || validation.source_rows <= 0 || !Number.isInteger(validation.store_count)
    || validation.store_count <= 0 || !Number.isInteger(validation.order_count)
    || validation.order_count <= 0) add('source_validation_invalid');
  if (!coverageBefore || coverageBefore.ok !== true || coverageBefore.report_type !== REPORT_TYPE
    || coverageBefore.business_date !== date || coverageBefore.has_records !== false
    || coverageBefore.record_count !== 0) add('pre_import_coverage_invalid');
  const r = response || {};
  if (r.ok !== true || r.data_kind !== DATA_KIND || !Number.isInteger(r.batch_id) || r.batch_id <= 0)
    add('import_response_identity_invalid');
  if (validation && (r.imported !== validation.source_rows || r.dish_mirrored !== validation.source_rows
    || r.matched_stores !== validation.store_count || r.skipped !== 0)) add('import_response_counts_mismatch');
  if (r.date_from !== date || r.date_to !== date) add('import_response_date_mismatch');
  if (Array.isArray(r.errors) && r.errors.length) add('import_response_errors_present');
  const c = coverageAfter || {};
  if (c.ok !== true || c.report_type !== REPORT_TYPE || c.business_date !== date
    || c.has_records !== true || !Number.isInteger(c.record_count) || c.record_count <= 0
    || !Number.isInteger(c.store_count) || !Number.isInteger(c.order_count))
    add('post_import_coverage_invalid');
  if (validation && c.record_count > validation.source_rows) add('post_import_rows_exceed_source');
  if (validation && (c.store_count !== validation.store_count || c.order_count !== validation.order_count))
    add('post_import_scope_mismatch');
  const batches = Array.isArray(c.import_batches) ? c.import_batches : [];
  const batch = batches.find(x => x && x.batch_id === r.batch_id);
  if (!batch || batch.file_name !== fileName || !validation || batch.row_count !== validation.source_rows
    || batch.date_from !== date || batch.date_to !== date) add('post_import_batch_mismatch');
  return { ok: errors.length === 0, errors, report_type: REPORT_TYPE, business_date: date,
    batch_id: Number.isInteger(r.batch_id) ? r.batch_id : null,
    source_rows: validation && validation.source_rows || null,
    db_rows: Number.isInteger(c.record_count) ? c.record_count : null,
    store_count: Number.isInteger(c.store_count) ? c.store_count : null,
    order_count: Number.isInteger(c.order_count) ? c.order_count : null };
}

module.exports = { REPORT_TYPE, DATA_KIND, verifyReportBImport };
