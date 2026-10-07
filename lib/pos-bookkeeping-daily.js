'use strict';

// 美团管家「门店收支统计」是按筛选区间汇总的账本，不包含逐行日期。
// 仅接受文件第二行明确写有同一天起止日期的原始导出；不得用文件名猜业务日。
const crypto = require('crypto');
const XLSX = require('xlsx');

const SHEET = '门店收支统计';
const HEADER = ['门店名称', '大类', '小类', '金额'];
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 10000;

function fail(code) { throw new Error(code); }
function isoDate(value) {
  const match = String(value || '').match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!match) return '';
  const date = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : '';
}
function cents(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const n = Math.round(value * 100);
    return Math.abs(value * 100 - n) < 0.00001 && Number.isSafeInteger(n) ? n : null;
  }
  const text = String(value ?? '').trim().replace(/[￥¥,，\s]/g, '');
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const n = Math.round(Number(text) * 100);
  return Number.isSafeInteger(n) ? n : null;
}
function normalizedName(value) {
  return String(value ?? '').trim().replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')');
}
function parsePosBookkeepingDaily(buffer, expectedDate, { allowEmpty = false } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 100 || buffer.length > MAX_BYTES) fail('file_size_invalid');
  const date = isoDate(expectedDate);
  if (!date || date !== expectedDate) fail('business_date_invalid');
  let workbook;
  try { workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false }); }
  catch { fail('workbook_unreadable'); }
  if (workbook.SheetNames.length !== 1 || workbook.SheetNames[0] !== SHEET) fail('sheet_identity_invalid');
  let range;
  try { range = XLSX.utils.decode_range(workbook.Sheets[SHEET]['!ref']); }
  catch { fail('sheet_range_invalid'); }
  if (range.s.c !== 0 || range.e.c !== 3 || range.s.r !== 0 || range.e.r > MAX_ROWS + 3)
    fail('sheet_range_invalid');
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[SHEET], { header: 1, raw: true, defval: '' });
  if (rows.length < (allowEmpty ? 4 : 5) || rows.length > MAX_ROWS + 4) fail('row_count_invalid');
  if (String(rows[0][0] || '').trim() !== SHEET) fail('title_invalid');
  const filters = String(rows[1][0] || '').trim();
  const match = filters.match(/^门店【全部】；大类【全部】；小类【全部】；日期【(\d{4}[/-]\d{1,2}[/-]\d{1,2})-(\d{4}[/-]\d{1,2}[/-]\d{1,2})】$/);
  if (!match) fail('filter_identity_invalid');
  const from = isoDate(match[1]);
  const to = isoDate(match[2]);
  if (from !== date || to !== date) fail('not_expected_single_day');
  if (rows[2].length !== 4 || HEADER.some((item, i) => String(rows[2][i] || '').trim() !== item)) fail('header_invalid');
  const totalRow = rows.at(-1);
  if (String(totalRow[0] || '').trim() !== '合计') fail('total_row_missing');
  if (rows.slice(3, -1).some(row => row.length !== 4)) fail('column_count_invalid');
  const entries = [];
  let sum = 0;
  for (let i = 3; i < rows.length - 1; i++) {
    const row = rows[i];
    const storeName = String(row[0] || '').trim();
    const categoryName = String(row[1] || '').trim();
    const subcategoryName = String(row[2] || '').trim();
    const amountCents = cents(row[3]);
    if (!storeName || !categoryName || !subcategoryName || amountCents === null) fail(`row_invalid:${i + 1}`);
    entries.push({ line: i + 1, store_name: storeName, category_name: categoryName,
      subcategory_name: subcategoryName, amount_cents: amountCents });
    sum += amountCents;
    if (!Number.isSafeInteger(sum)) fail('total_overflow');
  }
  if (!entries.length && !allowEmpty) fail('empty_report');
  if (cents(totalRow[3]) !== sum) fail('total_mismatch');
  if (rows.some((row, i) => i < 2 && row.slice(1).some(cell => cell !== ''))) fail('header_shape_invalid');
  return { report_type: 'pos_bookkeeping_daily', business_date: date,
    file_sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    row_count: entries.length, store_count: new Set(entries.map(row => normalizedName(row.store_name))).size,
    total_cents: sum, entries };
}

