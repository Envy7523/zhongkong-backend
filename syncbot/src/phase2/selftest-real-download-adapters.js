'use strict';
/**
 * 生产适配器 · fake-client 集成测试（**不启动 real-download、不导航、不查询、不进下载清单、不导出、不下载**）
 *   node src/phase2/selftest-real-download-adapters.js
 * 覆盖：白名单动作映射 / 未授权时不下发 host 命令 / 错误与异常时 finally 复位 approvals /
 *       无未白名单 host 命令 / 无项目导入接口调用 / 双重保护拒绝用例
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'syncbot-adapters-'));
process.env.SYNCBOT_ROOT = TMP;

const A = require('./real-download-adapters');
const M = require('./download-list-match');

const results = [];
const ck = (n, ok, d) => results.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });
const BD = '2026-09-17';
const CTX = { reportType: 'cashier_composite', platform: 'meituan', taskId: 'adapters-test', businessDate: BD };

// ---------- fake host client：记录每一条下发的命令；可注入故障 ----------
function fakeClient(over = {}) {
  const log = { cmds: [], forbidden: [] };
  const replies = {
    health: { ok: true, url: 'about:blank', title: 'x' },
    blockers: { has_password_input: false, keyword_hits: [], likely_login_page: false, likely_human_verification: false },
    url: { url: 'about:blank' },
    downloadRows: { frameCount: 1, best: { row_count: 2, header_hint: '业务模块 申请内容 申请人 申请时间 更新时间 状态 操作', rows: [{ cells: ['序号', '业务模块', '申请内容', '申请人', '申请时间', '更新时间', '状态', '操作'], rect: { x: 0, y: 0, w: 100, h: 10 }, controls: [] }, { cells: ['1', '报表中心', '综合营业统计(营业日期【2026/09/16-2026/09/16】)', 'LongXia', '2026/9/17 13:29:11', '2026/9/17 13:29:22', '导出完成', '下载删除'], rect: { x: 0, y: 20, w: 100, h: 20 }, controls: [{ text: '下载', selector: '#c-下载', rect: { x: 20, y: 24, w: 20, h: 12 } }] }] } },
    tableSummary: { pagination: { declared_count: 22, declared_text: '共 22 条记录' }, total_row: { cells: ['合计', '--', '--', '--', '--', '--', '22', '22', '1'], cell_count: 9, class_name: 'summary', depth: 16 }, tables: [], grids: [] },
    filterState: { best: { groups: [] } },
    pageText: { text: '本次导出数据共22条，请前往【下载清单】查看下载状态' },
    probe: { merged: {} },
    click: { clicked: 'sel' },
    screenshot: { path: '/tmp/x.png', bytes: 1 },
    // dateRow/picker/mouse fake（供共享日期动作 setDateRangeExact 使用）
    dateRow: { frameCount: 1, best: { found: true, url: 'x', row_class: 'DateRangePicker_2', inputs: [{ placeholder: '开始日期', value: '2026/09/17', readOnly: true, rect: { x: 324, y: 506, w: 90, h: 20 } }, { placeholder: '结束日期', value: '2026/09/17', readOnly: true, rect: { x: 446, y: 506, w: 90, h: 20 } }], block: { form_items: [{ text: '星期 全部', cls: 'WeekSelect_1', checked_texts: [] }, { text: '门店 全部 高级', cls: 'PoiSelector_5', checked_texts: [] }] } } },
    picker: { frameCount: 1, best: { distinct_dates: 1, min_date: '2026-09-17', max_date: '2026-09-17', cells: [{ date: '2026-09-17', text: '17', tag: 'td', cls: 'saas-picker-cell', rect: { x: 400, y: 600, w: 36, h: 30 }, selector: '#cell-17' }], presets: [] } },
    mouse: { action: 'click', x: 0, y: 0 },
    press: { ok: true },
    // 导出确认弹窗相关（默认：无弹窗容器、无可见确认候选；inspect 默认可见，供"点击时才消失"用例）
    overlays: { frameCount: 0, best: null, has_blocking_overlay: false, frames: [] },
    inspect: { exists: true, visible: true, enabled: true, inViewport: true, text: '确定', rect: { x: 1, y: 1, w: 40, h: 20 }, selector: '#dlg-ok' },
  };
  return {
    log,
    call: async (cmd, args) => {
      log.cmds.push({ cmd, args });
      if (A.FORBIDDEN_HOST_COMMANDS.has(cmd)) log.forbidden.push(cmd);
      if (typeof over.failWhen === 'function') {
        const fail = over.failWhen(cmd, args);
        if (fail) throw (fail instanceof Error ? fail : new Error(String(fail)));
      }
      if (over.failOn === cmd) throw new Error(`fake host 故障：${cmd}`);
      if (Object.prototype.hasOwnProperty.call(over.replies || {}, cmd)) {
        const v = over.replies[cmd];
        return typeof v === 'function' ? v(args) : v;
      }
      return replies[cmd];
    },
    health: async () => replies.health,
  };
}
function fakeFlow(over = {}) {
  const log = { calls: [] };
  const base = {
    screenshot: async () => { log.calls.push('screenshot'); return { file: path.join(TMP, 's.png') }; },
    dismissOverlays: async () => ({ ok: true, dismissed: [], remaining: 0 }),
    selectSavedScheme: async () => { log.calls.push('selectSavedScheme'); return { ok: true, step: 'selected' }; },
    waitForContent: async () => ({ ok: true }),
    gotoAndAssert: async () => ({ ok: true, url: 'x', url_assert: { ok: true, mismatches: [] } }),
    clickSelectorAndVerify: async (a) => { log.calls.push({ fn: 'clickSelectorAndVerify', arg: a }); return { ok: true }; },
    clickTextAndVerify: async (a) => { log.calls.push({ fn: 'clickTextAndVerify', arg: a }); return { ok: true }; },
  };
  return { log, ...Object.assign(base, over) };
}
function fakeApprovals(initial) {
  let cur = Object.assign({ export_submit: false, download_list: false, download_file: false }, initial || {});
  const log = { writes: [] };
  return { log, read: async () => cur, write: async (o) => { log.writes.push(JSON.parse(JSON.stringify(o))); cur = o; }, peek: () => cur };
}
const RULES = {
  navigation: { home_url: 'h', report_center_url: 'r', entry_url: 'e' },
  saved_query: { display_name: 'done' },
  overlay_dismissal: { allow_click_texts: ['知道了'] },
  report: { expected_store_count: 22 },
  filter_value_checks: { items: [{ no: 5, group: '餐时段统计方式', verify_source: 'export_file_row2_query_params' }] },
  download_list_locator: { full_url: 'https://pos.meituan.com/web/fe.rms-portal/rms-report.html#/rms-report/promiseDownload' },
};
const SELECTORS = { get: (k) => ({ 'action.export_button': '#export', 'nav.report_center': '#rc', 'nav.business_report': '#br', 'nav.target_report': '#tr', 'filter.date_start': '#s', 'filter.date_end': '#e', 'action.query': '#q' }[k] || null) };

function build(over = {}) {
  const client = fakeClient(over.client);
  const flow = fakeFlow(over.flow);
  const approvals = fakeApprovals(over.approvals);
  const audited = [];
  const waitCalls = [];
  const ad = A.createProductionAdapters({
    client, flow, approvals, rules: RULES, selectors: SELECTORS,
    validateFileFn: over.validateFileFn || (async () => ({ ok: true, checks: {}, errors: [] })),
    archiveFn: over.archiveFn || (async () => ({ file: path.join(TMP, 'a.xlsx'), size: 1, sha256: 'x', archived: true, duplicate: false })),
    waitForDownloadFile: async (o) => { waitCalls.push(o); return (over.waitForDownloadFile || (async () => ({ ok: true, file: path.join(TMP, 'd.xlsx'), name: 'd.xlsx', size: 1 })))(o); },
    incomingDir: TMP, audit: (r) => audited.push(r), now: () => '2026-09-18T00:00:00.000Z',
    // 确认弹窗轮询：测试默认零等待（只读轮询本身可注入超时/间隔，语义不变）
    sleep: over.sleep || (async () => {}),
    exportConfirm: over.exportConfirm || { timeoutMs: 0, intervalMs: 0 },
  });
  return { ad, client, flow, approvals, audited, waitCalls };
}
const row = (no, dateStr, applyTime, status, controls) => ({
  cells: [String(no), '报表中心', `综合营业统计(营业日期【${dateStr}-${dateStr}】)`, 'LongXia', applyTime, applyTime, status, (controls || ['下载', '删除']).join('')],
  rect: { x: 24, y: 169, w: 1543, h: 38 },
  controls: (controls || ['下载', '删除']).map((k, i) => ({ text: k, selector: `#c-${k}`, rect: { x: 1450 + i * 44, y: 177, w: 40, h: 20 } })),
});

(async () => {
  // 1) 白名单动作映射全覆盖
  {
    const { ad } = build();
    const names = A.ADAPTER_NAMES.filter((n) => typeof ad[n] === 'function');
    ck('1a 白名单 11 个动作全部装配', names.length === A.ADAPTER_NAMES.length, names.join(','));
    ck('1b 未装配禁止动作（import/validateImport/push/createTimer/delete）', ['import', 'validateImport', 'push', 'createTimer', 'delete'].every((k) => typeof ad[k] !== 'function'), '');
  }
  // 2) precheck / probeDownloadList（只读）
  {
    const { ad, client } = build();
    const pc = await ad.precheck({ ctx: CTX });
    ck('2a precheck 通过且仅下发 health/blockers', pc.ok === true && client.log.cmds.map((c) => c.cmd).join(',') === 'health,blockers', client.log.cmds.map((c) => c.cmd).join(','));
    const b2 = build({ client: { replies: { blockers: { likely_human_verification: true, keyword_hits: ['验证码'] } } } });
    const pc2 = await b2.ad.precheck({ ctx: CTX });
    ck('2b precheck 遇人机验证 → 拒绝且不绕过', pc2.ok === false && /人机验证/.test(pc2.reason), pc2.reason);
    const { ad: ad3, client: cl3 } = build();
    const pr = await ad3.probeDownloadList({ ctx: CTX });
    ck('2c probeDownloadList 仅导航+读取（无 click）', pr.ok === true && !cl3.log.cmds.some((c) => c.cmd === 'click'), cl3.log.cmds.map((c) => c.cmd).join(','));
  }
  // 3) submitExport 双重保护：未授权 → 拒绝且不下发 click
  {
    for (const [name, flags] of [['export_submit=false', {}], ['export_submit=false(其余true)', { download_list: true, download_file: true }]]) {
      const { ad, client, audited } = build({ approvals: flags });
      const r = await ad.submitExport({ ctx: CTX });
      const clicked = client.log.cmds.some((c) => c.cmd === 'click');
      ck(`3 ${name} → 拒绝且未下发 click`, r.ok === false && r.refused === true && clicked === false, `reason=${r.reason}；cmds=${client.log.cmds.map((c) => c.cmd).join(',')}`);
      ck(`3 ${name} → 已写审计`, audited.some((x) => x.event === 'adapter_refused' && x.action === 'submitExport'), JSON.stringify(audited[0] || null));
    }
  }
  // 4) downloadFile 双重保护
  {
    const okCtl = { selector: '#c-下载', rect: { x: 1450, y: 177, w: 40, h: 20 } };
    {
      const { ad, client } = build({ approvals: { download_file: false } });
      const r = await ad.downloadFile({ ctx: CTX, control: okCtl, target: { status: '导出完成', applicant: 'LongXia', taskStartedAt: 0 } });
      ck('4a download_file=false → 拒绝且未下发 click', r.ok === false && r.refused === true && !client.log.cmds.some((c) => c.cmd === 'click'), r.reason);
    }
    {
      const { ad, client } = build({ approvals: { download_file: true } });
      const r = await ad.downloadFile({ ctx: CTX, control: okCtl, target: { status: '导出中', applicant: 'LongXia', taskStartedAt: 0 } });
      ck('4b 状态非「导出完成」→ 拒绝且未点击', r.ok === false && r.refused === true && !client.log.cmds.some((c) => c.cmd === 'click'), r.reason);
    }
    {
      const { ad, client } = build({ approvals: { download_file: true } });
      const r = await ad.downloadFile({ ctx: CTX, control: null, target: { status: '导出完成', applicant: 'LongXia', taskStartedAt: 0 } });
      ck('4c 缺下载控件 → 拒绝且未点击', r.ok === false && r.refused === true && !client.log.cmds.some((c) => c.cmd === 'click'), r.reason);
    }
    {
      // 复核阶段：清单里出现 2 行歧义 → 拒绝
      const rows = { frameCount: 1, best: { row_count: 3, rows: [ { cells: ['序号', '业务模块', '申请内容', '申请人', '申请时间', '更新时间', '状态', '操作'], rect: { x: 0, y: 0, w: 100, h: 10 }, controls: [] }, row(1, '2026/09/17', '2026/9/18 08:06:00', '导出完成'), row(2, '2026/09/17', '2026/9/18 08:07:00', '导出完成') ] } };
      const { ad, client } = build({ approvals: { download_file: true }, client: { replies: { downloadRows: rows } } });
      const r = await ad.downloadFile({ ctx: CTX, control: okCtl, target: { status: '导出完成', applicant: 'LongXia', taskStartedAt: Date.parse('2026-09-18T00:00:00Z') } });
      ck('4d 下载前复核命中多行 → 拒绝且未点击（拒绝猜测）', r.ok === false && r.refused === true && !client.log.cmds.some((c) => c.cmd === 'click'), r.reason);
    }
    {
      // 唯一行且状态完成、控件属于该行 → 允许点击 download
      const rows = { frameCount: 1, best: { row_count: 2, rows: [ { cells: ['序号', '业务模块', '申请内容', '申请人', '申请时间', '更新时间', '状态', '操作'], rect: { x: 0, y: 0, w: 100, h: 10 }, controls: [] }, row(1, '2026/09/17', '2026/9/18 08:06:00', '导出完成') ] } };
      const { ad, client } = build({ approvals: { download_file: true }, client: { replies: { downloadRows: rows } } });
      const r = await ad.downloadFile({ ctx: CTX, control: okCtl, target: { status: '导出完成', applicant: 'LongXia', taskStartedAt: Date.parse('2026-09-18T00:00:00Z') } });
      const clicks = client.log.cmds.filter((c) => c.cmd === 'click');
      ck('4e 唯一行+状态完成+控件属于该行 → 下发 click(purpose=download)', r.ok === true && clicks.length === 1 && clicks[0].args.purpose === 'download', JSON.stringify(clicks.map((c) => c.args && c.args.purpose)));
    }
  }
  // 5) 全程无未白名单 host 命令、无导入接口调用
  {
    const { ad, client } = build({ approvals: { export_submit: true, download_list: true, download_file: true } });
    await ad.precheck({ ctx: CTX });
    await ad.probeDownloadList({ ctx: CTX });
    await ad.submitExport({ ctx: CTX });
    await ad.readDownloadRows({ ctx: CTX });
    await ad.screenshot({ ctx: CTX, nn: '01', step: 'x' });
    await ad.archive({ ctx: CTX, file: path.join(TMP, 'f.xlsx'), suggestedName: 'f.xlsx' });
    await ad.validateFile({ ctx: CTX, file: path.join(TMP, 'f.xlsx') });
    const cmds = client.log.cmds.map((c) => c.cmd);
    const unlisted = cmds.filter((c) => !A.ALLOWED_HOST_COMMANDS.has(c));
    ck('5a 全程 host 命令均在白名单内', unlisted.length === 0, `commands=${Array.from(new Set(cmds)).join(',')}`);
    ck('5b 未下发任何禁止命令（import/push/delete/timer）', client.log.forbidden.length === 0, client.log.forbidden.join(','));
    ck('5c 未装配导入/推送适配器（编排层亦不可持有）', A.ADAPTER_NAMES.every((n) => !['import', 'validateImport', 'push', 'createTimer'].includes(n)), '');
  }
  // 6) 错误/异常时 approvals 可复位（resetApprovals 幂等且写回三项 false）
  {
    const { ad, approvals } = build({ approvals: { export_submit: true, download_list: true, download_file: true } });
    await ad.setApprovals({ export_submit: true, download_list: true, download_file: true, task_id: CTX.taskId });
    await ad.resetApprovals({});
    const cur = approvals.peek();
    ck('6a resetApprovals 写回三项 false', cur.export_submit === false && cur.download_list === false && cur.download_file === false, JSON.stringify(cur));
    ck('6b temporary_for_task 已清空', cur.temporary_for_task === null, String(cur.temporary_for_task));
  }
  // 7) 异常传播与 host 故障
  {
    const { ad } = build({ client: { failOn: 'health' } });
    let threw = false;
    try { await ad.precheck({ ctx: CTX }); } catch (e) { threw = /故障/.test(e.message); }
    ck('7a host 故障向上抛出（由编排层 catch → FAILED）', threw, '');
    const { ad: ad2 } = build({ client: { failOn: 'blockers' } });
    let threw2 = false;
    try { await ad2.precheck({ ctx: CTX }); } catch (e) { threw2 = true; }
    ck('7b blockers 故障向上抛出', threw2, '');
  }
  // 8) TaskContext 缺失 → 立即拒绝（任何动作）
  {
    const { ad, client } = build({ approvals: { export_submit: true } });
    let threw = false;
    try { await ad.submitExport({ ctx: null }); } catch (e) { threw = /TaskContext/.test(e.message); }
    ck('8 缺少 TaskContext → 拒绝且下发 0 条 host 命令', threw && client.log.cmds.length === 0, `cmds=${client.log.cmds.length}`);
  }
  // 9) 构造期拒绝夹带禁止依赖
  {
    for (const bad of ['import', 'push', 'createTimer', 'delete']) {
      let threw = false;
      try { A.createProductionAdapters({ client: fakeClient(), flow: fakeFlow(), approvals: fakeApprovals(), rules: RULES, selectors: SELECTORS, [bad]: () => {} }); } catch (e) { threw = true; }
      ck(`9 构造期拒绝夹带依赖 ${bad}`, threw, '');
    }
  }
  // 11) 回归：selectors 注入绑定错误必须在构造期被发现（真实签名 get(sel,key) 的 arity=2）
  {
    const moduleLike = { get: (sel, key) => (sel && sel.selectors ? sel.selectors[key] : null) };   // 未绑定模块形态（arity=2）
    let threw = null;
    try { A.createProductionAdapters({ client: fakeClient(), flow: fakeFlow(), approvals: fakeApprovals(), rules: RULES, selectors: moduleLike }); } catch (e) { threw = e.message; }
    ck('11a 注入未绑定 selectors（arity=2）→ 构造期抛出且提示签名', !!threw && /arity=2/.test(threw), threw || '未抛错');
    const boundOk = (() => { try { A.createProductionAdapters({ client: fakeClient(), flow: fakeFlow(), approvals: fakeApprovals(), rules: RULES, selectors: { get: (k) => '#bound-' + k } }); return true; } catch (_) { return false; } })();
    ck('11b 注入绑定 selectors（arity=1）→ 构造成功', boundOk === true, '');
    const { ad, flow } = build();
    const r = await ad.navigateAndQuery({ ctx: CTX });
    const navCalls = flow.log.calls.filter((x) => x && x.fn === 'clickSelectorAndVerify');
    ck('11c navigateAndQuery 传给 flow 的选择器均非 undefined/null', navCalls.length > 0 && navCalls.every((x) => typeof x.arg.selector === 'string' && x.arg.selector.length > 0 && x.arg.selector !== '#bound-undefined'), JSON.stringify(navCalls.map((x) => x.arg && x.arg.selector)));
    ck('11d 筛选/查询阶段未提前中止', r.ok === true, r.reason || '');
  }
  // 11e 回归：缺必需选择器 → fail-fast（不透传 null 给 flow）
  {
    const bare = { get: (k) => ({ 'action.export_button': '#export' }[k] || null) };
    const cf = fakeClient(); const ff = fakeFlow(); const ap = fakeApprovals();
    const ad = A.createProductionAdapters({ client: cf, flow: ff, approvals: ap, rules: RULES, selectors: bare, validateFileFn: async () => ({ ok: true }), archiveFn: async () => ({ file: 'x' }), waitForDownloadFile: async () => ({ ok: true, file: 'x' }), incomingDir: TMP, audit: () => {}, now: () => 'T' });
    const r = await ad.navigateAndQuery({ ctx: CTX });
    ck('11e 缺必需选择器 → 明确失败且未调用 flow', r.ok === false && /缺少必需选择器/.test(r.reason) && ff.log.calls.length === 0, r.reason);
  }

  // 12) 回归：archive 真实返回结构 { file,size,sha256,archived,duplicate,keptBoth } 的映射
  {
    const { ad } = build({ archiveFn: async () => ({ file: path.join(TMP, 'realname.xlsx'), dir: TMP, size: 24565, sha256: 'f'.repeat(64), archived: true, duplicate: false, keptBoth: path.join(TMP, 'kept.xlsx') }) });
    const r = await ad.archive({ ctx: CTX, file: path.join(TMP, 'x.xlsx'), suggestedName: 'x.xlsx' });
    ck('12a archived_path/name/size/sha256 正确映射', r.archived_path === path.join(TMP, 'realname.xlsx') && r.archived_name === 'realname.xlsx' && r.size === 24565 && r.sha256 === 'f'.repeat(64), JSON.stringify(r));
    ck('12b keptBoth(同名不同内容) → overwrite_avoided=true', r.overwrite_avoided === true, JSON.stringify(r));
  }

  // 13) 导出确认弹窗（2026-09-23「element not found」故障修复）
  //     硬规则：禁止以全页文本含「下载清单」判定弹窗出现；只认"可见确认按钮候选"或"弹窗容器+可见确认按钮"；
  //             confirm 最多点击一次；失败语义三码可区分；任何失败零下载/零导入/零推送。
  {
    const EXPORT_APPROVALS = { export_submit: true, download_list: true, download_file: true };
    const clicksWith = (client, purpose) => client.log.cmds.filter((c) => c.cmd === 'click' && c.args && c.args.purpose === purpose);
    const OVERLAY_WITH_OK = { frameCount: 1, has_blocking_overlay: true, best: { overlay_count: 1, area_ratio: 0.2 }, frames: [{ frameIndex: 0, frameUrl: 'x', overlays: [{ class_name: 'modal', position: 'fixed', area_ratio: 0.2, is_mask_only: false, text: '确认导出', controls: [{ tag: 'button', text: '确定', selector: '#dlg-ok', rect: { x: 10, y: 10, w: 40, h: 20 }, cls: 'btn' }] }] }] };

    // 13a 全页存在「下载清单」文本、但无任何可见确认按钮 → not_found，confirm click=0
    {
      const { ad, client, audited } = build({
        approvals: EXPORT_APPROVALS,
        client: { replies: {
          pageText: { text: '本次导出数据共22条，请前往【下载清单】查看下载状态（页面其它区域也可能出现该文案）', length: 60 },
          probe: { merged: { 确定: { exact: [], partial: [], exactCount: 0, partialCount: 0 } } },
          overlays: { frameCount: 1, best: null, has_blocking_overlay: false, frames: [] },
        } },
      });
      const r = await ad.submitExport({ ctx: CTX });
      // v0.3.2：无可见确认按钮**不再判失败**（该页实际是"点击导出即直接下载"），
      // 探测原因仍记录为 not_found，但作为 confirmation_mode=absent_direct_download 的依据。
      ck('13a 全页含「下载清单」但无可见确认按钮 → 不再判失败（confirmation_mode=absent_direct_download）',
        r.ok === true && r.confirmation_mode === 'absent_direct_download' && r.stage === 'export_dialog_confirm', `${r.ok}/${r.confirmation_mode}/${r.stage}`);
      ck('13a confirm click=0、export click=1（未二次点击导出）',
        clicksWith(client, 'export_dialog_confirm').length === 0 && clicksWith(client, 'export').length === 1,
        `confirm=${clicksWith(client, 'export_dialog_confirm').length} export=${clicksWith(client, 'export').length}`);
      ck('13a 不以全页文本为判定依据（pageText 未被下发）',
        !client.log.cmds.some((c) => c.cmd === 'pageText'), client.log.cmds.map((c) => c.cmd).join(','));
      ck('13a 无弹窗时：导出已点击且状态确定（uncertain=false），confirm=0、零下载',
        r.export_clicked === true && r.export_submitted_uncertain === false && r.confirm_click_calls === 0 && r.download_calls === 0,
        JSON.stringify({ clicked: r.export_clicked, uncertain: r.export_submitted_uncertain, confirm: r.confirm_click_calls, download_calls: r.download_calls }));
      ck('13a 审计事件 export_dialog_confirm_absent 含 stage/reason/confirmation_mode 且不含 selector/页面正文',
        audited.some((x) => x.event === 'export_dialog_confirm_absent' && x.stage === 'export_dialog_confirm' && x.reason === 'export_dialog_confirm_not_found'
          && x.confirmation_mode === 'absent_direct_download'
          && !Object.prototype.hasOwnProperty.call(x, 'selector') && !Object.prototype.hasOwnProperty.call(x, 'dialog_text')), JSON.stringify(audited.slice(-1)));
    }

    // 13b 确认按钮延迟出现 → 单次 export、单次 confirm（后续可继续被动下载路径）
    {
      let probeCalls = 0;
      const { ad, client } = build({
        approvals: EXPORT_APPROVALS,
        exportConfirm: { timeoutMs: 200, intervalMs: 1 },
        client: { replies: {
          overlays: { frameCount: 1, best: null, has_blocking_overlay: false, frames: [] },
          probe: () => {
            probeCalls += 1;
            return probeCalls < 3
              ? { merged: {} }
              : { merged: { 确定: { exact: [{ tag: 'button', text: '确定', selector: '#dlg-ok', unique: true, visible: true, clickable: true, rect: { x: 1, y: 1, w: 40, h: 20 } }], partial: [], exactCount: 1, partialCount: 0 } } };
          },
        } },
      });
      const r = await ad.submitExport({ ctx: CTX });
      ck('13b 延迟出现的可见确认按钮 → ok 且只点击一次 confirm',
        r.ok === true && clicksWith(client, 'export_dialog_confirm').length === 1 && clicksWith(client, 'export').length === 1 && r.confirm_poll_attempts >= 3,
        `ok=${r.ok} confirm=${clicksWith(client, 'export_dialog_confirm').length} attempts=${r.confirm_poll_attempts}`);
      ck('13b confirm 点击带 forceRetry=false / domClickFallback=false（宿主只做一次点击尝试，不按 Escape、不做 DOM 兜底）',
        clicksWith(client, 'export_dialog_confirm')[0].args.forceRetry === false && clicksWith(client, 'export_dialog_confirm')[0].args.domClickFallback === false,
        JSON.stringify(clicksWith(client, 'export_dialog_confirm')[0].args));
      ck('13b 成功路径 uncertain=false，dialog 摘要不含页面正文',
        r.export_submitted_uncertain === false && /^confirm_clicked\(/.test(String(r.dialog_text)), String(r.dialog_text));
    }

    // 13c 确认按钮 probe 后消失（点击时元素已消失）→ stale，confirm click=1，绝不二次点击
    {
      const { ad, client } = build({
        approvals: EXPORT_APPROVALS,
        client: {
          replies: { overlays: OVERLAY_WITH_OK, inspect: { exists: true, visible: true, enabled: true, rect: { x: 10, y: 10, w: 40, h: 20 }, selector: '#dlg-ok' } },
          failWhen: (cmd, args) => (cmd === 'click' && args && args.purpose === 'export_dialog_confirm' ? new Error('frame.evaluate: Error: element not found') : null),
        },
      });
      const r = await ad.submitExport({ ctx: CTX });
      ck('13c 点击时元素已消失 → export_dialog_confirm_stale',
        r.ok === false && r.reason === 'export_dialog_confirm_stale' && r.stage === 'export_dialog_confirm', String(r.reason));
      ck('13c confirm click 恰好 1 次（绝不二次点击）',
        clicksWith(client, 'export_dialog_confirm').length === 1, String(clicksWith(client, 'export_dialog_confirm').length));
      ck('13c 原始 host 错误脱敏保留（host_error）',
        typeof r.host_error === 'string' && /element not found/.test(r.host_error), String(r.host_error));
      ck('13c 未重新点击 export 且零下载',
        clicksWith(client, 'export').length === 1 && r.download_calls === 0, `export=${clicksWith(client, 'export').length}`);
    }

    // 13c-2 点击前只读复核发现候选已不可见 → stale，confirm click=0（同样不二次点击）
    {
      const { ad, client } = build({
        approvals: EXPORT_APPROVALS,
        client: { replies: { overlays: OVERLAY_WITH_OK, inspect: { exists: false, visible: false, enabled: false, rect: null, selector: '#dlg-ok' } } },
      });
      const r = await ad.submitExport({ ctx: CTX });
      ck('13c2 点击前复核不可见 → export_dialog_confirm_stale 且 confirm click=0',
        r.ok === false && r.reason === 'export_dialog_confirm_stale' && clicksWith(client, 'export_dialog_confirm').length === 0,
        `${r.reason}/confirm=${clicksWith(client, 'export_dialog_confirm').length}`);
    }

    // 13d host 明确拒绝 confirm → rejected；零下载/零导入/零推送
    {
      const { ad, client } = build({
        approvals: EXPORT_APPROVALS,
        client: {
          replies: { overlays: OVERLAY_WITH_OK },
          failWhen: (cmd, args) => (cmd === 'click' && args && args.purpose === 'export_dialog_confirm' ? new Error('宿主拒绝：未授权 approvals.download_file 不为 true') : null),
        },
      });
      const r = await ad.submitExport({ ctx: CTX });
      ck('13d host 明确拒绝 → export_dialog_confirm_rejected', r.ok === false && r.reason === 'export_dialog_confirm_rejected', String(r.reason));
      ck('13d confirm click 恰好 1 次（不重试）', clicksWith(client, 'export_dialog_confirm').length === 1, String(clicksWith(client, 'export_dialog_confirm').length));
      ck('13d 零下载/零导入/零推送（无 download 类 host 命令、未装配导入/推送）',
        client.log.cmds.every((c) => !/import|push|downloadFile/i.test(String(c.cmd))) && r.download_calls === 0
          && A.ADAPTER_NAMES.indexOf('import') < 0 && A.ADAPTER_NAMES.indexOf('push') < 0, client.log.cmds.map((c) => c.cmd).join(','));
    }

    // 13e 未分类 host 错误（超时等）→ 保守归入 rejected（绝不落入可重试分支），原始错误保留
    {
      const { ad, client } = build({
        approvals: EXPORT_APPROVALS,
        client: {
          replies: { overlays: OVERLAY_WITH_OK },
          failWhen: (cmd, args) => (cmd === 'click' && args && args.purpose === 'export_dialog_confirm' ? new Error('宿主响应超时（60000ms）：click') : null),
        },
      });
      const r = await ad.submitExport({ ctx: CTX });
      ck('13e 未分类 host 错误 → export_dialog_confirm_rejected（原始错误保留）',
        r.reason === 'export_dialog_confirm_rejected' && /超时/.test(String(r.host_error)), `${r.reason}/${r.host_error}`);
      ck('13e confirm click 仍恰好 1 次', clicksWith(client, 'export_dialog_confirm').length === 1, String(clicksWith(client, 'export_dialog_confirm').length));
    }

    // 13f 命令已发给宿主后即使响应失败也不能证明未点击，按不可逆不确定处理。
    {
      const { ad, client } = build({
        approvals: EXPORT_APPROVALS,
        client: { failWhen: (cmd, args) => (cmd === 'click' && args && args.purpose === 'export' ? new Error('选择器在所有 frame 中都不存在：#export') : null) },
      });
      const r = await ad.submitExport({ ctx: CTX });
      ck('13f 导出点击响应失败 → export_click_failed / 不确定已点击 / 不进入确认轮询',
        r.ok === false && r.reason === 'export_click_failed' && r.export_clicked === true && r.export_submitted_uncertain === true && r.stage === 'export_click'
          && !client.log.cmds.some((c) => c.cmd === 'overlays' || c.cmd === 'probe'), `${r.reason}/${r.stage}`);
    }

    // 13g 纯函数与常量自洽
    {
      ck('13g classify: element not found → stale', A.classifyConfirmClickError('frame.evaluate: Error: element not found') === 'export_dialog_confirm_stale', '');
      ck('13g classify: 宿主拒绝/未授权 → rejected', A.classifyConfirmClickError('宿主拒绝：未授权') === 'export_dialog_confirm_rejected', '');
      ck('13g classify: 未分类 → rejected（fail-closed）', A.classifyConfirmClickError('something unexpected') === 'export_dialog_confirm_rejected', '');
      ck('13g 三码常量与失败语义一致',
        A.CONFIRM_FAIL.NOT_FOUND === 'export_dialog_confirm_not_found' && A.CONFIRM_FAIL.STALE === 'export_dialog_confirm_stale'
          && A.CONFIRM_FAIL.REJECTED === 'export_dialog_confirm_rejected' && A.CONFIRM_STAGE === 'export_dialog_confirm', '');
      ck('13g 候选文案以「确定」优先，且不含页面正文类文案', A.EXPORT_CONFIRM_LABELS[0] === '确定' && A.EXPORT_CONFIRM_LABELS.indexOf('下载清单') < 0, A.EXPORT_CONFIRM_LABELS.join(','));
      ck('13g redactText 脱敏 URL 与绝对路径', A.redactText('https://x.com/a /opt/zhongkong-sync-bot/state/x.json', 200) === '[url] [path]', A.redactText('https://x.com/a /opt/zhongkong-sync-bot/state/x.json', 200));
      ck('13g 默认轮询参数具备明确超时', A.DEFAULT_CONFIRM_WAIT.timeoutMs > 0 && A.DEFAULT_CONFIRM_WAIT.intervalMs > 0, JSON.stringify(A.DEFAULT_CONFIRM_WAIT));
    }
  }

  // 14) v0.3.2 直接下载（无站内确认弹窗）：export=1 / confirm=0 / download click=0，转入被动下载等待
  {
    const EXPORT_APPROVALS = { export_submit: true, download_list: true, download_file: true };
    const clicksWith = (client, purpose) => client.log.cmds.filter((c) => c.cmd === 'click' && c.args && c.args.purpose === purpose);

    // 14a 无站内弹窗：不再判失败，标 confirmation_mode=absent_direct_download，且不点击任何下载
    {
      const oldFile = path.join(TMP, 'old-round-report-a.xlsx');
      const oldCrdl = path.join(TMP, 'old-round.crdownload');
      fs.writeFileSync(oldFile, Buffer.alloc(64, 7));
      fs.writeFileSync(oldCrdl, Buffer.alloc(64, 8));
      const { ad, client, audited, waitCalls } = build({
        approvals: EXPORT_APPROVALS,
        client: { replies: { overlays: { frameCount: 0, best: null, has_blocking_overlay: false, frames: [] }, probe: { merged: {} } } },
        waitForDownloadFile: async () => ({ ok: true, file: path.join(TMP, 'new-round-report-a.xlsx'), name: 'new-round-report-a.xlsx', size: 25179, stable_polls: 2 }),
      });
      const r = await ad.submitExport({ ctx: CTX });
      ck('14a 无站内确认弹窗 ⇒ 判为成功（confirmation_mode=absent_direct_download），export=1 / confirm=0 / download click=0',
        r.ok === true && r.confirmation_mode === 'absent_direct_download' && clicksWith(client, 'export').length === 1 &&
        clicksWith(client, 'export_dialog_confirm').length === 0 && clicksWith(client, 'download').length === 0 && r.confirm_click_calls === 0,
        JSON.stringify({ ok: r.ok, mode: r.confirmation_mode, export: clicksWith(client, 'export').length, confirm: clicksWith(client, 'export_dialog_confirm').length, download: clicksWith(client, 'download').length }));
      ck('14a 已写只读审计 export_dialog_confirm_absent（不含 selector/正文）',
        audited.some((x) => x.event === 'export_dialog_confirm_absent' && x.confirmation_mode === 'absent_direct_download' && !Object.prototype.hasOwnProperty.call(x, 'selector')),
        JSON.stringify(audited.slice(-1)));
      const w = await ad.waitForPassiveFile({ ctx: CTX, sinceMs: Date.now() - 1000 });
      ck('14a 随后进入被动下载等待：只接受本轮新增文件（excludeNames=export 前快照，含旧 xlsx 与旧 .crdownload）+ 大小稳定≥2 次轮询',
        w.ok === true && waitCalls.length === 1 && Array.isArray(waitCalls[0].excludeNames) &&
        waitCalls[0].excludeNames.includes('old-round-report-a.xlsx') && waitCalls[0].excludeNames.includes('old-round.crdownload') &&
        Number(waitCalls[0].stablePolls) >= 2,
        JSON.stringify({ exclude: waitCalls[0] && waitCalls[0].excludeNames, stablePolls: waitCalls[0] && waitCalls[0].stablePolls }));
      ck('14a 被动下载结果透传新文件名/大小与稳定性证据', w.ok === true && w.name === 'new-round-report-a.xlsx' && w.size === 25179 && Number(w.stable_polls) >= 2, JSON.stringify({ name: w.name, size: w.size }));
    }

    // 14a2 平台异步通知可见，但没有安全按钮：记录通知原文，不误标为直下。
    {
      const notice = '本次导出数据共20条，请前往「下载清单」查看下载状态 我知道了 前往下载清单';
      const overlay = { frameCount: 1, has_blocking_overlay: true, frames: [{ frameIndex: 1,
        overlays: [{ is_mask_only: false, text: notice, controls: [] }] }] };
      const { ad, client, audited } = build({ approvals: EXPORT_APPROVALS,
        client: { replies: { overlays: overlay, probe: { merged: {} } } } });
      const r = await ad.submitExport({ ctx: CTX });
      ck('14a2 异步通知无安全按钮：原文落盘，零确认/下载点击，不误判直下',
        r.ok === true && r.confirmation_mode === 'async_notice_observed' && r.record.notice_text === notice
        && clicksWith(client, 'export_dialog_confirm').length === 0 && clicksWith(client, 'download').length === 0
        && audited.some((e) => e.event === 'export_async_notice_seen' && e.text === notice),
        JSON.stringify({ mode: r.confirmation_mode, notice: r.record.notice_text }));
    }

    // 14b 有站内弹窗：仍然 export=1 / confirm=1，confirmation_mode=dialog_confirmed
    {
      const { ad, client } = build({
        approvals: EXPORT_APPROVALS,
        client: { replies: { overlays: { frameCount: 1, has_blocking_overlay: true, frames: [{ frameIndex: 0, overlays: [{ is_mask_only: false, area_ratio: 0.2, controls: [{ tag: 'button', text: '确定', selector: '#dlg-ok', rect: { x: 1, y: 1, w: 40, h: 20 } }] }] }] } } },
      });
      const r = await ad.submitExport({ ctx: CTX });
      ck('14b 有站内确认弹窗 ⇒ export=1 / confirm=1，confirmation_mode=dialog_confirmed',
        r.ok === true && r.confirmation_mode === 'dialog_confirmed' && clicksWith(client, 'export').length === 1 && clicksWith(client, 'export_dialog_confirm').length === 1,
        JSON.stringify({ mode: r.confirmation_mode, export: clicksWith(client, 'export').length, confirm: clicksWith(client, 'export_dialog_confirm').length }));
    }

    // 14b2 平台异步通知 +「我知道了」：只点一次该按钮并保存原文。
    {
      const notice = '本次导出数据共20条，请前往「下载清单」查看下载状态 我知道了 前往下载清单';
      const overlay = { frameCount: 1, has_blocking_overlay: true, frames: [{ frameIndex: 1,
        overlays: [{ is_mask_only: false, text: notice, controls: [
          { tag: 'button', text: '我知道了', selector: '#notice-ok' },
          { tag: 'button', text: '前往下载清单', selector: '#notice-list' },
        ] }] }] };
      const { ad, client } = build({ approvals: EXPORT_APPROVALS,
        client: { replies: { overlays: overlay, inspect: { exists: true, visible: true, enabled: true, text: '我知道了' } } } });
      const r = await ad.submitExport({ ctx: CTX });
      ck('14b2 异步通知：仅点「我知道了」一次，原文保留',
        r.ok === true && r.record.notice_text === notice && r.dialog_candidate_label === '我知道了'
        && clicksWith(client, 'export_dialog_confirm').length === 1
        && clicksWith(client, 'export_dialog_confirm')[0].args.selector === '#notice-ok'
        && clicksWith(client, 'download').length === 0,
        JSON.stringify({ ok: r.ok, label: r.dialog_candidate_label, clicks: clicksWith(client, 'export_dialog_confirm').length }));
    }

    // 14c 失败语义保持：stale / rejected / export_click_failed 不携带 confirmation_mode
    {
      const OVERLAY = { frameCount: 1, has_blocking_overlay: true, frames: [{ frameIndex: 0, overlays: [{ is_mask_only: false, area_ratio: 0.2, controls: [{ tag: 'button', text: '确定', selector: '#dlg-ok', rect: { x: 1, y: 1, w: 40, h: 20 } }] }] }] };
      const { ad: a1, client: c1 } = build({ approvals: EXPORT_APPROVALS, client: { replies: { overlays: OVERLAY }, failWhen: (cmd, args) => (cmd === 'click' && args && args.purpose === 'export_dialog_confirm' ? new Error('frame.evaluate: Error: element not found') : null) } });
      const r1 = await a1.submitExport({ ctx: CTX });
      ck('14c 确认按钮点击时消失 ⇒ 仍为 export_dialog_confirm_stale，confirm 恰好 1 次，且无 confirmation_mode',
        r1.ok === false && r1.reason === 'export_dialog_confirm_stale' && clicksWith(c1, 'export_dialog_confirm').length === 1 && !r1.confirmation_mode,
        JSON.stringify({ reason: r1.reason, confirm: clicksWith(c1, 'export_dialog_confirm').length, mode: r1.confirmation_mode }));
      const { ad: a2, client: c2 } = build({ approvals: EXPORT_APPROVALS, client: { replies: { overlays: OVERLAY }, failWhen: (cmd, args) => (cmd === 'click' && args && args.purpose === 'export_dialog_confirm' ? new Error('宿主拒绝：未授权') : null) } });
      const r2 = await a2.submitExport({ ctx: CTX });
      ck('14c host 拒绝 ⇒ 仍为 export_dialog_confirm_rejected，confirm 恰好 1 次',
        r2.ok === false && r2.reason === 'export_dialog_confirm_rejected' && clicksWith(c2, 'export_dialog_confirm').length === 1, String(r2.reason));
      const { ad: a3, client: c3 } = build({ approvals: EXPORT_APPROVALS, client: { failWhen: (cmd, args) => (cmd === 'click' && args && args.purpose === 'export' ? new Error('选择器在所有 frame 中都不存在：#export') : null) } });
      const r3 = await a3.submitExport({ ctx: CTX });
      ck('14c export 点击响应失败 ⇒ 视为可能已点击且不进入任何等待/确认',
        r3.ok === false && r3.reason === 'export_click_failed' && r3.export_clicked === true && r3.export_submitted_uncertain === true && !r3.confirmation_mode && clicksWith(c3, 'export').length === 1, String(r3.reason));
    }
  }

  // 10) 白名单/黑名单集合自洽
  ck('10a 黑名单命令不出现在白名单', [...A.FORBIDDEN_HOST_COMMANDS].every((c) => !A.ALLOWED_HOST_COMMANDS.has(c)), '');
  ck('10b 下载动作常量与匹配器一致', M.DOWNLOAD_ACTION === '下载' && M.READY_STATUS === '导出完成', `${M.DOWNLOAD_ACTION}/${M.READY_STATUS}`);

  const ok = results.every((r) => r.ok);
  console.log(JSON.stringify({ ok, tmp_root: TMP, total: results.length, failed: results.filter((r) => !r.ok).length, results }, null, 2));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(ok ? 0 : 1);
})();
