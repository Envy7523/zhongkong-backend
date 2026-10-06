'use strict';
/**
 * 阶段2：通用 DOM 只读探针（**不含任何美团专用选择器**）
 *
 * 设计原则：
 *  - 定位依据只有两样：**已人工确认的界面文案** + 通用 DOM 结构遍历；
 *  - 候选选择器由运行时真实 DOM 生成（优先 data-* / id / 稳定 class / 结构路径），绝不由人写死猜测值；
 *  - 每个候选都带可见性、可点击性、唯一性等证据，供人工逐项核对。
 *
 * 重要实现约束（踩过的坑）：
 *  Playwright 的 `page.evaluate(fn)` **只序列化 fn 自身的源码**，函数内部**不能引用模块作用域的其他函数**。
 *  因此：
 *    1) 需要公共工具（如 cssPathOf）时，先由宿主调用 `installHelpers` 把工具挂到 `window.__probeHelpers`；
 *    2) 所有被求值的函数只通过 `window.__probeHelpers` 访问公共工具。
 */

/** 自包含：把公共工具安装到页面（宿主在每次 probe 前调用，幂等） */
function installHelpers() {
  if (window.__probeHelpers && window.__probeHelpers.version === 2) return { installed: false, version: 2 };
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const stableAttrs = ['data-testid', 'data-test', 'data-spm', 'data-track', 'data-id', 'data-name', 'aria-label', 'name', 'role'];

  /** 单层描述符：稳定属性优先，并**总是**在同类兄弟多于 1 时追加 :nth-of-type，保证路径唯一 */
  function descriptor(node) {
    let part = node.tagName.toLowerCase();
    let usedAttr = false;
    for (const a of stableAttrs) {
      const v = node.getAttribute && node.getAttribute(a);
      if (v && v.length <= 60) {
        part += `[${a}="${String(v).replace(/"/g, '\\"')}"]`;
        usedAttr = true;
        break;
      }
    }
    if (!usedAttr && node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
      part += `#${node.id}`;
      usedAttr = true;
    }
    if (!usedAttr) {
      const cls = (node.className && typeof node.className === 'string' ? node.className : '')
        .split(/\s+/)
        .filter((c) => c && c.length <= 40 && !/^(ng|css|sc|jsx|emotion)/.test(c))
        .slice(0, 2);
      if (cls.length) part += '.' + cls.map(esc).join('.');
    }
    const parent = node.parentElement;
    if (parent) {
      const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(node) + 1})`;
    }
    return part;
  }

  /** 生成**唯一**CSS 选择器：
   *  先构造自根到自身的完整路径（构造上唯一），再从左侧裁剪出最短的唯一后缀。
   *  这样避免出现 li[role="menuitem"] 这类匹配多个元素的宽选择器
   *  （Playwright page.click 默认严格模式，宽选择器会直接抛 strict mode violation）。 */
  function cssPathOf(el) {
    const segs = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 12) {
      segs.unshift(descriptor(node));
      node = node.parentElement;
      depth += 1;
    }
    const unique = (sel) => {
      try {
        return document.querySelectorAll(sel).length === 1;
      } catch (_) {
        return false;
      }
    };
    let best = segs.join(' > ');
    if (!unique(best)) return best; // 理论上不会发生；兜底返回完整路径
    for (let i = 1; i < segs.length; i++) {
      const cand = segs.slice(i).join(' > ');
      if (unique(cand)) {
        best = cand;
        break;
      }
    }
    return best;
  }

  const pick = (el) => {
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    const cs = cssPathOf(el);
    let unique = false;
    try {
      unique = document.querySelectorAll(cs).length === 1;
    } catch (_) {
      unique = false;
    }
    const attrs = {};
    for (const a of el.attributes || []) if (/^(data-|aria-|id$|class$|name$|role$|type$|placeholder$)/.test(a.name)) attrs[a.name] = String(a.value).slice(0, 80);
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().slice(0, 80),
      selector: cs,
      unique,
      visible: r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.1,
      clickable: ['a', 'button', 'li', 'span', 'div', 'label', 'input'].includes(el.tagName.toLowerCase()) && r.width > 0,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      attrs,
    };
  };
  window.__probeHelpers = { version: 2, cssPathOf, pick };
  return { installed: true, version: 2 };
}

/** 在页面上下文中执行：按可见文案收集候选元素（多候选 + 证据） */
function collectByText(input) {
  const { texts, scopeSelector, maxPerText } = input;
  const H = window.__probeHelpers;
  if (!H) return { __error: 'probe helpers 未安装' };
  const out = {};
  const root = scopeSelector ? document.querySelector(scopeSelector) || document : document;
  const all = Array.from(root.querySelectorAll('*'));
  for (const t of texts) {
    const want = String(t).trim();
    const exact = [];
    const partial = [];
    for (const el of all) {
      if (el.children.length > 6) continue;
      const txt = (el.textContent || '').trim();
      if (!txt) continue;
      if (txt === want) exact.push(el);
      else if (txt.includes(want) && txt.length <= want.length * 3 + 8) partial.push(el);
    }
    out[want] = {
      exact: exact.slice(0, maxPerText || 6).map(H.pick),
      partial: partial.slice(0, maxPerText || 6).map(H.pick),
      exactCount: exact.length,
      partialCount: partial.length,
    };
  }
  return out;
}

/** 在页面上下文中执行：采集筛选面板文本 + 可见控件状态（只读） */
function readFilterPanel(input) {
  const H = window.__probeHelpers;
  const { scopeSelector } = input;
  const root = scopeSelector ? document.querySelector(scopeSelector) : null;
  const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : null);
  const container = root || document.body;
  const controls = [];
  for (const el of Array.from(container.querySelectorAll('input,select,button,[role="combobox"],[role="radio"],[role="checkbox"],[class*="active"],[class*="selected"]'))) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    controls.push({
      tag: String(el.tagName).toLowerCase(),
      type: el.getAttribute('type') || null,
      role: el.getAttribute('role') || null,
      text: (el.innerText || el.value || '').toString().replace(/\s+/g, ' ').trim().slice(0, 60),
      value: el.value === undefined ? null : String(el.value).slice(0, 40),
      placeholder: el.getAttribute('placeholder') || null,
      selected: el.getAttribute('aria-selected') || el.getAttribute('aria-checked') || null,
      activeClass: /(^|\s)(active|selected|checked|is-active|current)(\s|$)/.test(el.className || ''),
      selector: H ? H.cssPathOf(el) : null,
    });
    if (controls.length >= 400) break;
  }
  return { found: !!root, text: textOf(root || document.body), controls, controlCount: controls.length };
}

/** 在页面上下文中执行：读取结果表概要（行数 / 合计行 / 首行关键列 / 分页信息） */
function readTableSummary(input) {
  const { scopeSelector } = input;
  const scope = scopeSelector ? document.querySelector(scopeSelector) || document : document;
  const tables = Array.from(scope.querySelectorAll('table'));
  const out = { tableCount: tables.length, tables: [] };
  tables.forEach((tb, i) => {
    const trs = Array.from(tb.querySelectorAll('tbody tr'));
    const rows = trs.map((tr) => Array.from(tr.children).map((td) => (td.innerText || '').replace(/\s+/g, ' ').trim()));
    const nonEmpty = rows.filter((r) => r.some((c) => c));
    const totalIdx = nonEmpty.findIndex((r) => /合计|总计|汇总/.test(r.slice(0, 3).join(' ')));
    out.tables.push({
      index: i,
      rowCount: nonEmpty.length,
      dataRowCount: totalIdx >= 0 ? totalIdx : nonEmpty.length,
      hasTotalRow: totalIdx >= 0,
      totalRow: totalIdx >= 0 ? nonEmpty[totalIdx].slice(0, 8) : null,
      firstRow: nonEmpty[0] ? nonEmpty[0].slice(0, 8) : null,
      headerRow: (() => {
        const thead = tb.querySelector('thead tr');
        return thead ? Array.from(thead.children).map((th) => (th.innerText || '').trim()).slice(0, 12) : null;
      })(),
    });
  });
  if (!tables.length) out.roleRows = Array.from(scope.querySelectorAll('[role="row"]')).length;

  // 通用 div 网格回退：不少 SaaS 报表用 div 虚拟网格而非 <table>。
  // 判定依据为通用特征（class 含 table/grid；行元素用 role=row 或 class 含 row/tr），不含站点专用选择器。
  const grids = [];
  const containers = Array.from(scope.querySelectorAll('[class*="table" i], [class*="grid" i]'));
  for (const c of containers) {
    const r = c.getBoundingClientRect();
    if (r.width < 200 || r.height < 60) continue;
    let rows = Array.from(c.querySelectorAll('[role="row"]'));
    if (!rows.length) rows = Array.from(c.querySelectorAll('[class*="table-row" i], [class*="-row-" i], [class*="tr-"], [class$="tr"]'));
    const rowTexts = rows.map((tr) => (tr.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (rowTexts.length < 2) continue;
    const cellsOf = (tr) =>
      Array.from(tr.children)
        .map((td) => (td.innerText || '').replace(/\s+/g, ' ').trim())
        .filter((x, i, a) => x !== '' || i === 0);
    const totalIdx = rowTexts.findIndex((t) => /^(合计|总计|汇总)\b|^(合计|总计|汇总)\s/.test(t) || t.startsWith('合计'));
    grids.push({
      container_class: String(c.className || '').slice(0, 80),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      rowElementCount: rowTexts.length,
      dataRowCount: totalIdx >= 0 ? totalIdx : rowTexts.length,
      hasTotalRow: totalIdx >= 0,
      totalRowText: totalIdx >= 0 ? rowTexts[totalIdx].slice(0, 160) : null,
      firstRowCells: rows[0] ? cellsOf(rows[0]).slice(0, 8) : null,
      firstRowText: rowTexts[0] ? rowTexts[0].slice(0, 200) : null,
      sampleRows: rowTexts.slice(0, 3).map((t) => t.slice(0, 160)),
    });
    if (grids.length >= 6) break;
  }
  if (grids.length) {
    grids.sort((a, b) => b.dataRowCount - a.dataRowCount);
    out.grids = grids;
    out.gridCount = grids.length;
  }

  // ===== 分页信息（通用）：结果表常按页渲染，「共N条记录」与「N条/页」是权威总数来源 =====
  const bodyText = (scope.body && scope.body.innerText ? scope.body.innerText : scope.innerText || '').replace(/\s+/g, ' ');
  const declared = /共\s*([\d,]+)\s*(?:条|行|个)\s*(?:记录|数据)?/.exec(bodyText);
  const pageSize = /([\d,]+)\s*(?:条|行|个)\s*\/\s*页/.exec(bodyText);
  const pageNums = Array.from(scope.querySelectorAll('[class*="pagination" i] li, [class*="pager" i] li, [class*="pagination" i] a'))
    .map((el) => (el.innerText || '').trim())
    .filter((t) => /^\d+$/.test(t));
  out.pagination = {
    declared_count: declared ? Number(declared[1].replace(/,/g, '')) : null,
    declared_text: declared ? declared[0] : null,
    page_size: pageSize ? Number(pageSize[1].replace(/,/g, '')) : null,
    page_size_text: pageSize ? pageSize[0] : null,
    page_numbers: pageNums.slice(-12),
  };

  // ===== 合计行（通用）：合计行可能位于网格 body 之外的固定页脚，故在全 frame 范围内查找 =====
  // 判定：元素直接子节点 >= 3，innerText 以 合计/总计/汇总 开头，且含数字
  const totalCands = [];
  for (const el of Array.from(scope.querySelectorAll('[role="row"], tr, [class*="table-row" i], [class*="-row-" i], [class*="footer" i], [class*="summary" i], [class*="total" i]'))) {
    const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!/^(合计|总计|汇总)/.test(t)) continue;
    if (el.children.length < 3) continue;
    if (!/\d/.test(t)) continue;
    totalCands.push({
      text: t.slice(0, 300),
      cells: Array.from(el.children).map((c2) => (c2.innerText || '').replace(/\s+/g, ' ').trim()).slice(0, 20),
      cell_count: el.children.length,
      class_name: String(el.className || '').slice(0, 80),
      depth: (() => { let d = 0, n = el; while (n && n.parentElement) { d += 1; n = n.parentElement; } return d; })(),
    });
  }
  // 取最深（最具体）的合计行元素
  totalCands.sort((a, b) => b.depth - a.depth);
  out.total_row = totalCands[0] || null;
  out.total_row_candidates = totalCands.length;
  return out;
}

/** 在页面上下文中执行：判定某元素存在/可见/可点击（**不点击**） */
function inspectElement(input) {
  const el = document.querySelector(input.selector);
  if (!el) return { exists: false, visible: false, enabled: false, rect: null };
  const r = el.getBoundingClientRect();
  const st = window.getComputedStyle(el);
  const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true' || /disabled/.test(el.className || '');
  return {
    exists: true,
    visible: r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.1,
    enabled: !disabled,
    inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1,
    text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    selector: input.selector,
  };
}

/** 在页面上下文中执行：定位日期类输入框（按 placeholder/取值格式，通用规则） */
function collectDateInputs() {
  const H = window.__probeHelpers;
  const out = [];
  for (const el of Array.from(document.querySelectorAll('input'))) {
    const r = el.getBoundingClientRect();
    const ph = (el.getAttribute('placeholder') || '').trim();
    const v = (el.value || '').trim();
    const looksDate = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(v) || /日期|时间|date/i.test(ph);
    if (!looksDate) continue;
    out.push({
      selector: H ? H.cssPathOf(el) : null,
      placeholder: ph,
      value: v,
      visible: r.width > 0 && r.height > 0,
      readOnly: el.readOnly === true,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
  }
  return out;
}

/** 在页面上下文中执行：采集某区域的结构化文本（供人工核对 DOM） */
function regionText(input) {
  const el = input.selector ? document.querySelector(input.selector) : document.body;
  if (!el) return null;
  const walk = (node, depth) => {
    if (depth > input.maxDepth) return null;
    const tag = String(node.tagName || '').toLowerCase();
    const text = Array.from(node.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .filter(Boolean)
      .join(' ');
    const attrs = {};
    for (const a of node.attributes || []) if (/^(data-|aria-|id$|class$|role$|placeholder$|type$|name$)/.test(a.name)) attrs[a.name] = String(a.value).slice(0, 60);
    const kids = Array.from(node.children || []).map((c) => walk(c, depth + 1)).filter(Boolean);
    if (!text && !kids.length && !Object.keys(attrs).length) return null;
    return { tag, text: text.slice(0, 120), attrs, children: kids };
  };
  return walk(el, 0);
}

/** 在页面上下文中执行：按"命中若干已确认文案"定位面板容器（取命中最多、面积最小的合格祖先） */
function findPanelByTexts(input) {
  const H = window.__probeHelpers;
  const { texts, minHits } = input;
  const want = texts.map((t) => String(t));
  const cands = [];
  for (const el of Array.from(document.querySelectorAll('div,section,form,main,aside,fieldset'))) {
    const txt = el.innerText || '';
    if (!txt) continue;
    const hits = want.filter((t) => txt.includes(t)).length;
    if (hits < minHits) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 100 || r.height < 40) continue;
    cands.push({ el, hits, area: r.width * r.height, rect: r, selector: H ? H.cssPathOf(el) : null });
  }
  cands.sort((a, b) => b.hits - a.hits || a.area - b.area);
  return cands.slice(0, 5).map((c) => ({
    selector: c.selector,
    hits: c.hits,
    of: want.length,
    area: Math.round(c.area),
    rect: { x: Math.round(c.rect.x), y: Math.round(c.rect.y), w: Math.round(c.rect.width), h: Math.round(c.rect.height) },
    text_head: (c.el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    unique: (() => {
      try {
        return document.querySelectorAll(c.selector).length === 1;
      } catch (_) {
        return false;
      }
    })(),
  }));
}

/** 在页面上下文中执行：定位结果表容器（含"合计"行的表优先） */
function findTableContainer() {
  const H = window.__probeHelpers;
  const out = [];
  for (const tb of Array.from(document.querySelectorAll('table'))) {
    const r = tb.getBoundingClientRect();
    const txt = tb.innerText || '';
    out.push({
      selector: H ? H.cssPathOf(tb) : null,
      rows: tb.querySelectorAll('tbody tr').length,
      has_total: /合计|总计|汇总/.test(txt),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      header: (() => {
        const thead = tb.querySelector('thead tr');
        return thead ? Array.from(thead.children).map((th) => (th.innerText || '').trim()).slice(0, 10) : null;
      })(),
    });
  }
  out.sort((a, b) => (b.has_total ? 1 : 0) - (a.has_total ? 1 : 0) || b.rows - a.rows);
  return out.slice(0, 5);
}

/** 在页面上下文中执行：判定是否存在登录表单/验证码等阻断元素（通用特征） */
function detectBlockers() {
  const text = (document.body && document.body.innerText ? document.body.innerText : '').replace(/\s+/g, ' ');
  const hasPassword = !!document.querySelector('input[type="password"]');
  const keywords = ['验证码', '短信验证', '扫码登录', '请登录', '登录后', '滑动验证', '安全验证', '人机验证'];
  const hits = keywords.filter((k) => text.includes(k));
  return {
    has_password_input: hasPassword,
    keyword_hits: hits,
    likely_login_page: hasPassword || hits.some((k) => /请登录|登录后|扫码登录/.test(k)),
    likely_human_verification: hits.some((k) => /验证码|短信验证|滑动验证|安全验证|人机验证/.test(k)),
    url: location.href,
  };
}

/**
 * 在页面上下文中执行：深度读取结果网格（用于判定虚拟滚动 / 合计行位置 / 总条数文案）。
 * 只读，不点击、不滚动页面（仅读取已渲染 DOM 及容器度量）。
 */
function readGridDetail(input) {
  const { maxRows = 60 } = input || {};
  const containers = Array.from(document.querySelectorAll('[class*="table" i], [class*="grid" i]'));
  const cands = [];
  for (const c of containers) {
    const r = c.getBoundingClientRect();
    if (r.width < 200 || r.height < 60) continue;
    let rows = Array.from(c.querySelectorAll('[role="row"]'));
    if (!rows.length) rows = Array.from(c.querySelectorAll('[class*="table-row" i], [class*="-row-" i], [class*="tr-"], [class$="tr"]'));
    const texts = rows.map((tr) => (tr.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (texts.length < 2) continue;
    // 虚拟滚动判定：滚动容器可用高度 < 内容高度，或行元素带 index 属性且数量少于声明总数
    const scrollers = [c, ...Array.from(c.querySelectorAll('*'))].filter((el) => {
      const st = getComputedStyle(el);
      return /auto|scroll/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 8;
    });
    const sc = scrollers[0] || null;
    // 总条数文案：在容器及其 4 层祖先内查找「共 N 条/行」
    let countText = null;
    let node = c;
    for (let up = 0; up < 5 && node; up += 1) {
      const t = (node.innerText || '').replace(/\s+/g, ' ');
      const m = /共\s*(\d+)\s*(?:条|行|个)/.exec(t);
      if (m) {
        countText = m[0];
        break;
      }
      node = node.parentElement;
    }
    // 行元素上的 data-row-index / aria-rowindex 可暴露真实总数
    const indices = rows
      .map((tr) => Number(tr.getAttribute('data-row-index') ?? tr.getAttribute('aria-rowindex') ?? NaN))
      .filter((n) => Number.isFinite(n));
    cands.push({
      class_name: String(c.className || '').slice(0, 100),
      rect: { w: Math.round(r.width), h: Math.round(r.height) },
      rendered_row_count: texts.length,
      scroll: sc ? { tag: sc.tagName, cls: String(sc.className || '').slice(0, 60), scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight, scrollTop: sc.scrollTop } : null,
      scrollable: !!sc,
      max_row_index: indices.length ? Math.max(...indices) : null,
      min_row_index: indices.length ? Math.min(...indices) : null,
      count_text: countText,
      total_row_index: texts.findIndex((t) => /^(合计|总计|汇总)/.test(t)),
      all_rows: texts.slice(0, maxRows),
    });
  }
  cands.sort((a, b) => b.rendered_row_count - a.rendered_row_count);
  // 当前日期控件/查询条附近的总数文案（页面级）
  const pageText = (document.body && document.body.innerText ? document.body.innerText : '').replace(/\s+/g, ' ');
  const pageCount = /共\s*(\d+)\s*(?:条|行|个)/.exec(pageText);
  return {
    url: location.href,
    grid_candidates: cands.slice(0, 4),
    page_count_text: pageCount ? pageCount[0] : null,
    page_text_has_heji: pageText.includes('合计'),
  };
}

/**
 * 在页面上下文中执行（**异步**）：滚动虚拟网格，收集全部行文本。
 * 只读：仅滚动结果区，不点击任何业务按钮、不触发导出/下载。
 * 用于解决「div 虚拟滚动」导致只渲染部分行（如页面显示"共 22 条"但 DOM 仅 20 行）的问题。
 */
async function readGridAllRows(input) {
  const { maxSteps = 40, settleMs = 320, maxRows = 80 } = input || {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rowsOf = (c) => {
    let rows = Array.from(c.querySelectorAll('[role="row"]'));
    if (!rows.length) rows = Array.from(c.querySelectorAll('[class*="table-row" i], [class*="-row-" i], [class*="tr-"], [class$="tr"]'));
    return rows.filter((tr) => (tr.innerText || '').replace(/\s+/g, ' ').trim());
  };
  // 选取渲染行最多的网格容器
  const containers = Array.from(document.querySelectorAll('[class*="table" i], [class*="grid" i]'));
  let best = null;
  for (const c of containers) {
    const r = c.getBoundingClientRect();
    if (r.width < 200 || r.height < 60) continue;
    const rows = rowsOf(c);
    if (rows.length < 2) continue;
    if (!best || rows.length > best.rows.length) best = { el: c, rows };
  }
  if (!best) return { found: false, url: location.href };

  const isScroller = (el) => {
    const st = getComputedStyle(el);
    return /auto|scroll/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 8;
  };
  // 滚动视口：自身或祖先中 overflowY 可滚且内容更高的元素
  let vp = null;
  let node = best.el;
  for (let up = 0; up < 7 && node; up += 1) {
    if (isScroller(node)) {
      vp = node;
      break;
    }
    node = node.parentElement;
  }
  if (!vp) {
    // 回退：在容器内部找滚动高度最大的可滚后代
    const inner = Array.from(best.el.querySelectorAll('*')).filter(isScroller);
    if (inner.length) vp = inner.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  }

  // 以「序号」列去重并排序；无序号时退化为按文本去重
  const byKey = new Map();
  const collect = () => {
    let added = 0;
    for (const tr of rowsOf(best.el)) {
      const t = (tr.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const m = /^(\d+)\b/.exec(t);
      const key = m ? `#${m[1]}` : `t:${t.slice(0, 60)}`;
      if (!byKey.has(key)) {
        byKey.set(key, { key, idx: m ? Number(m[1]) : null, text: t.slice(0, 400) });
        added += 1;
      } else {
        const prev = byKey.get(key);
        if (t.length > prev.text.length) prev.text = t.slice(0, 400);
      }
    }
    return added;
  };
  collect();
  const before = { scrollTop: vp ? vp.scrollTop : null, scrollHeight: vp ? vp.scrollHeight : null, clientHeight: vp ? vp.clientHeight : null };
  let steps = 0;
  if (vp) {
    const stepSize = Math.max(120, Math.floor(vp.clientHeight * 0.8));
    let lastTop = -1;
    for (let i = 0; i < maxSteps; i += 1) {
      steps += 1;
      vp.scrollTop = Math.min(vp.scrollTop + stepSize, vp.scrollHeight);
      await sleep(settleMs);
      collect();
      if (vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 2) break;
      if (vp.scrollTop === lastTop) break;
      lastTop = vp.scrollTop;
    }
    vp.scrollTop = 0;
    await sleep(settleMs);
    collect();
  }
  const items = Array.from(byKey.values());
  const indexed = items.filter((x) => x.idx !== null).sort((a, b) => a.idx - b.idx);
  const ordered = indexed.length >= items.length - 2 ? indexed : items;
  const totalIdx = ordered.findIndex((x) => /^(合计|总计|汇总)/.test(x.text));
  const pageText = (document.body && document.body.innerText ? document.body.innerText : '').replace(/\s+/g, ' ');
  const cm = /共\s*(\d+)\s*(?:条|行|个)/.exec(pageText);
  const headerText = (() => {
    const h = best.el.querySelector('[role="row"], thead tr, [class*="header" i]');
    return h ? (h.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300) : null;
  })();
  return {
    found: true,
    url: location.href,
    container_class: String(best.el.className || '').slice(0, 100),
    scrollable: !!vp,
    scroll_viewport: vp ? { tag: vp.tagName, cls: String(vp.className || '').slice(0, 80), ...before } : null,
    scroll_steps: steps,
    collected_count: ordered.length,
    store_row_count: totalIdx >= 0 ? totalIdx : ordered.length,
    has_total_row: totalIdx >= 0,
    total_row_text: totalIdx >= 0 ? ordered[totalIdx].text.slice(0, 300) : null,
    declared_count_text: cm ? cm[0] : null,
    declared_count: cm ? Number(cm[1]) : null,
    header_text: headerText,
    first_row: ordered[0] ? ordered[0].text.slice(0, 220) : null,
    total_row_cell2: totalIdx >= 0 ? ordered[totalIdx].text.split(' ')[2] || null : null,
    rows: ordered.slice(0, maxRows).map((x) => ({ idx: x.idx, text: x.text.slice(0, 160) })),
  };
}

