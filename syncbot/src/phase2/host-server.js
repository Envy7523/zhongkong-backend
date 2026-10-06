'use strict';
/**
 * 阶段2：浏览器宿主（Unix Socket 控制通道）
 *
 * 运行位置：`syncbot-browser.service` 内部（唯一持有 Chromium 持久 Profile 的进程）。
 * 职责：只执行**原子动作**（导航、只读取证、截图、点击、填日期），业务判断在 CLI 侧。
 *
 * 硬性约束（代码级强制，不依赖调用方自律）：
 *  1. socket `state/runtime/host.sock` 权限 0600，目录 0750；**不新增任何 TCP 监听**；
 *  2. 人工会话未 stop（human-busy 存在且未过期）→ 一切自动化命令拒绝；
 *  3. 自动化任务进行中 → humanSessionStart 拒绝；
 *  4. 未获「允许提交导出申请」批准 → 拒绝任何 purpose='export' 的点击；
 *  5. 未获「允许前往下载清单/下载」批准 → 拒绝跳转下载清单与点击下载；
 *  6. 每条命令（含被拒绝的）都写审计，审计只追加不修改历史。
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { createLineDecoder } = require('./proto');
const probe = require('./dom-probe');

const AUTOMATION_COMMANDS = new Set([
  'goto',
  'click',
  'fill',
  'probe',
  'filterPanel',
  'tableSummary',
  'gridDetail',
  'gridAllRows',
  'filterGroups',
  'filterDetail',
  'filterState',
  'listOptions',
  'downloadRows',
  'dateRow',
  'picker',
  'overlays',
  'mouse',
  'inspect',
  'dateInputs',
  'region',
  'screenshot',
  'waitForSelector',
  'findPanel',
  'findTable',
  'blockers',
  'pageText',
  'press',
  'setDateRange',
]);

function safeWriteJson(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * @param {object} deps
 * @param {import('playwright').BrowserContext} deps.context
 * @param {import('playwright').Page} deps.page
 * @param {object} deps.logger
 * @param {string} deps.runtimeDir  state/runtime
 * @param {string} deps.stateDir    state/
 */
