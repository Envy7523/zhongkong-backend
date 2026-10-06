'use strict';
/**
 * 真实下载测试 · 最终执行入口（**仅接线**；不含业务逻辑）
 *
 * 用法（三个参数必须同时给出；--date 必须是严格 YYYY-MM-DD，非法即拒绝、不访问浏览器、不写任务状态）：
 *   node src/phase2/real-download-run.js --confirm-real-download --report-type=cashier_composite --date=YYYY-MM-DD
 * 入口自检（fake adapter 接线 smoke test；不访问浏览器）：
 *   node src/phase2/real-download-run.js --smoke
 *
 * 业务日期的唯一来源是 CLI --date：TaskContext.businessDate 由它创建，并被逐层透传，
 * 因而「页面日期设置 / 查询结果校验 / 文件第 2 行元数据校验 / 归档目录 / 任务状态文件」
 * 全部派生自同一个日期。本文件**不得**再出现任何隐含固定业务日期的写法。
 *
 * 职责：解析 CLI → 建 TaskContext → 取任务锁 → 装配 production adapters 与 orchestrator
 *       → run() → finally 复位 approvals → 输出 task state 与退出码。
 * 不做：导入 / 推送 / timer / 写项目数据库 / 触碰报表B。
 */
const fs = require('fs');
const path = require('path');
const P = require('../paths');
const TC = require('../task-context');
const lock = require('../lock');
const { createTaskLogger } = require('../logger');
const { createOrchestrator } = require('./real-download');
const { createProductionAdapters } = require('./real-download-adapters');
const fileValidate = require('./report-a-file-validate');
const archiveMod = require('../archive');
const client = require('./client');
const flow = require('./meituan-flow');
const selectors = require('./selectors');
const config = require('../config');

const EXPECT = { confirm: '--confirm-real-download', reportType: 'cashier_composite' };
const BUSINESS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const APPROVAL_TTL_MS = 40 * 60 * 1000;   // 单次任务授权上限
const LOCK_NAME = 'meituan-download';

function parseArgs(argv) {
  const a = {};
  for (const x of argv) { const m = /^--([^=]+)(?:=(.*))?$/.exec(x); if (m) a[m[1]] = m[2] === undefined ? true : m[2]; }
  return a;
}

/**
 * 严格业务日期校验：必须精确为 YYYY-MM-DD，且必须是真实存在的日历日期。
 * 显式拒绝：2026-9-18（未补零）、20260918、2026/09/18、2026-13-01、2026-02-30、空值等。
 */
