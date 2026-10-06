'use strict';
/**
 * 只读验证 A7 机制（不点查询、不点导出、不进下载清单）：
 *   真实鼠标点开日期面板 → 真实鼠标点击 title=目标日期 的单元格（同日区间点两次）→ 读回输入框值证明已变更 → 截图 → 关闭面板。
 * 同时读取「常用查询」区域文本，用于判断当前是否显示了某个查询方案名。
 */
const fs = require('fs');
const path = require('path');
const P = require('../paths');
const client = require('./client');
const flow = require('./meituan-flow');
const selectors = require('./selectors');
const config = require('../config');

const sel = selectors.load();
const S = (k) => selectors.get(sel, k);
const rules = config.load('meituan-rules');
const TARGET = '2026/09/16';

(async () => {
  const out = { at: new Date().toISOString(), kind: 'diag-picker2', clicked_query: false, clicked_export: false, target: TARGET };
  const g = async (n, f) => { try { out[n] = await f(); } catch (e) { out[n] = { error: e.message.split('\n')[0] }; } };
  const nav = rules.navigation;

  await g('A1', () => flow.gotoAndAssert({ url: nav.home_url, expectFullUrl: nav.home_url, nn: null, step: 'p2-entry' }));
  await g('dismiss', () => flow.dismissOverlays({ allowTexts: (rules.overlay_dismissal || {}).allow_click_texts || [], maxRounds: 3 }));
  await g('A2', () => flow.clickSelectorAndVerify({ selector: S('nav.report_center'), purpose: 'nav', expectedUrls: [nav.report_center_url], nn: null, step: 'p2-rc' }));
  await g('A3', () => flow.clickSelectorAndVerify({ selector: S('nav.business_report'), purpose: 'nav', expectedTexts: ['营业统计'], nn: null, step: 'p2-br' }));
  await g('A4', () => flow.clickSelectorAndVerify({ selector: S('nav.target_report'), purpose: 'nav', expectedUrls: [nav.entry_url], nn: null, step: 'p2-tr' }));
  await g('content_ready', () => flow.waitForContent({ texts: ['营业日期', '统计周期'], timeoutMs: 45000, label: 'p2_ready' }));
  await g('dismiss2', () => flow.dismissOverlays({ allowTexts: (rules.overlay_dismissal || {}).allow_click_texts || [], maxRounds: 3 }));

  // 常用查询区域文本（判断是否显示了方案名）
  await g('scheme_probe', async () => {
    const r = await client.probe(['常用查询', '管理', '更新当前查询方案', '保存当前为查询方案', 'done'], { maxPerText: 6 });
    return r && r.merged ? Object.fromEntries(Object.entries(r.merged).map(([k, v]) => [k, { exact: (v.exact || []).length, partial: (v.partial || []).length, texts: (v.exact || []).slice(0, 3).map((x) => x.text) }])) : r;
  });

  const readDates = async () => {
    const dr = await client.dateRow({ maxLeaf: 40 }, { timeoutMs: 60000 });
    const ins = (dr && dr.best && dr.best.inputs) || [];
    return { values: ins.map((x) => x.value), readOnly: ins.map((x) => x.readOnly), rects: ins.map((x) => x.rect), inputs: ins };
  };
  await g('dates_before', readDates);
  const before = out.dates_before;

  const start = ((before && before.inputs) || []).find((x) => /开始/.test(x.placeholder || '')) || ((before && before.inputs) || [])[0];
  if (!start) throw new Error('未找到开始日期输入框');
  const cx = start.rect.x + Math.round(start.rect.w / 2);
  const cy = start.rect.y + Math.round(start.rect.h / 2);
  out.open_click = await client.mouse({ action: 'click', x: cx, y: cy, settleMs: 1800 }, { timeoutMs: 30000 });

  const clicks = [];
  for (let i = 0; i < 3; i += 1) {
    const pk = await client.picker({ maxCells: 80 }, { timeoutMs: 60000 });
    const cells = (pk && pk.best && pk.best.cells) || [];
    const want = TARGET.replace(/\//g, '-');
    const cell = cells.find((c) => c.date === want);
    if (!cell) { clicks.push({ i, error: `未找到 ${want}`, distinct: pk && pk.best ? pk.best.distinct_dates : 0 }); break; }
    await client.mouse({ action: 'click', x: cell.rect.x + Math.round(cell.rect.w / 2), y: cell.rect.y + Math.round(cell.rect.h / 2), settleMs: 1400 }, { timeoutMs: 30000 });
    const now = await readDates();
    clicks.push({ i, picked: cell.date, cell_cls: cell.cls, after_values: now.values });
    if (now.values.filter((v) => v === TARGET).length >= 2) break;
  }
  out.cell_clicks = clicks;

  out.dates_after = await readDates;
  out.dates_after = out.dates_after && out.dates_after.values ? out.dates_after : null;

  // 截图（证明日期已变更），然后关闭面板
  const shotDir = P.screenshotDay('meituan', 'cashier_composite', '2026-09-16');
  fs.mkdirSync(shotDir, { recursive: true });
  const shot = path.join(shotDir, `diag-picker-${Date.now()}-datechanged.png`);
  await g('screenshot', () => client.screenshot(shot, {}));
  out.screenshot_path = shot;

  await client.press(start.selector, 'Escape', { timeoutMs: 20000 }).catch(() => {});
  await client.mouse({ action: 'click', x: 700, y: 60, settleMs: 800 }, { timeoutMs: 20000 }).catch(() => {});
  out.dates_final = (await readDates()).values;

  const dir = path.join(P.state, 'selectors-dump');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diag-picker2-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  console.log('nav A2/A3/A4:', JSON.stringify([out.A2 && out.A2.ok, out.A3 && out.A3.ok, out.A4 && out.A4.ok]));
  console.log('scheme_probe:', JSON.stringify(out.scheme_probe));
  console.log('dates before:', JSON.stringify(before && before.values), 'readOnly=', JSON.stringify(before && before.readOnly));
  console.log('cell clicks:', JSON.stringify(clicks, null, 1));
  console.log('dates final:', JSON.stringify(out.dates_final));
  console.log('screenshot:', shot);
  console.log('dump:', file);
})().catch((e) => { console.error('DIAG_PICKER2_FAILED', e.message); process.exit(1); });
