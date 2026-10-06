'use strict';
/** 仅 2026-09-24：排除已确认筹建门店的一条零额测试行；原件永不改写。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const RULE = Object.freeze({ date: '2026-09-24', store: '鹅太公（麓城店）',
  category: '销售收入', subcategory: '堂食/外带', amount: 0, project_id: 29,
  project_name: '麓居邻里' });
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fail = reason => ({ ok: false, reason });
function derive({ file, businessDate } = {}) {
  if (businessDate !== RULE.date) return fail('construction_exception_date_not_approved');
  let workbook, grid;
  try {
    workbook = XLSX.readFile(file, { cellDates: false });
    if (workbook.SheetNames.length !== 1 || workbook.SheetNames[0] !== '门店收支统计')
      return fail('original_sheet_identity_invalid');
    grid = XLSX.utils.sheet_to_json(workbook.Sheets['门店收支统计'],
      { header: 1, raw: true, defval: '' });
  } catch { return fail('original_archive_unreadable'); }
  if (grid.length < 5 || String(grid.at(-1)[0]).trim() !== '合计') return fail('original_shape_invalid');
  const removed = grid.slice(3, -1).filter(row => String(row[0]).trim() === RULE.store);
  if (removed.length !== 1 || String(removed[0][1]).trim() !== RULE.category
    || String(removed[0][2]).trim() !== RULE.subcategory || Number(removed[0][3]) !== 0)
    return fail('construction_row_not_exact_zero');
  const kept = grid.slice(3, -1).filter(row => String(row[0]).trim() !== RULE.store);
  const derivedGrid = [...grid.slice(0, 3), ...kept, grid.at(-1)];
  const parsed = path.parse(path.resolve(file));
  const out = path.join(parsed.dir, parsed.name + '_忽略麓城筹建零额行' + parsed.ext);
  const sidecar = out + '.exception.json';
  if (fs.existsSync(out) || fs.existsSync(sidecar)) {
    if (!fs.existsSync(out) || !fs.existsSync(sidecar)) return fail('derived_archive_incomplete');
    let recorded, reread;
    try {
      recorded = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      reread = XLSX.utils.sheet_to_json(XLSX.readFile(out).Sheets['门店收支统计'],
        { header: 1, raw: true, defval: '' });
    } catch { return fail('derived_archive_evidence_unreadable'); }
    if (recorded.rule !== 'report_c_20260924_exact_construction_zero_v1'
      || recorded.business_date !== businessDate || recorded.project_id !== RULE.project_id
      || recorded.original_file !== path.basename(file) || recorded.original_sha256 !== sha(file)
      || recorded.derived_file !== path.basename(out) || recorded.derived_sha256 !== sha(out)
      || recorded.removed_rows !== 1 || recorded.source_rows !== grid.length - 4
      || recorded.imported_rows !== kept.length
      || JSON.stringify(recorded.removed_row) !== JSON.stringify(removed[0])
      || JSON.stringify(reread) !== JSON.stringify(derivedGrid))
      return fail('derived_archive_evidence_mismatch');
    return { ok: true, file: out, size: fs.statSync(out).size,
      sha256: recorded.derived_sha256, evidence: recorded, reused: true };
  }
  const fresh = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(fresh, XLSX.utils.aoa_to_sheet(derivedGrid), '门店收支统计');
  XLSX.writeFile(fresh, out);
  let reread;
  try { reread = XLSX.utils.sheet_to_json(XLSX.readFile(out).Sheets['门店收支统计'],
    { header: 1, raw: true, defval: '' }); }
  catch { return fail('derived_archive_unreadable'); }
  if (JSON.stringify(reread) !== JSON.stringify(derivedGrid)) return fail('derived_cells_changed');
  const evidence = { rule: 'report_c_20260924_exact_construction_zero_v1', business_date: businessDate,
    project_id: RULE.project_id, project_name: RULE.project_name,
    original_file: path.basename(file), original_sha256: sha(file),
    derived_file: path.basename(out), derived_sha256: sha(out),
    source_rows: grid.length - 4, imported_rows: kept.length, removed_rows: 1,
    removed_row: removed[0], total_unchanged: true, all_other_cell_values_equal: true };
  fs.writeFileSync(sidecar, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { ok: true, file: out, size: fs.statSync(out).size,
    sha256: evidence.derived_sha256, evidence };
}
module.exports = { RULE, derive };
