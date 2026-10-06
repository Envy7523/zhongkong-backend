'use strict';
/**
 * 阶段2：筛选/日期控件**只读结构侦察**（用于把 A6 升级为「12 项取值逐项校验」、把 A7 升级为「真实日期控件操作」）
 *   node src/phase2/diag-filters.js --date=2026-09-16
 *
 * 只做：导航到综合营业统计（nav 点击）→ 只读 DOM 探测 → 打开一次日期面板读取结构后按 Esc 关闭。
 * 绝不做：点击「查询」、点击「导出」、产生导出申请、进入下载清单、下载文件、导入、推送、写数据库。
 */
const fs = require('fs');
const path = require('path');
const P = require('../paths');
const client = require('./client');
const flow = require('./meituan-flow');
const selectors = require('./selectors');

const args = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}
const sel = selectors.load();
const S = (k) => selectors.get(sel, k);

(async () => {
  const out = { at: new Date().toISOString(), kind: 'diag-filters', read_only: true, clicked_query: false, clicked_export: false, visited_download_list: false };
  const guard = async (name, fn) => {
    try {
      out[name] = await fn();
    } catch (e) {
      out[name] = { error: e.message.split('\n')[0] };
    }
  };

  // ===== 导航（与 dry-run 的 A1–A4.5 **完全相同**的调用参数，含 URL 断言，确保点击后确实等待导航）=====
  const rules = require('../config').load('meituan-rules');
  const nav = rules.navigation;
  const health = await client.health();
  out.health_before = { url: health.url, active_task: health.active_task_id, human_busy: health.human_busy };
  await guard('A1_entry', () => flow.gotoAndAssert({ url: nav.home_url, expectFullUrl: nav.home_url, nn: null, step: 'diag-entry' }));
  const b1 = await flow.detectBlockers();
  out.blockers_entry = b1;
  if (b1.login_required) throw new Error('登录态失效 → 停止（不自动处理）');
  if (b1.human_verification) throw new Error('出现验证码/短信/安全验证 → 立即停止');
  // 清浮层（只点允许清单内的关闭文案）
  const ovRule = rules.overlay_dismissal || {};
  await guard('overlays_before', () => client.overlays({ minAreaRatio: 0.1 }, { timeoutMs: 30000 }));
  await guard('A1_5_dismiss', () => flow.dismissOverlays({ allowTexts: ovRule.allow_click_texts || [], maxRounds: ovRule.max_rounds || 3 }));
  await guard('overlays_after', () => client.overlays({ minAreaRatio: 0.1 }, { timeoutMs: 30000 }));
  await guard('A2_report_center', () => (S('nav.report_center')
    ? flow.clickSelectorAndVerify({ selector: S('nav.report_center'), purpose: 'nav', expectedUrls: [nav.report_center_url], nn: null, step: 'diag-report-center' })
    : flow.clickTextAndVerify({ text: '报表中心', expectedUrls: [nav.report_center_url], purpose: 'nav', nn: null, step: 'diag-report-center' })));
  await guard('A3_business_report', () => (S('nav.business_report')
    ? flow.clickSelectorAndVerify({ selector: S('nav.business_report'), purpose: 'nav', expectedTexts: ['营业统计'], nn: null, step: 'diag-business-report' })
    : flow.clickTextAndVerify({ text: '营业报表', expectedTexts: ['营业统计'], purpose: 'nav', nn: null, step: 'diag-business-report' })));
  await guard('A4_target_report', () => (S('nav.target_report')
    ? flow.clickSelectorAndVerify({ selector: S('nav.target_report'), purpose: 'nav', expectedUrls: [nav.entry_url], nn: null, step: 'diag-target-report' })
    : flow.clickTextAndVerify({ text: '综合营业统计', expectedUrls: [nav.entry_url], purpose: 'nav', nn: null, step: 'diag-target-report' })));
  await guard('url_after_nav', () => client.url());
  await guard('content_ready', () => flow.waitForContent({ texts: ['营业日期', '统计周期'], timeoutMs: 45000, label: 'diag_content' }));

  // ===== 只读探测 =====
  await guard('filterGroups', () => client.filterGroups({ maxGroups: 40, maxOptions: 30 }, { timeoutMs: 60000 }));
  await guard('dateRow', () => client.dateRow({ maxLeaf: 60 }, { timeoutMs: 60000 }));
  await guard('filterState', () => client.filterState({ maxGroups: 30 }, { timeoutMs: 90000 }));
  await guard('filterDetail', () => client.filterDetail({ labels: ['统计周期'], maxDepth: 5, maxNodes: 60 }, { timeoutMs: 90000 }));

  // 打开日期面板读取结构（一次点击输入框 → 读结构 → Esc 关闭；不点查询/导出）
  const startSel = S('filter.date_start');
  out.picker_probe = { start_selector: startSel, attempted: false };
  if (startSel) {
    try {
      await client.click(startSel, 'date_picker_probe', { settleMs: 1500 });
      out.picker_probe.attempted = true;
      out.picker_probe.clicked = true;
      out.picker = await client.picker({ maxCells: 60 }, { timeoutMs: 60000 });
      await client.press(startSel, 'Escape', { timeoutMs: 20000 }).catch(() => {});
      await client.press(startSel, 'Escape', { timeoutMs: 20000 }).catch(() => {});
      out.picker_probe.closed_with_escape = true;
    } catch (e) {
      out.picker_probe.error = e.message.split('\n')[0];
      try { await client.press(startSel, 'Escape', { timeoutMs: 20000 }); } catch (_) {}
    }
  }

  const dir = path.join(P.state, 'selectors-dump');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diag-filters-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  // ===== 控制台摘要 =====
  const st = out.filterState && out.filterState.best;
  if (st) {
    console.log(`FILTER STATE: groups=${st.group_count}`);
    for (const g of st.groups) {
      console.log(`  [${g.group}] opts=${g.option_count} checked=${JSON.stringify(g.checked_texts)} determinate=${g.determinate}`);
      console.log(`      evidence=${g.read_evidence}`);
      console.log(`      options=${JSON.stringify(g.options.map((o) => `${o.text}:${o.input_checked ? 'CHECKED' : '-'}${o.signals_agree ? '' : '(DISAGREE)'}`))}`);
    }
    console.log('  selects:', JSON.stringify((st.selects || []).filter((s) => s.is_selection_item).map((s) => s.text).slice(0, 12)));
    console.log('  date inputs:', JSON.stringify(st.date_inputs));
    console.log('  advanced:', JSON.stringify((st.advanced_controls || []).map((a) => a.text)));
  } else console.log('FILTER STATE: NONE', JSON.stringify(out.filterState && out.filterState.errors));
  const fg = out.filterGroups && out.filterGroups.best;
  console.log('url:', (out.url_after_nav && out.url_after_nav.url) || null);
  console.log('content_ready:', JSON.stringify(out.content_ready && { ok: out.content_ready.ok, frames: out.content_ready.frames }));
  if (fg) {
    console.log(`filter groups: ${fg.group_count}（frame ${fg.frameIndex}）`);
    for (const g of fg.groups) {
      console.log(`  [${g.label}] opts=${g.option_count} selected=${JSON.stringify(g.selected_texts)} signal=${g.signal_used} determinate=${g.determinate}`);
      console.log(`      evidence=${g.signal_evidence}`);
      console.log(`      options=${JSON.stringify(g.options.map((o) => `${o.text}${o.selected ? '*' : ''}${o.class_token ? '(' + o.class_token + ')' : ''}`))}`);
    }
  } else console.log('filter groups: NONE', JSON.stringify(out.filterGroups && out.filterGroups.errors));
  const dr = out.dateRow && out.dateRow.best;
  if (dr) {
    console.log('date row leaves:');
    for (const l of dr.leaves) console.log(`  ${l.tag} "${l.text}" value=${l.value} ro=${l.readOnly} cls=${l.cls.slice(0, 40)}`);
  } else console.log('date row: NONE');
  const pk = out.picker && out.picker.best;
  if (pk) {
    console.log(`picker: distinct_dates=${pk.distinct_dates} raw_title_cells=${pk.raw_title_cells} min=${pk.min_date} max=${pk.max_date}`);
    console.log('  panel:', JSON.stringify(pk.panel && { cls: pk.panel.cls, rect: pk.panel.rect }));
    console.log('  presets:', JSON.stringify((pk.presets || []).map((p) => p.text)));
    console.log('  cells sample:', JSON.stringify((pk.cells || []).slice(0, 6).map((c) => `${c.date}|${c.cls.slice(0, 22)}|tok=${c.token}`)));
    const want = ['2026-09-16', '2026-09-17'];
    for (const w of want) {
      const c = (pk.cells || []).find((x) => x.date === w);
      console.log(`  cell ${w}: ${c ? `FOUND cls="${c.cls}" token=${c.token} rect=${JSON.stringify(c.rect)}` : 'NOT FOUND'}`);
    }
  } else console.log('picker: NONE', JSON.stringify(out.picker && out.picker.errors));
  console.log('dump:', file);
})().catch((e) => {
  console.error('DIAG_FILTERS_FAILED', e.message);
  process.exit(1);
});