/** 在页面上下文中执行：读取「标签：选项…」分组结构，并判定每组选中项（只读，不点击） */
function readFilterGroups(input) {
  const { maxGroups = 40, maxOptions = 30, scopeSelector = null } = input || {};
  const scope = scopeSelector ? document.querySelector(scopeSelector) || document.body : document.body;
  const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');

  // 信号：显式状态优先（aria / input.checked / data-state / 选中类名），其次样式差异
  function signalsOf(el) {
    const cls = String(el.className || '');
    const st = getComputedStyle(el);
    const inner = el.querySelector ? el.querySelector('input') : null;
    const isInput = String(el.tagName).toLowerCase() === 'input';
    const ariaChecked = el.getAttribute('aria-checked');
    const ariaSelected = el.getAttribute('aria-selected');
    const ariaPressed = el.getAttribute('aria-pressed');
    const dataState = el.getAttribute('data-state') || el.getAttribute('data-selected') || el.getAttribute('data-active');
    const checkedAttr = el.getAttribute('checked');
    const inputChecked = inner ? inner.checked === true : (isInput ? el.checked === true : null);
    const token = (cls.match(/(?:^|\s)(active|selected|checked|is-active|is-selected|current|chosen|on)(?:\s|$)/i) || [])[1] || null;
    return {
      tag: String(el.tagName).toLowerCase(),
      cls: cls.slice(0, 90),
      title: el.getAttribute('title') || null,
      aria_checked: ariaChecked,
      aria_selected: ariaSelected,
      aria_pressed: ariaPressed,
      data_state: dataState,
      checked_attr: checkedAttr,
      input_type: inner ? (inner.getAttribute('type') || null) : (isInput ? (el.getAttribute('type') || null) : null),
      input_checked: inputChecked,
      class_token: token,
      color: st.color,
      font_weight: st.fontWeight,
      bg: st.backgroundColor,
      border_color: st.borderColor,
      cursor: st.cursor,
      text: textOf(el).slice(0, 40),
    };
  }
  /** 依据多信号判定某元素是否「选中」，返回 {selected, signal, evidence} */
  function decisive(s) {
    if (s.aria_checked === 'true') return { selected: true, signal: 'aria-checked', evidence: 'aria-checked="true"' };
    if (s.aria_selected === 'true') return { selected: true, signal: 'aria-selected', evidence: 'aria-selected="true"' };
    if (s.aria_pressed === 'true') return { selected: true, signal: 'aria-pressed', evidence: 'aria-pressed="true"' };
    if (s.input_checked === true) return { selected: true, signal: 'input.checked', evidence: `input[type=${s.input_type}].checked=true` };
    if (s.data_state === 'true' || s.data_state === 'active' || s.data_state === 'selected' || s.data_state === 'checked') {
      return { selected: true, signal: 'data-state', evidence: `data-state/selected/active="${s.data_state}"` };
    }
    if (s.checked_attr !== null) return { selected: true, signal: 'checked-attr', evidence: 'has checked attribute' };
    if (s.class_token) return { selected: true, signal: 'class-token', evidence: `class 含 "${s.class_token}"` };
    return { selected: false, signal: null, evidence: null };
  }

  // 叶子元素（无元素子节点）且文本以「：」结尾 → 候选标签
  const labelEls = [];
  for (const el of Array.from(scope.querySelectorAll('span,div,label,dt,th,td,p,b,strong,a'))) {
    if (el.children.length > 0) continue;
    const t = textOf(el);
    if (!t || t.length > 16) continue;
    if (!/[:：]\s*$/.test(t)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    labelEls.push({ el, label: t.replace(/\s*[:：]\s*$/, '') });
  }

  const groups = [];
  for (const { el, label } of labelEls) {
    // 选项容器：从标签父级向上找到「含有叶子文本选项」的最浅容器
    let container = null;
    let node = el.parentElement;
    for (let up = 0; up < 4 && node; up += 1) {
      const leaves = Array.from(node.querySelectorAll('*')).filter((d) => {
        if (d.children.length > 0) return false;
        const t = textOf(d);
        return t && t.length <= 24 && !/[:：]\s*$/.test(t) && d !== el;
      });
      if (leaves.length >= 1) {
        container = node;
        break;
      }
      node = node.parentElement;
    }
    if (!container) continue;
    const opts = [];
    for (const d of Array.from(container.querySelectorAll('*'))) {
      if (d.children.length > 0) continue;
      const t = textOf(d);
      if (!t || t.length > 24 || /[:：]\s*$/.test(t)) continue;
      opts.push({ el: d, s: signalsOf(d) });
    }
    if (!opts.length) continue;
    if (opts.length > maxOptions) continue;
    // 显式状态判定
    let selectedIdx = [];
    let signalUsed = null;
    let noise = null;
    const explicit = opts.map((o) => decisive(o.s));
    const hits = explicit.map((d, i) => (d.selected ? i : -1)).filter((i) => i >= 0);
    if (hits.length) {
      selectedIdx = hits;
      signalUsed = explicit[hits[0]].signal;
      noise = explicit[hits[0]].evidence;
    } else if (opts.length >= 2) {
      // 样式差异判定：多数派之外的唯一一个强调样式即为选中项
      const sig = (s) => `${s.color}|${s.font_weight}|${s.bg}`;
      const counts = {};
      for (const o of opts) counts[sig(o.s)] = (counts[sig(o.s)] || 0) + 1;
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      if (sorted.length === 2 && sorted[1][1] === 1) {
        const odd = sig(opts[0].s) === sorted[0][0] ? opts.findIndex((o) => sig(o.s) === sorted[1][0]) : 0;
        selectedIdx = [odd];
        signalUsed = 'style-differential';
        noise = `唯一不同样式：${sorted[1][0]}（多数派 ${sorted[0][0]} ×${sorted[0][1]}）`;
        if (odd < 0) selectedIdx = [];
      }
    }
    groups.push({
      label,
      label_selector: window.__probeHelpers ? window.__probeHelpers.cssPathOf(el) : null,
      container_class: String(container.className || '').slice(0, 80),
      option_count: opts.length,
      selected_texts: selectedIdx.map((i) => opts[i].s.text),
      signal_used: signalUsed,
      signal_evidence: noise,
      determinate: selectedIdx.length === 1,
      options: opts.map((o, i) => ({
        text: o.s.text,
        tag: o.s.tag,
        cls: o.s.cls,
        title: o.s.title,
        aria_checked: o.s.aria_checked,
        aria_selected: o.s.aria_selected,
        input_type: o.s.input_type,
        input_checked: o.s.input_checked,
        data_state: o.s.data_state,
        class_token: o.s.class_token,
        color: o.s.color,
        font_weight: o.s.font_weight,
        bg: o.s.bg,
        selected: selectedIdx.includes(i),
      })),
    });
    if (groups.length >= maxGroups) break;
  }
  return { url: location.href, group_count: groups.length, label_count: labelEls.length, groups };
}

/** 在页面上下文中执行：读取「营业日期 / 星期 / 门店 / 高级 / 展开筛选」这一行控件状态（只读） */
function readDateRow(input) {
  const { maxLeaf = 60 } = input || {};
  const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  // 定位含「营业日期」文案的最小容器
  let anchor = null;
  for (const el of Array.from(document.querySelectorAll('span,div,label,dt,th,td,p,b,strong'))) {
    if (el.children.length > 0) continue;
    const t = textOf(el);
    if (/^营业日期\s*[:：]?$/.test(t) || t === '营业日期') {
      anchor = el;
      break;
    }
  }
  if (!anchor) return { found: false, url: location.href };
  let row = anchor.parentElement;
  for (let up = 0; up < 4 && row; up += 1) {
    if (row.querySelector('input')) break;
    row = row.parentElement;
  }
  if (!row) row = anchor.parentElement;
  const leaves = [];
  for (const d of Array.from(row.querySelectorAll('*'))) {
    const t = textOf(d);
    if (d.children.length > 0) continue;
    if (!t) continue;
    const r = d.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    leaves.push({
      tag: String(d.tagName).toLowerCase(),
      text: t.slice(0, 40),
      cls: String(d.className || '').slice(0, 70),
      title: d.getAttribute('title') || null,
      placeholder: d.getAttribute('placeholder') || null,
      value: d.value === undefined ? null : String(d.value).slice(0, 30),
      readOnly: d.readOnly === undefined ? null : d.readOnly === true,
      disabled: d.disabled === undefined ? null : d.disabled === true,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      selector: window.__probeHelpers ? window.__probeHelpers.cssPathOf(d) : null,
    });
    if (leaves.length >= maxLeaf) break;
  }
  const inputs = Array.from(row.querySelectorAll('input')).map((i) => {
    const r = i.getBoundingClientRect();
    return {
      type: i.getAttribute('type') || null,
      value: String(i.value || '').slice(0, 30),
      placeholder: i.getAttribute('placeholder') || null,
      readOnly: i.readOnly === true,
      disabled: i.disabled === true,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      selector: window.__probeHelpers ? window.__probeHelpers.cssPathOf(i) : null,
    };
  });
  const block = (() => {
    // 向上找到同时包含「星期」与「门店」文案的祖先区块（承载 营业日期/星期/门店 整行）
    let b = anchor.parentElement;
    let hops = 0;
    while (b && hops < 7) {
      const t = textOf(b);
      if (t.includes('星期') && t.includes('门店')) break;
      b = b.parentElement;
      hops += 1;
    }
    if (!b) return null;
    const outline = [];
    (function walk(el, depth) {
      if (!el || outline.length >= 90) return;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      const o = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim();
      outline.push({
        depth,
        tag: String(el.tagName).toLowerCase(),
        cls: String(el.className || '').slice(0, 60),
        own_text: o.slice(0, 30),
        full_text: textOf(el).slice(0, 40),
        value: el.value === undefined ? null : String(el.value).slice(0, 24),
        readOnly: el.readOnly === undefined ? null : el.readOnly === true,
        cls_checked: /-checked(\s|$)/.test(String(el.className || '')),
        title: el.getAttribute('title') || null,
      });
      if (depth >= 5) return;
      for (const c of Array.from(el.children)) walk(c, depth + 1);
    })(b, 0);
    return { root_class: String(b.className || '').slice(0, 80), node_count: outline.length, outline, form_items: (() => {
      const items = [];
      for (const el of Array.from(b.querySelectorAll('*'))) {
        const cls = String(el.className || '');
        if (!/saas-row/.test(cls) || !/saas-form-item/.test(cls)) continue;
        if (/saas-form-item-(label|control|children|top-slot|bottom-slot)/.test(cls)) continue;
        const t = textOf(el);
        if (!t) continue;
        const checked = Array.from(el.querySelectorAll('*')).filter((d) => /-checked(\s|$)/.test(String(d.className || ''))).map((d) => textOf(d).slice(0, 20));
        items.push({ cls: cls.slice(0, 70), text: t.slice(0, 70), checked_texts: Array.from(new Set(checked)) });
      }
      return items;
    })() };
  })();
  return { found: true, url: location.href, row_class: String(row.className || '').slice(0, 90), leaf_count: leaves.length, leaves, inputs, block };
}

/**
 * 在页面上下文中执行：读取当前可见的日期选择面板结构（只读，不点击）
 * 用于确认「真正通过页面日期控件设置日期」所需的日历单元格定位方式。
 */
function readPicker(input) {
  const { maxCells = 60 } = input || {};
  const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const panels = [];
  // 常见日历面板：含星期表头（日/一/二/三/四/五/六）的可见容器
  const cands = Array.from(document.querySelectorAll('div,table,section,ul'));
  for (const c of cands) {
    const t = textOf(c);
    if (!t) continue;
    if (!/日\s*一\s*二\s*三\s*四\s*五\s*六/.test(t)) continue;
    const r = c.getBoundingClientRect();
    if (r.width < 120 || r.height < 80) continue;
    const st = getComputedStyle(c);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    // 日历单元格：类名含 cell/date/day 或带 title=YYYY-MM-DD
    let cells = Array.from(c.querySelectorAll('[title]')).filter((el) => /^\d{4}-\d{2}-\d{2}$/.test(el.getAttribute('title') || ''));
    let cellMode = 'title';
    if (!cells.length) {
      cells = Array.from(c.querySelectorAll('[class*="cell" i],[class*="date" i],[class*="day" i]')).filter((el) => /^\d{1,2}$/.test(textOf(el)));
      cellMode = 'class-text';
    }
    if (!cells.length) continue;
    const headerEls = [];
    // 面板头部：含年月文案的元素
    for (const h of Array.from(c.querySelectorAll('*'))) {
      if (h.children.length > 0) continue;
      const ht = textOf(h);
      if (/^\d{4}\s*年?/.test(ht) || /^\d{1,2}\s*月$/.test(ht)) {
        headerEls.push({ text: ht.slice(0, 40), cls: String(h.className || '').slice(0, 60), selector: window.__probeHelpers ? window.__probeHelpers.cssPathOf(h) : null });
      }
      if (headerEls.length >= 8) break;
    }
    panels.push({
      container_class: String(c.className || '').slice(0, 90),
      container_selector: window.__probeHelpers ? window.__probeHelpers.cssPathOf(c) : null,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      cell_mode: cellMode,
      cell_count: cells.length,
      headers: headerEls,
      cells: cells.slice(0, maxCells).map((el) => {
        const cs = getComputedStyle(el);
        return {
          text: textOf(el).slice(0, 12),
          title: el.getAttribute('title') || null,
          cls: String(el.className || '').slice(0, 80),
          color: cs.color,
          bg: cs.backgroundColor,
          font_weight: cs.fontWeight,
          aria_selected: el.getAttribute('aria-selected'),
          aria_disabled: el.getAttribute('aria-disabled'),
          data_state: el.getAttribute('data-state') || null,
          rect: (() => { const rr = el.getBoundingClientRect(); return { x: Math.round(rr.x), y: Math.round(rr.y), w: Math.round(rr.width), h: Math.round(rr.height) }; })(),
          selector: window.__probeHelpers ? window.__probeHelpers.cssPathOf(el) : null,
        };
      }),
    });
    if (panels.length >= 3) break;
  }
  return { url: location.href, panel_count: panels.length, panels };
}

/**
 * 在页面上下文中执行：检测遮挡页面、拦截点击的弹窗/引导/遮罩（只读，不点击）
 * 用于识别站点公告弹窗（例：「新增功能 … 查看详情 知道了」）等阻断性浮层。
 */
function readOverlays(input) {
  const { minAreaRatio = 0.1, maxText = 500 } = input || {};
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const sel = (el) => (window.__probeHelpers ? window.__probeHelpers.cssPathOf(el) : null);

  const overlays = [];
  const seen = new Set();
  const cands = Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],[class*="modal" i],[class*="dialog" i],[class*="overlay" i],[class*="mask" i],[class*="popup" i],[class*="guide" i],[class*="announce" i],[class*="update" i],[class*="notice" i]'));
  for (const el of cands) {
    const rect = rectOf(el);
    if (rect.w < 60 || rect.h < 30) continue;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
    if (st.position !== 'fixed' && st.position !== 'absolute') continue;
    const areaRatio = (rect.w * rect.h) / (vw * vh);
    if (areaRatio < minAreaRatio) continue;
    const text = textOf(el);
    const key = `${rect.x},${rect.y},${rect.w},${rect.h},${text.slice(0, 30)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 可点击文案控件（叶子节点，短文本）
    const controls = [];
    for (const c of Array.from(el.querySelectorAll('button,a,[role="button"],span,div,i'))) {
      if (c.children.length > 0) continue;
      const t = textOf(c);
      if (!t || t.length > 14) continue;
      const cr = rectOf(c);
      if (cr.w < 8 || cr.h < 8) continue;
      const cs = getComputedStyle(c);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      controls.push({ tag: String(c.tagName).toLowerCase(), text: t, selector: sel(c), rect: cr, cls: String(c.className || '').slice(0, 60) });
      if (controls.length >= 30) break;
    }
    overlays.push({
      class_name: String(el.className || '').slice(0, 100),
      role: el.getAttribute('role') || null,
      aria_modal: el.getAttribute('aria-modal') || null,
      position: st.position,
      z_index: st.zIndex,
      rect,
      area_ratio: Number(areaRatio.toFixed(3)),
      text: text.slice(0, maxText),
      text_length: text.length,
      is_mask_only: text.length === 0,
      controls,
      control_texts: Array.from(new Set(controls.map((c) => c.text))),
    });
  }
  overlays.sort((a, b) => b.area_ratio - a.area_ratio);
  return {
    url: location.href,
    viewport: { w: vw, h: vh },
    overlay_count: overlays.length,
    overlays: overlays.slice(0, 6),
    has_blocking_overlay: overlays.length > 0,
  };
}

/**
 * 在页面上下文中执行（只读）：针对给定标签，输出其所在分组子树的**结构大纲**，
 * 用于确认「选中状态」到底挂在哪个元素上（叶节点本身没有任何状态时）。
 */
function readFilterDetail(input) {
  const { labels = [], maxDepth = 5, maxNodes = 120 } = input || {};
  const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const ownText = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim();
  const desc = (el) => {
    const st = getComputedStyle(el);
    const cls = String(el.className || '');
    const attrs = {};
    for (const a of Array.from(el.attributes || [])) {
      if (/^(aria-|data-|role|title|checked|disabled)/.test(a.name)) attrs[a.name] = String(a.value).slice(0, 30);
    }
    const isInput = String(el.tagName).toLowerCase() === 'input';
    const rr = el.getBoundingClientRect();
    return {
      tag: String(el.tagName).toLowerCase(),
      cls: cls.slice(0, 80),
      selector: window.__probeHelpers ? window.__probeHelpers.cssPathOf(el) : null,
      rect: { x: Math.round(rr.x), y: Math.round(rr.y), w: Math.round(rr.width), h: Math.round(rr.height) },
      own_text: ownText(el).slice(0, 30),
      full_text: textOf(el).slice(0, 40),
      attrs,
      checked: isInput ? el.checked === true : null,
      input_type: isInput ? (el.getAttribute('type') || null) : null,
      color: st.color,
      fw: st.fontWeight,
      bg: st.backgroundColor,
      border: st.borderColor,
      token: (cls.match(/(?:^|\s)(active|selected|checked|is-active|is-selected|current|chosen|on)(?:\s|$)/i) || [])[1] || null,
      child_count: el.children.length,
    };
  };
  const results = [];
  for (const want of labels) {
    let labelEl = null;
    for (const el of Array.from(document.querySelectorAll('span,div,label,dt'))) {
      const t = textOf(el);
      if (t === `${want}：` || t === `${want}:`) { labelEl = el; break; }
      if (t === want && el.children.length === 0) { labelEl = el; break; }
    }
    if (!labelEl) { results.push({ label: want, found: false }); continue; }
    // 分组容器：向上找到包含「非标签叶文本」的最浅祖先
    let container = labelEl.parentElement;
    for (let up = 0; up < 4 && container; up += 1) {
      const leaves = Array.from(container.querySelectorAll('*')).filter((d) => d.children.length === 0 && textOf(d) && d !== labelEl);
      if (leaves.length >= 2) break;
      container = container.parentElement;
    }
    const outline = [];
    (function walk(el, depth) {
      if (!el || outline.length >= maxNodes) return;
      outline.push({ depth, ...desc(el) });
      if (depth >= maxDepth) return;
      for (const c of Array.from(el.children)) walk(c, depth + 1);
    })(container, 0);
    results.push({
      label: want,
      found: true,
      label_selector: window.__probeHelpers ? window.__probeHelpers.cssPathOf(labelEl) : null,
      container_class: String(container.className || '').slice(0, 90),
      container_selector: window.__probeHelpers ? window.__probeHelpers.cssPathOf(container) : null,
      node_count: outline.length,
      outline,
    });
  }
  return { url: location.href, results };
}

/**
 * 在页面上下文中执行（只读）：读取筛选面板的**权威状态**——radio/checkbox 的真实 checked 属性。
 * 结构（实测）：每组 = 「<维度名>：」标签所在元素的父级容器；选项 = 容器内 label（内含 input[type=radio|checkbox]）。
 * 判定优先级：input.checked（权威） → label class 含 -checked → 内部 span class 含 -checked；三者须一致，否则标 indeterminate。
 */
function readFilterState(input) {
  const { maxGroups = 30, includeSelects = true } = input || {};
  const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const ownText = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim();
  const sel = (el) => (window.__probeHelpers ? window.__probeHelpers.cssPathOf(el) : null);

  const groups = [];
  // 1) 找「<维度名>：」标签元素
  const labelEls = [];
  for (const el of Array.from(document.querySelectorAll('div,span,dt,th,label,p'))) {
    const ot = ownText(el);
    if (!ot || ot.length > 14) continue;
    if (!/^[^：:\s]{2,10}[:：]$/.test(ot)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    labelEls.push({ el, name: ot.replace(/[:：]$/, '') });
  }
  for (const { el, name } of labelEls) {
    let wrapper = el.parentElement;
    if (!wrapper) continue;
    // 选项 = 容器内所有含 radio/checkbox input 的 label
    let opts = [];
    for (const lab of Array.from(wrapper.querySelectorAll('label'))) {
      const inp = lab.querySelector('input[type="radio"],input[type="checkbox"]');
      if (!inp) continue;
      const t = textOf(lab);
      if (!t) continue;
      const labCls = String(lab.className || '');
      const inner = lab.querySelector('span[class*="radio"],span[class*="checkbox"]');
      const innerCls = inner ? String(inner.className || '') : '';
      const byInput = inp.checked === true;
      const byLabelCls = /-checked(\s|$)/.test(labCls);
      const byInnerCls = /-checked(\s|$)/.test(innerCls);
      const agree = byInput === byLabelCls && byInput === byInnerCls;
      opts.push({
        text: t.slice(0, 24),
        tag: String(lab.tagName).toLowerCase(),
        input_type: inp.getAttribute('type'),
        input_checked: byInput,
        label_class_checked: byLabelCls,
        inner_class_checked: byInnerCls,
        signals_agree: agree,
        value_attr: inp.getAttribute('value'),
        name_attr: inp.getAttribute('name'),
        selector: sel(lab),
        label_cls: labCls.slice(0, 70),
      });
    }
    if (!opts.length) continue;
    const checked = opts.filter((o) => o.input_checked);
    const inconsistent = opts.filter((o) => !o.signals_agree);
    groups.push({
      group: name,
      group_selector: sel(wrapper),
      wrapper_class: String(wrapper.className || '').slice(0, 70),
      option_count: opts.length,
      options: opts,
      checked_texts: checked.map((o) => o.text),
      determinate: inconsistent.length === 0 && checked.length >= 1,
      inconsistent_options: inconsistent.map((o) => o.text),
      read_evidence: inconsistent.length === 0
        ? `input.checked / label class -checked / 内部 span class -checked 三者一致（选项 ${opts.length} 个）`
        : `存在信号不一致选项：${inconsistent.map((o) => o.text).join('、')}`,
    });
    if (groups.length >= maxGroups) break;
  }

  // 2) 下拉类控件（星期 / 门店 等）：读取其显示值
  const selects = [];
  if (includeSelects) {
    for (const s of Array.from(document.querySelectorAll('[class*="saas-select"],[role="combobox"]'))) {
      const r = s.getBoundingClientRect();
      if (r.width < 30 || r.height < 12) continue;
      const st = getComputedStyle(s);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      const t = textOf(s);
      if (!t) continue;
      const cls = String(s.className || '');
      selects.push({
        text: t.slice(0, 40),
        cls: cls.slice(0, 80),
        is_selection_item: /selection-item/.test(cls),
        title: s.getAttribute('title') || null,
        selector: sel(s),
      });
      if (selects.length >= 40) break;
    }
  }

  // 3) 日期输入框与「高级/展开筛选」状态
  const dateInputs = [];
  for (const i of Array.from(document.querySelectorAll('input'))) {
    const ph = i.getAttribute('placeholder') || '';
    if (!/日期/.test(ph)) continue;
    dateInputs.push({ placeholder: ph, value: String(i.value || ''), readOnly: i.readOnly === true, selector: sel(i) });
  }
  const advanced = [];
  for (const b of Array.from(document.querySelectorAll('button,span,a,div'))) {
    if (b.children.length > 0) continue;
    const t = textOf(b);
    if (!/^(高级|展开筛选|收起筛选|收起维度)$/.test(t)) continue;
    const r = b.getBoundingClientRect();
    if (r.width === 0) continue;
    const st = getComputedStyle(b);
    advanced.push({ text: t, color: st.color, cls: String(b.className || '').slice(0, 60), selector: sel(b), visible: st.display !== 'none' && st.visibility !== 'hidden' });
  }
  return { url: location.href, group_count: groups.length, groups, selects, date_inputs: dateInputs, advanced_controls: advanced };
}

/**
 * 在页面上下文中执行：读取日期面板的**真实日历单元格**（基于 title="YYYY-MM-DD"），只读。
 * 同时读取快捷项（今天/昨天/…）。这是驱动真实日期控件的定位依据。
 */
function readPickerCells(input) {
  const { maxCells = 80 } = input || {};
  const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const sel = (el) => (window.__probeHelpers ? window.__probeHelpers.cssPathOf(el) : null);
  const vis = (el) => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const byDate = {};
  let raw = 0;
  for (const el of Array.from(document.querySelectorAll('[title]'))) {
    const t = el.getAttribute('title') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) continue;
    if (!vis(el)) continue;
    raw += 1;
    if (byDate[t]) continue;
    const cs = getComputedStyle(el);
    const cls = String(el.className || '');
    byDate[t] = {
      date: t,
      text: textOf(el).slice(0, 8),
      tag: String(el.tagName).toLowerCase(),
      cls: cls.slice(0, 90),
      color: cs.color,
      bg: cs.backgroundColor,
      token: (cls.match(/(?:^|\s)(active|selected|in-range|range-start|range-end|today|checked)(?:\s|$)/i) || [])[1] || null,
      aria_selected: el.getAttribute('aria-selected'),
      aria_disabled: el.getAttribute('aria-disabled'),
      rect: rectOf(el),
      selector: sel(el),
    };
  }
  const presets = [];
  for (const el of Array.from(document.querySelectorAll('a,button,span,li,div'))) {
    if (el.children.length > 0) continue;
    const t = textOf(el);
    if (!/^(今天|昨天|前天|最近7天|最近30天|本周|上周|本月|上月|近7日|近30日)$/.test(t)) continue;
    if (!vis(el)) continue;
    presets.push({ text: t, cls: String(el.className || '').slice(0, 70), rect: rectOf(el), selector: sel(el) });
    if (presets.length >= 20) break;
  }
  let panel = null;
  const first = Object.keys(byDate).sort()[0];
  if (first) {
    let n = document.querySelector(`[title="${first}"]`);
    for (let up = 0; up < 8 && n; up += 1) {
      const cls = String(n.className || '');
      if (/picker|dropdown|panel|calendar/i.test(cls)) { panel = { cls: cls.slice(0, 90), rect: rectOf(n), selector: sel(n) }; break; }
      n = n.parentElement;
    }
  }
  const dates = Object.keys(byDate).sort();
  return {
    url: location.href,
    raw_title_cells: raw,
    distinct_dates: dates.length,
    min_date: dates[0] || null,
    max_date: dates[dates.length - 1] || null,
    cells: dates.map((d) => byDate[d]),
    presets,
    panel,
  };
}

/** 在页面上下文中执行（只读）：读取**下拉列表**的选项（限定在 listbox / select-dropdown 容器内，避免误匹配左侧菜单） */
function readListOptions(input) {
  const { max = 40 } = input || {};
  const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const vis = (el) => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const containers = [];
  for (const c of Array.from(document.querySelectorAll('[role="listbox"],[class*="select-dropdown"],[class*="dropdown-menu"],[class*="select-dropdown-visible"]'))) {
    if (!vis(c)) continue;
    const r = rectOf(c);
    if (r.w < 40 || r.h < 16) continue;
    containers.push({ el: c, cls: String(c.className || '').slice(0, 90), rect: r });
  }
  const options = [];
  const seen = new Set();
  const scopeEls = containers.length ? containers.map((c) => c.el) : [];
  const pool = [];
  for (const c of scopeEls) for (const o of Array.from(c.querySelectorAll('[role="option"],[class*="select-item"],[class*="option"]'))) pool.push(o);
  if (!pool.length) for (const o of Array.from(document.querySelectorAll('[role="option"]'))) if (vis(o)) pool.push(o);
  for (const el of pool) {
    if (!vis(el)) continue;
    const t = textOf(el);
    if (!t || t.length > 40) continue;
    const cls = String(el.className || '');
    const key = `${t}|${JSON.stringify(rectOf(el))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({
      text: t,
      cls: cls.slice(0, 90),
      is_selected: /-selected(\s|$)/.test(cls) || el.getAttribute('aria-selected') === 'true',
      aria_selected: el.getAttribute('aria-selected'),
      rect: rectOf(el),
      selector: window.__probeHelpers ? window.__probeHelpers.cssPathOf(el) : null,
    });
    if (options.length >= max) break;
  }
  // 搜索框的 aria-expanded 可判断下拉是否已展开
  const searchInput = document.querySelector('input[role="combobox"]');
  return {
    url: location.href,
    container_count: containers.length,
    containers: containers.map((c) => ({ cls: c.cls, rect: c.rect })),
    count: options.length,
    options,
    combobox_aria_expanded: searchInput ? searchInput.getAttribute('aria-expanded') : null,
  };
}

/**
 * 在页面上下文中执行（只读）：读取列表页的行（文本 / 单元格 / 行内操作控件 / 坐标）。
 * 用于下载清单页：识别「行 / 状态 / 下载操作」三要素。
 */
function readDownloadRows(input) {
  const { maxRows = 60, maxControls = 12 } = input || {};
  const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const sel = (el) => (window.__probeHelpers ? window.__probeHelpers.cssPathOf(el) : null);
  const vis = (el) => { const st = getComputedStyle(el); if (st.display === 'none' || st.visibility === 'hidden') return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

  const rows = [];
  const seen = new Set();
  for (const tr of Array.from(document.querySelectorAll('tr, [role="row"], [class*="table-row" i]'))) {
    if (!vis(tr)) continue;
    const t = textOf(tr);
    if (!t || t.length < 2) continue;
    const key = `${rectOf(tr).y}|${t.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const controls = [];
    for (const c of Array.from(tr.querySelectorAll('a,button,span,[role="button"]'))) {
      if (!vis(c)) continue;
      const ct = textOf(c);
      if (!ct || ct.length > 10) continue;
      controls.push({ tag: String(c.tagName).toLowerCase(), text: ct, selector: sel(c), rect: rectOf(c), cls: String(c.className || '').slice(0, 60) });
      if (controls.length >= maxControls) break;
    }
    rows.push({
      text: t.slice(0, 400),
      cells: Array.from(tr.children).map((td) => textOf(td)).slice(0, 20),
      rect: rectOf(tr),
      controls,
      control_texts: Array.from(new Set(controls.map((c) => c.text))),
    });
    if (rows.length >= maxRows) break;
  }
  rows.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const body = (document.body && document.body.innerText ? document.body.innerText : '').replace(/\s+/g, ' ');
  return {
    url: location.href,
    row_count: rows.length,
    rows,
    header_hint: (() => { const h = document.querySelector('thead tr, [class*="table-header" i] tr'); return h ? textOf(h).slice(0, 300) : null; })(),
    page_has_export_done: body.includes('导出完成'),
    page_has_download_word: body.includes('下载'),
    page_text_head: body.slice(0, 400),
  };
}

module.exports = {
  installHelpers,
  collectByText,
  readFilterPanel,
  readFilterGroups,
  readFilterDetail,
  readFilterState,
  readDateRow,
  readPicker,
  readPickerCells,
  readOverlays,
  readListOptions,
  readDownloadRows,
  readTableSummary,
  inspectElement,
  collectDateInputs,
  regionText,
  findPanelByTexts,
  findTableContainer,
  detectBlockers,
  readGridDetail,
  readGridAllRows,
};
