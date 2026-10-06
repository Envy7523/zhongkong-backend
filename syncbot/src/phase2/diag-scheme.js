'use strict';
/**
 * 只读为主：定位「常用查询」方案下拉框，判断当前方案与 `done` 是否可选。
 * 点击白名单（严格）：
 *   - 只允许点击「class 含 select/dropdown 的触发器」打开列表；
 *   - 只允许点击「文本精确等于 done」的列表项；
 *   - 严禁点击：更新当前查询方案 / 保存当前为查询方案 / 管理（会修改方案）。
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
const FORBIDDEN = ['更新当前查询方案', '保存当前为查询方案', '管理'];

(async () => {
  const out = { at: new Date().toISOString(), kind: 'diag-scheme', clicked_query: false, clicked_export: false, forbidden_texts: FORBIDDEN };
  const g = async (n, f) => { try { out[n] = await f(); } catch (e) { out[n] = { error: e.message.split('\n')[0] }; } };
  const nav = rules.navigation;

  await g('A1', () => flow.gotoAndAssert({ url: nav.home_url, expectFullUrl: nav.home_url, nn: null, step: 'sc-entry' }));
  await g('dismiss', () => flow.dismissOverlays({ allowTexts: (rules.overlay_dismissal || {}).allow_click_texts || [], maxRounds: 3 }));
  await g('A2', () => flow.clickSelectorAndVerify({ selector: S('nav.report_center'), purpose: 'nav', expectedUrls: [nav.report_center_url], nn: null, step: 'sc-rc' }));
  await g('A3', () => flow.clickSelectorAndVerify({ selector: S('nav.business_report'), purpose: 'nav', expectedTexts: ['营业统计'], nn: null, step: 'sc-br' }));
  await g('A4', () => flow.clickSelectorAndVerify({ selector: S('nav.target_report'), purpose: 'nav', expectedUrls: [nav.entry_url], nn: null, step: 'sc-tr' }));
  await g('content_ready', () => flow.waitForContent({ texts: ['营业日期', '统计周期'], timeoutMs: 45000, label: 'sc_ready' }));
  await g('dismiss2', () => flow.dismissOverlays({ allowTexts: (rules.overlay_dismissal || {}).allow_click_texts || [], maxRounds: 3 }));

  // 1) 只读：dump「常用查询」所在水平带的元素（用于定位下拉触发器）
  await g('band', async () => {
    const region = await client.region(S('filter.panel') || 'body', { maxDepth: 3 }, { timeoutMs: 30000 }).catch(() => null);
    return { region_text_head: region && region.text ? region.text.slice(0, 300) : null };
  });
  await g('query_label_probe', () => client.probe(['常用查询'], { maxPerText: 8 }));
  // 通过 filterGroups 已知「常用查询」组及其选项；取其容器内元素的 class/rect 以找 select
  await g('fdetail', () => client.filterDetail({ labels: ['常用查询'], maxDepth: 4, maxNodes: 60 }, { timeoutMs: 90000 }));

  const det = out.fdetail && out.fdetail.best;
  const res = det && (det.results || []).find((r) => r.label === '常用查询' && r.found);
  out.scheme_outline = res ? res.outline.map((n) => ({ d: n.depth, tag: n.tag, cls: n.cls, own: n.own_text, text: n.full_text, attrs: n.attrs })) : null;
  const selectEl = res ? res.outline.find((n) => /select|dropdown|picker/i.test(n.cls || '')) : null;
  out.trigger_candidate = selectEl ? { cls: selectEl.cls, text: selectEl.full_text } : null;

  // 2) 若找到触发器 → 真实鼠标点击打开列表（不点任何禁改按钮）
  if (selectEl) {
    // 重新探测以获得 rect
    const dr = await client.filterDetail({ labels: ['常用查询'], maxDepth: 4, maxNodes: 60 }, { timeoutMs: 90000 });
    const r2 = dr && dr.best && (dr.best.results || []).find((x) => x.label === '常用查询' && x.found);
    const cand = r2 ? r2.outline.find((n) => /select|dropdown|picker/i.test(n.cls || '')) : null;
    out.trigger_has_rect = !!(cand && cand.rect);
    // 用 probe 拿 rect
    const pp = await client.probe(['常用查询'], { maxPerText: 8 });
    const hit = pp && pp.merged && pp.merged['常用查询'] ? [...(pp.merged['常用查询'].exact || []), ...(pp.merged['常用查询'].partial || [])][0] : null;
    out.query_label_rect = hit ? hit.rect : null;
  }

  // 3) 列出当前所有可见的、文本精确等于 done 的元素（若已显示）
  await g('done_probe', () => client.probe(['done'], { maxPerText: 8 }));

  const dir = path.join(P.state, 'selectors-dump');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diag-scheme-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  console.log('nav:', JSON.stringify([out.A2 && out.A2.ok, out.A3 && out.A3.ok, out.A4 && out.A4.ok]));
  console.log('query label rect:', JSON.stringify(out.query_label_rect));
  console.log('trigger candidate:', JSON.stringify(out.trigger_candidate));
  console.log('scheme outline:');
  for (const n of (out.scheme_outline || [])) console.log(`  ${'  '.repeat(n.d)}${n.tag} [${(n.cls || '').slice(0, 50)}] own="${n.own}" attrs=${JSON.stringify(n.attrs)}`);
  console.log('done_probe:', JSON.stringify(out.done_probe && out.done_probe.merged ? Object.fromEntries(Object.entries(out.done_probe.merged).map(([k, v]) => [k, { exact: (v.exact || []).length, partial: (v.partial || []).length }])) : out.done_probe));
  console.log('dump:', file);
})().catch((e) => { console.error('DIAG_SCHEME_FAILED', e.message); process.exit(1); });
