'use strict';
/**
 * 临时、精确的报表 A 筹建门店全零行排除：只处理 2026-09-24..26 的麓城店。
 * 原始归档不动；派生文件经过逐单元格复核后才交给现有校验/导入链路。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');

const RULE = Object.freeze({
  source_name: '鹅太公（麓城店）', city: '深圳市', project_id: 29,
  project_name: '麓居邻里', from: '2026-09-24', through: '2026-09-26',
  sheet: '综合营业统计', first_business_col: 7, last_business_col: 137,
});
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const text = value => String(value == null ? '' : value).trim();
const dateKey = value => text(value).replace(/[^0-9]/g, '');
const valueAt = (sheet, r, c) => sheet[XLSX.utils.encode_cell({ r, c })];

function fail(reason) { return { ok: false, reason }; }

function assess({ file, businessDate, coverage, mapping } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate || ''))) return fail('invalid_business_date');
  if (businessDate < RULE.from || businessDate > RULE.through) return { ok: true, applicable: false, reason: 'outside_approved_window' };
  if (!file || !fs.existsSync(file)) return fail('original_archive_missing');
  const record = (mapping && mapping.project_stores_absent_in_sample || []).find(x => x.id === RULE.project_id);
  if (!record || record.store_name !== RULE.project_name || record.project_status !== '筹建中' || record.flag !== 'pre_opening') return fail('preopening_ledger_not_confirmed');
  if (!coverage || coverage.ok !== true || coverage.truncated === true || !Array.isArray(coverage.active_stores)
      || coverage.active_stores_basis_confirmed !== true || !text(coverage.active_stores_basis)) return fail('active_store_coverage_untrusted');
  if (coverage.active_stores.some(x => Number(x.id) === RULE.project_id)) return fail('construction_store_now_active');

  let workbook;
  try { workbook = XLSX.readFile(file, { cellDates: false }); } catch { return fail('original_archive_unreadable'); }
  const sheet = workbook.Sheets[RULE.sheet];
  if (!sheet || !sheet['!ref']) return fail('report_sheet_missing');
  const range = XLSX.utils.decode_range(sheet['!ref']);
  if (text(valueAt(sheet, 2, 1)?.v) !== '门店名称' || text(valueAt(sheet, 2, 2)?.v) !== '营业日期') return fail('identity_headers_changed');
  let row = -1; let stores = 0;
  for (let r = 3; r <= range.e.r; r++) {
    const city = text(valueAt(sheet, r, 0)?.v);
    if (/^(合计|总计|汇总)/.test(city)) break;
    const name = text(valueAt(sheet, r, 1)?.v);
    if (!name) continue;
    stores += 1;
    if (name !== RULE.source_name) continue;
    if (row !== -1) return fail('duplicate_construction_row');
    if (city !== RULE.city || dateKey(valueAt(sheet, r, 2)?.v) !== dateKey(businessDate)) return fail('construction_identity_or_date_mismatch');
    row = r;
  }
  if (row < 0) return { ok: true, applicable: false, reason: 'exact_source_row_absent' };
  // Only the exact construction row is ever edited. A shorter, otherwise valid
  // report must pass through unchanged when that row is absent.
  if (range.e.c < RULE.last_business_col) return fail('business_columns_missing');
  for (let c = RULE.first_business_col; c <= RULE.last_business_col; c++) {
    const cell = valueAt(sheet, row, c);
    if (!cell || cell.f || typeof cell.v !== 'number' || !Number.isFinite(cell.v) || cell.v !== 0) {
      return fail('construction_business_cell_not_numeric_zero:' + XLSX.utils.encode_col(c));
    }
  }
  return { ok: true, applicable: true, workbook, sheet, row, original_store_count: stores, effective_store_count: stores - 1 };
}

function derive({ file, businessDate, coverage, mapping } = {}) {
  const assessment = assess({ file, businessDate, coverage, mapping });
  if (!assessment.ok || !assessment.applicable) return assessment;
  const { workbook, sheet, row } = assessment;
  const parsed = path.parse(file);
  const derived = path.join(parsed.dir, parsed.name + '_忽略麓城全零行' + parsed.ext);
  const sidecar = derived + '.exception.json';
  if (fs.existsSync(derived) || fs.existsSync(sidecar)) return fail('derived_archive_already_exists');
  const before = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  for (let c = 0; c <= RULE.last_business_col; c++) delete sheet[XLSX.utils.encode_cell({ r: row, c })];
  XLSX.writeFile(workbook, derived);
  let check;
  try { check = XLSX.readFile(derived, { cellDates: false }); } catch { return fail('derived_archive_unreadable'); }
  const after = XLSX.utils.sheet_to_json(check.Sheets[RULE.sheet], { header: 1, raw: true, defval: '' });
  if (JSON.stringify(workbook.SheetNames) !== JSON.stringify(check.SheetNames) || before.length !== after.length) return fail('derived_sheet_shape_changed');
  for (let r = 0; r < before.length; r++) {
    if (r === row) { if (after[r].some(x => x !== '')) return fail('derived_target_row_not_empty'); continue; }
    if (JSON.stringify(before[r]) !== JSON.stringify(after[r])) return fail('derived_other_cell_changed:' + (r + 1));
  }
  const evidence = {
    rule: 'exact_preopening_zero_row_v1', approved_window: [RULE.from, RULE.through], business_date: businessDate,
    source_name: RULE.source_name, project_id: RULE.project_id, project_name: RULE.project_name,
    original_file: path.basename(file), original_sha256: sha(file), derived_file: path.basename(derived), derived_sha256: sha(derived),
    removed_excel_row: row + 1, original_store_count: assessment.original_store_count, effective_store_count: assessment.effective_store_count,
    all_other_cell_values_equal: true,
  };
  fs.writeFileSync(sidecar, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { ok: true, applicable: true, file: derived, size: fs.statSync(derived).size, sha256: evidence.derived_sha256, evidence };
}

function adjustDeclaredDynamic(value, evidence) {
  if (value == null) return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return fail('declared_store_count_invalid');
  if (n === evidence.original_store_count) return { ok: true, value: evidence.effective_store_count };
  if (n === evidence.effective_store_count) return { ok: true, value: n };
  return fail('declared_store_count_mismatch_after_exception');
}

module.exports = { RULE, assess, derive, adjustDeclaredDynamic };
