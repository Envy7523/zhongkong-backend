'use strict';
const crypto = require('crypto');
const base = require('./syncbot-coverage');
const contract = require('../syncbot/src/meituan-delivery/operating-contract');
const { parseOperatingBuffer, plainDate } = require('../syncbot/src/meituan-delivery/operating-file');
const PREFIX = '/api/internal/syncbot/meituan-delivery';
const COLUMNS = { 营业收入: 'income_amount', 优惠前总额: 'gross_amount', 有效订单: 'order_count', 曝光人数: 'impression_users',
  入店人数: 'visit_users', 入店转化率: 'visit_rate', 下单转化率: 'order_rate', 下单人数: 'ordering_users', 综合体验分: 'store_rating' };
function ready(db) {
  db.run(`CREATE TABLE IF NOT EXISTS meituan_delivery_robot_runs (
    business_date TEXT PRIMARY KEY, source_sha256 TEXT NOT NULL, file_name TEXT NOT NULL,
    status TEXT NOT NULL, batch_id INTEGER, summary_json TEXT, started_at TEXT, completed_at TEXT)`);
}
function bindings(db) {
  const rows = db.queryAll(`SELECT p.platform_id, s.id store_id,s.store_name FROM store_platforms p
    JOIN stores s ON s.id=p.store_id WHERE p.platform_name='美团外卖' AND TRIM(COALESCE(p.platform_id,''))<>'' ORDER BY p.platform_id`);
  if (!rows.length || rows.length > 200 || rows.some(row => !/^\d+$/.test(row.platform_id))
    || new Set(rows.map(row => row.platform_id)).size !== rows.length) throw Error('operating_binding_invalid');
  return rows;
}
function sourceNumber(value, rate = false) {
  if (['', '--', '—', '-'].includes(String(value ?? '').trim())) return null;
  const text = String(value).trim().replace(/[,，￥¥\s]/g, '');
  return Number(text.replace(/%$/, '')) / (rate && text.endsWith('%') ? 100 : 1);
}
function verifyStored(db, report) {
  // 同一业务日可能还保留另一账号人工导入的门店，核验只覆盖本次原表。
  const sourceIds = report.rows.map(row => row.门店id);
  const records = db.queryAll(`SELECT * FROM meituan_delivery_operation_records WHERE biz_date=? AND meituan_store_id IN (${sourceIds.map(() => '?').join(',')})`, [report.from, ...sourceIds]);
  if (records.length !== report.row_count) throw Error('operating_database_row_count_mismatch');
  const actual = new Map(records.map(row => [String(row.meituan_store_id), row]));
  for (const source of report.rows) {
    const row = actual.get(source.门店id);
    if (!row || row.match_status !== 'matched' || !row.store_id) throw Error('operating_database_store_mismatch');
    const original = JSON.parse(row.raw_json);
    if (plainDate(original.日期) !== source.日期 || String(original.门店id) !== source.门店id) throw Error('operating_database_identity_mismatch');
    for (const field of contract.identityFields.slice(1)) {
      if (String(original[field] ?? '').trim() !== String(source[field]).trim()) throw Error('operating_database_source_mismatch');
    }
    for (const [field, column] of Object.entries(COLUMNS)) {
      const value = sourceNumber(source[field], field.endsWith('转化率'));
      const saved = sourceNumber(original[field], field.endsWith('转化率'));
      if (value !== saved || Math.abs(Number(row[column]) - (value ?? 0)) > 1e-8) throw Error('operating_database_metric_mismatch:' + column);
    }
  }
  return { ok: true, row_count: records.length, store_count: report.store_count,
    income_cents: report.income_cents, gross_cents: report.gross_cents, order_count: report.order_count,
    blank_metric_counts: report.blank_metric_counts, all_fields_verified: true };
}
function importSource(db, businessAnalytics, body) {
  const { business_date: date, file_name: filename, data, sha256 } = body || {};
  if (plainDate(date) !== date || typeof filename !== 'string' || !/^[^/\\]{1,200}\.(csv|xlsx|xls)$/.test(filename)
    || typeof data !== 'string' || data.length > 28 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(sha256 || '')) throw Error('operating_import_invalid');
  const buffer = Buffer.from(data, 'base64');
  if (crypto.createHash('sha256').update(buffer).digest('hex') !== sha256) throw Error('operating_hash_mismatch');
  const report = parseOperatingBuffer(buffer, { from: date, expectedStoreIds: bindings(db).map(row => row.platform_id) });
  ready(db);
  const existing = db.queryOne('SELECT * FROM meituan_delivery_robot_runs WHERE business_date=?', [date]);
  if (existing) {
    if (existing.source_sha256 !== sha256) throw Error('operating_prior_source_changed_manual_review');
    const summary = verifyStored(db, report);
    const batchId = existing.batch_id || db.queryOne('SELECT batch_id FROM meituan_delivery_operation_records WHERE biz_date=? AND meituan_store_id=?', [date, report.rows[0].门店id])?.batch_id;
    if (!batchId || db.queryOne('SELECT file_name FROM business_import_batches WHERE id=?', [batchId])?.file_name !== filename)
      throw Error('operating_prior_import_unknown');
    if (db.queryOne(`SELECT COUNT(*) n FROM meituan_delivery_operation_records WHERE biz_date=? AND meituan_store_id IN (${report.rows.map(() => '?').join(',')}) AND batch_id=?`, [date, ...report.rows.map(row => row.门店id), batchId]).n !== report.row_count)
      throw Error('operating_prior_import_unknown');
    db.run("UPDATE meituan_delivery_robot_runs SET status='completed',batch_id=?,summary_json=?,completed_at=? WHERE business_date=?",
      [batchId, JSON.stringify(summary), new Date().toISOString(), date]); db.save();
    return { ok: true, reused: true, batch_id: batchId, verification: summary };
  }
  db.run("INSERT INTO meituan_delivery_robot_runs (business_date,source_sha256,file_name,status,started_at) VALUES (?,?,?,'importing',?)",
    [date, sha256, filename, new Date().toISOString()]); db.save();
  const result = businessAnalytics.importMeituanDeliveryWorkbook(db, { data, file_name: filename, report_kind: 'operating' },
    { username: 'meituan-delivery-robot', display_name: '美团外卖采集机器人' });
  if (result.data_kind !== 'meituan_operation' || result.unmatched !== 0 || result.skipped !== 0 || result.raw_imported !== report.row_count)
    throw Error('operating_import_receipt_mismatch');
  const summary = verifyStored(db, report);
  db.run("UPDATE meituan_delivery_robot_runs SET status='completed',batch_id=?,summary_json=?,completed_at=? WHERE business_date=?",
    [result.batch_id, JSON.stringify(summary), new Date().toISOString(), date]); db.save();
  return { ok: true, batch_id: result.batch_id, reused: false, verification: summary };
}
function rawRecords(db, query = {}) {
  const from = query.date_from, to = query.date_to;
  if (plainDate(from) !== from || plainDate(to) !== to || from > to) throw Error('operating_date_range_invalid');
  const clauses = ['biz_date>=?', 'biz_date<=?'], values = [from, to];
  const ids = String(query.store_ids || query.store_id || '').split(',').filter(Boolean).map(Number);
  if (ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw Error('operating_store_scope_invalid');
  if (ids.length) { clauses.push(`store_id IN (${ids.map(() => '?').join(',')})`); values.push(...ids); }
  const page = Math.max(1, Math.min(100000, Math.trunc(Number(query.page) || 1)));
  const total = db.queryOne(`SELECT COUNT(*) n FROM meituan_delivery_operation_records WHERE ${clauses.join(' AND ')}`, values).n;
  const rows = db.queryAll(`SELECT * FROM meituan_delivery_operation_records WHERE ${clauses.join(' AND ')} ORDER BY biz_date DESC,meituan_store_id LIMIT 100 OFFSET ?`, [...values, (page - 1) * 100]);
  const lastRun = db.queryOne("SELECT name FROM sqlite_master WHERE name='meituan_delivery_robot_runs'")
    ? db.queryOne('SELECT business_date,status,batch_id,completed_at,summary_json FROM meituan_delivery_robot_runs WHERE business_date>=? AND business_date<=? ORDER BY business_date DESC LIMIT 1', [from, to]) : null;
  if (lastRun) { lastRun.verified_row_count = JSON.parse(lastRun.summary_json || '{}').row_count || 0; delete lastRun.summary_json; }
  return { ok: true, total, page, page_size: 100, last_run: lastRun, fields: contract.fields, rows: rows.map(row => ({
    ...JSON.parse(row.raw_json), 日期: row.biz_date, 门店id: row.meituan_store_id,
    system_store_name: row.store_name, match_status: row.match_status, batch_id: row.batch_id,
  })) };
}
function mount({ app, express, db, audit, businessAnalytics }) {
  app.use(PREFIX, express.raw({ type: () => true, limit: '30mb' }));
  const auth = (req, res) => { const result = base.verifyRequest(req, audit); if (!result.ok) res.status(401).json({ ok: false, reason: result.reason }); return result.ok; };
  app.get(PREFIX + '/scope', (req, res) => {
    if (!auth(req, res)) return;
    try { res.json({ ok: true, bindings: bindings(db) }); } catch (e) { res.status(409).json({ ok: false, reason: e.message }); }
  });
  app.post(PREFIX + '/import', (req, res) => {
    if (!auth(req, res)) return;
    try { res.json(importSource(db, businessAnalytics, JSON.parse(req.body.toString('utf8')))); }
    catch (e) { res.status(409).json({ ok: false, reason: /^[a-z][a-z0-9_:.-]{0,150}$/.test(e.message) ? e.message : 'operating_import_failed' }); }
  });
  app.get('/api/business-analytics/meituan-operating-source', (req, res) => {
    try { res.json(rawRecords(db, req.query)); } catch { res.status(400).json({ error: '营业明细日期或门店范围无效' }); }
  });
}
module.exports = { mount, ready, bindings, rawRecords, importSource, verifyStored, COLUMNS };
