'use strict';
/**
 * 报表A（综合营业统计）导出文件校验（离线可用；不做任何网络/美团访问）
 * 校验：扩展名 / 非空 / 无 .crdownload / 工作表名 / 第2行查询参数元数据 /
 *       门店行结构 / 合计行跳过 / 唯一有效门店数 / 门店名精确映射 / absent 审计
 *
 * 动态化口径（冻结）：
 *  - 期望门店数 = **本次 declared_dynamic**（查询步骤声明的有效门店数）；
 *    无 declared_dynamic 时退化为「文件自报的唯一有效门店数」（仅要求 >= 1）。
 *  - 「唯一有效门店数」= 剔除表头行、渠道分组行、指标叶子行、合计行后，
 *    **业务日期匹配、门店名非空、且能精确映射**的**唯一**门店行数。
 *  - 期望值显式给定（opts.expectedStores 为数字）⇒ 保留原「固定值严格比较」（向后兼容既有套件）。
 *  - 未知/歧义门店 ⇒ 校验失败（ok=false，非 fatal）并给出名单 ⇒ 调用方转 WAITING_HUMAN；
 *    **禁止**模糊/LIKE 猜测。
 *  - absent（主档在营门店当天未出现）⇒ **仅审计记录**：不失败、不补零、不影响 ok。
 *  - 在营门店清单只来自中控只读接口 active_stores:[{id,name}]（由调用方注入）；
 *    缺失/为空 ⇒ fail-closed：absent 记为 unknown（只审计），且当映射覆盖率无法确认
 *    （coverageRequired=true）时校验失败 ⇒ WAITING_HUMAN。本模块**不直连项目库**、不访问网络。
 */
const fs = require('fs');
const path = require('path');
const SMC = require('./store-mapping-coverage');

const ALLOWED_EXT = ['xlsx', 'xls', 'csv'];
const SHEET_NAME = '综合营业统计';
/** 业务日期列候选表头（与 meituan-rules.report.business_date_column 的口径一致：C 列「营业日期」） */
const DATE_HEADER_CANDIDATES = ['营业日期', '营业日', '业务日期'];

function baseCheck(file) {
  const errs = [];
  if (!fs.existsSync(file)) return { errs: [`文件不存在：${file}`], size: 0 };
  const st = fs.statSync(file);
  const name = path.basename(file);
  if (/\.crdownload$/i.test(name)) errs.push('文件仍为未完成下载（.crdownload）');
  const ext = String(name.split('.').pop() || '').toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) errs.push(`扩展名不在白名单（${ext}）`);
  if (!(st.size > 0)) errs.push('文件大小为 0');
  return { errs, size: st.size, ext, name };
}

/** 第2行元数据断言（关键词逐项） */
function row2Assertions(row2Text, businessDate) {
  const t = String(row2Text || '').replace(/\s+/g, ' ');
  const [y, m, d] = String(businessDate).split('-');
  const dateOk = t.includes(`${y}/${m}/${d}`) || t.includes(`${y}-${m}-${d}`) || t.includes(`${y}/${Number(m)}/${Number(d)}`);
  const items = [
    ['营业日期=目标日期', dateOk],
    ['统计周期【日期】', /统计周期[^）)】]*[【\[]\s*日期\s*[】\]]|统计周期[：:]\s*日期/.test(t)],
    ['门店区域【城市、门店名称】', /门店区域/.test(t) && /城市/.test(t) && /门店名称/.test(t)],
    ['餐时段统计方式【下单时间】', /餐时段统计方式/.test(t) && /下单时间/.test(t)],
    ['营业收入构成【结账方式类型】', /营业收入构成/.test(t) && /结账方式类型/.test(t)],
    ['支付优惠构成【结账方式】', /支付优惠构成/.test(t) && /结账方式/.test(t)],
    ['折扣优惠构成【折扣优惠方式】', /折扣优惠构成/.test(t) && /折扣优惠方式/.test(t)],
  ];
  return items.map(([name, ok]) => ({ name, ok: !!ok }));
}

