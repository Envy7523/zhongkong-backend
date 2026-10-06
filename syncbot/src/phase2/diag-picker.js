'use strict';
/**
 * 只读验证：真实鼠标点击能否打开日期面板，并能否定位 title=目标日期 的单元格。
 * 只做：导航 + 清浮层 + 点开日期面板 + 读单元格 + 读回日期值 + Esc 关闭。
 * 绝不点击：查询、导出、下载清单、下载。
 */
const client = require('./client');
const flow = require('./meituan-flow');
const selectors = require('./selectors');
const config = require('../config');

const sel = selectors.load();
const S = (k) => selectors.get(sel, k);
const rules = config.load('meituan-rules');

(async () => {
  const out = { at: new Date().toISOString(), kind: 'diag-picker', clicked_query: false, clicked_export: false };
  const g = async (n, f) => { try { out[n] = await f(); } catch (e) { out[n] = { error: e.message.split('\n')[0] }; } };
  const nav = rules.navigation;

  await g('A1_entry', () => flow.gotoAndAssert({ url: nav.home_url, expectFullUrl: nav.home_url, nn: null, step: 'dp-entry' }));
  await g('dismiss', () => flow.dismissOverlays({ allowTexts: (rules.overlay_dismissal || {}).allow_click_texts || [], maxRounds: 3 }));
  await g('A2', () => flow.clickSelectorAndVerify({ selector: S('nav.report_center'), purpose: 'nav', expectedUrls: [nav.report_center_url], nn: null, step: 'dp-rc' }));
  await g('A3', () => flow.clickSelectorAndVerify({ selector: S('nav.business_report'), purpose: 'nav', expectedTexts: ['营业统计'], nn: null, step: 'dp-br' }));
  await g('A4', () => flow.clickSelectorAndVerify({ selector: S('nav.target_report'), purpose: 'nav', expectedUrls: [nav.entry_url], nn: null, step: 'dp-tr' }));
  await g('content_ready', () => flow.waitForContent({ texts: ['营业日期', '统计周期'], timeoutMs: 45000, label: 'dp_ready' }));
  await g('dismiss2', () => flow.dismissOverlays({ allowTexts: (rules.overlay_dismissal || {}).allow_click_texts || [], maxRounds: 3 }));

  await g('date_row_before', () => client.dateRow({ maxLeaf: 40 }, { timeoutMs: 60000 }));
  const dr = out.date_row_before && out.date_row_before.best;
  const ins = (dr && dr.inputs) || [];
  out.date_inputs = ins.map((x) => ({ placeholder: x.placeholder, value: x.value, readOnly: x.readOnly, rect: x.rect, selector: x.selector }));
  const start = ins.find((x) => /开始/.test(x.placeholder || '')) || ins[0];
  out.start_input_used = start ? { placeholder: start.placeholder, rect: start.rect } : null;

  if (start) {
    const cx = start.rect.x + Math.round(start.rect.w / 2);
    const cy = start.rect.y + Math.round(start.rect.h / 2);
    out.mouse_click = await client.mouse({ action: 'click', x: cx, y: cy, settleMs: 1800 }, { timeoutMs: 30000 }).catch((e) => ({ error: e.message.split('\n')[0] }));
    await g('picker_after_mouse', () => client.picker({ maxCells: 80 }, { timeoutMs: 60000 }));
    const pk = out.picker_after_mouse && out.picker_after_mouse.best;
    out.picker_summary = pk ? {
      distinct_dates: pk.distinct_dates,
      min: pk.min_date,
      max: pk.max_date,
      presets: (pk.presets || []).map((p) => p.text),
      panel: pk.panel,
      cell_sample: (pk.cells || []).slice(0, 8).map((c) => ({ date: c.date, cls: c.cls.slice(0, 30), token: c.token })),
      target_cells: ['2026-09-16', '2026-09-17'].map((d) => {
        const c = (pk.cells || []).find((x) => x.date === d);
        return c ? { date: d, found: true, cls: c.cls.slice(0, 40), token: c.token, rect: c.rect } : { date: d, found: false };
      }),
    } : null;
    // 只读：不点单元格。按 Esc 关闭面板。
    await client.press(start.selector, 'Escape', { timeoutMs: 20000 }).catch(() => {});
    await client.mouse({ action: 'click', x: 700, y: 60, settleMs: 800 }, { timeoutMs: 20000 }).catch(() => {});
  }
  await g('date_row_after', () => client.dateRow({ maxLeaf: 40 }, { timeoutMs: 60000 }));
  out.date_after = ((out.date_row_after && out.date_row_after.best && out.date_row_after.best.inputs) || []).map((x) => x.value);

  const fs = require('fs');
  const path = require('path');
  const P = require('../paths');
  const dir = path.join(P.state, 'selectors-dump');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diag-picker-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  console.log('nav A2/A3/A4:', JSON.stringify([out.A2 && out.A2.ok, out.A3 && out.A3.ok, out.A4 && out.A4.ok]));
  console.log('content_ready:', JSON.stringify(out.content_ready && { ok: out.content_ready.ok }));
  console.log('date inputs before:', JSON.stringify(out.date_inputs && out.date_inputs.map((x) => `${x.placeholder}=${x.value}(ro=${x.readOnly})`)));
  console.log('mouse click:', JSON.stringify(out.mouse_click));
  console.log('picker summary:', JSON.stringify(out.picker_summary, null, 1));
  console.log('date after:', JSON.stringify(out.date_after));
  console.log('dump:', file);
})().catch((e) => { console.error('DIAG_PICKER_FAILED', e.message); process.exit(1); });
