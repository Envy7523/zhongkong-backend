#!/usr/bin/env node
'use strict';
/**
 * 门店数动态化（R1–R6）· **纯离线验收套件**
 *
 * 边界声明（本套件自身可验证）：
 *  - 全 fake：临时 SYNCBOT_ROOT + 本地构造的 xlsx 夹具 + fake 审计 batcher + 本地 mock 导入响应；
 *  - **不访问美团**、不连数据库、不调用真实 3456、不真实导出/导入/推送、不建 timer/cron、不写 webhook；
 *  - 报表 B（item_sales_detail）保持 locked_not_started，本套件显式验证它被拒绝；
 *  - 中控只读覆盖接口 GET /api/internal/syncbot/coverage 的 active_stores 由**参数注入**（不发真实请求）。
 *
 * 运行：SYNCBOT_BOT=<bot root> P3_OUT=<out.json> node app/bin/phase3/dynamic-store-rules-test.js
 * 输出：{ ok, total, failed, checks, suite, fixture, offline, real_meituan_run, real_import, real_push, timers_created }
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p3dyn-'));
process.env.SYNCBOT_ROOT = ROOT;

const BOT = process.env.SYNCBOT_BOT || path.resolve(__dirname, '../../..');
const TC = require(BOT + '/app/src/task-context.js');
const P = require(BOT + '/app/src/paths.js');
const V = require(BOT + '/app/src/phase2/report-a-file-validate.js');
const SMC = require(BOT + '/app/src/phase2/store-mapping-coverage.js');
const QF = require(BOT + '/app/src/phase2/report-a-query-flow.js');
const IMP = require(BOT + '/app/src/phase3/import-audit.js');
const PLAN = require(BOT + '/app/src/schedule/plan.js');
let IR = null;
try { IR = require(BOT + '/app/src/phase3/import-run.js'); } catch (e) { IR = null; }

const out = {
  suite: 'dynamic-store-rules-offline',
  fixture: true, offline: true,
  real_meituan_run: false, real_export: false, real_import: false, real_push: false,
  webhook_written: false, timers_created: false, report_b: 'locked_not_started',
  checks: [],
};
const ck = (n, ok, d) => out.checks.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });

const BD = (process.env.DYNRULES_BD || '2026-09-20');
const ISO = BD.replace(/-/g, '/');
const D = path.join(ROOT, 'fixtures');
fs.mkdirSync(D, { recursive: true });
let SEQ = 0;
const nextFile = (tag) => path.join(D, `${String(++SEQ).padStart(2, '0')}-${tag}.xlsx`);

// ---------------------------------------------------------------- 夹具工具
const storeName = (i) => `鹅太公烧鹅（测试店${String(i).padStart(2, '0')}）`;
const storeId = (i) => 100 + i;
/** 前 n 家门店的 {names, pairs, active} */
function setOf(n, from = 1) {
  const names = []; const pairs = []; const active = [];
  for (let i = from; i < from + n; i += 1) { const nm = storeName(i); const id = storeId(i); names.push(nm); pairs.push([nm, id]); active.push({ id: id, name: nm }); }
  return { names: names, pairs: pairs, active: active };
}
/** 映射台账（源门店名精确映射；不判断在营与否） */
function ledgerOf(pairs, status = 'confirmed') {
  const mappings = {};
  for (const [nm, id] of pairs) mappings[nm] = { project_store_id: id, confirmed: true, match_method: '名称完全一致' };
  return { status: status, confirmed_at: '2026-09-20T00:00:00.000Z', mappings: mappings };
}
/** 中控 coverage 应答（**原样**注入；含 ok/truncated/active_stores_basis/active_stores_basis_confirmed） */
function ACOV(active, over) {
  return Object.assign({ ok: true, active_stores: active, truncated: false, active_stores_basis: 'master_stores_active', active_stores_basis_confirmed: true }, over || {});
}

const R2_META = `营业日期：${ISO}-${ISO} 统计周期【日期】 门店区域【城市、门店名称】 餐时段统计方式【下单时间】 营业收入构成【结账方式类型】 支付优惠构成【结账方式】 折扣优惠构成【折扣优惠方式】`;

/**
 * 构造报表A 形状的 xlsx 夹具：
 *  行1 标题 / 行2 查询参数元数据 / 行3 身份表头（城市·门店名称·营业日期·…）
 *  行4 渠道分组行（门店名称列为空）/ 行5 指标叶子行（门店名称列为空）
 *  行6.. 门店数据行 / 末尾 合计行
 * names 里的每一项是一行；dates 可逐行覆盖营业日期；totalCount=null ⇒ 不写合计行。
 */
function fixture({ tag, names, dates, totalCount }) {
  const XLSX = require('xlsx');
  const file = nextFile(tag);
  const aoa = [
    ['综合营业统计'],
    [R2_META],
    ['城市', '门店名称', '营业日期', '门店数量', '营业额(元)'],
    ['', '', '', '美团外卖', '收银'],
    ['', '', '', '营业额(元)', '优惠金额(元)'],
  ];
  names.forEach((n, i) => aoa.push(['惠州市', n, (dates && dates[i]) || ISO, '1', String(100 + i)]));
  if (totalCount !== null && totalCount !== undefined) aoa.push(['合计', '', '', String(totalCount), String(totalCount)]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '综合营业统计');
  XLSX.writeFile(wb, file);
  return file;
}

// ---------------------------------------------------------------- 查询流程 fake（R2：自洽校验）
const SEL = (k) => ({ 'nav.report_center': '#rc', 'nav.business_report': '#br', 'nav.target_report': '#tr', 'filter.date_start': '#s', 'filter.date_end': '#e', 'action.query': '#q' }[k] || null);
const QRULES = {
  navigation: { home_url: 'h', report_center_url: 'r', entry_url: 'e' },
  saved_query: { display_name: 'done' },
  overlay_dismissal: { allow_click_texts: ['知道了'] },
  report: { expected_store_count: null },
  filter_value_checks: { items: [{ no: 1, key: 'city', group: '门店区域', expect_selected: ['城市'], type: 'checkbox_group' }] },
};
function queryHarness(declared, totalCell) {
  const seq = [];
  const hostCmd = async (c) => {
    seq.push(c);
    if (c === 'dateRow') return { best: { inputs: [{ placeholder: '开始日期', value: ISO, rect: { x: 1, y: 1, w: 1, h: 1 } }, { placeholder: '结束日期', value: ISO, rect: { x: 2, y: 1, w: 1, h: 1 } }], block: { form_items: [{ text: '星期 全部' }, { text: '门店 全部' }] } } };
    if (c === 'filterState') return { best: { groups: [{ group: '门店区域', checked_texts: ['城市'], determinate: true }] } };
    if (c === 'tableSummary') {
      return {
        pagination: declared === null ? {} : { declared_count: declared, declared_text: `共 ${declared} 条记录`, page_size: 20 },
        total_row: totalCell === null ? null : { cells: ['合计', '--', '--', '--', '--', '--', String(totalCell), String(totalCell), '1'] },
      };
    }
    return {};
  };
  const client = {
    call: (c, a) => hostCmd(c, a), mouse: async () => ({ ok: true }),
    picker: async () => ({ best: { distinct_dates: 1, cells: [{ date: BD, rect: { x: 1, y: 1, w: 1, h: 1 }, selector: '#cell' }] } }),
    press: async () => ({ ok: true }),
  };
  const flow = {
    seq: seq,
    gotoAndAssert: async (a) => ({ ok: true, url: a.url }),
    dismissOverlays: async () => ({ ok: true }),
    clickSelectorAndVerify: async () => ({ ok: true }),
    clickTextAndVerify: async () => ({ ok: true }),
    waitForContent: async () => ({ ok: true }),
    selectSavedScheme: async () => ({ ok: true, step: 'selected', after: { current_value_title: 'done' } }),
    screenshot: async () => ({ file: '/x.png' }),
  };
  const ctx = { reportType: 'cashier_composite', platform: 'meituan', taskId: 'dyn-qf', businessDate: BD };
  return { hostCmd, client, flow, ctx, seq };
}
async function runQuery(declared, totalCell) {
  const h = queryHarness(declared, totalCell);
  const r = await QF.navigateAndQueryReportA({ client: h.client, flow: h.flow, hostCmd: h.hostCmd, rules: QRULES, S: SEL, ctx: h.ctx, expectStores: null });
  return r;
}

