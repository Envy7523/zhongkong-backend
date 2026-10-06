'use strict';
/**
 * 诊断：A4（进入综合营业统计）为何失败 —— 打印上一轮 dump 摘要，并重跑导航逐步取证。
 * 只做导航与只读探测；不点查询、不点导出、不进下载清单。
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

(async () => {
  // 1) 上一轮 dump 摘要
  const dir = path.join(P.state, 'selectors-dump');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('diag-scheme2-')).sort() : [];
  if (files.length) {
    const last = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
    console.log('--- prev dump:', files[files.length - 1], '---');
    for (const k of ['A1', 'A2', 'A3', 'A4', 'content_ready', 'dismiss', 'dismiss2']) {
      const v = last[k];
      console.log(`  ${k}: ${JSON.stringify(v).slice(0, 400)}`);
    }
  } else console.log('no prev dump');

  // 2) 重跑导航并取证
  const nav = rules.navigation;
  const out = {};
  const g = async (n, f) => { try { out[n] = await f(); } catch (e) { out[n] = { error: e.message.split('\n')[0] }; } };
  await g('A1', () => flow.gotoAndAssert({ url: nav.home_url, expectFullUrl: nav.home_url, nn: null, step: 'd3-entry' }));
  await g('overlays_at_entry', () => client.overlays({ minAreaRatio: 0.1 }, { timeoutMs: 30000 }));
  await g('dismiss', () => flow.dismissOverlays({ allowTexts: (rules.overlay_dismissal || {}).allow_click_texts || [], maxRounds: 3 }));
  await g('overlays_after_dismiss', () => client.overlays({ minAreaRatio: 0.1 }, { timeoutMs: 30000 }));
  await g('A2', () => flow.clickSelectorAndVerify({ selector: S('nav.report_center'), purpose: 'nav', expectedUrls: [nav.report_center_url], nn: null, step: 'd3-rc' }));
  await g('url_after_A2', () => client.url());
  await g('A3', () => flow.clickSelectorAndVerify({ selector: S('nav.business_report'), purpose: 'nav', expectedTexts: ['营业统计'], nn: null, step: 'd3-br' }));
  await g('url_after_A3', () => client.url());
  await g('A4', () => flow.clickSelectorAndVerify({ selector: S('nav.target_report'), purpose: 'nav', expectedUrls: [nav.entry_url], nn: null, step: 'd3-tr' }));
  await g('A4_text_fallback', async () => {
    if (out.A4 && out.A4.ok) return { skipped: true };
    return flow.clickTextAndVerify({ text: '综合营业统计', expectedUrls: [nav.entry_url], purpose: 'nav', nn: null, step: 'd3-tr-fallback', soft: true });
  });
  await g('url_after_A4', () => client.url());
  await g('content_ready', () => flow.waitForContent({ texts: ['营业日期', '统计周期'], timeoutMs: 30000, label: 'd3_ready' }));
  await g('probe_target_text', () => client.probe(['综合营业统计'], { maxPerText: 8 }));

  for (const k of Object.keys(out)) {
    const v = out[k];
    console.log(`== ${k} ==`);
    console.log('  ' + JSON.stringify(v).slice(0, 700));
  }
})().catch((e) => { console.error('DIAG_NAV3_FAILED', e.message); process.exit(1); });
