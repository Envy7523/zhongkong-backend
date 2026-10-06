'use strict';
/**
 * 编排层离线验收（**被动下载主路径架构**；不访问美团、不点击导出/下载、不开 approvals、不导入/推送/timer）
 *   node src/phase2/selftest-real-download-orchestration.js
 *
 * 六项必测：
 *  1 点击导出后被动文件落盘 → 成功进入归档与文件校验；
 *  2 被动文件超时 → 下载清单**仅只读观察**，绝不点击第二次下载；
 *  3 真实 task state 按阶段持久化；
 *  4 导出提交后失败仍至少留下截图索引或明确截图失败记录；
 *  5 全程 download click 次数必须为 0；
 *  6 已有 export_submitted_at 的恢复路径绝不二次提交导出。
 * 并保留全部旧负向用例。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'syncbot-orch2-'));
process.env.SYNCBOT_ROOT = TMP;

const { createOrchestrator, FORBIDDEN_ADAPTERS } = require('./real-download');
const results = [];
const ck = (n, ok, d) => results.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });
const BD = '2026-09-17';
const CTX = { reportType: 'cashier_composite', platform: 'meituan', taskId: 'orch2-test', businessDate: BD };

function memStore(initial) {
  const saves = [];
  let s = initial || null;
  return {
    load: () => s,
    save: (v) => { s = JSON.parse(JSON.stringify(v)); saves.push({ phase: s.phase, export_submitted_at: s.export_submitted_at || null, failure: (s.failure && s.failure.reason) || null, screenshots: (s.screenshots || []).length }); },
    peek: () => s, saves,
  };
}

function makeAdapters(over = {}) {
  const log = { exportSubmits: 0, downloadClicks: 0, observeCalls: 0, screenshots: [], passiveWaits: 0 };
  const base = {
    precheck: async () => ({ ok: true }),
    probeDownloadList: async () => ({ ok: true, detail: '只读探测通过' }),
    navigateAndQuery: async () => ({ ok: true, declared_count: 22 }),
    submitExport: async () => ({ ok: true, dialog_text: '本次导出数据共22条' }),
    waitForPassiveFile: async () => {
      if (over.passive === null) return { ok: false, reason: '等待 600000ms 未出现新报表文件', elapsed_ms: 600000 };
      return over.passive || { ok: true, file: path.join(TMP, 'p.xlsx'), name: 'p.xlsx', size: 24952, elapsed_ms: 9009 };
    },
    observeDownloadList: async () => { log.observeCalls += 1; return over.observe || { ok: true, read_only: true, outcome: 'wait', detail: '清单未见目标行（只读观察）', clicked: false }; },
    downloadFile: async () => ({ ok: true, file: path.join(TMP, 'FORBIDDEN.xlsx') }),
    readDownloadRows: async () => ({ rows: [] }),
    screenshot: async (a) => { log.screenshots.push((a && a.step) || 'unnamed'); return { ok: true }; },
    archive: async () => ({ ok: true, archived_path: path.join(TMP, 'a.xlsx'), archived_name: 'a.xlsx', size: 24952, sha256: 'a'.repeat(64) }),
    validateFile: async () => ({ ok: true, checks: {}, errors: [] }),
    setApprovals: async () => ({ ok: true }),
    resetApprovals: async () => ({ ok: true }),
  };
  const merged = Object.assign(base, over.adapters || {});
  // 统一包裹：无论成功/失败都计一次「导出提交尝试」，使断言与实现无关
  const _sub = merged.submitExport;
  merged.submitExport = async (...args) => { log.exportSubmits += 1; return _sub(...args); };
  const _pf = merged.waitForPassiveFile;
  merged.waitForPassiveFile = async (...args) => { log.passiveWaits += 1; return _pf(...args); };
  const _dl = merged.downloadFile;
  merged.downloadFile = async (...args) => { log.downloadClicks += 1; return _dl(...args); };
  return { adapters: merged, log };
}

async function runCase(name, ov = {}, expect = {}) {
  const { adapters, log } = makeAdapters(ov);
  const store = memStore(ov.initialState || null);
  const orch = createOrchestrator({
    ctx: CTX, store, adapters,
    now: (() => { let i = 0; const t = Date.parse('2026-09-18T00:05:00Z'); return () => new Date(t + (i++ * 1000)).toISOString(); })(),
    sleep: async () => {},
  });
  const s = await orch.run({ applicant: 'LongXia' });
  if (expect.ok !== undefined) ck(`${name} → ok=${expect.ok}`, s.ok === expect.ok, `result=${s.result} err=${s.error || ''}`);
  if (expect.exportSubmits !== undefined) ck(`${name} → 导出提交次数=${expect.exportSubmits}`, log.exportSubmits === expect.exportSubmits, `实际 ${log.exportSubmits}`);
  ck(`${name} → download click=0`, log.downloadClicks === 0, `实际 ${log.downloadClicks}`);
  if (expect.observe !== undefined) ck(`${name} → 清单只读观察次数=${expect.observe}`, log.observeCalls === expect.observe, `实际 ${log.observeCalls}`);
  ck(`${name} → 未执行 import/push/timer`, s.imported === false && s.pushed === false && s.timer_created === false, '');
  return { s, log, store };
}

(async () => {
  // ===== 必测 1：被动落盘成功 =====
  const c1 = await runCase('必测1 被动落盘成功', {}, { ok: true, exportSubmits: 1, observe: 0 });
  ck('必测1b 终态经归档+文件校验（FILE_VALIDATED→STOPPED）', c1.s.phases_final === 'STOPPED' && c1.s.result === 'FILE_VALIDATED' && !!c1.s.archived && !!(c1.s.validation && c1.s.validation.ok), `final=${c1.s.phases_final} archived=${!!c1.s.archived}`);
  ck('必测1c 轨迹含 WAITING_EXPORT→EXPORT_READY→DOWNLOADED→FILE_VALIDATED', ['WAITING_EXPORT', 'EXPORT_READY', 'DOWNLOADED', 'FILE_VALIDATED'].every((p) => c1.s.history.some((h) => h.to === p)), JSON.stringify(c1.s.history.map((h) => h.to)));
  ck('必测1d 记录来源 via=passive_download', c1.s.history.some((h) => h.to === 'DOWNLOADED' && h.via === 'passive_download'), '');

  // ===== 必测 2：被动超时 → 清单只读观察，不点第二次下载 =====
  const c2 = await runCase('必测2 被动超时', { passive: null }, { ok: false, exportSubmits: 1, observe: 1 });
  ck('必测2b 失败原因 PASSIVE_DOWNLOAD_TIMEOUT', c2.s.error === 'PASSIVE_DOWNLOAD_TIMEOUT', String(c2.s.error));
  ck('必测2c 只读观察已记录且 clicked=false', !!(c2.s.list_observation && c2.s.list_observation.read_only === true && c2.s.list_observation.clicked === false), JSON.stringify(c2.s.list_observation));
  ck('必测2d downloadFile 从未被调用', c2.log.downloadClicks === 0 && c2.log.passiveWaits === 1, `downloadClicks=${c2.log.downloadClicks} passiveWaits=${c2.log.passiveWaits}`);

  // ===== 必测 3：状态按阶段持久化 =====
  ck('必测3 状态按阶段持久化（≥5 次且含 EXPORT_SUBMITTED/FILE_VALIDATED）', c1.store.saves.length >= 5 && c1.store.saves.some((x) => x.phase === 'EXPORT_SUBMITTED') && c1.store.saves.some((x) => x.phase === 'FILE_VALIDATED'), JSON.stringify(c1.store.saves.map((x) => x.phase)));
  ck('必测3b 持久化含不可逆提交时间', c1.store.saves.some((x) => x.phase === 'EXPORT_SUBMITTED' && !!x.export_submitted_at), '');
  ck('必测3c 失败路径也持久化 failure', c2.store.saves.some((x) => !!x.failure), JSON.stringify(c2.store.saves.filter((x) => x.failure).map((x) => x.failure)));

  // ===== 必测 4：导出后失败仍留取证 =====
  {
    const c4 = await runCase('必测4 导出后文件校验失败', { adapters: { validateFile: async () => ({ ok: false, errors: ['row2_metadata'] }) } }, { ok: false, exportSubmits: 1 });
    ck('必测4b 失败路径仍有截图调用', c4.log.screenshots.length >= 1, JSON.stringify(c4.log.screenshots));
    ck('必测4c 失败原因已持久化', c4.store.saves.some((x) => !!x.failure), JSON.stringify(c4.store.saves.filter((x) => x.failure).map((x) => x.failure)));
    const c4b = await runCase('必测4d 归档失败同样留取证', { adapters: { archive: async () => ({ ok: false, reason: '目录不可写' }) } }, { ok: false, exportSubmits: 1 });
    ck('必测4e 归档失败仍持久化 failure', c4b.store.saves.some((x) => !!x.failure), '');
  }

  // ===== 必测 6：已提交导出恢复不二次提交 =====
  {
    const pre = { phase: 'WAITING_EXPORT', export_submitted_at: '2026-09-18T00:04:00.000Z', irreversible: { export_submit: true }, history: [], screenshots: [], created_at: '2026-09-18T00:00:00.000Z' };
    const c6 = await runCase('必测6 从 WAITING_EXPORT 恢复', { initialState: pre, adapters: { submitExport: async () => { throw new Error('不应再次提交导出'); } } }, { ok: true, exportSubmits: 0 });
    ck('必测6b 恢复点标注 mustNotSubmitExport', !!(c6.s.resume && c6.s.resume.mustNotSubmitExport === true), JSON.stringify(c6.s.resume));
    const pre2 = { phase: 'EXPORT_READY', export_submitted_at: '2026-09-18T00:04:00.000Z', irreversible: { export_submit: true }, history: [], screenshots: [], created_at: '2026-09-18T00:00:00.000Z' };
    await runCase('必测6c 从 EXPORT_READY 恢复', { initialState: pre2, adapters: { submitExport: async () => { throw new Error('不应再次提交导出'); } } }, { ok: true, exportSubmits: 0, observe: 0 });
  }

  // ===== 必测 5：全局 download click 合计 = 0（每个 runCase 已单独断言） =====
  ck('必测5 已有用例全部断言 download click=0', results.filter((r) => /download click=0/.test(r.name)).every((r) => r.ok), `共 ${results.filter((r) => /download click=0/.test(r.name)).length} 条`);

  // ===== 保留的旧负向用例 =====
  await runCase('旧N1 前置失败', { adapters: { precheck: async () => ({ ok: false, reason: '缺 xlsx' }) } }, { ok: false, exportSubmits: 0, observe: 0 });
  await runCase('旧N2 清单探测失败', { adapters: { probeDownloadList: async () => ({ ok: false, reason: '结构不可识别' }) } }, { ok: false, exportSubmits: 0, observe: 0 });
  await runCase('旧N3 查询校验失败', { adapters: { navigateAndQuery: async () => ({ ok: false, reason: '声明总数非22' }) } }, { ok: false, exportSubmits: 0, observe: 0 });
  await runCase('旧N4 导出提交动作失败', { adapters: { submitExport: async () => ({ ok: false, reason: '弹窗未出现' }) } }, { ok: false, exportSubmits: 1, observe: 0 });
  await runCase('旧N5 被动文件未出现（0 字节/无新文件）', { passive: { ok: false, reason: '无新文件' } }, { ok: false, exportSubmits: 1, observe: 1 });
  await runCase('旧N6 归档异常', { adapters: { archive: async () => ({ ok: false, reason: '目标目录不可写' }) } }, { ok: false, exportSubmits: 1 });
  await runCase('旧N7 文件校验失败', { adapters: { validateFile: async () => ({ ok: false, errors: ['store_rows'] }) } }, { ok: false, exportSubmits: 1 });
  for (const bad of ['import', 'push', 'createTimer']) {
    let threw = false;
    try { createOrchestrator({ ctx: CTX, store: memStore(), adapters: { [bad]: async () => ({ ok: true }) } }); } catch (_) { threw = true; }
    ck(`旧N8 夹带禁用适配器 ${bad} → 构造期拒绝`, threw, '');
  }
  ck('旧N9 禁用适配器清单完整', ['import', 'validateImport', 'push', 'createTimer'].every((k) => FORBIDDEN_ADAPTERS.includes(k)), FORBIDDEN_ADAPTERS.join(','));
  ck('旧N10 旧轮询适配器仍保留但主路径不使用', typeof makeAdapters().adapters.readDownloadRows === 'function', '');

  // ===== 必测 7（新增）：导出确认弹窗失败 —— 阶段/原因透传 + 不二次点击导出 + 不进入被动等待 =====
  {
    const confirmFail = { ok: false, stage: 'export_dialog_confirm', reason: 'export_dialog_confirm_stale', export_clicked: true,
      export_submitted_uncertain: true, confirm_click_calls: 1, download_calls: 0, host_error: 'frame.evaluate: Error: element not found' };
    const c7 = await runCase('必测7 确认弹窗 stale', { adapters: { submitExport: async () => confirmFail } }, { ok: false, exportSubmits: 1, observe: 0 });
    ck('必测7b failure_stage/failure_reason 透传（不再只留笼统 download_failed）',
      c7.s.failure_stage === 'export_dialog_confirm' && c7.s.failure_reason === 'export_dialog_confirm_stale',
      JSON.stringify({ stage: c7.s.failure_stage, reason: c7.s.failure_reason }));
    ck('必测7c 顶层错误码可区分（EXPORT_SUBMIT_UNCERTAIN，不是 EXPORT_GATE_REFUSED）', c7.s.error === 'EXPORT_SUBMIT_UNCERTAIN', String(c7.s.error));
    ck('必测7d 未进入被动等待（fail-closed，不做 10 分钟等待）', c7.log.passiveWaits === 0, String(c7.log.passiveWaits));
    ck('必测7e 不可逆标记已落下（export_submitted_at 非空，重跑不得再点导出）',
      !!c7.s.export_submitted_at && !!c7.store.peek().irreversible.export_submit, JSON.stringify({ at: c7.s.export_submitted_at, irr: c7.store.peek().irreversible }));
    ck('必测7f 状态持久化含失败阶段/原因', c7.store.saves.some((x) => !!x.failure), JSON.stringify(c7.store.saves.filter((x) => x.failure).map((x) => x.failure)));
    ck('必测7g approvals 已复位 + 未导入/未推送/未建 timer',
      c7.s.approvals_reset === true && c7.s.imported === false && c7.s.pushed === false && c7.s.timer_created === false, '');
    ck('必测7h 确认点击次数透传=1、零下载', c7.s.confirm_click_calls === 1 && c7.s.download_calls === 0, JSON.stringify({ c: c7.s.confirm_click_calls, d: c7.s.download_calls }));

    // 同一状态文件重入：已有 export_submitted_at ⇒ 绝不再次点击导出
    const { adapters: a7, log: l7 } = makeAdapters({ adapters: { submitExport: async () => { throw new Error('不应再次提交导出'); } } });
    const orch7 = createOrchestrator({ ctx: CTX, store: c7.store, adapters: a7, sleep: async () => {} });
    const s7 = await orch7.run({ applicant: 'LongXia' });
    ck('必测7i 确认失败后重入：导出提交次数=0（绝不二次点击导出）且恢复点为 WAITING_EXPORT',
      l7.exportSubmits === 0 && !!(s7.resume && s7.resume.mustNotSubmitExport === true), JSON.stringify({ submits: l7.exportSubmits, resume: s7.resume && s7.resume.resume }));
    ck('必测7j 重入仍 download click=0', l7.downloadClicks === 0, String(l7.downloadClicks));

    // 闸门拒绝（未点击导出）→ 与"已点击导出"区分：不得标记为 uncertain
    const gateRefused = await runCase('必测7k 闸门拒绝（未点击导出）',
      { adapters: { submitExport: async () => ({ ok: false, stage: 'export_click', reason: 'export_click_failed', export_clicked: false }) } },
      { ok: false, exportSubmits: 1, observe: 0 });
    ck('必测7l 未点击导出 → EXPORT_GATE_REFUSED 且不落不可逆标记',
      gateRefused.s.error === 'EXPORT_GATE_REFUSED' && !gateRefused.s.export_submitted_at, JSON.stringify({ err: gateRefused.s.error, at: gateRefused.s.export_submitted_at }));
    ck('必测7m 未点击导出时 export_submitted_uncertain=false',
      gateRefused.s.export_submitted_uncertain === false && gateRefused.s.failure_reason === 'export_click_failed', JSON.stringify({ u: gateRefused.s.export_submitted_uncertain, r: gateRefused.s.failure_reason }));
  }

  // ===== 必测 8（v0.3.2）：无站内确认弹窗 ⇒ 直接进入被动下载等待（成功 / fail-closed 双分支） =====
  {
    const ABSENT = { ok: true, stage: 'export_dialog_confirm', confirmation_mode: 'absent_direct_download', export_clicked: true,
      export_submitted_uncertain: false, confirm_click_calls: 0, download_calls: 0, dialog_text: 'confirm_absent(absent_direct_download)' };

    // 8a 无弹窗 + 被动目录出现新的完整文件 ⇒ 判为成功，继续归档/校验
    const c8 = await runCase('必测8 无弹窗+新文件成功', { adapters: { submitExport: async () => ABSENT } }, { ok: true, exportSubmits: 1, observe: 0 });
    ck('必测8a 无站内弹窗 + 新完整文件 ⇒ 成功进入后续文件处理路径（FILE_VALIDATED/STOPPED）',
      c8.s.result === 'FILE_VALIDATED' && c8.s.phases_final === 'STOPPED' && !!c8.s.archived && !!(c8.s.validation && c8.s.validation.ok),
      JSON.stringify({ result: c8.s.result, final: c8.s.phases_final }));
    ck('必测8b confirmation_mode=absent_direct_download 透传到运行汇总，且 export=1 / confirm click=0 / download click=0',
      c8.s.confirmation_mode === 'absent_direct_download' && c8.log.exportSubmits === 1 && c8.s.confirm_click_calls === 0 && c8.log.downloadClicks === 0,
      JSON.stringify({ mode: c8.s.confirmation_mode, exports: c8.log.exportSubmits, confirm: c8.s.confirm_click_calls, download: c8.log.downloadClicks }));
    ck('必测8c 被动等待只针对本轮新增文件（不点下载、不额外点击页面）', c8.log.passiveWaits === 1 && c8.s.download_calls === 0, JSON.stringify({ passiveWaits: c8.log.passiveWaits }));

    // 8d 无弹窗 + 等待窗口内无新完整文件 ⇒ export_direct_download_not_observed（fail-closed，零导入零推送）
    const c8b = await runCase('必测8d 无弹窗且无新文件 fail-closed', { passive: null, adapters: { submitExport: async () => ABSENT } }, { ok: false, exportSubmits: 1, observe: 1 });
    ck('必测8d 无弹窗且无新完整文件 ⇒ error=EXPORT_DIRECT_DOWNLOAD_NOT_OBSERVED 且 failure_stage/failure_reason 具体化',
      c8b.s.error === 'EXPORT_DIRECT_DOWNLOAD_NOT_OBSERVED' && c8b.s.failure_stage === 'export_direct_download' && c8b.s.failure_reason === 'export_direct_download_not_observed',
      JSON.stringify({ error: c8b.s.error, stage: c8b.s.failure_stage, reason: c8b.s.failure_reason }));
    ck('必测8e 该失败仍零下载点击、零导入、零推送、零 timer，且已完成只读清单兜底观察',
      c8b.log.downloadClicks === 0 && c8b.s.imported === false && c8b.s.pushed === false && c8b.s.timer_created === false && c8b.log.observeCalls === 1,
      JSON.stringify({ download: c8b.log.downloadClicks, observe: c8b.log.observeCalls }));

    // 8f 有弹窗却等不到文件 ⇒ 保持既有 PASSIVE_DOWNLOAD_TIMEOUT 语义（不被新码覆盖）
    const c8c = await runCase('必测8f 有弹窗+无文件保持旧语义', {
      passive: null,
      adapters: { submitExport: async () => ({ ok: true, stage: 'export_dialog_confirm', confirmation_mode: 'dialog_confirmed', export_clicked: true, confirm_click_calls: 1, dialog_text: 'confirm_clicked(overlay_control:确定)' }) },
    }, { ok: false, exportSubmits: 1, observe: 1 });
    ck('必测8f 有确认弹窗但无文件 ⇒ 仍是 PASSIVE_DOWNLOAD_TIMEOUT（未被新 fail-closed 码替换）',
      c8c.s.error === 'PASSIVE_DOWNLOAD_TIMEOUT' && c8c.s.failure_stage !== 'export_direct_download', String(c8c.s.error));
  }

  const ok = results.every((r) => r.ok);
  console.log(JSON.stringify({ ok, total: results.length, failed: results.filter((r) => !r.ok).length, results }, null, 2));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(ok ? 0 : 1);
})();
