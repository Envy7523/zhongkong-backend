'use strict';
/**
 * 真实下载流程 · 离线 fixture 验收（**不访问美团、不提交导出、不下载、不导入、不推送、不建 timer**）
 *   node src/phase2/selftest-real-flow-offline.js
 * 覆盖：
 *   A 下载清单目标行匹配（无目标行/唯一完成/多行/状态异常/操作缺失/超时/控件不属于该行）
 *   B 状态机转换与不可逆导出提交闸门（含中断恢复、二次提交拒绝）
 *   C 失败分支均验证：不触发导入/推送/二次导出
 *   D 文件级校验（真实样本 + 各类异常 fixture）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'syncbot-realoffline-'));
process.env.SYNCBOT_ROOT = TMP;

const M = require('./download-list-match');
const V2 = require('./report-a-file-validate');
const SM = require('./real-flow-state');

const results = [];
const ck = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
const BD = '2026-09-17';
// 任务启动时间：2026/9/18 08:00（本地时区）
const T0 = new Date(2026, 8, 18, 8, 0, 0).getTime();


/** 从 config/store-mapping.json 提取已确认门店名称（缺失则返回 null，D 组该项跳过） */
function loadConfirmedStoreNames() {
  try {
    const real = '/opt/zhongkong-sync-bot/config/store-mapping.json';
    const p = path.join(process.env.SYNCBOT_ROOT || '', 'config', 'store-mapping.json');
    const file = fs.existsSync(real) ? real : p;
    if (!fs.existsSync(file)) return null;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const m = j.mappings || {};
    // mappings 的 key = 样本侧（美团导出行）门店名称；value 含 confirmed 与 project_store_id
    const names = Object.keys(m).filter((k) => m[k] && m[k].confirmed === true);
    return names.length >= 20 ? names : null;
  } catch (_) { return null; }
}

// ---------- fixture 构造器（对齐实测结构）----------
const HEADER = { cells: ['序号', '业务模块', '申请内容', '申请人', '申请时间', '更新时间', '状态', '操作'], rect: { x: 24, y: 131, w: 1543, h: 38 }, controls: [] };
function dataRow(no, dateStr, applyTime, status, opts = {}) {
  const content = opts.content || `综合营业统计(营业日期【${dateStr}-${dateStr}】)`;
  const applicant = opts.applicant === undefined ? 'LongXia' : opts.applicant;
  const mod = opts.module || '报表中心';
  const controls = [];
  const y = 169 + (no - 1) * 38;
  const rect = { x: 24, y, w: 1543, h: 38 };
  const kinds = opts.controls === undefined ? ['下载', '删除'] : opts.controls;
  let x = 1450;
  for (const k of kinds) { controls.push({ tag: 'a', text: k, selector: `#r${no}-${k}`, rect: { x, y: y + 8, w: 40, h: 20 } }); x += 44; }
  if (opts.orphanDownload) controls.push({ tag: 'a', text: '下载', selector: '#orphan', rect: { x: 1450, y: 900, w: 40, h: 20 } });
  return { cells: [String(no), mod, content, applicant, applyTime, opts.updateTime || applyTime, status, kinds.join('')], rect, controls, text: [mod, content, applicant, applyTime, status].join(' ') };
}
const fx = (rows) => ({ rows: [HEADER, ...rows] });

// ---------- A 目标行匹配 ----------
const A = (name, rows, criteria, expectOutcome) => {
  const r = M.selectTargetRow(fx(rows), criteria);
  ck(`A ${name}`, r.outcome === expectOutcome, `outcome=${r.outcome}（期望 ${expectOutcome}）reason=${r.reason}`);
  return r;
};
const C = { businessDate: BD, taskStartedAt: T0, applicant: 'LongXia' };

