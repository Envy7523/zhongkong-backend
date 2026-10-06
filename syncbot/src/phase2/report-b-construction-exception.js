'use strict';
/** B 报表：已确认筹建门店的净零测试交易排除。原件不动，派生件与证据并存。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const RULE = Object.freeze({ name: '鹅太公（麓城店）', code: 'MD00023', city: '深圳市',
  projectId: 29, projectName: '麓居邻里', from: '2026-09-24', through: '2026-09-26' });
const SUM_COLS = [22, 23, 24, 25, 26, 27, 46, 47];
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fail = reason => ({ ok: false, reason });

function assess({ file, businessDate, mapping, coverage } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate || '')) || businessDate < RULE.from || businessDate > RULE.through)
    return { ok: true, applicable: false, reason: 'outside_approved_window' };
  const record = (mapping && mapping.project_stores_absent_in_sample || []).find(x => x.id === RULE.projectId);
  if (!record || record.store_name !== RULE.projectName || record.project_status !== '筹建中' || record.flag !== 'pre_opening')
    return fail('preopening_ledger_not_confirmed');
  if (!coverage || coverage.ok !== true || coverage.store_codes_complete !== true || !Array.isArray(coverage.store_codes)
    || coverage.store_codes.some(x => x.id === RULE.projectId || x.pos_store_code === RULE.code))
    return fail('construction_store_in_coverage_or_coverage_untrusted');
  let workbook;
  try { workbook = XLSX.readFile(file, { cellDates: false }); } catch { return fail('original_archive_unreadable'); }
  const sheet = workbook.Sheets['品项销售明细'];
  if (!sheet) return fail('report_sheet_missing');
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  if (grid.length < 5 || String(grid[grid.length - 1][0]).trim() !== '合计') return fail('report_shape_invalid');
  const target = [], kept = [];
  for (const row of grid.slice(3, -1)) {
    if (String(row[2] || '').trim() !== RULE.name) { kept.push(row); continue; }
    if (String(row[0] || '').trim() !== RULE.city || String(row[1] || '').trim() !== RULE.code
      || String(row[3] || '').replace(/\//g, '-') !== businessDate || !String(row[21] || '').trim())
      return fail('construction_row_identity_mismatch');
    if (SUM_COLS.some(i => !Number.isFinite(Number(row[i])))) return fail('construction_row_amount_invalid');
    target.push(row);
  }
  if (!target.length) return { ok: true, applicable: false, reason: 'exact_source_rows_absent' };
  const sums = Object.fromEntries(SUM_COLS.map(i => [i, Number(target.reduce((a, r) => a + Number(r[i]), 0).toFixed(3))]));
  for (const i of [22, 23, 24, 25, 26, 27]) if (Math.abs(sums[i]) > 0.001)
    return fail('construction_test_transactions_not_net_zero:' + i);
  const total = [...grid[grid.length - 1]];
  for (const i of SUM_COLS) {
    if (!Number.isFinite(Number(total[i]))) return fail('total_amount_invalid:' + i);
    total[i] = Number((Number(total[i]) - sums[i]).toFixed(i === 22 || i === 23 || i === 46 ? 3 : 2));
  }
  return { ok: true, applicable: true, workbook, grid, target, kept, total, sums };
}

function derive(args = {}) {
  const a = assess(args);
  if (!a.ok || !a.applicable) return a;
  const source = path.resolve(args.file);
  const parsed = path.parse(source);
  const file = path.join(parsed.dir, parsed.name + '_忽略麓城筹建测试行' + parsed.ext);
  const sidecar = file + '.exception.json';
  if (fs.existsSync(file) || fs.existsSync(sidecar)) return fail('derived_archive_already_exists');
  const derivedGrid = [...a.grid.slice(0, 3), ...a.kept, a.total];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(derivedGrid), '品项销售明细');
  XLSX.writeFile(workbook, file);
  let reread;
  try { reread = XLSX.utils.sheet_to_json(XLSX.readFile(file).Sheets['品项销售明细'], { header: 1, raw: true, defval: '' }); }
  catch { return fail('derived_archive_unreadable'); }
  if (JSON.stringify(reread) !== JSON.stringify(derivedGrid)) return fail('derived_cells_changed');
  const evidence = { rule: 'report_b_exact_preopening_net_zero_v1', business_date: args.businessDate,
    source_name: RULE.name, source_code: RULE.code, project_id: RULE.projectId,
    original_file: path.basename(source), original_sha256: sha(source),
    derived_file: path.basename(file), derived_sha256: sha(file),
    excluded_rows: a.target.length, original_rows: a.grid.length - 4, effective_rows: a.kept.length,
    excluded_sums: a.sums, all_other_cell_values_equal: true };
  fs.writeFileSync(sidecar, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { ok: true, applicable: true, file, size: fs.statSync(file).size, sha256: evidence.derived_sha256, evidence };
}

module.exports = { RULE, SUM_COLS, assess, derive };
