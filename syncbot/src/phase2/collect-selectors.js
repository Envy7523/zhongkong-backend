'use strict';
/**
 * 阶段2：选择器现场采集
 *   node src/phase2/collect-selectors.js --date=2026-09-16
 *
 * 允许：导航到目标报表页，采集**运行时真实 DOM** 生成的选择器候选，逐节点截图，供人工逐项核对。
 * 禁止：点击「导出」、产生导出申请、前往下载清单、下载文件（下载清单相关键标记 deferred，本轮不采集）。
 */
const fs = require('fs');
const path = require('path');
const P = require('../paths');
const config = require('../config');
const { createLogger } = require('../logger');
const lock = require('../lock');
const client = require('./client');
const flow = require('./meituan-flow');
const selectors = require('./selectors');
const taskState = require('./task-state');

const args = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}
const BUSINESS_DATE = String(args.date || '');
if (!/^\d{4}-\d{2}-\d{2}$/.test(BUSINESS_DATE)) {
  console.error('用法: node src/phase2/collect-selectors.js --date=YYYY-MM-DD');
  process.exit(2);
}
const TASK_ID = `collect-${Date.now().toString(36)}`;
const logger = createLogger('phase2-collect');
const rules = config.load('meituan-rules');
const out = { task_id: TASK_ID, business_date: BUSINESS_DATE, started_at: new Date().toISOString(), steps: [], collected: {}, deferred: [], warnings: [], errors: [] };

function pick(list, preferTags = ['a', 'button', 'li', 'span', 'div']) {
  const vis = (list || []).filter((c) => c.visible);
  const score = (c) => (preferTags.indexOf(c.tag) === -1 ? 99 : preferTags.indexOf(c.tag)) + (c.unique ? 0 : 5);
  return vis.slice().sort((a, b) => score(a) - score(b) || a.rect.w * a.rect.h - b.rect.w * b.rect.h)[0] || null;
}

