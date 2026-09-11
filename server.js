/**
 * 中控后台 - 后端服务 v0.4.0
 * 负责：代理企业微信 API 调用、Webhook 消息推送、SQLite 数据管理
 */
const express = require('express');
const os = require('os');
const child_process = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { drawBarChart, drawLineChart, drawPieChart } = require('./lib/chart');
const { drawStoreDailyReport } = require('./lib/report');
const { parseDailyExcel, toReportData } = require('./lib/daily-data');
const db = require('./lib/db');
const collabService = require('./lib/collab-service');
const businessAnalytics = require('./lib/business-analytics');
const poultryAccounting = require('./lib/poultry-accounting');
const ledgerBackupImport = require('./lib/bookkeeping-import');
const wecomBot = require('./lib/wecom-bot');
const staffImport = require('./lib/staff-import');
const wecomStaffSync = require('./lib/wecom-staff-sync');
const { createBusinessAssistant } = require('./lib/wecom-business-assistant');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'etaigong-zhongkong-jwt-secret-2024';
const JWT_EXPIRES = '24h';

const app = express();
const PORT = process.env.PORT || 3456;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const AVATAR_DIR = path.join(__dirname, 'data', 'avatars');
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
const businessAssistant = createBusinessAssistant({ db, businessAnalytics, getAiConfig: getActiveAiConfig });
wecomBot.setTextMessageHandler(async (content) => {
  // 用户在会话里发送企微文档/智能表格链接：长连接机器人无法直接读取文档内容，给出导出文件导入指引
  const link = String(content || '').match(/https:\/\/doc\.weixin\.qq\.com\/\S+/);
  if (link) {
    return [
      '检测到这是企业微信文档／智能表格链接 📄',
      '我无法直接读取链接内容（长连接机器人不支持文档读取）。请用下面任一方式导入：',
      '',
      '【推荐】导出文件后发给我',
      '1）打开该智能表格 → 右上角「…」→ 导出 → Excel(.xlsx)',
      '2）在本会话点「+」→「文件」，把导出的 xlsx / csv 发给我',
      '我会自动识别「姓名 / 手机号 / 性别 / 年龄 / 所属门店 / 职位 / 角色 / 入职日期 / 状态 / 备注」，并回复“新增 X 人 / 更新 Y 人”。',
      '',
      '【进阶】如已为企业微信应用开通「智能表格」权限并配置企业可信IP，也可在网页端「人事专区 → 员工管理」点「↻ 从企微智能表格同步」一键同步。',
    ].join('\n');
  }
  return (await businessAssistant.answer(content)).reply;
});
// 企业微信里把员工表格（Excel/CSV）发给机器人 → 自动导入员工档案（人事专区 · 员工管理）
wecomBot.setFileMessageHandler(async ({ buffer, filename }) => {
  const lower = String(filename || '').toLowerCase();
  if (!/\.(xlsx|xls|csv)$/.test(lower)) {
    return `已收到「${filename || '文件'}」。目前只支持导入员工表格（.xlsx / .xls / .csv）：请把员工档案表发给我即可自动建档。`;
  }
  try {
    const result = staffImport.importStaffWorkbook(db, buffer, filename);
    console.log(`[staff import] ${filename}: 新增 ${result.created} / 更新 ${result.updated} / 跳过 ${result.skipped}`);
    return staffImport.formatImportReply(result, filename);
  } catch (e) {
    console.error('[staff import] 失败:', e.message);
    return `员工表导入失败：${e.message}`;
  }
});

// ===== 中间件 =====
app.use(express.json({ limit: '50mb' }));

// JWT 认证中间件（保护 /api/*，放行登录接口）
app.use((req, res, next) => {
  if (req.path === '/api/auth/login' || req.path === '/api/bot/status' || req.path === '/api/geo/bound') return next();
  if (!req.path.startsWith('/api/')) return next();
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }
  try {
    req.user = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
});

// 用户头像文件
app.use('/uploads/avatars', express.static(AVATAR_DIR, {
  maxAge: '7d',
  immutable: true,
  fallthrough: false,
}));

// 静态文件：优先使用 Vue 前端构建产物，回退到旧版静态文件
const vueDist = path.join(__dirname, 'frontend', 'dist');
if (fs.existsSync(vueDist)) {
  // index.html 绝不缓存：每次构建后的 JS 文件名都会变化，旧 HTML 若被缓存会引用不存在的旧资源并白屏。
  // 带哈希的 assets 则可长期缓存，避免每次打开重复下载大包。
  app.use(express.static(vueDist, {
    // 入口页交给下面的 SPA 回退输出，静态目录只提供带哈希的资源文件。
    index: false,
    maxAge: '1y',
    immutable: true,
  }));
  // SPA 回退：非 /api 路径返回 index.html
  app.get(/^(?!\/api).*/, (req, res, next) => {
    // 资源请求绝不能回退 index.html；否则旧版浏览器缓存请求不到旧哈希 JS 时，
    // 会收到 HTML 并导致动态路由模块加载失败、只剩页面外壳。
    if (req.path.startsWith('/api') || req.path.startsWith('/assets/') || req.path === '/favicon.svg') return next();
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    // 仅清理脚本/样式缓存，不影响登录令牌、已打开的标签或本地业务数据。
    res.setHeader('Clear-Site-Data', '"cache"');
    res.sendFile(path.join(vueDist, 'index.html'));
  });
} else {
  app.use(express.static(__dirname));
}

// ===== 工具函数 =====
/** 剥离 UTF-8 BOM 头 — 防止 Windows PowerShell / 记事本保存的 BOM 导致 JSON.parse 失败或首键乱码 */
function stripBOM(str) {
  if (typeof str !== 'string') return str;
  return str.codePointAt(0) === 0xFEFF ? str.slice(1) : str;
}
function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const clean = stripBOM(raw);
    return JSON.parse(clean);
  }
  catch { return { corpid: '', corpsecret: '', webhook: '', webhookName: '' }; }
}
function saveConfig(config) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8'); }
function getAiProfiles(cfg) {
  const profiles = Array.isArray(cfg.aiProfiles) ? cfg.aiProfiles.filter(item => item && item.id && item.baseUrl && item.model && item.apiKey) : [];
  if (!profiles.length && cfg.aiBaseUrl && cfg.aiModel && cfg.aiApiKey) {
    return [{ id: 'legacy-default', name: '原有模型配置', baseUrl: cfg.aiBaseUrl, model: cfg.aiModel, apiKey: cfg.aiApiKey, createdAt: '' }];
  }
  return profiles;
}
function getActiveAiConfig() {
  const cfg = loadConfig();
  const activeId = cfg.activeAiProfileId || '';
  if (activeId === 'local-simulation') return { aiEnabled: Boolean(cfg.aiEnabled), aiMode: 'local-simulation', aiProfileName: '本地模拟解读' };
  const profiles = getAiProfiles(cfg);
  const profile = profiles.find(item => item.id === activeId) || profiles[0];
  return profile ? { aiEnabled: Boolean(cfg.aiEnabled), aiMode: 'api', aiProfileName: profile.name, aiBaseUrl: profile.baseUrl, aiModel: profile.model, aiApiKey: profile.apiKey } : { aiEnabled: false };
}
function getPublicAiConfig(cfg) {
  const profiles = getAiProfiles(cfg);
  const activeId = cfg.activeAiProfileId || (profiles[0]?.id || '');
  const active = activeId === 'local-simulation' ? { id: activeId, name: '本地模拟解读', model: '本地模拟解读', local: true } : profiles.find(item => item.id === activeId);
  return {
    aiProfiles: profiles.map(item => ({ id: item.id, name: item.name || item.model, baseUrl: item.baseUrl, model: item.model, apiKeyMasked: item.apiKey ? item.apiKey.slice(0, 6) + '****' + item.apiKey.slice(-4) : '', createdAt: item.createdAt || '' })),
    activeAiProfileId: activeId,
    activeAiProfileName: active?.name || '',
    aiConfigured: Boolean(active || activeId === 'local-simulation'),
    aiEnabled: Boolean(cfg.aiEnabled),
  };
}
async function httpPost(url, body, headers = {}) {
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return resp.json();
}
async function httpGet(url, headers = {}) {
  const resp = await fetch(url, { headers });
  return resp.json();
}
let tokenCache = { token: null, expiresAt: 0 };
async function ensureToken() {
  const cfg = loadConfig();
  if (!cfg.corpid || !cfg.corpsecret) throw new Error('请先配置 corpid 和 corpsecret');
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const data = await httpGet(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${cfg.corpid}&corpsecret=${cfg.corpsecret}`);
  if (data.errcode !== 0) throw new Error(`获取 token 失败: [${data.errcode}] ${data.errmsg}`);
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 300) * 1000 };
  return tokenCache.token;
}

// ===== 门店主档（统一 SQLite stores 表；stores.json 已停用归档）=====
// 旧 JSON 版门店（text id store_2..store_18）全部已并入 DB stores（按门店名 1:1），
// 此处仅保留字段名兼容映射，供历史 camelCase 调用方（若有）写库时转换。
const LEGACY_STORE_FIELD_MAP = {
  storeName: 'store_name', businessType: 'store_type', legalPerson: 'legal_person',
  paymentType: 'payment_type', openingDate: 'opening_date', businessHours: 'business_hours',
  storeSize: 'store_size', status: 'status', province: 'province', city: 'city',
  district: 'district', address: 'address', phone: 'phone',
};
function dbStoresAll() { return db.queryAll('SELECT * FROM stores ORDER BY id'); }
function applyStoreUpdate(id, body) {
  const sets = [], params = [];
  Object.entries(LEGACY_STORE_FIELD_MAP).forEach(([camel, col]) => {
    if (body && body[camel] !== undefined && body[camel] !== null) { sets.push(`${col}=?`); params.push(String(body[camel]).trim()); }
  });
  if (!sets.length) return false;
  sets.push("updated_at=datetime('now','localtime')");
  params.push(id);
  const affected = db.run(`UPDATE stores SET ${sets.join(',')} WHERE id=?`, params);
  db.save();
  return affected > 0;
}

// ===== 配置 API =====
app.get('/api/config', (_req, res) => {
  const cfg = loadConfig();
  res.json({
    corpid: cfg.corpid || '',
    corpsecret_masked: cfg.corpsecret ? cfg.corpsecret.slice(0, 6) + '****' + cfg.corpsecret.slice(-4) : '',
    webhook: cfg.webhook || '',
    webhookName: cfg.webhookName || '',
    configured: !!(cfg.corpid && cfg.corpsecret),
    webhookConfigured: !!cfg.webhook,
    botIdMasked: cfg.botId ? cfg.botId.slice(0, 6) + '****' + cfg.botId.slice(-4) : '',
    botConfigured: !!(cfg.botId && cfg.botSecret),
    ...getPublicAiConfig(cfg),
  });
});
app.post('/api/config', async (req, res) => {
  const { corpid, corpsecret, webhook, webhookName, botId, botSecret, activeAiProfileId, aiEnabled } = req.body;
  const cfg = loadConfig();
  let botCredentialsChanged = false;
  if (corpid !== undefined) cfg.corpid = corpid.trim();
  if (corpsecret !== undefined) cfg.corpsecret = corpsecret.trim();
  if (webhook !== undefined) cfg.webhook = webhook.trim();
  if (webhookName !== undefined) cfg.webhookName = webhookName.trim();
  if (botId !== undefined && botId.trim()) {
    cfg.botId = botId.trim();
    botCredentialsChanged = true;
  }
  if (botSecret !== undefined && botSecret.trim()) {
    cfg.botSecret = botSecret.trim();
    botCredentialsChanged = true;
  }
  if (activeAiProfileId !== undefined) cfg.activeAiProfileId = String(activeAiProfileId || '').trim();
  if (aiEnabled !== undefined) cfg.aiEnabled = Boolean(aiEnabled);
  saveConfig(cfg);
  if (botCredentialsChanged) await wecomBot.restart();
  res.json({
    ok: true,
    configured: !!(cfg.corpid && cfg.corpsecret),
    webhookConfigured: !!cfg.webhook,
    botConfigured: !!(cfg.botId && cfg.botSecret),
    ...getPublicAiConfig(cfg),
    reconnecting: botCredentialsChanged,
  });
});

// AI 模型配置库：新增条目，不覆盖历史配置；密钥只写入后端 config.json。
app.post('/api/enterprise-settings/ai-profiles', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const baseUrl = String(req.body?.baseUrl || '').trim().replace(/\/$/, '');
    const model = String(req.body?.model || '').trim();
    const apiKey = String(req.body?.apiKey || '').trim();
    if (!name || !baseUrl || !model || !apiKey) return res.status(400).json({ error: '请完整填写配置名称、Base URL、模型名称和 API Key' });
    if (!/^https?:\/\//i.test(baseUrl)) return res.status(400).json({ error: 'Base URL 必须以 http:// 或 https:// 开头' });
    const cfg = loadConfig();
    const profiles = Array.isArray(cfg.aiProfiles) ? cfg.aiProfiles : [];
    const profile = { id: crypto.randomUUID(), name, baseUrl, model, apiKey, createdAt: new Date().toISOString() };
    profiles.push(profile);
    cfg.aiProfiles = profiles;
    if (!cfg.activeAiProfileId) cfg.activeAiProfileId = profile.id;
    saveConfig(cfg);
    res.status(201).json({ ok: true, profile: { id: profile.id, name: profile.name, baseUrl: profile.baseUrl, model: profile.model }, ...getPublicAiConfig(cfg) });
  } catch (e) { res.status(500).json({ error: `新增模型配置失败：${e.message}` }); }
});

// 编辑已有模型档案。API Key 留空时保留已保存的密钥，避免因修改模型名而覆盖密钥。
app.put('/api/enterprise-settings/ai-profiles/:profileId', (req, res) => {
  try {
    const profileId = String(req.params.profileId || '').trim();
    const cfg = loadConfig();
    const profiles = Array.isArray(cfg.aiProfiles) ? cfg.aiProfiles : [];
    const index = profiles.findIndex(item => item?.id === profileId);
    if (index < 0) return res.status(404).json({ error: '未找到该模型配置' });
    const current = profiles[index];
    const name = String(req.body?.name || current.name || '').trim();
    const baseUrl = String(req.body?.baseUrl || current.baseUrl || '').trim().replace(/\/$/, '');
    const model = String(req.body?.model || current.model || '').trim();
    const apiKey = String(req.body?.apiKey || '').trim() || current.apiKey;
    if (!name || !baseUrl || !model || !apiKey) return res.status(400).json({ error: '请完整填写配置名称、Base URL、模型名称和 API Key' });
    if (!/^https?:\/\//i.test(baseUrl)) return res.status(400).json({ error: 'Base URL 必须以 http:// 或 https:// 开头' });
    profiles[index] = { ...current, name, baseUrl, model, apiKey, updatedAt: new Date().toISOString() };
    cfg.aiProfiles = profiles;
    saveConfig(cfg);
    res.json({ ok: true, profile: { id: profileId, name, baseUrl, model }, ...getPublicAiConfig(cfg) });
  } catch (e) { res.status(500).json({ error: `更新模型配置失败：${e.message}` }); }
});

// ===== 企业设置 · 机器人设置 =====
// 主动重连仅重启机器人 WebSocket，不影响当前的经营数据服务。
app.post('/api/enterprise-settings/robot/reconnect', async (_req, res) => {
  const result = await wecomBot.restart();
  if (!result.ok) return res.status(400).json({ error: result.reason || '机器人凭据未配置' });
  res.json({ ok: true, message: '正在重新建立机器人长连接', status: wecomBot.getStatus() });
});

// 在后台先验证机器人将如何理解和回复问题，不会向企业微信发送消息。
app.post('/api/enterprise-settings/robot/preview-query', async (req, res) => {
  try {
    const content = String(req.body?.content || '').trim();
    if (!content) return res.status(400).json({ error: '请输入要测试的问题' });
    res.json({ ok: true, ...(await businessAssistant.answer(content)) });
  } catch (e) {
    res.status(500).json({ error: `经营问答测试失败：${e.message}` });
  }
});

// ===== 企业微信 Token =====
app.get('/api/wechat/token', async (_req, res) => {
  const cfg = loadConfig();
  if (!cfg.corpid || !cfg.corpsecret) return res.status(400).json({ error: '请先配置 corpid 和 corpsecret' });
  if (tokenCache.token && Date.now() < tokenCache.expiresAt)
    return res.json({ ok: true, access_token: tokenCache.token, cached: true, expires_in: Math.floor((tokenCache.expiresAt - Date.now()) / 1000) });
  try {
    const data = await httpGet(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${cfg.corpid}&corpsecret=${cfg.corpsecret}`);
    if (data.errcode === 0) {
      tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 300) * 1000 };
      res.json({ ok: true, access_token: data.access_token, cached: false, expires_in: data.expires_in });
    } else res.status(400).json({ error: `获取 token 失败: [${data.errcode}] ${data.errmsg}` });
  } catch (err) { res.status(500).json({ error: `网络错误: ${err.message}` }); }
});

// ===== Webhook 发送 =====
app.post('/api/wechat/send', async (req, res) => {
  const cfg = loadConfig();
  const webhookUrl = req.body.webhook || cfg.webhook;
  if (!webhookUrl) return res.status(400).json({ error: '请先配置 Webhook 地址' });
  const { msgtype = 'text', content, title, picurl, url, mentioned_list, mentioned_mobile_list } = req.body;
  const mentions = {};
  if (mentioned_list && mentioned_list.length) mentions.mentioned_list = mentioned_list;
  if (mentioned_mobile_list && mentioned_mobile_list.length) mentions.mentioned_mobile_list = mentioned_mobile_list;
  let payload;
  if (msgtype === 'text') payload = { msgtype: 'text', text: { content: content || '（空消息）', ...mentions } };
  else if (msgtype === 'markdown') payload = { msgtype: 'markdown', markdown: { content: content || '', ...(Object.keys(mentions).length ? mentions : {}) } };
  else if (msgtype === 'news') {
    if (!url) return res.status(400).json({ error: '图文消息缺少必填参数 url' });
    const article = { title: title || content || '消息', description: content || '', url };
    if (picurl) article.picurl = picurl;
    payload = { msgtype: 'news', news: { articles: [article] } };
  } else payload = { msgtype, ...req.body.extra };
  try {
    const data = await httpPost(webhookUrl, payload);
    if (data.errcode === 0) {
      db.run('INSERT INTO push_logs (push_type,target,content_preview,status) VALUES (?,?,?,?)', ['webhook', cfg.webhookName || '群聊', (content || '').slice(0, 100), 'success']);
      db.save();
      res.json({ ok: true, message: '消息发送成功' });
    } else {
      db.run('INSERT INTO push_logs (push_type,target,content_preview,status,error_msg) VALUES (?,?,?,?,?)', ['webhook', cfg.webhookName || '群聊', (content || '').slice(0, 100), 'failed', `[${data.errcode}] ${data.errmsg}`]);
      db.save();
      res.status(400).json({ error: `发送失败: [${data.errcode}] ${data.errmsg}` });
    }
  } catch (err) { res.status(500).json({ error: `网络错误: ${err.message}` }); }
});

// ===== 企业文档 =====
app.post('/api/wechat/doc', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.corpid || !cfg.corpsecret) return res.status(400).json({ error: '请先配置 corpid 和 corpsecret' });
  let token;
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) token = tokenCache.token;
  else {
    try {
      const tokenData = await httpGet(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${cfg.corpid}&corpsecret=${cfg.corpsecret}`);
      if (tokenData.errcode !== 0) return res.status(400).json({ error: `获取 token 失败: [${tokenData.errcode}] ${tokenData.errmsg}` });
      token = tokenData.access_token;
      tokenCache = { token, expiresAt: Date.now() + (tokenData.expires_in - 300) * 1000 };
    } catch (err) { return res.status(500).json({ error: `网络错误: ${err.message}` }); }
  }
  const { api, params = {} } = req.body;
  if (!api) return res.status(400).json({ error: '请指定 API 类型', available: [{ api: 'department_list', desc: '获取部门列表' }, { api: 'user_list', desc: '获取部门成员', params: ['department_id'] }, { api: 'user_info', desc: '获取成员信息', params: ['userid'] }, { api: 'custom', desc: '自定义 API 路径', params: ['path'] }] });
  try {
    let url, result;
    switch (api) {
      case 'department_list': url = `https://qyapi.weixin.qq.com/cgi-bin/department/list?access_token=${token}`; result = await httpGet(url); break;
      case 'user_list': url = `https://qyapi.weixin.qq.com/cgi-bin/user/list?access_token=${token}&department_id=${params.department_id || 1}&fetch_child=1`; result = await httpGet(url); break;
      case 'user_info': if (!params.userid) return res.status(400).json({ error: '缺少 userid 参数' }); url = `https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${token}&userid=${params.userid}`; result = await httpGet(url); break;
      case 'custom': if (!params.path) return res.status(400).json({ error: '缺少 path 参数' }); url = `https://qyapi.weixin.qq.com${params.path}?access_token=${token}`; for (const [k, v] of Object.entries(params)) { if (k !== 'path') url += `&${k}=${encodeURIComponent(v)}`; } result = await httpGet(url); break;
      default: return res.status(400).json({ error: `未知 API: ${api}` });
    }
    if (result.errcode !== undefined && result.errcode !== 0) return res.status(400).json({ error: `API 调用失败: [${result.errcode}] ${result.errmsg}`, detail: result });
    res.json({ ok: true, api, data: result });
  } catch (err) { res.status(500).json({ error: `网络错误: ${err.message}` }); }
});