A('A1 无目标行 → wait', [dataRow(1, '2026/09/16', '2026/9/17 13:29:11', '导出完成')], C, 'wait');
A('A2 唯一目标行且「导出完成」→ ready', [dataRow(1, '2026/09/16', '2026/9/17 13:29:11', '导出完成'), dataRow(2, '2026/09/17', '2026/9/18 08:05:00', '导出完成')], C, 'ready');
A('A3 目标行已出现但状态「导出中」→ wait', [dataRow(1, '2026/09/17', '2026/9/18 08:05:00', '导出中')], C, 'wait');
A('A4 目标行状态「导出失败」→ fail', [dataRow(1, '2026/09/17', '2026/9/18 08:05:00', '导出失败')], C, 'fail');
A('A5 命中多行 → fail（拒绝猜测）', [dataRow(1, '2026/09/17', '2026/9/18 08:05:00', '导出完成'), dataRow(2, '2026/09/17', '2026/9/18 08:06:00', '导出完成')], C, 'fail');
A('A6 目标行缺少「下载」操作 → fail', [dataRow(1, '2026/09/17', '2026/9/18 08:05:00', '导出完成', { controls: ['删除'] })], C, 'fail');
A('A7 「下载」控件不属于目标行 → fail', [dataRow(1, '2026/09/17', '2026/9/18 08:05:00', '导出完成', { controls: [], orphanDownload: true })], C, 'fail');
A('A8 申请时间早于任务启动 → 不算目标行（wait）', [dataRow(1, '2026/09/17', '2026/9/18 07:59:59', '导出完成')], C, 'wait');
A('A9 申请人不同 → 不算目标行（wait）', [dataRow(1, '2026/09/17', '2026/9/18 08:05:00', '导出完成', { applicant: 'OtherUser' })], C, 'wait');
A('A10 业务模块非报表中心 → 不算目标行（wait）', [dataRow(1, '2026/09/17', '2026/9/18 08:05:00', '导出完成', { module: '其他' })], C, 'wait');
(() => { const r = M.selectTargetRow({ rows: [{ cells: ['a', 'b'], rect: { x: 0, y: 0, w: 10, h: 10 }, controls: [] }] }, C); ck('A A11 表头缺失 → fail', r.outcome === 'fail', `outcome=${r.outcome} reason=${r.reason}`); })();
A('A12 缺少期望申请人 → fail（不猜）', [dataRow(1, '2026/09/17', '2026/9/18 08:05:00', '导出完成')], { businessDate: BD, taskStartedAt: T0, applicant: '' }, 'fail');
A('A13 缺少任务启动时间 → fail', [dataRow(1, '2026/09/17', '2026/9/18 08:05:00', '导出完成')], { businessDate: BD, applicant: 'LongXia' }, 'fail');
// 超时语义：反复 wait 直至超时由调用方判定；此处验证「始终无目标行」不会误判为 ready
(() => {
  let last = null;
  for (let i = 0; i < 3; i += 1) last = M.selectTargetRow(fx([dataRow(1, '2026/09/16', '2026/9/17 13:29:11', '导出完成')]), C);
  ck('A14 持续无目标行（模拟 25 分钟轮询）→ 始终 wait、不会误判 ready', last.outcome === 'wait', `outcome=${last.outcome}`);
})();

