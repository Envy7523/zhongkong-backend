'use strict';
/**
 * 只读诊断：为什么「报表中心」点击后未导航（不改动状态、不点导出、不点查询）
 *   node src/phase2/diag-nav.js
 */
const client = require('./client');
const selectors = require('./selectors');
const config = require('../config');

const sel = selectors.load();
const S = (k) => selectors.get(sel, k);

(async () => {
  const out = {};
  const g = async (n, f) => { try { out[n] = await f(); } catch (e) { out[n] = { error: e.message.split('\n')[0] }; } };

  const rules = config.load('meituan-rules');
  const nav = rules.navigation;
  out.nav_rules = { home_url: nav.home_url, report_center_url: nav.report_center_url, entry_url: nav.entry_url };

  await g('health_before', () => client.health());
  await g('goto', () => client.goto(nav.home_url, { settleMs: 3000 }, { timeoutMs: 60000 }));
  await g('health_after_goto', () => client.health());
  await g('frames_after_goto', () => client.call('frames', {}, { timeoutMs: 20000 }));

  const rcSelector = S('nav.report_center');
  out.report_center_selector = rcSelector;
  await g('inspect_rc', () => client.inspect(rcSelector, {}, { timeoutMs: 20000 }));

  // 该元素的 href / target / 父级信息
  await g('rc_attrs', async () => {
    const r = await client.call('region', { selector: rcSelector, maxDepth: 1 }, { timeoutMs: 20000 });
    return r;
  });

  // 点击前 URL
  await g('url_before_click', () => client.url());
  await g('click_rc', () => client.click(rcSelector, 'nav', { settleMs: 4000 }, { timeoutMs: 30000 }));
  await new Promise((r) => setTimeout(r, 3000));
  await g('url_after_click', () => client.url());
  await g('health_after_click', () => client.health());
  await g('frames_after_click', () => client.call('frames', {}, { timeoutMs: 20000 }));
  await g('blockers_after_click', () => client.blockers({}, { timeoutMs: 20000 }));
  await g('pageText_tail', async () => {
    const p = await client.pageText({ maxChars: 3000 }, { timeoutMs: 20000 });
    return { length: p.length, frames: p.frames, tail: String(p.text || '').slice(-1200) };
  });

  // 若导航到报表页失败，顺便看看有没有弹出新窗口（page_count）
  console.log(JSON.stringify(out, null, 2).slice(0, 12000));
})().catch((e) => { console.error('DIAG_NAV_FAILED', e.message); process.exit(1); });