/** 业务日期单元格归一：2026/09/16、2026-9-16、2026年09月16日 → '20260916' */
function normDateCell(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return null;
  const digits = s.replace(/[^0-9]/g, '');
  if (digits.length === 8) return digits;
  const m = s.match(/^(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}${String(m[2]).padStart(2, '0')}${String(m[3]).padStart(2, '0')}`;
}
const isoKey = (bd) => String(bd || '').replace(/[^0-9]/g, '');

/**
 * 校验导出文件
 * @param {string} file
 * @param {{
 *   businessDate: string,
 *   expectedStores?: number|null,     // 数字 ⇒ 固定值严格比较（向后兼容）；null/undefined ⇒ 动态
 *   declaredDynamic?: number|null,    // 查询步骤声明的有效门店数（动态模式的期望值来源）
 *   activeStores?: Array<{id:number,name:string}>|null,  // 中控 coverage.active_stores（在营基准）
 *   storeMapping?: object|null,       // config/store-mapping.json 内容（源门店名精确映射台账）
 *   coverageRequired?: boolean,       // true ⇒ 在营清单缺失时 fail-closed 判失败
 *   expectedStoreNames?: string[],    // 兼容旧调用：仅作**审计**（不再阻断 absent）
 * }} opts
 */
function validateReportAFile(file, opts = {}) {
  const checks = {};
  const b = baseCheck(file);
  checks.extension_and_size = { ok: b.errs.length === 0, detail: b.errs.length ? b.errs.join('；') : `ext=${b.ext} size=${b.size}` };
  if (!checks.extension_and_size.ok) return { ok: false, checks, errors: b.errs };

  let XLSX;
  try { XLSX = require('xlsx'); } catch (e) { return { ok: false, checks: { ...checks, xlsx: { ok: false, detail: `缺少 xlsx 依赖：${e.message}` } }, errors: ['xlsx 依赖缺失'] }; }

  let wb;
  try { wb = XLSX.readFile(file, { cellDates: false }); } catch (e) {
    return { ok: false, checks: { ...checks, parse: { ok: false, detail: e.message } }, errors: [`无法解析：${e.message}`] };
  }
  const names = wb.SheetNames || [];
  checks.sheet_name = { ok: names.includes(SHEET_NAME), detail: `工作表=${JSON.stringify(names)}` };

  const ws = wb.Sheets[SHEET_NAME] || wb.Sheets[names[0]];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  const rowOf = (i) => (grid[i] || []).map((x) => String(x === undefined || x === null ? '' : x)).join(' ');
  const row2 = rowOf(1);
  const r2 = row2Assertions(row2, opts.businessDate);
  checks.row2_metadata = { ok: r2.every((x) => x.ok), detail: r2.map((x) => `${x.ok ? '✓' : '✗'}${x.name}`).join(' '), items: r2, raw: row2.slice(0, 300) };

  // 门店行：定位含「门店名称」的表头行，向下取数据行直到「合计」行
  let headerIdx = -1;
  for (let i = 0; i < Math.min(grid.length, 15); i += 1) {
    if ((grid[i] || []).some((c) => String(c).replace(/\s+/g, '') === '门店名称')) { headerIdx = i; break; }
  }
  const storeRows = [];
  let totalRowFound = false;
  let skippedHeaderRows = 0;
  let nameCol = -1;
  let dateCol = -1;
  if (headerIdx >= 0) {
    // 门店名称列 / 业务日期列：按表头文案定位（身份表头行含「门店名称」）
    nameCol = (grid[headerIdx] || []).findIndex((x) => String(x).replace(/\s+/g, '') === '门店名称');
    dateCol = (grid[headerIdx] || []).findIndex((x) => DATE_HEADER_CANDIDATES.includes(String(x).replace(/\s+/g, '')));
    for (let i = headerIdx + 1; i < grid.length; i += 1) {
      const cells = (grid[i] || []).map((x) => String(x === undefined || x === null ? '' : x).replace(/\s+/g, ' ').trim());
      if (cells.some((c) => /^合计|^总计|^汇总/.test(c))) { totalRowFound = true; break; }
      if (!cells.some((c) => c)) continue;
      // 门店数据行判定：门店名称列非空
      // 依据实测：身份表头下 24 个非空行中恰有 22 行门店名称非空，且这 22 个名称与已确认映射完全一致；
      // 另 2 行是「渠道分组行 / 指标叶子行」（门店名称列为空），必须排除。
      const nm = String((nameCol >= 0 ? cells[nameCol] : '') || '').trim();
      if (!nm) { skippedHeaderRows += 1; continue; }
      storeRows.push({ cells, name: nm, date: dateCol >= 0 ? normDateCell(cells[dateCol]) : null });
    }
  }
  checks.header_found = { ok: headerIdx >= 0, detail: `表头行索引=${headerIdx} 门店名称列=#${nameCol} 营业日期列=#${dateCol}` };
  checks.skipped_non_store_rows = { ok: true, detail: `跳过非门店行 ${skippedHeaderRows} 行（渠道分组行/指标叶子行）` };
  checks.total_row_skipped = { ok: totalRowFound, detail: totalRowFound ? '已识别合计行并跳过，未计入门店行' : '未找到合计行' };

  // ---- 「唯一有效门店数」计数口径（冻结） ----
  const targetDate = isoKey(opts.businessDate);
  const rowsWithDate = storeRows.filter((r) => r.date !== null);
  const rowDateMatched = (r) => (dateCol < 0 ? true : r.date === targetDate);
  const dateMatchedRows = storeRows.filter(rowDateMatched);
  const dateUnmatchedRows = storeRows.filter((r) => !rowDateMatched(r));
  // 门店名去重（同名多次出现 ⇒ 只计一次；重复行不放大计数）
  const uniqNames = [];
  const seenName = new Set();
  for (const r of dateMatchedRows) {
    const k = SMC.keyName(r.name);
    if (!k || seenName.has(k)) continue;
    seenName.add(k);
    uniqNames.push(r.name);
  }
  checks.row_business_date = {
    ok: true, audit_only: true,
    detail: dateCol < 0
      ? `skip: 未在表头定位到业务日期列（已由第2行元数据断言把关）；门店行 ${storeRows.length} 行全部计入`
      : `业务日期列=#${dateCol}，匹配 ${dateMatchedRows.length} 行 / 不匹配 ${dateUnmatchedRows.length} 行${dateUnmatchedRows.length ? '：' + JSON.stringify(dateUnmatchedRows.slice(0, 5).map((r) => r.name)) : ''}`,
    date_column: dateCol, matched_rows: dateMatchedRows.length, unmatched_rows: dateUnmatchedRows.length,
    rows_with_date_value: rowsWithDate.length,
  };

  const ledger = SMC.buildLedger(opts.storeMapping || null);
  const mappingAvailable = ledger.available;
  const mapped = uniqNames.map((n) => Object.assign({ raw: n }, SMC.matchStoreName(n, ledger)));
  const unknownStores = mapped.filter((m) => !m.ok && m.reason === 'unknown').map((m) => m.name);
  const ambiguousStores = mapped.filter((m) => !m.ok && m.reason === 'ambiguous').map((m) => ({ name: m.name, candidates: m.candidates }));
  const mappedOk = mapped.filter((m) => m.ok);
  // 「能精确映射」不可判定（未提供台账）时，唯一有效门店数退化为「业务日期匹配的唯一门店名数」并显式标注口径
  const uniqueValid = mappingAvailable ? mappedOk.length : uniqNames.length;

  const dynamicMode = !(typeof opts.expectedStores === 'number' && Number.isFinite(opts.expectedStores));
  const declaredDynamic = (typeof opts.declaredDynamic === 'number' && Number.isFinite(opts.declaredDynamic)) ? opts.declaredDynamic : null;
  let expected;
  let expectedSource;
  if (!dynamicMode) { expected = opts.expectedStores; expectedSource = 'fixed_explicit'; }
  else if (declaredDynamic !== null) { expected = declaredDynamic; expectedSource = 'declared_dynamic'; }
  else { expected = uniqueValid; expectedSource = 'file_self_reported'; }

  // ---- v0.3.3 金额证据：仅用**精确表头白名单** + 已通过日期/门店校验的门店行 ----
  const AMOUNT_WHITELIST = [ { file_column: '营业收入(元)', key: 'recorded_amount' }, { file_column: '营业额(元)', key: 'gross_amount' }, { file_column: '优惠金额(元)', key: 'discount_amount' } ];
  const amountEvidence = { scope: 'import_batch_id', mappings: [], amount_excel: {}, file_store_rows: storeRows.length, excluded_non_store_rows: skippedHeaderRows, excluded_total_rows: totalRowFound ? 1 : 0 };
  for (const m of AMOUNT_WHITELIST) {
    const col = (grid[headerIdx] || []).findIndex((x) => String(x === undefined || x === null ? '' : x).replace(/\s+/g, '') === m.file_column);
    amountEvidence.mappings.push({ file_column: m.file_column, db_column: m.key });
    if (col < 0) { amountEvidence.amount_excel[m.key] = null; continue; }
    let sum = 0; let cells = 0;
    for (const r of dateMatchedRows) { const raw = String((r.cells || [])[col] === undefined ? '' : r.cells[col]).replace(/[,\s]/g, ''); if (raw === '') continue; const v = Number(raw); if (Number.isFinite(v)) { sum += v; cells += 1; } }
    amountEvidence.amount_excel[m.key] = cells > 0 ? Math.round(sum * 100) / 100 : null;
  }

  checks.store_rows = {
    ok: uniqueValid >= 1 && uniqueValid === expected,
    detail: `唯一有效门店数=${uniqueValid}（期望 ${expected}；来源=${expectedSource}；口径：${mappingAvailable ? '业务日期匹配+门店名非空+可精确映射' : '业务日期匹配+门店名非空（无映射台账，映射口径不可判定）'}；门店行 ${storeRows.length} 行 / 去重前 ${dateMatchedRows.length} 行）`,
    unique_valid_store_count: uniqueValid,
    raw_store_rows: storeRows.length,
    date_matched_rows: dateMatchedRows.length,
    expected,
    expected_source: expectedSource,
    declared_dynamic: declaredDynamic,
    fixed_expected: dynamicMode ? null : opts.expectedStores,
  };

  // 门店名精确映射：文件中出现的每个门店都必须在台账中精确命中（未知/歧义 ⇒ 失败并给名单）
  // coverageRequired=true（生产装配）时**不得**因"台账未注入"而跳过名单闸门：一律 fail-closed。
  if (!mappingAvailable) {
    checks.store_names_known = (opts.coverageRequired === true)
      ? {
        ok: false, reason: 'mapping_ledger_unavailable',
        detail: '未提供源门店名精确映射台账（config/store-mapping.json）⇒ 无法判定未知/歧义门店；自动路径**不得**跳过名单闸门 ⇒ 按 fail-closed 判失败（转人工）',
        unknown: [], ambiguous: [],
      }
      : { ok: true, detail: 'skip: 未提供映射台账（store-mapping.json），未知门店判定不可用（仅记录）', unknown: [], ambiguous: [] };
  } else {
    checks.store_names_known = {
      ok: unknownStores.length === 0 && ambiguousStores.length === 0,
      detail: `未知门店 ${unknownStores.length} 家 ${JSON.stringify(unknownStores)}；歧义门店 ${ambiguousStores.length} 家 ${JSON.stringify(ambiguousStores)}；已精确映射 ${mappedOk.length} 家`,
      unknown: unknownStores, ambiguous: ambiguousStores, mapped_count: mappedOk.length,
    };
  }

  // ---- 在营清单可信度判定（硬规则）----
  // 不可信（ok!==true / active_stores 为 null / truncated=true / active_stores_basis 缺失或为空）
  // ⇒ **不得**做 absent / mapping 覆盖判断，一律转人工（WAITING_HUMAN，零导入零推送）。
  // 合法空集（ok===true 且 active_stores:[] 且 basis 非空）⇒ 只审计、不因 absent 失败。
  // 阶段 1 判据：basis **未确认** === basis 缺失 ⇒ 一律 fail-closed。
  // 兼容开关 allowUnconfirmedBasis（默认 false）可降级为旧行为（absent=unconfirmed 只审计、未知门店仍阻断）。
  const allowUnconfirmedBasis = opts.allowUnconfirmedBasis === true;
  const activeAsmt = SMC.assessActiveStores(
    opts.activeStoresCoverage !== undefined ? opts.activeStoresCoverage : opts.activeStores,
    { allowUnconfirmedBasis: allowUnconfirmedBasis },
  );

  // absent 审计（**只记录，不失败、不补零**）
  const fileMappedIds = mappedOk.map((m) => m.id);
  // 无台账 ⇒ 无法把文件门店名换算成主档 id ⇒ absent 只能记 unknown（**不得**据此判定"未出现门店"）
  const absent = mappingAvailable
    ? SMC.computeAbsent({ coverage: activeAsmt, fileMappedIds, excludedStoreIds: ledger.excluded_ids })
    : { status: 'unknown', reason: 'mapping_unavailable', absent: [], absent_count: null, basis_confirmed: activeAsmt.basis_confirmed };
  checks.absent_stores = {
    ok: true, audit_only: true,
    status: absent.status,
    detail: absent.status === 'known'
      ? `在营 ${absent.active_count} 家，文件出现 ${absent.matched_count} 家，未出现（absent）${absent.absent_count} 家（仅审计：不失败、不补零）${absent.absent_count ? '：' + JSON.stringify(absent.absent.slice(0, 10).map((s) => s.name)) : ''}`
      : (absent.status === 'unconfirmed'
        ? `unconfirmed（active_stores_basis_confirmed=false）⇒ absent 只写审计、不失败、不补零${absent.absent_count ? '：' + JSON.stringify(absent.absent.slice(0, 10).map((s) => s.name)) : ''}`
        : `unknown（${absent.reason}）⇒ 在营清单不可信：**不作** absent 判定、不生成 absent 记录，只记审计`),
    absent: absent.absent, absent_count: absent.absent_count,
    basis_confirmed: absent.basis_confirmed === true,
  };

  const coverage = SMC.checkCoverage({ ledger, coverage: activeAsmt });
  const coverageBlocking = opts.coverageRequired === true;
  // basis_confirmed===false（中控侧尚未确认真实在营判定）：**不得**据此自动判定缺席；
  // 「在营门店缺映射」这一结论同样建立在未确认的基准上 ⇒ 降级为审计（不阻断）；
  // 但台账本身的问题（不可读/未确认/空）与"未知门店"（文件×台账）**仍然阻断**。
  const unconfirmedBasisExempt = coverage.basis_confirmed === false && coverage.reason === 'uncovered_active_stores';
  if (coverage.ok) {
    checks.mapping_coverage = { ok: true, detail: coverage.detail, uncovered: [], active_count: coverage.active_count, covered_count: coverage.covered_count, basis_confirmed: coverage.basis_confirmed === true };
  } else if (coverageBlocking && !unconfirmedBasisExempt) {
    checks.mapping_coverage = {
      ok: false,
      detail: `映射台账覆盖率未通过（${coverage.reason}）：${coverage.detail}${coverage.uncovered.length ? '；缺映射=' + JSON.stringify(coverage.uncovered.map((s) => s.name)) : ''}`,
      reason: coverage.reason, uncovered: coverage.uncovered, trust: coverage.trust,
    };
  } else {
    checks.mapping_coverage = {
      ok: true, audit_only: true,
      detail: unconfirmedBasisExempt
        ? `audit-only（active_stores_basis_confirmed=false ⇒ 不据此判失败）：${coverage.detail}${coverage.uncovered.length ? '；缺映射=' + JSON.stringify(coverage.uncovered.map((s) => s.name)) : ''}`
        : `skip（未要求覆盖率校验）：${coverage.reason}｜${coverage.detail}`,
      reason: coverage.reason, uncovered: coverage.uncovered, trust: coverage.trust,
    };
  }

  // 兼容旧的「双向名单一致性」：**降级为纯审计项**（absent 不再阻断；未知门店由 store_names_known 阻断）
  const storeNames = dateMatchedRows.map((r) => r.name);
  if (opts.expectedStoreNames && opts.expectedStoreNames.length) {
    const exp = new Set(opts.expectedStoreNames.map((x) => String(x).trim()));
    const got = new Set(storeNames.map((x) => String(x).trim()));
    const missing = [...exp].filter((x) => !got.has(x));
    const extra = [...got].filter((x) => !exp.has(x));
    checks.store_names_exact = { ok: missing.length === 0 && extra.length === 0, audit_only: true, detail: `（审计项，不阻断）缺失=${JSON.stringify(missing)} 多余=${JSON.stringify(extra)}` };
  } else {
    checks.store_names_exact = { ok: true, audit_only: true, detail: 'skip: 未提供已确认映射名单（审计项，不阻断）' };
  }

  const failed = Object.entries(checks).filter(([, v]) => !v.ok && v.audit_only !== true).map(([k]) => k);
  return {
    ok: failed.length === 0, checks, errors: failed, row2_items: r2,
    amount_evidence: amountEvidence,
  store_count: storeRows.length, store_names: storeNames, sheet_names: names,
    unique_valid_store_count: uniqueValid,
    declared_dynamic_used: dynamicMode && declaredDynamic !== null ? declaredDynamic : null,
    expected_store_count_used: expected,
    expected_store_count_source: expectedSource,
    mapping_mode: mappingAvailable ? 'ledger' : 'unavailable',
    unknown_stores: unknownStores,
    ambiguous_stores: ambiguousStores,
    absent_stores: absent.absent,
    absent_status: absent.status,
    absent_count: absent.absent_count,
    mapping_coverage: { ok: coverage.ok, reason: coverage.reason, uncovered: coverage.uncovered, blocking: coverageBlocking, trust: coverage.trust, basis_confirmed: coverage.basis_confirmed === true },
    active_stores_trust: activeAsmt.trust,
    active_stores_trust_reason: activeAsmt.reason,
    active_stores_basis: activeAsmt.basis,
    active_stores_basis_confirmed: activeAsmt.basis_confirmed === true,
    allow_unconfirmed_basis: allowUnconfirmedBasis,
    // 导入侧行数期望（fileDataRows）：报表A 的 imported = 门店行数 ×（渠道组数 + 构成组数），
    // 该乘数由中控导入实现决定，文件侧**不可单方面确定** ⇒ 显式置 null，
    // 由「响应自报」兜底（见 phase3/import-audit.expectedFrom/verifyImportResult）。
    data_row_count: null,
    data_row_count_mode: 'not_derivable_from_file',
  };
}

/** 归档命名：同名不覆盖 → 追加时间戳后缀 */
function archiveNameNoOverwrite(srcFile, destDir, desiredName) {
  const name = desiredName || path.basename(srcFile);
  let candidate = name;
  if (fs.existsSync(path.join(destDir, candidate))) {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    candidate = `${stem}.${ts}${ext}`;
    let n = 1;
    while (fs.existsSync(path.join(destDir, candidate))) { candidate = `${stem}.${ts}-${n}${ext}`; n += 1; }
  }
  return candidate;
}

module.exports = { validateReportAFile, archiveNameNoOverwrite, row2Assertions, ALLOWED_EXT, SHEET_NAME, DATE_HEADER_CANDIDATES, normDateCell };
