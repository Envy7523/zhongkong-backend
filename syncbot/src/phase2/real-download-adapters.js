'use strict';
/**
 * real-download.js 的**生产适配器装配**（依赖注入；只允许走既有 browser host / client / flow 受控命令）
 *
 * 硬约束（本文件在代码层强制，不依赖调用方自觉）：
 *  1. 不直接 HTTP 调美团接口；不绕过 host socket；不操作 Cookie / Profile；
 *  2. 动作白名单：precheck / probeDownloadList / navigateAndQuery / submitExport /
 *     readDownloadRows / retrieveFromDownloadList / downloadFile / screenshot / archive / validateFile / setApprovals / resetApprovals；
 *     禁止出现 import / validateImport / push / createTimer / delete（构造时即校验依赖，夹带即抛错）；
 *  3. 不可逆动作双重保护：
 *     - submitExport 前：TaskContext 合法 + 状态机 canSubmitExport + approvals.export_submit===true；
 *     - downloadFile 前：唯一目标行 + 状态精确「导出完成」+ 下载控件属于该行 + approvals.download_file===true；
 *     任一不满足 → 拒绝、写审计、**不下发任何 host 命令**。
 */
const fs = require('fs');
const path = require('path');
const TC = require('../task-context');
const P = require('../paths');
const SM = require('./real-flow-state');
const M = require('./download-list-match');
const FC = require('./filter-check');
const DR = require('./date-range');
const QF = require('./report-a-query-flow');

/** 允许下发的 host 命令（只读 + 受控动作；不含任何导入/推送/删除） */
const ALLOWED_HOST_COMMANDS = new Set([
  'health', 'ping', 'url', 'frames', 'goto', 'click', 'fill', 'press', 'mouse', 'screenshot',
  'probe', 'filterPanel', 'filterGroups', 'filterDetail', 'filterState', 'tableSummary', 'gridDetail',
  'gridAllRows', 'downloadRows', 'listOptions', 'picker', 'dateRow', 'overlays', 'inspect', 'dateInputs',
  'region', 'waitForSelector', 'findPanel', 'findTable', 'blockers', 'pageText', 'setDateRange',
  'taskBegin', 'taskEnd', 'audit', 'approvals', 'humanBusy', 'stats',
]);
/** 明确禁止的 host 命令（出现即阻断） */
const FORBIDDEN_HOST_COMMANDS = new Set(['import', 'importWorkbook', 'validateImport', 'push', 'createTimer', 'delete', 'deleteRow', 'remove']);

const ADAPTER_NAMES = [
  'precheck', 'probeDownloadList', 'navigateAndQuery', 'submitExport',
  'readDownloadRows',
  'waitForPassiveFile',
  'observeDownloadList', 'retrieveFromDownloadList', 'downloadFile', 'screenshot', 'archive', 'validateFile',
  'setApprovals', 'resetApprovals',
];

/**
 * 导出确认弹窗（2026-09-23「element not found」故障修复）：
 *   · **禁止**以"全页文本中出现「下载清单」"作为弹窗已出现的依据 —— 该文本可能存在于页面其它区域（假阳性）；
 *   · 只允许只读轮询「可见的确认按钮候选」或「弹窗容器 + 容器内可见确认按钮」两类证据；
 *   · 找到当前可见候选后**只点击一次** confirm；元素消失绝不二次点击；绝不重新点击 export；绝不点击 download。
 */
const EXPORT_CONFIRM_LABELS = ['确定', '确认', '我知道了', '知道了', '关闭'];
/** 导出确认失败语义（三码互斥；任一都必须 fail-closed：零下载 / 零导入 / 零推送，转人工） */
const CONFIRM_FAIL = {
  /** 超时仍未发现任何"可见确认按钮候选" */
  NOT_FOUND: 'export_dialog_confirm_not_found',
  /** 发现候选，但单次点击时元素已消失 / 不可用 */
  STALE: 'export_dialog_confirm_stale',
  /** host 或页面明确拒绝（命令已下发但被拒绝/未能执行，且无"元素消失"证据） */
  REJECTED: 'export_dialog_confirm_rejected',
};
const CONFIRM_STAGE = 'export_dialog_confirm';
/** 确认弹窗探测模式（v0.3.2） */
const CONFIRM_MODE = {
  /** 探测到可见确认按钮并已单次点击 */
  DIALOG_CONFIRMED: 'dialog_confirmed',
  /** 未探测到确认按钮且无异步通知证据；继续被动等待，超时再走清单 */
  ABSENT_DIRECT_DOWNLOAD: 'absent_direct_download',
  /** 已看见平台异步导出通知，但未找到可安全点击的按钮；不再误记为直下 */
  ASYNC_NOTICE_OBSERVED: 'async_notice_observed',
};
/**
 * 只读轮询参数（明确超时；轮询期间不点击任何元素）。
 * v0.3.2：探测窗口收窄为**短暂**探测（默认 6s）——未出现确认按钮时不再失败，而是转入被动下载等待。
 */