// ===== 一键推送 =====
app.post('/api/wechat/pipeline', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.corpid || !cfg.corpsecret) return res.status(400).json({ error: '请先配置 corpid 和 corpsecret' });
  if (!cfg.webhook) return res.status(400).json({ error: '请先配置 Webhook 地址' });
  try {
    const token = await ensureToken();
    const { api, params = {}, msgtype = 'markdown' } = req.body;
    let data;
    switch (api) {
      case 'department_list': data = await httpGet(`https://qyapi.weixin.qq.com/cgi-bin/department/list?access_token=${token}`); break;
      case 'user_list': data = await httpGet(`https://qyapi.weixin.qq.com/cgi-bin/user/list?access_token=${token}&department_id=${params.department_id || 1}&fetch_child=1`); break;
      default: return res.status(400).json({ error: `不支持的 API: ${api}` });
    }
    const now = new Date().toLocaleString('zh-CN');
    let msg = '';
    if (api === 'department_list') {
      const depts = data.department || [];
      msg = `## 🏢 部门列表\n> 时间：${now}\n> 共 **${depts.length}** 个部门\n\n| ID | 名称 | 父部门 |\n|---|---|---|\n`;
      depts.forEach(d => msg += `| ${d.id} | ${d.name} | ${d.parentid} |\n`);
    } else if (api === 'user_list') {
      const users = data.userlist || [];
      msg = `## 👥 成员列表\n> 时间：${now}\n> 共 **${users.length}** 人\n\n| 姓名 | 部门 | 职位 |\n|---|---|---|\n`;
      users.forEach(u => msg += `| ${u.name} | ${u.department?.join(',') || '-'} | ${u.position || '-'} |\n`);
    }
    const sendResult = await httpPost(cfg.webhook, { msgtype: 'markdown', markdown: { content: msg } });
    db.run('INSERT INTO push_logs (push_type,target,content_preview,status) VALUES (?,?,?,?)', ['pipeline', cfg.webhookName || '群聊', `${api} 推送`, 'success']);
    db.save();
    res.json({ ok: true, message: '数据已推送到群' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== 智能表格 =====
app.post('/api/wechat/table/info', async (req, res) => {
  try { const token = await ensureToken(); const { doc_id } = req.body; if (!doc_id) return res.status(400).json({ error: '缺少 doc_id' }); const result = await httpPost(`https://qyapi.weixin.qq.com/cgi-bin/wedoc/get_doc_base_info?access_token=${token}`, { docid: doc_id }); if (result.errcode !== 0) return res.status(400).json({ error: `[${result.errcode}] ${result.errmsg}` }); res.json({ ok: true, data: result }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/wechat/table/sheets', async (req, res) => {
  try { const token = await ensureToken(); const { doc_id } = req.body; if (!doc_id) return res.status(400).json({ error: '缺少 doc_id' }); const result = await httpPost(`https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/get_sheet?access_token=${token}`, { docid: doc_id }); if (result.errcode !== 0) return res.status(400).json({ error: `[${result.errcode}] ${result.errmsg}` }); res.json({ ok: true, data: result }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/wechat/table/records', async (req, res) => {
  try { const token = await ensureToken(); const { doc_id, sheet_id, limit = 100, offset = 0, view_id, sort, filter_spec } = req.body; if (!doc_id || !sheet_id) return res.status(400).json({ error: '缺少 doc_id 或 sheet_id' }); const body = { docid: doc_id, sheet_id, limit: Math.min(limit, 500), offset }; if (view_id) body.view_id = view_id; if (sort) body.sort = sort; if (filter_spec) body.filter_spec = filter_spec; const result = await httpPost(`https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/get_records?access_token=${token}`, body); if (result.errcode !== 0) return res.status(400).json({ error: `[${result.errcode}] ${result.errmsg}` }); res.json({ ok: true, data: result }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/wechat/table/pipeline', async (req, res) => {
  const cfg = loadConfig(); if (!cfg.webhook) return res.status(400).json({ error: '请先配置 Webhook 地址' });
  try { const token = await ensureToken(); const { doc_id, sheet_id, limit = 100, offset = 0 } = req.body; if (!doc_id || !sheet_id) return res.status(400).json({ error: '缺少 doc_id 或 sheet_id' }); const rr = await httpPost(`https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/get_records?access_token=${token}`, { docid: doc_id, sheet_id, limit: Math.min(limit, 500), offset }); if (rr.errcode !== 0) return res.status(400).json({ error: `读取失败: [${rr.errcode}] ${rr.errmsg}` }); const records = rr.records || []; const now = new Date().toLocaleString('zh-CN'); let msg = `## 📊 表格数据\n> 更新时间：${now}\n> 共 **${records.length}** 条\n\n`; records.slice(0, 20).forEach((rec, i) => { const values = rec.values || {}; msg += `**${i + 1}.** `; msg += Object.entries(values).slice(0, 5).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.map(x => x.text || x).join(', ') : v}`).join(' | ') + '\n'; }); if (records.length > 20) msg += `\n> ... 还有 ${records.length - 20} 条`; const sr = await httpPost(cfg.webhook, { msgtype: 'markdown', markdown: { content: msg } }); if (sr.errcode !== 0) return res.status(400).json({ error: `发送失败: [${sr.errcode}] ${sr.errmsg}` }); res.json({ ok: true, message: '表格已推送', recordCount: records.length }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/bot/test — 测试 Bot 连接（使用 corpid/corpsecret 获取 token + 拉取部门列表）
// 注意：botId/botSecret 仅用于 WebSocket 长连接（wecom-bot.js），HTTP API 使用 corpid/corpsecret
app.post('/api/bot/test', async (req, res) => {
  try {
    const token = await ensureToken();
    const deptData = await httpGet(`https://qyapi.weixin.qq.com/cgi-bin/department/list?access_token=${token}`);
    if (deptData.errcode !== 0 && deptData.errcode !== undefined) {
      return res.status(400).json({
        ok: false,
        step: 'department_list',
        error: `[${deptData.errcode}] ${deptData.errmsg}`,
        detail: deptData,
      });
    }
    const departments = deptData.department || [];
    res.json({
      ok: true,
      message: `Bot 连接成功！获取到 ${departments.length} 个部门`,
      departments,
      token_preview: token.slice(0, 8) + '...',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/bot/query — 使用 corpid/corpsecret 凭证通用查询企业微信 API
app.post('/api/bot/query', async (req, res) => {
  try {
    const token = await ensureToken();
    const { api, params = {} } = req.body;
    if (!api) {
      return res.status(400).json({
        error: '请指定 API 类型',
        available: [
          { api: 'department_list', desc: '获取部门列表' },
          { api: 'user_list', desc: '获取部门成员', params: ['department_id'] },
          { api: 'user_info', desc: '获取成员信息', params: ['userid'] },
          { api: 'custom', desc: '自定义 API 路径', params: ['path'] },
        ],
      });
    }
    let url, result;
    switch (api) {
      case 'department_list':
        url = `https://qyapi.weixin.qq.com/cgi-bin/department/list?access_token=${token}`;
        result = await httpGet(url);
        break;
      case 'user_list':
        url = `https://qyapi.weixin.qq.com/cgi-bin/user/list?access_token=${token}&department_id=${params.department_id || 1}&fetch_child=1`;
        result = await httpGet(url);
        break;
      case 'user_info':
        if (!params.userid) return res.status(400).json({ error: '缺少 userid 参数' });
        url = `https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${token}&userid=${params.userid}`;
        result = await httpGet(url);
        break;
      case 'custom':
        if (!params.path) return res.status(400).json({ error: '缺少 path 参数' });
        url = `https://qyapi.weixin.qq.com${params.path}?access_token=${token}`;
        for (const [k, v] of Object.entries(params)) {
          if (k !== 'path') url += `&${k}=${encodeURIComponent(v)}`;
        }
        result = await httpGet(url);
        break;
      default:
        return res.status(400).json({ error: `未知 API: ${api}` });
    }
    if (result.errcode !== undefined && result.errcode !== 0) {
      return res.status(400).json({ error: `API 调用失败: [${result.errcode}] ${result.errmsg}`, detail: result });
    }
    res.json({ ok: true, api, data: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 日报图表推送 =====
const CHART_DRAWERS = { bar: drawBarChart, line: drawLineChart, pie: drawPieChart };
app.post('/api/wechat/report/send', async (req, res) => {
  const cfg = loadConfig(); if (!cfg.webhook) return res.status(400).json({ error: '请先配置 Webhook 地址' });
  const { title = '日报', chart_type, chart_config = {}, report_text, send_text_only = false } = req.body;
  const results = [];
  try {
    if (!send_text_only && chart_type && CHART_DRAWERS[chart_type]) {
      const { base64: imgBase64 } = CHART_DRAWERS[chart_type](chart_config);
      const md5 = crypto.createHash('md5').update(Buffer.from(imgBase64, 'base64')).digest('hex');
      const imgResp = await httpPost(cfg.webhook, { msgtype: 'image', image: { base64: imgBase64, md5 } });
      if (imgResp.errcode !== 0) return res.status(400).json({ error: `图表发送失败: [${imgResp.errcode}] ${imgResp.errmsg}`, results });
      results.push({ type: 'image', ok: true });
    }
    if (report_text) { const tr = await httpPost(cfg.webhook, { msgtype: 'markdown', markdown: { content: report_text } }); results.push({ type: 'markdown', ok: tr.errcode === 0 }); }
    db.run('INSERT INTO push_logs (push_type,target,content_preview,status) VALUES (?,?,?,?)', ['report', cfg.webhookName || '', title, 'success']);
    db.save();
    res.json({ ok: true, message: '日报推送完成', results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== 门店日报（多门店）=====
const dailyStoreState = { stores: [], generated: {}, pushed: {}, lastLoad: 0 };
function reloadDailyData() { const stores = parseDailyExcel(); dailyStoreState.stores = stores; dailyStoreState.generated = {}; dailyStoreState.pushed = {}; dailyStoreState.lastLoad = Date.now(); return stores; }
function ensureDailyDataLoaded() { if (dailyStoreState.stores.length === 0) reloadDailyData(); }
app.get('/api/report/daily/stores', (req, res) => {
  try { ensureDailyDataLoaded(); const stores = dailyStoreState.stores.map((s, i) => ({ ...s, generated: !!dailyStoreState.generated[s.id || ('store_' + i)], pushed: !!dailyStoreState.pushed[s.id || ('store_' + i)], generatedTime: dailyStoreState.generated[s.id || ('store_' + i)]?.time || null })); res.json({ ok: true, stores, count: stores.length, lastLoad: dailyStoreState.lastLoad }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/report/daily/reload', (req, res) => {
  try { const stores = reloadDailyData(); res.json({ ok: true, message: '日报数据已重新加载', stores, count: stores.length }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/report/daily/upload', (req, res) => {
  try { const { filename, data: b64 } = req.body; if (!b64) return res.status(400).json({ error: '缺少文件数据' }); const filePath = path.join(__dirname, filename || '日报.xlsx'); fs.writeFileSync(filePath, Buffer.from(b64, 'base64')); const stores = reloadDailyData(); res.json({ ok: true, message: `文件已上传并加载，共 ${stores.length} 家门店`, stores: stores.length }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/report/daily/generate/:id', (req, res) => {
  try { ensureDailyDataLoaded(); const store = dailyStoreState.stores.find(s => s.id === req.params.id); if (!store) return res.status(404).json({ error: '门店不存在' }); const { base64, buffer } = drawStoreDailyReport(toReportData(store)); const md5 = crypto.createHash('md5').update(buffer).digest('hex'); dailyStoreState.generated[req.params.id] = { base64, md5, time: Date.now() }; res.json({ ok: true, id: req.params.id, message: '日报已生成', imageSize: buffer.length }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/report/daily/generate-all', async (req, res) => {
  try { ensureDailyDataLoaded(); const results = []; for (const s of dailyStoreState.stores) { try { const { base64, buffer } = drawStoreDailyReport(toReportData(s)); const md5 = crypto.createHash('md5').update(buffer).digest('hex'); dailyStoreState.generated[s.id] = { base64, md5, time: Date.now() }; results.push({ id: s.id, storeName: s.storeName, ok: true }); } catch (e) { results.push({ id: s.id, storeName: s.storeName, ok: false, error: e.message }); } } res.json({ ok: true, message: `生成完成：${results.filter(r=>r.ok).length}/${results.length}`, results }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/report/daily/push/:id', async (req, res) => {
  const cfg = loadConfig(); if (!cfg.webhook) return res.status(400).json({ error: '请先配置 Webhook 地址' });
  try { ensureDailyDataLoaded(); const store = dailyStoreState.stores.find(s => s.id === req.params.id); if (!store) return res.status(404).json({ error: '门店不存在' }); let gen = dailyStoreState.generated[req.params.id]; if (!gen) { const { base64, buffer } = drawStoreDailyReport(toReportData(store)); gen = { base64, md5: crypto.createHash('md5').update(buffer).digest('hex') }; } const ir = await httpPost(cfg.webhook, { msgtype: 'image', image: { base64: gen.base64, md5: gen.md5 } }); if (ir.errcode !== 0) return res.status(400).json({ error: `推送失败: [${ir.errcode}] ${ir.errmsg}` }); dailyStoreState.pushed[req.params.id] = true; db.run('INSERT INTO push_logs (push_type,target,content_preview,status) VALUES (?,?,?,?)', ['daily', cfg.webhookName || '', `${store.storeName} 日报`, 'success']); db.save(); res.json({ ok: true, message: `${store.storeName} 日报已推送` }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/report/daily/push-all', async (req, res) => {
  const cfg = loadConfig(); if (!cfg.webhook) return res.status(400).json({ error: '请先配置 Webhook 地址' });
  try { ensureDailyDataLoaded(); const results = []; for (const s of dailyStoreState.stores) { try { let gen = dailyStoreState.generated[s.id]; if (!gen) { const { base64, buffer } = drawStoreDailyReport(toReportData(s)); gen = { base64, md5: crypto.createHash('md5').update(buffer).digest('hex') }; } const ir = await httpPost(cfg.webhook, { msgtype: 'image', image: { base64: gen.base64, md5: gen.md5 } }); if (ir.errcode === 0) { dailyStoreState.pushed[s.id] = true; results.push({ id: s.id, storeName: s.storeName, ok: true }); } else { results.push({ id: s.id, storeName: s.storeName, ok: false, error: `[${ir.errcode}] ${ir.errmsg}` }); } } catch (e) { results.push({ id: s.id, storeName: s.storeName, ok: false, error: e.message }); } } res.json({ ok: true, message: `推送完成：${results.filter(r=>r.ok).length}/${results.length}`, results }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 门店列表（统一读 DB 主档；兼容旧路径 /api/stores）=====
app.get('/api/stores', (req, res) => { try { res.json({ ok: true, stores: dbStoresAll() }); } catch (e) { res.status(500).json({ error: e.message }); } });

// 历史接口：从日报 Excel 初始化门店列表（旧 stores.json 时代用），现已停用
app.post('/api/stores/init', (_req, res) => { res.status(410).json({ error: '该接口已废弃：门店主档统一使用数据库 stores 表，请在「门店管理-基本信息」维护' }); });

// 地图统计（必须在 :id 之前，否则 province-stats 被 :id 捕获）
app.get('/api/stores/province-stats', (req, res) => {
  try {
    const rows = db.queryAll(`SELECT province as name, COUNT(*) as value FROM stores WHERE province IS NOT NULL AND province != '' GROUP BY province ORDER BY value DESC`);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/stores/city-stats', (req, res) => {
  try {
    const { province } = req.query;
    if (!province) return res.status(400).json({ error: '缺少 province 参数' });
    const rows = db.queryAll(`SELECT city as name, COUNT(*) as value FROM stores WHERE province=? AND city IS NOT NULL AND city != '' GROUP BY city ORDER BY value DESC`, [province]);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/stores/district-stats', (req, res) => {
  try {
    const { province, city, district } = req.query;
    if (!province || !city) return res.status(400).json({ error: '缺少 province 或 city 参数' });
    const rows = db.queryAll(`SELECT district as name, COUNT(*) as value FROM stores WHERE province=? AND city=? AND district IS NOT NULL AND district != '' GROUP BY district ORDER BY value DESC`, [province, city]);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 高德签名辅助：参数名排序后拼接，追加 secret 取 MD5
function amapSign(params, secret) {
  const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  return crypto.createHash('md5').update(sorted + secret).digest('hex');
}

// 阿里云 DataV 边界 GeoJSON 代理（后端转发，绕过浏览器 Referer 防盗链——云端域名访问会被 DataV 403）
app.get('/api/geo/bound', async (req, res) => {
  try {
    const path = String(req.query.path || '').trim();
    if (!path || !/^[\w-]+_full\.json$/.test(path)) return res.status(400).json({ error: '非法路径参数' });
    const data = await fetch(`https://geo.datav.aliyun.com/areas_v3/bound/${encodeURIComponent(path)}`).then(r => r.text());
    res.type('application/json').send(data);
  } catch (e) { res.status(500).json({ error: `边界数据获取失败：${e.message}` }); }
});

// 高德地理编码代理（后端转发，避免前端 JS key 无 Web API 权限）
app.get('/api/geocode', async (req, res) => {
  try {
    const { address, city } = req.query;
    if (!address) return res.status(400).json({ error: '缺少 address 参数' });
    const cfg = loadConfig();
    const key = cfg.amapWebKey;
    if (!key) return res.status(400).json({ error: '未配置 amapWebKey，请在 config.json 中填入高德 Web API key（需开通 Web服务 API 权限）' });
    const qs = { key, address };
    if (city) qs.city = city;
    // 如果配置了安全密钥则计算签名
    if (cfg.amapWebSecret) qs.sig = amapSign(qs, cfg.amapWebSecret);
    const qstr = Object.entries(qs).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const data = await httpGet(`https://restapi.amap.com/v3/geocode/geo?${qstr}`);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 高德周边搜索代理（商圈调查核心）
app.get('/api/amap/around', async (req, res) => {
  try {
    const { location, radius, types, keywords, offset, page } = req.query;
    if (!location) return res.status(400).json({ error: '缺少 location 参数（格式: lng,lat）' });
    const cfg = loadConfig();
    const key = cfg.amapWebKey;
    if (!key) return res.status(400).json({ error: '未配置 amapWebKey' });
    const qs = { key, location, radius: radius || '3000', offset: offset || '25', page: page || '1' };
    if (types) qs.types = types;
    if (keywords) qs.keywords = keywords;
    if (cfg.amapWebSecret) qs.sig = amapSign(qs, cfg.amapWebSecret);
    const qstr = Object.entries(qs).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const data = await httpGet(`https://restapi.amap.com/v3/place/around?${qstr}`);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 按区域获取门店经纬度（必须在 :id 之前）
app.get('/api/stores/locations', (req, res) => {
  try {
    const { province, city, district, store_type } = req.query;
    let where = 'WHERE lat IS NOT NULL AND lng IS NOT NULL AND lat != 0 AND lng != 0';
    const params = [];
    if (province)   { where += ' AND province=?';   params.push(province); }
    if (city)       { where += ' AND city=?';       params.push(city); }
    if (district)   { where += ' AND district=?';   params.push(district); }
    if (store_type) { where += ' AND store_type=?'; params.push(store_type); }
    const rows = db.queryAll(`SELECT id, store_name, lat, lng, status, store_type, remark, COALESCE(radius,3000) as radius FROM stores ${where}`, params);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stores/:id', (req, res) => { try { const s = db.queryOne('SELECT * FROM stores WHERE id=?', [req.params.id]); if (!s) return res.status(404).json({ error: '门店不存在' }); res.json({ ok: true, store: s }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/stores/:id', (req, res) => { try { if (!applyStoreUpdate(req.params.id, req.body)) return res.status(404).json({ error: '门店不存在' }); const s = db.queryOne('SELECT * FROM stores WHERE id=?', [req.params.id]); res.json({ ok: true, store: s }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put('/api/stores/:id', (req, res) => { try { if (!applyStoreUpdate(req.params.id, req.body)) return res.status(404).json({ error: '门店不存在' }); const s = db.queryOne('SELECT * FROM stores WHERE id=?', [req.params.id]); res.json({ ok: true, store: s }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/stores/:id', (req, res) => { try { const store = db.queryOne('SELECT * FROM stores WHERE id=?', [req.params.id]); if (!store) return res.status(404).json({ error: '门店不存在' }); db.run('DELETE FROM stores WHERE id=?', [req.params.id]); db.run('DELETE FROM store_region_members WHERE store_id=?', [req.params.id]); db.save(); res.json({ ok: true, message: '门店已删除', removed: store }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ==========================================
//  SQLite 版门店管理（新路由，路径 /api/db/stores）
// ==========================================

// ===== 自定义门店区域 =====
// 区域可多层嵌套，门店与区域为多对多关系，便于按省/市/片区等多个维度汇总。
function normalizeStoreIds(value) {
  const raw = Array.isArray(value) ? value : [];
  return [...new Set(raw.map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0))];
}

function listStoreRegions() {
  const regions = db.queryAll(`
    SELECT r.*, COUNT(m.store_id) AS direct_store_count
    FROM store_regions r
    LEFT JOIN store_region_members m ON m.region_id=r.id
    GROUP BY r.id
    ORDER BY r.sort_order ASC, r.id ASC
  `);
  const members = db.queryAll(`
    SELECT m.region_id, m.store_id, s.store_name
    FROM store_region_members m
    JOIN stores s ON s.id=m.store_id
    ORDER BY s.store_name
  `);
  const memberMap = new Map();
  members.forEach(member => {
    const list = memberMap.get(member.region_id) || [];
    list.push({ id: member.store_id, store_name: member.store_name });
    memberMap.set(member.region_id, list);
  });
  return regions.map(region => ({
    ...region,
    store_ids: (memberMap.get(region.id) || []).map(item => item.id),
    stores: memberMap.get(region.id) || [],
  }));
}

app.get('/api/store-regions', (req, res) => {
  try { res.json({ ok: true, regions: listStoreRegions() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/store-regions', (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const parentId = req.body.parent_id === '' || req.body.parent_id == null ? null : Number(req.body.parent_id);
    if (!name) return res.status(400).json({ error: '区域名称不能为空' });
    if (parentId && !db.queryOne('SELECT id FROM store_regions WHERE id=?', [parentId])) return res.status(400).json({ error: '上级区域不存在' });
    const id = db.insert('INSERT INTO store_regions (name,parent_id,sort_order) VALUES (?,?,?)', [name, parentId || null, Number(req.body.sort_order) || 0]);
    normalizeStoreIds(req.body.store_ids).forEach(storeId => db.run('INSERT OR IGNORE INTO store_region_members (region_id,store_id) VALUES (?,?)', [id, storeId]));
    db.save();
    res.json({ ok: true, id, regions: listStoreRegions() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/store-regions/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const current = db.queryOne('SELECT * FROM store_regions WHERE id=?', [id]);
    if (!current) return res.status(404).json({ error: '区域不存在' });
    const name = String(req.body.name ?? current.name).trim();
    const parentId = req.body.parent_id === '' || req.body.parent_id == null ? null : Number(req.body.parent_id);
    if (!name) return res.status(400).json({ error: '区域名称不能为空' });
    if (parentId === id) return res.status(400).json({ error: '区域不能选择自身作为上级' });
    if (parentId) {
      let cursor = db.queryOne('SELECT id,parent_id FROM store_regions WHERE id=?', [parentId]);
      if (!cursor) return res.status(400).json({ error: '上级区域不存在' });
      while (cursor) {
        if (Number(cursor.id) === id) return res.status(400).json({ error: '不能将下级区域设为上级区域' });
        cursor = cursor.parent_id ? db.queryOne('SELECT id,parent_id FROM store_regions WHERE id=?', [cursor.parent_id]) : null;
      }
    }
    db.run("UPDATE store_regions SET name=?, parent_id=?, sort_order=?, updated_at=datetime('now','localtime') WHERE id=?", [name, parentId || null, Number(req.body.sort_order) || 0, id]);
    if (Array.isArray(req.body.store_ids)) {
      db.run('DELETE FROM store_region_members WHERE region_id=?', [id]);
      normalizeStoreIds(req.body.store_ids).forEach(storeId => db.run('INSERT OR IGNORE INTO store_region_members (region_id,store_id) VALUES (?,?)', [id, storeId]));
    }
    db.save();
    res.json({ ok: true, regions: listStoreRegions() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/store-regions/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const region = db.queryOne('SELECT id FROM store_regions WHERE id=?', [id]);
    if (!region) return res.status(404).json({ error: '区域不存在' });
    db.run('DELETE FROM store_regions WHERE id=?', [id]);
    db.save();
    res.json({ ok: true, regions: listStoreRegions() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 单门店的区域归属只保留一个末级区域。这样在门店列表中调整分组时，
// 不需要先进入区域再批量勾选，也不会遗留旧分组的重复归属。
app.put('/api/stores/:id/region-membership', (req, res) => {
  try {
    const storeId = Number(req.params.id);
    const store = db.queryOne('SELECT id FROM stores WHERE id=?', [storeId]);
    if (!store) return res.status(404).json({ error: '门店不存在' });

    const rawRegionId = req.body.region_id;
    const regionId = rawRegionId === '' || rawRegionId == null ? null : Number(rawRegionId);
    if (regionId != null) {
      const region = db.queryOne('SELECT id FROM store_regions WHERE id=?', [regionId]);
      if (!region) return res.status(400).json({ error: '所选区域不存在' });
      const child = db.queryOne('SELECT id FROM store_regions WHERE parent_id=? LIMIT 1', [regionId]);
      if (child) return res.status(400).json({ error: '门店只能归属到末级区域' });
    }

    db.run('DELETE FROM store_region_members WHERE store_id=?', [storeId]);
    if (regionId != null) db.run('INSERT OR IGNORE INTO store_region_members (region_id,store_id) VALUES (?,?)', [regionId, storeId]);
    db.save();
    res.json({ ok: true, regions: listStoreRegions() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 统计卡片
app.get('/api/db/stores/stats', (req, res) => {
  try {
    const row = db.queryOne(`
      SELECT
        SUM(CASE WHEN status='正常营业' THEN 1 ELSE 0 END) as open_count,
        SUM(CASE WHEN status='筹建中' THEN 1 ELSE 0 END) as planning_count,
        SUM(CASE WHEN status IN ('已闭店','闭店','迁址') THEN 1 ELSE 0 END) as closed_count,
        SUM(CASE WHEN store_type='直营店' THEN 1 ELSE 0 END) as direct_count,
        SUM(CASE WHEN store_type='加盟店' THEN 1 ELSE 0 END) as franchise_count,
        SUM(CASE WHEN store_type='联营店' THEN 1 ELSE 0 END) as joint_count,
        COUNT(*) as total
      FROM stores
    `);
    res.json({ ok: true, stats: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 按市统计（旧版兼容）
app.get('/api/db/stores/by-city', (req, res) => {
  try {
    const { province } = req.query;
    if (!province) return res.status(400).json({ error: '缺少 province 参数' });
    const rows = db.queryAll(`
      SELECT city, COUNT(*) as cnt
      FROM stores
      WHERE province=? AND city IS NOT NULL AND city != ''
      GROUP BY city
      ORDER BY cnt DESC
    `, [province]);
    const map = {};
    rows.forEach(r => { map[r.city] = r.cnt; });
    res.json({ ok: true, data: map, total: rows.reduce((s, r) => s + r.cnt, 0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 按省份统计
app.get('/api/db/stores/by-province', (req, res) => {
  try {
    const rows = db.queryAll(`
      SELECT province, COUNT(*) as cnt
      FROM stores
      WHERE province IS NOT NULL AND province != ''
      GROUP BY province
      ORDER BY cnt DESC
    `);
    const map = {};
    rows.forEach(r => { map[r.province] = r.cnt; });
    res.json({ ok: true, data: map, total: rows.reduce((s, r) => s + r.cnt, 0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 列表（分页+搜索）
app.get('/api/db/stores', (req, res) => {
  try {
    const { keyword, status, store_type, legal_person, page, page_size } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (keyword) { where += ' AND store_name LIKE ?'; params.push('%' + keyword + '%'); }
    if (status) { where += ' AND status=?'; params.push(status); }
    if (store_type) { where += ' AND store_type=?'; params.push(store_type); }
    if (legal_person) { where += ' AND legal_person LIKE ?'; params.push('%' + legal_person + '%'); }
    const total = db.queryOne(`SELECT COUNT(*) as cnt FROM stores ${where}`, params).cnt;
    const psize = parseInt(page_size) || 10;
    const pg = parseInt(page) || 1;
    const offset = (pg - 1) * psize;
    params.push(psize, offset);
    const stores = db.queryAll(`SELECT * FROM stores ${where} ORDER BY id LIMIT ? OFFSET ?`, params);
    res.json({ ok: true, stores, total, page: pg, page_size: psize });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/db/stores/:id', (req, res) => {
  try { const store = db.queryOne('SELECT * FROM stores WHERE id=?', [req.params.id]); if (!store) return res.status(404).json({ error: '门店不存在' }); const platforms = db.queryAll('SELECT * FROM store_platforms WHERE store_id=?', [req.params.id]); const fixedCosts = db.queryAll('SELECT * FROM store_fixed_costs WHERE store_id=?', [req.params.id]); const employees = db.queryAll('SELECT * FROM employees WHERE store_id=?', [req.params.id]); res.json({ ok: true, store, platforms, fixedCosts, employees }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/db/stores', (req, res) => {
  try { const { store_name, status, store_type, legal_person, payment_type, region, province, city, district, address, phone, business_hours, opening_date, table_2person, table_4person, store_size, lat, lng } = req.body; if (!store_name) return res.status(400).json({ error: '门店名称不能为空' }); const id = db.insert('INSERT INTO stores (store_name,status,store_type,legal_person,payment_type,region,province,city,district,address,phone,business_hours,opening_date,table_2person,table_4person,store_size,lat,lng) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [store_name, status||'正常营业', store_type||'直营店', legal_person||'', payment_type||'法人收款', region||'', province||'', city||'', district||'', address||'', phone||'', business_hours||'', opening_date||null, table_2person||0, table_4person||0, store_size||'', lat||null, lng||null]); db.save(); res.json({ ok: true, id }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/db/stores/:id', (req, res) => {
  try { const allowedFields = ['store_name','status','store_type','legal_person','payment_type','region','province','city','district','address','phone','business_hours','opening_date','table_2person','table_4person','store_size','lat','lng','remark','radius']; const sets = [], params = []; allowedFields.forEach(f => { if (req.body[f] !== undefined) { sets.push(`${f}=?`); params.push(req.body[f]); } }); if (!sets.length) return res.status(400).json({ error: '没有要更新的字段' }); sets.push("updated_at=datetime('now','localtime')"); params.push(req.params.id); const affected = db.run(`UPDATE stores SET ${sets.join(',')} WHERE id=?`, params); db.save(); if (!affected) return res.status(404).json({ error: '门店不存在' }); res.json({ ok: true, message: '已更新' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/db/stores/:id', (req, res) => {
  try { const affected = db.run('DELETE FROM stores WHERE id=?', [req.params.id]); db.save(); if (!affected) return res.status(404).json({ error: '门店不存在' }); res.json({ ok: true, message: '已删除' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 第三方平台 =====
const PLATFORM_NAMES = ['美团外卖', '淘宝闪购', '京东外卖', '美团团购', '抖音团购'];
const PLATFORM_STATUS = ['已上线', '未上线', '筹备中'];
function normalizePlatformRecord(value) {
  const platform_name = String(value?.platform_name || '').trim();
  const setup_status = String(value?.setup_status || '未上线').trim();
  const online_date = String(value?.online_date || '').trim();
  const platform_id = String(value?.platform_id || '').trim();
  if (!PLATFORM_NAMES.includes(platform_name)) throw new Error('不支持的平台名称');
  if (!PLATFORM_STATUS.includes(setup_status)) throw new Error('建号状态不正确');
  if (online_date && !/^\d{4}-\d{2}-\d{2}$/.test(online_date)) throw new Error('上线时间格式应为 YYYY-MM-DD');
  if (setup_status === '已上线' && !platform_id) throw new Error(`${platform_name} 已上线时必须填写平台 ID`);
  return { platform_name, setup_status, online_date: online_date || null, platform_id };
}
function upsertStorePlatform(storeId, storeName, raw) {
  const item = normalizePlatformRecord(raw);
  const rows = db.queryAll('SELECT id FROM store_platforms WHERE store_id=? AND platform_name=? ORDER BY id DESC', [storeId, item.platform_name]);
  if (rows.length) {
    db.run("UPDATE store_platforms SET platform_id=?, setup_status=?, online_date=?, updated_at=datetime('now','localtime') WHERE id=?", [item.platform_id, item.setup_status, item.online_date, rows[0].id]);
    rows.slice(1).forEach(row => db.run('DELETE FROM store_platforms WHERE id=?', [row.id]));
    return rows[0].id;
  }
  return db.insert('INSERT INTO store_platforms (store_id,platform_name,platform_id,setup_status,online_date) VALUES (?,?,?,?,?)', [storeId, item.platform_name, item.platform_id, item.setup_status, item.online_date]);
}
app.get('/api/store-platforms', (req, res) => { try { const rows = db.queryAll('SELECT p.*, s.store_name FROM store_platforms p JOIN stores s ON s.id=p.store_id ORDER BY s.store_name, p.id'); res.json({ ok: true, platforms: rows }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/store-platforms/resolve', (req, res) => { try { const platform_name = String(req.query.platform_name || '').trim(); const platform_id = String(req.query.platform_id || '').trim(); if (!PLATFORM_NAMES.includes(platform_name) || !platform_id) return res.status(400).json({ error: '请提供平台名称和平台 ID' }); const row = db.queryOne('SELECT p.*, s.store_name, s.status AS store_status FROM store_platforms p JOIN stores s ON s.id=p.store_id WHERE p.platform_name=? AND p.platform_id=?', [platform_name, platform_id]); if (!row) return res.status(404).json({ error: '未找到对应门店的平台绑定' }); res.json({ ok: true, store: row }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/stores/:id/platforms', (req, res) => { try { res.json({ ok: true, platforms: db.queryAll('SELECT * FROM store_platforms WHERE store_id=? ORDER BY id', [req.params.id]) }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/stores/:id/platforms', (req, res) => { try { const store = db.queryOne('SELECT store_name FROM stores WHERE id=?', [req.params.id]); if (!store) return res.status(404).json({ error: '门店不存在' }); const id = upsertStorePlatform(Number(req.params.id), store.store_name, req.body); db.save(); res.json({ ok: true, id }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.put('/api/stores/:id/platforms', (req, res) => { try { const store = db.queryOne('SELECT store_name FROM stores WHERE id=?', [req.params.id]); if (!store) return res.status(404).json({ error: '门店不存在' }); const platforms = Array.isArray(req.body.platforms) ? req.body.platforms : []; if (!platforms.length) return res.status(400).json({ error: '请至少提交一个平台' }); platforms.forEach(item => upsertStorePlatform(Number(req.params.id), store.store_name, item)); db.save(); res.json({ ok: true, platforms: db.queryAll('SELECT * FROM store_platforms WHERE store_id=? ORDER BY id', [req.params.id]) }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.put('/api/platforms/:id', (req, res) => { try { const current = db.queryOne('SELECT p.*, s.store_name FROM store_platforms p JOIN stores s ON s.id=p.store_id WHERE p.id=?', [req.params.id]); if (!current) return res.status(404).json({ error: '平台记录不存在' }); upsertStorePlatform(current.store_id, current.store_name, { ...current, ...req.body }); db.save(); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.delete('/api/platforms/:id', (req, res) => { try { db.run('DELETE FROM store_platforms WHERE id=?', [req.params.id]); db.save(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ===== 员工 =====
function ageFromIdCard(value) {
  const idCard = String(value || '').trim().toUpperCase();
  const match = idCard.match(/^\d{6}(\d{4})(\d{2})(\d{2})\d{3}[0-9X]$/);
  if (!match) return null;
  const birth = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (birth.getFullYear() !== Number(match[1]) || birth.getMonth() !== Number(match[2]) - 1 || birth.getDate() !== Number(match[3])) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  if (today.getMonth() < birth.getMonth() || (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())) age -= 1;
  return age >= 0 && age <= 130 ? age : null;
}

function resolveStaffStoreId(storeName) {
  const name = String(storeName || '').trim();
  if (!name) return null;
  return db.queryOne('SELECT id FROM stores WHERE store_name=? LIMIT 1', [name])?.id || null;
}

app.get('/api/stores/:id/employees', (req, res) => {
  try { const { status } = req.query; let sql = 'SELECT * FROM employees WHERE store_id=?'; const params = [req.params.id]; if (status) { sql += ' AND status=?'; params.push(status); } sql += ' ORDER BY id'; res.json({ ok: true, employees: db.queryAll(sql, params) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/stores/:id/employees', (req, res) => { try { const { name, status, hire_date, hire_type, position, salary } = req.body; if (!name) return res.status(400).json({ error: '员工姓名不能为空' }); const id = db.insert('INSERT INTO employees (store_id,name,status,hire_date,hire_type,position,salary) VALUES (?,?,?,?,?,?,?)', [req.params.id, name, status||'在职', hire_date||null, hire_type||'全职', position||'', salary||0]); db.save(); res.json({ ok: true, id }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put('/api/employees/:id', (req, res) => { try { const fields = ['store_id','name','status','hire_date','hire_type','position','salary','leave_date']; const sets = [], params = []; fields.forEach(f => { if (req.body[f] !== undefined) { sets.push(`${f}=?`); params.push(req.body[f]); } }); if (!sets.length) return res.status(400).json({ error: '没有要更新的字段' }); params.push(req.params.id); db.run(`UPDATE employees SET ${sets.join(',')} WHERE id=?`, params); db.save(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/employees/:id', (req, res) => { try { db.run('DELETE FROM employees WHERE id=?', [req.params.id]); db.save(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ===== 员工管理（店长 + 店员）=====
// GET /api/staff — 列表（分页、搜索、角色筛选）
app.get('/api/staff', (req, res) => {
  try {
    const { page = 1, page_size = 10, keyword, status, store_name, position, role } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(page_size) || 10));
    const offset = (pageNum - 1) * pageSize;

    let where = [];
    let params = [];

    if (role) { where.push('e.role=?'); params.push(role); }
    if (keyword) { where.push('(e.name LIKE ? OR e.phone LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    if (status) { where.push('e.status=?'); params.push(status); }
    if (store_name) { where.push('e.store_name LIKE ?'); params.push(`%${store_name}%`); }
    if (position) { where.push('e.position=?'); params.push(position); }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const total = db.queryOne(`SELECT COUNT(*) as cnt FROM employees e ${whereClause}`, params).cnt;
    const resolvedStoreId = "COALESCE(NULLIF(e.store_id, 0), (SELECT id FROM stores sx WHERE sx.store_name=e.store_name LIMIT 1))";
    const list = db.queryAll(
      `SELECT e.*, ${resolvedStoreId} AS resolved_store_id, COALESCE(manager.name, '') AS manager_name
       FROM employees e
       LEFT JOIN store_manager_assignments assignment ON assignment.store_id=${resolvedStoreId}
       LEFT JOIN employees manager ON manager.id=assignment.employee_id
       ${whereClause} ORDER BY e.id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    res.json({ ok: true, list, total, page: pageNum, page_size: pageSize });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 门店管理：店长归属只在这里维护，员工列表读取该绑定结果。
app.get('/api/staff/store-managers', (req, res) => {
  try {
    const stores = db.queryAll(`SELECT s.id, s.store_name, s.status, assignment.employee_id AS manager_id,
      COALESCE(manager.name, '') AS manager_name, COALESCE(manager.phone, '') AS manager_phone,
      COALESCE(manager.position, '') AS manager_position
      FROM stores s
      LEFT JOIN store_manager_assignments assignment ON assignment.store_id=s.id
      LEFT JOIN employees manager ON manager.id=assignment.employee_id
      ORDER BY s.id`);
    const candidates = db.queryAll(`SELECT id, name, phone, position, store_name FROM employees
      WHERE status='在职' ORDER BY name COLLATE NOCASE, id`);
    res.json({ ok: true, stores, candidates });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/staff/store-managers/:storeId', (req, res) => {
  try {
    const storeId = Number(req.params.storeId);
    const managerId = Number(req.body?.employee_id);
    if (!db.queryOne('SELECT id FROM stores WHERE id=?', [storeId])) return res.status(404).json({ error: '门店不存在' });
    if (!managerId) {
      db.run('DELETE FROM store_manager_assignments WHERE store_id=?', [storeId]);
      db.save();
      return res.json({ ok: true, manager: null });
    }
    const employee = db.queryOne("SELECT id,name,phone,position FROM employees WHERE id=? AND status='在职'", [managerId]);
    if (!employee) return res.status(400).json({ error: '请选择在职员工担任店长' });
    db.run(`INSERT INTO store_manager_assignments (store_id,employee_id,updated_at) VALUES (?,?,datetime('now','localtime'))
      ON CONFLICT(store_id) DO UPDATE SET employee_id=excluded.employee_id,updated_at=excluded.updated_at`, [storeId, managerId]);
    db.save();
    res.json({ ok: true, manager: employee });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/staff/stats — 统计
app.get('/api/staff/stats', (req, res) => {
  try {
    const { role } = req.query;
    let where = '';
    const params = [];
    if (role) { where = 'WHERE role=?'; params.push(role); }

    const total = db.queryOne(`SELECT COUNT(*) as cnt FROM employees ${where}`, params).cnt;
    const active = db.queryOne(`SELECT COUNT(*) as cnt FROM employees ${where}${where ? ' AND' : ' WHERE'} status='在职'`, params).cnt;
    const inactive = db.queryOne(`SELECT COUNT(*) as cnt FROM employees ${where}${where ? ' AND' : ' WHERE'} status='离职'`, params).cnt;

    res.json({ ok: true, stats: { total, active, inactive } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/staff — 新增员工（本地建档），并异步尝试同步到企微智能表格
app.post('/api/staff', (req, res) => {
  try {
    const { name, phone, gender, photo_url, store_name, onboarding_status, status, entry_date, position, role, hire_type, salary, probation_date, leave_date, id_card_number, id_card_front_url, id_card_back_url, bank_name, bank_branch, bank_account_name, bank_card_number, emergency_contact, emergency_phone, health_certificate_url, health_certificate_expiry, remark } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ error: '姓名不能为空' });
    const cleanStoreName = String(store_name || '').trim();
    const storeId = resolveStaffStoreId(cleanStoreName);
    const calculatedAge = ageFromIdCard(id_card_number) || 0;
    const id = db.insert(
      `INSERT INTO employees (name,phone,gender,age,store_name,manager_name,onboarding_status,status,entry_date,position,role,hire_type,salary,probation_date,leave_date,id_card_number,id_card_front_url,id_card_back_url,bank_name,bank_branch,bank_account_name,bank_card_number,emergency_contact,emergency_phone,health_certificate_url,health_certificate_expiry,remark,store_id,smartsheet_record_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cleanName, String(phone || '').trim(), String(gender || '').trim(), calculatedAge,
        cleanStoreName, '', String(onboarding_status || '已入职').trim(), status === '离职' ? '离职' : '在职', String(entry_date || '').trim(),
        String(position || '').trim(), String(role || '店员').trim(), String(hire_type || '全职').trim(), Number(salary) || 0, String(probation_date || '').trim(), String(leave_date || '').trim(),
        String(id_card_number || '').trim(), String(id_card_front_url || '').trim(), String(id_card_back_url || '').trim(), String(bank_name || '').trim(), String(bank_branch || '').trim(), String(bank_account_name || '').trim(), String(bank_card_number || '').trim(), String(emergency_contact || '').trim(), String(emergency_phone || '').trim(), String(health_certificate_url || '').trim(), String(health_certificate_expiry || '').trim(), String(remark || '').trim(), storeId, '']
    );
    db.run('UPDATE employees SET photo_url=? WHERE id=?', [String(photo_url || '').trim(), id]);
    db.save();
    const created = db.queryOne('SELECT * FROM employees WHERE id=?', [id]);
    const cfg = loadConfig();
    syncStaffToSmartsheet(created, cfg).then(r => {
      if (r.synced) console.log(`[staff sync] 企微同步成功 (${r.action}): ${created.name}`);
      else console.error(`[staff sync] 企微同步失败: ${r.reason}`);
    }).catch(e => console.error('[staff sync] 同步异常:', e.message));
    res.json({ ok: true, id, staff: created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/staff/import — 上传员工表格（Excel/CSV，base64）导入员工档案
app.post('/api/staff/import', (req, res) => {
  try {
    const { filename, data } = req.body || {};
    if (!data) return res.status(400).json({ error: '缺少文件数据' });
    const buffer = Buffer.from(String(data).replace(/^data:[^,]+,/, ''), 'base64');
    if (!buffer.length) return res.status(400).json({ error: '文件内容为空' });
    const result = staffImport.importStaffWorkbook(db, buffer, filename || '员工表.xlsx');
    console.log(`[staff import/http] ${filename}: 新增 ${result.created} / 更新 ${result.updated} / 跳过 ${result.skipped}`);
    res.json({ ok: true, ...result, message: staffImport.formatImportReply(result, filename) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/staff/sync-wecom — 以机器人身份从企业微信智能表格同步员工档案（无需自建应用 wedoc 权限）
app.post('/api/staff/sync-wecom', async (req, res) => {
  try {
    const cfg = loadConfig();
    const docid = String(req.body?.docid || cfg.staffSmartSheetDocId || '').trim();
    const sheetTitle = String(req.body?.sheet_title || cfg.staffSmartSheetTitle || '员工信息表').trim();
    if (!docid) return res.status(400).json({ error: '请先在 config.json 配置 staffSmartSheetDocId（企微智能表格链接中的 s3_ 开头 ID）' });
    const result = await wecomStaffSync.syncEmployeesFromWecom(db, { docid, sheetTitle });
    console.log(`[staff sync/wecom] ${sheetTitle}: 新增 ${result.created} / 更新 ${result.updated} / 跳过 ${result.skipped}`);
    res.json({ ok: true, ...result, message: `同步完成：新增 ${result.created} 人，更新 ${result.updated} 人，跳过 ${result.skipped} 行` });
  } catch (e) {
    console.error('[staff sync/wecom] 失败:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// 员工同步到企微智能表格的辅助函数
async function syncStaffToSmartsheet(employee, cfg) {
  // 优先使用 access_token API (支持 update_records)，回退到 webhook
  const hasApiConfig = cfg.staffSmartSheetDocId && cfg.staffSmartSheetSheetId;
  const hasWebhook = cfg.staffSmartSheetUrl;

  if (!hasApiConfig && !hasWebhook) return { synced: false, reason: '未配置企微表格' };

  const values = {
    '名字': employee.name || '',
    '手机号': employee.phone || '',
    '性别': employee.gender || '',
    '年龄': String(employee.age || ''),
    '个人照片': employee.photo_url || '',
    '归属门店': employee.store_name || '',
    '入职状态': employee.onboarding_status || '',
    '在职状态': employee.status || '',
    '入职日期': employee.entry_date || '',
    '岗位': employee.position || '',
    '用工类型': employee.hire_type || '',
    '薪酬标准': String(employee.salary || ''),
    '转正时间': employee.probation_date || '',
    '离职时间': employee.leave_date || '',
    '身份证号码': employee.id_card_number || '',
    '身份证正反面照片': [employee.id_card_front_url, employee.id_card_back_url].filter(Boolean).join(' | '),
    '开户银行': employee.bank_name || '',
    '开户银行支行': employee.bank_branch || '',
    '银行卡姓名': employee.bank_account_name || '',
    '银行卡卡号': employee.bank_card_number || '',
    '紧急联系人': employee.emergency_contact || '',
    '紧急联系电话': employee.emergency_phone || '',
    '健康证照片': employee.health_certificate_url || '',
    '健康证失效时间': employee.health_certificate_expiry || '',
    '备注': employee.remark || '',
  };

  // 方式一：access_token API（支持 add + update）
  if (hasApiConfig) {
    try {
      const token = await ensureToken();
      const baseUrl = 'https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet';
      const recordId = employee.smartsheet_record_id;

      let result;
      if (recordId) {
        // 更新已有记录
        result = await httpPost(`${baseUrl}/update_records?access_token=${token}`, {
          docid: cfg.staffSmartSheetDocId,
          sheet_id: cfg.staffSmartSheetSheetId,
          key_type: 'CELL_VALUE_KEY_TYPE_FIELD_TITLE',
          records: [{ record_id: recordId, values }],
        });
      } else {
        // 新增记录
        result = await httpPost(`${baseUrl}/add_records?access_token=${token}`, {
          docid: cfg.staffSmartSheetDocId,
          sheet_id: cfg.staffSmartSheetSheetId,
          key_type: 'CELL_VALUE_KEY_TYPE_FIELD_TITLE',
          records: [{ values }],
        });
      }

      if (result.errcode === 0) {
        // 新增成功后，保存返回的 record_id
        if (!recordId && result.records && result.records[0]) {
          db.run('UPDATE employees SET smartsheet_record_id=? WHERE id=?',
            [result.records[0].record_id, employee.id]);
          db.save();
        }
        return { synced: true, action: recordId ? 'update' : 'add' };
      }
      console.error('[staff sync] API 失败:', result.errmsg);
      return { synced: false, reason: result.errmsg };
    } catch (e) {
      console.error('[staff sync] API 异常:', e.message);
      return { synced: false, reason: e.message };
    }
  }

  // 方式二：webhook（仅支持 add_records，兼容旧配置）
  if (hasWebhook) {
    try {
      const payload = {
        schema: {
          '姓名': { title: '姓名', type: 'text' },
          '手机号': { title: '手机号', type: 'text' },
          '性别': { title: '性别', type: 'text' },
          '年龄': { title: '年龄', type: 'text' },
          '所属门店': { title: '所属门店', type: 'text' },
          '状态': { title: '状态', type: 'text' },
          '入职日期': { title: '入职日期', type: 'text' },
          '职位': { title: '职位', type: 'text' },
          '角色': { title: '角色', type: 'text' },
          '备注': { title: '备注', type: 'text' },
        },
        add_records: [{ values }],
      };
      const resp = await fetch(cfg.staffSmartSheetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (data.errcode === 0) return { synced: true, action: 'add_webhook' };
      console.error('[staff sync] Webhook 失败:', data.errmsg);
      return { synced: false, reason: data.errmsg };
    } catch (e) {
      console.error('[staff sync] Webhook 异常:', e.message);
      return { synced: false, reason: e.message };
    }
  }

  return { synced: false, reason: '未知错误' };
}

// PUT /api/staff/:id — 更新员工 + 同步到企微智能表格
app.put('/api/staff/:id', async (req, res) => {
  try {
    const fields = ['name', 'phone', 'gender', 'photo_url', 'store_name', 'onboarding_status', 'status', 'entry_date', 'position', 'remark', 'hire_type', 'salary', 'probation_date', 'leave_date', 'id_card_number', 'id_card_front_url', 'id_card_back_url', 'bank_name', 'bank_branch', 'bank_account_name', 'bank_card_number', 'emergency_contact', 'emergency_phone', 'health_certificate_url', 'health_certificate_expiry'];
    const sets = [];
    const params = [];

    fields.forEach(f => {
      if (req.body[f] !== undefined) { sets.push(`${f}=?`); params.push(req.body[f]); }
    });

    if (req.body.store_name !== undefined) { sets.push('store_id=?'); params.push(resolveStaffStoreId(req.body.store_name)); }
    if (req.body.id_card_number !== undefined) { sets.push('age=?'); params.push(ageFromIdCard(req.body.id_card_number) || 0); }

    if (!sets.length) return res.status(400).json({ error: '没有要更新的字段' });

    sets.push("updated_at=datetime('now','localtime')");
    params.push(req.params.id);

    db.run(`UPDATE employees SET ${sets.join(',')} WHERE id=?`, params);
    db.save();

    const updated = db.queryOne('SELECT * FROM employees WHERE id=?', [req.params.id]);

    // 异步同步到企微智能表格
    const cfg = loadConfig();
    syncStaffToSmartsheet(updated, cfg).then(r => {
      if (r.synced) console.log(`[staff sync] 企微同步成功 (${r.action}): ${updated.name}`);
      else console.error(`[staff sync] 企微同步失败: ${r.reason}`);
    }).catch(e => console.error('[staff sync] 同步异常:', e.message));

    res.json({ ok: true, staff: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/staff/seed — 重新生成测试员工数据
app.post('/api/staff/seed', (req, res) => {
  try {
    const count = db.reseedStaff();
    res.json({ ok: true, count, message: `已重新生成 ${count} 条测试员工数据` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/staff/sync-pull — 从企微智能表格拉取员工数据到本地
app.get('/api/staff/sync-pull', async (req, res) => {
  try {
    const cfg = loadConfig();
    if (!cfg.staffSmartSheetDocId || !cfg.staffSmartSheetSheetId) {
      return res.status(400).json({ error: '请先配置 staffSmartSheetDocId 和 staffSmartSheetSheetId' });
    }

    const token = await ensureToken();

    // 1. 拉取企微表格全部记录
    let allRecords = [];
    let offset = 0;
    const limit = 500;
    while (true) {
      const result = await httpPost(
        `https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/get_records?access_token=${token}`,
        { docid: cfg.staffSmartSheetDocId, sheet_id: cfg.staffSmartSheetSheetId, limit, offset }
      );
      if (result.errcode !== 0) {
        return res.status(400).json({ error: `读取企微表格失败: [${result.errcode}] ${result.errmsg}` });
      }
      const records = result.records || [];
      allRecords = allRecords.concat(records);
      if (!result.has_more || records.length < limit) break;
      offset += limit;
    }

    console.log(`[staff pull] 从企微拉取到 ${allRecords.length} 条记录`);

    // 2. 获取本地已有员工的 record_id 映射
    const localMap = {};
    const allLocal = db.queryAll('SELECT id, smartsheet_record_id, name FROM employees');
    for (const e of allLocal) {
      if (e.smartsheet_record_id) localMap[e.smartsheet_record_id] = e;
    }

    // 3. 逐条同步
    let created = 0, updated = 0, skipped = 0;
    for (const rec of allRecords) {
      const vals = rec.values || {};
      // 企微字段标题 → 值映射
      const text = (field) => (vals[field] || []).map(v => v.text || v).join('').trim();
      const name = text('姓名') || text('名字');
      if (!name) { skipped++; continue; }

      const rowData = {
        name,
        phone: text('手机号'), gender: text('性别'), age: parseInt(text('年龄')) || 0,
        store_name: text('归属门店') || text('所属门店'), manager_name: text('归属店长'),
        onboarding_status: text('入职状态') || '已入职', status: text('在职状态') || text('状态') || '在职',
        entry_date: text('入职日期'), position: text('岗位') || text('职位'), role: text('角色') || '店员',
        hire_type: text('用工类型') || '全职', salary: Number(text('薪酬标准') || text('员工工资') || text('兼职时薪')) || 0,
        probation_date: text('转正时间'), leave_date: text('离职时间'), id_card_number: text('身份证号码'),
        id_card_front_url: text('身份证正面照片') || text('身份证正反面照片').split(' | ')[0] || '',
        id_card_back_url: text('身份证反面照片') || text('身份证正反面照片').split(' | ').slice(1).join(' | ') || '',
        bank_name: text('开户银行'), bank_branch: text('开户银行支行'), bank_account_name: text('银行卡姓名'), bank_card_number: text('银行卡卡号'),
        emergency_contact: text('紧急联系人'), emergency_phone: text('紧急联系电话'),
        health_certificate_url: text('健康证照片'), health_certificate_expiry: text('健康证失效时间'), remark: text('备注'),
      };

      // 尝试匹配：先按 record_id，再按姓名
      let localEmployee = localMap[rec.record_id];
      if (!localEmployee) {
        localEmployee = allLocal.find(e => e.name === rowData.name && !e.smartsheet_record_id);
      }

      if (localEmployee) {
        // 更新本地记录 + 写入 record_id
        db.run(
          `UPDATE employees SET smartsheet_record_id=?, name=?, phone=?, gender=?, age=?, store_name=?, manager_name=?, onboarding_status=?,
           status=?, entry_date=?, position=?, role=?, hire_type=?, salary=?, probation_date=?, leave_date=?, id_card_number=?, id_card_front_url=?, id_card_back_url=?,
           bank_name=?, bank_branch=?, bank_account_name=?, bank_card_number=?, emergency_contact=?, emergency_phone=?, health_certificate_url=?, health_certificate_expiry=?, remark=?,
           updated_at=datetime('now','localtime') WHERE id=?`,
          [rec.record_id, rowData.name, rowData.phone, rowData.gender, rowData.age,
           rowData.store_name, rowData.manager_name, rowData.onboarding_status, rowData.status, rowData.entry_date, rowData.position, rowData.role, rowData.hire_type, rowData.salary,
           rowData.probation_date, rowData.leave_date, rowData.id_card_number, rowData.id_card_front_url, rowData.id_card_back_url,
           rowData.bank_name, rowData.bank_branch, rowData.bank_account_name, rowData.bank_card_number, rowData.emergency_contact, rowData.emergency_phone,
           rowData.health_certificate_url, rowData.health_certificate_expiry, rowData.remark, localEmployee.id]
        );
        updated++;
      } else {
        // 新建本地员工
        const newId = db.insert(
          `INSERT INTO employees (name,phone,gender,age,store_name,manager_name,onboarding_status,status,entry_date,position,role,hire_type,salary,probation_date,leave_date,id_card_number,id_card_front_url,id_card_back_url,bank_name,bank_branch,bank_account_name,bank_card_number,emergency_contact,emergency_phone,health_certificate_url,health_certificate_expiry,remark,smartsheet_record_id,store_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [rowData.name, rowData.phone, rowData.gender, rowData.age,
           rowData.store_name, rowData.manager_name, rowData.onboarding_status, rowData.status, rowData.entry_date, rowData.position, rowData.role, rowData.hire_type, rowData.salary,
           rowData.probation_date, rowData.leave_date, rowData.id_card_number, rowData.id_card_front_url, rowData.id_card_back_url,
           rowData.bank_name, rowData.bank_branch, rowData.bank_account_name, rowData.bank_card_number, rowData.emergency_contact, rowData.emergency_phone,
           rowData.health_certificate_url, rowData.health_certificate_expiry, rowData.remark, rec.record_id, 0]
        );
        allLocal.push({ id: newId, smartsheet_record_id: rec.record_id, name: rowData.name });
        created++;
      }
    }

    db.save();
    const message = `同步完成：新增 ${created} 人，更新 ${updated} 人，跳过 ${skipped} 条空记录`;
    console.log(`[staff pull] ${message}`);
    res.json({ ok: true, created, updated, skipped, total: allRecords.length, message });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 固定成本 =====
app.get('/api/stores/:id/fixed-costs', (req, res) => { try { res.json({ ok: true, costs: db.queryAll('SELECT * FROM store_fixed_costs WHERE store_id=?', [req.params.id]) }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/stores/:id/fixed-costs', (req, res) => { try { const { cost_type, amount, period } = req.body; if (!cost_type) return res.status(400).json({ error: '成本项目不能为空' }); const value = Number(amount); if (!Number.isFinite(value)) return res.status(400).json({ error: '请输入有效金额' }); const id = db.insert('INSERT INTO store_fixed_costs (store_id,cost_type,amount,period) VALUES (?,?,?,?)', [req.params.id, cost_type.trim(), value, period || '月度']); db.save(); res.json({ ok: true, id }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put('/api/fixed-costs/:id', (req, res) => { try { const { amount, cost_type } = req.body; const sets = [], params = []; if (amount !== undefined) { sets.push('amount=?'); params.push(amount); } if (cost_type !== undefined) { sets.push('cost_type=?'); params.push(cost_type); } if (!sets.length) return res.status(400).json({ error: '没有要更新的字段' }); params.push(req.params.id); db.run(`UPDATE store_fixed_costs SET ${sets.join(',')} WHERE id=?`, params); db.save(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/fixed-costs/:id', (req, res) => { try { db.run('DELETE FROM store_fixed_costs WHERE id=?', [req.params.id]); db.save(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ===== 运营成本 =====
app.get('/api/stores/:id/operating-costs', (req, res) => { try { res.json({ ok: true, costs: db.queryAll('SELECT * FROM store_operating_costs WHERE store_id=? ORDER BY date DESC, id DESC', [req.params.id]) }); } catch (e) { res.status(500).json({ error: e.message }); } });
// 月度费用台账默认允许查看全门店；可按门店范围和费用月份筛选。
app.get('/api/operating-costs', (req, res) => {
  try {
    const clauses = ['1=1'];
    const params = [];
    const storeIds = String(req.query.store_ids || '').split(',').map(Number).filter(id => Number.isInteger(id) && id > 0);
    if (storeIds.length) { clauses.push(`store_id IN (${storeIds.map(() => '?').join(',')})`); params.push(...storeIds); }
    else if (req.query.store_id) { clauses.push('store_id=?'); params.push(Number(req.query.store_id)); }
    const month = String(req.query.month || '').trim();
    if (/^\d{4}-\d{2}$/.test(month)) { clauses.push('substr(date,1,7)=?'); params.push(month); }
    const costs = db.queryAll(`SELECT * FROM store_operating_costs WHERE ${clauses.join(' AND ')} ORDER BY date DESC, store_name ASC, id DESC`, params);
    res.json({ ok: true, costs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/stores/:id/operating-costs', (req, res) => { try { const { store_name, date, item, amount } = req.body; if (!item) return res.status(400).json({ error: '事项不能为空' }); const id = db.insert('INSERT INTO store_operating_costs (store_id,store_name,date,item,amount) VALUES (?,?,?,?,?)', [req.params.id, store_name||'', date||new Date().toISOString().slice(0,10), item, amount||0]); db.save(); res.json({ ok: true, id }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put('/api/stores/:id/monthly-wage', (req, res) => { try { const month = String(req.body.month || ''); const amount = Number(req.body.amount); if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: '请选择工资月份' }); if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: '请输入有效工资金额' }); const store = db.queryOne('SELECT store_name FROM stores WHERE id=?', [req.params.id]); if (!store) return res.status(404).json({ error: '门店不存在' }); const date = `${month}-01`; const current = db.queryOne("SELECT id FROM store_operating_costs WHERE store_id=? AND item='月度工资' AND substr(date,1,7)=? ORDER BY id DESC LIMIT 1", [req.params.id, month]); if (current) db.run('UPDATE store_operating_costs SET store_name=?, date=?, amount=? WHERE id=?', [store.store_name, date, amount, current.id]); else db.insert("INSERT INTO store_operating_costs (store_id,store_name,date,item,amount) VALUES (?,?,?,?,?)", [req.params.id, store.store_name, date, '月度工资', amount]); db.save(); res.json({ ok: true, message: '月度工资已保存' }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put('/api/stores/:id/monthly-operating-cost', (req, res) => {
  try {
    const month = String(req.body.month || '');
    const item = String(req.body.item || '').trim();
    const amount = Number(req.body.amount);
    const allowedItems = new Set(['月度工资', '月度房租及物业', '月度水电费']);
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: '请选择成本月份' });
    if (!allowedItems.has(item)) return res.status(400).json({ error: '仅可记录工资、房租/物业或水电费' });
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: '请输入有效金额' });
    const store = db.queryOne('SELECT store_name FROM stores WHERE id=?', [req.params.id]);
    if (!store) return res.status(404).json({ error: '门店不存在' });
    const date = `${month}-01`;
    const existing = db.queryAll('SELECT id FROM store_operating_costs WHERE store_id=? AND item=? AND substr(date,1,7)=? ORDER BY id DESC', [req.params.id, item, month]);
    if (existing.length) {
      db.run('UPDATE store_operating_costs SET store_name=?, date=?, amount=? WHERE id=?', [store.store_name, date, amount, existing[0].id]);
      existing.slice(1).forEach(row => db.run('DELETE FROM store_operating_costs WHERE id=?', [row.id]));
    } else {
      db.insert('INSERT INTO store_operating_costs (store_id,store_name,date,item,amount) VALUES (?,?,?,?,?)', [req.params.id, store.store_name, date, item, amount]);
    }
    db.save();
    res.json({ ok: true, message: '月度运营成本已保存' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/operating-costs/:id', (req, res) => { try { db.run('DELETE FROM store_operating_costs WHERE id=?', [req.params.id]); db.save(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ===== 菜品管理 =====
app.get('/api/menu', (req, res) => {
  try {
    const { store_id, category, status } = req.query;
    let sql = `SELECT m.*, s.store_name,
      (SELECT COUNT(*) FROM menu_cost_components c WHERE c.menu_item_id=m.id) AS cost_component_count
      FROM menu_items m LEFT JOIN stores s ON m.store_id=s.id LEFT JOIN menu_categories mc ON mc.name=m.category WHERE 1=1`;
    const params = [];
    if (store_id) { sql += ' AND (m.store_id=? OR m.store_id IS NULL)'; params.push(store_id); }
    if (category) { sql += ' AND m.category=?'; params.push(category); }
    if (status) { sql += ' AND m.status=?'; params.push(status); }
    sql += " ORDER BY CASE WHEN m.category IS NULL OR m.category='' THEN 1 ELSE 0 END, COALESCE(mc.sort_order, 999999), mc.id, m.id";
    const items = db.queryAll(sql, params);
    res.json({ ok: true, items, count: items.length });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/menu', (req, res) => {
  try {
    const {
      store_id, name, category, method, spec, price, dine_in_price,
      member_price, takeout_price, spec_unit, spec_weight, cost,
      expiry_days, status, item_type, spuid, skuid,
    } = req.body;
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ error: '菜品名称不能为空' });
    const cleanSkuid = String(skuid || '').trim();
    const cleanSpuid = String(spuid || '').trim();
    if (cleanSkuid) {
      const dup = db.queryOne("SELECT id FROM menu_items WHERE skuid=? AND skuid != ''", [cleanSkuid]);
      if (dup) return res.status(409).json({ error: `菜品编码(SKUID) ${cleanSkuid} 已存在（id=${dup.id}），请勿重复新增` });
    }
    const dinePrice = Number(dine_in_price) || 0;
    const id = db.insert(
      `INSERT INTO menu_items
       (store_id,name,category,method,spec,price,dine_in_price,member_price,takeout_price,spec_unit,spec_weight,cost,expiry_days,status,item_type,spuid,skuid)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        store_id || null,
        cleanName,
        String(category || '').trim(),
        String(method || '').trim(),
        String(spec || '').trim(),
        Number(price ?? dinePrice) || 0,
        dinePrice,
        Number(member_price) || 0,
        Number(takeout_price) || 0,
        String(spec_unit || '份').trim(),
        String(spec_weight || '').trim(),
        Number(cost) || 0,
        expiry_days == null || expiry_days === '' ? null : Number(expiry_days),
        status === '停售' ? '停售' : '在售',
        item_type === 'combo' ? 'combo' : 'dish',
        cleanSpuid,
        cleanSkuid,
      ]
    );
    db.save();
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/menu/:id', (req, res) => { try { const fields = ['name','category','method','spec','price','dine_in_price','member_price','takeout_price','spec_unit','spec_weight','cost','expiry_days','status','item_type','spuid','skuid']; const sets = [], params = []; const sk = req.body.skuid !== undefined ? String(req.body.skuid).trim() : ''; const dup = sk ? db.queryOne("SELECT id FROM menu_items WHERE skuid=? AND skuid != '' AND id != ?", [sk, req.params.id]) : null; if (dup) return res.status(409).json({ error: `菜品编码(SKUID) ${sk} 已被 id=${dup.id} 使用` }); fields.forEach(f => { if (req.body[f] !== undefined) { sets.push(`${f}=?`); params.push(req.body[f]); } }); if (!sets.length) return res.status(400).json({ error: '没有要更新的字段' }); params.push(req.params.id); db.run(`UPDATE menu_items SET ${sets.join(',')} WHERE id=?`, params); db.save(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/menu/:id', (req, res) => { try { db.run('DELETE FROM menu_items WHERE id=?', [req.params.id]); db.save(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/api/menu/:id/cost-components', (req, res) => {
  try {
    const item = db.queryOne('SELECT id,name,cost,item_type FROM menu_items WHERE id=?', [req.params.id]);
    if (!item) return res.status(404).json({ error: '菜品不存在' });
    const components = db.queryAll(
      `SELECT c.id,c.ingredient_name,c.quantity,c.unit,c.unit_cost,c.subtotal,c.component_menu_item_id,c.choice_group,c.choice_min,c.choice_max,c.sort_order,
              cm.name AS component_name, cm.spec AS component_spec, cm.cost AS component_current_cost
       FROM menu_cost_components c
       LEFT JOIN menu_items cm ON cm.id=c.component_menu_item_id
       WHERE c.menu_item_id=? ORDER BY c.sort_order,c.id`,
      [req.params.id]
    );
    res.json({ ok: true, item, components, total_cost: Number(item.cost) || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/menu/:id/cost-components', (req, res) => {
  const itemId = Number(req.params.id);
  try {
    if (!db.queryOne('SELECT id FROM menu_items WHERE id=?', [itemId])) return res.status(404).json({ error: '菜品不存在' });
    if (!Array.isArray(req.body?.components)) return res.status(400).json({ error: '成本明细格式不正确' });
    if (req.body.components.length > 100) return res.status(400).json({ error: '单个菜品最多录入 100 条成本明细' });
    const components = req.body.components.map((row, index) => {
      const refId = Number(row.component_menu_item_id) || null;
      const quantity = Number(row.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`第 ${index + 1} 行用量必须大于 0`);
      let name = String(row.ingredient_name || '').trim();
      let unitCost = Number(row.unit_cost);
      // 引用菜单商品：名称与单位成本以商品当前档案为准（商品无成本时按 0 计，由前端提示）
      if (refId) {
        const src = db.queryOne('SELECT id,name,cost FROM menu_items WHERE id=?', [refId]);
        if (!src) throw new Error(`第 ${index + 1} 行引用的商品不存在`);
        name = name || String(src.name || '').trim();
        unitCost = Number(src.cost) || 0;
      }
      if (!name) throw new Error(`第 ${index + 1} 行请填写材料名称`);
      if (!Number.isFinite(unitCost) || unitCost < 0) throw new Error(`第 ${index + 1} 行单位成本不能小于 0`);
      return {
        ingredient_name: name,
        quantity,
        unit: String(row.unit || '份').trim() || '份',
        unit_cost: unitCost,
        component_menu_item_id: refId,
        choice_group: String(row.choice_group || '').trim().slice(0, 80),
        choice_min: Math.max(1, Math.floor(Number(row.choice_min) || 1)),
        choice_max: Math.max(1, Math.floor(Number(row.choice_max) || Number(row.choice_min) || 1)),
        subtotal: Math.round(quantity * unitCost * 100) / 100,
        sort_order: index,
      };
    });
    const fixedCost = components.filter(row => !row.choice_group).reduce((sum, row) => sum + row.subtotal, 0);
    const choiceGroups = new Map();
    components.filter(row => row.choice_group).forEach(row => {
      if (!choiceGroups.has(row.choice_group)) choiceGroups.set(row.choice_group, []);
      choiceGroups.get(row.choice_group).push(row);
    });
    const optionalCost = [...choiceGroups.values()].reduce((sum, group) => {
      const min = group[0].choice_min;
      const max = group[0].choice_max;
      if (group.some(row => row.choice_min !== min || row.choice_max !== max)) throw new Error('同一选择组的可选数量必须一致');
      if (min > group.length || max < min || max > group.length) throw new Error('选择组的可选数量超出备选菜品范围');
      return sum + group.map(row => row.subtotal).sort((a, b) => a - b).slice(0, min).reduce((value, cost) => value + cost, 0);
    }, 0);
    const totalCost = Math.round((fixedCost + optionalCost) * 100) / 100;
    db.exec('BEGIN');
    try {
      db.run('DELETE FROM menu_cost_components WHERE menu_item_id=?', [itemId]);
      components.forEach(row => db.insert(
        'INSERT INTO menu_cost_components (menu_item_id,ingredient_name,quantity,unit,unit_cost,component_menu_item_id,choice_group,choice_min,choice_max,subtotal,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [itemId, row.ingredient_name, row.quantity, row.unit, row.unit_cost, row.component_menu_item_id, row.choice_group, row.choice_min, row.choice_max, row.subtotal, row.sort_order]
      ));
      db.run("UPDATE menu_items SET cost=?, item_type=CASE WHEN item_type IS NULL THEN 'combo' ELSE item_type END WHERE id=?", [totalCost, itemId]);
      db.exec('COMMIT');
      db.save();
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.json({ ok: true, components, total_cost: totalCost });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 清空成本构成：只删除成分行，不改变手工录入的成本
app.delete('/api/menu/:id/cost-components', (req, res) => {
  try {
    const item = db.queryOne('SELECT id FROM menu_items WHERE id=?', [req.params.id]);
    if (!item) return res.status(404).json({ error: '菜品不存在' });
    db.run('DELETE FROM menu_cost_components WHERE menu_item_id=?', [req.params.id]);
    db.save();
    res.json({ ok: true, message: '成本构成已清空（成本值保留）' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 菜品分类 =====
// 分类名列表（用于下拉筛选）：来自分类表 + 菜单中仍在使用的历史分类
app.get('/api/menu-categories', (req, res) => {
  try {
    const fromTable = db.queryAll('SELECT name FROM menu_categories ORDER BY sort_order, id').map(r => r.name);
    const orphans = db.queryAll("SELECT DISTINCT category FROM menu_items WHERE category IS NOT NULL AND category != ''").map(r => r.category).filter(n => !fromTable.includes(n));
    res.json({ ok: true, categories: [...fromTable, ...orphans] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 分类管理列表（含菜品数量；附带"待收录"的历史分类）
app.get('/api/menu-category/list', (req, res) => {
  try {
    const used = {};
    db.queryAll("SELECT category AS name, COUNT(*) AS dish_count FROM menu_items WHERE category IS NOT NULL AND category != '' GROUP BY category").forEach(r => { used[r.name] = r.dish_count; });
    const rows = db.queryAll('SELECT id, name, sort_order, remark, created_at FROM menu_categories ORDER BY sort_order, id');
    const managed = rows.map(r => ({ ...r, dish_count: used[r.name] || 0 }));
    const orphans = Object.keys(used).filter(n => !rows.some(r => r.name === n)).map(n => ({ id: null, name: n, sort_order: 0, remark: '', created_at: '', orphan: true, dish_count: used[n] }));
    res.json({ ok: true, categories: [...managed, ...orphans], total: managed.length, dishTotal: Object.values(used).reduce((s, v) => s + v, 0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 新增分类
app.post('/api/menu-category', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: '分类名称不能为空' });
    if (db.queryOne('SELECT id FROM menu_categories WHERE name=?', [name])) return res.status(400).json({ error: `分类「${name}」已存在` });
    const nextSortOrder = (Number(db.queryOne('SELECT MAX(sort_order) AS value FROM menu_categories')?.value) || 0) + 10;
    const sort_order = req.body?.sort_order !== undefined ? Number(req.body.sort_order) || nextSortOrder : nextSortOrder;
    const remark = String(req.body?.remark || '').trim();
    const id = db.insert('INSERT INTO menu_categories (name, sort_order, remark) VALUES (?,?,?)', [name, sort_order, remark]);
    db.save();
    res.status(201).json({ ok: true, id, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 收录历史分类（菜单中已使用但分类表没有）
app.post('/api/menu-category/adopt', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: '分类名称不能为空' });
    if (db.queryOne('SELECT id FROM menu_categories WHERE name=?', [name])) return res.status(400).json({ error: `分类「${name}」已存在` });
    const nextSortOrder = (Number(db.queryOne('SELECT MAX(sort_order) AS value FROM menu_categories')?.value) || 0) + 10;
    const id = db.insert('INSERT INTO menu_categories (name, sort_order) VALUES (?,?)', [name, nextSortOrder]);
    db.save();
    res.status(201).json({ ok: true, id, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 拖动排序：提交全部已管理分类，统一重写连续排序值，保证所有分类选择器顺序一致
app.put('/api/menu-category/order', (req, res) => {
  try {
    if (!Array.isArray(req.body?.ids)) return res.status(400).json({ error: '排序数据格式不正确' });
    const rows = db.queryAll('SELECT id FROM menu_categories ORDER BY sort_order, id');
    const ids = req.body.ids.map(Number).filter(Number.isFinite);
    if (new Set(ids).size !== ids.length || ids.length !== rows.length || rows.some(row => !ids.includes(row.id))) {
      return res.status(400).json({ error: '请提交全部分类的完整排序' });
    }
    db.exec('BEGIN');
    try {
      ids.forEach((id, index) => db.run("UPDATE menu_categories SET sort_order=?, updated_at=datetime('now','localtime') WHERE id=?", [(index + 1) * 10, id]));
      db.exec('COMMIT');
      db.save();
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.json({ ok: true, ids });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 编辑分类（改名会同步更新菜品与模板中的分类名）
app.put('/api/menu-category/:id', (req, res) => {
  try {
    const category = db.queryOne('SELECT * FROM menu_categories WHERE id=?', [req.params.id]);
    if (!category) return res.status(404).json({ error: '分类不存在' });
    const name = req.body?.name !== undefined ? String(req.body.name).trim() : category.name;
    if (!name) return res.status(400).json({ error: '分类名称不能为空' });
    if (db.queryOne('SELECT id FROM menu_categories WHERE name=? AND id!=?', [name, req.params.id])) return res.status(400).json({ error: `分类「${name}」已存在` });
    const sort_order = req.body?.sort_order !== undefined ? Number(req.body.sort_order) || 0 : category.sort_order;
    const remark = req.body?.remark !== undefined ? String(req.body.remark).trim() : category.remark;
    db.run("UPDATE menu_categories SET name=?, sort_order=?, remark=?, updated_at=datetime('now','localtime') WHERE id=?", [name, sort_order, remark, req.params.id]);
    let syncedDishes = 0;
    if (name !== category.name) {
      syncedDishes = db.run('UPDATE menu_items SET category=? WHERE category=?', [name, category.name]);
      db.run('UPDATE menu_template_items SET category=? WHERE category=?', [name, category.name]);
    }
    db.save();
    res.json({ ok: true, syncedDishes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 删除分类（关联菜品将变为"未分类"）
app.delete('/api/menu-category/:id', (req, res) => {
  try {
    const category = db.queryOne('SELECT * FROM menu_categories WHERE id=?', [req.params.id]);
    if (!category) return res.status(404).json({ error: '分类不存在' });
    db.run('DELETE FROM menu_categories WHERE id=?', [req.params.id]);
    const clearedDishes = db.run("UPDATE menu_items SET category='' WHERE category=?", [category.name]);
    db.run("UPDATE menu_template_items SET category='' WHERE category=?", [category.name]);
    db.save();
    res.json({ ok: true, clearedDishes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 堂食菜品绑定 =====
/** 规格归一化：'--'/空 统一为 ''（无规格），保证映射唯一键一致 */
function normalizeDishSpec(value) {
  const text = String(value || '').trim();
  return (text === '' || text === '--') ? '' : text;
}

// 绑定时名称不是唯一标识：上庄、下庄、半只等规格售价不同，必须完整展示为 SKU。
function withDishMenuSku(menu = {}) {
  const name = String(menu.name || '').trim();
  const spec = normalizeDishSpec(menu.spec);
  const method = String(menu.method || '').trim();
  const unit = String(menu.spec_unit || '').trim();
  const weight = String(menu.spec_weight || '').trim();
  const parts = [];
  [spec, method && method !== '/' ? method : '', weight || unit].filter(Boolean).forEach(part => {
    if (!parts.includes(part)) parts.push(part);
  });
  const dineInPrice = Number(menu.dine_in_price || menu.price) || 0;
  const memberPrice = Number(menu.member_price) || 0;
  const takeoutPrice = Number(menu.takeout_price) || 0;
  const priceSummary = [
    dineInPrice ? `堂食 ¥${dineInPrice.toFixed(2)}` : '',
    memberPrice ? `会员 ¥${memberPrice.toFixed(2)}` : '',
    takeoutPrice ? `外卖 ¥${takeoutPrice.toFixed(2)}` : '',
  ].filter(Boolean).join(' / ');
  return {
    ...menu,
    sku_label: `${name}${parts.length ? ` · ${parts.join(' · ')}` : ''}`,
    sku_variant: parts.join(' · ') || '标准规格',
    sku_price_summary: priceSummary || '价格未设置',
  };
}
// 绑定列表：dish_sales 按菜品聚合 + 关联本地菜品（含成本/毛利估算），支持搜索与分页
app.get('/api/dish-sales/mappings', (req, res) => {
  try {
    const { keyword, mapped, page = 1, page_size = 20, sort = 'income' } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (keyword) { where += ' AND (d.product_name LIKE ? OR d.product_code LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
    if (mapped === 'bound') { where += ' AND m.id IS NOT NULL'; }
    if (mapped === 'unbound') { where += ' AND m.id IS NULL'; }
    const sortCol = { income: 'income_amount', quantity: 'quantity', amount: 'amount_total' }[sort] || 'income_amount';
    const total = db.queryOne(`SELECT COUNT(*) as cnt FROM (
        SELECT d.product_code, d.product_name, d.spec
        FROM dish_sales d
        LEFT JOIN dish_sales_mappings m ON m.product_code = d.product_code AND m.product_name = d.product_name
          AND m.spec = CASE WHEN d.spec IN ('', '--') THEN '' ELSE d.spec END
        ${where}
        GROUP BY d.product_code, d.product_name, d.spec
      )`, params).cnt;
    const psize = Math.min(100, Math.max(1, parseInt(page_size) || 20));
    const pg = Math.max(1, parseInt(page) || 1);
    const rows = db.queryAll(`
      SELECT d.product_code, d.product_name, d.spec,
        SUM(d.quantity) as quantity,
        SUM(d.amount_total) as amount_total,
        SUM(d.income_amount) as income_amount,
        SUM(d.refund_amount) as refund_amount,
        m.id as mapping_id, m.menu_item_id as menu_item_id,
        mi.name as menu_name, mi.category as menu_category, mi.cost as unit_cost,
        mi.spec as menu_spec, mi.method as menu_method, mi.spec_unit as menu_spec_unit, mi.spec_weight as menu_spec_weight,
        mi.price as menu_price, mi.dine_in_price as menu_dine_in_price, mi.member_price as menu_member_price, mi.takeout_price as menu_takeout_price
      FROM dish_sales d
      LEFT JOIN dish_sales_mappings m ON m.product_code = d.product_code AND m.product_name = d.product_name
        AND m.spec = CASE WHEN d.spec IN ('', '--') THEN '' ELSE d.spec END
      LEFT JOIN menu_items mi ON mi.id = m.menu_item_id
      ${where}
      GROUP BY d.product_code, d.product_name, d.spec
      ORDER BY ${sortCol} DESC
      LIMIT ? OFFSET ?`, [...params, psize, (pg - 1) * psize]);
    const items = rows.map(r => {
      const sku = withDishMenuSku({
        name: r.menu_name, spec: r.menu_spec, method: r.menu_method, spec_unit: r.menu_spec_unit, spec_weight: r.menu_spec_weight,
        price: r.menu_price, dine_in_price: r.menu_dine_in_price, member_price: r.menu_member_price, takeout_price: r.menu_takeout_price,
      });
      return {
        ...r,
        mapped: !!r.mapping_id,
        menu_sku_label: r.mapping_id ? sku.sku_label : '',
        menu_sku_variant: r.mapping_id ? sku.sku_variant : '',
        menu_sku_price_summary: r.mapping_id ? sku.sku_price_summary : '',
        unit_cost: Number(r.unit_cost) || 0,
        total_cost: r.mapping_id ? Math.round(Number(r.quantity) * (Number(r.unit_cost) || 0) * 100) / 100 : null,
        gross_profit: r.mapping_id ? Math.round((Number(r.income_amount) - Number(r.quantity) * (Number(r.unit_cost) || 0)) * 100) / 100 : null,
      };
    });
    const menu_items = db.queryAll(`SELECT id,name,category,method,spec,price,dine_in_price,member_price,takeout_price,spec_unit,spec_weight,cost
      FROM menu_items WHERE status='在售' ORDER BY category,name,spec,id`).map(withDishMenuSku);
    res.json({ ok: true, items, total, page: pg, page_size: psize, menu_items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 一键绑定：未绑定的堂食菜品按名称自动匹配本地菜品；同名多规格时用规格（上庄/下庄/半只等）区分
app.post('/api/dish-sales/mappings/auto-bind', (req, res) => {
  try {
    const rows = db.queryAll(`
      SELECT d.product_code, d.product_name, d.spec,
        SUM(d.quantity) as quantity, SUM(d.income_amount) as income_amount
      FROM dish_sales d
      LEFT JOIN dish_sales_mappings m ON m.product_code = d.product_code AND m.product_name = d.product_name
        AND m.spec = CASE WHEN d.spec IN ('', '--') THEN '' ELSE d.spec END
      WHERE m.id IS NULL
      GROUP BY d.product_code, d.product_name, d.spec
    `);
    const menus = db.queryAll("SELECT id,name,spec,method,spec_unit,spec_weight,cost FROM menu_items WHERE status='在售'");
    const byName = new Map();
    menus.forEach(m => {
      const list = byName.get(m.name);
      if (list) list.push(m); else byName.set(m.name, [m]);
    });
    let bound = 0, skipped = 0;
    const reasons = { no_name_match: 0, ambiguous_spec: 0, no_spec_among_multi: 0 };
    db.run('BEGIN');
    for (const r of rows) {
      const candidates = byName.get(String(r.product_name || '').trim()) || [];
      if (!candidates.length) { reasons.no_name_match++; skipped++; continue; }
      let target;
      if (candidates.length === 1) {
        target = candidates[0];
      } else {
        const spec = String(r.spec || '').trim();
        if (spec && spec !== '--') {
          const normalizedSpec = normalizeDishSpec(spec);
          const match = candidates.filter(c => {
            const menuSpec = normalizeDishSpec(c.spec);
            // 优先匹配新字段 spec；历史菜品尚未迁移规格时，才回退到单位/重量字段。
            return menuSpec === normalizedSpec || (!menuSpec && [c.spec_unit, c.spec_weight].some(value => normalizeDishSpec(value) === normalizedSpec));
          });
          if (match.length === 1) target = match[0];
          else { if (match.length === 0) reasons.no_spec_among_multi++; else reasons.ambiguous_spec++; skipped++; continue; }
        } else {
          reasons.no_spec_among_multi++; skipped++; continue;
        }
      }
      db.run(`INSERT INTO dish_sales_mappings (product_code, product_name, spec, menu_item_id) VALUES (?,?,?,?)
        ON CONFLICT(product_code, product_name, spec) DO UPDATE SET menu_item_id=excluded.menu_item_id, updated_at=datetime('now','localtime')`,
        [r.product_code, String(r.product_name || '').trim(), normalizeDishSpec(r.spec), target.id]);
      bound++;
    }
    db.run('COMMIT');
    db.save();
    res.json({ ok: true, bound, skipped, reasons });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 批量绑定：把多个堂食菜品（编码+名称+规格）一次性关联到同一个本地菜品
app.post('/api/dish-sales/mappings/batch', (req, res) => {
  try {
    const { items, menu_item_id } = req.body;
    const menuId = Number(menu_item_id);
    const menu = db.queryOne('SELECT id FROM menu_items WHERE id=?', [menuId]);
    if (!menu) return res.status(400).json({ error: '本地菜品不存在' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: '请选择要绑定的菜品' });
    db.run('BEGIN');
    let bound = 0;
    for (const it of items) {
      const code = String(it?.product_code || '').trim();
      const name = String(it?.product_name || '').trim();
      if (!code || !name) continue;
      db.run(`INSERT INTO dish_sales_mappings (product_code, product_name, spec, menu_item_id) VALUES (?,?,?,?)
        ON CONFLICT(product_code, product_name, spec) DO UPDATE SET menu_item_id=excluded.menu_item_id, updated_at=datetime('now','localtime')`,
        [code, name, normalizeDishSpec(it?.spec), menuId]);
      bound++;
    }
    db.run('COMMIT');
    db.save();
    res.json({ ok: true, bound });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 绑定/更换：按菜品编码 upsert
app.post('/api/dish-sales/mappings', (req, res) => {
  try {
    const { product_code, product_name, spec, menu_item_id } = req.body;
    const code = String(product_code || '').trim();
    const menuId = Number(menu_item_id);
    if (!code) return res.status(400).json({ error: '菜品编码不能为空' });
    const menu = db.queryOne('SELECT id FROM menu_items WHERE id=?', [menuId]);
    if (!menu) return res.status(400).json({ error: '本地菜品不存在' });
    db.run(`INSERT INTO dish_sales_mappings (product_code, product_name, spec, menu_item_id) VALUES (?,?,?,?)
      ON CONFLICT(product_code, product_name, spec) DO UPDATE SET menu_item_id=excluded.menu_item_id, updated_at=datetime('now','localtime')`,
      [code, String(product_name || '').trim(), normalizeDishSpec(spec), menuId]);
    db.save();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 解绑
app.delete('/api/dish-sales/mappings/:id', (req, res) => {
  try {
    const affected = db.run('DELETE FROM dish_sales_mappings WHERE id=?', [req.params.id]);
    if (!affected) return res.status(404).json({ error: '绑定记录不存在' });
    db.save();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ===== 菜品销售明细 =====
// 菜品分析聚合：按菜品汇总销量/金额/收入/优惠/退款（总视角使用，支持门店筛选与分页）
app.get('/api/dish-sales/analytics', (req, res) => {
  try {
    const { date_from, date_to, store_id, store_ids, keyword, limit = 20, sort = 'income', page = 1, page_size = 20 } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (date_from) { where += ' AND order_time>=?'; params.push(date_from); }
    if (date_to) { where += ' AND order_time<=?'; params.push(`${date_to} 23:59:59`); }
    if (store_id) {
      const name = db.queryOne('SELECT store_name FROM stores WHERE id=?', [Number(store_id)])?.store_name;
      if (name) { where += ' AND store_name=?'; params.push(name); }
    }
    if (store_ids) {
      const ids = String(store_ids).split(',').map(Number).filter(id => Number.isInteger(id) && id > 0);
      if (ids.length) {
        const names = db.queryAll(`SELECT store_name FROM stores WHERE id IN (${ids.map(() => '?').join(',')})`, ids).map(r => r.store_name);
        if (names.length) { where += ` AND store_name IN (${names.map(() => '?').join(',')})`; params.push(...names); }
      }
    }
    if (keyword) { where += ' AND (product_name LIKE ? OR product_code LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
    const sortKey = { income: 'income_amount', quantity: 'quantity', amount: 'amount_total' }[sort] || 'income_amount';
    const psize = Math.min(100, Math.max(1, parseInt(page_size) || 20));
    const pg = Math.max(1, parseInt(page) || 1);
    // 取数分两段：SQL 只做分组汇总（不设 LIMIT，分组数在千级），本地 SKU 识别、排序、翻页都在 JS 做。
    const groups = db.queryAll(`
      SELECT d.product_code, d.product_name, d.spec,
        SUM(d.quantity) as quantity,
        SUM(d.amount_total) as amount_total,
        SUM(d.discount_amount) as discount_amount,
        SUM(d.income_amount) as income_amount,
        SUM(d.refund_amount) as refund_amount,
        COUNT(DISTINCT d.order_no) as order_count,
        SUM(CASE WHEN d.refunded='部分退' THEN 1 ELSE 0 END) as refunded_count,
        MAX(m.id) as mapping_id,
        MAX(m.menu_item_id) as menu_item_id
      FROM dish_sales d
      LEFT JOIN dish_sales_mappings m ON m.product_code = d.product_code AND m.product_name = d.product_name
        AND m.spec = CASE WHEN d.spec IN ('', '--') THEN '' ELSE d.spec END
      ${where}
      GROUP BY d.product_code, d.product_name, d.spec`, params);
    // 收银机品项名称本来就取自本地菜品库，绝大多数行应与本地菜品对得上，
    // 不能因为 dish_sales_mappings 里没有手工记录就要求用户「本地菜品绑本地菜品」。
    // 识别优先级：手工绑定 → 菜品编码=skuid（名称互校）→ 名称+规格唯一 → 名称唯一。
    const menus = db.queryAll(`SELECT id,name,category,method,spec,spec_unit,spec_weight,cost,skuid
      FROM menu_items WHERE status='在售' AND INSTR(name,'员工餐')=0`).map(withDishMenuSku);
    const menuById = new Map(menus.map(menu => [Number(menu.id), menu]));
    // 手工绑定可能指向已下架菜品，也要查得到成本
    const manualIds = [...new Set(groups.map(g => Number(g.menu_item_id)).filter(Boolean))].filter(id => !menuById.has(id));
    if (manualIds.length) {
      db.queryAll(`SELECT id,name,category,method,spec,spec_unit,spec_weight,cost,skuid FROM menu_items
        WHERE id IN (${manualIds.map(() => '?').join(',')})`, manualIds)
        .map(withDishMenuSku).forEach(menu => menuById.set(Number(menu.id), menu));
    }
    const dishMenuKey = value => String(value || '').replace(/[【】\[\]（）()\s]/g, '').trim();
    const menuBySkuid = new Map(menus.filter(menu => String(menu.skuid || '').trim()).map(menu => [String(menu.skuid).trim(), menu]));
    const menusByName = new Map();
    const menusByNameSpec = new Map();
    menus.forEach(menu => {
      const nameKey = dishMenuKey(menu.name);
      menusByName.set(nameKey, [...(menusByName.get(nameKey) || []), menu]);
      const specKey = `${nameKey}|${normalizeDishSpec(menu.spec)}`;
      menusByNameSpec.set(specKey, [...(menusByNameSpec.get(specKey) || []), menu]);
    });
    const onlyOne = list => (list && list.length === 1 ? list[0] : null);
    const round2 = value => Math.round(value * 100) / 100;
    const items = groups.map(group => {
      const nameKey = dishMenuKey(group.product_name);
      const coded = menuBySkuid.get(String(group.product_code || '').trim());
      // 编码与名称互相校验，避免把「金牌烧鸭饭」错归到另一道菜
      const byCode = coded && dishMenuKey(coded.name) === nameKey ? coded : null;
      const menu = menuById.get(Number(group.menu_item_id))
        || byCode
        || onlyOne(menusByNameSpec.get(`${nameKey}|${normalizeDishSpec(group.spec)}`))
        || onlyOne(menusByName.get(nameKey))
        || null;
      const quantity = Number(group.quantity) || 0;
      const income = Number(group.income_amount) || 0;
      const unitCost = menu ? Number(menu.cost) || 0 : 0;
      return {
        ...group,
        mapped: !!menu,
        mapping_id: group.mapping_id || null,
        auto_matched: !!menu && !group.mapping_id,
        menu_item_id: menu ? menu.id : null,
        menu_name: menu ? menu.name : '',
        menu_category: menu ? menu.category : '',
        menu_sku_label: menu ? menu.sku_label : '',
        menu_sku_variant: menu ? menu.sku_variant : '',
        menu_sku_price_summary: menu ? menu.sku_price_summary : '',
        unit_cost: unitCost,
        cost_available: menu ? 1 : 0,
        estimated_cost: menu ? round2(quantity * unitCost) : null,
        net_income: menu ? round2(income - quantity * unitCost) : null,
      };
    });
    // 已关联的排前面，未关联的自动沉到列表末尾（与外卖/团购看板一致），再按所选指标倒序。
    items.sort((a, b) => Number(b.mapped) - Number(a.mapped)
      || (Number(b[sortKey]) || 0) - (Number(a[sortKey]) || 0));
    const total = items.length;
    const mappedItems = items.filter(item => item.mapped);
    const summaryRow = db.queryOne(`
      SELECT COUNT(DISTINCT d.product_code) as product_count,
        SUM(d.quantity) as quantity,
        SUM(d.amount_total) as amount_total,
        SUM(d.discount_amount) as discount_amount,
        SUM(d.income_amount) as income_amount,
        SUM(d.refund_amount) as refund_amount,
        COUNT(DISTINCT d.order_no) as order_count
      FROM dish_sales d ${where}`, params) || {};
    const summary = {
      ...summaryRow,
      // 订单量是全区间去重值，不能由分组行相加；成本三项则按识别后的本地菜品汇总。
      cost_covered_product_count: mappedItems.length,
      estimated_cost: round2(mappedItems.reduce((sum, item) => sum + Number(item.estimated_cost || 0), 0)),
      net_income: round2(mappedItems.reduce((sum, item) => sum + Number(item.net_income || 0), 0)),
    };
    // 按下单时刻聚合，固定补齐 00:00–23:00，便于跨日、周、月观察高峰时段。
    const hourlyRows = db.queryAll(`
      SELECT substr(order_time, 12, 2) as hour,
        COUNT(DISTINCT CASE
          WHEN TRIM(COALESCE(order_no, '')) <> '' THEN COALESCE(NULLIF(TRIM(store_name), ''), '未知门店') || '|' || TRIM(order_no)
          ELSE '__row__' || id
        END) as order_count
      FROM dish_sales ${where} AND length(order_time) >= 13
      GROUP BY substr(order_time, 12, 2)`, params);
    const hourlyMap = new Map(hourlyRows.map(row => [String(row.hour || '').padStart(2, '0'), Number(row.order_count) || 0]));
    const hourly_trend = Array.from({ length: 24 }, (_, hour) => {
      const key = String(hour).padStart(2, '0');
      return { hour, period: `${key}:00`, order_count: hourlyMap.get(key) || 0 };
    });
    const pageItems = items.slice((pg - 1) * psize, pg * psize);
    res.json({ ok: true, summary, top: pageItems, total, page: pg, page_size: psize, hourly_trend });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 分页查询：支持关键字（门店/菜品名/编码）、退款状态、下单时间范围筛选
app.get('/api/dish-sales', (req, res) => {
  try {
    const { keyword, refunded, date_from, date_to, page = 1, page_size = 20 } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (keyword) {
      where += ' AND (store_name LIKE ? OR product_name LIKE ? OR product_code LIKE ?)';
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    if (refunded !== undefined && refunded !== '') { where += ' AND refunded=?'; params.push(refunded); }
    if (date_from) { where += ' AND order_time>=?'; params.push(date_from); }
    if (date_to) { where += ' AND order_time<=?'; params.push(date_to); }
    const total = db.queryOne(`SELECT COUNT(*) as cnt FROM dish_sales ${where}`, params).cnt;
    const psize = Math.min(200, Math.max(1, parseInt(page_size) || 20));
    const pg = Math.max(1, parseInt(page) || 1);
    const rows = db.queryAll(`SELECT * FROM dish_sales ${where} ORDER BY order_time DESC, id DESC LIMIT ? OFFSET ?`, [...params, psize, (pg - 1) * psize]);
    res.json({ ok: true, items: rows, total, page: pg, page_size: psize });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 销售汇总：总记录数、金额合计、优惠合计、收入合计、退款笔数
app.get('/api/dish-sales/stats', (req, res) => {
  try {
    const row = db.queryOne(`
      SELECT
        COUNT(*) as count,
        COALESCE(SUM(amount_total),0) as amount_total,
        COALESCE(SUM(discount_amount),0) as discount_amount,
        COALESCE(SUM(income_amount),0) as income_amount,
        COALESCE(SUM(CASE WHEN refunded IN ('是','1','部分退') THEN 1 ELSE 0 END),0) as refund_count,
        COALESCE(SUM(refund_amount),0) as refund_amount
      FROM dish_sales
    `);
    res.json({ ok: true, stats: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 菜品核算（禽类消耗反推）=====
// 挂在「菜品管理」下的临时位置，功能打通后整体迁往「成本核算」：
// 迁移时只需改前端 tab id 前缀与路由 path，本组接口路径改为 /api/cost-accounting/poultry-* 即可，业务逻辑零改动。
app.get('/api/poultry/species', (req, res) => {
  try { res.json({ ok: true, birds: poultryAccounting.listBirds(), animals: poultryAccounting.ANIMALS }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/poultry/species', (req, res) => {
  try { res.json({ ok: true, ...poultryAccounting.createBird(req.body) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/poultry/species/:id', (req, res) => {
  try { res.json({ ok: true, ...poultryAccounting.updateBird(Number(req.params.id), req.body) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/poultry/species/:id', (req, res) => {
  try { res.json({ ok: true, ...poultryAccounting.deleteBird(Number(req.params.id)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/poultry/yields', (req, res) => {
  try { res.json({ ok: true, yields: poultryAccounting.listYields(Number(req.query.bird_id) || 0) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/poultry/yields/:birdId', (req, res) => {
  try { res.json({ ok: true, ...poultryAccounting.saveYields(Number(req.params.birdId), req.body?.rows) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/poultry/yields/:id', (req, res) => {
  try { res.json({ ok: true, ...poultryAccounting.deleteYield(Number(req.params.id)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/poultry/dish-usage', (req, res) => {
  try {
    const menuItemId = Number(req.query.menu_item_id) || 0;
    if (menuItemId) return res.json({ ok: true, ...poultryAccounting.listUsageByMenu(menuItemId) });
    res.json({ ok: true, ...poultryAccounting.listUsageOverview(req.query) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/poultry/dish-usage/:menuItemId', (req, res) => {
  try { res.json({ ok: true, ...poultryAccounting.saveUsageForMenu(Number(req.params.menuItemId), req.body?.rows) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// 批量关联：按分组勾选多个菜品，一次套用同一套「部位 × 每份耗用」
app.post('/api/poultry/dish-usage/batch', (req, res) => {
  try { res.json(poultryAccounting.batchSaveUsage(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/poultry/dish-usage/configured', (req, res) => {
  try { res.json({ ok: true, items: poultryAccounting.listConfiguredMenus() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/poultry/accounting', (req, res) => {
  try { res.json(poultryAccounting.calculate(req.query)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/poultry/accounting/purchase-comparison', (req, res) => {
  try { res.json(poultryAccounting.purchaseComparison(req.query)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/poultry/purchases', (req, res) => {
  try { res.json({ ok: true, purchases: poultryAccounting.listPurchases(req.query) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/poultry/purchases', (req, res) => {
  try { res.json({ ok: true, ...poultryAccounting.savePurchase(req.body) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/poultry/purchases/:id', (req, res) => {
  try { res.json({ ok: true, ...poultryAccounting.deletePurchase(Number(req.params.id)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/poultry/template', (req, res) => {
  try {
    res.json({
      ok: true,
      file_name: '菜品核算-禽类出成与耗用模板.xlsx',
      data: poultryAccounting.buildTemplateWorkbook().toString('base64'),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/poultry/import', (req, res) => {
  try {
    const { filename, data } = req.body || {};
    if (!data) return res.status(400).json({ error: '缺少文件数据' });
    const buffer = Buffer.from(String(data).replace(/^data:[^,]+,/, ''), 'base64');
    if (!buffer.length) return res.status(400).json({ error: '文件内容为空' });
    const result = poultryAccounting.importWorkbook(buffer);
    console.log(`[poultry import] ${filename || '未命名.xlsx'}: 禽类 ${result.birds} / 出成 ${result.yields} / 耗用 ${result.usage} / 异常 ${result.error_count}`);
    res.json({ ok: true, ...result, filename: filename || '' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 模板列表
app.get('/api/menu-templates', (req, res) => {
  try { const rows = db.queryAll("SELECT * FROM menu_templates ORDER BY updated_at DESC"); res.json({ ok: true, templates: rows }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// 创建模板
app.post('/api/menu-templates', (req, res) => {
  try { const { name, remark } = req.body; const cleanName = String(name || '').trim(); if (!cleanName) return res.status(400).json({ error: '模板名称不能为空' }); const id = db.insert("INSERT INTO menu_templates (name,remark) VALUES (?,?)", [cleanName, remark || '']); db.save(); res.json({ ok: true, id, name: cleanName }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// 更新模板
app.put('/api/menu-templates/:id', (req, res) => {
  try { const { name, remark } = req.body; const sets = [], params = []; if (name !== undefined) { sets.push('name=?'); params.push(String(name).trim()); } if (remark !== undefined) { sets.push('remark=?'); params.push(remark); } if (!sets.length) return res.status(400).json({ error: '没有要更新的字段' }); sets.push("updated_at=datetime('now','localtime')"); params.push(req.params.id); db.run(`UPDATE menu_templates SET ${sets.join(',')} WHERE id=?`, params); db.save(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// 删除模板
app.delete('/api/menu-templates/:id', (req, res) => {
  try { db.run('DELETE FROM menu_template_items WHERE template_id=?', [req.params.id]); db.run('DELETE FROM menu_templates WHERE id=?', [req.params.id]); db.save(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// 获取模板详情（含菜品列表 + 系统成本参考）
app.get('/api/menu-templates/:id', (req, res) => {
  try {
    const template = db.queryOne('SELECT * FROM menu_templates WHERE id=?', [req.params.id]);
    if (!template) return res.status(404).json({ error: '模板不存在' });
    const items = db.queryAll('SELECT * FROM menu_template_items WHERE template_id=? ORDER BY sort_order, id', [req.params.id]);
    // 附带系统成本：对每个 item 查找同名菜品的最新成本
    const costMap = {};
    db.queryAll("SELECT name, cost FROM menu_items WHERE cost > 0").forEach(row => { if (!costMap[row.name] || costMap[row.name] < row.cost) costMap[row.name] = row.cost; });
    const itemsWithCost = items.map(item => ({ ...item, system_cost: costMap[item.name] || 0 }));
    res.json({ ok: true, template, items: itemsWithCost });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 添加菜品到模板
app.post('/api/menu-templates/:id/items', (req, res) => {
  try {
    const template = db.queryOne('SELECT id FROM menu_templates WHERE id=?', [req.params.id]);
    if (!template) return res.status(404).json({ error: '模板不存在' });
    const { name, category, dine_in_price, member_price, takeout_price } = req.body;
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ error: '菜品名称不能为空' });
    const maxSort = db.queryOne('SELECT MAX(sort_order) as mx FROM menu_template_items WHERE template_id=?', [req.params.id]);
    const id = db.insert('INSERT INTO menu_template_items (template_id,name,category,dine_in_price,member_price,takeout_price,sort_order) VALUES (?,?,?,?,?,?,?)', [req.params.id, cleanName, category || '', Number(dine_in_price) || 0, Number(member_price) || 0, Number(takeout_price) || 0, (maxSort?.mx ?? -1) + 1]);
    db.run("UPDATE menu_templates SET updated_at=datetime('now','localtime') WHERE id=?", [req.params.id]);
    db.save();
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 编辑模板菜品
app.put('/api/menu-templates/:id/items/:itemId', (req, res) => {
  try {
    const item = db.queryOne('SELECT * FROM menu_template_items WHERE id=? AND template_id=?', [req.params.itemId, req.params.id]);
    if (!item) return res.status(404).json({ error: '菜品不存在' });
    const fields = ['name', 'category', 'dine_in_price', 'member_price', 'takeout_price'];
    const sets = [], params = [];
    fields.forEach(f => { if (req.body[f] !== undefined) { sets.push(`${f}=?`); params.push(f === 'name' ? String(req.body[f]).trim() : req.body[f]); } });
    if (!sets.length) return res.status(400).json({ error: '没有要更新的字段' });
    params.push(req.params.itemId);
    db.run(`UPDATE menu_template_items SET ${sets.join(',')} WHERE id=?`, params);
    db.run("UPDATE menu_templates SET updated_at=datetime('now','localtime') WHERE id=?", [req.params.id]);
    db.save();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 删除模板菜品
app.delete('/api/menu-templates/:id/items/:itemId', (req, res) => {
  try { db.run('DELETE FROM menu_template_items WHERE id=? AND template_id=?', [req.params.itemId, req.params.id]); db.run("UPDATE menu_templates SET updated_at=datetime('now','localtime') WHERE id=?", [req.params.id]); db.save(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 耗材消耗 =====
app.get('/api/supplies', (req, res) => {
  try { const { store_id, date_from, date_to, limit } = req.query; let sql = 'SELECT * FROM store_supplies WHERE 1=1'; const params = []; if (store_id) { sql += ' AND store_id=?'; params.push(store_id); } if (date_from) { sql += ' AND date>=?'; params.push(date_from); } if (date_to) { sql += ' AND date<=?'; params.push(date_to); } sql += ' ORDER BY date DESC, id DESC LIMIT ?'; params.push(limit || 100); res.json({ ok: true, rows: db.queryAll(sql, params) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/supplies', (req, res) => {
  try { const { store_id, store_name, date, item, quantity, unit, unit_price } = req.body; if (!item) return res.status(400).json({ error: '耗材名称不能为空' }); const total = (quantity||1) * (unit_price||0); const id = db.insert('INSERT INTO store_supplies (store_id,store_name,date,item,quantity,unit,unit_price,total_cost) VALUES (?,?,?,?,?,?,?,?)', [store_id||null, store_name||'', date||new Date().toISOString().slice(0,10), item, quantity||1, unit||'个', unit_price||0, total]); db.save(); res.json({ ok: true, id, total_cost: total }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/supplies/:id', (req, res) => { try { db.run('DELETE FROM store_supplies WHERE id=?', [req.params.id]); db.save(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/analysis/supplies', (req, res) => {
  try { const { store_id, date_from, date_to } = req.query; let sql = 'SELECT item, SUM(quantity) as total_qty, SUM(total_cost) as total_cost, unit FROM store_supplies WHERE 1=1'; const params = []; if (store_id) { sql += ' AND store_id=?'; params.push(store_id); } if (date_from) { sql += ' AND date>=?'; params.push(date_from); } if (date_to) { sql += ' AND date<=?'; params.push(date_to); } sql += ' GROUP BY item, unit ORDER BY total_cost DESC'; res.json({ ok: true, rows: db.queryAll(sql, params) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 成本核算 =====
app.get('/api/cost-accounting', (req, res) => {
  try { const { store_id, period_type, date } = req.query; let sql = 'SELECT c.*, s.store_name FROM cost_accounting c LEFT JOIN stores s ON c.store_id=s.id WHERE 1=1'; const params = []; if (store_id) { sql += ' AND c.store_id=?'; params.push(store_id); } if (period_type) { sql += ' AND c.period_type=?'; params.push(period_type); } if (date) { sql += ' AND c.date=?'; params.push(date); } sql += ' ORDER BY c.date DESC, c.id DESC'; res.json({ ok: true, rows: db.queryAll(sql, params) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/cost-accounting', (req, res) => {
  try { const { store_id, date, period_type, revenue, discount, actual_revenue, fixed_daily_cost, food_cost, other_cost } = req.body; const net = (actual_revenue||revenue||0) - (fixed_daily_cost||0) - (food_cost||0) - (other_cost||0); const id = db.insert('INSERT INTO cost_accounting (store_id,date,period_type,revenue,discount,actual_revenue,fixed_daily_cost,food_cost,other_cost,net_profit) VALUES (?,?,?,?,?,?,?,?,?,?)', [store_id, date||new Date().toISOString().slice(0,10), period_type||'日', revenue||0, discount||0, actual_revenue||0, fixed_daily_cost||0, food_cost||0, other_cost||0, net]); db.save(); res.json({ ok: true, id, net_profit: net }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/cost-accounting/calculate', (req, res) => {
    try { const { store_id, date } = req.body; if (!store_id) return res.status(400).json({ error: '缺少 store_id' }); const store = db.queryOne('SELECT store_name FROM stores WHERE id=?', [store_id]); if (!store) return res.status(404).json({ error: '门店不存在' }); const calcDate = date || new Date().toISOString().slice(0,10); const report = db.queryOne('SELECT revenue,actual_revenue FROM daily_reports WHERE store_id=? AND date=?', [store_id, calcDate]); const revenue = report ? report.revenue : 0; const actualRevenue = report ? report.actual_revenue : 0; const fixedCosts = db.queryAll('SELECT SUM(amount) as total FROM store_fixed_costs WHERE store_id=?', [store_id]); const monthlyFixed = fixedCosts[0]?.total || 0; const dailyFixed = monthlyFixed / 30; const foodCost = revenue * 0.35; const otherCosts = db.queryAll("SELECT SUM(amount) as total FROM store_operating_costs WHERE store_id=? AND date=?", [store_id, calcDate]); const otherCost = otherCosts[0]?.total || 0; const netProfit = actualRevenue - dailyFixed - foodCost - otherCost; const id = db.insert('INSERT INTO cost_accounting (store_id,date,period_type,revenue,discount,actual_revenue,fixed_daily_cost,food_cost,other_cost,net_profit) VALUES (?,?,?,?,?,?,?,?,?,?)', [store_id, calcDate, '日', revenue, revenue - actualRevenue, actualRevenue, Math.round(dailyFixed*100)/100, Math.round(foodCost*100)/100, otherCost, Math.round(netProfit*100)/100]); db.save(); res.json({ ok: true, id, net_profit: Math.round(netProfit*100)/100, detail: { revenue, actualRevenue, dailyFixed: Math.round(dailyFixed*100)/100, foodCost: Math.round(foodCost*100)/100, otherCost } }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
// 周/月成本聚合
app.get('/api/cost-accounting/weekly', (req, res) => {
  try { const { store_id, date_from, date_to } = req.query; let sql = "SELECT store_id, strftime('%Y-W%W', date) as week, SUM(revenue) as revenue, SUM(actual_revenue) as actual_revenue, SUM(fixed_daily_cost) as fixed_daily_cost, SUM(food_cost) as food_cost, SUM(other_cost) as other_cost, SUM(net_profit) as net_profit FROM cost_accounting WHERE period_type='日'"; const params = []; if (store_id) { sql += ' AND store_id=?'; params.push(store_id); } if (date_from) { sql += ' AND date>=?'; params.push(date_from); } if (date_to) { sql += ' AND date<=?'; params.push(date_to); } sql += ' GROUP BY week ORDER BY week DESC LIMIT 20'; res.json({ ok: true, rows: db.queryAll(sql, params) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/cost-accounting/monthly', (req, res) => {
  try { const { store_id, date_from, date_to } = req.query; let sql = "SELECT store_id, strftime('%Y-%m', date) as month, SUM(revenue) as revenue, SUM(actual_revenue) as actual_revenue, SUM(fixed_daily_cost) as fixed_daily_cost, SUM(food_cost) as food_cost, SUM(other_cost) as other_cost, SUM(net_profit) as net_profit FROM cost_accounting WHERE period_type='日'"; const params = []; if (store_id) { sql += ' AND store_id=?'; params.push(store_id); } if (date_from) { sql += ' AND date>=?'; params.push(date_from); } if (date_to) { sql += ' AND date<=?'; params.push(date_to); } sql += ' GROUP BY month ORDER BY month DESC LIMIT 12'; res.json({ ok: true, rows: db.queryAll(sql, params) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 日报入库 =====
app.get('/api/reports/daily/db', (req, res) => {
  try { const { store_id, date, date_from, date_to, limit } = req.query; let sql = 'SELECT * FROM daily_reports WHERE 1=1'; const params = []; if (store_id) { sql += ' AND store_id=?'; params.push(store_id); } if (date) { sql += ' AND date=?'; params.push(date); } if (date_from) { sql += ' AND date>=?'; params.push(date_from); } if (date_to) { sql += ' AND date<=?'; params.push(date_to); } sql += ' ORDER BY date DESC LIMIT ?'; params.push(limit || 100); res.json({ ok: true, rows: db.queryAll(sql, params) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/reports/daily/import', (req, res) => {
  try { const stores = parseDailyExcel(); let imported = 0; for (const s of stores) { const matched = db.queryOne("SELECT id FROM stores WHERE store_name LIKE ? LIMIT 1", ['%'+s.storeName+'%']); if (!matched) continue; db.run('INSERT OR REPLACE INTO daily_reports (store_id,store_name,date,revenue,actual_revenue,order_count,instore,pickup,mt_waimai,tb_flash,jd_waimai,mt_pay,mt_tuan,dy_tuan,stored_value,coupon,discount_amount,discount_rate) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [matched.id, s.storeName, s.date, s.revenue, s.actualRevenue, s.orderCount, s.raw?.instore||0, s.raw?.pickup||0, s.raw?.mtWaimai||0, s.raw?.tbFlash||0, s.raw?.jdWaimai||0, s.raw?.mtPay||0, s.raw?.mtTuan||0, s.raw?.dyTuan||0, s.raw?.stored||0, s.raw?.coupon||0, s.discountAmount, s.discountRate]); imported++; } db.save(); res.json({ ok: true, message: `已导入 ${imported} 条日报` }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 仪表盘统计 =====
app.get('/api/dashboard/stats', (req, res) => {
  try { const storeCount = db.queryOne('SELECT COUNT(*) as cnt FROM stores').cnt; const activeStores = db.queryOne("SELECT COUNT(*) as cnt FROM stores WHERE status='正常营业'").cnt; const employeeCount = db.queryOne("SELECT COUNT(*) as cnt FROM employees WHERE status='在职'").cnt; const menuCount = db.queryOne("SELECT COUNT(*) as cnt FROM menu_items WHERE status='在售'").cnt; const pushSuccess = db.queryOne("SELECT COUNT(*) as cnt FROM push_logs WHERE status='success'").cnt; const pushTotal = db.queryOne('SELECT COUNT(*) as cnt FROM push_logs').cnt; res.json({ ok: true, stats: { storeCount, activeStores, employeeCount, menuCount, pushSuccess, pushTotal, pushRate: pushTotal ? Math.round(pushSuccess/pushTotal*100) : 0 } }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 推送日志 =====
app.get('/api/push-logs', (req, res) => { try { const { status, limit } = req.query; let sql = 'SELECT * FROM push_logs WHERE 1=1'; const params = []; if (status) { sql += ' AND status=?'; params.push(status); } sql += ' ORDER BY id DESC LIMIT ?'; params.push(limit || 50); res.json({ ok: true, logs: db.queryAll(sql, params) }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/push-logs', (req, res) => { try { const { push_type, target, content_preview, status, error_msg } = req.body; const id = db.insert('INSERT INTO push_logs (push_type,target,content_preview,status,error_msg) VALUES (?,?,?,?,?)', [push_type||'', target||'', content_preview||'', status||'success', error_msg||'']); db.save(); res.json({ ok: true, id }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ===== 认证 =====
app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
    const hash = crypto.createHash('md5').update(password).digest('hex');
    const user = db.queryOne(`SELECT u.id,u.username,u.role,u.display_name,u.phone,u.avatar_url,u.store_id,s.store_name
      FROM users u LEFT JOIN stores s ON u.store_id=s.id WHERE u.username=? AND u.password_hash=?`, [username, hash]);
    if (!user) return res.status(401).json({ error: '用户名或密码错误' });
    const token = jwt.sign({
      id: user.id,
      username: user.username,
      role: user.role,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      store_id: user.store_id,
      store_name: user.store_name || '',
    }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.json({ ok: true, token, user });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', (req, res) => {
  // 补充最新的 store 信息
  const u = req.user;
  if (u.store_id) {
    const s = db.queryOne('SELECT store_name FROM stores WHERE id=?', [u.store_id]);
    if (s) u.store_name = s.store_name;
  }
  res.json({ ok: true, user: u });
});

// ===== 记账本 =====

function getBookkeepingStore(req) {
  if (req.user.store_id) return { store_id: req.user.store_id, store_name: req.user.store_name || '' };
  return { store_id: null, store_name: '' };
}

// 大类 CRUD
app.get('/api/bookkeeping/categories', (req, res) => {
  try {
    const rows = db.queryAll(`
      SELECT c.*, COUNT(s.id) AS subcategory_count
      FROM bookkeeping_categories c
      LEFT JOIN bookkeeping_subcategories s ON s.category_id = c.id
      GROUP BY c.id
      ORDER BY c.sort_order, c.id
    `);
    res.json({ ok: true, categories: rows });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/bookkeeping/categories', (req, res) => {
  try { const name = String(req.body.name || '').trim(); if (!name) return res.status(400).json({ error: '分类名称不能为空' }); const id = db.insert('INSERT INTO bookkeeping_categories (name,sort_order) VALUES (?,?)', [name, req.body.sort_order || 0]); db.save(); res.json({ ok: true, id }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/bookkeeping/categories/:id', (req, res) => {
  try { const sets = [], params = []; ['name','sort_order'].forEach(f => { if (req.body[f] !== undefined) { sets.push(`${f}=?`); params.push(req.body[f]); } }); if (!sets.length) return res.status(400).json({ error: '没有要更新的字段' }); params.push(req.params.id); db.run(`UPDATE bookkeeping_categories SET ${sets.join(',')} WHERE id=?`, params); db.save(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/bookkeeping/categories/:id', (req, res) => {
  try { db.run('DELETE FROM bookkeeping_subcategories WHERE category_id=?', [req.params.id]); db.run('DELETE FROM bookkeeping_categories WHERE id=?', [req.params.id]); db.save(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 小类 CRUD
app.get('/api/bookkeeping/subcategories', (req, res) => {
  try { const { category_id } = req.query; let sql = 'SELECT * FROM bookkeeping_subcategories'; const params = []; if (category_id) { sql += ' WHERE category_id=?'; params.push(category_id); } sql += ' ORDER BY sort_order, id'; res.json({ ok: true, subcategories: db.queryAll(sql, params) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/bookkeeping/subcategories', (req, res) => {
  try { const { category_id, name, sort_order } = req.body; if (!category_id) return res.status(400).json({ error: '请指定所属大类' }); const cleanName = String(name || '').trim(); if (!cleanName) return res.status(400).json({ error: '小类名称不能为空' }); const id = db.insert('INSERT INTO bookkeeping_subcategories (category_id,name,sort_order) VALUES (?,?,?)', [category_id, cleanName, sort_order || 0]); db.save(); res.json({ ok: true, id }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/bookkeeping/subcategories/:id', (req, res) => {
  try { const sets = [], params = []; ['name','category_id','sort_order'].forEach(f => { if (req.body[f] !== undefined) { sets.push(`${f}=?`); params.push(req.body[f]); } }); if (!sets.length) return res.status(400).json({ error: '没有要更新的字段' }); params.push(req.params.id); db.run(`UPDATE bookkeeping_subcategories SET ${sets.join(',')} WHERE id=?`, params); db.save(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/bookkeeping/subcategories/:id', (req, res) => {
  try { db.run('DELETE FROM bookkeeping_subcategories WHERE id=?', [req.params.id]); db.save(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 记账记录 CRUD
app.get('/api/bookkeeping/entries', (req, res) => {
  try {
    const { store_id } = getBookkeepingStore(req);
    const { date_from, date_to, category_id, subcategory_id, aggregate, page = 1, page_size = 50 } = req.query;
    let sql = 'SELECT * FROM bookkeeping_entries WHERE 1=1';
    const params = [];
    if (store_id) { sql += ' AND store_id=?'; params.push(store_id); }
    else if (req.query.store_ids) {
      const storeIds = String(req.query.store_ids).split(',').map(Number).filter(id => Number.isInteger(id) && id > 0);
      if (storeIds.length) { sql += ` AND store_id IN (${storeIds.map(() => '?').join(',')})`; params.push(...storeIds); }
    }
    else if (req.query.store_id) { sql += ' AND store_id=?'; params.push(req.query.store_id); }
    if (date_from) { sql += ' AND date>=?'; params.push(date_from); }
    if (date_to) { sql += ' AND date<=?'; params.push(date_to); }
    if (category_id) { sql += ' AND category_id=?'; params.push(category_id); }
    if (subcategory_id) { sql += ' AND subcategory_id=?'; params.push(subcategory_id); }
    if (aggregate === 'summary') {
      sql = sql.replace('SELECT *', 'SELECT category_id, category_name, subcategory_id, subcategory_name, SUM(amount) as total_amount, COUNT(*) as entry_count');
      sql += ' GROUP BY category_id, category_name, subcategory_id, subcategory_name ORDER BY category_name ASC, subcategory_name ASC';
      const rows = db.queryAll(sql, params);
      return res.json({ ok: true, rows, aggregate: 'summary' });
    }
    const total = db.queryOne(`SELECT COUNT(*) AS count FROM bookkeeping_entries ${sql.slice(sql.indexOf('WHERE'))}`, params)?.count || 0;
    const psize = Math.min(200, Math.max(10, Number(page_size) || 50));
    const pg = Math.max(1, Number(page) || 1);
    sql += ' ORDER BY date DESC, id DESC LIMIT ? OFFSET ?';
    res.json({ ok: true, entries: db.queryAll(sql, [...params, psize, (pg - 1) * psize]), total, page: pg, page_size: psize });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function cleanQuickBookkeepingCell(value) {
  return String(value ?? '').replace(/\*\*/g, '').replace(/`/g, '').trim();
}

function normalizeQuickBookkeepingName(value) {
  return cleanQuickBookkeepingCell(value)
    .replace(/\s+/g, '')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')');
}

function parseQuickBookkeepingText(text) {
  const rows = [];
  const errors = [];
  String(text || '').split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    let cells;
    if (line.includes('|')) {
      cells = line.split('|').map(cleanQuickBookkeepingCell);
      if (!cells[0]) cells.shift();
      if (!cells[cells.length - 1]) cells.pop();
    } else {
      cells = line.split(/\t+/).map(cleanQuickBookkeepingCell);
    }
    const compact = cells.filter(Boolean);
    if (!compact.length || compact.some(cell => /^(序号|门店名称|大类|小类|金额)$/.test(cell))) return;
    if (compact.every(cell => /^[-—:：]+$/.test(cell))) return;
    if (/^\d+$/.test(cells[0] || '')) cells.shift();
    if (cells.length < 4) {
      errors.push({ line: index + 1, message: '字段不足，请按「门店名称、大类、小类、金额」粘贴' });
      return;
    }
    const [store_name, category_name, subcategory_name, amount_text] = cells;
    const amount = Number(String(amount_text || '').replace(/[¥￥,，\s]/g, ''));
    if (!store_name || !category_name || !subcategory_name || !Number.isFinite(amount)) {
      errors.push({ line: index + 1, message: '门店、大类、小类或金额格式不正确' });
      return;
    }
    rows.push({ line: index + 1, store_name, category_name, subcategory_name, amount });
  });
  return { rows, errors };
}

function resolveQuickBookkeepingRows(req, text) {
  const parsed = parseQuickBookkeepingText(text);
  const stores = db.queryAll('SELECT id, store_name FROM stores');
  const storeMap = new Map(stores.map(store => [normalizeQuickBookkeepingName(store.store_name), store]));
  const scopedStoreId = req.user.store_id || null;
  const rows = [];
  const errors = [...parsed.errors];
  parsed.rows.forEach(row => {
    const store = storeMap.get(normalizeQuickBookkeepingName(row.store_name));
    if (!store) {
      errors.push({ line: row.line, message: `未找到门店「${row.store_name}」` });
      return;
    }
    if (scopedStoreId && Number(store.id) !== Number(scopedStoreId)) {
      errors.push({ line: row.line, message: '当前账号只能录入所属门店的数据' });
      return;
    }
    rows.push({ ...row, store_id: store.id, store_name: store.store_name });
  });
  if (!rows.length && !errors.length) errors.push({ line: 0, message: '未识别到可录入的数据行' });
  return { rows, errors };
}

app.post('/api/bookkeeping/quick-entry/preview', (req, res) => {
  try {
    const { rows, errors } = resolveQuickBookkeepingRows(req, req.body.text);
    res.json({ ok: true, rows, errors, valid_count: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * 记账重复检测：同店、同日、同大类、同小类、金额一致的已存在记录视为重复。
 * rows: [{ store_id, date, category_name, subcategory_name, amount }]
 * 返回去重后的重复样本 [{date, store_name, category_name, subcategory_name, amount}]
 */
function findBookkeepingDuplicates(db, rows) {
  const seen = new Set();
  const duplicates = [];
  (rows || []).forEach(row => {
    if (!row.store_id || !row.date) return;
    const amount = Number(row.amount) || 0;
    const cat = String(row.category_name || '').trim();
    const sub = String(row.subcategory_name || '').trim();
    const key = `${row.store_id}|${row.date}|${cat}|${sub}|${amount.toFixed(2)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const hit = db.queryOne(`SELECT date, store_name, category_name, subcategory_name, amount
      FROM bookkeeping_entries
      WHERE store_id=? AND date=? AND category_name=? AND subcategory_name=? AND ABS(amount-?)<0.005
      LIMIT 1`, [row.store_id, row.date, cat, sub, amount]);
    if (hit) duplicates.push({ date: hit.date, store_name: hit.store_name, category_name: hit.category_name, subcategory_name: hit.subcategory_name, amount: Number(hit.amount) });
  });
  return duplicates;
}

app.post('/api/bookkeeping/quick-entry/commit', (req, res) => {
  try {
    const date = String(req.body.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '请选择归属日期' });
    const { rows, errors } = resolveQuickBookkeepingRows(req, req.body.text);
    if (errors.length) return res.status(400).json({ error: '数据校验未通过，请先修正后重新解析', errors });
    // 去重校验：与已有记录重复时提示（force=true 放行）
    if (!req.body.force) {
      const duplicates = findBookkeepingDuplicates(db, rows.map(row => ({ ...row, date })));
      if (duplicates.length) {
        return res.status(409).json({
          error: `检测到 ${duplicates.length} 条与已有记账重复的记录（同店/同日/同分类/同金额），请确认是否仍要录入`,
          code: 'DUPLICATE_BOOKKEEPING', duplicates,
        });
      }
    }
    const categories = db.queryAll('SELECT * FROM bookkeeping_categories');
    const categoryMap = new Map(categories.map(item => [normalizeQuickBookkeepingName(item.name), item]));
    const subcategoryMap = new Map();
    db.queryAll('SELECT * FROM bookkeeping_subcategories').forEach(item => {
      subcategoryMap.set(`${item.category_id}:${normalizeQuickBookkeepingName(item.name)}`, item);
    });
    let createdCategories = 0;
    let createdSubcategories = 0;
    rows.forEach(row => {
      const categoryKey = normalizeQuickBookkeepingName(row.category_name);
      let category = categoryMap.get(categoryKey);
      if (!category) {
        const id = db.insert('INSERT INTO bookkeeping_categories (name,sort_order) VALUES (?,?)', [row.category_name, 999]);
        category = { id, name: row.category_name };
        categoryMap.set(categoryKey, category);
        createdCategories++;
      }
      const subcategoryKey = `${category.id}:${normalizeQuickBookkeepingName(row.subcategory_name)}`;
      let subcategory = subcategoryMap.get(subcategoryKey);
      if (!subcategory) {
        const id = db.insert('INSERT INTO bookkeeping_subcategories (category_id,name,sort_order) VALUES (?,?,?)', [category.id, row.subcategory_name, 999]);
        subcategory = { id, name: row.subcategory_name };
        subcategoryMap.set(subcategoryKey, subcategory);
        createdSubcategories++;
      }
      db.insert(
        'INSERT INTO bookkeeping_entries (store_id,store_name,user_id,user_name,date,category_id,category_name,subcategory_id,subcategory_name,amount,images,remark) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [row.store_id, row.store_name, req.user.id, req.user.display_name || req.user.username, date,
          category.id, category.name, subcategory.id, subcategory.name, row.amount, '[]', '快捷录入']
      );
    });
    db.save();
    res.json({ ok: true, inserted: rows.length, created_categories: createdCategories, created_subcategories: createdSubcategories });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bookkeeping/entries', (req, res) => {
  try {
    const { store_id, store_name } = getBookkeepingStore(req);
    const { date, category_id, category_name, subcategory_id, subcategory_name, amount, images, remark } = req.body;
    if (!store_id) return res.status(400).json({ error: '您的账号未绑定门店，无法记账' });
    if (!date) return res.status(400).json({ error: '请选择日期' });
    const amt = Number(amount) || 0;
    // 去重校验：与已有记录重复时提示（force=true 放行）
    const catName = String(category_name || '').trim()
      || (category_id ? db.queryOne('SELECT name FROM bookkeeping_categories WHERE id=?', [category_id])?.name : '') || '';
    const subName = String(subcategory_name || '').trim()
      || (subcategory_id ? db.queryOne('SELECT name FROM bookkeeping_subcategories WHERE id=?', [subcategory_id])?.name : '') || '';
    if (!req.body.force) {
      const duplicates = findBookkeepingDuplicates(db, [{ store_id, date, category_name: catName, subcategory_name: subName, amount: amt }]);
      if (duplicates.length) {
        return res.status(409).json({
          error: '该记录与已有记账重复（同店/同日/同分类/同金额），请确认是否仍要录入',
          code: 'DUPLICATE_BOOKKEEPING', duplicates,
        });
      }
    }
    const id = db.insert(
      'INSERT INTO bookkeeping_entries (store_id,store_name,user_id,user_name,date,category_id,category_name,subcategory_id,subcategory_name,amount,images,remark) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [store_id, store_name, req.user.id, req.user.display_name || req.user.username, date,
       category_id || null, category_name || '', subcategory_id || null, subcategory_name || '',
       amt, JSON.stringify(images || []), remark || '']
    );
    db.save();
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/bookkeeping/entries/:id', (req, res) => {
  try {
    const { store_id } = getBookkeepingStore(req);
    const where = store_id ? ' AND store_id=?' : '';
    const params = store_id ? [req.params.id, store_id] : [req.params.id];
    db.run(`DELETE FROM bookkeeping_entries WHERE id=?${where}`, params);
    db.save();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 批量删除（多选 ids）
app.post('/api/bookkeeping/entries/batch-delete', (req, res) => {
  try {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
      .map(Number).filter(id => Number.isInteger(id) && id > 0);
    if (!ids.length) return res.status(400).json({ error: '请选择要删除的记录' });
    const { store_id } = getBookkeepingStore(req);
    let sql = `DELETE FROM bookkeeping_entries WHERE id IN (${ids.map(() => '?').join(',')})`;
    const params = [...ids];
    if (store_id) { sql += ' AND store_id=?'; params.push(store_id); }
    const deleted = db.run(sql, params);
    db.save();
    res.json({ ok: true, deleted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 按日期区间清除（如删除整月数据）
app.post('/api/bookkeeping/entries/purge', (req, res) => {
  try {
    const date_from = String(req.body?.date_from || '').trim();
    const date_to = String(req.body?.date_to || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date_from) || !/^\d{4}-\d{2}-\d{2}$/.test(date_to)) {
      return res.status(400).json({ error: '请提供合法的 date_from / date_to' });
    }
    const { store_id } = getBookkeepingStore(req);
    let sql = 'DELETE FROM bookkeeping_entries WHERE date>=? AND date<=?';
    const params = [date_from, date_to];
    if (store_id) { sql += ' AND store_id=?'; params.push(store_id); }
    const deleted = db.run(sql, params);
    db.save();
    res.json({ ok: true, deleted, date_from, date_to });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 记账本备份/更新覆盖导入：先删除 date >= replace_from 的本地记账，再导入文件（Excel，含 日期/门店名称/大类/小类/金额）
app.post('/api/bookkeeping/import-replace', (req, res) => {
  try {
    const result = ledgerBackupImport.importLedgerBackup(db, req.body || {}, req.user);
    res.status(201).json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ===== 用户管理 =====
function removeAvatarFile(avatarUrl) {
  if (!avatarUrl || !avatarUrl.startsWith('/uploads/avatars/')) return;
  const filename = path.basename(avatarUrl);
  const filePath = path.join(AVATAR_DIR, filename);
  if (path.dirname(filePath) !== AVATAR_DIR) return;
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}
function hasValidImageSignature(buffer, type) {
  if (type === 'png') {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  }
  if (type === 'jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (type === 'webp') {
    return buffer.length >= 12
      && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

app.get('/api/users', (req, res) => {
  try {
    const users = db.queryAll('SELECT id,username,role,display_name,phone,avatar_url,created_at FROM users ORDER BY id');
    res.json({ ok: true, users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const displayName = String(req.body.display_name || '').trim();
    const role = String(req.body.role || '客服').trim();
    const phone = String(req.body.phone || '').trim();
    if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
    if (username.length > 50) return res.status(400).json({ error: '用户名不能超过 50 个字符' });
    if (phone.length > 30) return res.status(400).json({ error: '手机号格式不正确' });
    const hash = crypto.createHash('md5').update(password).digest('hex');
    const id = db.insert(
      'INSERT INTO users (username,password_hash,role,display_name,phone) VALUES (?,?,?,?,?)',
      [username, hash, role, displayName || username, phone]
    );
    db.save();
    res.json({ ok: true, id });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(400).json({ error: '用户名已存在' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/users/:id', (req, res) => {
  try {
    const allowed = ['username', 'role', 'display_name', 'phone'];
    const sets = [];
    const params = [];
    for (const field of allowed) {
      if (req.body[field] === undefined) continue;
      const value = String(req.body[field] ?? '').trim();
      if (field === 'username' && !value) return res.status(400).json({ error: '用户名不能为空' });
      if (field === 'phone' && value.length > 30) return res.status(400).json({ error: '手机号格式不正确' });
      sets.push(`${field}=?`);
      params.push(value);
    }
    if (!sets.length) return res.status(400).json({ error: '没有要更新的字段' });
    params.push(req.params.id);
    db.run(`UPDATE users SET ${sets.join(',')} WHERE id=?`, params);
    db.save();
    res.json({ ok: true });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(400).json({ error: '用户名已存在' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/users/:id/password', (req, res) => {
  try {
    const password = String(req.body.password || '');
    if (password.length < 6) return res.status(400).json({ error: '密码至少需要 6 位' });
    const hash = crypto.createHash('md5').update(password).digest('hex');
    db.run('UPDATE users SET password_hash=? WHERE id=?', [hash, req.params.id]);
    db.save();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users/:id/avatar', (req, res) => {
  try {
    const user = db.queryOne('SELECT id,avatar_url FROM users WHERE id=?', [req.params.id]);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    const dataUrl = String(req.body.data || '');
    const match = dataUrl.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/);
    if (!match) return res.status(400).json({ error: '仅支持 PNG、JPEG 或 WebP 图片' });
    const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
    if (!buffer.length || buffer.length > 2 * 1024 * 1024) {
      return res.status(400).json({ error: '头像大小不能超过 2MB' });
    }
    if (!hasValidImageSignature(buffer, match[1])) {
      return res.status(400).json({ error: '图片文件内容无效' });
    }
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const filename = `user-${Number(req.params.id)}-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(AVATAR_DIR, filename), buffer);
    const avatarUrl = `/uploads/avatars/${filename}`;
    db.run('UPDATE users SET avatar_url=? WHERE id=?', [avatarUrl, req.params.id]);
    db.save();
    removeAvatarFile(user.avatar_url);
    res.json({ ok: true, avatar_url: avatarUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id/avatar', (req, res) => {
  try {
    const user = db.queryOne('SELECT avatar_url FROM users WHERE id=?', [req.params.id]);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    db.run("UPDATE users SET avatar_url='' WHERE id=?", [req.params.id]);
    db.save();
    removeAvatarFile(user.avatar_url);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', (req, res) => {
  try {
    if (Number(req.params.id) === Number(req.user?.id)) {
      return res.status(400).json({ error: '不能删除当前登录账号' });
    }
    const user = db.queryOne('SELECT avatar_url FROM users WHERE id=?', [req.params.id]);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    db.run('DELETE FROM users WHERE id=?', [req.params.id]);
    db.save();
    removeAvatarFile(user.avatar_url);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================================================================
// ===== 协同事项管理 (Collab) — Controller 层 =====================
// ================================================================

/**
 * GET /api/collab/issues
 * 获取事项列表（支持分页、状态筛选、关键词搜索）
 * Query: ?status=待开始|进行中|已完成|未完成|全部 &keyword=xxx &page=1 &pageSize=20
 */
app.get('/api/collab/issues', (req, res) => {
  try {
    const { status, keyword, page, pageSize, phase } = req.query;
    const result = collabService.listIssues({ status, keyword, page, pageSize, phase }, req.user);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/collab/issues/:id
 * 获取事项详情（含完整信息 + 跟进时间线）
 */
app.get('/api/collab/issues/:id', (req, res) => {
  try {
    const result = collabService.getIssueDetail(Number(req.params.id), req.user);
    if (result.error) return res.status(404).json({ error: result.error });
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/collab/issues
 * 发起新事项
 * Body: { title, description, deadline, start_time, participants, participants_name }
 */
app.post('/api/collab/issues', (req, res) => {
  try {
    const result = collabService.createIssue(req.body, req.user);
    if (result.error) return res.status(400).json({ error: result.error });
    db.save();
    res.status(201).json({ ok: true, issue: result.issue });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/collab/issues/:id/participants', (req, res) => {
  try {
    const result = collabService.updateParticipants(Number(req.params.id), req.body.participants || [], req.user);
    if (result.error) return res.status(400).json({ error: result.error });
    db.save(); res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/collab/issues/:id/deadline', (req, res) => {
  try {
    const result = collabService.updateDeadline(Number(req.params.id), req.body.deadline || null, req.user);
    if (result.error) return res.status(400).json({ error: result.error });
    db.save(); res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/collab/issues/:id/archive', (req, res) => {
  try {
    const result = collabService.archiveIssue(Number(req.params.id), req.user);
    if (result.error) return res.status(400).json({ error: result.error });
    db.save(); res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/collab/issues/:id', (req, res) => {
  try {
    const result = collabService.deleteIssue(Number(req.params.id), req.user);
    if (result.error) return res.status(400).json({ error: result.error });
    db.save(); res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/collab/issues/:id/reply
 * 添加跟进回复
 * Body: { content, images[] }
 */
app.post('/api/collab/issues/:id/reply', (req, res) => {
  try {
    const result = collabService.addReply(
      Number(req.params.id),
      req.body.content || '',
      req.body.images || [],
      req.body.type || 'progress',
      req.user,
      req.body.parent_id || null,
      req.body.reply_to_user_id || null,
      req.body.reply_to_name || ''
    );
    if (result.error) return res.status(400).json({ error: result.error });
    db.save();
    res.status(201).json({ ok: true, reply: result.reply, issue: result.issue });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/collab/issues/:id/replies/:replyId', (req, res) => {
  try {
    const result = collabService.editReply(Number(req.params.id), Number(req.params.replyId), req.body.content || '', req.body.images || [], req.user);
    if (result.error) return res.status(400).json({ error: result.error });
    db.save(); res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/collab/issues/:id/completions/:replyId/review', (req, res) => {
  try {
    const result = collabService.reviewCompletion(Number(req.params.id), Number(req.params.replyId), Boolean(req.body.approved), req.body.note || '', req.user);
    if (result.error) return res.status(400).json({ error: result.error });
    db.save(); res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/collab/issues/:id/extensions', (req, res) => {
  try {
    const result = collabService.extendDeadline(Number(req.params.id), req.body.deadline || '', req.body.reason || '', req.user);
    if (result.error) return res.status(400).json({ error: result.error });
    db.save(); res.status(201).json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * PUT /api/collab/issues/:id/advance
 * 推进事项状态（单向不可逆：待开始→进行中→已完成/未完成）
 * Body: { status: '进行中'|'已完成'|'未完成', note: '推进说明' }
 * 权限：仅发起人
 */
app.put('/api/collab/issues/:id/advance', (req, res) => {
  try {
    const result = collabService.advanceStatus(
      Number(req.params.id),
      req.body.status || '',
      req.body.note || '',
      req.user
    );
    if (result.error) return res.status(400).json({ error: result.error });
    db.save();
    res.json({ ok: true, issue: result.issue });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * GET /api/collab/users
 * 获取可选用户列表（用于负责人下拉选择）
 */
app.get('/api/collab/users', (req, res) => {
  try {
    const users = db.queryAll('SELECT id, username, display_name, role FROM users ORDER BY id');
    res.json({ ok: true, users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 数据分析 =====
function monthlyDashboardRange(month, asOf) {
  const matched = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!matched) throw new Error('请选择统计月份');
  const year = Number(matched[1]);
  const monthNumber = Number(matched[2]);
  if (monthNumber < 1 || monthNumber > 12) throw new Error('统计月份格式不正确');
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const start = `${matched[1]}-${matched[2]}-01`;
  const end = `${matched[1]}-${matched[2]}-${String(daysInMonth).padStart(2, '0')}`;
  const cutoff = String(asOf || end);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff) || cutoff < start || cutoff > end) throw new Error('截止日期必须在所选月份内');
  return { month: `${matched[1]}-${matched[2]}`, start, end, cutoff, days_in_month: daysInMonth, elapsed_days: Number(cutoff.slice(-2)) };
}

function previousMonthRange(month) {
  const [year, monthNumber] = String(month).split('-').map(Number);
  const date = new Date(year, monthNumber - 2, 1);
  const text = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  return { month: text, start: `${text}-01`, end: `${text}-${String(new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()).padStart(2, '0')}` };
}

function buildMonthlyDashboardGroups(monthRows, dayRows, type, options = {}) {
  const isExpense = type === 'expense';
  const isStored = type === 'stored';
  const groups = new Map();
  const addRows = (rows, field) => rows.forEach(row => {
    const raw = Number(row.amount || 0);
    if ((isExpense && raw >= 0) || (!isExpense && raw <= 0)) return;
    if (!isExpense && isStored && !isStoredValue(row)) return;
    if (!isExpense && !isStored && isStoredValue(row)) return;
    if (options.excludeRow?.(row)) return;
    const category = row.category_name || '未分类';
    const subcategory = row.subcategory_name || '未分类';
    const key = `${category}\u0000${subcategory}`;
    if (!groups.has(key)) groups.set(key, { category, subcategory, daily_amount: 0, cumulative_amount: 0 });
    groups.get(key)[field] += isExpense ? -raw : raw;
  });
  addRows(monthRows, 'cumulative_amount');
  addRows(dayRows, 'daily_amount');
  if (isExpense) (options.accrualItems || []).forEach(item => {
    const category = item.category;
    const subcategory = item.subcategory;
    const key = `${category}\u0000${subcategory}`;
    if (!groups.has(key)) groups.set(key, { category, subcategory, daily_amount: 0, cumulative_amount: 0 });
    const row = groups.get(key);
    row.daily_amount += Number(item.daily_amount || 0);
    row.cumulative_amount += Number(item.cumulative_amount || 0);
  });
  const categoryMap = new Map();
  groups.forEach(row => {
    if (!categoryMap.has(row.category)) categoryMap.set(row.category, { category: row.category, daily_amount: 0, cumulative_amount: 0, children: [] });
    const group = categoryMap.get(row.category);
    group.daily_amount += row.daily_amount;
    group.cumulative_amount += row.cumulative_amount;
    group.children.push(row);
  });
  const result = [];
  [...categoryMap.values()].sort((a, b) => b.cumulative_amount - a.cumulative_amount).forEach(group => {
    result.push({ category: group.category, subcategory: '', daily_amount: group.daily_amount, cumulative_amount: group.cumulative_amount, is_group: true });
    group.children.sort((a, b) => b.cumulative_amount - a.cumulative_amount).forEach(item => result.push({ ...item, is_group: false }));
  });
  return result;
}

function isStoredValue(row) {
  return String(row.category_name || '') === '会员' || /充值|储值/.test(String(row.subcategory_name || ''));
}

function isBookkeepingWage(row) {
  return /工资|薪资|薪酬/.test(`${row.category_name || ''} ${row.subcategory_name || ''}`);
}

function isRentOrProperty(row) {
  const category = String(row.category_name || '');
  const subcategory = String(row.subcategory_name || '');
  // “店租物水电费”是混合大类，必须以小类判断，避免把“电费”误归为房租。
  if (/水电|水费|电费/.test(subcategory)) return false;
  return /房租|租金|物业|店租/.test(subcategory) || (!subcategory && /房租|租金|物业|店租/.test(category));
}

function isUtilities(row) {
  const category = String(row.category_name || '');
  const subcategory = String(row.subcategory_name || '');
  // “店租物水电费”是混合大类，必须以小类判断，不能把“店租”误归为水电。
  if (/房租|租金|物业|店租/.test(subcategory)) return false;
  const isPropertyCostCategory = /店租|房租|租金|物业|水电/.test(category);
  return isPropertyCostCategory && (/水电|水费|电费/.test(subcategory) || (!subcategory && /水电|水费|电费/.test(category)));
}

function fixedCostTotals(storeId) {
  const where = [];
  const params = [];
  if (storeId) { where.push('store_id=?'); params.push(storeId); }
  const sql = `SELECT cost_type, SUM(amount) AS amount FROM store_fixed_costs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} GROUP BY cost_type`;
  return db.queryAll(sql, params).reduce((totals, row) => {
    const amount = Math.abs(Number(row.amount || 0));
    const text = String(row.cost_type || '');
    if (/房租|租金|物业/.test(text)) totals.rent += amount;
    if (/水电|水费|电费/.test(text)) totals.utilities += amount;
    return totals;
  }, { rent: 0, utilities: 0 });
}

function isBookkeepingSalesRevenue(row) {
  const text = `${row.category_name || ''} ${row.subcategory_name || ''}`;
  return /销售收入|堂食|外带|自提|美团外卖|淘宝闪购|京东(?:外卖|秒送)|抖音团购|美团.*团购|大众点评/.test(text);
}

function isBookkeepingPlatformFee(row) {
  const text = `${row.category_name || ''} ${row.subcategory_name || ''}`;
  return /平台.*费|服务费|佣金|推广费|配送费|保障.*费|履约.*费/.test(text);
}

function appendDashboardVirtualGroup(rows, category, subcategory, dailyAmount, cumulativeAmount) {
  if (!dailyAmount && !cumulativeAmount) return rows;
  const child = { category, subcategory, daily_amount: dailyAmount, cumulative_amount: cumulativeAmount, is_group: false, virtual: true };
  const group = { category, subcategory: '', daily_amount: dailyAmount, cumulative_amount: cumulativeAmount, is_group: true, virtual: true };
  return [group, child, ...rows];
}

// 收入构成不能只显示一个“真实数据销售收入”汇总。这里保留记账本口径下
// 用户关心的收入字段，并以当前选择的收银机/第三方来源填充对应金额。
const SALES_COMPOSITION_CHANNELS = [
  { key: 'store_sales', label: '店内销售', note: '收银机' },
  { key: 'pickup', label: '自提销售', note: '收银机' },
  { key: 'meituan_delivery', label: '美团外卖' },
  { key: 'taobao_flash', label: '淘宝闪购' },
  { key: 'jd_delivery', label: '京东秒送' },
  { key: 'douyin_group', label: '抖音团购' },
  { key: 'meituan_group', label: '美团/大众点评团购' },
];
const GROUP_BUY_COMPOSITION_CHANNELS = new Set(['douyin_group', 'meituan_group']);

function revenueSourceLabel(source) {
  if (source === 'platform') return '第三方数据';
  if (source === 'mixed') return '混合来源';
  return '收银机数据';
}

function buildResolvedIncomeComposition(monthRows, dayRows, resolvedRows, cutoff, revenuePolicy) {
  // 非销售类收入仍然完全来自记账本，避免真实数据视角吞掉其他经营收入。
  const otherIncomeRows = buildMonthlyDashboardGroups(monthRows, dayRows, 'income', { excludeRow: isBookkeepingSalesRevenue });
  const amounts = new Map(SALES_COMPOSITION_CHANNELS.map(item => [item.key, {
    daily_amount: 0, cumulative_amount: 0, sources: new Set(),
  }]));
  const groupStates = new Map([...GROUP_BUY_COMPOSITION_CHANNELS].map(key => [key, {
    requested_platform: revenuePolicy.sourceFor(key) === 'platform', platform_applied: false, fallback_to_pos: false,
  }]));
  // 只有“该团购选择第三方且第三方记录实际可用”时，解析器才会从店内销售
  // 扣掉对应收银机团购金额并加入第三方金额。收银机来源或回退收银机时都不拆分。
  resolvedRows.forEach(row => {
    const state = groupStates.get(row.channel);
    if (!state) return;
    if (row.source_used === 'platform' && !row.exclude_from_sales) state.platform_applied = true;
    if (state.requested_platform && row.source_used !== 'platform') state.fallback_to_pos = true;
  });
  resolvedRows.filter(row => !row.exclude_from_sales).forEach(row => {
    const item = amounts.get(row.channel);
    if (!item) return;
    const income = Number(row.income || 0);
    item.cumulative_amount += income;
    if (row.biz_date === cutoff) item.daily_amount += income;
    item.sources.add(row.source_used === 'platform' ? 'platform' : 'pos');
  });
  const activeGroupStates = SALES_COMPOSITION_CHANNELS
    .filter(meta => GROUP_BUY_COMPOSITION_CHANNELS.has(meta.key))
    .map(meta => ({ ...meta, ...groupStates.get(meta.key) }));
  const removedGroups = activeGroupStates.filter(item => item.platform_applied && !item.fallback_to_pos);
  const partiallyReplacedGroups = activeGroupStates.filter(item => item.platform_applied && item.fallback_to_pos);
  const retainedGroups = activeGroupStates.filter(item => !item.platform_applied || item.fallback_to_pos);
  // 每次请求单独生成店内销售标签，不能改写全局渠道配置。
  const storeSalesMeta = { ...SALES_COMPOSITION_CHANNELS[0] };
  if (removedGroups.length && !retainedGroups.length) {
    storeSalesMeta.label = '纯堂食外带';
    storeSalesMeta.note = '已剔除第三方团购';
  } else if (removedGroups.length || partiallyReplacedGroups.length) {
    storeSalesMeta.label = '店内销售（团购部分替换）';
    const removedNames = [...removedGroups, ...partiallyReplacedGroups].map(item => item.label).join('、');
    const retainedNames = retainedGroups.map(item => item.label).join('、');
    storeSalesMeta.note = retainedNames ? `已替换${removedNames}；仍含${retainedNames}` : `已替换${removedNames}`;
  } else if (activeGroupStates.some(item => item.requested_platform)) {
    storeSalesMeta.label = '店内销售（团购待拆分）';
    storeSalesMeta.note = '第三方团购记录未就绪';
  } else {
    storeSalesMeta.label = '店内销售（含收银机团购）';
    storeSalesMeta.note = '收银机数据';
  }
  const displayChannels = SALES_COMPOSITION_CHANNELS
    .filter(meta => !GROUP_BUY_COMPOSITION_CHANNELS.has(meta.key) || groupStates.get(meta.key).platform_applied)
    .map(meta => meta.key === 'store_sales' ? storeSalesMeta : meta);
  const children = displayChannels.map(meta => {
    const amount = amounts.get(meta.key);
    const source = amount.sources.size > 1 ? 'mixed' : (amount.sources.values().next().value || 'pos');
    return {
      category: '销售收入',
      subcategory: meta.label,
      daily_amount: amount.daily_amount,
      cumulative_amount: amount.cumulative_amount,
      source_label: meta.note || revenueSourceLabel(source),
      source_used: source,
      is_group: false,
      virtual: true,
    };
  });
  const dailyAmount = children.reduce((sum, item) => sum + Number(item.daily_amount || 0), 0);
  const cumulativeAmount = children.reduce((sum, item) => sum + Number(item.cumulative_amount || 0), 0);
  const salesGroup = {
    category: '销售收入', subcategory: '', daily_amount: dailyAmount, cumulative_amount: cumulativeAmount,
    is_group: true, virtual: true,
  };
  return [salesGroup, ...children, ...otherIncomeRows];
}

function buildStoredValueComposition(monthRows, dayRows) {
  const children = buildMonthlyDashboardGroups(monthRows, dayRows, 'stored').filter(row => !row.is_group)
    .map(row => ({ ...row, category: '会员储值', is_group: false }));
  if (!children.length) return [];
  return [{
    category: '会员储值', subcategory: '',
    daily_amount: children.reduce((sum, row) => sum + Number(row.daily_amount || 0), 0),
    cumulative_amount: children.reduce((sum, row) => sum + Number(row.cumulative_amount || 0), 0),
    is_group: true,
  }, ...children];
}

app.get('/api/analysis/monthly-operating-dashboard', (req, res) => {
  try {
    const { month, as_of, store_id } = req.query;
    const view = req.query.view === 'accrual' ? 'accrual' : 'cash';
    const validCostSources = ['operating_previous', 'operating_current', 'bookkeeping'];
    const legacyCostSource = validCostSources.includes(req.query.cost_source) ? req.query.cost_source : null;
    const sourceFor = (key, fallback) => validCostSources.includes(req.query[`${key}_source`])
      ? req.query[`${key}_source`]
      : (legacyCostSource || fallback);
    const costSources = {
      wage: sourceFor('wage', 'operating_previous'),
      rent: sourceFor('rent', 'bookkeeping'),
      utilities: sourceFor('utilities', 'bookkeeping'),
    };
    const period = monthlyDashboardRange(month, as_of);
    const requestedStoreIds = String(req.query.store_ids || store_id || '')
      .split(',').map(Number).filter(id => Number.isInteger(id) && id > 0);
    const scopedStoreIds = req.user.store_id ? [Number(req.user.store_id)] : [...new Set(requestedStoreIds)];
    const appendStoreScope = (where, params, field = 'store_id') => {
      if (!scopedStoreIds.length) return;
      where.push(`${field} IN (${scopedStoreIds.map(() => '?').join(',')})`);
      params.push(...scopedStoreIds);
    };
    const revenueDataView = String(req.query.data_view || 'real') === 'cashier' ? 'cashier' : 'real';
    const isCashierView = revenueDataView === 'cashier';
    const resolvedRevenue = businessAnalytics.getResolvedRevenueByDate(db, {
      date_from: period.start, date_to: period.cutoff, store_ids: scopedStoreIds.join(','),
      data_view: revenueDataView, source_overrides: req.query.source_overrides || '',
    });
    const resolvedSalesByDate = new Map();
    resolvedRevenue.rows.filter(row => !row.exclude_from_sales).forEach(row => {
      const item = resolvedSalesByDate.get(row.biz_date) || { income: 0, settled: 0, fees: 0, gross: 0, orders: 0 };
      item.income += Number(row.income || 0);
      item.settled += Number(row.settled || 0);
      item.fees += Number(row.resolved_fees || 0);
      item.gross += Number(row.gross || 0);
      item.orders += Number(row.orders || 0);
      resolvedSalesByDate.set(row.biz_date, item);
    });
    const resolvedSalesTotals = [...resolvedSalesByDate.values()].reduce((sum, row) => ({
      income: sum.income + row.income, settled: sum.settled + row.settled, fees: sum.fees + row.fees, gross: sum.gross + row.gross, orders: sum.orders + row.orders,
    }), { income: 0, settled: 0, fees: 0, gross: 0, orders: 0 });
    const where = ['date>=?', 'date<=?'];
    const params = [period.start, period.cutoff];
    appendStoreScope(where, params);
    const monthRows = db.queryAll(
      `SELECT category_name, subcategory_name, SUM(amount) AS amount FROM bookkeeping_entries WHERE ${where.join(' AND ')} GROUP BY category_name, subcategory_name`,
      params
    );
    const dayWhere = ['date=?'];
    const dayParams = [period.cutoff];
    appendStoreScope(dayWhere, dayParams);
    const dayRows = db.queryAll(`SELECT category_name, subcategory_name, SUM(amount) AS amount FROM bookkeeping_entries WHERE ${dayWhere.join(' AND ')} GROUP BY category_name, subcategory_name`, dayParams);
    const profitRows = db.queryAll(
      `SELECT date, category_name, subcategory_name, SUM(amount) AS amount FROM bookkeeping_entries WHERE ${where.join(' AND ')} GROUP BY date, category_name, subcategory_name ORDER BY date`,
      params
    );
    const recordedAmount = (matcher) => monthRows.reduce((sum, row) => {
      const amount = Number(row.amount || 0);
      return matcher(row) && amount < 0 ? sum - amount : sum;
    }, 0);
    const ledgerWageAmount = recordedAmount(isBookkeepingWage);
    const ledgerRentAmount = recordedAmount(isRentOrProperty);
    const ledgerUtilitiesAmount = recordedAmount(isUtilities);
    const previousPeriod = previousMonthRange(month);
    const sourceMetaByKey = {
      operating_previous: { label: '门店管理 · 运营成本上月数据', detail: `${previousPeriod.month} 的工资、房租/物业、水电费月度记录` },
      operating_current: { label: '门店管理 · 运营成本本月数据', detail: `${month} 的工资、房租/物业、水电费月度记录` },
      bookkeeping: { label: '记账本记录数据', detail: `按 ${period.start} 至 ${period.cutoff} 的工资、房租/物业、水电记账汇总` },
    };
    const operatingCostTotal = (item, source) => {
      if (source === 'bookkeeping') return 0;
      const targetPeriod = source === 'operating_previous' ? previousPeriod : { start: period.start, end: period.end };
      const costWhere = ['item=?', 'date>=?', 'date<=?'];
      const costParams = [item, targetPeriod.start, targetPeriod.end];
      appendStoreScope(costWhere, costParams);
      return Number(db.queryOne(`SELECT SUM(amount) AS total FROM store_operating_costs WHERE ${costWhere.join(' AND ')}`, costParams)?.total || 0);
    };
    const monthlyWageBasis = costSources.wage === 'bookkeeping' ? ledgerWageAmount : operatingCostTotal('月度工资', costSources.wage);
    const monthlyRentBasis = costSources.rent === 'bookkeeping' ? ledgerRentAmount : operatingCostTotal('月度房租及物业', costSources.rent);
    const monthlyUtilitiesBasis = costSources.utilities === 'bookkeeping' ? ledgerUtilitiesAmount : operatingCostTotal('月度水电费', costSources.utilities);
    const wage = {
      mode: costSources.wage,
      source_month: costSources.wage === 'operating_previous' ? previousPeriod.month : String(month),
      reference_amount: monthlyWageBasis,
      ledger_amount: ledgerWageAmount,
      source: sourceMetaByKey[costSources.wage].label,
      daily_amount: monthlyWageBasis / period.days_in_month,
      cumulative_amount: monthlyWageBasis / period.days_in_month * period.elapsed_days,
      expense_amount: monthlyWageBasis / period.days_in_month * period.elapsed_days,
    };
    const recurringCosts = [
      {
        key: 'wage', category: '人工及福利费', subcategory: '日应计工资', matcher: isBookkeepingWage,
        basis: monthlyWageBasis, ledger_amount: ledgerWageAmount, source_key: costSources.wage, source: sourceMetaByKey[costSources.wage].label,
      },
      {
        key: 'rent', category: '房租及物业费', subcategory: '日应计房租及物业', matcher: isRentOrProperty,
        basis: monthlyRentBasis, ledger_amount: ledgerRentAmount, source_key: costSources.rent,
        source: sourceMetaByKey[costSources.rent].label,
      },
      {
        key: 'utilities', category: '店租物水电费', subcategory: '日应计水电', matcher: isUtilities,
        basis: monthlyUtilitiesBasis, ledger_amount: ledgerUtilitiesAmount, source_key: costSources.utilities,
        source: sourceMetaByKey[costSources.utilities].label,
      },
    ].map(item => ({
      ...item,
      daily_amount: Number(item.basis || 0) / period.days_in_month,
      cumulative_amount: Number(item.basis || 0) / period.days_in_month * period.elapsed_days,
    }));
    // 在经营盈亏口径中，这三类成本始终只由当前选择的数据来源形成日应计，
    // 账本中的同类一次性记录不再额外计入，避免重复计算。
    const recurringMatcher = row => view === 'accrual' && (isBookkeepingWage(row) || isRentOrProperty(row) || isUtilities(row));
    const accrualItems = view === 'accrual'
      ? recurringCosts.map(item => ({
          category: item.category, subcategory: item.subcategory,
          daily_amount: item.daily_amount, cumulative_amount: item.cumulative_amount,
        }))
      : [];
    const profitByDate = new Map();
    profitRows.forEach(row => {
      if (!profitByDate.has(row.date)) profitByDate.set(row.date, { income: 0, expense: 0 });
      const target = profitByDate.get(row.date);
      const amount = Number(row.amount || 0);
      // 收银机视角直接用记账本口径：销售类收入与平台费用都保留在账本里；
      // 真实数据视角才从账本剔除（由平台解析/虚拟分组替代展示）。
      if (amount > 0 && !isStoredValue(row) && (isCashierView || !isBookkeepingSalesRevenue(row))) target.income += amount;
      if (amount < 0 && !recurringMatcher(row) && (isCashierView || !isBookkeepingPlatformFee(row))) target.expense -= amount;
    });
    const dailyProfitSeries = [];
    let cumulativeProfit = 0;
    for (let day = 1; day <= period.elapsed_days; day++) {
      const date = `${String(month)}-${String(day).padStart(2, '0')}`;
      const row = profitByDate.get(date) || {};
      const sales = isCashierView ? {} : (resolvedSalesByDate.get(date) || {});
      const income = Number(row.income || 0) + Number(sales.income || 0);
      const expense = Number(row.expense || 0) + Number(sales.fees || 0) + (view === 'accrual' ? recurringCosts.reduce((sum, item) => sum + Number(item.daily_amount || 0), 0) : 0);
      const dailyNet = income - expense;
      cumulativeProfit += dailyNet;
      dailyProfitSeries.push({ date, day, income, expense, daily_net: dailyNet, cumulative_net: cumulativeProfit });
    }
    const ledgerIncomeTotal = monthRows.reduce((sum, row) => Number(row.amount || 0) > 0 && !isStoredValue(row) ? sum + Number(row.amount) : sum, 0);
    const ledgerFeeTotal = monthRows.reduce((sum, row) => Number(row.amount || 0) < 0 && isBookkeepingPlatformFee(row) ? sum - Number(row.amount) : sum, 0);
    const incomeRows = isCashierView
      ? buildMonthlyDashboardGroups(monthRows, dayRows, 'income')
      : buildResolvedIncomeComposition(monthRows, dayRows, resolvedRevenue.rows, period.cutoff, resolvedRevenue.policy);
    const expenseRows = isCashierView
      ? buildMonthlyDashboardGroups(monthRows, dayRows, 'expense', { excludeRow: recurringMatcher, accrualItems })
      : appendDashboardVirtualGroup(
          buildMonthlyDashboardGroups(monthRows, dayRows, 'expense', { excludeRow: row => recurringMatcher(row) || isBookkeepingPlatformFee(row), accrualItems }),
          '平台费用', '第三方平台费用', Number(resolvedSalesByDate.get(period.cutoff)?.fees || 0), Number(resolvedSalesTotals.fees || 0)
        );
    const storedValueRows = buildStoredValueComposition(monthRows, dayRows);
    const totals = (rows, key) => rows.filter(row => row.is_group).reduce((sum, row) => sum + Number(row[key] || 0), 0);
    const dailyIncome = totals(incomeRows, 'daily_amount');
    const cumulativeIncome = totals(incomeRows, 'cumulative_amount');
    const dailyExpense = totals(expenseRows, 'daily_amount');
    const cumulativeExpense = totals(expenseRows, 'cumulative_amount');
    const storedValue = rows => rows.reduce((sum, row) => isStoredValue(row) && Number(row.amount || 0) > 0 ? sum + Number(row.amount) : sum, 0);
    let storeName = '全门店汇总';
    if (scopedStoreIds.length === 1) {
      const store = db.queryOne('SELECT store_name FROM stores WHERE id=?', [scopedStoreIds[0]]);
      if (!store) return res.status(404).json({ error: '门店不存在' });
      storeName = store.store_name;
    } else if (scopedStoreIds.length > 1) {
      storeName = `${scopedStoreIds.length} 家门店汇总`;
    }
    res.json({
      ok: true,
      store_name: storeName,
      period,
      view,
      revenue_source: {
        view: revenueDataView,
        overrides: isCashierView ? {} : resolvedRevenue.policy.overrides,
        gross_amount: isCashierView ? Math.round(ledgerIncomeTotal * 100) / 100 : resolvedSalesTotals.gross,
        income_amount: isCashierView ? Math.round(ledgerIncomeTotal * 100) / 100 : resolvedSalesTotals.income,
        settled_amount: isCashierView ? Math.round(ledgerIncomeTotal * 100) / 100 : resolvedSalesTotals.settled,
        platform_fee_amount: isCashierView ? Math.round(ledgerFeeTotal * 100) / 100 : resolvedSalesTotals.fees,
        order_count: isCashierView ? 0 : resolvedSalesTotals.orders,
      },
      cost_sources: Object.fromEntries(Object.entries(costSources).map(([key, source]) => [key, { key: source, ...sourceMetaByKey[source] }])),
      wage,
      accrual_costs: recurringCosts.map(item => ({
        key: item.key, name: item.subcategory, source_key: item.source_key, source: item.source, monthly_basis: item.basis,
        daily_amount: item.daily_amount, cumulative_amount: item.cumulative_amount, recorded_amount: item.ledger_amount,
      })),
      income_rows: incomeRows,
      expense_rows: expenseRows,
      stored_value_rows: storedValueRows,
      daily_profit_series: dailyProfitSeries,
      totals: {
        daily_income: dailyIncome,
        daily_expense: dailyExpense,
        daily_net: dailyIncome - dailyExpense,
        daily_stored_value: storedValue(dayRows),
        cumulative_income: cumulativeIncome,
        cumulative_expense: cumulativeExpense,
        cumulative_net: cumulativeIncome - cumulativeExpense,
        cumulative_stored_value: storedValue(monthRows),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/analysis/revenue', (req, res) => {
  try { const { store_id, date } = req.query; let sql = 'SELECT * FROM daily_reports WHERE 1=1'; const params = []; if (store_id) { sql += ' AND store_id=?'; params.push(store_id); } if (date) { sql += ' AND date=?'; params.push(date); } else { sql += " AND date=(SELECT MAX(date) FROM daily_reports)"; } const rows = db.queryAll(sql, params); const channels = { instore:0, pickup:0, mtWaimai:0, tbFlash:0, jdWaimai:0, mtPay:0, mtTuan:0, dyTuan:0, stored:0, coupon:0 }; rows.forEach(r => { channels.instore += r.instore||0; channels.pickup += r.pickup||0; channels.mtWaimai += r.mt_waimai||0; channels.tbFlash += r.tb_flash||0; channels.jdWaimai += r.jd_waimai||0; channels.mtPay += r.mt_pay||0; channels.mtTuan += r.mt_tuan||0; channels.dyTuan += r.dy_tuan||0; channels.stored += r.stored_value||0; channels.coupon += r.coupon||0; }); res.json({ ok: true, channels, totalRevenue: rows.reduce((s,r)=>s+(r.revenue||0),0) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/analysis/cost', (req, res) => { try { const { store_id } = req.query; let sql = 'SELECT * FROM cost_accounting WHERE 1=1'; const params = []; if (store_id) { sql += ' AND store_id=?'; params.push(store_id); } sql += ' ORDER BY date DESC LIMIT 30'; res.json({ ok: true, rows: db.queryAll(sql, params) }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/analysis/sales', (req, res) => { try { res.json({ ok: true, rows: db.queryAll('SELECT store_name,date,revenue,actual_revenue,order_count,discount_amount FROM daily_reports ORDER BY date DESC LIMIT 50') }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ===== 经营数据分析（收银系统 + 线上平台双向核对） =====
app.get('/api/business-analytics/overview', (req, res) => {
  try {
    res.json({ ok: true, ...businessAnalytics.getOverview(db, req.query) });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/business-analytics/views/:scope', (req, res) => {
  try {
    const requested = req.params.scope;
    if (!['overview', 'group-buy', 'delivery'].includes(requested)) return res.status(404).json({ error: '分析视图不存在' });
    const result = businessAnalytics.getScopedOverview(db, requested === 'group-buy' ? 'group_buy' : requested, req.query);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 美团外卖经营指标（曝光/入店/下单/转化率）：求和字段直接合计，转化率按加权口径重算
app.get('/api/business-analytics/meituan-operation', (req, res) => {
  try {
    res.json(businessAnalytics.getMeituanOperation(db, req.query));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/business-analytics/products/:scope', (req, res) => {
  try {
    const scope = req.params.scope;
    if (!['overview','group-buy','delivery'].includes(scope)) return res.status(404).json({ error: '分析视角不存在' });
    res.json({ ok: true, ...businessAnalytics.getProductAnalytics(db, scope, req.query) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 规格拆分配置（可编辑数据，成本实时取自关联菜品 menu_items.cost）
app.get('/api/business-analytics/spec-links', (req, res) => {
  try {
    const platform = String(req.query.platform || '').trim() || '美团外卖';
    const name = String(req.query.external_product_name || '').trim();
    let sql = `SELECT sl.id, sl.platform, sl.external_product_name, sl.menu_item_id, sl.platform_price, sl.enabled,
        m.name AS menu_name, m.spec AS menu_spec, COALESCE(m.cost, 0) AS cost
      FROM business_product_spec_links sl LEFT JOIN menu_items m ON m.id = sl.menu_item_id
      WHERE sl.platform=?`;
    const params = [platform];
    if (name) { sql += ' AND sl.external_product_name=?'; params.push(name); }
    sql += ' ORDER BY sl.external_product_name, sl.sort_order, sl.platform_price';
    res.json({ ok: true, links: db.queryAll(sql, params) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/business-analytics/spec-links', (req, res) => {
  try {
    const platform = String(req.body.platform || '').trim();
    const name = String(req.body.external_product_name || '').trim();
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!platform || !name) return res.status(400).json({ error: '请提供平台和平台商品名' });
    const clean = items.map(item => ({ menu_item_id: Number(item.menu_item_id), platform_price: Number(item.platform_price) }))
      .filter(item => Number.isInteger(item.menu_item_id) && item.menu_item_id > 0 && Number.isFinite(item.platform_price) && item.platform_price > 0);
    if (!clean.length) return res.status(400).json({ error: '请至少配置一个规格（本地SKU + 平台售价）' });
    if (new Set(clean.map(item => item.menu_item_id)).size !== clean.length) return res.status(400).json({ error: '同一个本地规格 SKU 只能配置一次，请合并或删除重复行' });
    const blockedEmployeeMeal = db.queryOne(`SELECT id FROM menu_items WHERE id IN (${clean.map(() => '?').join(',')}) AND INSTR(name,'员工餐')>0`, clean.map(item => item.menu_item_id));
    if (blockedEmployeeMeal) return res.status(400).json({ error: '员工餐不参与外卖和团购菜品绑定' });
    db.run('BEGIN');
    try {
      db.run('DELETE FROM business_product_spec_links WHERE platform=? AND external_product_name=?', [platform, name]);
      // 规格拆分成为唯一成本口径，移除原单品绑定，避免同一平台商品出现两套关联。
      db.run('DELETE FROM business_product_mappings WHERE platform=? AND external_product_name=?', [platform, name]);
      clean.forEach((item, index) => {
        db.insert('INSERT INTO business_product_spec_links (platform,external_product_name,menu_item_id,platform_price,sort_order,enabled) VALUES (?,?,?,?,?,1)',
          [platform, name, item.menu_item_id, item.platform_price, index + 1]);
      });
      db.run('COMMIT');
    } catch (error) { try { db.run('ROLLBACK'); } catch {} throw error; }
    db.save();
    res.json({ ok: true, saved: clean.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 取消规格拆分：只删除规格关系，不删除原始销量、平台商品或本地菜品档案。
app.delete('/api/business-analytics/spec-links', (req, res) => {
  try {
    const platform = String(req.query.platform || '').trim();
    const name = String(req.query.external_product_name || '').trim();
    if (!platform || !name) return res.status(400).json({ error: '请提供平台和平台商品名' });
    const removed = db.run('DELETE FROM business_product_spec_links WHERE platform=? AND external_product_name=?', [platform, name]);
    if (!removed) return res.status(404).json({ error: '该商品没有可取消的规格拆分配置' });
    db.save();
    res.json({ ok: true, removed });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 日级规格人工确认：仅在自动反解多解/无解时使用；保存后优先于自动计算。
app.get('/api/business-analytics/spec-overrides', (req, res) => {
  try {
    const platform = String(req.query.platform || '').trim();
    const productName = String(req.query.external_product_name || '').trim();
    const storeId = Number(req.query.store_id);
    const bizDate = String(req.query.biz_date || '').trim();
    if (!platform || !productName || !storeId || !bizDate) return res.status(400).json({ error: '请提供平台、商品、门店和日期' });
    const rows = db.queryAll(`SELECT o.menu_item_id,o.quantity,m.name AS menu_name,m.spec AS menu_spec,COALESCE(m.cost,0) AS unit_cost
      FROM business_product_spec_overrides o LEFT JOIN menu_items m ON m.id=o.menu_item_id
      WHERE o.platform=? AND o.external_product_name=? AND o.store_id=? AND o.biz_date=?
      ORDER BY o.menu_item_id`, [platform, productName, storeId, bizDate]);
    res.json({ ok: true, overrides: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/business-analytics/spec-overrides', (req, res) => {
  try {
    const platform = String(req.body.platform || '').trim();
    const productName = String(req.body.external_product_name || '').trim();
    const storeId = Number(req.body.store_id);
    const bizDate = String(req.body.biz_date || '').trim();
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!platform || !productName || !Number.isInteger(storeId) || storeId <= 0 || !bizDate) return res.status(400).json({ error: '请提供平台、商品、门店和日期' });
    const clean = items.map(item => ({ menu_item_id: Number(item.menu_item_id), quantity: Math.round(Number(item.quantity)) }))
      .filter(item => Number.isInteger(item.menu_item_id) && item.menu_item_id > 0 && Number.isInteger(item.quantity) && item.quantity >= 0);
    if (!clean.length) return res.status(400).json({ error: '请至少填写一个规格数量' });
    const configured = db.queryAll('SELECT menu_item_id FROM business_product_spec_links WHERE platform=? AND external_product_name=? AND enabled=1', [platform, productName]).map(row => Number(row.menu_item_id));
    if (!configured.length) return res.status(400).json({ error: '请先配置该商品的规格 SKU 与平台售价' });
    if (clean.some(item => !configured.includes(item.menu_item_id))) return res.status(400).json({ error: '人工确认只能填写已配置的规格 SKU' });
    db.run('BEGIN');
    try {
      db.run('DELETE FROM business_product_spec_overrides WHERE platform=? AND external_product_name=? AND store_id=? AND biz_date=?', [platform, productName, storeId, bizDate]);
      clean.filter(item => item.quantity > 0).forEach(item => db.insert(`INSERT INTO business_product_spec_overrides
        (platform,store_id,biz_date,external_product_name,menu_item_id,quantity) VALUES (?,?,?,?,?,?)`, [platform, storeId, bizDate, productName, item.menu_item_id, item.quantity]));
      db.run('COMMIT');
    } catch (error) { try { db.run('ROLLBACK'); } catch {} throw error; }
    db.save();
    res.json({ ok: true, saved: clean.filter(item => item.quantity > 0).length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/business-analytics/mappings/:scope', (req, res) => {
  try {
    const scope = req.params.scope;
    if (!['overview','group-buy','delivery'].includes(scope)) return res.status(404).json({ error: '分析视角不存在' });
    res.json({ ok: true, ...businessAnalytics.getProductMappings(db, scope, req.query) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/business-analytics/mappings', (req, res) => {
  try { res.json(businessAnalytics.saveProductMapping(db, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/business-analytics/pos-mappings', (req, res) => {
  try { res.json(businessAnalytics.savePosProductMapping(db, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 解绑：删除平台商品与本地菜品的映射
app.delete('/api/business-analytics/mappings/:id', (req, res) => {
  try { res.json(businessAnalytics.deleteProductMapping(db, req.params.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 批量绑定：把多个平台商品（平台+商品名）一次性关联到同一个本地菜品
app.post('/api/business-analytics/mappings/batch', (req, res) => {
  try {
    const { items, menu_item_id } = req.body;
    const menuId = Number(menu_item_id);
    const menu = db.queryOne('SELECT id,name FROM menu_items WHERE id=?', [menuId]);
    if (!menu) return res.status(400).json({ error: '本地菜品不存在' });
    if (String(menu.name || '').includes('员工餐')) return res.status(400).json({ error: '员工餐不参与外卖和团购菜品绑定' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: '请选择要绑定的商品' });
    const scope = String(req.body?.scope || '').trim();
    const group = scope === 'delivery' ? 'delivery' : 'group_buy';
    db.run('BEGIN');
    let bound = 0;
    for (const it of items) {
      const platform = String(it?.platform || '').trim();
      const name = String(it?.external_product_name || it?.product_name || '').trim();
      if (!platform || !name) continue;
      db.run(`INSERT INTO business_product_mappings (platform, channel_group, external_product_name, menu_item_id)
        VALUES (?,?,?,?) ON CONFLICT(platform, external_product_name)
        DO UPDATE SET channel_group=excluded.channel_group, menu_item_id=excluded.menu_item_id, updated_at=datetime('now','localtime')`,
        [platform, group, name, menuId]);
      bound++;
    }
    db.run('COMMIT');
    db.save();
    res.json({ ok: true, bound });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 绑定名称标准化：忽略平台的展示符号、常见营销标签与空格，但保留菜品主体和规格。
function productBindingNameKey(value) {
  return String(value || '').toLowerCase()
    // 【太公三宝饭】是菜品主名，不能和【招牌】这类营销标签一样整体删除。
    .replace(/[【\[](?:新客专享|外卖专享|限时特惠|热销推荐|招牌|人气|爆款|新品)[】\]]/g, '')
    .replace(/[【】\[\]]/g, '')
    .replace(/(?:新客专享|外卖专享|限时特惠|热销推荐|招牌|人气|爆款|新品)/g, '')
    .replace(/[\s·•_—\-－，,。.!！:：/\\]/g, '')
    .trim();
}

// 外卖名称经常把赠品、是否配饭写在主菜名后面。这里仅剥离明确不会改变
// 主菜身份的信息；不能识别或可能对应多规格的名称仍交由人工处理。
function deliveryBindingNameKey(value) {
  let text = String(value || '').trim();
  const noRice = /不含(?:米饭|白饭)/.test(text);
  // “XXX + 例汤/靓汤”中的汤为赠品，不应影响主菜绑定。
  text = text
    .replace(/[+＋]\s*(?:例汤|靓汤)(?=\s*(?:[（(].*[）)])?\s*$)/g, '')
    .replace(/[（(]\s*(?:含)?(?:例汤|靓汤)\s*[）)]/g, '')
    .replace(/不含(?:米饭|白饭)/g, '')
    .trim();
  // 平台的“烧肉/例（不含米饭）”和本地的“烧肉例牌”是同一售卖形态。
  if (noRice) text = text.replace(/(?:[/／\s])?例(?=\s*(?:[（(].*[）)])?\s*$)/, '例牌');
  return productBindingNameKey(text);
}

// 这三类在本地存在多规格/组合配置，单品自动绑定会绕开规格选择，必须保留人工处理。
function isProtectedDeliveryMultiSpecProduct(value) {
  const text = String(value || '');
  return /太公烧鹅|烧鸭|咸鸡|咸香鸡|咸香靓鸡/.test(text);
}

// 组合套餐、双拼和“濑粉/面”这类仍需选择内容或规格，不能因为名称里包含一个菜名就自动绑定。
function isDeliveryCompositeProduct(value) {
  const text = String(value || '')
    .replace(/[+＋]\s*(?:例汤|靓汤)(?=\s*(?:[（(].*[）)])?\s*$)/g, '');
  return /(?:套餐|双拼|三拼|自选|二选一|濑粉\s*[/／]|干捞面|[+＋])/.test(text);
}

function productBindingSignature(binding) {
  if (binding.type === 'spec') return `spec:${binding.items.map(item => `${item.menu_item_id}@${Number(item.platform_price)}`).sort().join('|')}`;
  return `single:${binding.menu_item_id}`;
}

// 平台常在本地菜品主名之前/之后加三拼、超值、套餐等描述。主名长度至少 4，且在
// 平台名称内唯一时，视为安全的“菜品系列”匹配；若同长度主名有多个，仍交给人工校正。
function uniqueContainedMenuId(menus, platformNameKey) {
  const candidates = (menus || []).filter(menu => {
    const menuKey = productBindingNameKey(menu.name);
    return menuKey.length >= 4 && platformNameKey.includes(menuKey);
  });
  const longest = Math.max(0, ...candidates.map(menu => productBindingNameKey(menu.name).length));
  const ids = [...new Set(candidates.filter(menu => productBindingNameKey(menu.name).length === longest).map(menu => Number(menu.id)).filter(Boolean))];
  return ids.length === 1 ? ids[0] : 0;
}

const PRODUCT_BINDING_SPECS = ['上庄', '下庄', '半只', '一只', '整只', '大份', '小份', '大盒', '小盒', '单人', '双人'];
function productBindingSpecKey(value) {
  const text = productBindingNameKey(value);
  return PRODUCT_BINDING_SPECS.find(spec => text.includes(spec)) || '';
}
function productBindingDishCoreKey(value) {
  return productBindingNameKey(value)
    .replace(/(?:上庄|下庄|半只|一只|整只|大份|小份|大盒|小盒|单人|双人)/g, '')
    .replace(/(?:金牌|现烤|招牌|太公|至尊|经典|超值|烧味)/g, '')
    .replace(/(?:约)?\d+(?:g|克|斤|两|ml|毫升)/g, '')
    .replace(/(?:不含|含)(?:米饭|白饭|靓汤|饮品|柠檬茶)/g, '')
    .trim();
}
function uniqueDishAndSpecMenuId(menus, productName) {
  const productSpec = productBindingSpecKey(productName);
  const productCore = productBindingDishCoreKey(productName);
  if (!productSpec || productCore.length < 2) return 0;
  const ids = [...new Set((menus || []).filter(menu => productBindingSpecKey(menu.spec || '') === productSpec && productBindingDishCoreKey(menu.name) === productCore)
    .map(menu => Number(menu.id)).filter(Boolean))];
  return ids.length === 1 ? ids[0] : 0;
}
// 对“米饭”这类平台简写，允许从本地“白米饭 / 太公白米饭”中联想；只有唯一时自动绑定，
// 多个候选则带入人工校正，不会猜测。
function shortCoreMenuCandidates(menus, productName) {
  const core = productBindingDishCoreKey(productName);
  if (!['米饭', '白饭'].includes(core)) return [];
  return (menus || []).filter(menu => productBindingDishCoreKey(menu.name).includes('米饭'));
}
function uniqueShortCoreMenuId(menus, productName) {
  const ids = [...new Set(shortCoreMenuCandidates(menus, productName).map(menu => Number(menu.id)).filter(Boolean))];
  return ids.length === 1 ? ids[0] : 0;
}

// 一键绑定：优先复用其他平台的相同菜品绑定，其次匹配本地菜品；只有候选唯一时才自动落库。
app.post('/api/business-analytics/mappings/auto-bind', (req, res) => {
  try {
    const scope = String(req.body?.scope || '').trim();
    const channels = scope === 'delivery'
      ? ['meituan_delivery', 'taobao_flash', 'jd_delivery']
      : ['meituan_group', 'douyin_group', 'free_trial'];
    const rows = db.queryAll(`
      SELECT p.platform, p.product_name,
        SUM(p.quantity) as quantity, SUM(p.sales_amount) as sales_amount
      FROM business_product_sales p
      LEFT JOIN business_product_mappings m ON m.platform = p.platform AND m.external_product_name = p.product_name
      WHERE p.channel IN (${channels.map(() => '?').join(',')}) AND m.id IS NULL
      GROUP BY p.platform, p.product_name
    `, channels);
    const menus = db.queryAll("SELECT id,name,category,spec FROM menu_items WHERE status='在售' AND INSTR(name,'员工餐')=0");
    const byName = new Map(), byNormalizedName = new Map();
    menus.forEach(m => {
      const append = (map, key) => { if (!key) return; const list = map.get(key); if (list) list.push(m); else map.set(key, [m]); };
      append(byName, String(m.name || '').trim());
      append(byNormalizedName, productBindingNameKey(m.name));
    });
    const group = scope === 'delivery' ? 'delivery' : 'group_buy';
    const existingMappings = db.queryAll(`SELECT platform,external_product_name,menu_item_id FROM business_product_mappings
      WHERE platform IN (${channels.map(() => '?').join(',')})`, channels);
    const existingSpecLinks = db.queryAll(`SELECT platform,external_product_name,menu_item_id,platform_price,sort_order
      FROM business_product_spec_links WHERE enabled=1 AND platform IN (${channels.map(() => '?').join(',')})
      ORDER BY platform,external_product_name,sort_order,id`, channels);
    const reusableExact = new Map(), reusableNormalized = new Map();
    const appendReusable = (map, key, binding) => {
      if (!key) return;
      const signatures = map.get(key) || new Map();
      signatures.set(productBindingSignature(binding), binding);
      map.set(key, signatures);
    };
    existingMappings.forEach(row => {
      const binding = { type: 'single', menu_item_id: Number(row.menu_item_id) };
      appendReusable(reusableExact, String(row.external_product_name || '').trim(), binding);
      appendReusable(reusableNormalized, productBindingNameKey(row.external_product_name), binding);
    });
    const specsByProduct = new Map();
    existingSpecLinks.forEach(row => {
      const key = `${row.platform}|${row.external_product_name}`;
      const item = specsByProduct.get(key) || { platform: row.platform, name: String(row.external_product_name || '').trim(), items: [] };
      item.items.push({ menu_item_id: Number(row.menu_item_id), platform_price: Number(row.platform_price), sort_order: Number(row.sort_order) });
      specsByProduct.set(key, item);
    });
    specsByProduct.forEach(item => {
      const binding = { type: 'spec', items: item.items };
      appendReusable(reusableExact, item.name, binding);
      appendReusable(reusableNormalized, productBindingNameKey(item.name), binding);
    });
    const uniqueMenu = candidates => {
      const ids = [...new Set((candidates || []).map(item => Number(item.id)).filter(Boolean))];
      return ids.length === 1 ? ids[0] : 0;
    };
    const bind = (platform, productName, binding) => {
      db.run('DELETE FROM business_product_spec_links WHERE platform=? AND external_product_name=?', [platform, productName]);
      if (binding.type === 'spec') {
        db.run('DELETE FROM business_product_mappings WHERE platform=? AND external_product_name=?', [platform, productName]);
        binding.items.forEach((item, index) => db.insert(`INSERT INTO business_product_spec_links
          (platform,external_product_name,menu_item_id,platform_price,sort_order,enabled) VALUES (?,?,?,?,?,1)`,
          [platform, productName, item.menu_item_id, item.platform_price, index + 1]));
      } else {
        db.run(`INSERT INTO business_product_mappings (platform, channel_group, external_product_name, menu_item_id)
          VALUES (?,?,?,?) ON CONFLICT(platform, external_product_name)
          DO UPDATE SET channel_group=excluded.channel_group, menu_item_id=excluded.menu_item_id, updated_at=datetime('now','localtime')`,
          [platform, group, productName, binding.menu_item_id]);
      }
    };
    let bound = 0, skipped = 0;
    const reasons = { no_name_match: 0, ambiguous_name: 0, cross_platform_reused: 0, exact_name: 0, normalized_name: 0, intelligent_match: 0 };
    db.run('BEGIN');
    try {
      for (const r of rows) {
        const name = String(r.product_name || '').trim();
        const normalizedName = productBindingNameKey(name);
        const reuse = reusableExact.get(name) || reusableNormalized.get(normalizedName);
        if (reuse && reuse.size === 1) {
          bind(r.platform, name, [...reuse.values()][0]);
          bound++; reasons.cross_platform_reused++; continue;
        }
        if (reuse && reuse.size > 1) { reasons.ambiguous_name++; skipped++; continue; }
        const exactMenuId = uniqueMenu(byName.get(name));
        if (exactMenuId) { bind(r.platform, name, { type: 'single', menu_item_id: exactMenuId }); bound++; reasons.exact_name++; continue; }
        const normalizedMenuId = uniqueMenu(byNormalizedName.get(normalizedName));
        if (normalizedMenuId) { bind(r.platform, name, { type: 'single', menu_item_id: normalizedMenuId }); bound++; reasons.normalized_name++; continue; }
        const dishAndSpecMenuId = uniqueDishAndSpecMenuId(menus, name);
        if (dishAndSpecMenuId) { bind(r.platform, name, { type: 'single', menu_item_id: dishAndSpecMenuId }); bound++; reasons.intelligent_match++; continue; }
        const shortCoreMenuId = uniqueShortCoreMenuId(menus, name);
        if (shortCoreMenuId) { bind(r.platform, name, { type: 'single', menu_item_id: shortCoreMenuId }); bound++; reasons.intelligent_match++; continue; }
        const containedMenuId = uniqueContainedMenuId(menus, normalizedName);
        if (containedMenuId) { bind(r.platform, name, { type: 'single', menu_item_id: containedMenuId }); bound++; reasons.intelligent_match++; continue; }
        // 最后一层只允许“一个名称完整包含另一个名称”的唯一候选，且短名称至少 4 个字符。
        const fuzzyCandidates = menus.filter(menu => {
          const menuKey = productBindingNameKey(menu.name);
          const shortKey = menuKey.length <= normalizedName.length ? menuKey : normalizedName;
          const longKey = menuKey.length > normalizedName.length ? menuKey : normalizedName;
          return shortKey.length >= 4 && longKey.includes(shortKey) && longKey.length - shortKey.length <= 6;
        });
        const fuzzyMenuId = uniqueMenu(fuzzyCandidates);
        if (fuzzyMenuId) { bind(r.platform, name, { type: 'single', menu_item_id: fuzzyMenuId }); bound++; reasons.intelligent_match++; continue; }
        if (fuzzyCandidates.length || (byName.get(name) || []).length || (byNormalizedName.get(normalizedName) || []).length) reasons.ambiguous_name++;
        else reasons.no_name_match++;
        skipped++;
      }
      db.run('COMMIT');
    } catch (error) {
      try { db.run('ROLLBACK'); } catch {}
      throw error;
    }
    db.save();
    res.json({ ok: true, bound, skipped, reasons });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 智能绑定的预览/执行两阶段流程。预览绝不写库：有多个合理候选、或跨平台已有不同
// 绑定时交由使用者校正，避免“一键绑定”把成本归到错误菜品。
function buildBusinessAutoBindingPlan(scopeValue) {
  const scope = String(scopeValue || '').trim();
  const channels = scope === 'delivery'
    ? ['meituan_delivery', 'taobao_flash', 'jd_delivery']
    : ['meituan_group', 'douyin_group', 'free_trial'];
  const group = scope === 'delivery' ? 'delivery' : 'group_buy';
  const rows = db.queryAll(`SELECT p.platform,p.product_name FROM business_product_sales p
    LEFT JOIN business_product_mappings m ON m.platform=p.platform AND m.external_product_name=p.product_name
    LEFT JOIN business_product_spec_links s ON s.platform=p.platform AND s.external_product_name=p.product_name AND s.enabled=1
    WHERE p.channel IN (${channels.map(() => '?').join(',')}) AND m.id IS NULL AND s.id IS NULL
    GROUP BY p.platform,p.product_name`, channels);
  const menus = db.queryAll("SELECT id,name,category,spec FROM menu_items WHERE status='在售' AND INSTR(name,'员工餐')=0 AND INSTR(category,'员工餐')=0 AND INSTR(category,'团购')=0 ORDER BY category,name,spec");
  const menuById = new Map(menus.map(menu => [Number(menu.id), menu]));
  const byName = new Map(), byKey = new Map(), byDeliveryKey = new Map();
  const add = (map, key, value) => {
    if (!key) return;
    const list = map.get(key) || [];
    list.push(value);
    map.set(key, list);
  };
  menus.forEach(menu => {
    add(byName, String(menu.name || '').trim(), menu);
    add(byKey, productBindingNameKey(menu.name), menu);
    add(byDeliveryKey, deliveryBindingNameKey(menu.name), menu);
  });

  const existingMappings = db.queryAll(`SELECT platform,external_product_name,menu_item_id FROM business_product_mappings
    WHERE platform IN (${channels.map(() => '?').join(',')})`, channels);
  const existingSpecs = db.queryAll(`SELECT platform,external_product_name,menu_item_id,platform_price,sort_order FROM business_product_spec_links
    WHERE enabled=1 AND platform IN (${channels.map(() => '?').join(',')}) ORDER BY platform,external_product_name,sort_order,id`, channels);
  const reusableExact = new Map(), reusableKey = new Map();
  const addReuse = (map, key, binding) => {
    if (!key) return;
    const signatures = map.get(key) || new Map();
    signatures.set(productBindingSignature(binding), binding);
    map.set(key, signatures);
  };
  existingMappings.forEach(row => {
    const binding = { type: 'single', menu_item_id: Number(row.menu_item_id) };
    addReuse(reusableExact, String(row.external_product_name || '').trim(), binding);
    addReuse(reusableKey, productBindingNameKey(row.external_product_name), binding);
  });
  const specGroups = new Map();
  existingSpecs.forEach(row => {
    const key = `${row.platform}|${row.external_product_name}`;
    const value = specGroups.get(key) || { name: String(row.external_product_name || '').trim(), items: [] };
    value.items.push({ menu_item_id: Number(row.menu_item_id), platform_price: Number(row.platform_price), sort_order: Number(row.sort_order) });
    specGroups.set(key, value);
  });
  specGroups.forEach(value => {
    const binding = { type: 'spec', items: value.items };
    addReuse(reusableExact, value.name, binding);
    addReuse(reusableKey, productBindingNameKey(value.name), binding);
  });
  const uniqueId = list => {
    const ids = [...new Set((list || []).map(x => Number(x.id)).filter(Boolean))];
    return ids.length === 1 ? ids[0] : 0;
  };
  const candidateMenus = (lists, reuse) => {
    const result = new Map();
    (lists || []).flat().forEach(menu => { if (menu?.id) result.set(Number(menu.id), menu); });
    if (reuse) reuse.forEach(binding => {
      (binding.type === 'spec' ? binding.items : [binding]).forEach(item => {
        const menu = menuById.get(Number(item.menu_item_id));
        if (menu) result.set(Number(menu.id), menu);
      });
    });
    return [...result.values()].map(menu => ({ id: Number(menu.id), name: menu.name, category: menu.category || '未分类', spec: menu.spec || '' }));
  };
  const autoItems = [], manualItems = [];
  rows.forEach(row => {
    const productName = String(row.product_name || '').trim();
    // 多规格菜由规格绑定管理，不进入预关联或人工校正队列，避免单品映射覆盖规格方案。
    if (scope === 'delivery' && isProtectedDeliveryMultiSpecProduct(productName)) return;
    const key = scope === 'delivery' ? deliveryBindingNameKey(productName) : productBindingNameKey(productName);
    const exact = byName.get(productName) || [];
    const normalized = (scope === 'delivery' ? byDeliveryKey : byKey).get(key) || [];
    const productSpec = productBindingSpecKey(productName);
    const productCore = productBindingDishCoreKey(productName);
    const dishAndSpec = productSpec && productCore.length >= 2
      ? menus.filter(menu => productBindingSpecKey(menu.spec || '') === productSpec && productBindingDishCoreKey(menu.name) === productCore)
      : [];
    const shortCore = shortCoreMenuCandidates(menus, productName);
    const contained = menus.filter(menu => {
      const menuKey = productBindingNameKey(menu.name);
      return menuKey.length >= 4 && key.includes(menuKey);
    });
    const fuzzy = menus.filter(menu => {
      const menuKey = productBindingNameKey(menu.name);
      const shortKey = menuKey.length <= key.length ? menuKey : key;
      const longKey = menuKey.length > key.length ? menuKey : key;
      return shortKey.length >= 4 && longKey.includes(shortKey) && longKey.length - shortKey.length <= 6;
    });
    const reuse = reusableExact.get(productName) || reusableKey.get(key);
    const bind = (binding, strategy) => autoItems.push({ platform: row.platform, product_name: productName, binding, strategy });
    if (scope === 'delivery' && isDeliveryCompositeProduct(productName)) {
      const candidates = candidateMenus([exact, normalized, dishAndSpec, shortCore, contained, fuzzy], reuse);
      if (candidates.length) manualItems.push({
        key: `${row.platform}::${productName}`,
        platform: row.platform,
        product_name: productName,
        reason: '组合菜品或多规格内容需要人工确认，不自动绑定',
        candidates
      });
      return;
    }
    if (reuse?.size === 1) { bind([...reuse.values()][0], '复用其他平台同名绑定'); return; }
    if (reuse?.size > 1) {
      manualItems.push({ key: `${row.platform}::${productName}`, platform: row.platform, product_name: productName, reason: '其他平台存在不同绑定，请确认对应本地菜品', candidates: candidateMenus([exact, normalized, dishAndSpec, shortCore, contained, fuzzy], reuse) });
      return;
    }
    const exactId = uniqueId(exact);
    if (exactId) { bind({ type: 'single', menu_item_id: exactId }, '本地同名'); return; }
    const normalizedId = uniqueId(normalized);
    if (normalizedId) {
      bind({ type: 'single', menu_item_id: normalizedId }, scope === 'delivery' && key !== productBindingNameKey(productName) ? '赠品/例牌规则匹配' : '规范化同名');
      return;
    }
    const dishAndSpecId = uniqueId(dishAndSpec);
    if (dishAndSpecId) { bind({ type: 'single', menu_item_id: dishAndSpecId }, '菜品词与规格联想'); return; }
    const shortCoreId = uniqueId(shortCore);
    if (shortCoreId) { bind({ type: 'single', menu_item_id: shortCoreId }, '简写菜品词联想'); return; }
    const containedId = uniqueContainedMenuId(menus, key);
    if (containedId) { bind({ type: 'single', menu_item_id: containedId }, '菜品主名包含匹配'); return; }
    const fuzzyId = uniqueId(fuzzy);
    if (fuzzyId) { bind({ type: 'single', menu_item_id: fuzzyId }, '智能名称识别'); return; }
    const candidates = candidateMenus([exact, normalized, dishAndSpec, shortCore, contained, fuzzy]);
    // 没有任何可靠联想的菜品不进入本次人工校正，仍保留在主列表中供单独处理。
    if (!candidates.length) return;
    manualItems.push({
      key: `${row.platform}::${productName}`,
      platform: row.platform,
      product_name: productName,
      reason: '找到多个可能的本地菜品，请人工校正',
      candidates
    });
  });
  return { scope, group, channels, menus, menuById, autoItems, manualItems };
}

function applyBusinessAutoBinding(group, platform, productName, binding) {
  db.run('DELETE FROM business_product_spec_links WHERE platform=? AND external_product_name=?', [platform, productName]);
  if (binding.type === 'spec') {
    db.run('DELETE FROM business_product_mappings WHERE platform=? AND external_product_name=?', [platform, productName]);
    binding.items.forEach((item, index) => db.insert(`INSERT INTO business_product_spec_links
      (platform,external_product_name,menu_item_id,platform_price,sort_order,enabled) VALUES (?,?,?,?,?,1)`,
      [platform, productName, item.menu_item_id, item.platform_price, index + 1]));
  } else {
    db.run(`INSERT INTO business_product_mappings (platform,channel_group,external_product_name,menu_item_id)
      VALUES (?,?,?,?) ON CONFLICT(platform,external_product_name) DO UPDATE SET channel_group=excluded.channel_group,menu_item_id=excluded.menu_item_id,updated_at=datetime('now','localtime')`,
      [platform, group, productName, binding.menu_item_id]);
  }
}

app.post('/api/business-analytics/mappings/auto-bind/preview', (req, res) => {
  try {
    const plan = buildBusinessAutoBindingPlan(req.body?.scope);
    const safeItems = plan.autoItems.map(item => {
      const menuIds = item.binding.type === 'spec' ? item.binding.items.map(link => link.menu_item_id) : [item.binding.menu_item_id];
      const targets = menuIds.map(id => plan.menuById.get(Number(id))).filter(Boolean)
        .map(menu => `${menu.name}${menu.spec ? ` · ${menu.spec}` : ''}`);
      return { platform: item.platform, product_name: item.product_name, strategy: item.strategy, target: targets.join('、') || '规格方案' };
    });
    res.json({ ok: true, auto_count: plan.autoItems.length, auto_items: safeItems, manual_items: plan.manualItems, menu_items: plan.menus.map(m => ({ id: Number(m.id), name: m.name, category: m.category || '未分类', spec: m.spec || '' })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/business-analytics/mappings/auto-bind/execute', (req, res) => {
  try {
    const plan = buildBusinessAutoBindingPlan(req.body?.scope);
    const manualByKey = new Map(plan.manualItems.map(item => [item.key, item]));
    const corrections = Array.isArray(req.body?.corrections) ? req.body.corrections : [];
    let autoBound = 0, corrected = 0, skipped = 0;
    db.run('BEGIN');
    try {
      plan.autoItems.forEach(item => { applyBusinessAutoBinding(plan.group, item.platform, item.product_name, item.binding); autoBound++; });
      corrections.forEach(correction => {
        const key = `${String(correction?.platform || '').trim()}::${String(correction?.product_name || '').trim()}`;
        const item = manualByKey.get(key);
        if (!item) return;
        const menuId = Number(correction?.menu_item_id);
        if (menuId && plan.menuById.has(menuId)) {
          applyBusinessAutoBinding(plan.group, item.platform, item.product_name, { type: 'single', menu_item_id: menuId });
          corrected++;
        } else skipped++;
      });
      db.run('COMMIT');
    } catch (error) { try { db.run('ROLLBACK'); } catch {} throw error; }
    db.save();
    res.json({ ok: true, bound: autoBound + corrected, auto_bound: autoBound, corrected, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/business-analytics/diagnoses', (req, res) => {
  try { res.json({ ok: true, diagnosis: businessAnalytics.getDiagnosis(db, req.query || {}) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/business-analytics/diagnoses', (req, res) => {
  try { res.status(201).json({ ok: true, diagnosis: businessAnalytics.generateDiagnosis(db, req.body || {}, req.user) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/business-analytics/import', (req, res) => {
  try {
    const result = businessAnalytics.importWorkbook(db, req.body || {}, req.user);
    res.status(201).json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 美团“全部门店营业额收入单量”报表：严格按第三方平台档案的美团外卖门店 ID 关联。
app.post('/api/business-analytics/import/meituan-delivery', (req, res) => {
  try {
    const result = businessAnalytics.importMeituanDeliveryWorkbook(db, req.body || {}, req.user);
    res.status(201).json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 美团团购“收益明细”：按收益时间结算，售价/费用/商家应得与菜品销量同步入库。
app.post('/api/business-analytics/import/meituan-group-buy', (req, res) => {
  try {
    const result = businessAnalytics.importMeituanGroupBuyWorkbook(db, req.body || {}, req.user);
    res.status(201).json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 抖音团购“分账明细-正向/退款-团购”：两张表必须成对上传，按核销时间和订单编号抵销。
// 美团团购“门店基础数据”：经营、流量、评分独立入库；实际到账从已导入收益明细日账读取。
app.post('/api/business-analytics/import/meituan-group-operation', (req, res) => {
  try {
    const result = businessAnalytics.importMeituanGroupOperationWorkbook(db, req.body || {}, req.user);
    res.status(201).json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/business-analytics/import/douyin-group-buy', (req, res) => {
  try {
    const result = businessAnalytics.importDouyinGroupBuyWorkbook(db, req.body || {}, req.user);
    res.status(201).json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 京东“全部门店营业额收入单量 / 商品销量”报表：严格按第三方平台档案的京东外卖门店 ID 关联。
app.post('/api/business-analytics/import/jd-delivery', (req, res) => {
  try {
    const result = businessAnalytics.importJdDeliveryWorkbook(db, req.body || {}, req.user);
    res.status(201).json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 淘宝闪购“全部门店营业额收入单量”报表：与美团同口径，按淘宝闪购平台门店 ID 关联。
app.post('/api/business-analytics/import/taobao-flash', (req, res) => {
  try {
    const result = businessAnalytics.importTaobaoFlashWorkbook(db, req.body || {}, req.user);
    res.status(201).json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 全平台通用导入记录：用于导入页追溯文件、数据归属和覆盖日期。
app.get('/api/business-analytics/import-batches', (req, res) => {
  try {
    const platform = String(req.query.platform || '').trim();
    const sourceType = String(req.query.source_type || '').trim();
    const pageSize = Math.min(100, Math.max(10, Number(req.query.page_size || req.query.limit) || 20));
    const page = Math.max(1, Number(req.query.page) || 1);
    const clauses = [];
    const values = [];
    if (platform) { clauses.push('platform=?'); values.push(platform); }
    if (sourceType) { clauses.push('source_type=?'); values.push(sourceType); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = Number(db.queryOne(`SELECT COUNT(*) AS total FROM business_import_batches ${where}`, values)?.total || 0);
    const batches = db.queryAll(`SELECT id,source_type,platform,file_name,row_count,date_from,date_to,imported_by_name,created_at
      FROM business_import_batches ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...values, pageSize, (page - 1) * pageSize]);
    res.json({ ok: true, batches, total, page, page_size: pageSize });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/business-analytics/template', (req, res) => {
  try {
    const sourceType = req.query.source_type === 'platform' ? 'platform' : 'pos';
    res.json({
      ok: true,
      file_name: sourceType === 'platform' ? '线上平台营业数据模板.xlsx' : '收银系统营业数据模板.xlsx',
      data: businessAnalytics.createTemplate(sourceType),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 数据导出 =====
app.get('/api/data/export', (req, res) => {
  try { const { type } = req.query; let data; switch (type) { case 'stores': data = db.queryAll('SELECT * FROM stores'); break; case 'daily': data = db.queryAll('SELECT * FROM daily_reports ORDER BY date DESC LIMIT 200'); break; case 'cost': data = db.queryAll('SELECT * FROM cost_accounting ORDER BY date DESC LIMIT 200'); break; case 'menu': data = db.queryAll('SELECT * FROM menu_items'); break; default: data = { stores: db.queryAll('SELECT * FROM stores'), menu: db.queryAll('SELECT * FROM menu_items') }; } res.json({ ok: true, type, data }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 设置 Windows 控制台编码 =====
function setupConsoleEncoding() {
  if (os.platform() === 'win32') {
    try {
      child_process.execSync('chcp 65001', { stdio: 'ignore', timeout: 2000 });
    } catch {
      // chcp 可能失败（非管理员等场景），静默忽略
    }
  }
}

// ===== 地图自定义点位 =====
app.get('/api/map-pins', (req, res) => {
  try {
    const { province, city, district } = req.query;
    const currentUserId = req.user?.id;
    // 按门店所在省市过滤（通过 store_id 关联 stores 表）
    let sql = 'SELECT p.* FROM map_pins p LEFT JOIN stores s ON p.store_id = s.id WHERE 1=1';
    const params = [];
    if (province) {
      sql += " AND (s.province=? OR p.province=? OR ((p.province IS NULL OR p.province='') AND p.store_id IS NULL))";
      params.push(province, province);
    }
    if (city) {
      sql += " AND (s.city=? OR p.city=? OR ((p.city IS NULL OR p.city='') AND p.store_id IS NULL))";
      params.push(city, city);
    }
    if (district) {
      sql += " AND (s.district=? OR p.district=? OR ((p.district IS NULL OR p.district='') AND p.store_id IS NULL))";
      params.push(district, district);
    }
    // visibility 过滤：public 所有人可见；private 仅创建者可见
    sql += ' AND (p.visibility=\'public\' OR p.visibility IS NULL';
    if (currentUserId != null) {
      sql += ' OR (p.visibility=\'private\' AND p.user_id=?)';
      params.push(currentUserId);
    }
    sql += ')';
    sql += ' ORDER BY p.id';
    res.json({ ok: true, data: db.queryAll(sql, params) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/map-pins', (req, res) => {
  try {
    const { lng, lat, name, remark, color, radius, shape, store_id, visibility, province, city, district } = req.body;
    if (lng == null || lat == null) return res.status(400).json({ error: '缺少经纬度' });
    const created_by = req.user?.display_name || req.user?.username || '';
    const user_id = req.user?.id || null;
    const id = db.insert('INSERT INTO map_pins (lng,lat,name,remark,color,radius,shape,created_by,store_id,user_id,visibility,province,city,district) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [lng, lat, name||'', remark||'', color||'#F56C6C', radius||3000, shape||'circle', created_by, store_id||null, user_id, visibility||'public', province||'', city||'', district||'']);
    db.save();
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/map-pins/:id', (req, res) => {
  try {
    const allowed = ['name','remark','color','radius','shape','lat','lng','visibility','province','city','district'];
    const sets = [], params = [];
    allowed.forEach(f => { if (req.body[f] !== undefined) { sets.push(`${f}=?`); params.push(req.body[f]); } });
    if (!sets.length) return res.status(400).json({ error: '无更新字段' });
    sets.push("updated_at=datetime('now','localtime')");
    params.push(req.params.id);
    db.run(`UPDATE map_pins SET ${sets.join(',')} WHERE id=?`, params);
    db.save();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/map-pins/:id', (req, res) => {
  try {
    db.run('DELETE FROM map_pins WHERE id=?', [req.params.id]);
    db.save();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/map-pins', (req, res) => {
  try {
    db.run('DELETE FROM map_pins');
    db.save();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 将扁平评论列表转为两层树形（父评论 + 子回复）
function buildCommentTree(rows) {
  const parents = rows.filter(r => !r.parent_id);
  const children = rows.filter(r => r.parent_id);
  return parents.map(p => ({
    ...p,
    replies: children.filter(c => c.parent_id === p.id)
  }));
}

// ===== 点位评论 =====
app.get('/api/map-pins/:pinId/comments', (req, res) => {
  try {
    const rows = db.queryAll(
      'SELECT * FROM pin_comments WHERE pin_id=? ORDER BY created_at ASC',
      [req.params.pinId]
    );
    res.json({ ok: true, data: buildCommentTree(rows) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/map-pins/:pinId/comments', (req, res) => {
  try {
    const { content, parent_id, reply_to_name } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: '评论内容不能为空' });
    const user_id = req.user?.id || null;
    const username = req.user?.display_name || req.user?.username || '';
    const id = db.insert(
      'INSERT INTO pin_comments (pin_id, user_id, username, content, parent_id, reply_to_name) VALUES (?,?,?,?,?,?)',
      [req.params.pinId, user_id, username, content.trim(), parent_id || null, reply_to_name || '']
    );
    db.save();
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/map-pins/:pinId/comments/:commentId', (req, res) => {
  try {
    const comment = db.queryOne('SELECT * FROM pin_comments WHERE id=? AND pin_id=?', [req.params.commentId, req.params.pinId]);
    if (!comment) return res.status(404).json({ error: '评论不存在' });
    // 仅允许删除自己的评论
    if (comment.user_id && comment.user_id !== (req.user?.id)) {
      return res.status(403).json({ error: '只能删除自己的评论' });
    }
    // 级联删除子回复
    db.run('DELETE FROM pin_comments WHERE parent_id=?', [req.params.commentId]);
    db.run('DELETE FROM pin_comments WHERE id=?', [req.params.commentId]);
    db.save();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 门店评论 =====
app.get('/api/stores/:storeId/comments', (req, res) => {
  try {
    const rows = db.queryAll(
      'SELECT * FROM store_comments WHERE store_id=? ORDER BY created_at ASC',
      [req.params.storeId]
    );
    res.json({ ok: true, data: buildCommentTree(rows) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/stores/:storeId/comments', (req, res) => {
  try {
    const { content, parent_id, reply_to_name } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: '评论内容不能为空' });
    const user_id = req.user?.id || null;
    const username = req.user?.display_name || req.user?.username || '';
    const id = db.insert(
      'INSERT INTO store_comments (store_id, user_id, username, content, parent_id, reply_to_name) VALUES (?,?,?,?,?,?)',
      [req.params.storeId, user_id, username, content.trim(), parent_id || null, reply_to_name || '']
    );
    db.save();
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/stores/:storeId/comments/:commentId', (req, res) => {
  try {
    const comment = db.queryOne('SELECT * FROM store_comments WHERE id=? AND store_id=?', [req.params.commentId, req.params.storeId]);
    if (!comment) return res.status(404).json({ error: '评论不存在' });
    if (comment.user_id && comment.user_id !== (req.user?.id)) {
      return res.status(403).json({ error: '只能删除自己的评论' });
    }
    // 级联删除子回复
    db.run('DELETE FROM store_comments WHERE parent_id=?', [req.params.commentId]);
    db.run('DELETE FROM store_comments WHERE id=?', [req.params.commentId]);
    db.save();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 智能机器人状态 =====
app.get('/api/bot/status', (_req, res) => {
  res.json(wecomBot.getStatus());
});

// ===== 启动 =====
(async () => {
  // 本地调试可通过 DISABLE_WECOM_BOT=1 停用机器人长连接，避免外部连接干扰页面服务。
  if (process.env.DISABLE_WECOM_BOT !== '1') wecomBot.start().catch(err => console.error('[wecom-bot] 启动失败:', err.message));
  setupConsoleEncoding();
  await db.init();
  db.seed();
  // 历史京东门店经营日报早期仅写入外卖运营看板；启动时回填为平台营业记录，
  // 让总数据视角和外卖视角使用一致的第三方来源。
  businessAnalytics.rebuildJdRevenueFromOperation(db);

  // 确保 admin 用户存在且密码正确（兼容旧数据库）；
  // 不再自动补种 agent 等测试账号——人员管理以实际维护的账号为准。
  (function ensureUsers() {
    const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
    const adminHash = md5('admin123');
    const admin = db.queryOne("SELECT * FROM users WHERE username='admin'");
    if (!admin) {
      db.insert("INSERT INTO users (username,password_hash,role,display_name) VALUES ('admin',?,'管理员','系统管理员')", [adminHash]);
    } else if (admin.password_hash !== adminHash || admin.role !== '管理员') {
      db.run("UPDATE users SET password_hash=?, role='管理员', display_name='系统管理员' WHERE username='admin'", [adminHash]);
    }
    db.save();
  })();

  console.log('═'.repeat(50));
  console.log('  编码环境确认');
  console.log('  系统平台 :', os.platform());
  console.log('  文件编码 : UTF-8 (所有 fs 读写均显式指定)');
  console.log('  响应编码 : Content-Type + charset=utf-8');
  console.log('═'.repeat(50));
// ===== 智能表格 Webhook 代理 =====
app.post('/api/webhook/smartsheet', async (req, res) => {
  const { url, payload } = req.body;
  if (!url) return res.status(400).json({ error: '请提供 webhook URL' });
  if (!payload) return res.status(400).json({ error: '请提供 payload' });
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    res.json({ ok: true, status: resp.status, data });
  } catch (e) {
    res.status(500).json({ error: '请求失败: ' + e.message });
  }
});

  const server = app.listen(PORT, () => {
    console.log(`🚀 中控后台已启动: http://localhost:${PORT}`);
    console.log(`📦 数据库: data/database.sqlite`);
  });

  // 优雅退出：断开智能机器人
  const graceful = (signal) => {
    console.log(`\n[server] 收到 ${signal}，正在关闭...`);
    wecomBot.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGINT', () => graceful('SIGINT'));
  process.on('SIGTERM', () => graceful('SIGTERM'));
})();