function startHost({ context, page, logger, runtimeDir, stateDir, platform }) {
  const socketPath = path.join(runtimeDir, 'host.sock');
  const humanBusyFile = path.join(runtimeDir, 'human-busy.json');
  const approvalsFile = path.join(runtimeDir, 'approvals.json');
  const auditFile = path.join(stateDir, `host-audit-${platform}.jsonl`);

  const state = {
    startedAt: new Date().toISOString(),
    activeTaskId: null,
    automationOwner: null,
    lastCommand: null,
    commandCount: 0,
    refusedCount: 0,
  };

  function audit(rec) {
    try {
      fs.appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n');
    } catch (e) {
      /* 审计失败不影响主流程，但记日志 */
      try {
        logger.warn('host.audit_append_failed', { error: e.message });
      } catch (_) {}
    }
  }

  function readApprovals() {
    try {
      return { export_submit: false, download_list: false, download_file: false, ...JSON.parse(fs.readFileSync(approvalsFile, 'utf8')) };
    } catch (_) {
      return { export_submit: false, download_list: false, download_file: false };
    }
  }

  function readHumanBusy() {
    try {
      const j = JSON.parse(fs.readFileSync(humanBusyFile, 'utf8'));
      const age = (Date.now() - new Date(j.since).getTime()) / 1000;
      const expired = j.ttl && age > j.ttl;
      return { present: true, expired: !!expired, ...j };
    } catch (_) {
      return { present: false, expired: false };
    }
  }

  function writeHumanBusy(owner, extra = {}) {
    safeWriteJson(humanBusyFile, { owner, since: new Date().toISOString(), ttl: 900, ...extra });
    try {
      fs.chmodSync(humanBusyFile, 0o640);
    } catch (_) {}
  }

  function clearHumanBusy() {
    try {
      fs.unlinkSync(humanBusyFile);
    } catch (_) {}
  }

  /** 人工会话是否正在占用（**仅 owner==='human'** 且未过期；
   *  注意 owner==='auto' 表示自动化任务自身占用，不得据此拒绝自动化命令，否则会自锁） */
  function humanActive() {
    const h = readHumanBusy();
    return h.present && !h.expired && h.owner === 'human';
  }

  function guard(cmd, args) {
    // 规则 2：人工会话未 stop → 自动化命令一律拒绝
    if (AUTOMATION_COMMANDS.has(cmd) && humanActive()) {
      const h = readHumanBusy();
      return `HUMAN_BUSY：人工会话进行中（owner=${h.owner}, since=${h.since}）。请先执行 syncbot human-session stop`;
    }
    // 规则 3：自动化进行中 → 拒绝人工会话开始
    if (cmd === 'humanSessionStart') {
      const h = readHumanBusy();
      if (state.activeTaskId) {
        return `AUTOMATION_ACTIVE：自动化任务 ${state.activeTaskId} 正在运行，禁止开始人工会话`;
      }
      if (h.present && !h.expired && h.owner === 'auto') {
        return 'AUTOMATION_ACTIVE：检测到自动化占用标志（owner=auto），禁止开始人工会话；请等待任务结束或人工中止';
      }
    }
    // 规则 4：导出点击需批准
    if (cmd === 'click' && args && args.purpose === 'export') {
      const ap = readApprovals();
      if (!ap.export_submit) {
        return 'EXPORT_NOT_APPROVED：未获得「允许提交导出申请」批准，拒绝点击「导出」（当前仅批准 dry-run）';
      }
    }
    // 规则 5：下载清单跳转 / 下载点击需批准
    if (cmd === 'goto' && args && args.purpose === 'download_list') {
      const ap = readApprovals();
      if (!ap.download_list) return 'DOWNLOAD_LIST_NOT_APPROVED：未获得「允许前往下载清单」批准，拒绝跳转';
    }
    if (cmd === 'click' && args && args.purpose === 'download') {
      const ap = readApprovals();
      if (!ap.download_file) return 'DOWNLOAD_NOT_APPROVED：未获得「允许下载报表」批准，拒绝点击「下载」';
    }
    // 规则 6：结果表 / 页面文本类只读命令在人工占用期间也允许（便于人工自查），其余按规则 2 处理
    return null;
  }

  // ===== 跨 frame 工具（目标报表页内容位于 iframe 内）=====
  /** 给所有 frame 打上 __idx（便于回传 frame 归属） */
  function markFrames() {
    page.frames().forEach((f, i) => {
      f.__idx = i;
    });
    return page.frames();
  }

  /** 在所有 frame 中安装探针工具（幂等；页面翻页/新 frame 后需重装） */
  async function installAllFrames() {
    const out = [];
    for (const f of markFrames()) {
      try {
        out.push({ frameIndex: f.__idx, frameUrl: f.url(), installed: await f.evaluate(probe.installHelpers, {}) });
      } catch (e) {
        out.push({ frameIndex: f.__idx, frameUrl: f.url(), error: e.message.split('\n')[0] });
      }
    }
    return out;
  }

  /** 在所有 frame 中执行同一探针，回传逐 frame 结果 */
  async function evalAllFrames(fn, arg) {
    const out = [];
    for (const f of markFrames()) {
      try {
        out.push({ frameIndex: f.__idx, frameUrl: f.url(), result: await f.evaluate(fn, arg) });
      } catch (e) {
        out.push({ frameIndex: f.__idx, frameUrl: f.url(), error: e.message.split('\n')[0] });
      }
    }
    return out;
  }

  /** 找到包含该选择器的 frame（主 frame 优先）；wait=true 时轮询等待 */
  async function frameWithSelector(selector, { wait = false, timeoutMs = 15000 } = {}) {
    const deadline = Date.now() + (wait ? timeoutMs : 0);
    for (;;) {
      for (const f of markFrames()) {
        try {
          const n = await f.evaluate((sel) => document.querySelectorAll(sel).length, selector);
          if (n > 0) return f;
        } catch (_) {
          /* 跨域 frame 无法访问，跳过 */
        }
      }
      if (!wait || Date.now() > deadline) return null;
      await page.waitForTimeout(500);
    }
  }

  const handlers = {
    async ping() {
      return { pong: true, started_at: state.startedAt, protocol: 1 };
    },
    async frames() {
      return page.frames().map((f, i) => ({ index: i, url: f.url(), name: f.name(), isMain: f === page.mainFrame() }));
    },

    async ensureHelpers() {
      return installAllFrames();
    },

    async health() {
      const pages = context.pages();
      return {
        ok: true,
        started_at: state.startedAt,
        platform,
        display: process.env.DISPLAY || null,
        url: page.url(),
        title: await page.title().catch(() => null),
        page_count: pages.length,
        frame_count: page.frames().length,
        frames: page.frames().map((f, i) => ({ index: i, url: f.url(), isMain: f === page.mainFrame() })),
        active_task_id: state.activeTaskId,
        human_busy: readHumanBusy(),
        approvals: readApprovals(),
        command_count: state.commandCount,
        refused_count: state.refusedCount,
      };
    },

    async url() {
      return { url: page.url(), title: await page.title().catch(() => null) };
    },

    async goto(args) {
      const before = page.url();
      await page.goto(args.url, { waitUntil: args.waitUntil || 'domcontentloaded', timeout: args.timeoutMs || 45000 });
      await page.waitForTimeout(args.settleMs === undefined ? 1200 : args.settleMs);
      return { from: before, url: page.url(), title: await page.title().catch(() => null) };
    },

    async screenshot(args) {
      fs.mkdirSync(path.dirname(args.path), { recursive: true });
      await page.screenshot({ path: args.path, fullPage: args.fullPage === true });
      const st = fs.statSync(args.path);
      return { path: args.path, bytes: st.size, url: page.url() };
    },

    // ===== 跨 frame 只读探针（报表页内容在 iframe 内）=====
    async probe(args) {
      await installAllFrames();
      const perFrame = await evalAllFrames(probe.collectByText, {
        texts: args.texts,
        scopeSelector: args.scopeSelector || null,
        maxPerText: args.maxPerText || 6,
      });
      const merged = {};
      const frameHits = [];
      for (const fr of perFrame) {
        if (fr.error || !fr.result) continue;
        let hits = 0;
        for (const [k, v] of Object.entries(fr.result)) {
          hits += (v.exactCount || 0);
          merged[k] = merged[k] || { exact: [], partial: [], exactCount: 0, partialCount: 0 };
          for (const c of v.exact || []) merged[k].exact.push({ ...c, frameIndex: fr.frameIndex, frameUrl: fr.frameUrl });
          for (const c of v.partial || []) merged[k].partial.push({ ...c, frameIndex: fr.frameIndex, frameUrl: fr.frameUrl });
          merged[k].exactCount += v.exactCount || 0;
          merged[k].partialCount += v.partialCount || 0;
        }
        frameHits.push({ frameIndex: fr.frameIndex, frameUrl: fr.frameUrl, exactHits: hits });
      }
      return { merged, frameHits, perFrameErrors: perFrame.filter((f) => f.error).map((f) => ({ frameIndex: f.frameIndex, error: f.error })) };
    },

    async filterPanel(args) {
      await installAllFrames();
      const perFrame = await evalAllFrames(probe.readFilterPanel, { scopeSelector: args.scopeSelector || null });
      const found = perFrame.filter((f) => !f.error && f.result && f.result.found);
      const pickFrame = found.sort((a, b) => (b.result.controlCount || 0) - (a.result.controlCount || 0))[0] || perFrame[0];
      return pickFrame ? { frameIndex: pickFrame.frameIndex, frameUrl: pickFrame.frameUrl, ...pickFrame.result } : { found: false, text: '', controls: [] };
    },

    async tableSummary(args) {
      const perFrame = await evalAllFrames(probe.readTableSummary, { scopeSelector: args.scopeSelector || null });
      const merged = { tableCount: 0, tables: [], grids: [] };
      for (const fr of perFrame) {
        if (fr.error || !fr.result) continue;
        merged.tableCount += fr.result.tableCount || 0;
        for (const t of fr.result.tables || []) merged.tables.push({ ...t, frameIndex: fr.frameIndex, frameUrl: fr.frameUrl });
        for (const g of fr.result.grids || []) merged.grids.push({ ...g, frameIndex: fr.frameIndex, frameUrl: fr.frameUrl });
        // 分页与合计行：取「有声明总数」/「有合计行」的 frame（报表内容 frame）
        const pg = fr.result.pagination;
        if (pg && (pg.declared_count !== null || pg.page_size !== null || (pg.page_numbers || []).length)) {
          if (!merged.pagination || (merged.pagination.declared_count === null && pg.declared_count !== null)) {
            merged.pagination = { ...pg, frameIndex: fr.frameIndex, frameUrl: fr.frameUrl };
          }
        }
        const tr = fr.result.total_row;
        if (tr) {
          if (!merged.total_row || (tr.cells || []).length > (merged.total_row.cells || []).length) {
            merged.total_row = { ...tr, frameIndex: fr.frameIndex, frameUrl: fr.frameUrl };
          }
        }
        if (fr.result.total_row_candidates) merged.total_row_candidates = (merged.total_row_candidates || 0) + fr.result.total_row_candidates;
      }
      merged.grids.sort((a, b) => b.dataRowCount - a.dataRowCount);
      return merged;
    },

    async gridDetail(args) {
      const perFrame = await evalAllFrames(probe.readGridDetail, { maxRows: args.maxRows || 60 });
      const frames = perFrame.filter((f) => !f.error && f.result).map((f) => ({ frameIndex: f.frameIndex, frameUrl: f.frameUrl, ...f.result }));
      const withGrid = frames.filter((f) => (f.grid_candidates || []).length);
      return { frameCount: perFrame.length, frames, best: withGrid[0] || null };
    },

    async gridAllRows(args) {
      const perFrame = await evalAllFrames(probe.readGridAllRows, { maxSteps: args.maxSteps || 40, settleMs: args.settleMs || 320, maxRows: args.maxRows || 80 });
      const frames = perFrame.filter((f) => !f.error && f.result).map((f) => ({ frameIndex: f.frameIndex, frameUrl: f.frameUrl, ...f.result }));
      const withGrid = frames.filter((f) => f.found);
      withGrid.sort((a, b) => (b.collected_count || 0) - (a.collected_count || 0));
      return { frameCount: perFrame.length, frames, best: withGrid[0] || null, errors: perFrame.filter((f) => f.error).map((f) => ({ frameIndex: f.frameIndex, error: f.error })) };
    },

    // ===== 只读：筛选分组选中状态 / 日期行控件 / 日期面板结构 =====
    async filterGroups(args) {
      await installAllFrames();
      const perFrame = await evalAllFrames(probe.readFilterGroups, { maxGroups: args.maxGroups || 40, maxOptions: args.maxOptions || 30, scopeSelector: args.scopeSelector || null });
      const frames = perFrame.filter((f) => !f.error && f.result).map((f) => ({ frameIndex: f.frameIndex, frameUrl: f.frameUrl, ...f.result }));
      const withGroups = frames.filter((f) => (f.group_count || 0) > 0);
      withGroups.sort((a, b) => (b.group_count || 0) - (a.group_count || 0));
      return { frameCount: perFrame.length, best: withGroups[0] || null, errors: perFrame.filter((f) => f.error).map((f) => ({ frameIndex: f.frameIndex, error: f.error })) };
    },

    async filterDetail(args) {
      await installAllFrames();
      const perFrame = await evalAllFrames(probe.readFilterDetail, { labels: args.labels || [], maxDepth: args.maxDepth || 5, maxNodes: args.maxNodes || 120 });
      const frames = perFrame.filter((f) => !f.error && f.result).map((f) => ({ frameIndex: f.frameIndex, frameUrl: f.frameUrl, ...f.result }));
      const withFound = frames.filter((f) => (f.results || []).some((r) => r.found));
      withFound.sort((a, b) => (b.results || []).filter((r) => r.found).length - (a.results || []).filter((r) => r.found).length);
      return { frameCount: perFrame.length, best: withFound[0] || null, frames, errors: perFrame.filter((f) => f.error).map((f) => ({ frameIndex: f.frameIndex, error: f.error })) };
    },

    async downloadRows(args) {
      await installAllFrames();
      const perFrame = await evalAllFrames(probe.readDownloadRows, { maxRows: args.maxRows || 60, maxControls: args.maxControls || 12 });
      const frames = perFrame.filter((f) => !f.error && f.result).map((f) => ({ frameIndex: f.frameIndex, frameUrl: f.frameUrl, ...f.result }));
      const withRows = frames.filter((f) => (f.row_count || 0) > 0);
      withRows.sort((a, b) => (b.row_count || 0) - (a.row_count || 0));
      return { frameCount: perFrame.length, best: withRows[0] || frames[0] || null, frames, errors: perFrame.filter((f) => f.error).map((f) => ({ frameIndex: f.frameIndex, error: f.error })) };
    },

    async listOptions(args) {
      await installAllFrames();
      const perFrame = await evalAllFrames(probe.readListOptions, { max: args.max || 40 });
      const frames = perFrame.filter((f) => !f.error && f.result).map((f) => ({ frameIndex: f.frameIndex, frameUrl: f.frameUrl, ...f.result }));
      const withOpts = frames.filter((f) => (f.count || 0) > 0);
      withOpts.sort((a, b) => (b.count || 0) - (a.count || 0));
      return { frameCount: perFrame.length, best: withOpts[0] || null, frames, errors: perFrame.filter((f) => f.error).map((f) => ({ frameIndex: f.frameIndex, error: f.error })) };
    },

    async filterState(args) {
      await installAllFrames();
      const perFrame = await evalAllFrames(probe.readFilterState, { maxGroups: args.maxGroups || 30, includeSelects: args.includeSelects !== false });
      const frames = perFrame.filter((f) => !f.error && f.result).map((f) => ({ frameIndex: f.frameIndex, frameUrl: f.frameUrl, ...f.result }));
      const withGroups = frames.filter((f) => (f.group_count || 0) > 0);
      withGroups.sort((a, b) => (b.group_count || 0) - (a.group_count || 0));
      return { frameCount: perFrame.length, best: withGroups[0] || null, frames, errors: perFrame.filter((f) => f.error).map((f) => ({ frameIndex: f.frameIndex, error: f.error })) };
    },

    async dateRow(args) {      await installAllFrames();
      const perFrame = await evalAllFrames(probe.readDateRow, { maxLeaf: args.maxLeaf || 60 });
      const frames = perFrame.filter((f) => !f.error && f.result).map((f) => ({ frameIndex: f.frameIndex, frameUrl: f.frameUrl, ...f.result }));
      return { frameCount: perFrame.length, best: frames.find((f) => f.found) || null, frames, errors: perFrame.filter((f) => f.error).map((f) => ({ frameIndex: f.frameIndex, error: f.error })) };
    },

    async picker(args) {
      await installAllFrames();
      const perFrame = await evalAllFrames(args.cells === false ? probe.readPicker : probe.readPickerCells, { maxCells: args.maxCells || 80 });
      const frames = perFrame.filter((f) => !f.error && f.result).map((f) => ({ frameIndex: f.frameIndex, frameUrl: f.frameUrl, ...f.result }));
      const withCells = frames.filter((f) => (f.distinct_dates || 0) > 0);
      withCells.sort((a, b) => (b.distinct_dates || 0) - (a.distinct_dates || 0));
      return { frameCount: perFrame.length, best: withCells[0] || frames[0] || null, frames, errors: perFrame.filter((f) => f.error).map((f) => ({ frameIndex: f.frameIndex, error: f.error })) };
    },

    /** 真实鼠标操作（页面坐标）。用于必须由真实 mousedown/mouseup 才能打开的原生控件（如日期面板）。 */
    async mouse(args) {
      const before = page.url();
      const action = args.action || 'click';
      if (action === 'click') {
        await page.mouse.move(args.x, args.y);
        await page.waitForTimeout(120);
        await page.mouse.down();
        await page.waitForTimeout(60);
        await page.mouse.up();
      } else if (action === 'move') {
        await page.mouse.move(args.x, args.y);
      } else {
        throw new Error(`不支持的 mouse action: ${action}`);
      }
      await page.waitForTimeout(args.settleMs === undefined ? 1200 : args.settleMs);
      return { action, x: args.x, y: args.y, from: before, url: page.url() };
    },

    async overlays(args) {      await installAllFrames();
      const perFrame = await evalAllFrames(probe.readOverlays, { minAreaRatio: args.minAreaRatio || 0.1, maxText: args.maxText || 500 });
      const frames = perFrame.filter((f) => !f.error && f.result).map((f) => ({ frameIndex: f.frameIndex, frameUrl: f.frameUrl, ...f.result }));
      const withOverlay = frames.filter((f) => f.has_blocking_overlay);
      withOverlay.sort((a, b) => (b.overlay_count || 0) - (a.overlay_count || 0));
      return { frameCount: perFrame.length, best: withOverlay[0] || null, has_blocking_overlay: withOverlay.length > 0, frames, errors: perFrame.filter((f) => f.error).map((f) => ({ frameIndex: f.frameIndex, error: f.error })) };
    },

    async inspect(args) {
      const fr = await frameWithSelector(args.selector);
      if (!fr) return { exists: false, visible: false, enabled: false, rect: null, searchedFrames: page.frames().length };
      const r = await fr.evaluate(probe.inspectElement, { selector: args.selector });
      return { ...r, frameIndex: fr.__idx, frameUrl: fr.url() };
    },

    async dateInputs() {
      await installAllFrames();
      const perFrame = await evalAllFrames(probe.collectDateInputs, {});
      const out = [];
      for (const fr of perFrame) {
        if (fr.error || !fr.result) continue;
        for (const d of fr.result) out.push({ ...d, frameIndex: fr.frameIndex, frameUrl: fr.frameUrl });
      }
      return out;
    },

    async region(args) {
      const fr = args.selector ? await frameWithSelector(args.selector) : page.mainFrame();
      if (!fr) return null;
      const r = await fr.evaluate(probe.regionText, { selector: args.selector || null, maxDepth: args.maxDepth || 4 });
      return r === null ? null : { ...r, frameIndex: fr.__idx, frameUrl: fr.url() };
    },

    async findPanel(args) {
      await installAllFrames();
      const perFrame = await evalAllFrames(probe.findPanelByTexts, { texts: args.texts, minHits: args.minHits || 5 });
      const out = [];
      for (const fr of perFrame) {
        if (fr.error || !fr.result) continue;
        for (const p of fr.result) out.push({ ...p, frameIndex: fr.frameIndex, frameUrl: fr.frameUrl });
      }
      out.sort((a, b) => b.hits - a.hits || a.area - b.area);
      return out.slice(0, 6);
    },

    async findTable() {
      await installAllFrames();
      const perFrame = await evalAllFrames(probe.findTableContainer, {});
      const out = [];
      for (const fr of perFrame) {
        if (fr.error || !fr.result) continue;
        for (const t of fr.result) out.push({ ...t, frameIndex: fr.frameIndex, frameUrl: fr.frameUrl });
      }
      out.sort((a, b) => (b.has_total ? 1 : 0) - (a.has_total ? 1 : 0) || b.rows - a.rows);
      return out.slice(0, 6);
    },

    async blockers() {
      const perFrame = await evalAllFrames(probe.detectBlockers, {});
      const main = perFrame.find((f) => !f.error && f.result) || { result: {} };
      const keywordHits = [];
      let pwd = false;
      for (const fr of perFrame) {
        if (fr.error || !fr.result) continue;
        pwd = pwd || fr.result.has_password_input;
        for (const k of fr.result.keyword_hits || []) if (!keywordHits.includes(k)) keywordHits.push(k);
      }
      return {
        has_password_input: pwd,
        keyword_hits: keywordHits,
        likely_login_page: pwd || keywordHits.some((k) => /请登录|登录后|扫码登录/.test(k)),
        likely_human_verification: keywordHits.some((k) => /验证码|短信验证|滑动验证|安全验证|人机验证/.test(k)),
        url: page.url(),
        frames_checked: perFrame.length,
      };
    },

    async pageText(args) {
      const perFrame = await evalAllFrames(() => (document.body && document.body.innerText ? document.body.innerText : '').replace(/\s+/g, ' '), {});
      const parts = perFrame
        .filter((f) => !f.error && f.result)
        .map((f) => `[frame${f.frameIndex}] ${f.result}`);
      const t = parts.join(' ');
      const max = args && args.maxChars ? args.maxChars : 4000;
      return { text: t.slice(0, max), length: t.length, url: page.url(), frames: perFrame.length };
    },

    async waitForSelector(args) {
      const fr = await frameWithSelector(args.selector, { wait: true, timeoutMs: args.timeoutMs || 20000 });
      if (!fr) return { found: false, selector: args.selector, error: '在所有 frame 中都未出现该选择器' };
      return { found: true, selector: args.selector, frameIndex: fr.__idx, frameUrl: fr.url() };
    },

    async click(args) {
      const before = page.url();
      const fr = await frameWithSelector(args.selector);
      if (!fr) throw new Error(`选择器在所有 frame 中都不存在：${args.selector}`);
      let forced = false;
      let via = 'input_click';
      let firstError = null;
      try {
        await fr.click(args.selector, { timeout: args.timeoutMs || 20000 });
      } catch (e) {
        firstError = e.message.split('\n')[0];
        // 兜底顺序（每一步都写审计，点击是否生效仍由后置断言判定）：
        //   1) 关闭可能遮挡的浮层后，以 force 重试（跳过可操作性检查，但仍由 Playwright 发送真实鼠标事件）
        //   2) 仍失败则改为 DOM 级 click：先 scrollIntoView 再 el.click()
        //      —— 用于嵌套 iframe 内滚动定位卡住（scroll into view 反复重试至超时）的场景
        if (args.forceRetry !== false) {
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(400);
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(400);
          try {
            await fr.click(args.selector, { timeout: args.timeoutMs || 20000, force: true });
            forced = true;
            via = 'forced_input_click';
          } catch (e2) {
            if (args.domClickFallback === false) throw e2;
            await fr.evaluate((sel) => {
              const el = document.querySelector(sel);
              if (!el) throw new Error('element not found');
              el.scrollIntoView({ block: 'center', inline: 'center' });
              el.click();
              return true;
            }, args.selector);
            via = 'dom_click';
            firstError = `${firstError} | force: ${e2.message.split('\n')[0]}`;
          }
        } else {
          throw e;
        }
      }
      if (args.settleMs) await page.waitForTimeout(args.settleMs);
      return { clicked: args.selector, purpose: args.purpose || null, via, forced, first_error: firstError, frameIndex: fr.__idx, frameUrl: fr.url(), from: before, url: page.url() };
    },

    async fill(args) {
      const fr = await frameWithSelector(args.selector);
      if (!fr) throw new Error(`选择器在所有 frame 中都不存在：${args.selector}`);
      await fr.fill(args.selector, String(args.value));
      return { filled: args.selector, value: String(args.value), frameIndex: fr.__idx, frameUrl: fr.url() };
    },

    async press(args) {
      if (args.selector) {
        const fr = await frameWithSelector(args.selector);
        if (fr) await fr.focus(args.selector).catch(() => {});
      }
      await page.keyboard.press(args.key || 'Enter');
      return { pressed: args.key || 'Enter', target: args.selector || '(focused)' };
    },

    async setDateRange(args) {
      await installAllFrames();
      const { startSelector, endSelector, value } = args;
      const out = { start: null, end: null, readBack: null };
      const fStart = startSelector ? await frameWithSelector(startSelector) : null;
      const fEnd = endSelector ? await frameWithSelector(endSelector) : null;
      out.start_frame = fStart ? fStart.__idx : null;
      out.end_frame = fEnd ? fEnd.__idx : null;
      // 注意：不要先 click（日历控件弹出层会遮挡输入框，导致 actionability 等待直到超时）。
      // 直接用 fill（force 以跳过可操作性检查），必要时再触发键盘事件。
      if (fStart) {
        try {
          await fStart.fill(startSelector, value, { timeout: args.fillTimeoutMs || 8000 });
          out.start = value;
        } catch (e) {
          out.start_error = e.message.split('\n')[0];
        }
      } else {
        out.start_error = '未在任何 frame 中找到起始日期输入框';
      }
      if (args.advanceKey !== false) await page.keyboard.press('Tab').catch(() => {});
      if (fEnd) {
        try {
          await fEnd.fill(endSelector, value, { timeout: args.fillTimeoutMs || 8000 });
          out.end = value;
        } catch (e) {
          out.end_error = e.message.split('\n')[0];
        }
      } else {
        out.end_error = '未在任何 frame 中找到结束日期输入框';
      }
      if (args.confirmKey !== false) await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(600);
      // 关闭可能残留的日历浮层：浮层会遮挡「查询」按钮，导致后续 click 可操作性等待超时
      if (args.dismissPicker !== false) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
      }
      await page.waitForTimeout(args.settleMs || 1200);
      const perFrame = await evalAllFrames(probe.collectDateInputs, {});
      const first = perFrame.find((r) => !r.error && (r.result || []).length);
      out.readBack = first ? first.result : [];
      out.readBack_frame = first ? first.frameIndex : null;
      out.url = page.url();
      return out;
    },

    // ---- 任务会话（自动化占位）----
    async taskBegin(args) {
      if (state.activeTaskId && state.activeTaskId !== args.task_id) {
        throw new Error(`已有自动化任务 ${state.activeTaskId} 正在运行，拒绝并发（L2 会话令牌）`);
      }
      state.activeTaskId = args.task_id;
      state.automationOwner = args.owner || 'cli';
      writeHumanBusy('auto', { task_id: args.task_id, business_date: args.business_date || null });
      audit({ event: 'task_begin', task_id: args.task_id, business_date: args.business_date || null });
      return { task_id: state.activeTaskId };
    },

    async taskEnd(args) {
      if (state.activeTaskId && args && args.task_id && state.activeTaskId !== args.task_id) {
        throw new Error(`task_id 不匹配：当前 ${state.activeTaskId}`);
      }
      const prev = state.activeTaskId;
      state.activeTaskId = null;
      state.automationOwner = null;
      clearHumanBusy();
      audit({ event: 'task_end', task_id: prev });
      return { closed: prev };
    },

    // ---- 人工会话 ----
    async humanSessionStart(args) {
      writeHumanBusy('human', { note: args && args.note ? args.note : null });
      audit({ event: 'human_session_start' });
      return { owner: 'human', file: humanBusyFile, ttl: 900 };
    },

    async humanSessionStop() {
      clearHumanBusy();
      audit({ event: 'human_session_stop' });
      return { cleared: true };
    },

    async humanBusy() {
      return readHumanBusy();
    },

    async approvals() {
      return readApprovals();
    },

    async audit(args) {
      audit({ event: 'client_record', ...(args && args.record ? args.record : {}) });
      return { appended: true, audit_file: auditFile };
    },

    async stats() {
      return { ...state, audit_file: auditFile, socket: socketPath };
    },
  };

  // ---- socket 服务 ----
  try {
    fs.unlinkSync(socketPath);
  } catch (_) {}
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o750 });

  // 启动自清理：宿主机重启后，上一轮若异常退出可能残留占用标志
  //   - owner='auto' 必为陈旧（重启后不存在活动任务）→ 删除，避免阻塞后续自动化
  //   - owner='human' 保留（人工可能仍在 noVNC 中操作）
  try {
    const h = readHumanBusy();
    if (h.present && h.owner === 'auto') {
      clearHumanBusy();
      logger.warn('host.stale_auto_busy_cleared', { since: h.since, task_id: h.task_id || null });
    }
  } catch (_) {}

  const server = net.createServer((conn) => {
    const decode = createLineDecoder(async (msg) => {
      if (msg.__parseError) {
        conn.write(JSON.stringify({ id: null, ok: false, error: `非法请求：${msg.__parseError}` }) + '\n');
        return;
      }
      const { id, cmd, args } = msg;
      state.commandCount += 1;
      state.lastCommand = { cmd, at: new Date().toISOString() };
      const refused = guard(cmd, args || {});
      if (refused) {
        state.refusedCount += 1;
        audit({ event: 'command_refused', cmd, args: args || {}, reason: refused });
        logger.warn('host.command_refused', { cmd, reason: refused });
        conn.write(JSON.stringify({ id, ok: false, error: refused }) + '\n');
        return;
      }
      const fn = handlers[cmd];
      if (!fn) {
        conn.write(JSON.stringify({ id, ok: false, error: `未知命令：${cmd}` }) + '\n');
        return;
      }
      try {
        const result = await fn(args || {});
        audit({ event: 'command_ok', cmd, args: redactArgs(args || {}) });
        conn.write(JSON.stringify({ id, ok: true, result }) + '\n');
      } catch (e) {
        audit({ event: 'command_error', cmd, args: redactArgs(args || {}), error: e.message.split('\n')[0] });
        conn.write(JSON.stringify({ id, ok: false, error: e.message.split('\n')[0] }) + '\n');
      }
    });
    conn.on('data', decode);
    conn.on('error', () => {});
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(socketPath, () => {
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch (e) {
        logger.warn('host.socket_chmod_failed', { error: e.message });
      }
      logger.step('host.listening', {
        socket: socketPath,
        mode: '0600',
        runtime_dir: runtimeDir,
        tcp_listeners_added: 0,
        audit_file: auditFile,
        note: '仅 Unix Socket；不新增任何 TCP 监听',
      });
      resolve({
        socketPath,
        server,
        close: () =>
          new Promise((r) => {
            clearHumanBusy();
            server.close(() => r());
          }),
        stats: () => ({ ...state }),
      });
    });
  });
}

function redactArgs(a) {
  const out = { ...a };
  for (const k of Object.keys(out)) {
    if (/pass|token|cookie|secret|session/i.test(k)) out[k] = '[REDACTED]';
  }
  if (typeof out.url === 'string') out.url = out.url.slice(0, 200);
  return out;
}

module.exports = { startHost, AUTOMATION_COMMANDS };
