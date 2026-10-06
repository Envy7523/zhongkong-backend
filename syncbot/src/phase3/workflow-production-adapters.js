'use strict';
/**
 * workflow **生产适配器工厂**（唯一显式装配点）—— **data-only**
 *
 * 架构收口：syncbot 只负责"美团报表 A 导出、校验、导入项目数据库"；
 * 上午 9 点日报推送由**项目现有机器人**（中控侧，持有企业微信 webhook）承担。
 * 因此本工厂**只装配 download / import 两段**：
 *   · 不装配、不调用、也不要求任何 push adapter（传入 `deps.push` → 明确拒绝 push_adapter_not_allowed）；
 *   · 不读取 webhook/token/corpid/corpsecret，不发送企业微信，不产生 PUSH_* 事件；
 *   · "缺少 sender"在本入口**不构成阻塞**（本入口根本没有 sender 概念）。
 * （phase3/push-run.js 与 push-client.js 仍在仓库保留其离线套件，但**无生产调用路径**。）
 *
 * 设计边界（逐条对应本轮要求）：
 *  1. workflow-run.js **只接受注入的适配器**：它自身不 require playwright / 数据库 / Cookie /
 *     webhook / fs 写文件；真实能力一律由本工厂在**显式调用**下装配出来。
 *  2. 装配过程**零副作用**：本模块只做"校验 + 调用注入的工厂函数 + 形状校验"，
 *     不启动浏览器、不发任何 HTTP、不读任何 webhook/token、不写任何文件。
 *  3. 默认 **fail-closed**：未显式 `enable:true`（CLI 由 env `SYNCBOT_WORKFLOW_PROD_ADAPTERS=1` 提供）
 *     时直接返回 `production_adapters_not_enabled`，调用方必须拒绝执行 → 零副作用。
 *  4. 两个适配器**各自**保留原有闸门（由被装配的模块自己实现，本工厂不绕过、不简化）：
 *       · download：phase2 真实下载编排（G1/G2、导出/下载/归档/文件校验、幂等与超时）
 *       · import  ：phase3 import-run（G3 覆盖闸门 + 本地终态闸门 + 超时 + 脱敏 + 单次 HTTP）
 *  5. 缺失任何一个适配器工厂 → 明确拒绝（adapter_factory_missing:<key>），绝不"少一个也照跑"。
 *  6. 传入 push 适配器工厂 → 明确拒绝（push_adapter_not_allowed）：生产链路里根本不该存在推送。
 */
const ALLOWED_REPORT_TYPES = ['cashier_composite'];
const ADAPTER_KEYS = ['download', 'import'];                    // data-only：不含 push
/** 推送归属（**只用于声明与审计展示**，本工厂绝不装配/调用它） */
const PUSH_OWNER = {
  owner: 'project_daily_report_bot',
  description: '项目现有机器人（中控侧）负责上午 9 点日报推送；syncbot 不持有企业微信凭据，也不参与发送',
  syncbot_wecom_credentials: 'none',
};
/** 形状要求：download 需要 run()，import 需要 runOnce() */
const ADAPTER_SHAPE = { download: 'run', import: 'runOnce' };

/** 适配器调用白名单（声明式；供 CLI/审计/评审查阅） */
const ADAPTER_CALL_WHITELIST = {
  download: {
    source: 'phase2/real-download-adapters.js :: createProductionAdapters()（报表A 真实下载适配器）',
    allowed: ['既有真实下载编排（浏览器动作全在该适配器内部）', '归档写入 downloads/<platform>/<report_type>/<date>/', 'validateReportAFile 文件校验'],
    forbidden_in_workflow: ['workflow 内直接操作浏览器', 'workflow 内直接写项目文件', 'workflow 内读取 Cookie/凭据'],
  },
  import: {
    source: 'phase3/import-run.js + phase3/import-client.js（正式导入 HTTP 客户端）',
    allowed: ['POST http://127.0.0.1:3456/api/business-analytics/import（仅本机回环、JWT 仅内存）', 'HMAC 审计上报 /api/internal/syncbot/events'],
    forbidden_in_workflow: ['workflow 内直连数据库', 'workflow 内复制文件', 'workflow 内自动重试导入'],
  },
};