function isValidBusinessDate(value) {
  if (value === undefined || value === null || value === true) return false;
  const s = String(value);
  if (!BUSINESS_DATE_RE.test(s)) return false;
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(5, 7));
  const day = Number(s.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // 反向校验：日历上不存在的日期（如 02-30）经 Date 归一化后会与输入不一致
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

/** 严格启动条件校验；不满足返回拒绝原因（纯函数，无任何 I/O，因此拒绝路径零浏览器访问） */
function validateStartArgs(args) {
  const problems = [];
  if (!args['confirm-real-download']) problems.push(`缺少 ${EXPECT.confirm}`);
  if (args['report-type'] !== EXPECT.reportType) problems.push(`--report-type 必须精确为 ${EXPECT.reportType}（实际 ${args['report-type']}）`);
  if (!isValidBusinessDate(args.date)) {
    problems.push(`--date 必须严格为 YYYY-MM-DD 且为真实存在的日历日期（实际 ${args.date === undefined ? '(未提供)' : JSON.stringify(args.date)}）`);
  }
  const extra = Object.keys(args).filter((k) => !['confirm-real-download', 'report-type', 'date', 'smoke', 'active-stores'].includes(k));
  if (extra.length) problems.push(`不接受的额外参数：${extra.join(', ')}`);
  for (const [k, v] of Object.entries(args)) {
    if (String(v).includes('item_sales_detail')) problems.push(`禁止：参数 ${k} 含 item_sales_detail（报表B 锁定）`);
  }
  return problems;
}

/** 带任务绑定 + 过期保护的 approvals 存储（入口自建，不改适配器） */
function makeBoundApprovals(taskId, log, fileOverride) {
  // fileOverride：自检时指向临时文件，绝不触碰真实 approvals.json
  const file = fileOverride || path.join(P.runtime, 'approvals.json');
  const readRaw = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const writeRaw = (o) => fs.writeFileSync(file, JSON.stringify(o, null, 2));
  return {
    file,
    readRaw,
    writeRaw,
    /** 供适配器读取：只有「绑定本任务 且 未过期」的 true 才算授权 */
    async read() {
      const o = readRaw();
      const bound = o.temporary_for_task === taskId;
      const until = Date.parse(o.temporary_until || '');
      const fresh = Number.isFinite(until) && Date.now() < until;
      const stale = ['export_submit', 'download_list', 'download_file'].some((k) => o[k] === true) && !(bound && fresh);
      if (stale) {
        log.push({ event: 'stale_approval_refused', at: new Date().toISOString(), temporary_for_task: o.temporary_for_task || null, temporary_until: o.temporary_until || null });
        writeRaw(Object.assign({}, o, { export_submit: false, download_list: false, download_file: false, temporary_for_task: null, temporary_until: null, stale_reset_at: new Date().toISOString() }));
        return { export_submit: false, download_list: false, download_file: false };
      }
      return { export_submit: o.export_submit === true, download_list: o.download_list === true, download_file: o.download_file === true };
    },
    async write(next) {
      const o = readRaw();
      const on = next && (next.export_submit === true || next.download_list === true || next.download_file === true);
      const merged = Object.assign({}, o, next);
      if (on) { merged.temporary_for_task = taskId; merged.temporary_until = new Date(Date.now() + APPROVAL_TTL_MS).toISOString(); }
      else { merged.export_submit = false; merged.download_list = false; merged.download_file = false; merged.temporary_for_task = null; merged.temporary_until = null; }
      writeRaw(merged);
    },
    isStaleTrue() {
      const o = readRaw();
      return ['export_submit', 'download_list', 'download_file'].some((k) => o[k] === true) && o.temporary_for_task !== taskId;
    },
  };
}

/** 等待下载文件落盘（仅接线；不含业务判断） */
async function waitForDownloadFile({ dir, timeoutMs = 120000, pollMs = 2000, startedAt = Date.now() }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    const cand = names
      .filter((n) => /\.(xlsx|xls|csv)$/i.test(n) && !/\.crdownload$/i.test(n))
      .map((n) => ({ n, st: fs.statSync(path.join(dir, n)) }))
      .filter((x) => x.st.mtimeMs >= startedAt - 3000 && x.st.size > 0)
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    if (cand.length) return { ok: true, file: path.join(dir, cand[0].n), name: cand[0].n, size: cand[0].st.size };
    if (Date.now() >= deadline) return { ok: false, reason: `等待 ${timeoutMs}ms 未出现新报表文件` };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** smoke 专用：生成严格晚于当前时间的申请时间字符串（YYYY/M/D HH:mm:ss） */
function futureApply() {
  const d = new Date(Date.now() + 300000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 在营门店清单注入点（口径冻结 §4）：只接受**中控只读接口**
 *   GET /api/internal/syncbot/coverage?business_date=YYYY-MM-DD
 * 响应（或其中的 active_stores:[{id,name}]）的**本地落盘文件**；本 CLI 不直连项目库、不发任何请求。
 * 未提供 ⇒ 覆盖率校验不启用（人工路径）；每日自动路径**始终** fail-closed（见 real-download-adapters）。
 */
function loadActiveStores(file) {
  if (typeof file !== 'string' || !file) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 裸数组：合法的"只有清单"注入（**无** basis ⇒ 由裁决层判为不可信，fail-closed）
    if (Array.isArray(j)) return j;
    // 对象：应为中控 coverage 应答原样（ok/active_stores/truncated/active_stores_basis/active_stores_basis_confirmed）
    if (j && typeof j === 'object') return j;
    return null;
  } catch (_) { return null; }
}
/** 注入文件 → 覆盖快照（**不做**任何"空/null 即无在营门店"的推断） */
function coverageFromInjection(injected) {
  if (injected === null || injected === undefined) return null;
  if (Array.isArray(injected)) {
    return { ok: true, active_stores: injected, truncated: false, active_stores_basis: null, active_stores_basis_confirmed: false };
  }
  return injected;
}
/** 注入文件 → 审计用名单（在营门店名）；仅用于 expectedStoreNames（不阻断） */
function namesFromInjection(injected) {
  if (Array.isArray(injected)) return injected;
  if (injected && Array.isArray(injected.active_stores)) return injected.active_stores;
  return null;
}
/** 源门店名精确映射台账（config/store-mapping.json，只读） */
function loadStoreMapping() {
  try { return JSON.parse(fs.readFileSync(path.join(P.config, 'store-mapping.json'), 'utf8')); } catch (_) { return null; }
}

/**
 * 期望门店名单（口径冻结：**动态**，不再是固定 22 条）。
 *  主档在营 ∪ 文件出现 —— 「主档在营」来自 --active-stores（中控只读接口 coverage.active_stores）；
 *  「文件出现」由 report-a-file-validate 的 store_names_known 逐行精确映射覆盖。
 * 该名单在本流程里**只作审计**（checks.store_names_exact，audit_only），阻断由
 * store_names_known（未知/歧义门店）与 mapping_coverage（台账覆盖率）承担。
 * 未提供在营清单时退化为台账已确认源门店名（仅审计基线），**不构成任何闸门**。
 */
function expectedStoreNamesFor(activeStores) {
  if (Array.isArray(activeStores) && activeStores.length) {
    const names = activeStores.map((s) => String((s && (s.name || s.store_name)) || '').trim()).filter(Boolean);
    if (names.length) return names;
  }
  return confirmedStoreNames();
}

function confirmedStoreNames() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(P.config, 'store-mapping.json'), 'utf8'));
    const m = j.mappings || {};
    const names = Object.keys(m).filter((k) => m[k] && m[k].confirmed === true);
    return names.length ? names : undefined;
  } catch { return undefined; }
}