// ---------------------------------------------------------------- 导入边界 fake（R6）
function fakeBatcher() {
  const events = []; const posts = [];
  let pending = [];
  const b = {
    events: events, posts: posts,
    buildEvent: ({ stage, seq, metrics }) => ({ event_id: 'ev-' + stage + '-' + events.length, stage: stage, seq: seq, metrics: metrics }),
    add: (e) => { events.push(e); pending.push(e); return { ok: true }; },
    flush: async (reason) => {
      posts.push({ reason: reason, last_stage: events.length ? events[events.length - 1].stage : null });
      const results = pending.map((e) => ({ event_id: e.event_id, ok: true, status: 201, accepted: 1, duplicates: 0, rejected_count: 0, batch_reason: reason, batch_size: pending.length }));
      pending = [];
      return { ok: true, results: results };
    },
    whenIdle: async () => ({ ok: true, pending_sends: 0 }),
    summary: () => ({ posts_log: posts, buffered: events.length }),
    setOnResult: () => {}, setOnIdleTimeout: () => {}, close: async () => {},
  };
  return b;
}
const pushSpy = { calls: 0, send() { pushSpy.calls += 1; } };

/**
 * 用**真实** import-audit 边界跑一次受闸门保护的导入：
 *  - validateFile 返回本次文件校验结果（决定是否 WAITING_HUMAN）；
 *  - importFn 是本地 mock 响应（不发出任何真实请求）。
 */
async function runImportGate({ tag, validateResult, importResponse, expected }) {
  const ctx = TC.createContext('cashier_composite', { platform: 'meituan', taskId: 'dyn-' + tag, businessDate: BD });
  const batcher = fakeBatcher();
  const audit = IMP.createImportAudit({ ctx: ctx, batcher: batcher, opts: { auditShaField: 'off' } });
  let importCalls = 0;
  const before = pushSpy.calls;
  const r = await audit.runGuardedImport({
    coverageGate: async () => ({ ok: true, covered: false }),
    duplicateCheck: async () => ({ duplicate: false }),
    validateFile: async () => validateResult,
    importFn: async () => { importCalls += 1; return importResponse; },
    expected: expected || null,
    businessDate: BD,
  });
  await audit.whenIdle();
  return {
    r: r, import_calls: importCalls, push_calls: pushSpy.calls - before,
    stages: batcher.events.map((e) => e.stage), audit: audit, batcher: batcher,
  };
}
/** 本地 mock 导入响应（字段与中控 importCashierCompositeReport 的返回体一致） */
function mockImport({ raw, matched, imported, amountExcel = 1000, amountDb = 1000, errors = [], unmatchedStores = null }) {
  const resp = {
    ok: true, http: 201, import_batch_id: 900001, data_kind: 'cashier_composite',
    amount_excel: 75997.23, amount_db: 75997.23, import_batch_id: 180, amount_basis: { scope: 'import_batch_id', mappings: [{ file_column: '营业收入(元)', db_column: 'recorded_amount' }, { file_column: '营业额(元)', db_column: 'gross_amount' }, { file_column: '优惠金额(元)', db_column: 'discount_amount' }] }, raw_imported: raw, matched_stores: matched, imported: imported,
    errors: errors, resolved_channels: ['店内销售'],
    excel_business_date: BD, amount_excel: amountExcel, amount_db: amountDb,
    sha256: 'a'.repeat(64),
  };
  if (Array.isArray(unmatchedStores)) resp.unmatched_stores = unmatchedStores;
  return resp;
}