// ---------- B 状态机与不可逆闸门 ----------
function memStore() {
  let s = null;
  return { load: () => s, save: (v) => { s = JSON.parse(JSON.stringify(v)); }, peek: () => s };
}
const gatesOk = { precheckOk: true, queryOk: true, downloadListProbed: true };
{
  const st = memStore();
  const m = SM.createMachine({ load: st.load, save: st.save });
  m.transition('PRECHECK'); m.transition('PRECHECK_OK'); m.transition('QUERY_DONE');
  ck('B1 迁移 PRECHECK→PRECHECK_OK→QUERY_DONE', m.state.phase === 'QUERY_DONE', m.state.phase);
  const bad = (() => { try { m.transition('FILE_VALIDATED'); return null; } catch (e) { return e.message; } })();
  ck('B2 非法迁移被拒（QUERY_DONE→FILE_VALIDATED）', !!bad, bad || '未拒绝');
  const noGates = SM.canSubmitExport(m.state, { precheckOk: true, queryOk: true, downloadListProbed: false });
  ck('B3 清单探测未通过 → 禁止提交导出', noGates.ok === false, noGates.reason);
  const wrongPhase = SM.canSubmitExport({ phase: 'PRECHECK_OK', export_submitted_at: null }, gatesOk);
  ck('B4 非 QUERY_DONE → 禁止提交导出', wrongPhase.ok === false, wrongPhase.reason);
  m.markExportSubmitted({ gates: gatesOk, record: { submitted_at: 'X' } });
  ck('B5 标记导出已提交（不可逆）', !!m.state.export_submitted_at && m.state.irreversible.export_submit === true, `at=${m.state.export_submitted_at}`);
  const twice = SM.canSubmitExport(m.state, gatesOk);
  ck('B6 二次提交导出被拒（不可逆闸门）', twice.ok === false, twice.reason);
  const twiceThrow = (() => { try { m.markExportSubmitted({ gates: gatesOk }); return null; } catch (e) { return e.message; } })();
  ck('B7 二次 markExportSubmitted 抛错', !!twiceThrow, twiceThrow || '未抛错');
  ck('B8 提交后状态为 EXPORT_SUBMITTED', m.state.phase === 'EXPORT_SUBMITTED', m.state.phase);
  m.transition('WAITING_EXPORT');
  const rp = SM.resumePoint(m.state);
  ck('B9 中断恢复：仅从清单轮询恢复、禁止再提交', rp.resume === 'WAITING_EXPORT' && rp.mustNotSubmitExport === true, rp.reason);
  ck('B10 恢复点不含再次提交路径', rp.resume !== 'QUERY_DONE' && rp.mustNotSubmitExport === true, `resume=${rp.resume}`);
}
{
  const st = memStore();
  const m = SM.createMachine({ load: st.load, save: st.save });
  m.transition('PRECHECK'); m.transition('PRECHECK_OK'); m.transition('QUERY_DONE'); m.transition('EXPORT_SUBMITTED'); m.transition('WAITING_EXPORT'); m.transition('EXPORT_READY');
  const rp = SM.resumePoint(m.state);
  ck('B11 已就绪态恢复 → EXPORT_READY（不重查不重提）', rp.resume === 'EXPORT_READY' && rp.mustNotSubmitExport === true, rp.reason);
}
{
  const st = memStore();
  const m = SM.createMachine({ load: st.load, save: st.save });
  m.transition('PRECHECK');
  m.fail('模拟异常');
  ck('B12 异常 → FAILED 且记录原因', m.state.phase === 'FAILED' && !!m.state.failure, JSON.stringify(m.state.failure));
  const rp = SM.resumePoint(m.state);
  ck('B13 FAILED 不自动重跑、不重提导出', rp.mustNotSubmitExport === true, rp.reason);
}
{
  const st = memStore();
  const m = SM.createMachine({ load: st.load, save: st.save });
  m.transition('PRECHECK'); m.transition('PRECHECK_OK'); m.transition('QUERY_DONE'); m.transition('EXPORT_SUBMITTED'); m.transition('WAITING_EXPORT'); m.transition('EXPORT_READY'); m.transition('DOWNLOADED'); m.transition('FILE_VALIDATED'); m.transition('STOPPED');
  ck('B14 正常终态链路到 STOPPED（9 次迁移）', m.state.phase === 'STOPPED' && m.state.history.length === 9, `history=${m.state.history.length}`);
}
ck('B15 迁移表覆盖全部约定状态', SM.STATES.length === 11 && SM.STATES.includes('EXPORT_SUBMITTED') && SM.isTerminal('FAILED') && SM.isTerminal('STOPPED'), SM.STATES.join(','));