async function steps() {
  // 0) 前置（引导期：注册表尚不存在是正常情况——本工具就是它的创建者）
  const existingSel = selectors.load();
  const pre = existingSel.exists ? selectors.validate({ forRealRun: false }) : { ok: true, errors: [], warnings: [`选择器注册表尚不存在（${selectors.FILE}），本次为首次现场采集`], missing: [], unverified: [] };
  out.precheck = pre;
  if (!pre.ok) {
    // 注册表已存在但结构不合规时，仅告警并继续重新采集（不阻断引导）
    out.warnings.push(...pre.errors);
  }

  const h = await client.health();
  out.host = { url: h.url, title: h.title, human_busy: h.human_busy, approvals: h.approvals };
  if (h.human_busy && h.human_busy.present && !h.human_busy.expired && h.human_busy.owner === 'human') throw new Error('人工会话进行中，请先执行 syncbot human-session stop（互斥规则）');

  const lk = lock.acquire('meituan-download', 'cashier_composite', { meta: { task_id: TASK_ID, purpose: 'selectors-collect' } });
  try {
    await client.taskBegin(TASK_ID, { owner: 'collect-selectors', business_date: BUSINESS_DATE });

    // 1) 入口页
    const nav = rules.navigation;
    const home = nav.home_url;
    const s1 = await flow.gotoAndAssert({ url: home, expectFullUrl: home, businessDate: BUSINESS_DATE, taskId: TASK_ID, nn: '01', step: 'entry' });
    out.steps.push({ step: 'A1_entry', ...s1 });
    if (!s1.ok) throw new Error(`入口页 URL 不符：${JSON.stringify(s1.url_assert.mismatches)}`);
    const b1 = await flow.detectBlockers();
    out.blockers_entry = b1;
    if (b1.login_required) throw new Error('入口页出现登录要求：登录态可能已失效，请人工经 noVNC 重新登录（不绕过）');
    if (b1.human_verification) throw new Error('入口页出现验证码/短信/安全验证，立即停止（不绕过）');

    // 2) 报表中心
    const navTxt = '报表中心';
    const c2 = await flow.clickTextAndVerify({
      text: navTxt,
      expectedUrls: [nav.report_center_url],
      expectedTexts: ['营业报表'],
      purpose: 'nav',
      businessDate: BUSINESS_DATE,
      taskId: TASK_ID,
      nn: '02',
      step: 'report-center',
    });
    out.steps.push({ step: 'A2_report_center', click_text: navTxt, ...c2 });
    if (!c2.ok) throw new Error(`无法进入报表中心：${c2.reason}`);
    const navReportCenter = c2.chosen;
    out.collected['nav.report_center'] = { chosen: navReportCenter.selector, candidates: [navReportCenter], page: 'top' };

    // 3) 营业报表（中间步骤：只记录证据；最终以目标报表页 URL 为硬断言）
    const c3 = await flow.clickTextAndVerify({
      text: '营业报表',
      expectedTexts: ['综合营业统计', '营业统计'],
      purpose: 'nav',
      businessDate: BUSINESS_DATE,
      taskId: TASK_ID,
      nn: '03',
      step: 'business-report',
      soft: true,
    });
    out.steps.push({ step: 'A3_business_report', ...c3 });
    if (!c3.ok) {
      const dump = await flow.writeFailureDump(TASK_ID, { error: `A3 失败：${c3.reason}`, extra: { c3 } });
      out.failure_dump = dump;
      throw new Error(`无法点击「营业报表」：${c3.reason}（诊断：${dump}）`);
    }
    out.collected['nav.business_report'] = { chosen: c3.chosen.selector, candidates: [c3.chosen], page: 'left' };

    // 4) 综合营业统计（目标报表）
    const targetUrl = nav.entry_url;
    let c4 = await flow.clickTextAndVerify({
      text: '综合营业统计',
      expectedUrls: [targetUrl],
      purpose: 'nav',
      businessDate: BUSINESS_DATE,
      taskId: TASK_ID,
      nn: '04',
      step: 'target-report',
      tries: 3,
    });
    if (!c4.ok) {
      // 回退：先点「营业统计」分组展开，再点「综合营业统计」
      const g = await flow.clickTextAndVerify({ text: '营业统计', purpose: 'nav', businessDate: BUSINESS_DATE, taskId: TASK_ID, nn: '04a', step: 'report-group', soft: true });
      out.steps.push({ step: 'A4a_report_group', ...g });
      c4 = await flow.clickTextAndVerify({
        text: '综合营业统计',
        expectedUrls: [targetUrl],
        purpose: 'nav',
        businessDate: BUSINESS_DATE,
        taskId: TASK_ID,
        nn: '04',
        step: 'target-report',
      });
    }
    out.steps.push({ step: 'A4_target_report', ...c4 });
    if (!c4.ok) {
      const dump = await flow.writeFailureDump(TASK_ID, { error: `A4 失败：${c4.reason}`, extra: { c3, c4 } });
      out.failure_dump = dump;
      throw new Error(`无法进入「综合营业统计」：${c4.reason}（诊断：${dump}）`);
    }
    out.collected['nav.target_report'] = { chosen: c4.chosen.selector, candidates: [c4.chosen], page: 'left' };

    // 报表页阻断复检 + URL 断言
    const cur = await client.url();
    const ua = flow.urlAssert.assertSegments(cur.url, flow.urlAssert.expectFromFullUrl(targetUrl));
    out.report_page_url_assert = ua;
    if (!ua.ok) throw new Error(`目标报表页 URL 不符：${JSON.stringify(ua.mismatches)}`);
    const b4 = await flow.detectBlockers();
    out.blockers_report_page = b4;
    if (b4.login_required) throw new Error('报表页出现登录要求，立即停止');
    if (b4.human_verification) throw new Error('报表页出现验证码/短信/安全验证，立即停止');

    // 内容就绪门控：报表内容在 iframe 内，需等待其加载完成后再采集
    const ready = await flow.waitForContent({ texts: ['营业日期', '统计周期'], timeoutMs: 45000, label: 'A4.5_report_content' });
    out.content_ready = ready;
    if (!ready.ok) throw new Error(`报表页内容未就绪（缺失：${ready.missing.join(', ')}；frames=${ready.frames}）`);

    // 5) 采集：查询方案区域 / 方案名 done
    const schemeArea = await flow.findPanels({ texts: ['查询方案', '保存当前为查询方案', '更新当前查询方案', '设为常用'], minHits: 1 });
    out.collected['report.query_scheme_area'] = { candidates: schemeArea, chosen: schemeArea[0] ? schemeArea[0].selector : null, page: 'report' };
    const doneText = rules.saved_query.display_name;
    const doneProbe = await flow.findBestByText(doneText);
    out.collected['report.saved_query_done'] = { chosen: doneProbe.exact[0] ? doneProbe.exact[0].selector : null, candidates: doneProbe.exact.slice(0, 6), page: 'report', text_basis: doneText };

    // 6) 采集：筛选面板 + 日期输入 + 查询 + 导出按钮 + 高级
    const FILTER_LABELS = ['门店区域', '统计周期', '时段餐段', '餐时段统计方式', '销售渠道', '销售品项构成', '营业收入构成', '支付优惠构成', '折扣优惠构成', '营业日期', '星期', '门店'];
    const panels = await flow.findPanels({ texts: FILTER_LABELS, minHits: 5 });
    out.collected['filter.panel'] = { candidates: panels, chosen: panels[0] ? panels[0].selector : null, page: 'report' };
    const dateInputs = await client.dateInputs();
    out.collected['filter.date_inputs_all'] = { page: 'report', inputs: dateInputs };
    const visibleDates = (dateInputs || []).filter((d) => d.visible);
    out.collected['filter.date_start'] = { chosen: visibleDates[0] ? visibleDates[0].selector : null, candidates: visibleDates.slice(0, 4), page: 'report', note: '范围控件的起始输入框（现场采集）' };
    out.collected['filter.date_end'] = { chosen: visibleDates[1] ? visibleDates[1].selector : null, candidates: visibleDates.slice(1, 4), page: 'report', note: '范围控件的结束输入框（现场采集）' };
    const queryProbe = await flow.findBestByText('查询');
    out.collected['action.query'] = { chosen: pick(queryProbe.exact) ? pick(queryProbe.exact).selector : null, candidates: queryProbe.exact.slice(0, 6), page: 'report', text_basis: '查询' };
    const advProbe = await flow.findBestByText('高级');
    out.collected['filter.advanced_toggle'] = { chosen: pick(advProbe.exact) ? pick(advProbe.exact).selector : null, candidates: advProbe.exact.slice(0, 4), page: 'report', text_basis: '高级', note: '用于断言未展开高级筛选' };

    // 7) 导出按钮：**只探测与判定可点击性，绝不点击**
    const exportProbe = await flow.findBestByText('导出');
    const exportBest = pick(exportProbe.exact) || pick(exportProbe.partial);
    out.export_button_probe = { exact: exportProbe.exact.slice(0, 6), partial: exportProbe.partial.slice(0, 6), chosen: exportBest ? exportBest.selector : null };
    if (exportBest) {
      const insp = await client.inspect(exportBest.selector);
      out.export_button_inspect = insp;
      out.collected['action.export_button'] = { chosen: exportBest.selector, candidates: exportProbe.exact.slice(0, 6), page: 'report', text_basis: '导出', inspected: insp };
    } else {
      out.collected['action.export_button'] = { chosen: null, candidates: [], page: 'report', text_basis: '导出', note: '未探测到导出按钮' };
    }
    const tables = await flow.findTable();
    out.collected['report.table'] = { candidates: tables, chosen: tables[0] ? tables[0].selector : null, page: 'report' };

    // 8) 导出按钮位置截图（dry-run 的终点截图，仅为人工核对定位）
    const shotBtn = await flow.screenshot(BUSINESS_DATE, TASK_ID, '08', 'export-button');
    out.steps.push({ step: 'SHOT_export_button', ...shotBtn });

    // 9) 延后项（未获批准，不访问下载清单）
    for (const k of selectors.DEFERRED_KEYS) {
      out.deferred.push({ key: k, reason: '本轮未获「前往下载清单」批准，暂不采集；将在获批真实下载测试后采集' });
    }

    // 10) DOM 取证（供人工核对）
    const dumpDir = path.join(P.state, 'selectors-dump');
    fs.mkdirSync(dumpDir, { recursive: true });
    const panelText = await client.pageText({ maxChars: 60000 });
    const filterRegion = out.collected['filter.panel'].chosen ? await client.region(out.collected['filter.panel'].chosen, { maxDepth: 3 }) : null;
    const dumpFile = path.join(dumpDir, `${TASK_ID}-report-page.json`);
    fs.writeFileSync(
      dumpFile,
      JSON.stringify(
        {
          task_id: TASK_ID,
          url: panelText.url,
          body_text: panelText.text,
          filter_panel_region: filterRegion,
          date_inputs: dateInputs,
          table_candidates: tables,
          export_button_probe: out.export_button_probe,
          collected: out.collected,
        },
        null,
        2
      )
    );
    out.dump_file = dumpFile;

    await client.taskEnd(TASK_ID);
    return out;
  } finally {
    try {
      await client.taskEnd(TASK_ID);
    } catch (_) {}
    lk.release();
  }
}

