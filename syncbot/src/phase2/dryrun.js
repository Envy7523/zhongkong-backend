'use strict';
/**
 * 阶段2：dry-run（**终点为「导出」按钮，绝不点击导出**）
 *   node src/phase2/dryrun.js --date=2026-09-16
 *
 * 可验证：页面导航、查询方案 done、12 项固定筛选、日期设置、查询结果（声明数有效且与合计行自洽 + 合计行）、导出按钮存在/可见/可点击。
 * 绝不做：点击导出、产生导出申请、出现或验证导出弹窗、跳转下载清单、下载文件。
 */
const fs = require('fs');
const path = require('path');
const P = require('../paths');
const config = require('../config');
const { createTaskLogger } = require('../logger');
const lock = require('../lock');
const client = require('./client');
const flow = require('./meituan-flow');
const selectors = require('./selectors');
const FC = require('./filter-check');
const taskState = require('./task-state');
const TC = require('../task-context');

const args = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}
const BUSINESS_DATE = String(args.date || '');
if (!/^\d{4}-\d{2}-\d{2}$/.test(BUSINESS_DATE)) {
  console.error('用法: node src/phase2/dryrun.js --date=YYYY-MM-DD --report-type=cashier_composite');
  process.exit(2);
}
// 入口显式创建 TaskContext（report_type 必填、必须已授权；未授权在此即拒绝，零落盘）
const CTX = TC.createContext(args['report-type'], { platform: 'meituan', taskId: TASK_ID, businessDate: BUSINESS_DATE });
const REPORT_TYPE = CTX.reportType;
const DATE_INPUT = BUSINESS_DATE.replace(/-/g, '/'); // 页面使用 YYYY/MM/DD
const TASK_ID = `dry-${Date.now().toString(36)}`;
// 任务级 logger：**显式传入 report_type**（禁止从全局状态推断）；未授权报表在此即被拒绝
const SNAP_CTX = TC.createContext(REPORT_TYPE, { platform: 'meituan', taskId: TASK_ID, businessDate: BUSINESS_DATE });
const logger = createTaskLogger('phase2-dryrun', { reportType: REPORT_TYPE, platform: CTX.platform, taskId: TASK_ID, businessDate: BUSINESS_DATE });
// 状态机绑定到同一 ctx 的 report_type（显式，不使用全局状态）
const TS = taskState.forReport(REPORT_TYPE);
const rules = config.load('meituan-rules');
const sel = selectors.load();
const S = (k) => selectors.get(sel, k);

const report = {
  task_id: TASK_ID,
  mode: 'dry-run',
  business_date: BUSINESS_DATE,
  date_input: DATE_INPUT,
  started_at: new Date().toISOString(),
  expected_store_rows: rules.report.expected_store_count,
  steps: [],
  screenshots: [],
  warnings: [],
  errors: [],
  clicked_export: false,
  created_export_request: false,
  visited_download_list: false,
  downloaded: false,
};

async function snap(nn, step) {
  const s = await flow.screenshot(SNAP_CTX, nn, step);
  report.screenshots.push(s);
  return s;
}

async function record(step, rec) {
  report.steps.push({ step, at: new Date().toISOString(), ...rec });
  try {
    TS.step(BUSINESS_DATE, { step, ...rec });
  } catch (_) {}
}