// ---------- C 失败分支均不得触发导入/推送/二次导出 ----------
{
  const st = memStore();
  const m = SM.createMachine({ load: st.load, save: st.save });
  m.transition('PRECHECK'); m.transition('PRECHECK_OK'); m.transition('QUERY_DONE');
  m.fail('清单探测失败');
  const s = st.peek();
  const noImport = !s.history.some((h) => /import|validate_import|push/.test(JSON.stringify(h)));
  const noSecondExport = !s.export_submitted_at;
  ck('C1 失败分支未触发导入/校验/推送', noImport, JSON.stringify(s.history.map((h) => h.to)));
  ck('C2 失败分支未提交导出（无二次导出风险）', noSecondExport, `export_submitted_at=${s.export_submitted_at}`);
  const rp = SM.resumePoint(s);
  ck('C3 失败后恢复不重跑（需人工介入）', rp.mustNotSubmitExport === true && ['FAILED'].includes(rp.resume), rp.reason);
}
for (const [n, rows, exp] of [
  ['C4 多行歧义', [dataRow(1, '2026/09/17', '2026/9/18 08:05:00', '导出完成'), dataRow(2, '2026/09/17', '2026/9/18 08:06:00', '导出完成')], 'fail'],
  ['C5 状态异常', [dataRow(1, '2026/09/17', '2026/9/18 08:05:00', '导出失败')], 'fail'],
  ['C6 操作缺失', [dataRow(1, '2026/09/17', '2026/9/18 08:05:00', '导出完成', { controls: [] })], 'fail'],
]) {
  const st = memStore();
  const m = SM.createMachine({ load: st.load, save: st.save });
  m.transition('PRECHECK'); m.transition('PRECHECK_OK'); m.transition('QUERY_DONE');
  const r = M.selectTargetRow(fx(rows), C);
  if (r.outcome === 'fail') m.fail(r.reason);
  const s = st.peek();
  ck(`${n} → fail 且未提交导出、未进入 import/push`, r.outcome === exp && !s.export_submitted_at && !s.history.some((h) => /import|push/.test(h.to)), `${r.outcome} / export=${s.export_submitted_at}`);
}

// ---------- D 文件级校验（真实样本，只读；不存在则跳过）----------
const REAL_SAMPLE = '/opt/zhongkong-sync-bot/downloads/meituan/_incoming/鹅太公_综合营业统计_20260917_1153_1789617206572.xlsx';
const HAVE_XLSX = (() => { try { require.resolve('xlsx'); return true; } catch { return false; } })();
if (!HAVE_XLSX) {
  ck('D 文件级校验（缺少 xlsx 依赖，跳过）', true, 'skip: 未安装 xlsx（请在服务器上运行以覆盖 D 组）');
} else if (!fs.existsSync(REAL_SAMPLE)) {
  ck('D 文件级校验（真实样本不存在，跳过）', true, `skip: ${REAL_SAMPLE} 不存在（本地环境）；服务器上运行以覆盖 D 组`);
} else {
  const V = require('./report-a-file-validate');
  const names = loadConfirmedStoreNames();
  // 动态模式：不传固定门店数（由文件自报唯一有效门店数，仅要求 >= 1）；expectedStoreNames 仅作审计
  const good = V.validateReportAFile(REAL_SAMPLE, { businessDate: '2026-09-16', expectedStores: null, declaredDynamic: null, expectedStoreNames: names || undefined, reportType: 'cashier_composite' });
  // 动态化（口径冻结）：不再把「22 家」当作期望值；只断言映射名单**可加载且非空**
  ck('D0 已确认门店映射可加载（非空）', Array.isArray(names) && names.length >= 1, names ? `共 ${names.length} 家：${names.slice(0, 3).join('、')}…` : '未从 store-mapping.json 提取到名单（该项在 D1 中跳过）');
  ck('D1 真实样本校验通过', good.ok === true, JSON.stringify(good.checks).slice(0, 400));
  // 空文件
  const empty = path.join(TMP, 'empty.xlsx'); fs.writeFileSync(empty, '');
  ck('D2 空文件 → 失败', V.validateReportAFile(empty, { businessDate: '2026-09-16', expectedStores: 22 }).ok === false, '');
  const badExt = path.join(TMP, 'a.txt'); fs.writeFileSync(badExt, 'x');
  ck('D3 非法扩展名 → 失败', V.validateReportAFile(badExt, { businessDate: '2026-09-16', expectedStores: 22 }).ok === false, '');
  const cr = path.join(TMP, 'a.xlsx.crdownload'); fs.writeFileSync(cr, 'x');
  ck('D4 .crdownload 未完成 → 失败', V.validateReportAFile(cr, { businessDate: '2026-09-16', expectedStores: 22 }).ok === false, '');
  ck('D5 日期不符 → 失败', V.validateReportAFile(REAL_SAMPLE, { businessDate: '2026-09-15', expectedStores: 22 }).ok === false, '');
  ck('D6 门店数不符 → 失败', V.validateReportAFile(REAL_SAMPLE, { businessDate: '2026-09-16', expectedStores: 21 }).ok === false, '');
  {
    fs.writeFileSync(path.join(TMP, 'a.xlsx'), 'existing');
    const renamed = V.archiveNameNoOverwrite(REAL_SAMPLE, TMP, 'a.xlsx');
    ck('D7 同名文件不覆盖（归档命名自动改名）', renamed !== 'a.xlsx' && fs.readFileSync(path.join(TMP, 'a.xlsx'), 'utf8') === 'existing', `renamed=${renamed}`);
  }
}