/** workflow 源码中**禁止出现**的调用/字样（静态自检用） */
const FORBIDDEN_IN_WORKFLOW = [
  { name: 'browser', re: /require\(\s*['"](?:playwright|puppeteer|playwright-core)['"]\s*\)/ },
  { name: 'database', re: /require\(\s*['"][^'"]*(?:sqlite|better-sqlite3|sql\.js)[^'"]*['"]\s*\)/ },
  { name: 'project_file_write', re: /\bfs\.(?:writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|mkdir|mkdirSync|rename|renameSync|unlink|unlinkSync|rm|rmSync)\b/ },
  { name: 'webhook_direct', re: /(?:webhook|qyapi\.weixin\.qq\.com|sendMessage|sendTextMessage)/i },
  { name: 'credentials', re: /(?:\bcookie\b|\bpassword\b|\bjwt\b|Authorization\s*:)/i },
  { name: 'timer', re: /\b(?:setInterval|setTimeout|setImmediate|cron|schedule)\b/ },
  // data-only：生产 workflow 绝不允许引用推送通道模块
  { name: 'push_channel_module', re: /require\(\s*['"][^'"]*push-(?:run|client)[^'"]*['"]\s*\)/ },
];

/**
 * 去掉注释后再扫描（注释里"提到" cron/webhook 等词不算违规；只看**可执行代码**）。
 * 注意保留 \`http://\` 这类协议前缀（仅在 \`//\` 前一个字符不是 \`:\` 时才当注释）。
 */
function stripComments(src) {
  return String(src == null ? '' : src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** 静态自检：workflow **代码**里是否出现禁止的调用（返回违规列表，空数组 = 通过） */
function scanForbiddenCalls(sourceText) {
  const src = stripComments(sourceText);
  const hits = [];
  for (const { name, re } of FORBIDDEN_IN_WORKFLOW) {
    const m = src.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
    if (m && m.length) hits.push({ name, hits: m.slice(0, 3).map((x) => String(x).slice(0, 60)) });
  }
  return hits;
}

/**
 * 显式装配生产适配器。
 * @returns {{ok:true, adapters:object, whitelist:object}|{ok:false, reason:string}}
 */
function createWorkflowProductionAdapters(config = {}) {
  const { enable = false, confirmRealWorkflow = false, reportType = null, businessDate = null, deps = {} } = config || {};
  // ③ 未显式启用 → fail-closed（零副作用）
  if (enable !== true) return { ok: false, reason: 'production_adapters_not_enabled' };
  // ② 生产运行必须显式确认
  if (confirmRealWorkflow !== true) return { ok: false, reason: 'confirm_real_workflow_required' };
  if (!ALLOWED_REPORT_TYPES.includes(String(reportType))) return { ok: false, reason: 'report_type_not_allowed' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate))) return { ok: false, reason: 'business_date_invalid' };
  // ⑥ data-only：绝不装配推送适配器（显式拒绝，而不是"忽略它照跑"）
  if (deps && deps.push !== undefined) return { ok: false, reason: 'push_adapter_not_allowed' };
  // ⑤ 两个适配器工厂缺一不可
  for (const key of ADAPTER_KEYS) {
    if (typeof deps[key] !== 'function') return { ok: false, reason: 'adapter_factory_missing:' + key };
  }
  const adapters = {};
  for (const key of ADAPTER_KEYS) {
    let built = null;
    try { built = deps[key]({ reportType, businessDate, platform: config.platform || 'meituan' }); }
    catch (e) { return { ok: false, reason: 'adapter_factory_threw:' + key }; }
    const need = ADAPTER_SHAPE[key];
    if (!built || typeof built[need] !== 'function') return { ok: false, reason: 'adapter_shape_invalid:' + key };
    adapters[key] = built;
  }
  return { ok: true, adapters, whitelist: ADAPTER_CALL_WHITELIST, adapter_keys: ADAPTER_KEYS.slice(),
    data_only: true, push_owner: PUSH_OWNER };
}

module.exports = {
  createWorkflowProductionAdapters, scanForbiddenCalls, stripComments,
  ADAPTER_CALL_WHITELIST, ADAPTER_KEYS, ADAPTER_SHAPE, FORBIDDEN_IN_WORKFLOW, ALLOWED_REPORT_TYPES, PUSH_OWNER,
};