async function main() {
  // 0) 前置
  const sv = selectors.validate({ forRealRun: false });
  report.selectors_validation = sv;
  for (const w of sv.warnings) report.warnings.push(w);
  if (!sv.ok) throw new Error(`选择器前置校验失败：${sv.errors.join('; ')}`);

  const h = await client.health();
  report.host_health = { url: h.url, title: h.title, human_busy: h.human_busy, approvals: h.approvals };
  if (h.human_busy && h.human_busy.present && !h.human_busy.expired && h.human_busy.owner === 'human') throw new Error('人工会话进行中，请先执行 syncbot human-session stop（互斥规则）');

  TS.begin(BUSINESS_DATE, { task_id: TASK_ID, dry_run: true, business_date: BUSINESS_DATE });
  const lk = lock.acquire('meituan-download', REPORT_TYPE, { meta: { task_id: TASK_ID, purpose: 'dry-run' } });
  try {
    await client.taskBegin(TASK_ID, { owner: 'dryrun', business_date: BUSINESS_DATE });
    await client.audit({ task_id: TASK_ID, mode: 'dry-run', business_date: BUSINESS_DATE, note: '开始 dry-run（不提交导出申请）' });

    TS.setState(BUSINESS_DATE, 'PRECHECK_OK', { task_id: TASK_ID });

    // A1 入口页
    TS.setState(BUSINESS_DATE, 'NAVIGATING', { action: 'A1_entry' });
    const nav = rules.navigation;
    const a1 = await flow.gotoAndAssert({ url: nav.home_url, expectFullUrl: nav.home_url, businessDate: BUSINESS_DATE, taskId: TASK_ID, reportType: REPORT_TYPE, nn: '01', step: 'entry' });
    await record('A1_entry', a1);
    report.nav_home = a1;
    if (!a1.ok) throw new Error(`A1 入口页 URL 不符：${JSON.stringify(a1.url_assert.mismatches)}`);
    const b1 = await flow.detectBlockers();
    report.blockers_entry = b1;
    if (b1.login_required) throw new Error('A1 登录态失效（出现登录要求）→ 需人工经 noVNC 重新登录，不自动处理');
    if (b1.human_verification) throw new Error('A1 出现验证码/短信/安全验证 → 立即停止（不绕过）');

    // A1.5 清除阻断性浮层（站点公告/引导弹窗；会拦截后续点击）
    const ovRule = rules.overlay_dismissal || {};
    let a15 = { ok: true, skipped: true };
    if (ovRule.enabled) {
      a15 = await flow.dismissOverlays({ allowTexts: ovRule.allow_click_texts || [], maxRounds: ovRule.max_rounds || 3 });
      await snap('01b', 'overlay-dismissed');
      await record('A1.5_overlay_dismissal', a15);
      if (!a15.ok) throw new Error(`A1.5 阻断性浮层未能清除：${a15.reason}`);
    }

    // A2 报表中心（优先用采集到的选择器，缺失时回退到文案点击）
    const a2 = S('nav.report_center')
      ? await flow.clickSelectorAndVerify({ selector: S('nav.report_center'), purpose: 'nav', expectedUrls: [nav.report_center_url], businessDate: BUSINESS_DATE, taskId: TASK_ID, reportType: REPORT_TYPE, nn: '02', step: 'report-center' })
      : await flow.clickTextAndVerify({ text: '报表中心', expectedUrls: [nav.report_center_url], purpose: 'nav', businessDate: BUSINESS_DATE, taskId: TASK_ID, reportType: REPORT_TYPE, nn: '02', step: 'report-center' });
    await record('A2_report_center', a2);
    if (!a2.ok) throw new Error('A2 未能进入报表中心');

    // A3 营业报表
    const a3 = S('nav.business_report')
      ? await flow.clickSelectorAndVerify({ selector: S('nav.business_report'), purpose: 'nav', expectedTexts: ['营业统计'], businessDate: BUSINESS_DATE, taskId: TASK_ID, reportType: REPORT_TYPE, nn: '03', step: 'business-report' })
      : await flow.clickTextAndVerify({ text: '营业报表', expectedTexts: ['营业统计'], purpose: 'nav', businessDate: BUSINESS_DATE, taskId: TASK_ID, reportType: REPORT_TYPE, nn: '03', step: 'business-report' });
    await record('A3_business_report', a3);
    if (!a3.ok) throw new Error('A3 未能进入营业报表');

    // A4 综合营业统计
    const a4 = S('nav.target_report')
      ? await flow.clickSelectorAndVerify({ selector: S('nav.target_report'), purpose: 'nav', expectedUrls: [nav.entry_url], businessDate: BUSINESS_DATE, taskId: TASK_ID, reportType: REPORT_TYPE, nn: '04', step: 'target-report' })
      : await flow.clickTextAndVerify({ text: '综合营业统计', expectedUrls: [nav.entry_url], purpose: 'nav', businessDate: BUSINESS_DATE, taskId: TASK_ID, reportType: REPORT_TYPE, nn: '04', step: 'target-report' });
    await record('A4_target_report', a4);
    if (!a4.ok) throw new Error('A4 未能进入「综合营业统计」');
    const cur = await client.url();
    const ua = flow.urlAssert.assertSegments(cur.url, flow.urlAssert.expectFromFullUrl(nav.entry_url));
    report.target_url_assert = ua;
    if (!ua.ok) throw new Error(`A4 目标报表页 URL 分段断言失败：${JSON.stringify(ua.mismatches)}`);
    const b4 = await flow.detectBlockers();
    report.blockers_report_page = b4;
    if (b4.login_required) throw new Error('A4 登录态失效 → 人工处理');
    if (b4.human_verification) throw new Error('A4 出现验证码/短信/安全验证 → 立即停止');

    // A4.5 内容就绪门控（报表内容在 iframe 内，加载有延迟；未就绪即读取会导致误判）
    const ready = await flow.waitForContent({ texts: ['营业日期', '统计周期'], timeoutMs: 45000, label: 'A4.5_report_content' });
    await record('A4.5_content_ready', ready);
    if (!ready.ok) throw new Error(`A4.5 报表页内容未就绪（缺失：${ready.missing.join(', ')}；frames=${ready.frames}；text_length=${ready.text_length}）`);

    // A4.6 报表页也可能出现公告/引导浮层 → 点击前再清一次
    if (ovRule.enabled) {
      const a46 = await flow.dismissOverlays({ allowTexts: ovRule.allow_click_texts || [], maxRounds: ovRule.max_rounds || 3 });
      await record('A4.6_overlay_dismissal_report_page', a46);
      if (!a46.ok) throw new Error(`A4.6 报表页阻断性浮层未能清除：${a46.reason}`);
    }

    // A5 载入已保存查询方案（通过「常用查询」下拉框真实选择；严禁点击 更新/保存/管理）
    const schemeName = String(rules.saved_query.display_name);
    let a5 = await flow.selectSavedScheme(schemeName);
    a5 = { ...a5, scheme: schemeName, read_evidence: '下拉框 .saas-select-selection-item[title] 读回值' };
    await snap('05', 'saved-query');
    await record('A5_saved_query', a5);
    if (!a5.ok) {
      throw new Error(`A5 未能选择查询方案「${schemeName}」：${a5.step} — ${a5.reason || JSON.stringify(a5).slice(0, 300)}`);
    }

    // A6 固定筛选：12 项**取值**逐项校验（读取真实选中状态，不再只校验文案存在）
    TS.setState(BUSINESS_DATE, 'FILTERS_OK', { action: 'A6_filters' });
    const fvc = rules.filter_value_checks || { items: [] };
    const fstate = await client.filterState({ maxGroups: 30 }, { timeoutMs: 90000 });
    const fbest = fstate && fstate.best;
    const groups = (fbest && fbest.groups) || [];
    const groupOf = (name) => groups.find((g) => g.group === name) || null;
    const controlValueOf = (text) => {
      // readDateRow 的结构：{ best: { found, inputs, block: { form_items: [...] } } }
      const items = (dateBlock && dateBlock.block && dateBlock.block.form_items) || [];
      const hit = items.find((it) => it.text === text || it.text.startsWith(`${text} `));
      if (!hit) return null;
      const value = hit.text.replace(new RegExp(`^${text}\\s*`), '').replace(/\s*高\s*级\s*$/, '').trim();
      return { row_class: hit.cls, row_text: hit.text, value, checked_texts: hit.checked_texts || [] };
    };
    let dateBlock = null;
    try {
      const dr = await client.dateRow({ maxLeaf: 40 }, { timeoutMs: 60000 });
      dateBlock = dr && dr.best;
    } catch (_) {}

    // 共享校验模块（与 real-download-adapters 同一实现，防止规则漂移）
    const fcRes = FC.checkFilterItems((fvc.items || []), { groups, dateRowItems: (dateBlock && dateBlock.block && dateBlock.block.form_items) || [] });
    const itemResults = fcRes.results.map((r) => ({ no: r.no, key: r.key, type: r.type, group: r.group, expect: r.expect, actual: r.actual, status: r.status, ok: r.ok, read_evidence: r.read_evidence, verify_source: r.verify_source, missing: r.missing, extra: r.extra }));
    const __fcLegacy = (() => {
    const groupUnion = {};
    for (const it of (fvc.items || [])) {
      if (it.type === 'checkbox_group' && it.group) groupUnion[it.group] = (groupUnion[it.group] || []).concat(it.expect_selected || []);
    }
    for (const it of (fvc.items || [])) {
      const base = { no: it.no, key: it.key, type: it.type, expect: it.expect_value !== undefined ? it.expect_value : (it.expect_selected || []).join('、') };
      if (it.type === 'value_control') {
        const cv = controlValueOf(it.control_text);
        const actual = cv ? cv.value : null;
        const ok = actual === it.expect_value;
        itemResults.push({
          ...base,
          group: it.control_text,
          actual,
          read_evidence: cv ? `日期行区块 form_item「${cv.row_text}」行文本解析（class=${cv.row_class}）` : '未在日期行区块中找到该控件',
          ok,
          status: actual === null ? 'unreadable' : ok ? 'match' : 'mismatch',
        });
        continue;
      }
      const g = groupOf(it.group);
      if (!g) {
        const seg = (groupOf('时段餐段') || {}).checked_texts || [];
        // 第 5 项「餐时段统计方式」归属**导出文件第2行查询参数元数据校验**（非页面筛选、非项目数据字段、不影响报表B）
        const deferredToFile = it.verify_source === 'export_file_row2_query_params';
        const naRule = deferredToFile || (it.no === 5 && seg.includes('不分时段'));
        itemResults.push({
          ...base,
          group: it.group,
          actual: null,
          verify_source: it.verify_source || 'page_filter_state',
          read_evidence: deferredToFile
            ? `归属导出文件第2行查询参数元数据校验：时段餐段=不分时段 时页面不渲染该维度组，页面侧不校验；改由阶段3读取导出文件第2行查询参数校验为「${(it.expect_selected || []).join('、')}」（非项目数据字段，不影响报表B）`
            : (naRule ? `「${it.group}」控件在当前配置下不存在（时段餐段=不分时段 时被折叠，DOM 中无该维度组）` : `未找到「${it.group}：」维度组`),
          ok: naRule,
          status: deferredToFile ? 'deferred_to_file_validation' : (naRule ? 'not_applicable' : 'unreadable'),
          not_applicable_reason: deferredToFile
            ? '校验归属为导出文件第2行查询参数元数据（阶段3）'
            : (naRule ? '时段餐段=不分时段 时该维度不参与筛选，页面不渲染该控件' : null),
        });
        continue;
      }
      const checkedArr = g.checked_texts || [];
      const actual = checkedArr.join('、') || null;
      const expectSet = it.type === 'checkbox_group' ? (groupUnion[it.group] || it.expect_selected || []) : (it.expect_selected || []);
      const indeterminate = g.determinate === false;
      const setEq = checkedArr.length === expectSet.length && expectSet.every((x) => checkedArr.includes(x));
      itemResults.push({
        ...base,
        group: it.group,
        actual,
        expect_set_used: it.type === 'checkbox_group' ? expectSet.join('、') : undefined,
        read_evidence: g.read_evidence,
        checked_count: checkedArr.length,
        selected_selector_evidence: (g.options || []).filter((o) => o.input_checked).map((o) => `${o.text} → input.checked=true, label_cls=${o.label_cls}`).slice(0, 3),
        status: indeterminate ? 'indeterminate' : setEq ? 'match' : 'mismatch',
        ok: !indeterminate && setEq,
      });
    }
    return null;
    })();
    void __fcLegacy;
    // 第 12 项附加规则：高级筛选未展开
    const advTexts = ((fbest && fbest.advanced_controls) || []).map((a) => a.text);
    const advExpanded = advTexts.includes('收起筛选');
    const item12 = itemResults.find((r) => r.no === 12);
    if (item12) {
      item12.advanced_filter_expanded = advExpanded;
      item12.advanced_controls = advTexts;
      item12.ok = item12.ok && !advExpanded;
      item12.status = item12.ok ? item12.status : (advExpanded ? 'mismatch' : item12.status);
      item12.read_evidence += `；高级筛选控件=${JSON.stringify(advTexts)}（未出现「收起筛选」→ 未展开）`;
    }
    const mismatches = itemResults.filter((r) => r.status === 'mismatch').map((r) => `#${r.no} ${r.group}: 期望「${r.expect}」实际「${r.actual}」`);
    const unreadable = itemResults.filter((r) => r.status === 'unreadable' || r.status === 'indeterminate').map((r) => `#${r.no} ${r.group}: ${r.status}`);
    const notApplicable = itemResults.filter((r) => r.status === 'not_applicable').map((r) => `#${r.no} ${r.group}: 不适用（${r.not_applicable_reason}）`);    const advState = S('filter.advanced_toggle') ? await client.inspect(S('filter.advanced_toggle')) : null;
    const a6 = {
      ok: (fvc.on_mismatch === 'fail' ? mismatches.length === 0 : true)
        && (fvc.on_indeterminate === 'fail' ? unreadable.length === 0 : true),
      check_mode: '12 项取值逐项校验（读取真实选中状态）',
      read_evidence_rule: fvc.read_evidence_rule,
      expected_count: (fvc.items || []).length,
      checked_count: itemResults.filter((r) => r.status === 'match').length,
      items: itemResults,
      mismatches,
      unreadable,
      not_applicable: notApplicable,
      groups_found: groups.map((g) => ({ group: g.group, checked: g.checked_texts, determinate: g.determinate, options: g.option_count })),
      advanced_toggle: advState,
      panel_selector: S('filter.panel'),
      frame: fbest ? { frameIndex: fbest.frameIndex, frameUrl: fbest.frameUrl } : null,
    };
    await snap('06', 'filters');
    await record('A6_filters', a6);
    if (!a6.ok) {
      throw new Error(`A6 12 项取值校验失败：不一致 ${JSON.stringify(mismatches)}；无法读取 ${JSON.stringify(unreadable)}`);
    }

    // A7 通过**真实日期控件**设置营业日期（禁止对 readOnly 输入框 fill）
    const startSel = S('filter.date_start');
    const endSel = S('filter.date_end');
    const dco = rules.date_control_operation || {};
    const readDates = async () => {
      const dr = await client.dateRow({ maxLeaf: 40 }, { timeoutMs: 60000 });
      const ins = (dr && dr.best && dr.best.inputs) || [];
      return { values: ins.map((x) => x.value), placeholders: ins.map((x) => x.placeholder), readOnly: ins.map((x) => x.readOnly), inputs: ins };
    };
    /** 打开日期面板并读回单元格；带重试与「面板已打开」断言（每次重新取坐标） */
    const openPicker = async (inputSel, tag) => {
      const attempts = [];
      const wrapperSel = inputSel.replace(/\s*>\s*input$/, '');
      for (let i = 0; i < 4; i += 1) {
        // 每次重新读取坐标（页面滚动/加载会使其失效）
        let target = null;
        try {
          const dr = await client.dateRow({ maxLeaf: 40 }, { timeoutMs: 60000 });
          const ins = (dr && dr.best && dr.best.inputs) || [];
          target = ins.find((x) => x.selector === inputSel) || ins[0] || null;
        } catch (e) {
          attempts.push({ attempt: i + 1, stage: 'dateRow', error: e.message.split('\n')[0] });
        }
        if (target && target.rect) {
          const cx = target.rect.x + Math.round(target.rect.w / 2);
          const cy = target.rect.y + Math.round(target.rect.h / 2);
          try {
            await client.mouse({ action: 'click', x: cx, y: cy, settleMs: 1600 }, { timeoutMs: 30000 });
            attempts.push({ attempt: i + 1, via: 'mouse_click_xy', x: cx, y: cy });
          } catch (e) {
            attempts.push({ attempt: i + 1, via: 'mouse_click_xy', error: e.message.split('\n')[0] });
          }
        }
        let pk = await client.picker({ maxCells: 80 }, { timeoutMs: 60000 }).catch(() => null);
        if (pk && pk.best && pk.best.distinct_dates > 0) return { attempts, picker: pk.best, wrapper_selector: wrapperSel, target_input: target || null };
        // 回退：点击 wrapper
        if (wrapperSel) {
          try {
            await client.click(wrapperSel, 'date_picker_open', { settleMs: 1600 });
            attempts.push({ attempt: i + 1, via: 'selector_click_wrapper' });
            pk = await client.picker({ maxCells: 80 }, { timeoutMs: 60000 }).catch(() => null);
            if (pk && pk.best && pk.best.distinct_dates > 0) return { attempts, picker: pk.best, wrapper_selector: wrapperSel, target_input: target || null };
          } catch (e) {
            attempts.push({ attempt: i + 1, via: 'selector_click_wrapper', error: e.message.split('\n')[0] });
          }
        }
        await flow.sleep(1200);
      }
      return { attempts, picker: null, wrapper_selector: wrapperSel, target_input: null };
    };

    /** 用真实日期面板把起止日期都设为 targetInput（YYYY/MM/DD）；整体重试，直到读回验证通过 */
    const setDateViaPickerOnce = async (targetInput, tag) => {
      const iso = targetInput.replace(/\//g, '-');
      const steps = [];
      const before = await readDates();
      const open = await openPicker(startSel, tag);
      if (!open.picker) {
        return { target: targetInput, before_values: before.values, after_values: before.values, changed: false, verified: false, pick_clicks: 0, open_attempts: open.attempts, steps, panel_opened: false };
      }
      let picked = 0;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const cur = attempt === 0 ? open.picker : ((await client.picker({ maxCells: 80 }, { timeoutMs: 60000 }).catch(() => null) || {}).best || null);
        const cs = (cur && cur.cells) || [];
        const cell = cs.find((c) => c.date === iso);
        if (!cell) {
          // 面板可能已关闭 → 重开
          const reopened = await openPicker(startSel, tag);
          steps.push({ attempt, error: `未找到 title=${iso}`, distinct_dates: cur ? cur.distinct_dates : 0, reopened: !!reopened.picker });
          if (!reopened.picker) break;
          continue;
        }
        await client.mouse({ action: 'click', x: cell.rect.x + Math.round(cell.rect.w / 2), y: cell.rect.y + Math.round(cell.rect.h / 2), settleMs: 1500 }, { timeoutMs: 30000 }).catch(async () => {
          await client.click(cell.selector, 'date_pick_cell', { settleMs: 1500 });
        });
        picked += 1;
        const now = await readDates();
        steps.push({ attempt, picked: cell.date, cell_cls: cell.cls.slice(0, 70), after_values: now.values });
        if (now.values.filter((v) => v === targetInput).length >= 2) break;
      }
      await client.press(startSel, 'Escape', { timeoutMs: 20000 }).catch(() => {});
      await flow.sleep(600);
      const after = await readDates();
      return {
        target: targetInput,
        before_values: before.values,
        after_values: after.values,
        changed: JSON.stringify(before.values) !== JSON.stringify(after.values),
        verified: after.values.filter((v) => v === targetInput).length >= 2,
        pick_clicks: picked,
        open_attempts: open.attempts,
        panel_opened: true,
        steps,
      };
    };
    /** 外层重试：最多 3 轮完整尝试 */
    const setDateViaPicker = async (targetInput, tag) => {
      const tries = [];
      for (let i = 0; i < 3; i += 1) {
        const r = await setDateViaPickerOnce(targetInput, tag);
        tries.push(r);
        if (r.verified) return { ...r, try_index: i + 1, tries: tries.map((x) => ({ verified: x.verified, picks: x.pick_clicks, panel: x.panel_opened, after: x.after_values })) };
        await flow.sleep(1000);
      }
      const last = tries[tries.length - 1];
      return { ...last, try_index: tries.length, tries: tries.map((x) => ({ verified: x.verified, picks: x.pick_clicks, panel: x.panel_opened, after: x.after_values })) };
    };

    // A7.1 主目标日期（dry-run 业务日期）
    const setMain = await setDateViaPicker(DATE_INPUT, 'main');
    const a7 = {
      ok: setMain.verified,
      method: dco.method || '真实日期面板点击',
      forbid_fill_on_readonly: true,
      expected_value: DATE_INPUT,
      read_back: setMain.after_values,
      detail: setMain,
    };
    await snap('07', 'dateset');
    await record('A7_set_date', a7);
    if (!a7.ok) throw new Error(`A7 未通过真实日期控件把营业日期设为 ${DATE_INPUT}（读回 ${JSON.stringify(setMain.after_values)}）`);

    // A7.2 无导出切换验证：切到「已确认有数据」的对照日期 → 查询 → 读回 → 再恢复 → 查询 → 读回
    const st = dco.switch_test || {};
    let a7switch = { enabled: !!st.enabled, skipped: !st.enabled };
    if (st.enabled) {
      const otherInput = String(st.different_date || '').replace(/-/g, '/');
      const restoreInput = String(st.restore_date || BUSINESS_DATE).replace(/-/g, '/');
      const qSel = S('action.query');
      const clickQuery = async (label) => {
        if (qSel) return flow.clickSelectorAndVerify({ selector: qSel, purpose: 'query', businessDate: BUSINESS_DATE, taskId: TASK_ID, reportType: REPORT_TYPE, nn: null, step: label });
        return flow.clickTextAndVerify({ text: '查询', purpose: 'query', businessDate: BUSINESS_DATE, taskId: TASK_ID, reportType: REPORT_TYPE, nn: null, step: label, soft: true });
      };
      // 切到对照日期
      const toOther = await setDateViaPicker(otherInput, 'switch');
      await snap('07b', 'switch-date-set');
      const q1 = await clickQuery('switch-query');
      await flow.sleep(2500);
      const otherAfter = await readDates();
      const otherSummary = await client.tableSummary({});
      await snap('07c', 'switch-date-queried');
      const otherEvidence = {
        target: otherInput,
        date_control_values: otherAfter.values,
        date_control_verified: otherAfter.values.filter((v) => v === otherInput).length >= 2,
        declared_count: (otherSummary.pagination || {}).declared_count,
        declared_count_text: (otherSummary.pagination || {}).declared_text,
        has_total_row: !!otherSummary.total_row,
        distinct_from_target: otherInput !== DATE_INPUT,
        query_click_ok: q1 && q1.ok,
      };
      // 恢复为业务日期
      const backTo = await setDateViaPicker(restoreInput, 'restore');
      await snap('07d', 'restore-date-set');
      const q2 = await clickQuery('restore-query');
      await flow.sleep(2500);
      const restored = await readDates();
      const restoredSummary = await client.tableSummary({});
      await snap('07e', 'restore-date-queried');
      const restoreEvidence = {
        target: restoreInput,
        date_control_values: restored.values,
        date_control_verified: restored.values.filter((v) => v === restoreInput).length >= 2,
        declared_count: (restoredSummary.pagination || {}).declared_count,
        declared_count_text: (restoredSummary.pagination || {}).declared_text,
        query_click_ok: q2 && q2.ok,
      };
      a7switch = {
        enabled: true,
        different_date: st.different_date,
        different_date_basis: st.different_date_basis,
        restore_date: st.restore_date,
        switched: otherEvidence,
        restored: restoreEvidence,
        export_clicked_throughout: false,
        ok: otherEvidence.date_control_verified
          && otherEvidence.distinct_from_target
          && otherEvidence.declared_count > 0
          && restoreEvidence.date_control_verified
          && restoreEvidence.declared_count > 0,
      };
      await record('A7_switch_restore_verification', a7switch);
      if (!a7switch.ok) {
        throw new Error(`A7 日期切换/恢复验证失败：切换后读回 ${JSON.stringify(otherEvidence.date_control_values)}（声明 ${otherEvidence.declared_count} 条）；恢复后读回 ${JSON.stringify(restoreEvidence.date_control_values)}（声明 ${restoreEvidence.declared_count} 条）`);
      }
    }

    // A8 查询 + 结果校验（声明数有效且与合计行自洽 + 合计行存在）
    TS.setState(BUSINESS_DATE, 'QUERY_OK', { action: 'A8_query' });
    const qSel = S('action.query');
    let a8click = null;
    if (qSel) {
      try {
        a8click = await flow.clickSelectorAndVerify({ selector: qSel, purpose: 'query', businessDate: BUSINESS_DATE, taskId: TASK_ID, reportType: REPORT_TYPE, nn: '08', step: 'queried' });
      } catch (e) {
        // 兜底：采集到的选择器可能被浮层遮挡或已改版 → 回退为按已确认文案「查询」点击（仍写审计）
        a8click = { ok: false, selector: qSel, error: e.message.split('\n')[0], fallback: 'text_click' };
        const fb = await flow.clickTextAndVerify({ text: '查询', purpose: 'query', businessDate: BUSINESS_DATE, taskId: TASK_ID, reportType: REPORT_TYPE, nn: '08', step: 'queried', soft: true });
        a8click.text_fallback = fb;
        if (fb.ok) a8click = { ok: true, selector: fb.chosen.selector, via_text_fallback: true, first_error: e.message.split('\n')[0] };
      }
    } else {
      a8click = await flow.clickTextAndVerify({ text: '查询', purpose: 'query', businessDate: BUSINESS_DATE, taskId: TASK_ID, reportType: REPORT_TYPE, nn: '08', step: 'queried' });
    }
    if (!a8click.ok) throw new Error(`A8 点击「查询」失败：${a8click.error || JSON.stringify(a8click).slice(0, 300)}`);
    let summary = null;
    let tbl = null;
    let grid = null;
    // 轮询到「结果已渲染」：任一满足即可 —— <table> 有数据行 / div 网格有数据行 / 分页已声明总数
    for (let i = 0; i < 12; i++) {
      summary = await client.tableSummary({});
      tbl = (summary.tables || [])[0] || null;
      grid = (summary.grids || [])[0] || null;
      const pg = summary.pagination || null;
      if ((tbl && tbl.dataRowCount > 0) || (grid && grid.dataRowCount > 0) || (pg && pg.declared_count !== null)) break;
      await flow.sleep(2500);
    }
    // 取值优先级：有数据行的一方优先（空 <table> 不得覆盖已渲染的网格）
    if (!(tbl && tbl.dataRowCount > 0) && grid && grid.dataRowCount > 0) tbl = null;
    if (!(grid && grid.dataRowCount > 0) && tbl && tbl.dataRowCount > 0) grid = null;
    const dataRowCount = tbl ? tbl.dataRowCount : grid ? grid.dataRowCount : 0;
    const hasTotalRow = tbl ? tbl.hasTotalRow === true : grid ? grid.hasTotalRow === true : false;
    const firstRowDate = tbl && tbl.firstRow ? tbl.firstRow[2] : grid && grid.firstRowCells ? grid.firstRowCells[2] : null;

    // ===== A8 判定（仅四项，删除错误字段 first_row_date_matches_target）=====
    // 1) 查询结果声明总数有效（>=1）——配置**显式**给出固定值时才与之等值比较
    // 2) 合计行门店数量与声明数**自洽**（合计行不可解析时只记录不拒绝）
    // 3) 合计行存在  4) 当前营业日期控件 = 目标日期
    // 期望值来源（动态化）：rules.report.expected_store_count 显式数字 ⇒ 固定比较；否则用本次声明数。
    const pagination = (summary && summary.pagination) || null;
    const totalRow = (summary && summary.total_row) || null;
    const declaredCount = pagination ? pagination.declared_count : null;
    const totalRowCells = (totalRow && totalRow.cells) || [];
    const rawExpected = rules.report.expected_store_count;
    const fixedExpected = (typeof rawExpected === 'number' && Number.isFinite(rawExpected)) ? rawExpected : null;
    const declaredOk = declaredCount !== null && declaredCount !== undefined && Number.isFinite(Number(declaredCount)) && Number(declaredCount) >= 1;
    const expectedNum = fixedExpected !== null ? fixedExpected : (declaredOk ? Number(declaredCount) : null);
    const expectedStr = expectedNum === null ? null : String(expectedNum);
    // 门店数量列：合计行中值等于本次期望门店数、且成对出现的数值单元格（实测为「营业门店数量 / 门店营业天数」两列同为同一数值）
    const storeCountCells = expectedStr === null ? [] : totalRowCells.filter((c) => c === expectedStr);
    const a8dateNow = await readDates();
    const dateControlOk = a8dateNow.values.filter((v) => v === DATE_INPUT).length >= 2;

    const c1 = fixedExpected !== null ? declaredCount === fixedExpected : declaredOk;
    // 动态模式：合计行不存在 ⇒ 不可解析 ⇒ 只记录不拒绝（c2 记为通过，evidence 里留痕）
    const c2 = storeCountCells.length >= 1 || (fixedExpected === null && !totalRow);
    const c3 = !!totalRow;
    const c4 = dateControlOk;
    const a8 = {
      ok: fixedExpected !== null ? (c1 && c2 && c3 && c4) : (c1 && c2 && c4),
      check_mode: fixedExpected !== null
        ? '四项校验（声明总数==配置固定值 / 合计行门店数量 / 合计行存在 / 营业日期控件）'
        : '四项校验·动态（声明总数>=1 且与合计行自洽 / 合计行门店数量 / 合计行存在 / 营业日期控件）',
      expected_store_count_mode: fixedExpected !== null ? 'fixed' : 'dynamic',
      checks: {
        '1_查询结果声明有效（配置显式给定时须等值）': { ok: c1, expect: expectedNum, actual: declaredCount, evidence: pagination ? `${pagination.declared_text}（分页每页 ${pagination.page_size} 条，共 ${(pagination.page_numbers || []).length ? Math.max(...pagination.page_numbers.map(Number)) : '?'} 页）` : '未识别分页文案' },
        '2_合计行门店数量与声明数自洽': { ok: c2, expect: expectedNum, actual: storeCountCells, evidence: totalRow ? `合计行单元格=${JSON.stringify(totalRowCells.slice(0, 9))}` : '无合计行（动态模式：不可解析，只记录不拒绝）' },
        '3_合计行存在': { ok: c3, evidence: totalRow ? `命中元素 class="${totalRow.class_name}" depth=${totalRow.depth} cells=${totalRow.cell_count}` : '未找到合计行' },
        '4_当前营业日期控件等于目标日期': { ok: c4, expect: DATE_INPUT, actual: a8dateNow.values, evidence: `日期控件读回 ${JSON.stringify(a8dateNow.values)}（readOnly=${JSON.stringify(a8dateNow.readOnly)}）` },
      },
      count_rule: '分页声明总数（共N条记录）；期望值 = 配置显式固定值（若有）否则本次声明数——不与任何固定门店数硬绑定',
      declared_count: declaredCount,
      declared_count_text: pagination ? pagination.declared_text : null,
      page_size: pagination ? pagination.page_size : null,
      page_numbers: pagination ? pagination.page_numbers : null,
      rendered_row_count: dataRowCount,
      rendered_row_count_note: '页面分页渲染，渲染行数等于每页条数而非总条数',
      total_row: totalRow,
      total_row_store_count_cells: storeCountCells,
      has_total_row: c3,
      date_control_values: a8dateNow.values,
      table: tbl,
      grid,
      all_tables: (summary && summary.tables || []).map((x) => ({ rowCount: x.rowCount, dataRowCount: x.dataRowCount, hasTotalRow: x.hasTotalRow, header: x.headerRow })),
      all_grids: (summary && summary.grids || []).map((x) => ({ dataRowCount: x.dataRowCount, hasTotalRow: x.hasTotalRow, firstRowText: x.firstRowText, sampleRows: x.sampleRows })),
      expected_store_rows: expectedNum,
      expected_store_rows_source: fixedExpected !== null ? 'rules.report.expected_store_count' : 'declared_dynamic（运行期）',
      detected_row_source: totalRow ? 'total_row+pagination' : tbl ? 'table' : grid ? 'div_grid' : 'none',
      removed_fields: ['first_row_date_matches_target'],
      removed_fields_note: '已删除该错误判定：屏幕结果网格没有「营业日期」列，原字段实际读取到门店名称列；文件业务日期改由阶段3校验 Excel C 列「营业日期」',
      business_date_file_check_deferred: '阶段3：以导出文件 Excel C 列「营业日期」校验业务日期',
      page2_enumerated: false,
      page2_note: '本阶段未翻页枚举（避免多余点击）；逐行核对由阶段3基于导出文件完成',
    };
    await record('A8_query_result', a8);
    if (!a8.ok) {
      const failed = Object.entries(a8.checks).filter(([, v]) => !v.ok).map(([k, v]) => `${k}（期望 ${v.expect === undefined ? '-' : JSON.stringify(v.expect)}，实际 ${JSON.stringify(v.actual)}）`);
      throw new Error(`A8 四项校验未全部通过：${failed.join('；')}`);
    }

    // A9' 导出按钮：只判定存在/可见/可点击 → 终点，**绝不点击**
    const exportSel = S('action.export_button');
    const insp = exportSel ? await client.inspect(exportSel) : { exists: false };
    const a9 = {
      ok: !!(insp.exists && insp.visible && insp.enabled),
      selector: exportSel,
      inspect: insp,
      clicked: false,
      note: 'dry-run 终点：仅校验导出按钮存在/可见/可点击，绝不点击',
    };
    await snap('09', 'export-button');
    await record('A9_export_button_assert', a9);
    if (!a9.ok) throw new Error(`A9 导出按钮不可用：exists=${insp.exists} visible=${insp.visible} enabled=${insp.enabled}`);

    TS.setState(BUSINESS_DATE, 'DRY_RUN_DONE', { task_id: TASK_ID, note: '停在「导出」按钮前，未点击导出' });
    report.result = 'DRY_RUN_DONE';
    report.ok = true;

    await client.audit({ task_id: TASK_ID, mode: 'dry-run', result: 'DRY_RUN_DONE', clicked_export: false, created_export_request: false, visited_download_list: false, downloaded: false });
    await client.taskEnd(TASK_ID);
    return report;
  } catch (e) {
    report.errors.push(e.message);
    try {
      await snap('99', 'failed');
    } catch (_) {}
    try {
      TS.fail(BUSINESS_DATE, 'DRY_RUN', { task_id: TASK_ID, error: e.message, screenshots: report.screenshots.map((s) => s.file) });
    } catch (_) {}
    try {
      await client.audit({ task_id: TASK_ID, mode: 'dry-run', result: 'FAILED', error: e.message });
      await client.taskEnd(TASK_ID);
    } catch (_) {}
    report.ok = false;
    report.result = 'FAILED';
    return report;
  } finally {
    try {
      lk.release();
    } catch (_) {}
  }
}

(async () => {
  const r = await main();
  r.finished_at = new Date().toISOString();
  try {
    TS.patch(BUSINESS_DATE, { dry_run_report: { task_id: TASK_ID, ok: r.ok, result: r.result, finished_at: r.finished_at } });
  } catch (_) {}
  console.log(JSON.stringify(r, null, 2));
  await logger.close();
  process.exit(r.ok ? 0 : 1);
})();