// ---------- D 组回归：身份表头之下存在「渠道分组行 / 指标叶子行」时，只应计入真实门店行 ----------
if (HAVE_XLSX) {
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();
    const R2 = '营业日期：2026/09/17-2026/09/17 统计周期【日期】 门店区域【城市、门店名称】 餐时段统计方式【下单时间】 营业收入构成【结账方式类型】 支付优惠构成【结账方式】 折扣优惠构成【折扣优惠方式】';
    const aoa = [
      ['综合营业统计'],
      [R2],
      ['序号', '城市', '门店名称', '门店数量', '营业额(元)'],
      ['', '', '', '美团外卖', '收银'],
      ['', '', '', '营业额(元)', '优惠金额(元)'],
      ['1', '惠州市', '鹅太公烧鹅（上排店）', '1', '100'],
      ['2', '惠州市', '鹅太公烧鹅（下埔店）', '1', '200'],
      ['合计', '', '', '2', '300'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, '综合营业统计');
    const fxFile = path.join(TMP, 'fixture-with-group-rows.xlsx');
    XLSX.writeFile(wb, fxFile);
    const rr = V2.validateReportAFile(fxFile, { businessDate: '2026-09-17', expectedStores: 2, expectedStoreNames: ['鹅太公烧鹅（上排店）', '鹅太公烧鹅（下埔店）'] });
    ck('D8 回归：跳过渠道分组行/指标叶子行，门店行数=2（修复前误计为 4）', rr.store_count === 2, 'store_count=' + rr.store_count + '，' + ((rr.checks.skipped_non_store_rows || {}).detail || ''));
    ck('D9 回归：合计行被跳过 + 门店名精确匹配 + 整体通过', rr.checks.total_row_skipped.ok === true && rr.checks.store_names_exact.ok === true && rr.ok === true, JSON.stringify(rr.errors));
  } catch (e) {
    ck('D8/D9 回归断言执行', false, e.message);
  }
} else {
  ck('D8/D9 回归断言（缺少 xlsx 依赖，跳过）', true, 'skip: 需在具备 xlsx 的环境运行（服务器）');
}

const ok = results.every((r) => r.ok);
console.log(JSON.stringify({ ok, tmp_root: TMP, total: results.length, failed: results.filter((r) => !r.ok).length, results }, null, 2));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.exit(ok ? 0 : 1);
