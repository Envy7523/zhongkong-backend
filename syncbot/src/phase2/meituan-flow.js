'use strict';
/**
 * 阶段2：美团流程原语（collect / dry-run / 后续真实运行共用）
 *
 * 硬规则：
 *  - 所有点击都必须有 purpose，且写审计；purpose='export'/'download' 由宿主按批准状态强制拦截；
 *  - 定位一律来自**现场采集的选择器**（config/selectors.json）或**已确认文案的运行时探测**；
 *  - 任何一步前置/后置断言失败 → 立即停止、截图、返回失败原因，不猜测替代路径。
 */
const fs = require('fs');
const path = require('path');
const P = require('../paths');
const client = require('./client');
const urlAssert = require('./url-assert');
const domProbe = require('./dom-probe');
const TC = require('../task-context');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 截图目录：**完全由传入 ctx 派生**（platform/reportType/businessDate），不使用全局或隐式状态 */
function shotDir(ctx) {
  TC.assertContext(ctx);
  const d = P.screenshotDay(ctx.platform, ctx.reportType, ctx.businessDate);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 由显式参数构造 task-scoped ctx（仅用于截图；report_type 必须已由调用方显式给出） */
function ctxFor(reportType, platform, taskId, businessDate, nn) {
  if (!reportType || !taskId || !businessDate || !nn) return null;
  try { return TC.createContext(reportType, { platform: platform || 'meituan', taskId, businessDate }); } catch (_) { return null; }
}

async function screenshot(ctx, nn, step, extra = {}) {
  TC.assertContext(ctx);
  if (!nn) throw new Error('screenshot 需要 nn（截图序号），禁止隐式缺省');
  const { taskId } = ctx;
  const file = path.join(shotDir(ctx), `${taskId}-${nn}-${step}.png`);
  const r = await client.screenshot(file, extra);
  return { step, file: r.path, bytes: r.bytes, url: r.url };
}

/** 通用阻断检测：登录表单 / 验证码 / 短信 / 扫码（由宿主内的通用探针实现） */
async function detectBlockers() {
  const r = await client.call('blockers', {});
  return {
    password_input: r.has_password_input,
    keyword_hits: r.keyword_hits,
    login_required: r.likely_login_page,
    human_verification: r.likely_human_verification,
    url: r.url,
  };
}

/** 文案→最佳候选（只返回证据，不点击）。宿主现在跨 frame 探测，返回 {merged, frameHits} */
async function findBestByText(text, opts = {}) {
  const res = await client.probe([text], { maxPerText: opts.maxPerText || 8 });
  const bucket = (res && res.merged ? res.merged[text] : res && res[text]) || { exact: [], partial: [] };
  const rank = (list) =>
    list
      .filter((c) => c.visible)
      .sort((a, b) => {
        const tagScore = (x) => (['a', 'button'].includes(x.tag) ? 0 : ['li', 'label', 'input'].includes(x.tag) ? 1 : 2);
        return tagScore(a) - tagScore(b) || Number(b.unique) - Number(a.unique) || a.rect.w * a.rect.h - b.rect.w * b.rect.h;
      });
  return {
    exact: rank(bucket.exact || []),
    partial: rank(bucket.partial || []),
    exactCount: bucket.exactCount,
    partialCount: bucket.partialCount,
    frameHits: (res && res.frameHits) || [],
    frames: (res && res.perFrameErrors) || [],
  };
}

/** 点击某文案命中的元素，并按期望 URL / 期望文案验证；最多尝试 3 个候选
 *  soft=true 时只要求"点击动作成功"，断言结果仅记录（用于中间导航步骤；最终以目标页 URL 为硬断言） */
async function clickTextAndVerify({ text, expectedUrls = [], expectedTexts = [], purpose, businessDate, taskId, reportType, platform, nn, step, tries = 3, soft = false }) {
  const found = await findBestByText(text);
  const candidates = found.exact.length ? found.exact : found.partial;
  if (!candidates.length) {
    return { ok: false, reason: `未找到文案「${text}」的可点击可见元素`, tried: [], candidates: found };
  }
  const tried = [];
  for (const c of candidates.slice(0, tries)) {
    const before = await client.url();
    let clickErr = null;
    try {
      await client.click(c.selector, purpose, { settleMs: 2500 });
    } catch (e) {
      clickErr = e.message;
    }
    await sleep(1200);
    const after = await client.url();
    let urlOk = null;
    if (expectedUrls.length) {
      const m = urlAssert.matchAny(after.url, expectedUrls);
      urlOk = m.result.ok;
    }
    let textOk = null;
    if (expectedTexts.length) {
      const p = await client.pageText({ maxChars: 20000 });
      const body = (p.text || '').replace(/\s+/g, ' ');
      textOk = expectedTexts.every((t) => body.includes(t));
    }
    const ok = clickErr ? false : (urlOk === null || urlOk === true) && (textOk === null || textOk === true);
    tried.push({ selector: c.selector, tag: c.tag, clickErr, url_before: before.url, url_after: after.url, url_ok: urlOk, text_ok: textOk, ok });
    if (ok || (soft && !clickErr)) {
      const _sctx = ctxFor(reportType, platform, taskId, businessDate, nn);
  if (_sctx) await screenshot(_sctx, nn, step).catch(() => {});
      return { ok: true, soft_accept: soft && !ok, chosen: c, tried, after, url_kind: urlOk, text_ok: textOk };
    }
  }
  const clickErrs = tried.map((t) => t.clickErr).filter(Boolean);
  return {
    ok: false,
    reason: `点击「${text}」后未能满足后置断言${clickErrs.length ? `（点击错误：${clickErrs.join(' | ')}）` : ''}`,
    tried,
    candidates: found,
  };
}

/** 按选择器点击并断言（用于采集出来的选择器） */
async function clickSelectorAndVerify({ selector, purpose, expectedUrls = [], expectedTexts = [], businessDate, taskId, reportType, platform, nn, step }) {
  const before = await client.url();
  await client.click(selector, purpose, { settleMs: 2500 });
  await sleep(1200);
  const after = await client.url();
  const m = expectedUrls.length ? urlAssert.matchAny(after.url, expectedUrls) : { result: { ok: null } };
  let textOk = null;
  if (expectedTexts.length) {
    const p = await client.pageText({ maxChars: 20000 });
    const body = (p.text || '').replace(/\s+/g, ' ');
    textOk = expectedTexts.every((t) => body.includes(t));
  }
  const ok = (m.result.ok === null || m.result.ok) && (textOk === null || textOk);
  const _sctx = ctxFor(reportType, platform, taskId, businessDate, nn);
  if (_sctx) await screenshot(_sctx, nn, step).catch(() => {});
  return { ok, selector, purpose, url_before: before.url, url_after: after.url, url_assert: m.result, text_ok: textOk };
}

/** 导航到指定 URL 并做分段断言 */
async function gotoAndAssert({ url, expectFullUrl, businessDate, taskId, reportType, platform, nn, step, settleMs = 2000, purpose }) {
  // 【修正】purpose 原先未进入形参 ⇒ 调用方传的 purpose:'download_list' 被静默丢弃，
  // 宿主 guard 因 args.purpose 缺失而不做批准校验（download_list 闸门形同未接线）。
  await client.goto(url, purpose ? { settleMs, purpose } : { settleMs });
  const cur = await client.url();
  const result = urlAssert.assertSegments(cur.url, urlAssert.expectFromFullUrl(expectFullUrl || url));
  const _sctx = ctxFor(reportType, platform, taskId, businessDate, nn);
  if (_sctx) await screenshot(_sctx, nn, step).catch(() => {});
  return { ok: result.ok, url: cur.url, title: cur.title, url_assert: result };
}

/** 面板/表格容器采集 */
async function findPanels({ texts, minHits }) {
  // 通过 region 命令无法执行任意函数，这里用 filterPanel 的 scope 语义 + 文本命中近似实现：
  // 直接复用宿主 probe 的 partial 命中集合，取其公共祖先不可行 → 改为要求宿主执行 findPanelByTexts。
  // 因此该动作由宿主新增命令 `findPanel` 提供（见 host-server.js）。
  return client.call('findPanel', { texts, minHits });
}

/** 内容就绪门控：轮询 pageText，直到所有期望文案出现（报表页内容在 iframe 内，加载有延迟） */
async function waitForContent({ texts, timeoutMs = 45000, pollMs = 1500, label = 'content' }) {
  const deadline = Date.now() + timeoutMs;
  let last = { text: '', frames: 0 };
  const found = [];
  for (;;) {
    const pt = await client.pageText({ maxChars: 60000 });
    last = pt;
    const missing = texts.filter((t) => !String(pt.text || '').includes(t));
    if (!missing.length) return { ok: true, waited_ms: timeoutMs - (deadline - Date.now()), frames: pt.frames, text_length: pt.length };
    found.push({ at: new Date().toISOString(), missing: missing.length, text_length: pt.length, frames: pt.frames });
    if (Date.now() > deadline) {
      return { ok: false, label, missing, frames: last.frames, text_length: last.length, samples: found.slice(-6) };
    }
    await sleep(pollMs);
  }
}

async function findTable() {
  return client.call('findTable', {});
}

/** 失败取证：写一份诊断 JSON（URL、body 文本、关键文案探测结果），便于人工判断原因 */
async function writeFailureDump(taskId, extra = {}) {
  const fsx = require('fs');
  const dir = path.join(P.state, 'selectors-dump');
  fsx.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${taskId}-failure.json`);
  const dump = { task_id: taskId, at: new Date().toISOString(), error: extra.error || null };
  try {
    const cur = await client.url();
    dump.url = cur.url;
    dump.title = cur.title;
  } catch (e) {
    dump.url_error = e.message;
  }
  try {
    const pt = await client.pageText({ maxChars: 20000 });
    dump.body_text = pt.text;
  } catch (e) {
    dump.body_text_error = e.message;
  }
  try {
    dump.probe_left_menu = await client.probe(['营业报表', '营业统计', '综合营业统计'], { maxPerText: 8 });
  } catch (e) {
    dump.probe_error = e.message;
  }
  try {
    dump.blockers = await client.blockers({});
  } catch (_) {}
  if (extra.extra) dump.extra = extra.extra;
  fsx.writeFileSync(file, JSON.stringify(dump, null, 2));
  return file;
}

/**
 * 关闭阻断性浮层（站点公告 / 引导弹窗 / 遮罩）。
 * 硬规则：
 *  - 只点击**允许清单内的关闭类文案**（知道了/关闭…），绝不点击「查看详情」「去查看」等会跳转的按钮；
 *  - 找不到允许的关闭控件 → 返回失败（不猜测、不强点）；
 *  - 每次点击写审计（purpose='dismiss_overlay'），并复核浮层是否消失。
 */
async function dismissOverlays({ allowTexts = [], maxRounds = 3, purpose = 'dismiss_overlay' } = {}) {
  const rounds = [];
  for (let i = 0; i < maxRounds; i += 1) {
    const r = await client.overlays({ minAreaRatio: 0.1 });
    const ovs = (r && r.best && r.best.overlays) || [];
    if (!ovs.length) return { ok: true, dismissed: rounds, remaining: 0, reason: i === 0 ? 'no_overlay' : 'cleared' };
    let target = null;
    for (const t of allowTexts) {
      for (const ov of ovs) {
        const c = (ov.controls || []).find((x) => x.text === t);
        if (c) {
          target = { text: t, control: c, overlay: { class_name: ov.class_name, rect: ov.rect, z_index: ov.z_index, area_ratio: ov.area_ratio, text: ov.text.slice(0, 160) } };
          break;
        }
      }
      if (target) break;
    }
    if (!target) {
      return {
        ok: false,
        reason: '检测到阻断性浮层，但浮层内没有允许清单中的关闭控件（不猜测、不强点）',
        dismissed: rounds,
        remaining: ovs.length,
        overlays: ovs.map((o) => ({ class_name: o.class_name, rect: o.rect, area_ratio: o.area_ratio, text: o.text.slice(0, 160), control_texts: o.control_texts })),
      };
    }
    await client.click(target.control.selector, purpose, { settleMs: 1500 });
    await sleep(1200);
    rounds.push({ text: target.text, selector: target.control.selector, overlay: target.overlay });
  }
  const after = await client.overlays({ minAreaRatio: 0.1 });
  const left = (after && after.best && after.best.overlays) || [];
  return { ok: left.length === 0, dismissed: rounds, remaining: left.length, reason: left.length ? 'overlay_persists' : 'cleared' };
}

/**
 * 读取「常用查询」方案下拉框的当前值（只读）。
 * 结构：div.query-form-scheme-wrapper > span「常用查询：」+ div.saas-select > …span.saas-select-selection-item[title]
 */
async function readSchemeValue() {
  const r = await client.filterDetail({ labels: ['常用查询'], maxDepth: 4, maxNodes: 60 }, { timeoutMs: 90000 });
  const best = r && r.best;
  const res = best && (best.results || []).find((x) => x.label === '常用查询' && x.found);
  if (!res) return { ok: false, reason: '未找到「常用查询」区域', outline: null };
  const nodes = res.outline || [];
  const sel = nodes.find((n) => /saas-select\b/.test(n.cls || '') && /single/.test(n.cls || '')) || nodes.find((n) => /saas-select\b/.test(n.cls || ''));
  const item = nodes.find((n) => /selection-item/.test(n.cls || ''));
  const trigger = nodes.find((n) => /select-selector/.test(n.cls || '')) || sel;
  const title = item && item.attrs ? (item.attrs.title === undefined ? null : item.attrs.title) : null;
  const valueText = item ? (item.own_text || item.full_text || '') : '';
  return {
    ok: true,
    select_selector: sel ? sel.selector : null,
    select_rect: sel ? sel.rect : null,
    trigger_selector: trigger ? trigger.selector : null,
    trigger_rect: trigger ? trigger.rect : null,
    current_value_title: title,
    current_value_text: valueText,
    is_empty: (title === '' || title === null) && (valueText === '' || valueText === null),
    outline: nodes.map((n) => ({ tag: n.tag, cls: n.cls, own: n.own_text, attrs: n.attrs })),
  };
}

/**
 * 选择「已保存查询方案」（A5）。硬规则：
 *  - 只点击**文本精确等于**目标方案名的列表项；严禁点击「更新当前查询方案 / 保存当前为查询方案 / 管理」（会修改方案）；
 *  - 打开下拉用真实鼠标点击触发器；
 *  - 选择后读回下拉当前值，必须等于目标方案名，否则判失败。
 */
async function selectSavedScheme(schemeName, { forbidTexts = ['更新当前查询方案', '保存当前为查询方案', '管理'] } = {}) {
  const before = await readSchemeValue();
  if (!before.ok) return { ok: false, step: 'read_before', reason: before.reason };
  if (before.current_value_title === schemeName || before.current_value_text === schemeName) {
    return { ok: true, step: 'already_selected', before, after: before };
  }
  // 打开下拉（真实鼠标）；若首次未展开，再点一次并尝试点击搜索输入框
  const tr = before.trigger_rect;
  if (!tr || !tr.w || !tr.h) return { ok: false, step: 'open', reason: '未取得下拉触发器坐标', before };
  const cx = tr.x + Math.round(tr.w / 2);
  const cy = tr.y + Math.round(tr.h / 2);
  const openAttempts = [];
  let list = null;
  for (let i = 0; i < 2; i += 1) {
    await client.mouse({ action: 'click', x: cx, y: cy, settleMs: 1400 }, { timeoutMs: 30000 });
    list = await client.listOptions({ max: 40 }, { timeoutMs: 30000 });
    const b = list && list.best;
    openAttempts.push({ attempt: i + 1, container_count: b ? b.container_count : 0, option_count: b ? b.count : 0, aria_expanded: b ? b.combobox_aria_expanded : null });
    if (b && b.count > 0) break;
  }
  let opts = (list && list.best && list.best.options) || [];
  // 命中禁改文案 → 立即停止（不得点击）
  const forbiddenHit = opts.filter((o) => forbidTexts.includes(o.text));
  const target = opts.find((o) => o.text === schemeName);
  if (!target) {
    // 关掉下拉，避免残留
    await client.press(before.trigger_selector || 'body', 'Escape', { timeoutMs: 20000 }).catch(() => {});
    return {
      ok: false,
      step: 'find_option',
      reason: `展开后未找到文本精确等于「${schemeName}」的选项`,
      open_attempts: openAttempts,
      containers_seen: list && list.best ? list.best.containers : null,
      options_seen: opts.map((o) => o.text).slice(0, 20),
      forbidden_texts_seen: forbiddenHit.map((o) => o.text),
      before,
    };
  }
  await client.mouse({ action: 'click', x: target.rect.x + Math.round(target.rect.w / 2), y: target.rect.y + Math.round(target.rect.h / 2), settleMs: 1800 }, { timeoutMs: 30000 });
  await sleep(1500);
  const after = await readSchemeValue();
  const ok = after.ok && (after.current_value_title === schemeName || after.current_value_text === schemeName);
  return {
    ok,
    step: ok ? 'selected' : 'verify',
    scheme: schemeName,
    options_seen: opts.map((o) => o.text).slice(0, 20),
    clicked_option: { text: target.text, cls: target.cls, rect: target.rect, selector: target.selector },
    forbidden_texts_clicked: [],
    before: { current_value_title: before.current_value_title, current_value_text: before.current_value_text, is_empty: before.is_empty },
    after: after.ok ? { current_value_title: after.current_value_title, current_value_text: after.current_value_text } : after,
  };
}

module.exports = {
  sleep,
  screenshot,
  detectBlockers,
  dismissOverlays,
  readSchemeValue,
  selectSavedScheme,
  findBestByText,
  clickTextAndVerify,
  clickSelectorAndVerify,
  gotoAndAssert,
  findPanels,
  findTable,
  waitForContent,
  writeFailureDump,
  urlAssert,
};