// 原 6s 探测不足以覆盖已观察到的异步流程；清单记录的 10–11s 更新耗时
// 不能证明弹窗何时出现，故延长只读观察窗口，同时仍以后续清单取件为准。
const DEFAULT_CONFIRM_WAIT = { timeoutMs: 45000, intervalMs: 1500, minAreaRatio: 0.02, maxText: 200 };
/** 被动下载：新增文件大小稳定所需的最小轮询次数（≥2 ⇒ 至少跨两次轮询） */
const DEFAULT_PASSIVE_STABLE_POLLS = 2;;
const CONFIRM_STALE_RE = /element not found|都不存在|not attached|detached|no node found|stale element|node is detached/i;
const CONFIRM_REJECT_RE = /refus|deny|denied|reject|未授权|未批准|不允许|禁止|forbidden|blocked|approval|not allowed|unauthor/i;
const REDACT_URL_RE = /https?:[/][/][^\s"')]+/g;
const REDACT_PATH_RE = /(^|[\s"'(=])([/](?:home|opt|etc|var|root|tmp|usr)[/][^\s"')]*)/g;

/** 脱敏（URL / 绝对路径 → 占位符；并截断长度） */
function redactText(v, max) {
  const s = String(v === undefined || v === null ? '' : v).replace(REDACT_URL_RE, '[url]').replace(REDACT_PATH_RE, '$1[path]');
  return s.slice(0, max || 120);
}

/**
 * host 错误 → 确认失败语义（保守归类）：
 *   · 元素消失 / 句柄失效 → stale；
 *   · 明确拒绝 / 未授权   → rejected；
 *   · 其余（超时、可操作性失败、宿主未知错误）→ 同样归入 rejected（宿主未能执行该命令），
 *     原始错误另存 host_error / detail.host_error，**绝不落入"可再试"分支**。
 */
function classifyConfirmClickError(message) {
  const m = String(message === undefined || message === null ? '' : message);
  if (CONFIRM_STALE_RE.test(m)) return CONFIRM_FAIL.STALE;
  if (CONFIRM_REJECT_RE.test(m)) return CONFIRM_FAIL.REJECTED;
  return CONFIRM_FAIL.REJECTED;
}

function assertNoForbiddenDeps(deps) {
  const bad = Object.keys(deps || {}).filter((k) => FORBIDDEN_HOST_COMMANDS.has(k));
  if (bad.length) throw new Error(`生产适配器禁止注入：${bad.join(', ')}（导入/推送/删除/定时器不在本流程范围内）`);
}

function recoverRecordedArchive({ ctx, incomingDir, priorDownloadedFile, priorDownloadedAt }) {
  const prior = path.resolve(String(priorDownloadedFile || ''));
  const eventMs = Date.parse(String(priorDownloadedAt || ''));
  if (path.dirname(prior) !== path.resolve(String(incomingDir || '')) || !Number.isFinite(eventMs))
    return { ok: false, reason: 'prior_download_evidence_invalid' };
  const archived = path.join(P.dayDownloads(ctx.platform, ctx.reportType, ctx.businessDate), path.basename(prior));
  let stat;
  try { stat = fs.lstatSync(archived); } catch { return { ok: false, reason: 'recorded_archive_missing' }; }
  if (!stat.isFile() || stat.size <= 0 || Math.abs(stat.mtimeMs - eventMs) > 60000)
    return { ok: false, reason: 'recorded_archive_mismatch' };
  return { ok: true, file: archived, name: path.basename(archived), size: stat.size,
    via: 'archived', elapsed_ms: 0 };
}

/**
 * @param {object} deps 依赖注入（生产用真实 client/flow；测试用 fake）
 *   client      —— 必须提供 call() 与 ./client 的方法（只走 host socket）
 *   flow        —— 必须提供 screenshot / dismissOverlays / selectSavedScheme / waitForContent / gotoAndAssert
 *   approvals   —— { read():object, write(obj):void } 读写 approvals.json
 *   rules       —— meituan-rules 配置对象
 *   selectors   —— { get(key) }
 *   validateFileFn / archiveFn / waitForDownloadFile —— 既有接口或可替换实现
 *   audit       —— (record)=>void 审计（拒答与关键动作都会写）
 *   now         —— 时间源
 */
function createProductionAdapters(deps) {
  assertNoForbiddenDeps(deps);
  const {
    client, flow, approvals, rules, selectors,
    validateFileFn, archiveFn, waitForDownloadFile,
    queryFlow = QF.navigateAndQueryReportA,
    audit = () => {}, now = () => new Date().toISOString(),
    reportTypeOf = (ctx) => ctx.reportType,
  } = deps || {};
  const need = { client, flow, approvals, rules, selectors };
  for (const [k, v] of Object.entries(need)) if (!v) throw new Error(`缺少依赖：${k}`);
  if (typeof queryFlow !== 'function') throw new Error('queryFlow 必须为已确认的报表查询流程');
  const reportName = (rules && rules.report_name) || '综合营业统计';
  // 签名守卫：selectors.get 的真实签名是 get(sel, key)（2 参）。若注入未绑定的模块对象，
  // key 位置会收到 undefined 并导致运行期 TypeError。此处构造期即失败，避免再次发生。
  if (typeof selectors.get !== 'function') throw new Error('selectors 必须提供 get 方法');
  if (selectors.get.length !== 1) {
    throw new Error(`selectors.get 必须注入「已绑定注册表」的形式 get(key)（1 参）；当前 arity=${selectors.get.length}，疑似注入了未绑定的 selectors 模块（真实签名为 get(sel, key)）`);
  }

  // 本次运行的实际声明门店数（来自查询步骤的回归值 declared_dynamic）。
  // ctx 由 TC.createContext 冻结（Object.freeze），无法写回 ctx ⇒ 用本适配器实例的闭包透传；
  // 适配器实例由 createDownloadFactory().run() 每次运行新建 ⇒ 闭包天然按运行隔离。
  let lastDeclaredDynamic = null;
  let lastQueryResult = null;
  let lastCReadiness = null;
  /**
   * 本次 export **之前**的下载目录快照（仅文件名）。
   * 被动下载只接受"本次 export 后新产生"的文件：与快照相比为新增（显式排除旧文件），
   * 从而绝不把上一轮失败遗留的 xlsx / .crdownload 误认成本轮产物。
   */
  let lastExportIncomingSnapshot = null;
  /** 只读列目录（失败即返回空数组，绝不抛错） */
  const listIncoming = () => {
    try { return fs.readdirSync(deps.incomingDir).slice(0, 500); } catch (_) { return []; }
  };

  const ctxOf = (a) => TC.assertContext(a && a.ctx);
  const S = (key) => (selectors && typeof selectors.get === 'function' ? selectors.get(key) : null);
  /** 期望门店数来源：规则显式给定优先，否则本次运行的实际声明数，否则 null（动态） */
  const expectStoresOf = () => {
    const fixed = (rules.report && rules.report.expected_store_count !== undefined && rules.report.expected_store_count !== null)
      ? rules.report.expected_store_count : null;
    if (fixed !== null) return fixed;
    return lastDeclaredDynamic !== null ? lastDeclaredDynamic : null;
  };
  const hostCmd = (cmd, args) => {
    if (FORBIDDEN_HOST_COMMANDS.has(cmd)) throw new Error(`禁止下发 host 命令：${cmd}`);
    if (!ALLOWED_HOST_COMMANDS.has(cmd)) throw new Error(`未在白名单内的 host 命令：${cmd}`);
    return client.call(cmd, args);
  };
  const refuse = (action, reason, ctx) => {
    const rec = { at: now(), event: 'adapter_refused', action, reason, task_id: ctx ? ctx.taskId : null, report_type: ctx ? ctx.reportType : null };
    try { audit(rec); } catch (_) {}
    return { ok: false, refused: true, reason };
  };

  /** 只读轮询用的延时（离线测试注入 sleep 以零等待） */
  const sleep = typeof deps.sleep === 'function' ? deps.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  /**
   * 确认弹窗轮询参数：默认值 ← 规则文件（可选 export_confirm_wait）← 依赖注入（测试用）。
   * 只允许**缩短/延长只读轮询**，不改变任何点击语义。
   */
  const confirmWait = Object.assign(
    {},
    DEFAULT_CONFIRM_WAIT,
    (rules && rules.export_confirm_wait && typeof rules.export_confirm_wait === 'object') ? rules.export_confirm_wait : {},
    (deps && deps.exportConfirm && typeof deps.exportConfirm === 'object') ? deps.exportConfirm : {},
  );

  /**
   * 只读候选采集（**不看全页文本**）。两类证据，按强度排序：
   *   ① overlay_control：弹窗容器（position fixed/absolute、面积达标、非纯遮罩）+ 容器内可见的确认按钮控件；
   *   ② probe_visible ：元素文本**精确相等**的确认按钮候选，且 visible===true && clickable===true。
   * 两者的 selector 均为宿主探针给出的 CSS 路径；不点击、不改页面。
   */
  async function collectVisibleConfirmCandidates() {
    const out = [];
    let noticeText = null;
    let ov = null;
    try { ov = await hostCmd('overlays', { minAreaRatio: confirmWait.minAreaRatio, maxText: confirmWait.maxText }); } catch (_) { ov = null; }
    const frames = (ov && Array.isArray(ov.frames)) ? ov.frames : [];
    for (const fr of frames) {
      const list = (fr && Array.isArray(fr.overlays)) ? fr.overlays : [];
      for (const o of list) {
        if (!o || o.is_mask_only === true) continue;
        const overlayText = String(o.text || '').trim();
        if (!noticeText && /本次导出数据共\s*\d+\s*条/.test(overlayText)
          && /下载清单/.test(overlayText) && /下载状态/.test(overlayText)) {
          noticeText = overlayText.slice(0, 200);
        }
        const ctrls = Array.isArray(o.controls) ? o.controls : [];
        for (const ctl of ctrls) {
          const label = String((ctl && ctl.text) || '').trim();
          const rank = EXPORT_CONFIRM_LABELS.indexOf(label);
          if (rank < 0 || !ctl || !ctl.selector) continue;
          out.push({ source: 'overlay_control', label, selector: ctl.selector, rank,
            area_ratio: (o.area_ratio === undefined ? null : o.area_ratio),
            frame_index: (fr && fr.frameIndex !== undefined) ? fr.frameIndex : null });
        }
      }
    }
    // overlay.controls 常给出内部 span；该 span 在真实弹窗中虽可见，frame.click
    // 却可能一直等不到可接收事件。总是并行读取 probe 的原生 button，优先点击它。
    let pr = null;
    try { pr = await hostCmd('probe', { texts: EXPORT_CONFIRM_LABELS, maxPerText: 4 }); } catch (_) { pr = null; }
    const merged = (pr && pr.merged) || {};
    for (let i = 0; i < EXPORT_CONFIRM_LABELS.length; i += 1) {
      const label = EXPORT_CONFIRM_LABELS[i];
      const bucket = merged[label];
      const exact = (bucket && Array.isArray(bucket.exact)) ? bucket.exact : [];
      for (const h of exact) {
        if (!h || h.visible !== true || h.clickable !== true || !h.selector) continue;
        out.push({ source: 'probe_visible', label, selector: h.selector, rank: i,
          tag: String(h.tag || '').toLowerCase(), frame_index: (h.frameIndex === undefined ? null : h.frameIndex) });
      }
    }
    out.sort((a, b) => {
      const priority = (x) => x.source === 'probe_visible' && x.tag === 'button' ? 0 : x.source === 'overlay_control' ? 1 : 2;
      return priority(a) - priority(b) || a.rank - b.rank;
    });
    out.noticeText = noticeText;
    return out;
  }

  return {
    /** 只读前置：host 可用 + 无登录/验证码阻断 */
    async precheck({ ctx }) {
      const c = ctxOf({ ctx });
      const h = await hostCmd('health', {});
      if (!h || !h.ok) return { ok: false, reason: 'host 不可用' };
      const b = await hostCmd('blockers', {});
      if (b && (b.likely_login_page || b.likely_human_verification)) {
        return { ok: false, reason: '检测到登录要求或人机验证，停止（不绕过）' };
      }
      return { ok: true, detail: `host ok, url=${h.url}`, report_type: reportTypeOf(c) };
    },

    /** 只读探测下载清单页结构（仅导航 + 读取，绝不点击） */
    async probeDownloadList({ ctx }) {
      const c = ctxOf({ ctx });
      const dl = (rules.download_list_locator && rules.download_list_locator.url_assertion) || {};
      const target = dl.full_url || rules.download_list_locator.url;
      const g = await flow.gotoAndAssert({ url: target, expectFullUrl: target, purpose: 'download_list', businessDate: c.businessDate, taskId: c.taskId, reportType: c.reportType, platform: c.platform });
      if (!g || !g.ok) return { ok: false, reason: `下载清单页 URL 断言失败：${JSON.stringify(g && g.url_assert && g.url_assert.mismatches)}` };
      const rows = await hostCmd('downloadRows', { maxRows: 60 });
      const best = rows && rows.best;
      if (!best || !best.row_count) return { ok: false, reason: '下载清单页未解析到任何行' };
      const hasAction = best.rows.some((r) => (r.control_texts || []).includes(M.DOWNLOAD_ACTION));
      const hasStatus = best.rows.some((r) => (r.cells || []).some((x) => String(x).includes('导出')));
      if (!hasAction && !hasStatus) return { ok: false, reason: '未识别到「状态」或「下载」要素' };
      return { ok: true, detail: `行数=${best.row_count}，表头=${best.header_hint || '-'}，含下载操作=${hasAction}` };
    },

    /** 报表页导航 + done 方案 + 日期 + 11 项筛选 + 点击查询 + 读取声明数/合计（共享流程，不含导出） */
    async navigateAndQuery({ ctx }) {
      const c = ctxOf({ ctx });
      const queryClient = reportName === '品项销售明细' || reportName === '门店收支统计' ? client
        : { call: (cmd, args, o) => client.call(cmd, args, o), mouse: (a, o) => client.call('mouse', a, o), picker: (a, o) => client.call('picker', a, o), press: (sel, key, o) => client.call('press', { selector: sel, key }, o) };
      const r = await queryFlow({
        client: queryClient, businessDate: c.businessDate,
        flow, hostCmd, rules, S, ctx: c, expectStores: expectStoresOf(),
      });
      lastQueryResult = r;
      lastDeclaredDynamic = reportName === '门店收支统计'
        ? (Number.isInteger(r?.declared_count) ? r.declared_count : null)
        : ((r && Number.isFinite(Number(r.declared_dynamic))) ? Number(r.declared_dynamic) : null);
      return r;
    },
    /**
     * 【不可逆】提交导出：
     *   ① 点击一次导出（不可逆；失败即 fail-closed，绝不重试）；
     *   ② **只读**轮询「可见的确认按钮候选」或「弹窗容器 + 容器内可见确认按钮」（明确超时）；
     *   ③ 找到当前可见候选后先做一次 inspect 复核，再**只点击一次** confirm；
     *   ④ 任何失败都返回可区分的 stage/reason，且 export_submitted_uncertain=true（已点击导出、后续状态不确定）。
     * 全程不读取/不依赖全页文本；不重新点击 export；不点击 download。
     */
    async submitExport({ ctx }) {
      const c = ctxOf({ ctx });
      const ap = await approvals.read();
      if (!ap || ap.export_submit !== true) return refuse('submitExport', 'approvals.export_submit 不为 true，拒绝点击导出', c);
      let sel = S('action.export_button');
      if (reportName === '品项销售明细') {
        if (typeof deps.exportReadiness !== 'function')
          return refuse('submitExport', '报表 B 缺少导出前只读复核，拒绝点击', c);
        let ready;
        try { ready = await deps.exportReadiness({ client, businessDate: c.businessDate }); }
        catch (_) { ready = null; }
        if (!ready || ready.ok !== true || ready.report_type !== c.reportType
          || ready.business_date !== c.businessDate || !ready.button
          || ready.button.label !== rules.export_button || !ready.button.selector)
          return refuse('submitExport', '报表 B 页面/筛选/结果/按钮读回不符，拒绝点击', c);
        // B 的页面选择器来自本次现场只读复核；A 注册表中的旧按钮路径不能代替 B。
        // readiness 已验证唯一原生 button、frame、可见/可点及 inspect 读回。
        sel = ready.button.selector;
      }
      if (reportName === '门店收支统计') {
        if (typeof deps.exportReadiness !== 'function')
          return refuse('submitExport', '报表 C 缺少导出前只读复核，拒绝点击', c);
        let ready;
        try { ready = await deps.exportReadiness({ client, businessDate: c.businessDate, queryResult: lastQueryResult }); }
        catch (_) { ready = null; }
        if (!ready || ready.ok !== true || ready.report_type !== c.reportType
          || ready.business_date !== c.businessDate || !ready.button
          || ready.button.label !== rules.export_button || !ready.button.selector)
          return refuse('submitExport', '报表 C 页面/筛选/结果/按钮读回不符，拒绝点击', c);
        lastCReadiness = ready;
        sel = ready.button.selector;
      }
      if (!sel) return refuse('submitExport', '未采集到导出按钮选择器', c);
      const note = (event, extra) => {
        try { audit(Object.assign({ at: now(), event, stage: CONFIRM_STAGE, task_id: c.taskId, report_type: c.reportType }, extra || {})); } catch (_) {}
      };

      // ① 导出点击：唯一一次（点击前先取"本轮之前"的下载目录快照，供被动下载做新增判定）
      lastExportIncomingSnapshot = listIncoming();
      const exportClickStartedAt = now();
      try {
        await hostCmd('click', { selector: sel, purpose: 'export', settleMs: 1500 });
      } catch (e) {
        const msg = redactText(e && e.message, 120);
        note('export_click_failed', { reason: 'export_click_failed', host_error: msg });
        // 命令已送达宿主后，超时/断线无法证明页面没有收到点击。按不可逆动作处理，
        // 持久化提交不确定并转人工；绝不能因客户端抛错而允许下次自动再点一次。
        return { ok: false, stage: 'export_click', reason: 'export_click_failed', export_clicked: true,
          export_submitted_uncertain: true, confirm_click_calls: 0, download_calls: 0, host_error: msg };
      }

      // ② 只读轮询（超时即 not_found；轮询期间绝不点击任何元素）
      const t0 = Date.now();
      let attempts = 0;
      let cand = null;
      let probeError = null;
      let noticeText = null;
      for (;;) {
        attempts += 1;
        try {
          const list = await collectVisibleConfirmCandidates();
          cand = list.length ? list[0] : null;
          if (list.noticeText) noticeText = list.noticeText;
        }
        catch (e) { cand = null; probeError = redactText(e && e.message, 80); }
        if (cand) break;
        if (Date.now() - t0 >= confirmWait.timeoutMs) break;
        await sleep(confirmWait.intervalMs);
      }
      const elapsedMs = Date.now() - t0;
      if (noticeText) note('export_async_notice_seen', { text: noticeText, attempts, elapsed_ms: elapsedMs });

      // 平台这条通知本身已明确说明导出进入异步下载清单。确认按钮仅负责关闭弹窗，
      // 在当前页面可能被同层遮罩挡住；不让非必要的关闭动作决定导出成败。
      // 后续仍必须走原有的清单行/申请人/时间/文件校验闸门，绝不再次点击导出。
      if (noticeText) {
        return { ok: true, stage: CONFIRM_STAGE,
          confirmation_mode: CONFIRM_MODE.ASYNC_NOTICE_OBSERVED,
          export_clicked: true, export_submitted_uncertain: false,
          confirm_click_calls: 0, download_calls: 0,
          confirm_poll_attempts: attempts, elapsed_ms: elapsedMs,
          incoming_snapshot_count: lastExportIncomingSnapshot ? lastExportIncomingSnapshot.length : 0,
          dialog_text: noticeText,
          record: { submitted_at: now(), export_click_started_at: exportClickStartedAt,
            confirm_attempts: attempts, confirm_source: null,
            confirmation_mode: CONFIRM_MODE.ASYNC_NOTICE_OBSERVED, notice_text: noticeText } };
      }

      if (!cand) {
        // 未看见异步通知且无安全按钮：不重试导出，继续被动等待/查清单。
        const mode = CONFIRM_MODE.ABSENT_DIRECT_DOWNLOAD;
        note('export_dialog_confirm_absent', { reason: CONFIRM_FAIL.NOT_FOUND, attempts, elapsed_ms: elapsedMs, probe_error: probeError, confirmation_mode: mode, notice_text: noticeText });
        return { ok: true, stage: CONFIRM_STAGE, confirmation_mode: mode,
          export_clicked: true, export_submitted_uncertain: false,
          confirm_click_calls: 0, download_calls: 0,
          confirm_poll_attempts: attempts, elapsed_ms: elapsedMs, probe_error: probeError,
          incoming_snapshot_count: lastExportIncomingSnapshot ? lastExportIncomingSnapshot.length : 0,
          dialog_text: noticeText || 'confirm_absent(absent_direct_download)',
          record: { submitted_at: now(), export_click_started_at: exportClickStartedAt,
            confirm_attempts: attempts, confirm_source: null, confirmation_mode: mode, notice_text: noticeText } };
      }

      // ③ 点击前一刻只读复核（同一选择器的当前可见性）
      let pre = null;
      try { pre = await hostCmd('inspect', { selector: cand.selector }); } catch (_) { pre = null; }
      const preText = String((pre && pre.text) || '').trim();
      if (!(pre && pre.exists === true && pre.visible === true && pre.enabled !== false)
        || (preText && preText !== cand.label)) {
        note('export_dialog_confirm_failed', { reason: CONFIRM_FAIL.STALE, attempts, source: cand.source, phase: 'pre_click' });
        return { ok: false, stage: CONFIRM_STAGE, reason: CONFIRM_FAIL.STALE,
          export_clicked: true, export_submitted_uncertain: true,
          confirm_click_calls: 0, download_calls: 0,
          confirm_poll_attempts: attempts, elapsed_ms: elapsedMs,
          detail: { source: cand.source, pre_click_visible: !!(pre && pre.visible), pre_click_label: preText },
          record: { submitted_at: now(), export_click_started_at: exportClickStartedAt,
            confirm_attempts: attempts, confirm_source: cand.source } };
      }

      // ④ confirm 点击：最多一次。forceRetry=false + domClickFallback=false ⇒ 宿主只做一次点击尝试，
      //    不按 Escape、不做 DOM 兜底、绝不在元素消失后重试。
      let confirmClickCalls = 0;
      try {
        confirmClickCalls += 1;
        await hostCmd('click', { selector: cand.selector, purpose: 'export_dialog_confirm', settleMs: 1200, forceRetry: false, domClickFallback: false });
      } catch (e) {
        const msg = redactText(e && e.message, 160);
        const reason = classifyConfirmClickError(msg);
        note('export_dialog_confirm_failed', { reason, attempts, source: cand.source, host_error: msg });
        return { ok: false, stage: CONFIRM_STAGE, reason,
          export_clicked: true, export_submitted_uncertain: true,
          confirm_click_calls: confirmClickCalls, download_calls: 0,
          confirm_poll_attempts: attempts, elapsed_ms: elapsedMs,
          host_error: msg,
          detail: { source: cand.source, label: cand.label, host_error_present: true },
          record: { submitted_at: now(), export_click_started_at: exportClickStartedAt,
            confirm_attempts: attempts, confirm_source: cand.source } };
      }

      note('export_dialog_confirm_clicked', { attempts, source: cand.source, elapsed_ms: elapsedMs, confirmation_mode: CONFIRM_MODE.DIALOG_CONFIRMED, notice_text: noticeText });
      return { ok: true, stage: CONFIRM_STAGE, confirmation_mode: CONFIRM_MODE.DIALOG_CONFIRMED,
        export_clicked: true, export_submitted_uncertain: false,
        incoming_snapshot_count: lastExportIncomingSnapshot ? lastExportIncomingSnapshot.length : 0,
        confirm_click_calls: confirmClickCalls, download_calls: 0,
        confirm_poll_attempts: attempts, elapsed_ms: elapsedMs,
        dialog_candidate_source: cand.source, dialog_candidate_label: cand.label,
        dialog_text: 'confirm_clicked(' + cand.source + ':' + cand.label + ')',
        record: { submitted_at: now(), export_click_started_at: exportClickStartedAt,
          confirm_attempts: attempts, confirm_source: cand.source, notice_text: noticeText } };
    },

    /** 只读：读取下载清单行 */
    async readDownloadRows({ ctx }) {
      ctxOf({ ctx });
      const rows = await hostCmd('downloadRows', { maxRows: 60 });
      return (rows && rows.best) || { rows: [] };
    },

    /** 【主成功路径】等待被动下载处理器落盘（点击导出后站点自行下发文件）；不点击任何按钮 */
    async waitForPassiveFile({ ctx, sinceMs, resumeArchived, priorDownloadedFile, priorDownloadedAt }) {
      const c = ctxOf({ ctx });
      if (resumeArchived === true) {
        // The previous attempt may have moved the downloaded file into the
        // date archive before validation failed. Recover only that exact
        // recorded basename, from the expected date directory and time window.
        return recoverRecordedArchive({ ctx: c, incomingDir: deps.incomingDir, priorDownloadedFile, priorDownloadedAt });
      }
      const t0 = Date.now();
      const got = await waitForDownloadFile({
        dir: deps.incomingDir,
        timeoutMs: deps.passiveTimeoutMs || 600000,
        pollMs: deps.passivePollMs || 3000,
        startedAt: sinceMs || t0 - 60000,
        // 只接受本次 export 后**新增**的文件（旧 xlsx / 旧 .crdownload / export 前已存在者一律排除）
        excludeNames: Array.isArray(lastExportIncomingSnapshot) ? lastExportIncomingSnapshot.slice() : null,
        // 文件大小必须稳定至少 stablePolls 次轮询（默认 2）
        stablePolls: Number(deps.passiveStablePolls) > 0 ? Number(deps.passiveStablePolls) : DEFAULT_PASSIVE_STABLE_POLLS,
      });
      return got && got.ok
        ? { ok: true, file: got.file, name: got.name, size: got.size, elapsed_ms: Date.now() - t0,
            stable_polls: (got.stable_polls === undefined ? null : got.stable_polls),
            excluded_names: (Array.isArray(lastExportIncomingSnapshot) ? lastExportIncomingSnapshot.length : 0) }
        : { ok: false, reason: (got && got.reason) || `等待 ${deps.passiveTimeoutMs || 600000}ms 未出现新报表文件`, elapsed_ms: Date.now() - t0 };
    },

    /** 【只读兜底】导出后观察下载清单（诊断用途）：**只读，不点击下载/删除** */
    async observeDownloadList({ ctx, taskStartedAt, applicant }) {
      const c = ctxOf({ ctx });
      const rows = await hostCmd('downloadRows', { maxRows: 60 });
      const best = rows && rows.best;
      if (!best) return { ok: false, read_only: true, detail: '清单页未解析到行（可能未导航至清单页）' };
      const sel = M.selectTargetRow(best, { businessDate: c.businessDate, taskStartedAt, applicant, reportName });
      return { ok: true, read_only: true, outcome: sel.outcome, detail: sel.reason, row_count: best.row_count, clicked: false };
    },

    /**
     * 【新增·异步受理路径】下载清单取件：导航清单 → 只读等待唯一行「导出完成」→ 点该行「下载」。
     * 与 downloadFile 的差别：自行完成导航+匹配（供被动下载超时后的兜底取件）。
     * 绝不点击导出、绝不再次提交申请；任一环节不满足即 ok:false（fail-closed，不猜）。
     * 说明：宿主客户端以 `const fn = adapters[name]` 形式取用，`this` 不绑定，故此处内联下载步骤而非调用 this.downloadFile。
     */
    async retrieveFromDownloadList({ ctx, taskStartedAt, applicant, markDownloadClickAttempt }) {
      const c = ctxOf({ ctx });
      if (typeof markDownloadClickAttempt !== 'function') return { ok: false, reason: 'download_click_marker_missing' };
      if (!applicant || !Number.isFinite(taskStartedAt)) return { ok: false, reason: 'download_list_match_criteria_missing' };
      const loc = rules.download_list_locator || {};
      const target = (loc.url_assertion && loc.url_assertion.full_url) || loc.url;
      if (!target) return { ok: false, reason: 'download_list_url_not_configured' };
      const g = await flow.gotoAndAssert({ url: target, expectFullUrl: target, purpose: 'download_list',
        businessDate: c.businessDate, taskId: c.taskId, reportType: c.reportType, platform: c.platform });
      if (!g || !g.ok) return { ok: false, reason: 'download_list_url_assert_failed' };
      // 被动下载已等 10 分钟；再给清单至多 15 分钟，覆盖规则中的 25 分钟完成窗口。
      // 「尚无行/导出中」只读等待；失败态、重复行或申请人缺失立即拒绝。
      const listWaitMs = Number(deps.downloadListWaitMs) > 0 ? Number(deps.downloadListWaitMs) : 15 * 60 * 1000;
      const listPollMs = Number(deps.downloadListPollMs) > 0 ? Number(deps.downloadListPollMs) : 30000;
      const deadline = Date.now() + listWaitMs;
      let rows = null;
      let best = null;
      let sel = null;
      for (;;) {
        rows = await hostCmd('downloadRows', { maxRows: 60 });
        best = (rows && rows.best) || { rows: [], row_count: 0 };
        sel = best.row_count === 0
          ? { outcome: 'wait', reason: '下载清单暂无记录' }
          : M.selectTargetRow(best, { businessDate: c.businessDate, taskStartedAt, applicant, reportName });
        if (sel.outcome === 'ready') break;
        if (sel.outcome === 'fail') return { ok: false, reason: 'download_list_failed:' + String(sel.reason).slice(0, 120), row_count: best.row_count };
        if (Date.now() >= deadline) return { ok: false, reason: 'download_list_wait_timeout:' + String(sel.reason).slice(0, 120), row_count: best.row_count };
        await sleep(listPollMs);
      }
      const ap = await approvals.read();
      if (!ap || ap.download_file !== true) return { ok: false, reason: 'approvals_download_file_not_true' };
      // 点击前再读一次：清单可能刷新或重排，只能使用最新目标行的控件。
      const freshRows = await hostCmd('downloadRows', { maxRows: 60 });
      const fresh = M.selectTargetRow(freshRows && freshRows.best ? freshRows.best : { rows: [] },
        { businessDate: c.businessDate, taskStartedAt, applicant, reportName });
      if (fresh.outcome !== 'ready') return { ok: false, reason: 'download_list_changed:' + String(fresh.reason).slice(0, 120) };
      if (!fresh.download_control || !fresh.download_control.selector
        || !M.rectContains(fresh.download_control.row_rect, fresh.download_control.rect)) {
        return { ok: false, reason: 'download_control_changed' };
      }
      const incomingBeforeClick = listIncoming();
      const downloadStartedAt = Date.now();
      // 持久化先于点击。若点击成功但文件等待超时，续跑只能观察文件，不能再次点击。
      await markDownloadClickAttempt();
      await hostCmd('click', { selector: fresh.download_control.selector, purpose: 'download', settleMs: 1500 });
      const got = await waitForDownloadFile({ dir: deps.incomingDir, timeoutMs: deps.downloadTimeoutMs || 120000,
        pollMs: 2000, startedAt: downloadStartedAt, excludeNames: incomingBeforeClick, stablePolls: 2 });
      if (!got || !got.ok) return { ok: false, reason: 'download_file_not_landed', download_click_attempted: true };
      return { ok: true, file: got.file, suggested_name: got.name, size: got.size,
        matched: fresh.target, row_count: freshRows.best.row_count };
    },

    /** 【关键】下载：唯一目标行 + 状态「导出完成」+ 控件属于该行 + approvals.download_file */
    async downloadFile({ ctx, control, target }) {
      const c = ctxOf({ ctx });
      const ap = await approvals.read();
      if (!ap || ap.download_file !== true) return refuse('downloadFile', 'approvals.download_file 不为 true，拒绝点击下载', c);
      if (!control || !control.selector || !control.rect) return refuse('downloadFile', '缺少目标行内的下载控件（含坐标）', c);
      if (!target || target.status !== M.READY_STATUS) return refuse('downloadFile', `目标行状态非「${M.READY_STATUS}」（实际 ${target && target.status}），拒绝下载`, c);
      const rows = await hostCmd('downloadRows', { maxRows: 60 });
      const fresh = M.selectTargetRow(rows && rows.best ? rows.best : { rows: [] }, { businessDate: c.businessDate, taskStartedAt: target.taskStartedAt || 0, applicant: target.applicant, reportName });
      if (fresh.outcome !== 'ready') return refuse('downloadFile', `下载前复核失败：${fresh.reason}`, c);
      const rowRect = fresh.download_control.row_rect || control.row_rect;
      if (!M.rectContains(rowRect, fresh.download_control.rect)) {
        return refuse('downloadFile', '下载控件不属于该目标行，拒绝点击', c);
      }
      await hostCmd('click', { selector: fresh.download_control.selector, purpose: 'download', settleMs: 1500 });
      const incoming = deps.incomingDir;
      const got = await waitForDownloadFile({ dir: incoming, timeoutMs: 120000, pollMs: 2000 });
      if (!got || !got.ok) return { ok: false, reason: `等待下载文件落盘失败：${(got && got.reason) || '未知'}` };
      return { ok: true, file: got.file, suggested_name: got.name, size: got.size };
    },

    async screenshot({ ctx, nn, step }) {
      const c = ctxOf({ ctx });
      const s = await flow.screenshot(c, nn, step);
      return { ok: true, path: s && s.file };
    },

    async archive({ ctx, file, suggestedName, recoveredArchive }) {
      const c = ctxOf({ ctx });
      if (recoveredArchive === true) {
        const dir = path.resolve(P.dayDownloads(c.platform, c.reportType, c.businessDate));
        const resolved = path.resolve(String(file || ''));
        if (path.dirname(resolved) !== dir) return { ok: false, reason: 'recovered_archive_path_mismatch' };
        let stat;
        try { stat = fs.lstatSync(resolved); } catch { return { ok: false, reason: 'recovered_archive_missing' }; }
        if (!stat.isFile() || stat.size <= 0) return { ok: false, reason: 'recovered_archive_invalid' };
        if (typeof archiveFn?.recoverArchived !== 'function') return { ok: false, reason: 'recorded_archive_recovery_unavailable' };
        const r = await archiveFn.recoverArchived({ srcFile: resolved });
        const p = r && (r.file || r.archived_path);
        return { ok: !!p, archived_path: p || null, archived_name: p ? path.basename(p) : null,
          size: (r && r.size) || null, sha256: (r && r.sha256) || null,
          overwrite_avoided: true, duplicate: true };
      }
      const r = await archiveFn({ srcFile: file, platform: c.platform, reportType: c.reportType, businessDate: c.businessDate, fileName: suggestedName, move: true });
      // 真实 archive() 返回 { file, dir, size, sha256, archived, duplicate, keptBoth? }
      const p = r && (r.file || r.archived_path);
      return { ok: !!p, archived_path: p || null, archived_name: p ? require('path').basename(p) : null, size: (r && r.size) || null, sha256: (r && r.sha256) || null, overwrite_avoided: !!(r && r.keptBoth), duplicate: !!(r && r.duplicate) };
    },

    async validateFile({ ctx, file }) {
      const c = ctxOf({ ctx });
      if (reportName === '门店收支统计' && !lastCReadiness) {
        // 已提交导出的恢复流程不再点击导出；只重新查询同日结果以重建文件对账基准。
        let query, ready;
        try {
          query = await queryFlow({ client, businessDate: c.businessDate });
          ready = query?.ok === true ? await deps.exportReadiness({ client, businessDate: c.businessDate, queryResult: query }) : null;
        } catch (_) { ready = null; }
        if (!ready?.ok) return { ok: false, errors: ['report_c_recovery_readiness_unavailable'] };
        lastQueryResult = query;
        lastCReadiness = ready;
      }
      const expected = expectStoresOf();
      const v = await validateFileFn(file, {
        businessDate: c.businessDate,
        // 期望门店数来源（口径冻结）：① 规则里**显式给定**的固定值优先（向后兼容）；
        // ② 否则用本次运行的实际声明数 declared_dynamic；③ 都没有 ⇒ null（动态模式，文件自报自洽）。
        expectedStores: expected,
        declaredDynamic: lastDeclaredDynamic,
        expectedStoreNames: deps.expectedStoreNames,
        // 在营门店清单只来自中控只读接口 coverage（由调用方注入，本适配器不取数、不直连项目库）。
        // 必须注入**原样应答对象**（ok/active_stores/truncated/active_stores_basis/active_stores_basis_confirmed），
        // 校验收口按硬规则判定可信度：不可信 ⇒ 校验失败 ⇒ WAITING_HUMAN（零导入、零推送）。
        activeStoresCoverage: (deps.activeStoresCoverage !== undefined && deps.activeStoresCoverage !== null)
          ? deps.activeStoresCoverage
          : (Array.isArray(deps.activeStores) ? deps.activeStores : null),
        storeMapping: deps.storeMapping || null,
        // B 专属：门店机构编码由中控同日只读覆盖接口提供；A 校验器忽略这两个额外字段。
        storeCodesCoverage: deps.storeCodesCoverage || null,
        requireStoreCodes: reportName === '品项销售明细',
        // 覆盖率 fail-closed：无法确认在营清单/映射覆盖率时判失败 ⇒ 下游转 WAITING_HUMAN（零导入、零推送）
        coverageRequired: deps.coverageRequired === undefined ? true : deps.coverageRequired === true,
      });
      if (reportName === '门店收支统计') {
        const reconciled = require('./report-c-export-readiness').reconcileExportFile(lastCReadiness, v);
        if (!reconciled.ok) return { ok: false, errors: [reconciled.reason],
          report_type: c.reportType, business_date: c.businessDate };
      }
      return {
        ok: !!(v && v.ok), checks: v && v.checks, errors: v && v.errors,
        amount_evidence: (v && v.amount_evidence) || null,
        store_count: v && v.store_count,
        report_type: v && v.report_type,
        business_date: v && v.business_date,
        source_rows: v && (v.source_rows ?? v.row_count),
        order_count: v && v.order_count,
        amounts: v && v.amounts,
        metadata_checks: v && v.metadata_checks,
        effective_file: v && v.effective_file,
        effective_size: v && v.effective_size,
        effective_sha256: v && v.effective_sha256,
        exception_evidence: v && v.exception_evidence,
        header_columns: v && v.header_columns,
        declared_dynamic: (v && v.declared_dynamic_used !== undefined) ? v.declared_dynamic_used : lastDeclaredDynamic,
        declared_dynamic_used: (v && v.declared_dynamic_used !== undefined) ? v.declared_dynamic_used : lastDeclaredDynamic,
        data_row_count: (v && v.data_row_count !== undefined) ? v.data_row_count : null,
        absent_stores: (v && v.absent_stores) || null,
        absent_status: (v && v.absent_status) || null,
      };
    },

    async setApprovals(flags) {
      const cur = (await approvals.read()) || {};
      await approvals.write(Object.assign({}, cur, flags, { updated_at: now().slice(0, 10), temporary_for_task: flags && flags.task_id }));
      return { ok: true };
    },
    async resetApprovals() {
      const cur = (await approvals.read()) || {};
      await approvals.write(Object.assign({}, cur, { export_submit: false, download_list: false, download_file: false, updated_at: now().slice(0, 10), temporary_for_task: null }));
      return { ok: true };
    },
  };
}

module.exports = {
  createProductionAdapters, ALLOWED_HOST_COMMANDS, FORBIDDEN_HOST_COMMANDS, ADAPTER_NAMES,
  // 导出确认弹窗（修复）对外常量与纯函数（供离线测试直接断言）
  EXPORT_CONFIRM_LABELS, CONFIRM_FAIL, CONFIRM_STAGE, CONFIRM_MODE, DEFAULT_CONFIRM_WAIT, DEFAULT_PASSIVE_STABLE_POLLS,
  classifyConfirmClickError, redactText, recoverRecordedArchive,
};