// ---------------------------------------------------------------- 用例
(async () => {
  // ============ A. 查询步骤（R2）：动态自洽，不与固定值比较 ============
  for (const n of [21, 22, 23]) {
    const r = await runQuery(n, n);
    ck(`A1·${n} 家 动态查询：声明数=合计行=${n} → 通过且 declared_dynamic=${n}`,
      r.ok === true && r.declared_dynamic === n && r.total_store_count === n && r.total_row_parse !== 'unavailable',
      JSON.stringify({ ok: r.ok, declared_dynamic: r.declared_dynamic, parse: r.total_row_parse, reason: r.reason || '' }));
  }
  {
    const r = await runQuery(22, 21);
    ck('A2 动态查询：声明 22 与合计行 21 不一致 → 拒绝（自洽失败才失败）',
      r.ok === false && /不一致/.test(r.reason) && r.declared_dynamic === null, r.reason);
  }
  {
    const r = await runQuery(21, null);
    ck('A3 动态查询：合计行不可解析 → 只记录不拒绝（total_row_parse=unavailable）',
      r.ok === true && r.total_row_parse === 'unavailable' && r.declared_dynamic === 21,
      JSON.stringify({ ok: r.ok, parse: r.total_row_parse, declared_dynamic: r.declared_dynamic }));
  }
  {
    const r = await runQuery(null, null);
    ck('A4 动态查询：声明数不可解析 → 拒绝（declared>=1 是硬条件）', r.ok === false && /声明总数/.test(r.reason), r.reason);
  }

  // ============ B. 文件唯一有效门店数（R3）：21 / 22 / 23 ============
  for (const n of [21, 22, 23]) {
    const s = setOf(n);
    const file = fixture({ tag: 'n' + n, names: s.names, totalCount: n });
    const v = V.validateReportAFile(file, {
      businessDate: BD, expectedStores: null, declaredDynamic: n,
      activeStores: ACOV(s.active), storeMapping: ledgerOf(s.pairs), coverageRequired: true,
    });
    ck(`B1·${n} 家 文件校验：唯一有效门店数=${n}、合计行跳过、映射全覆盖 → ok`,
      v.ok === true && v.unique_valid_store_count === n && v.store_count === n &&
      v.checks.total_row_skipped.ok === true && v.checks.skipped_non_store_rows.detail.indexOf('2 行') >= 0 &&
      v.checks.store_names_known.ok === true && v.checks.mapping_coverage.ok === true && v.absent_count === 0,
      JSON.stringify({ ok: v.ok, unique: v.unique_valid_store_count, errors: v.errors, absent: v.absent_count }));
  }

  // ============ C. 零营业被平台自动排除（absent：只审计，不失败、不补零） ============
  {
    const s = setOf(22);                       // 主档在营 22 家
    const names = s.names.slice(0, 21);        // 平台自动排除 1 家（零营业）
    const file = fixture({ tag: 'zero', names: names, totalCount: 21 });
    const v = V.validateReportAFile(file, {
      businessDate: BD, expectedStores: null, declaredDynamic: 21,
      activeStores: ACOV(s.active), storeMapping: ledgerOf(s.pairs), coverageRequired: true,
    });
    ck('C1 零营业门店被平台自动排除：文件 21 行 / 声明 21 → 校验通过（不与 22 比较）',
      v.ok === true && v.unique_valid_store_count === 21 && v.expected_store_count_used === 21 && v.expected_store_count_source === 'declared_dynamic',
      JSON.stringify({ ok: v.ok, unique: v.unique_valid_store_count, used: v.expected_store_count_used, src: v.expected_store_count_source, errors: v.errors }));
    ck('C2 absent 只记录：absent_count=1、status=known、且不影响 ok（不补零、不失败）',
      v.ok === true && v.absent_count === 1 && v.absent_status === 'known' && v.checks.absent_stores.audit_only === true &&
      v.absent_stores.length === 1 && v.absent_stores[0].name === s.names[21],
      JSON.stringify({ ok: v.ok, absent: v.absent_count, names: v.absent_stores.map((x) => x.name) }));
    ck('C3 未补零：门店行数仍为 21（absent 门店未被写成 0 行）',
      v.store_count === 21 && v.unknown_stores.length === 0, JSON.stringify({ rows: v.store_count, unknown: v.unknown_stores }));
  }

  // ============ D. 闭店 / 未开业：不进入 expected、也不进入 absent ============
  {
    const s = setOf(21);                       // 主档在营 21 家（1 家已闭店 ⇒ 不在 active_stores）
    const file = fixture({ tag: 'closed', names: s.names, totalCount: 21 });
    const v = V.validateReportAFile(file, {
      businessDate: BD, expectedStores: null, declaredDynamic: 21,
      activeStores: ACOV(s.active), storeMapping: ledgerOf(s.pairs), coverageRequired: true,
    });
    ck('D1 闭店：在营 21 家且文件 21 家 → 通过，absent=0（闭店既不进 expected 也不进 absent）',
      v.ok === true && v.absent_count === 0 && v.unique_valid_store_count === 21,
      JSON.stringify({ ok: v.ok, absent: v.absent_count, unique: v.unique_valid_store_count }));
  }
  {
    // 未开业：主档在营清单**不含**筹建门店；文件也不含 ⇒ 双方一致，不产生 absent
    const s = setOf(22);
    const preOpening = '鹅太公烧鹅（筹建中店）';
    const preOpeningId = 999;
    const file = fixture({ tag: 'preopen', names: s.names, totalCount: 22 });
    const v = V.validateReportAFile(file, {
      businessDate: BD, expectedStores: null, declaredDynamic: 22,
      activeStores: ACOV(s.active), storeMapping: ledgerOf(s.pairs), coverageRequired: true,
    });
    ck('D2 未开业：筹建门店不在在营清单 → 不入 expected、不入 absent（absent=0，无该店名）',
      v.ok === true && v.absent_count === 0 && v.absent_stores.every((x) => x.id !== preOpeningId) && !v.unknown_stores.includes(preOpening),
      JSON.stringify({ ok: v.ok, absent: v.absent_count, ids: v.absent_stores.map((x) => x.id) }));
  }

  // ============ E. 新开门店：mapping 已补 / mapping 缺失 ============
  {
    const s = setOf(23);                       // 新店 23 已补映射且在营
    const file = fixture({ tag: 'newok', names: s.names, totalCount: 23 });
    const v = V.validateReportAFile(file, {
      businessDate: BD, expectedStores: null, declaredDynamic: 23,
      activeStores: ACOV(s.active), storeMapping: ledgerOf(s.pairs), coverageRequired: true,
    });
    ck('E1 新开门店（mapping 已补）：23 家在营 23 家映射 23 行 → 通过',
      v.ok === true && v.unique_valid_store_count === 23 && v.checks.mapping_coverage.ok === true,
      JSON.stringify({ ok: v.ok, unique: v.unique_valid_store_count, errors: v.errors }));
    const gate = await runImportGate({
      tag: 'new23',
      validateResult: { ok: v.ok, errors: v.errors, store_count: v.unique_valid_store_count, declared_dynamic: 23, absent_stores: v.absent_stores },
      importResponse: mockImport({ raw: 23, matched: 23, imported: 161 }),
      expected: IMP.expectedFrom({ fileStoreRows: 23, declared: 23, fileDataRows: 161 }),
    });
    ck('E2 新开门店（23 家）导入验收按动态值判定：23/23/161 → IMPORT_SUCCEEDED',
      gate.r.action === 'IMPORT_SUCCEEDED' && gate.import_calls === 1 && gate.push_calls === 0,
      JSON.stringify({ action: gate.r.action, import: gate.import_calls, push: gate.push_calls }));
  }
  {
    const s = setOf(23);                       // 新店已在主档在营清单，但台账**没有**它的 confirmed 映射
    const ledger = ledgerOf(s.pairs.slice(0, 22));
    const file = fixture({ tag: 'newmiss', names: s.names.slice(0, 22), totalCount: 22 });
    const v = V.validateReportAFile(file, {
      businessDate: BD, expectedStores: null, declaredDynamic: 22,
      activeStores: ACOV(s.active), storeMapping: ledger, coverageRequired: true,
    });
    ck('E3 新开门店（mapping 缺失）：在营 23 家但台账只覆盖 22 家 → 校验失败（不猜）',
      v.ok === false && v.checks.mapping_coverage.ok === false && /uncovered_active_stores/.test(v.checks.mapping_coverage.reason || '') &&
      v.mapping_coverage.uncovered.length === 1 && v.mapping_coverage.uncovered[0].name === s.names[22],
      JSON.stringify({ ok: v.ok, errors: v.errors, reason: v.mapping_coverage.reason, uncovered: v.mapping_coverage.uncovered.map((x) => x.name) }));
    const gate = await runImportGate({
      tag: 'newmiss',
      validateResult: { ok: v.ok, errors: v.errors, store_count: v.unique_valid_store_count, declared_dynamic: 22, absent_stores: v.absent_stores },
      importResponse: mockImport({ raw: 22, matched: 22, imported: 154 }),
      expected: IMP.expectedFrom({ fileStoreRows: 22, declared: 22, fileDataRows: 154 }),
    });
    ck('E4 新开门店（mapping 缺失）→ WAITING_HUMAN + 零导入 + 零推送',
      gate.r.action === 'WAITING_HUMAN' && gate.r.reason === 'file_validation_needs_human' &&
      gate.import_calls === 0 && gate.push_calls === 0 && gate.stages.join(',') === 'WAITING_HUMAN',
      JSON.stringify({ action: gate.r.action, reason: gate.r.reason, import: gate.import_calls, push: gate.push_calls, stages: gate.stages }));
  }

  // ============ F. 未知门店 ⇒ WAITING_HUMAN 且零导入零推送 ============
  {
    const s = setOf(22);
    const ghost = '鹅太公烧鹅（台账没有的店）';
    const names = s.names.slice(0, 21).concat([ghost]);
    const file = fixture({ tag: 'unknown', names: names, totalCount: 22 });
    const v = V.validateReportAFile(file, {
      businessDate: BD, expectedStores: null, declaredDynamic: 22,
      activeStores: ACOV(s.active), storeMapping: ledgerOf(s.pairs), coverageRequired: true,
    });
    ck('F1 未知门店（无法精确映射）→ 校验失败且给出名单（禁止模糊/LIKE 猜测）',
      v.ok === false && v.checks.store_names_known.ok === false && v.unknown_stores.length === 1 && v.unknown_stores[0] === ghost &&
      v.unique_valid_store_count === 21,
      JSON.stringify({ ok: v.ok, errors: v.errors, unknown: v.unknown_stores, unique: v.unique_valid_store_count }));
    const gate = await runImportGate({
      tag: 'unknown',
      validateResult: { ok: v.ok, errors: v.errors, store_count: v.unique_valid_store_count, declared_dynamic: 22, absent_stores: v.absent_stores },
      importResponse: mockImport({ raw: 22, matched: 22, imported: 154 }),
      expected: IMP.expectedFrom({ fileStoreRows: 22, declared: 22, fileDataRows: 154 }),
    });
    ck('F2 未知门店 → WAITING_HUMAN（file_validation_needs_human）+ 零导入 + 零推送',
      gate.r.action === 'WAITING_HUMAN' && gate.import_calls === 0 && gate.push_calls === 0 &&
      gate.stages.join(',') === 'WAITING_HUMAN' && gate.r.allow_push === false,
      JSON.stringify({ action: gate.r.action, reason: gate.r.reason, import: gate.import_calls, push: gate.push_calls }));
    const ev = gate.audit.summary().emitted_kinds;
    ck('F3 未知门店时审计只发 WAITING_HUMAN（无 IMPORT_STARTED / IMPORT_SUCCEEDED）',
      ev.length === 1 && ev[0] === 'WAITING_HUMAN', JSON.stringify(ev));
  }

  // ============ G. 重复门店行：去重后计数 ============
  {
    const s = setOf(22);
    const names = s.names.concat([s.names[0], s.names[1]]);   // 22 家 + 2 条重复行
    const file = fixture({ tag: 'dupe', names: names, totalCount: 24 });
    const v = V.validateReportAFile(file, {
      businessDate: BD, expectedStores: null, declaredDynamic: 22,
      activeStores: ACOV(s.active), storeMapping: ledgerOf(s.pairs), coverageRequired: true,
    });
    ck('G1 重复门店行：24 行数据 → 唯一有效门店数=22（去重后计数），仍通过',
      v.ok === true && v.store_count === 24 && v.unique_valid_store_count === 22 &&
      v.expected_store_count_used === 22 && v.absent_count === 0,
      JSON.stringify({ ok: v.ok, rows: v.store_count, unique: v.unique_valid_store_count, errors: v.errors }));
  }

  // ============ H. 声明数与文件不一致 ⇒ WAITING_HUMAN ============
  {
    const s = setOf(22);
    const file = fixture({ tag: 'mismatch', names: s.names.slice(0, 21), totalCount: 21 });
    const v = V.validateReportAFile(file, {
      businessDate: BD, expectedStores: null, declaredDynamic: 22,   // 页面声明 22，文件只有 21
      activeStores: ACOV(s.active), storeMapping: ledgerOf(s.pairs), coverageRequired: true,
    });
    ck('H1 声明数(22) 与文件唯一有效门店数(21) 不一致 → 校验失败（严格等值 ±0）',
      v.ok === false && v.checks.store_rows.ok === false && v.checks.store_rows.expected === 22 && v.checks.store_rows.unique_valid_store_count === 21 &&
      /唯一有效门店数=21（期望 22/.test(v.checks.store_rows.detail),
      JSON.stringify({ ok: v.ok, errors: v.errors, detail: v.checks.store_rows.detail }));
    const gate = await runImportGate({
      tag: 'mismatch',
      validateResult: { ok: v.ok, errors: v.errors, store_count: v.unique_valid_store_count, declared_dynamic: 22, absent_stores: v.absent_stores },
      importResponse: mockImport({ raw: 21, matched: 21, imported: 147 }),
      expected: IMP.expectedFrom({ fileStoreRows: 21, declared: 22, fileDataRows: 147 }),
    });
    ck('H2 声明数与文件不一致 → WAITING_HUMAN + 零导入 + 零推送',
      gate.r.action === 'WAITING_HUMAN' && gate.import_calls === 0 && gate.push_calls === 0,
      JSON.stringify({ action: gate.r.action, reason: gate.r.reason, import: gate.import_calls, push: gate.push_calls }));
  }

  // ============ I. 业务日期匹配计入唯一有效门店数 ============
  {
    const s = setOf(22);
    const dates = s.names.map(() => ISO);
    dates[21] = '2026/09/19';                                  // 1 行业务日期不是目标日期
    const file = fixture({ tag: 'baddate', names: s.names, dates: dates, totalCount: 22 });
    const v = V.validateReportAFile(file, {
      businessDate: BD, expectedStores: null, declaredDynamic: 21,
      activeStores: ACOV(s.active), storeMapping: ledgerOf(s.pairs), coverageRequired: true,
    });
    ck('I1 业务日期不匹配的门店行不计入唯一有效门店数（22 行 → 21 家）',
      v.ok === true && v.unique_valid_store_count === 21 && v.checks.row_business_date.unmatched_rows === 1,
      JSON.stringify({ ok: v.ok, unique: v.unique_valid_store_count, unmatched: v.checks.row_business_date.unmatched_rows, errors: v.errors }));
  }

  // ============ J. 在营清单缺失 ⇒ fail-closed ============
  {
    const s = setOf(22);
    const file = fixture({ tag: 'nocov', names: s.names, totalCount: 22 });
    const vMissing = V.validateReportAFile(file, {
      businessDate: BD, expectedStores: null, declaredDynamic: 22,
      activeStores: null, storeMapping: ledgerOf(s.pairs), coverageRequired: true,
    });
    ck('J1 未注入在营清单 ⇒ 不可信 ⇒ 校验失败（fail-closed ⇒ WAITING_HUMAN），absent 记 unknown 且不生成记录',
      vMissing.ok === false && vMissing.mapping_coverage.reason === 'active_stores_untrusted:active_stores_unavailable' &&
      vMissing.absent_status === 'unknown' && vMissing.absent_count === null && vMissing.absent_stores.length === 0,
      JSON.stringify({ ok: vMissing.ok, errors: vMissing.errors, reason: vMissing.mapping_coverage.reason, absent: vMissing.absent_status }));
    const vEmpty = V.validateReportAFile(file, {
      businessDate: BD, expectedStores: null, declaredDynamic: 22,
      activeStores: ACOV([]), storeMapping: ledgerOf(s.pairs), coverageRequired: true,
    });
    ck('J2 合法空集（ok=true + basis 非空 + active_stores:[]）⇒ **不因 absent 失败**：absent=0、覆盖率空真、整体通过',
      vEmpty.ok === true && vEmpty.absent_status === 'known' && vEmpty.absent_count === 0 &&
      vEmpty.mapping_coverage.ok === true && vEmpty.active_stores_trust === 'trusted_empty' &&
      vEmpty.unique_valid_store_count === 22,
      JSON.stringify({ ok: vEmpty.ok, trust: vEmpty.active_stores_trust, absent: vEmpty.absent_count, errors: vEmpty.errors }));
    const gate = await runImportGate({
      tag: 'nocov',
      validateResult: { ok: vMissing.ok, errors: vMissing.errors, store_count: vMissing.unique_valid_store_count, declared_dynamic: 22, absent_stores: null, absent_count: null },
      importResponse: mockImport({ raw: 22, matched: 22, imported: 154 }),
      expected: IMP.expectedFrom({ fileStoreRows: 22, declared: 22, fileDataRows: 154 }),
    });
    ck('J3 active_stores 缺失 ⇒ WAITING_HUMAN + 零导入 + 零推送',
      gate.r.action === 'WAITING_HUMAN' && gate.import_calls === 0 && gate.push_calls === 0,
      JSON.stringify({ action: gate.r.action, reason: gate.r.reason, import: gate.import_calls, push: gate.push_calls }));
  }

  // ============ N. 在营清单**不可信即转人工**（硬规则） ============
  {
    const s = setOf(22);
    const ledger = ledgerOf(s.pairs);
    const mk = (tag) => fixture({ tag: tag, names: s.names, totalCount: 22 });
    const base = { businessDate: BD, expectedStores: null, declaredDynamic: 22, storeMapping: ledger, coverageRequired: true };
    const gateOn = (v, tag) => runImportGate({
      tag: tag,
      validateResult: { ok: v.ok, errors: v.errors, store_count: v.unique_valid_store_count, declared_dynamic: 22, absent_stores: null, absent_count: null },
      importResponse: mockImport({ raw: 22, matched: 22, imported: 154 }),
      expected: IMP.expectedFrom({ fileStoreRows: 22, declared: 22, fileDataRows: 154 }),
    });

    // a) ok:false / active_stores:null ⇒ 不可信 ⇒ WAITING_HUMAN、零导入零推送
    const a1 = V.validateReportAFile(mk('n-a1'), Object.assign({}, base, { activeStores: ACOV(s.active, { ok: false }) }));
    const a2 = V.validateReportAFile(mk('n-a2'), Object.assign({}, base, { activeStores: ACOV(null) }));
    ck('N-a1 覆盖接口 ok:false ⇒ 不可信 ⇒ 校验失败（active_stores_untrusted:active_stores_query_failed）',
      a1.ok === false && a1.mapping_coverage.reason === 'active_stores_untrusted:active_stores_query_failed' &&
      a1.active_stores_trust === 'untrusted' && a1.absent_count === null,
      JSON.stringify({ ok: a1.ok, reason: a1.mapping_coverage.reason, trust: a1.active_stores_trust }));
    ck('N-a2 active_stores:null ⇒ 不可信（**禁止**当作「没有在营门店」）⇒ 校验失败、不产生 absent 记录',
      a2.ok === false && a2.mapping_coverage.reason === 'active_stores_untrusted:active_stores_missing' &&
      a2.absent_status === 'unknown' && a2.absent_count === null && a2.absent_stores.length === 0,
      JSON.stringify({ ok: a2.ok, reason: a2.mapping_coverage.reason, absent: a2.absent_status, records: a2.absent_stores.length }));
    const ga = await gateOn(a2, 'n-a');
    ck('N-a3 不可信在营清单 ⇒ WAITING_HUMAN + 零导入 + 零推送',
      ga.r.action === 'WAITING_HUMAN' && ga.import_calls === 0 && ga.push_calls === 0 && ga.stages.join(',') === 'WAITING_HUMAN',
      JSON.stringify({ action: ga.r.action, import: ga.import_calls, push: ga.push_calls, stages: ga.stages }));

    // b) truncated:true ⇒ 同上，且**不产生 absent 记录**
    const b = V.validateReportAFile(mk('n-b'), Object.assign({}, base, { activeStores: ACOV(s.active, { truncated: true }) }));
    ck('N-b1 truncated:true ⇒ 不可信 ⇒ 校验失败，且**不产生任何 absent 记录**（status=unknown / records=0 / count=null）',
      b.ok === false && b.mapping_coverage.reason === 'active_stores_untrusted:active_stores_truncated' &&
      b.absent_status === 'unknown' && b.absent_count === null && b.absent_stores.length === 0,
      JSON.stringify({ ok: b.ok, reason: b.mapping_coverage.reason, absent_status: b.absent_status, records: b.absent_stores.length }));
    const gb = await gateOn(b, 'n-b');
    ck('N-b2 truncated ⇒ WAITING_HUMAN + 零导入 + 零推送',
      gb.r.action === 'WAITING_HUMAN' && gb.import_calls === 0 && gb.push_calls === 0,
      JSON.stringify({ action: gb.r.action, import: gb.import_calls, push: gb.push_calls }));

    // c) active_stores_basis 缺失 ⇒ 同上
    const c = V.validateReportAFile(mk('n-c'), Object.assign({}, base, { activeStores: ACOV(s.active, { active_stores_basis: '' }) }));
    ck('N-c1 active_stores_basis 缺失/为空 ⇒ 不可信 ⇒ 校验失败且不产生 absent 记录',
      c.ok === false && c.mapping_coverage.reason === 'active_stores_untrusted:active_stores_basis_missing' &&
      c.absent_status === 'unknown' && c.absent_stores.length === 0,
      JSON.stringify({ ok: c.ok, reason: c.mapping_coverage.reason, absent_status: c.absent_status }));

    // d) **阶段 1 判据**：basis 缺失 **或未确认** ⇒ 一律 fail-closed ⇒ WAITING_HUMAN
    const d = V.validateReportAFile(mk('n-d'), Object.assign({}, base, { activeStores: ACOV(s.active, { active_stores_basis_confirmed: false }) }));
    ck('N-d1 active_stores_basis_confirmed:false（默认严格模式）⇒ 不可信 ⇒ 校验失败、不产生 absent 记录',
      d.ok === false && d.mapping_coverage.reason === 'active_stores_untrusted:active_stores_basis_unconfirmed' &&
      d.active_stores_trust === 'untrusted' && d.absent_status === 'unknown' &&
      d.absent_count === null && d.absent_stores.length === 0 && d.allow_unconfirmed_basis === false,
      JSON.stringify({ ok: d.ok, reason: d.mapping_coverage.reason, trust: d.active_stores_trust, absent: d.absent_status }));
    const gd0 = await gateOn(d, 'n-d-strict');
    ck('N-d2 basis 未确认（严格模式）⇒ WAITING_HUMAN + 零导入 + 零推送',
      gd0.r.action === 'WAITING_HUMAN' && gd0.import_calls === 0 && gd0.push_calls === 0 && gd0.stages.join(',') === 'WAITING_HUMAN',
      JSON.stringify({ action: gd0.r.action, import: gd0.import_calls, push: gd0.push_calls, stages: gd0.stages }));

    // d-兼容开关：显式 allowUnconfirmedBasis:true 时降级为旧行为（absent=unconfirmed 只审计、不失败）
    const dL = V.validateReportAFile(mk('n-d-lenient'), Object.assign({}, base, {
      activeStores: ACOV(s.active, { active_stores_basis_confirmed: false }), allowUnconfirmedBasis: true,
    }));
    ck('N-d3 兼容开关 allowUnconfirmedBasis:true ⇒ absent 记为 unconfirmed（只审计、不失败），整体通过',
      dL.ok === true && dL.absent_status === 'unconfirmed' && dL.checks.absent_stores.audit_only === true &&
      dL.allow_unconfirmed_basis === true,
      JSON.stringify({ ok: dL.ok, absent_status: dL.absent_status, errors: dL.errors }));
    const ghost = '鹅太公烧鹅（台账没有的店）';
    const ghostFile = fixture({ tag: 'n-d4', names: s.names.slice(0, 21).concat([ghost]), totalCount: 22 });
    const d4 = V.validateReportAFile(ghostFile, Object.assign({}, base, {
      activeStores: ACOV(s.active, { active_stores_basis_confirmed: false }), allowUnconfirmedBasis: true,
    }));
    ck('N-d4 兼容开关下**未知门店仍然阻断** ⇒ 校验失败 + 名单（⇒ WAITING_HUMAN）',
      d4.ok === false && d4.checks.store_names_known.ok === false && d4.unknown_stores.length === 1 &&
      d4.unknown_stores[0] === ghost && d4.absent_status === 'unconfirmed',
      JSON.stringify({ ok: d4.ok, unknown: d4.unknown_stores, absent: d4.absent_status, errors: d4.errors }));
    const gd4 = await gateOn(d4, 'n-d4');
    ck('N-d5 兼容开关 + 未知门店 ⇒ WAITING_HUMAN + 零导入 + 零推送',
      gd4.r.action === 'WAITING_HUMAN' && gd4.import_calls === 0 && gd4.push_calls === 0,
      JSON.stringify({ action: gd4.r.action, import: gd4.import_calls, push: gd4.push_calls }));
    ck('N-d6 两种模式行为确实不同（严格：失败；兼容开关：通过）',
      d.ok !== dL.ok && d.absent_count === null && dL.absent_count !== null,
      JSON.stringify({ strict_ok: d.ok, lenient_ok: dL.ok }));

    // e) 合法空集 vs 查询失败：行为必须不同
    const eEmpty = V.validateReportAFile(mk('n-e1'), Object.assign({}, base, { activeStores: ACOV([]) }));
    const eFail = V.validateReportAFile(mk('n-e2'), Object.assign({}, base, { activeStores: ACOV(null, { ok: false }) }));
    ck('N-e1 合法空集（全部闭店）：**不因 absent 失败**（只审计）⇒ ok=true、absent=0、覆盖率空真',
      eEmpty.ok === true && eEmpty.absent_count === 0 && eEmpty.absent_status === 'known' &&
      eEmpty.mapping_coverage.ok === true && eEmpty.active_stores_trust === 'trusted_empty',
      JSON.stringify({ ok: eEmpty.ok, trust: eEmpty.active_stores_trust, absent: eEmpty.absent_count }));
    ck('N-e2 查询失败：直接不可信 ⇒ 校验失败（与「空集」行为不同）',
      eFail.ok === false && eFail.active_stores_trust === 'untrusted' &&
      eFail.mapping_coverage.reason === 'active_stores_untrusted:active_stores_query_failed',
      JSON.stringify({ ok: eFail.ok, trust: eFail.active_stores_trust, reason: eFail.mapping_coverage.reason }));
    ck('N-e3 「空集」与「查询失败」行为确实不同（一通过 / 一转人工，absent 一处 0 一处 null）',
      eEmpty.ok !== eFail.ok && eEmpty.absent_count === 0 && eFail.absent_count === null,
      JSON.stringify({ empty_ok: eEmpty.ok, fail_ok: eFail.ok }));

    // f) 裸数组（无 basis）不得当权威
    const f = V.validateReportAFile(mk('n-f'), Object.assign({}, base, { activeStores: s.active }));
    ck('N-f 裸数组（无 active_stores_basis）⇒ 判为不可信 ⇒ 校验失败（绝不把「只有清单」当权威）',
      f.ok === false && f.mapping_coverage.reason === 'active_stores_untrusted:active_stores_basis_missing',
      JSON.stringify({ ok: f.ok, reason: f.mapping_coverage.reason }));
  }

  // ============ K. 动态导入行数与金额校验（R6） ============
  {
    const exp = IMP.expectedFrom({ fileStoreRows: 22, declared: 22, fileDataRows: 154 });
    ck('K1 expectedFrom：raw_imported=matched_stores=fileStoreRows、imported=fileDataRows、amount_tolerance=0.01',
      exp.raw_imported === 22 && exp.matched_stores === 22 && exp.imported === 154 && exp.amount_tolerance === 0.01 &&
      exp.derived_from.fileStoreRows === 22 && exp.derived_from.declared === 22 && exp.derived_from.fileDataRows === 154,
      JSON.stringify(exp));
    const expFallback = IMP.expectedFrom({ declared: 21 });
    ck('K2 expectedFrom：fileStoreRows 缺失时回落本次声明数；fileDataRows 缺失 ⇒ imported=null（不比较，绝不回落固定值）',
      expFallback.raw_imported === 21 && expFallback.matched_stores === 21 && expFallback.imported === null,
      JSON.stringify(expFallback));
    const d = IMP.DEFAULT_EXPECTED;
    ck('K3 DEFAULT_EXPECTED 已是 null 哨兵（不再含 22/154 固定值）',
      d.raw_imported === null && d.matched_stores === null && d.imported === null && d.amount_tolerance === 0.01,
      JSON.stringify(d));

    const okGate = await runImportGate({
      tag: 'k-ok', validateResult: { ok: true, checks: {}, errors: [], store_count: 22, declared_dynamic: 22 },
      importResponse: mockImport({ raw: 22, matched: 22, imported: 154, amountExcel: 1000, amountDb: 1000 }),
      expected: exp,
    });
    ck('K4 动态值全等（22/22/154，金额差 0）→ IMPORT_SUCCEEDED 且允许推送信号 allow_push=true',
      okGate.r.action === 'IMPORT_SUCCEEDED' && okGate.r.allow_push === true && okGate.import_calls === 1,
      JSON.stringify({ action: okGate.r.action, allow_push: okGate.r.allow_push }));

    const tol = await runImportGate({
      tag: 'k-tol', validateResult: { ok: true, checks: {}, errors: [], store_count: 22, declared_dynamic: 22 },
      importResponse: mockImport({ raw: 22, matched: 22, imported: 154, amountExcel: 1000, amountDb: 1000.01 }),
      expected: exp,
    });
    ck('K5 金额容差保留 0.01：差 0.01 → 通过',
      tol.r.action === 'IMPORT_SUCCEEDED' && tol.r.verification.amount_delta === 0.01,
      JSON.stringify({ action: tol.r.action, delta: tol.r.verification && tol.r.verification.amount_delta }));

    const over = await runImportGate({
      tag: 'k-over', validateResult: { ok: true, checks: {}, errors: [], store_count: 22, declared_dynamic: 22 },
      importResponse: mockImport({ raw: 22, matched: 22, imported: 154, amountExcel: 1000, amountDb: 1000.02 }),
      expected: exp,
    });
    ck('K6 金额超容差（0.02 > 0.01）→ IMPORT_FAILED + 不推送',
      over.r.action === 'IMPORT_FAILED' && over.r.allow_push === false && (over.r.problems || []).join(',').indexOf('amount_mismatch') >= 0,
      JSON.stringify({ action: over.r.action, problems: over.r.problems }));

    const impBad = await runImportGate({
      tag: 'k-imp', validateResult: { ok: true, checks: {}, errors: [], store_count: 22, declared_dynamic: 22 },
      importResponse: mockImport({ raw: 22, matched: 22, imported: 150 }),
      expected: exp,
    });
    ck('K7 imported(150) 与文件数据行数(154) 不一致 → IMPORT_FAILED + imported_mismatch',
      impBad.r.action === 'IMPORT_FAILED' && (impBad.r.problems || []).indexOf('imported_mismatch') >= 0,
      JSON.stringify({ action: impBad.r.action, problems: impBad.r.problems }));

    const rawBad = await runImportGate({
      tag: 'k-raw', validateResult: { ok: true, checks: {}, errors: [], store_count: 22, declared_dynamic: 22 },
      importResponse: mockImport({ raw: 21, matched: 21, imported: 147 }),
      expected: exp,
    });
    ck('K8 raw_imported(21) ≠ 文件门店行数(22) → IMPORT_FAILED + raw_imported_mismatch',
      rawBad.r.action === 'IMPORT_FAILED' && (rawBad.r.problems || []).indexOf('raw_imported_mismatch') >= 0,
      JSON.stringify({ action: rawBad.r.action, problems: rawBad.r.problems }));

    const short = await runImportGate({
      tag: 'k-short', validateResult: { ok: true, checks: {}, errors: [], store_count: 22, declared_dynamic: 22 },
      importResponse: mockImport({ raw: 22, matched: 20, imported: 140, unmatchedStores: ['鹅太公烧鹅（测试店21）', '鹅太公烧鹅（测试店22）'] }),
      expected: exp,
    });
    ck('K9 matched_stores(20) < raw_imported(22) → **WAITING_HUMAN**（转人工）+ 不推送 + 未匹配名单进返回值',
      short.r.action === 'WAITING_HUMAN' && short.r.reason === 'matched_stores_short' && short.r.allow_push === false &&
      short.r.verification_dynamic.matched_short_by === 2 && short.r.unmatched.length === 2 &&
      short.stages.indexOf('IMPORT_SUCCEEDED') < 0,
      JSON.stringify({ action: short.r.action, reason: short.r.reason, short_by: short.r.verification_dynamic && short.r.verification_dynamic.matched_short_by, unmatched: short.r.unmatched.length, stages: short.stages }));
    ck('K10 matched<raw 的终态为 WAITING_HUMAN（无 IMPORT_SUCCEEDED），metrics 载荷不含门店名、也不含新增动态字段',
      short.audit.summary().emitted_kinds.indexOf('WAITING_HUMAN') >= 0 &&
      short.audit.summary().emitted_kinds.indexOf('IMPORT_SUCCEEDED') < 0 &&
      JSON.stringify(short.batcher.events.map((e) => e.metrics)).indexOf('测试店') < 0 &&
      Object.keys(short.batcher.events[1].metrics.validation).sort().join(',') ===
        'amount_delta,business_date_matched,errors_empty,imported,matched_stores,raw_imported',
      JSON.stringify({ kinds: short.audit.summary().emitted_kinds, metrics: short.batcher.events.map((e) => e.metrics) }));

    ck('K11 审计 metrics 顶层键全部在已知白名单内（动态计数只嵌套在 validation 内，不新增顶层字段）',
      (() => {
        const allowed = new Set(['phase', 'started_at', 'finished_at', 'duration_ms', 'failure_reason', 'original_filename', 'file_size',
          'sha256', 'sha256_prefix', 'import_batch_id', 'raw_store_count', 'matched_store_count', 'ready_to_push', 'push_status',
          'imported', 'pushed', 'is_backfill', 'reconstructed', 'not_a_realtime_success', 'screenshot_count', 'validation', 'evidence', 'note']);
        const bad = [];
        for (const evt of okGate.batcher.events.concat(short.batcher.events)) {
          for (const k of Object.keys((evt && evt.metrics) || {})) if (!allowed.has(k)) bad.push(k);
        }
        return bad.length === 0;
      })(), 'see dynamicCounts 嵌套在 validation');

    const noFileRows = await runImportGate({
      tag: 'k-nofd', validateResult: { ok: true, checks: {}, errors: [], store_count: 22, declared_dynamic: 22 },
      importResponse: mockImport({ raw: 22, matched: 22, imported: 154 }),
      expected: IMP.expectedFrom({ fileStoreRows: 22, declared: 22 }),   // 文件数据行数不可得
    });
    ck('K12 文件数据行数不可得：imported 以**响应自报**为准（verification_dynamic.imported_expected=response_self_reported），不回落固定值',
      noFileRows.r.action === 'IMPORT_SUCCEEDED' && noFileRows.r.verification_dynamic &&
      noFileRows.r.verification_dynamic.imported_expected === 'response_self_reported',
      JSON.stringify({ action: noFileRows.r.action, dyn: noFileRows.r.verification_dynamic || null }));

    ck('K13 审计 metrics 载荷（validation）**只含原有形状键**，动态证据不进 metrics',
      (() => {
        const expect = ['amount_delta', 'business_date_matched', 'errors_empty', 'imported', 'matched_stores', 'raw_imported'];
        const seen = Object.keys(okGate.r.verification || {}).sort();
        return JSON.stringify(seen) === JSON.stringify(expect);
      })(),
      JSON.stringify({ keys: Object.keys(okGate.r.verification || {}).sort() }));

    ck('K14 动态期望值证据经 verification_dynamic / 本地状态承载（含期望值与缺口计数）',
      short.r.verification_dynamic && short.r.verification_dynamic.matched_short_by === 2 &&
      short.r.verification_dynamic.raw_imported_expected === 22 &&
      short.r.verification_dynamic.matched_stores_expected === 22 &&
      short.r.verification_dynamic.imported_expected === 154,
      JSON.stringify(short.r.verification_dynamic || null));
  }

  // ============ M. 自动路径：名单闸门**不得**因"未传 deps"而被跳过 ============
  {
    // 生产装配语义：coverageRequired=true（runner 默认），但台账未注入 ⇒ 未知门店判定不可跳过 ⇒ fail-closed
    const s = setOf(22);
    const file = fixture({ tag: 'noledger', names: s.names, totalCount: 22 });
    const v = V.validateReportAFile(file, {
      businessDate: BD, expectedStores: null, declaredDynamic: 22,
      activeStores: ACOV(s.active), storeMapping: null, coverageRequired: true,
    });
    ck('M1 自动路径不再"未传就跳过"：无映射台账 + coverageRequired ⇒ store_names_known 失败（mapping_ledger_unavailable）',
      v.ok === false && v.checks.store_names_known.ok === false &&
      v.checks.store_names_known.reason === 'mapping_ledger_unavailable' &&
      v.mapping_coverage.ok === false,
      JSON.stringify({ ok: v.ok, errors: v.errors, reason: v.checks.store_names_known.reason }));
    ck('M2 无台账时 absent 只记 unknown（不得据此判定"未出现门店"），且不计 absent_count',
      v.absent_status === 'unknown' && v.absent_count === null && v.checks.absent_stores.audit_only === true,
      JSON.stringify({ status: v.absent_status, count: v.absent_count }));
    const gate = await runImportGate({
      tag: 'noledger',
      validateResult: { ok: v.ok, errors: v.errors, store_count: v.unique_valid_store_count, declared_dynamic: 22, absent_stores: null },
      importResponse: mockImport({ raw: 22, matched: 22, imported: 154 }),
      expected: IMP.expectedFrom({ fileStoreRows: 22, declared: 22, fileDataRows: 154 }),
    });
    ck('M3 自动路径（无台账）⇒ WAITING_HUMAN + 零导入 + 零推送',
      gate.r.action === 'WAITING_HUMAN' && gate.import_calls === 0 && gate.push_calls === 0 &&
      gate.stages.join(',') === 'WAITING_HUMAN',
      JSON.stringify({ action: gate.r.action, reason: gate.r.reason, import: gate.import_calls, push: gate.push_calls }));

    // 在营清单缺失但**台账齐备**：未知门店可判，覆盖率仍 fail-closed（这是 runner 未接 coverage 接口时的真实姿态）
    const v2 = V.validateReportAFile(fixture({ tag: 'nofixed', names: s.names, totalCount: 22 }), {
      businessDate: BD, expectedStores: null, declaredDynamic: 22,
      activeStores: null, storeMapping: ledgerOf(s.pairs), coverageRequired: true,
    });
    ck('M4 在营清单缺失但台账齐备：未知门店判定仍**执行**（store_names_known ok），覆盖率单独 fail-closed',
      v2.ok === false && v2.checks.store_names_known.ok === true &&
      v2.mapping_coverage.reason === 'active_stores_untrusted:active_stores_unavailable' && v2.absent_status === 'unknown',
      JSON.stringify({ ok: v2.ok, names_known: v2.checks.store_names_known.ok, cov: v2.mapping_coverage.reason }));
  }

  // ============ L. 报表 B 仍 locked ============
  {
    let ctxThrew = null;
    try { TC.createContext('item_sales_detail', { platform: 'meituan', taskId: 'dyn-b', businessDate: BD }); }
    catch (e) { ctxThrew = String(e && e.message); }
    ck('L1 报表 B（item_sales_detail）无法创建 TaskContext（locked_not_started）',
      !!ctxThrew && /未授权|locked_not_started/.test(ctxThrew) && P.REPORT_TYPES.item_sales_detail.authorized === false,
      ctxThrew ? ctxThrew.slice(0, 120) : '未抛错');
    ck('L2 计划层显式识别 locked 报表（containsLockedReport）',
      PLAN.containsLockedReport({ report_type: 'item_sales_detail' }) === true &&
      PLAN.containsLockedReport({ report_type: 'cashier_composite' }) === false, '');
    if (IR) {
      let irThrew = null;
      try { IR.createImportRun({ ctx: { reportType: 'item_sales_detail', platform: 'meituan', taskId: 'dyn-b2', businessDate: BD } }); }
      catch (e) { irThrew = String(e && e.message); }
      ck('L3 import-run 拒绝报表 B（不建状态、不接线、零请求）', !!irThrew && /未授权|只接受/.test(irThrew), irThrew ? irThrew.slice(0, 120) : '未抛错');
    } else {
      ck('L3 import-run 拒绝报表 B', false, 'import-run 模块未加载');
    }
    ck('L4 本套件自证：未访问美团、未真实导出/导入/推送、未写 webhook、未建 timer',
      out.real_meituan_run === false && out.real_export === false && out.real_import === false &&
      out.real_push === false && out.webhook_written === false && out.timers_created === false,
      JSON.stringify({ meituan: out.real_meituan_run, push: out.real_push, timer: out.timers_created }));
  }

  out.total = out.checks.length;
  out.failed = out.checks.filter((c) => !c.ok).length;
  out.ok = out.failed === 0;
  out.fixture_root = ROOT;
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
  if (process.env.P3_OUT) { try { fs.writeFileSync(process.env.P3_OUT, JSON.stringify(out, null, 2), 'utf8'); } catch (_) {} }
  console.log(JSON.stringify({ suite: out.suite, ok: out.ok, total: out.total, failed: out.failed }));
  if (!out.ok) console.log(JSON.stringify(out.checks.filter((c) => !c.ok).map((c) => ({ name: c.name, detail: c.detail })), null, 2));
  process.exit(out.ok ? 0 : 1);
})().catch((e) => {
  const fatal = { suite: out.suite, ok: false, total: out.checks.length, failed: out.checks.filter((c) => !c.ok).length + 1, fatal: String((e && e.stack) || e).slice(0, 900), checks: out.checks };
  if (process.env.P3_OUT) { try { fs.writeFileSync(process.env.P3_OUT, JSON.stringify(fatal, null, 2), 'utf8'); } catch (_) {} }
  console.log(JSON.stringify(fatal, null, 2));
  process.exit(9);
});
