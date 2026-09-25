'use strict';
/**
 * 中控 · 收银导入「金额证据」最小实现（batch 作用域；不返回明细）
 *   · 依据 import_batch_id 在本地库聚合金额，供 syncbot 做同口径 amount 校验；
 *   · 明确拒绝日期级聚合：WHERE 只允许 batch_id=?（若 SQL 出现 biz_date 视为缺陷，测试会断言）；
 *   · amount_basis 三元组 = { file_column, db_column, scope:'import_batch_id' }。
 */
const AMOUNT_BASIS_WHITELIST = [
  { file_column: '营业收入(元)', db_column: 'recorded_amount' },
  { file_column: '营业额(元)', db_column: 'gross_amount' },
  { file_column: '优惠金额(元)', db_column: 'discount_amount' },
];
const SCOPE = 'import_batch_id';

/** 逐列聚合 SQL（batch 作用域，唯一允许的形式；供测试断言） */
function amountSqlFor(dbColumn, { cashierComposite = false } = {}) {
  if (!AMOUNT_BASIS_WHITELIST.some((m) => m.db_column === dbColumn)) throw new Error('db_column_not_whitelisted:' + dbColumn);
  // cashier_composite adds two group-buy composition rows per store. Their amounts
  // are already represented in the report's channel totals, so counting them again
  // would overstate the three file-level columns by the group-buy amount.
  return 'SELECT SUM(' + dbColumn + ') AS v FROM business_revenue_records WHERE batch_id=?' +
    (cashierComposite ? " AND channel_group<>'group_buy'" : '');
}

/** 取值归一：null/undefined/非数值一律 null —— 绝不把空聚合臆造成 0 */
function coerce(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
/** 与中控现有 db 句柄形态解耦的只读取值（prepare/get、get、queryOne、exec 四种形态都支持） */
function queryOneValue(db, sql, params) {
  if (!db) throw new Error('db_missing');
  const p = params || [];
  if (typeof db.prepare === 'function') { const st = db.prepare(sql); const row = (typeof st.get === 'function') ? st.get(...p) : null; if (row) return coerce(Object.values(row)[0]); }
  if (typeof db.get === 'function') { const row = db.get(sql, p); if (row) return coerce(Object.values(row)[0]); }
  if (typeof db.queryOne === 'function') { const row = db.queryOne(sql, p); if (row) return coerce(Object.values(row)[0]); }
  if (typeof db.exec === 'function') { const r = db.exec(sql, p); if (r && r.length && r[0].values && r[0].values.length) return coerce(r[0].values[0][0]); }
  return null;
}
function numOrNull(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }

/**
 * @param {object} db    中控本地库句柄（只读使用）
 * @param {object} result 既有导入结果（至少含 batch_id）
 * @returns {{import_batch_id:number|null, amount_db:object|null, amount_basis:object|null, amount_evidence_error?:string}}
 */
function buildAmountEvidence(db, result) {
  const batchId = result && result.batch_id !== undefined && result.batch_id !== null ? Number(result.batch_id) : null;
  if (!Number.isFinite(batchId) || batchId <= 0) return { import_batch_id: null, amount_db: null, amount_basis: null, amount_evidence_error: 'missing_batch_id' };
  const amountDb = {};
  const mappings = [];
  const cashierComposite = result && result.data_kind === 'cashier_composite';
  for (const m of AMOUNT_BASIS_WHITELIST) {
    let v = null;
    try { v = numOrNull(queryOneValue(db, amountSqlFor(m.db_column, { cashierComposite }), [batchId])); } catch (_) { v = null; }
    amountDb[m.db_column] = v;
    mappings.push({ file_column: m.file_column, db_column: m.db_column, scope: SCOPE });
  }
  return { import_batch_id: batchId, amount_db: amountDb, amount_basis: { scope: SCOPE, mappings: mappings } };
}
module.exports = { AMOUNT_BASIS_WHITELIST, SCOPE, amountSqlFor, buildAmountEvidence, queryOneValue };