(async () => {
  let failed = null;
  try {
    await steps();
    logger.step('collect.done', { task_id: TASK_ID, collected: Object.keys(out.collected).length, deferred: out.deferred.length });
  } catch (e) {
    failed = e.message;
    out.errors.push(e.message);
    logger.error('collect.failed', { task_id: TASK_ID, error: e.message });
    try {
      await flow.screenshot(BUSINESS_DATE, TASK_ID, '99', 'failed');
    } catch (_) {}
    try {
      out.failure_dump = out.failure_dump || (await flow.writeFailureDump(TASK_ID, { error: e.message }));
    } catch (_) {}
  }

  // 写选择器注册表（保留既有 verified 标记：选择器未变化则保留）
  const existing = selectors.load();
  const now = new Date().toISOString();
  const sel = {
    _README: [
      '阶段2 选择器注册表：全部由**现场采集**生成，禁止手写猜测值。',
      'chosen 为采集到的最佳候选；candidates 为备选；verified 由人工逐项核对后置为 true。',
      '真实运行（提交导出申请/下载）要求所有必需项 verified=true；dry-run 允许 verified=false 但需人工在输出中确认。',
      'download_list.* 与 export.* 为延后项（本轮未获批准访问下载清单页，尚未采集）。',
    ],
    generated_at: existing.meta && existing.meta.generated_at ? existing.meta.generated_at : now,
    updated_at: now,
    task_id: TASK_ID,
    business_date: BUSINESS_DATE,
    source: 'runtime DOM probe (collect-selectors.js)',
    selectors: {},
  };
  for (const [k, v] of Object.entries(out.collected)) {
    const prev = existing.selectors[k];
    sel.selectors[k] = {
      page: v.page || null,
      text_basis: v.text_basis || null,
      chosen: v.chosen || null,
      chosen_unique: (v.candidates || []).some((c) => c.selector === v.chosen && c.unique === true),
      candidates: v.candidates || [],
      note: v.note || null,
      verified: !!(prev && prev.verified === true && prev.chosen === (v.chosen || null)),
      verified_at: prev && prev.chosen === (v.chosen || null) ? prev.verified_at || null : null,
      captured_at: now,
    };
  }
  for (const d of out.deferred) {
    const prev = existing.selectors[d.key];
    sel.selectors[d.key] = {
      page: 'download_list',
      deferred: true,
      deferred_reason: d.reason,
      chosen: null,
      candidates: [],
      verified: false,
      captured_at: null,
      note: prev ? prev.note : null,
    };
  }
  sel.captured_count = Object.values(sel.selectors).filter((x) => x.chosen).length;
  sel.verified_count = Object.values(sel.selectors).filter((x) => x.verified).length;
  fs.writeFileSync(selectors.FILE, JSON.stringify(sel, null, 2) + '\n');

  try {
    taskState.patch(BUSINESS_DATE, { collect_task_id: TASK_ID, collect_at: now, collect_result: failed ? 'failed' : 'success', collect_error: failed });
  } catch (_) {}

  out.finished_at = new Date().toISOString();
  out.selectors_file = selectors.FILE;
  if (args['out-json']) {
    fs.writeFileSync(String(args['out-json']), JSON.stringify(out, null, 2));
  }
  console.log(JSON.stringify(out, null, 2));
  await logger.close();
  process.exit(failed ? 1 : 0);
})();