function inspectImport(db, parsed) {
  const byName = require('./store-pos-identity').nameMap(db,parsed.business_date,normalizedName);
  const unknown = [...new Set(parsed.entries.map(row => row.store_name).filter(name => !byName.has(normalizedName(name))))];
  if (unknown.length) fail(`store_unmatched:${unknown.join('|')}`);
  const prior = db.queryOne('SELECT id,file_sha256,row_count,total_cents FROM pos_bookkeeping_daily_imports WHERE business_date=?', [parsed.business_date]);
  const existing = Number(db.queryOne('SELECT COUNT(*) AS n FROM bookkeeping_entries WHERE date=?', [parsed.business_date])?.n ?? 0);
  if (!Number.isInteger(existing) || existing < 0) fail('coverage_unreadable');
  if (prior) {
    const linked = db.queryOne(`SELECT COUNT(*) AS n,ROUND(SUM(e.amount)*100) AS cents
      FROM pos_bookkeeping_daily_import_rows l JOIN bookkeeping_entries e ON e.id=l.entry_id
      WHERE l.batch_id=? AND e.date=?`, [prior.id, parsed.business_date]);
    const linkedRows = db.queryAll(`SELECT l.source_line,e.store_name,e.category_name,e.subcategory_name,e.amount
      FROM pos_bookkeeping_daily_import_rows l JOIN bookkeeping_entries e ON e.id=l.entry_id
      WHERE l.batch_id=? AND e.date=?`, [prior.id, parsed.business_date]);
    const expectedByLine = new Map(parsed.entries.map(row => [row.line, row]));
    const contentMatches = linkedRows.length === parsed.row_count && linkedRows.every(row => {
      const source = expectedByLine.get(Number(row.source_line));
      return source && normalizedName(row.store_name) === normalizedName(source.store_name)
        && normalizedName(row.category_name) === normalizedName(source.category_name)
        && normalizedName(row.subcategory_name) === normalizedName(source.subcategory_name)
        && cents(Number(row.amount)) === source.amount_cents;
    });
    if (prior.file_sha256 === parsed.file_sha256 && Number(prior.row_count) === parsed.row_count
      && Number(prior.total_cents) === parsed.total_cents && existing === parsed.row_count
      && Number(linked?.n) === parsed.row_count && Number(linked?.cents) === parsed.total_cents
      && contentMatches)
      return { status: 'already_imported', existing, stores: byName };
    fail('daily_import_conflict_manual_review');
  }
  if (existing) fail('existing_manual_entries_manual_review');
  return { status: 'ready', existing: 0, stores: byName };
}

function importPosBookkeepingDaily(db, buffer, expectedDate, user) {
  const parsed = parsePosBookkeepingDaily(buffer, expectedDate);
  const gate = inspectImport(db, parsed);
  if (gate.status === 'already_imported') return { ok: true, already_imported: true,
    business_date: parsed.business_date, row_count: parsed.row_count, total_cents: parsed.total_cents };
  const userId = Number(user?.id);
  if (!Number.isInteger(userId) || userId <= 0) fail('import_user_invalid');
  db.run('BEGIN');
  try {
    // 同一进程内的二次覆盖闸门；任何既存手工记账都不能被机器人删除或静默混合。
    inspectImport(db, parsed);
    const categories = new Map(db.queryAll('SELECT id,name FROM bookkeeping_categories').map(row => [normalizedName(row.name), row]));
    const subcategories = new Map(db.queryAll('SELECT id,category_id,name FROM bookkeeping_subcategories')
      .map(row => [`${row.category_id}:${normalizedName(row.name)}`, row]));
    const batchId = db.insert(`INSERT INTO pos_bookkeeping_daily_imports
      (business_date,file_sha256,row_count,store_count,total_cents,imported_by)
      VALUES (?,?,?,?,?,?)`, [parsed.business_date, parsed.file_sha256, parsed.row_count,
      parsed.store_count, parsed.total_cents, userId]);
    for (const row of parsed.entries) {
      const store = gate.stores.get(normalizedName(row.store_name));
      const catKey = normalizedName(row.category_name);
      let category = categories.get(catKey);
      if (!category) {
        category = { id: db.insert('INSERT INTO bookkeeping_categories (name,sort_order) VALUES (?,?)', [row.category_name, 999]), name: row.category_name };
        categories.set(catKey, category);
      }
      const subKey = `${category.id}:${normalizedName(row.subcategory_name)}`;
      let subcategory = subcategories.get(subKey);
      if (!subcategory) {
        subcategory = { id: db.insert('INSERT INTO bookkeeping_subcategories (category_id,name,sort_order) VALUES (?,?,?)',
          [category.id, row.subcategory_name, 999]), name: row.subcategory_name };
        subcategories.set(subKey, subcategory);
      }
      const entryId = db.insert(`INSERT INTO bookkeeping_entries
        (store_id,store_name,user_id,user_name,date,category_id,category_name,subcategory_id,subcategory_name,amount,images,remark)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [store.id, store.store_name, userId, String(user.display_name || user.username || 'syncbot'),
        parsed.business_date, category.id, category.name, subcategory.id, subcategory.name, row.amount_cents / 100,
        '[]', `收银系统门店收支统计自动导入 #${batchId}`]);
      db.insert('INSERT INTO pos_bookkeeping_daily_import_rows (batch_id,entry_id,source_line) VALUES (?,?,?)',
        [batchId, entryId, row.line]);
    }
    const check = db.queryOne(`SELECT COUNT(*) AS n,ROUND(SUM(amount)*100) AS cents
      FROM bookkeeping_entries WHERE date=?`, [parsed.business_date]);
    if (Number(check?.n) !== parsed.row_count || Number(check?.cents) !== parsed.total_cents) fail('post_import_reconciliation_failed');
    db.run('COMMIT');
    db.save();
    return { ok: true, already_imported: false, batch_id: batchId, business_date: parsed.business_date,
      row_count: parsed.row_count, store_count: parsed.store_count, total_cents: parsed.total_cents,
      sha256_prefix: parsed.file_sha256.slice(0, 12) };
  } catch (error) {
    try { db.run('ROLLBACK'); } catch {}
    throw error;
  }
}

module.exports = { parsePosBookkeepingDaily, inspectImport, importPosBookkeepingDaily, normalizedName };

