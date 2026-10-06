'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const MOD = require('../../src/phase2/construction-zero-exception');
const VALID = require('../../src/phase2/report-a-file-validate');
const RUNNER = require('../../src/phase3/production-sync-runner');
const source = process.env.CONSTRUCTION_ZERO_TEST_SOURCE || path.resolve(__dirname, '../../outputs/20260925-0924-store-exclusion/source-original.xlsx');
const mapping = require(process.env.CONSTRUCTION_ZERO_TEST_MAPPING || '../../config/store-mapping.json');
const coverage = { ok: true, truncated: false, active_stores_basis: 'stores.status=正常营业', active_stores_basis_confirmed: true, active_stores: [{ id: 1, name: 'known' }] };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zk-construction-zero-'));
const original = path.join(root, 'source-original.xlsx');
fs.copyFileSync(source, original);
const checks = [];
const ck = (name, yes) => checks.push({ name, ok: !!yes });

let a = MOD.assess({ file: original, businessDate: '2026-09-24', coverage, mapping });
ck('exact zero row accepted', a.ok && a.applicable && a.row === 25 && a.original_store_count === 21 && a.effective_store_count === 20);
let d = MOD.derive({ file: original, businessDate: '2026-09-24', coverage, mapping });
ck('derived and evidence created', d.ok && d.applicable && fs.existsSync(d.file) && fs.existsSync(d.file + '.exception.json') && d.evidence.all_other_cell_values_equal);
const validated = VALID.validateReportAFile(d.file, { businessDate: '2026-09-24', declaredDynamic: 20, storeMapping: mapping, coverageRequired: false });
ck('existing formal file validator accepts derived report', validated.ok && validated.unique_valid_store_count === 20 && validated.unknown_stores.length === 0);
ck('declared 21 adjusts to 20', MOD.adjustDeclaredDynamic(21, d.evidence).value === 20);
ck('declared 20 stays 20', MOD.adjustDeclaredDynamic(20, d.evidence).value === 20);
ck('declared 19 refuses', MOD.adjustDeclaredDynamic(19, d.evidence).reason === 'declared_store_count_mismatch_after_exception');
ck('original unchanged', fs.readFileSync(original).equals(fs.readFileSync(source)));
ck('repeat refuses overwrite', MOD.derive({ file: original, businessDate: '2026-09-24', coverage, mapping }).reason === 'derived_archive_already_exists');
ck('active construction store refuses', MOD.assess({ file: original, businessDate: '2026-09-24', coverage: { ...coverage, active_stores: [{ id: 29, name: '麓居邻里' }] }, mapping }).reason === 'construction_store_now_active');
ck('expired date does not waive', MOD.assess({ file: original, businessDate: '2026-09-27', coverage, mapping }).applicable === false);
const nonzero = path.join(root, 'nonzero.xlsx');
const w = XLSX.readFile(original); w.Sheets['综合营业统计'].H26.v = 0.01; w.Sheets['综合营业统计'].H26.w = '0.01'; XLSX.writeFile(w, nonzero);
ck('nonzero revenue refuses', MOD.assess({ file: nonzero, businessDate: '2026-09-24', coverage, mapping }).reason === 'construction_business_cell_not_numeric_zero:H');
const badMapping = structuredClone(mapping); badMapping.project_stores_absent_in_sample.find(x => x.id === 29).project_status = '正常营业';
ck('opened ledger refuses', MOD.assess({ file: original, businessDate: '2026-09-24', coverage, mapping: badMapping }).reason === 'preopening_ledger_not_confirmed');

// Discount/coupon columns vary by business date. Width matters only if the
// exact construction row is present and would be removed.
function shortenedFixture(name, removeConstructionRow) {
  const file = path.join(root, name);
  const wb = XLSX.readFile(original);
  const sheet = wb.Sheets[MOD.RULE.sheet];
  const lastCol = MOD.RULE.last_business_col - 3;
  for (const address of Object.keys(sheet)) {
    if (address.startsWith('!')) continue;
    const cell = XLSX.utils.decode_cell(address);
    if (cell.c > lastCol || (removeConstructionRow && cell.r === a.row)) delete sheet[address];
  }
  const range = XLSX.utils.decode_range(sheet['!ref']);
  range.e.c = lastCol;
  sheet['!ref'] = XLSX.utils.encode_range(range);
  XLSX.writeFile(wb, file);
  return file;
}
const shorterAbsent = shortenedFixture('shorter-absent.xlsx', true);
const absent = MOD.assess({ file: shorterAbsent, businessDate: '2026-09-24', coverage, mapping });
ck('shorter report without construction row passes unchanged', absent.ok && absent.applicable === false && absent.reason === 'exact_source_row_absent');
ck('shorter absent report creates no derived file', MOD.derive({ file: shorterAbsent, businessDate: '2026-09-24', coverage, mapping }).applicable === false && !fs.existsSync(path.join(root, 'shorter-absent_忽略麓城全零行.xlsx')));
const shorterPresent = shortenedFixture('shorter-present.xlsx', false);
ck('shorter report with construction row still refuses', MOD.assess({ file: shorterPresent, businessDate: '2026-09-24', coverage, mapping }).reason === 'business_columns_missing');

(async () => {
  const wrappedOriginal = path.join(root, 'wrapped-original.xlsx');
  fs.copyFileSync(source, wrappedOriginal);
  const wrapped = RUNNER.wrapConstructionZeroException({
    archiveFn: async () => ({ file: wrappedOriginal, size: fs.statSync(wrappedOriginal).size }),
    validateFileFn: (file, opts) => VALID.validateReportAFile(file, { ...opts, storeMapping: mapping, coverageRequired: false }),
    businessDate: '2026-09-24', coverage, mapping,
  });
  const archived = await wrapped.archiveFn({});
  const checked = await wrapped.validateFileFn(archived.file, { businessDate: '2026-09-24', declaredDynamic: 21 });
  ck('production archive+validate wrapper passes adjusted declared count', archived.file !== wrappedOriginal && checked.ok && checked.declared_dynamic_used === 20);
  const rejected = await wrapped.validateFileFn(archived.file, { businessDate: '2026-09-24', declaredDynamic: 19 });
  ck('production wrapper refuses unrelated declared count', rejected.ok === false && rejected.errors.includes('declared_store_count_mismatch_after_exception'));
  const recoveredOriginal = path.join(root, 'recovered-original.xlsx');
  fs.copyFileSync(source, recoveredOriginal);
  const recovered = await wrapped.archiveFn.recoverArchived({ srcFile: recoveredOriginal });
  const recoveredCheck = await wrapped.validateFileFn(recovered.file, { businessDate: '2026-09-24', declaredDynamic: 21 });
  ck('recorded archive recovery still applies construction exception and validation',
    recovered.file !== recoveredOriginal && recoveredCheck.ok && recoveredCheck.declared_dynamic_used === 20
    && fs.readFileSync(recoveredOriginal).equals(fs.readFileSync(source)));
  console.log(JSON.stringify({ ok: checks.every(x => x.ok), checks, output_dir: root }, null, 2));
  process.exit(checks.every(x => x.ok) ? 0 : 1);
})().catch(error => { console.error(error); process.exit(1); });
