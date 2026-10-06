'use strict';
/**
 * A5 实施验证：选择「已保存查询方案 done」→ 读回下拉值 → 再读 12 项筛选实际状态。
 * 严格白名单：只点击文本精确等于 done 的选项；严禁点击 更新当前查询方案 / 保存当前为查询方案 / 管理；
 * 不点查询、不点导出、不进下载清单。
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
const SCHEME = String((rules.saved_query || {}).display_name || 'done');

(async () => {
  const out = { at: new Date().toISOString(), kind: 'diag-scheme2', scheme: SCHEME, clicked_query: false, clicked_export: false };
  const g = async (n, f) => { try { out[n] = await f(); } catch (e) { out[n] = { error: e.message.split('\n')[0] }; } };
  const nav = rules.navigation;

  await g('A1', () => flow.gotoAndAssert({ url: nav.home_url, expectFullUrl: nav.home_url, nn: null, step: 's2-entry' }));
  await g('dismiss', () => flow.dismissOverlays({ allowTexts: (rules.overlay_dismissal || {}).allow_click_texts || [], maxRounds: 3 }));
  await g('A2', () => flow.clickSelectorAndVerify({ selector: S('nav.report_center'), purpose: 'nav', expectedUrls: [nav.report_center_url], nn: null, step: 's2-rc' }));
  await g('A3', () => flow.clickSelectorAndVerify({ selector: S('nav.business_report'), purpose: 'nav', expectedTexts: ['营业统计'], nn: null, step: 's2-br' }));
  // A4 稳健化：「综合营业统计」位于「营业报表」的悬浮弹层中，需先 hover 再点击；失败则重试并回退为文案点击
  await g('A4', async () => {
    const tgt = S('nav.target_report');
    for (let i = 0; i < 3; i += 1) {
      // hover 营业报表以唤出弹层
      try {
        const insp = await client.inspect(S('nav.business_report'), {}, { timeoutMs: 20000 });
        if (insp && insp.rect) {
          await client.mouse({ action: 'move', x: insp.rect.x + Math.round(insp.rect.w / 2), y: insp.rect.y + Math.round(insp.rect.h / 2), settleMs: 900 }, { timeoutMs: 20000 });
        }
      } catch (_) {}
      const exists = tgt ? await client.inspect(tgt, {}, { timeoutMs: 20000 }).then((x) => x.exists).catch(() => false) : false;
      if (exists) {
        const r = await flow.clickSelectorAndVerify({ selector: tgt, purpose: 'nav', expectedUrls: [nav.entry_url], nn: null, step: `s2-tr-${i}` });
        if (r.ok) return { ...r, via: `hover_then_selector(attempt ${i + 1})` };
      }
    }
    const fb = await flow.clickTextAndVerify({ text: '综合营业统计', expectedUrls: [nav.entry_url], purpose: 'nav', nn: null, step: 's2-tr-text', soft: true });
    return { ...fb, via: 'text_fallback' };
  });
  await g('url_after_A4', () => client.url());
  await g('content_ready', () => flow.waitForContent({ texts: ['营业日期', '统计周期'], timeoutMs: 45000, label: 's2_ready' }));
  await g('dismiss2', () => flow.dismissOverlays({ allowTexts: (rules.overlay_dismissal || {}).allow_click_texts || [], maxRounds: 3 }));

  await g('scheme_before', () => flow.readSchemeValue());
  await g('select_scheme', () => flow.selectSavedScheme(SCHEME));
  await g('scheme_after', () => flow.readSchemeValue());
  await g('filter_state_after', () => client.filterState({ maxGroups: 30 }, { timeoutMs: 90000 }));

  const fs2 = out.filter_state_after && out.filter_state_after.best;
  const itemRows = [];
  if (fs2) {
    const groups = fs2.groups || [];
    const by = (n) => (groups.find((x) => x.group === n) || {}).checked_texts || null;
    const checks = (rules.filter_value_checks || {}).items || [];
    for (const it of checks) {
      if (it.type === 'value_control') { itemRows.push({ no: it.no, key: it.key, expect: it.expect_value, actual: '(见日期行区块)', status: 'pending' }); continue; }
      const act = by(it.group);
      const exp = it.expect_selected || [];
      const ok = act && act.length === exp.length && exp.every((x) => act.includes(x));
      itemRows.push({ no: it.no, key: it.key, group: it.group, expect: exp.join('、'), actual: act ? act.join('、') : null, status: ok ? 'match' : 'mismatch' });
    }
  }
  out.item_rows = itemRows;

  const dir = path.join(P.state, 'selectors-dump');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diag-scheme2-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  console.log('nav:', JSON.stringify([out.A2 && out.A2.ok, out.A3 && out.A3.ok, out.A4 && out.A4.ok]));
  console.log('scheme BEFORE:', JSON.stringify(out.scheme_before && { title: out.scheme_before.current_value_title, text: out.scheme_before.current_value_text, is_empty: out.scheme_before.is_empty }));
  console.log('select_scheme:', JSON.stringify(out.select_scheme, null, 1));
  console.log('scheme AFTER:', JSON.stringify(out.scheme_after && { title: out.scheme_after.current_value_title, text: out.scheme_after.current_value_text, is_empty: out.scheme_after.is_empty }));
  console.log('--- 12 items after selecting scheme ---');
  for (const r of itemRows) console.log(`  #${r.no} ${r.key}: expect=${r.expect} actual=${r.actual} -> ${r.status}`);
  console.log('dump:', file);
})().catch((e) => { console.error('DIAG_SCHEME2_FAILED', e.message); process.exit(1); });