// ---------------- smoke test（fake adapters；不访问浏览器）----------------
/** 参数契约必须同时覆盖：本次业务日期 与 历史基线日期 */
const SMOKE_DATES = ['2026-09-17', '2026-09-18'];
/** 必须被拒绝的非法日期（含非严格格式与日历上不存在的日期） */
const ILLEGAL_DATES = [
  '2026-9-18', '20260918', '2026/09/18', '18-09-2026',
  '2026-13-01', '2026-02-30', '2026-04-31', '2026-00-10', '2026-09-00',
  '', 'today', '2026-09-18 ', ' 2026-09-18', '2026-09-18T00:00:00Z', '2026-09-1',
];

/**
 * 单个业务日期的接线 smoke：用 fake adapters 跑通编排（不触网），
 * 并断言「同一个 CLI 日期」贯穿 TaskContext、页面日期设置、归档、文件校验等所有适配器。
 */
async function wiringSmoke(BD) {
  const checks = [];
  const ck = (n, ok, d) => checks.push({ name: `[${BD}] ${n}`, ok: !!ok, detail: d === undefined ? '' : String(d) });
  const TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'syncbot-smoke-'));
  const TASK = `smoke-run-${BD}`;
  const picked = BD.replace(/-/g, '/');
  const ctx = TC.createContext('cashier_composite', { platform: 'meituan', taskId: TASK, businessDate: BD });
  ck('S6 TaskContext.businessDate 取自 CLI', ctx.businessDate === BD, ctx.businessDate);
  let s = { phase: 'PENDING', export_submitted_at: null, irreversible: { export_submit: false }, history: [], screenshots: [], created_at: new Date().toISOString() };
  const store = { load: () => s, save: (v) => { s = JSON.parse(JSON.stringify(v)); } };
  let submits = 0; let resets = 0;
  const seen = {};
  const ap = makeBoundApprovals(TASK, [], path.join(TMP, 'approvals.json'));
  const fakes = {
    precheck: async ({ ctx: c }) => { seen.precheck = c.businessDate; return { ok: true }; },
    probeDownloadList: async ({ ctx: c }) => {
      seen.probeDownloadList = c.businessDate;
      const flags = await ap.read();
      // 真实 host 对下载清单导航要求此只读授权；导出/实际下载在此时仍必须关闭。
      if (flags.download_list !== true || flags.export_submit === true || flags.download_file === true) {
        return { ok: false, reason: 'download_list_readonly_approval_missing_or_overbroad' };
      }
      return { ok: true };
    },
    navigateAndQuery: async ({ ctx: c }) => {
      seen.navigateAndQuery = c.businessDate;
      // 共享流程的设日期动作必须使用同一 CLI 日期（此处记录模拟的控件双值）
      seen.page_date_inputs = [c.businessDate.replace(/-/g, '/'), c.businessDate.replace(/-/g, '/')];
      // 【弃用标注 · 仅 --smoke 夹具常量】declared_count=22 / 共22条 是接线自检用的假值，
      // **不是**生产闸门期望值，也不在每日自动路径上：
      //   · 每日路径 = bin/schedule-tick.js → schedule/worker.js → phase3/production-sync-runner.js（不经过本文件）
      //   · 本文件的真实分支（main()，需 --confirm-real-download）走 createProductionAdapters 的**真实**适配器，
      //     本夹具不会被构造；生产期望值来自运行期 declared_dynamic（见 report-a-query-flow）。
      //   · 静态断言：smoke() 的 S13 校验本字面量只出现在 main() 之前的夹具区。
      return { ok: true, declared_count: 22, declared_dynamic: null };   // [测试数据 · 非生产期望值]
    },
    submitExport: async ({ ctx: c }) => { seen.submitExport = c.businessDate; submits += 1; return { ok: true, dialog_text: '本次导出数据共22条（夹具）' }; },   // [测试数据 · 非生产期望值]
    readDownloadRows: async () => ({ rows: [{ cells: ['序号', '业务模块', '申请内容', '申请人', '申请时间', '更新时间', '状态', '操作'], rect: { x: 0, y: 0, w: 10, h: 10 }, controls: [] }, { cells: ['1', '报表中心', `综合营业统计(营业日期【${picked}-${picked}】)`, 'LongXia', futureApply(), futureApply(), '导出完成', '下载'], rect: { x: 0, y: 20, w: 100, h: 20 }, controls: [{ text: '下载', selector: '#d', rect: { x: 20, y: 24, w: 20, h: 12 } }] }] }),
    // 新主路径：被动下载（不点击任何按钮）
    waitForPassiveFile: async ({ ctx: c }) => { seen.waitForPassiveFile = c.businessDate; return { ok: true, file: path.join(TMP, `${BD}.xlsx`), name: `${BD}.xlsx`, size: 24952, elapsed_ms: 12 }; },
    observeDownloadList: async () => ({ ok: true, read_only: true, outcome: 'wait', detail: '只读观察', clicked: false }),
    downloadFile: async () => ({ ok: true, file: path.join(TMP, 'd.xlsx'), suggested_name: 'd.xlsx' }),
    archive: async ({ ctx: c }) => { seen.archive = c.businessDate; return { ok: true, archived_path: path.join(TMP, 'a.xlsx'), archived_name: 'a.xlsx', size: 1, sha256: 'x' }; },
    validateFile: async ({ ctx: c }) => { seen.validateFile = c.businessDate; return { ok: true, checks: {} }; },
    screenshot: async () => ({ ok: true }),
    setApprovals: async (f) => { await ap.write(f); },
    resetApprovals: async () => { resets += 1; await ap.write({ export_submit: false, download_list: false, download_file: false }); },
  };
  const orch = createOrchestrator({ ctx, store, adapters: fakes, sleep: async () => {}, wait: { initialWaitMs: 0, pollIntervalMs: 0, maxWaitMs: 3 } });
  const r = await orch.run({ applicant: 'LongXia' });
  ck('S7 接线 smoke 跑通（FILE_VALIDATED）', r.ok === true && r.result === 'FILE_VALIDATED', `result=${r.result} err=${r.error || ''}`);
  ck('S7b summary.business_date 与 CLI 一致', r.business_date === BD, r.business_date);
  const chainKeys = ['precheck', 'probeDownloadList', 'navigateAndQuery', 'submitExport', 'waitForPassiveFile', 'archive', 'validateFile'];
  ck('S7c 全链路适配器收到的 ctx.businessDate 均为 CLI 日期', chainKeys.every((k) => seen[k] === BD), JSON.stringify(seen));
  ck('S7d 页面日期设置为同一日期的双值', Array.isArray(seen.page_date_inputs) && seen.page_date_inputs.length === 2 && seen.page_date_inputs.every((v) => v === picked), JSON.stringify(seen.page_date_inputs));
  ck('S8 导出仅提交一次', submits === 1, `submits=${submits}`);
  ck('S8b 全程 download click = 0（主路径为被动下载）', r.download_calls === 0, `download_calls=${r.download_calls}`);
  ck('S8c 被动下载路径被使用', !!(r.passive_wait && r.passive_wait.ok === true), JSON.stringify(r.passive_wait));
  ck('S9 finally 复位 approvals 一次', resets === 1, `resets=${resets}`);
  const raw = ap.readRaw();
  ck('S10 授权已复位为 false', raw.export_submit === false && raw.download_list === false && raw.download_file === false, JSON.stringify(raw));
  // 过期/无绑定授权 → 被视为未授权
  fs.writeFileSync(ap.file, JSON.stringify({ export_submit: true, download_list: true, download_file: true, temporary_for_task: 'other-task', temporary_until: new Date(Date.now() + 60000).toISOString() }));
  const seenOther = await ap.read();
  ck('S11 非本任务绑定的遗留 true → 拒绝使用且被复位', seenOther.export_submit === false && ap.readRaw().export_submit === false, JSON.stringify(seenOther));
  fs.writeFileSync(ap.file, JSON.stringify({ export_submit: true, download_list: true, download_file: true, temporary_for_task: TASK, temporary_until: new Date(Date.now() - 1000).toISOString() }));
  const seenStale = await ap.read();
  ck('S12 已过期授权 → 拒绝使用', seenStale.export_submit === false, JSON.stringify(seenStale));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  return checks;
}

async function smoke() {
  const out = { mode: 'smoke', checks: [] };
  const ck = (n, ok, d) => out.checks.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });
  const okArgs = (date) => ({ 'confirm-real-download': true, 'report-type': EXPECT.reportType, date });
  // 1) 参数门禁
  ck('S1 缺 --confirm-real-download → 拒绝', validateStartArgs({ 'report-type': EXPECT.reportType, date: '2026-09-18' }).length > 0, '');
  ck('S2 report-type 不符 → 拒绝', validateStartArgs({ 'confirm-real-download': true, 'report-type': 'item_sales_detail', date: '2026-09-18' }).length > 0, '');
  ck('S3 含 item_sales_detail → 拒绝', validateStartArgs({ 'confirm-real-download': true, 'report-type': 'item_sales_detail', date: '2026-09-18' }).some((x) => /item_sales_detail/.test(x)), '');
  ck('S4 额外参数 → 拒绝', validateStartArgs(Object.assign(okArgs('2026-09-18'), { foo: '1' })).length > 0, '');
  ck('S5a 三参数精确 2026-09-17 → 通过', validateStartArgs(okArgs('2026-09-17')).length === 0, JSON.stringify(validateStartArgs(okArgs('2026-09-17'))));
  ck('S5b 三参数精确 2026-09-18 → 通过', validateStartArgs(okArgs('2026-09-18')).length === 0, JSON.stringify(validateStartArgs(okArgs('2026-09-18'))));
  ck('S5c 未提供 --date → 拒绝', validateStartArgs({ 'confirm-real-download': true, 'report-type': EXPECT.reportType }).length > 0, '');
  ILLEGAL_DATES.forEach((d, i) => {
    const probs = validateStartArgs(okArgs(d));
    ck(`S5d-${i + 1} 非法日期 ${JSON.stringify(d)} → 拒绝`, probs.length > 0, probs.join(' | '));
  });
  // 2b) 静态断言：夹具里的 declared_count=22 不得出现在生产装配分支（main() 及之后）
  {
    const src = fs.readFileSync(__filename, 'utf8');
    const fixtureIdx = src.indexOf('declared_count: 22');
    const mainIdx = src.indexOf('async function main()');
    const prodIdx = src.indexOf('createProductionAdapters(');
    ck('S13 declared_count=22 仅为 --smoke 夹具常量（位于 main() 之前，未进入生产装配分支）',
      fixtureIdx > 0 && mainIdx > 0 && fixtureIdx < mainIdx && prodIdx > mainIdx &&
      !/expected_store_count\s*[=:]+\s*22/.test(src),
      `fixture@${fixtureIdx} main@${mainIdx} prodAdapters@${prodIdx}`);
    // S14：在营清单注入点必须是**本地文件**（绝不发请求、绝不直连项目库）
    const injFile = path.join(require('os').tmpdir(), `dyn-active-${Date.now()}.json`);
    fs.writeFileSync(injFile, JSON.stringify({ ok: true, active_stores: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] }));
    const got = loadActiveStores(injFile);
    ck('S14 --active-stores 注入点只读本地 coverage 响应（含 active_stores 字段）且缺省为 null（不启用覆盖率校验）',
      got && Array.isArray(got.active_stores) && got.active_stores.length === 2 &&
      loadActiveStores(null) === null && loadActiveStores(injFile + '.nope') === null,
      JSON.stringify({ injected: got && got.active_stores && got.active_stores.length, missing: loadActiveStores(injFile + '.nope') }));
    try { fs.rmSync(injFile, { force: true }); } catch (_) {}
  }
  // 3) 每个业务日期各跑一遍接线 smoke，断言日期全链路一致
  for (const BD of SMOKE_DATES) out.checks.push(...(await wiringSmoke(BD)));
  out.ok = out.checks.every((c) => c.ok);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.smoke) {
    const r = await smoke();
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
  const problems = validateStartArgs(args);
  if (problems.length) {
    console.log(JSON.stringify({ ok: false, refused: true, reason: '启动条件不满足，已拒绝（未访问浏览器、未写任务状态）', problems }, null, 2));
    process.exit(2);
  }
  const reportType = EXPECT.reportType;
  // 全链路唯一业务日期来源：CLI --date（此处已通过 isValidBusinessDate 严格校验）
  const businessDate = String(args.date);
  const taskId = `real-${Date.now().toString(36)}`;
  const ctx = TC.createContext(reportType, { platform: 'meituan', taskId, businessDate });
  const auditLog = [];
  const approvals = makeBoundApprovals(taskId, auditLog);

  // 遗留 true（无绑定/过期）→ 先拒绝使用并复位
  if (approvals.isStaleTrue()) {
    const seen = await approvals.read();
    console.log(JSON.stringify({ ok: false, refused: true, reason: '检测到遗留/无绑定的 approvals=true，已复位并拒绝执行不可逆操作', seen }, null, 2));
    process.exit(3);
  }

  const logger = createTaskLogger('phase2-real-download', { reportType, platform: 'meituan', taskId, businessDate });
  const lockHandle = lock.acquire(LOCK_NAME, reportType, { meta: { task_id: taskId, purpose: 'real-download', report_type: reportType } });
  const snap = () => ({
    at: new Date().toISOString(),
    approvals: approvals.readRaw(),
    downloads_audit_lines: (() => { try { return fs.readFileSync(path.join(P.state, 'downloads-meituan.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch { return null; } })(),
    legacy_exists: fs.existsSync(path.join(P.state, 'tasks', 'meituan-2026-09-16.json')),
  });
  const before = snap();
  logger.info('real.start', { before, lock: path.basename(lockHandle.file) });

  // 在营门店清单注入（口径冻结 §4）：--active-stores=<中控 coverage 应答原样落盘文件>
  const ACTIVE_INJECTION = loadActiveStores(args['active-stores']);
  const ACTIVE_COVERAGE = coverageFromInjection(ACTIVE_INJECTION);

  // selectors.get 的真实签名是 get(sel, key) → 必须先 load，再注入绑定形式 get(key)
  const selRegistry = selectors.load();
  const adapters = createProductionAdapters({
    client, flow, approvals, rules: config.load('meituan-rules'),
    selectors: { get: (k) => selectors.get(selRegistry, k) },
    validateFileFn: (f, o) => fileValidate.validateReportAFile(f, o),
    archiveFn: (a) => archiveMod.archive(a),
    waitForDownloadFile: (o) => waitForDownloadFile(Object.assign({ startedAt: Date.now() - 60000 }, o)),
    incomingDir: P.incoming('meituan', reportType),
    // 动态门店数口径（**不再是固定 22 条名单**）：
    //   · 审计名单 = 主档在营 ∪ 文件出现（在营来自 --active-stores，文件出现由逐行精确映射覆盖）；
    //   · 阻断项 = storeMapping 精确映射（未知/歧义门店 ⇒ 校验失败）与 mapping_coverage（台账覆盖率）；
    //   · 提供 --active-stores 时覆盖率 fail-closed 生效；未提供则仅精确映射闸门生效（人工路径）。
    expectedStoreNames: expectedStoreNamesFor(namesFromInjection(ACTIVE_INJECTION)),
    storeMapping: loadStoreMapping(),
    // 注入的是**原样 coverage 应答**（含 truncated / basis / basis_confirmed）；裸数组没有 basis
    // ⇒ 由裁决层判为不可信 ⇒ 校验失败转人工（fail-closed，绝不把"只有清单"当权威）。
    activeStoresCoverage: ACTIVE_COVERAGE,
    activeStores: Array.isArray(ACTIVE_INJECTION) ? ACTIVE_INJECTION : null,
    coverageRequired: ACTIVE_COVERAGE !== null,
    audit: (r) => { auditLog.push(r); logger.info('audit', r); },
  });
  // 状态落盘到 report_type 分层的任务状态文件
  // 状态持久化：**唯一** orchestrator 实例，绑定 report_type 分层的任务状态文件
  const taskState = require('./task-state').forReport(reportType);
  const persisted = [];
  // 阶段3 审计接线（下载侧）：emit 仅在业务 state 落盘成功之后；审计失败只落 outbox +
  // 任务状态里的 real_download_audit（脱敏），绝不回滚业务、不重跑、不阻塞已完成步骤。
  // 注意：onPending 直接 patch 任务状态（不经过 store.save），因此不会递归触发 emit。
  const audit = require('../phase3/real-download-audit').createRealDownloadAudit({
    ctx,
    logger,
    onPending: (info) => {
      try {
        taskState.patch(businessDate, {
          real_download_audit: { audit_pending: 1, phase: info.phase, stage: info.stage, reason: info.reason, at: info.at },
        });
      } catch (e) {
        logger.error('audit.pending.persist.failed', { error: e.message, phase: info.phase });
      }
    },
  });
  const persistBusinessState = (v) => {
    taskState.patch(businessDate, {
      real_download: Object.assign({}, v, {
        task_id: taskId,
        report_type: reportType,
        business_date: businessDate,
        export_submitted_at: v.export_submitted_at || null,
        screenshot_index: (v.screenshots || []).slice(),
        failure_reason: (v.failure && v.failure.reason) || null,
        archived: v.archived || null,
      }),
    });
    persisted.push({ at: new Date().toISOString(), phase: v.phase });
  };
  const store = {
    load: () => { const st = taskState.read(businessDate); return (st.phase2 && st.phase2.real_download) || null; },
    // 业务状态先落盘，成功之后才发审计事件（persistBusinessState 内部吞错，绝不因审计中断业务）
    save: audit.wrapSave(persistBusinessState),
  };
  const orch = createOrchestrator({ ctx, store, adapters, now: () => new Date().toISOString() });

  const shotLog = [];
  const shot = async (nn, step) => { const r = await require('./date-range').captureScreenshot({ flow, ctx, nn, step, sink: shotLog }); if (!r.ok) logger.error('screenshot.failed', { nn, step, reason: r.reason }); return r; };
  let result;
  try {
    result = await orch.run({ applicant: 'LongXia' });
    if (result && result.export_submitted_at) await shot('90', 'post-export');
    if (result && !result.ok) await shot('98', 'failed-after-run');
  } catch (e) {
    try { await shot('99', 'fatal-failed'); } catch (_) {}
    logger.error('real.fatal', { error: e.message });
    result = { ok: false, result: 'FAILED', error: e.message };
  } finally {
    try { await adapters.resetApprovals({}); } catch (e) { logger.error('approvals.reset.failed', { error: e.message }); }
    try { lockHandle.release(); } catch (_) {}
  }
  await audit.whenIdle();   // 等审计事件落地（发送失败也已进 outbox），不影响业务已完成的结果
  const after = snap();
  logger.info('real.end', { result: result && result.result, ok: result && result.ok, export_submit_calls: result && result.exportSubmitCalls, approvals_reset: result && result.approvals_reset, after });
  console.log(JSON.stringify({
    ok: !!(result && result.ok), task_id: taskId, report_type: reportType, business_date: businessDate,
    result: result && result.result, error: result && result.error,
    export_submit_calls: result && result.exportSubmitCalls, download_calls: result && result.download_calls,
    poll_counts: result && result.poll_counts, approvals_reset: result && result.approvals_reset,
    archived: result && result.archived, validation: result && result.validation,
    phases: result && result.phases, history: result && result.history,
    before, after,
    screenshot_index: shotLog,
    screenshot_failures: shotLog.filter((x) => !x.ok),
    state_persisted_phases: persisted,
    audit: audit.summary(),
  }, null, 2));
  process.exit(result && result.ok ? 0 : 1);
}

main().catch((e) => { console.error(JSON.stringify({ ok: false, fatal: e.message })); process.exit(9); });
