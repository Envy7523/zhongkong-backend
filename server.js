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
const ledgerBackupImport = require('./lib/bookkeeping-import');
const wecomBot = require('./lib/wecom-bot');
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
wecomBot.setTextMessageHandler(async (content) => (await businessAssistant.answer(content)).reply);

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
  app.use(express.static(vueDist));
  // SPA 回退：非 /api 路径返回 index.html
  app.get(/^(?!\/api).*/, (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
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

// ===== 门店 JSON 兼容 =====
const STORES_PATH = path.join(__dirname, 'stores.json');
function loadStores() { try { const raw = fs.readFileSync(STORES_PATH, 'utf-8'); return JSON.parse(stripBOM(raw)); } catch { return []; } }
function saveStores(stores) { fs.writeFileSync(STORES_PATH, JSON.stringify(stores, null, 2) + '\n', 'utf-8'); }
const STORE_FIELDS = ['businessType','storeName','legalPerson','paymentType','status','openingDate','phone','province','city','district','address','businessHours','storeSize','monthlyRent','monthlyUtilities','employeeCount','laborCost','closingTime','businessDays'];

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

// ===== 门店管理（JSON 兼容旧版）=====
app.get('/api/stores', (req, res) => { try { const stores = loadStores(); res.json({ ok: true, stores }); } catch (e) { res.status(500).json({ error: e.message }); } });

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

app.get('/api/stores/:id', (req, res) => { try { const stores = loadStores(); const s = stores.find(s => s.id === req.params.id); if (!s) return res.status(404).json({ error: '门店不存在' }); res.json({ ok: true, store: s }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/stores/:id', (req, res) => { try { const stores = loadStores(); const idx = stores.findIndex(s => s.id === req.params.id); if (idx === -1) return res.status(404).json({ error: '门店不存在' }); STORE_FIELDS.forEach(f => { if (req.body[f] !== undefined) stores[idx][f] = String(req.body[f]).trim(); }); saveStores(stores); res.json({ ok: true, store: stores[idx] }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put('/api/stores/:id', (req, res) => { try { const stores = loadStores(); const idx = stores.findIndex(s => s.id === req.params.id); if (idx === -1) return res.status(404).json({ error: '门店不存在' }); STORE_FIELDS.forEach(f => { if (req.body[f] !== undefined) stores[idx][f] = String(req.body[f]).trim(); }); saveStores(stores); res.json({ ok: true, store: stores[idx] }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/stores/:id', (req, res) => { try { let stores = loadStores(); const idx = stores.findIndex(s => s.id === req.params.id); if (idx === -1) return res.status(404).json({ error: '门店不存在' }); const removed = stores[idx]; stores = stores.filter(s => s.id !== req.params.id); saveStores(stores); res.json({ ok: true, message: '门店已删除', removed }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/stores/init', (req, res) => { try { const excelStores = parseDailyExcel(); let stores = loadStores(); excelStores.forEach(es => { const existing = stores.find(s => s.id === es.id); if (!existing) { const s = { id: es.id }; STORE_FIELDS.forEach(f => { s[f] = ''; }); s.storeName = es.storeName; stores.push(s); } else if (!existing.storeName || existing.storeName !== es.storeName) existing.storeName = es.storeName; }); stores.sort((a, b) => { const na = parseInt(a.id.replace('store_', '')), nb = parseInt(b.id.replace('store_', '')); return na - nb; }); saveStores(stores); res.json({ ok: true, stores, count: stores.length }); } catch (e) { res.status(500).json({ error: e.message }); } });

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
    const list = db.queryAll(
      `SELECT e.* FROM employees e ${whereClause} ORDER BY e.id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    res.json({ ok: true, list, total, page: pageNum, page_size: pageSize });
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

// 员工同步到企微智能表格的辅助函数
async function syncStaffToSmartsheet(employee, cfg) {
  // 优先使用 access_token API (支持 update_records)，回退到 webhook
  const hasApiConfig = cfg.staffSmartSheetDocId && cfg.staffSmartSheetSheetId;
  const hasWebhook = cfg.staffSmartSheetUrl;

  if (!hasApiConfig && !hasWebhook) return { synced: false, reason: '未配置企微表格' };

  const values = {
    '姓名': employee.name || '',
    '手机号': employee.phone || '',
    '性别': employee.gender || '',
    '年龄': String(employee.age || ''),
    '所属门店': employee.store_name || '',
    '状态': employee.status || '',
    '入职日期': employee.entry_date || '',
    '职位': employee.position || '',
    '角色': employee.role || '',
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
    const fields = ['name', 'phone', 'gender', 'age', 'store_name', 'status', 'entry_date', 'position', 'remark', 'role'];
    const sets = [];
    const params = [];

    fields.forEach(f => {
      if (req.body[f] !== undefined) { sets.push(`${f}=?`); params.push(req.body[f]); }
    });

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
      const name = (vals['姓名'] || []).map(v => v.text || v).join('') || '';
      if (!name) { skipped++; continue; }

      const rowData = {
        name,
        phone: (vals['手机号'] || []).map(v => v.text || v).join('') || '',
        gender: (vals['性别'] || []).map(v => v.text || v).join('') || '',
        age: parseInt((vals['年龄'] || []).map(v => v.text || v).join('')) || 0,
        store_name: (vals['所属门店'] || []).map(v => v.text || v).join('') || '',
        status: (vals['状态'] || []).map(v => v.text || v).join('') || '在职',
        entry_date: (vals['入职日期'] || []).map(v => v.text || v).join('') || '',
        position: (vals['职位'] || []).map(v => v.text || v).join('') || '',
        role: (vals['角色'] || []).map(v => v.text || v).join('') || '店员',
        remark: (vals['备注'] || []).map(v => v.text || v).join('') || '',
      };

      // 尝试匹配：先按 record_id，再按姓名
      let localEmployee = localMap[rec.record_id];
      if (!localEmployee) {
        localEmployee = allLocal.find(e => e.name === rowData.name && !e.smartsheet_record_id);
      }

      if (localEmployee) {
        // 更新本地记录 + 写入 record_id
        db.run(
          `UPDATE employees SET smartsheet_record_id=?, name=?, phone=?, gender=?, age=?,
           store_name=?, status=?, entry_date=?, position=?, role=?, remark=?,
           updated_at=datetime('now','localtime') WHERE id=?`,
          [rec.record_id, rowData.name, rowData.phone, rowData.gender, rowData.age,
           rowData.store_name, rowData.status, rowData.entry_date, rowData.position,
           rowData.role, rowData.remark, localEmployee.id]
        );
        updated++;
      } else {
        // 新建本地员工
        const newId = db.insert(
          `INSERT INTO employees (name, phone, gender, age, store_name, status, entry_date,
           position, role, remark, smartsheet_record_id, store_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [rowData.name, rowData.phone, rowData.gender, rowData.age,
           rowData.store_name, rowData.status, rowData.entry_date,
           rowData.position, rowData.role, rowData.remark, rec.record_id, 0]
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
      FROM menu_items m LEFT JOIN stores s ON m.store_id=s.id WHERE 1=1`;
    const params = [];
    if (store_id) { sql += ' AND (m.store_id=? OR m.store_id IS NULL)'; params.push(store_id); }
    if (category) { sql += ' AND m.category=?'; params.push(category); }
    if (status) { sql += ' AND m.status=?'; params.push(status); }
    sql += ' ORDER BY m.id';
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
      expiry_days, status,
    } = req.body;
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ error: '菜品名称不能为空' });
    const dinePrice = Number(dine_in_price) || 0;
    const id = db.insert(
      `INSERT INTO menu_items
       (store_id,name,category,method,spec,price,dine_in_price,member_price,takeout_price,spec_unit,spec_weight,cost,expiry_days,status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      ]
    );
    db.save();
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/menu/:id', (req, res) => { try { const fields = ['name','category','method','spec','price','dine_in_price','member_price','takeout_price','spec_unit','spec_weight','cost','expiry_days','status']; const sets = [], params = []; fields.forEach(f => { if (req.body[f] !== undefined) { sets.push(`${f}=?`); params.push(req.body[f]); } }); if (!sets.length) return res.status(400).json({ error: '没有要更新的字段' }); params.push(req.params.id); db.run(`UPDATE menu_items SET ${sets.join(',')} WHERE id=?`, params); db.save(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/menu/:id', (req, res) => { try { db.run('DELETE FROM menu_items WHERE id=?', [req.params.id]); db.save(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/api/menu/:id/cost-components', (req, res) => {
  try {
    const item = db.queryOne('SELECT id,name,cost FROM menu_items WHERE id=?', [req.params.id]);
    if (!item) return res.status(404).json({ error: '菜品不存在' });
    const components = db.queryAll(
      'SELECT id,ingredient_name,quantity,unit,unit_cost,subtotal,sort_order FROM menu_cost_components WHERE menu_item_id=? ORDER BY sort_order,id',
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
      const name = String(row.ingredient_name || '').trim();
      const quantity = Number(row.quantity);
      const unitCost = Number(row.unit_cost);
      if (!name) throw new Error(`第 ${index + 1} 行请填写材料名称`);
      if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`第 ${index + 1} 行用量必须大于 0`);
      if (!Number.isFinite(unitCost) || unitCost < 0) throw new Error(`第 ${index + 1} 行单位成本不能小于 0`);
      return {
        ingredient_name: name,
        quantity,
        unit: String(row.unit || '份').trim() || '份',
        unit_cost: unitCost,
        subtotal: Math.round(quantity * unitCost * 100) / 100,
        sort_order: index,
      };
    });
    const totalCost = Math.round(components.reduce((sum, row) => sum + row.subtotal, 0) * 100) / 100;
    db.exec('BEGIN');
    try {
      db.run('DELETE FROM menu_cost_components WHERE menu_item_id=?', [itemId]);
      components.forEach(row => db.insert(
        'INSERT INTO menu_cost_components (menu_item_id,ingredient_name,quantity,unit,unit_cost,subtotal,sort_order) VALUES (?,?,?,?,?,?,?)',
        [itemId, row.ingredient_name, row.quantity, row.unit, row.unit_cost, row.subtotal, row.sort_order]
      ));
      db.run('UPDATE menu_items SET cost=? WHERE id=?', [totalCost, itemId]);
      db.exec('COMMIT');
      db.save();
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.json({ ok: true, components, total_cost: totalCost });
  } catch (e) { res.status(400).json({ error: e.message }); }
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
    const sort_order = Number(req.body?.sort_order) || 0;
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
    const id = db.insert('INSERT INTO menu_categories (name, sort_order) VALUES (?,?)', [name, 0]);
    db.save();
    res.status(201).json({ ok: true, id, name });
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
    const sortCol = { income: 'income_amount', quantity: 'quantity', amount: 'amount_total' }[sort] || 'income_amount';
    const total = db.queryOne(`SELECT COUNT(*) as cnt FROM (SELECT product_code, product_name, spec FROM dish_sales ${where} GROUP BY product_code, product_name, spec)`, params).cnt;
    const psize = Math.min(100, Math.max(1, parseInt(page_size) || 20));
    const pg = Math.max(1, parseInt(page) || 1);
    const rows = db.queryAll(`
      SELECT d.product_code, d.product_name, d.spec,
        SUM(d.quantity) as quantity,
        SUM(d.amount_total) as amount_total,
        SUM(d.discount_amount) as discount_amount,
        SUM(d.income_amount) as income_amount,
        SUM(d.refund_amount) as refund_amount,
        COUNT(DISTINCT d.order_no) as order_count,
        SUM(CASE WHEN d.refunded='部分退' THEN 1 ELSE 0 END) as refunded_count,
        MAX(CASE WHEN m.id IS NOT NULL THEN 1 ELSE 0 END) as cost_available,
        SUM(CASE WHEN m.id IS NOT NULL THEN d.quantity * COALESCE(mi.cost, 0) ELSE 0 END) as estimated_cost,
        CASE WHEN MAX(CASE WHEN m.id IS NOT NULL THEN 1 ELSE 0 END) = 1
          THEN SUM(d.income_amount) - SUM(d.quantity * COALESCE(mi.cost, 0))
          ELSE NULL END as net_income
      FROM dish_sales d
      LEFT JOIN dish_sales_mappings m ON m.product_code = d.product_code AND m.product_name = d.product_name
        AND m.spec = CASE WHEN d.spec IN ('', '--') THEN '' ELSE d.spec END
      LEFT JOIN menu_items mi ON mi.id = m.menu_item_id
      ${where}
      GROUP BY d.product_code, d.product_name, d.spec
      ORDER BY ${sortCol} DESC
      LIMIT ? OFFSET ?`, [...params, psize, (pg - 1) * psize]);
    const summary = db.queryOne(`
      SELECT COUNT(DISTINCT d.product_code) as product_count,
        SUM(d.quantity) as quantity,
        SUM(d.amount_total) as amount_total,
        SUM(d.discount_amount) as discount_amount,
        SUM(d.income_amount) as income_amount,
        SUM(d.refund_amount) as refund_amount,
        COUNT(DISTINCT d.order_no) as order_count,
        COUNT(DISTINCT CASE WHEN m.id IS NOT NULL THEN d.product_code || '|' || d.product_name || '|' || d.spec END) as cost_covered_product_count,
        SUM(CASE WHEN m.id IS NOT NULL THEN d.quantity * COALESCE(mi.cost, 0) ELSE 0 END) as estimated_cost,
        SUM(CASE WHEN m.id IS NOT NULL THEN d.income_amount - d.quantity * COALESCE(mi.cost, 0) ELSE 0 END) as net_income
      FROM dish_sales d
      LEFT JOIN dish_sales_mappings m ON m.product_code = d.product_code AND m.product_name = d.product_name
        AND m.spec = CASE WHEN d.spec IN ('', '--') THEN '' ELSE d.spec END
      LEFT JOIN menu_items mi ON mi.id = m.menu_item_id
      ${where}`, params);
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
    res.json({ ok: true, summary, top: rows, total, page: pg, page_size: psize, hourly_trend });
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

app.post('/api/bookkeeping/quick-entry/commit', (req, res) => {
  try {
    const date = String(req.body.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '请选择归属日期' });
    const { rows, errors } = resolveQuickBookkeepingRows(req, req.body.text);
    if (errors.length) return res.status(400).json({ error: '数据校验未通过，请先修正后重新解析', errors });
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
    if (isExpense && options.excludeRow?.(row)) return;
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
      if (amount > 0 && !isStoredValue(row)) target.income += amount;
      if (amount < 0 && !recurringMatcher(row)) target.expense -= amount;
    });
    const dailyProfitSeries = [];
    let cumulativeProfit = 0;
    for (let day = 1; day <= period.elapsed_days; day++) {
      const date = `${String(month)}-${String(day).padStart(2, '0')}`;
      const row = profitByDate.get(date) || {};
      const income = Number(row.income || 0);
      const expense = Number(row.expense || 0) + (view === 'accrual' ? recurringCosts.reduce((sum, item) => sum + Number(item.daily_amount || 0), 0) : 0);
      const dailyNet = income - expense;
      cumulativeProfit += dailyNet;
      dailyProfitSeries.push({ date, day, income, expense, daily_net: dailyNet, cumulative_net: cumulativeProfit });
    }
    const incomeRows = buildMonthlyDashboardGroups(monthRows, dayRows, 'income');
    const expenseRows = buildMonthlyDashboardGroups(monthRows, dayRows, 'expense', { excludeRow: recurringMatcher, accrualItems });
    const storedValueRows = buildMonthlyDashboardGroups(monthRows, dayRows, 'stored');
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

app.get('/api/business-analytics/products/:scope', (req, res) => {
  try {
    const scope = req.params.scope;
    if (!['overview','group-buy','delivery'].includes(scope)) return res.status(404).json({ error: '分析视角不存在' });
    res.json({ ok: true, ...businessAnalytics.getProductAnalytics(db, scope, req.query) });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    const menu = db.queryOne('SELECT id FROM menu_items WHERE id=?', [menuId]);
    if (!menu) return res.status(400).json({ error: '本地菜品不存在' });
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

// 一键绑定：未绑定的平台商品按名称自动匹配本地菜品；同名多规格（平台无规格信息）时跳过避免误绑
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
    const menus = db.queryAll("SELECT id,name,category FROM menu_items WHERE status='在售'");
    const byName = new Map();
    menus.forEach(m => {
      const list = byName.get(m.name);
      if (list) list.push(m); else byName.set(m.name, [m]);
    });
    const group = scope === 'delivery' ? 'delivery' : 'group_buy';
    let bound = 0, skipped = 0;
    const reasons = { no_name_match: 0, ambiguous_name: 0 };
    db.run('BEGIN');
    for (const r of rows) {
      const candidates = byName.get(String(r.product_name || '').trim()) || [];
      if (!candidates.length) { reasons.no_name_match++; skipped++; continue; }
      if (candidates.length > 1) { reasons.ambiguous_name++; skipped++; continue; }
      db.run(`INSERT INTO business_product_mappings (platform, channel_group, external_product_name, menu_item_id)
        VALUES (?,?,?,?) ON CONFLICT(platform, external_product_name)
        DO UPDATE SET channel_group=excluded.channel_group, menu_item_id=excluded.menu_item_id, updated_at=datetime('now','localtime')`,
        [r.platform, group, String(r.product_name || '').trim(), candidates[0].id]);
      bound++;
    }
    db.run('COMMIT');
    db.save();
    res.json({ ok: true, bound, skipped, reasons });
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

// 淘宝闪购“全部门店营业额收入单量”报表：与美团同口径，按淘宝闪购平台门店 ID 关联。
app.post('/api/business-analytics/import/taobao-flash', (req, res) => {
  try {
    const result = businessAnalytics.importTaobaoFlashWorkbook(db, req.body || {}, req.user);
    res.status(201).json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
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
  // 启动智能机器人长连接
  wecomBot.start().catch(err => console.error('[wecom-bot] 启动失败:', err.message));
  setupConsoleEncoding();
  await db.init();
  db.seed();

  // 确保 admin 和 agent 用户存在并密码正确（兼容旧数据库）
  (function ensureUsers() {
    const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
    const adminHash = md5('admin123');
    const agentHash = md5('agent123');
    const admin = db.queryOne("SELECT * FROM users WHERE username='admin'");
    if (!admin) {
      db.insert("INSERT INTO users (username,password_hash,role,display_name) VALUES ('admin',?,'管理员','系统管理员')", [adminHash]);
    } else if (admin.password_hash !== adminHash || admin.role !== '管理员') {
      db.run("UPDATE users SET password_hash=?, role='管理员', display_name='系统管理员' WHERE username='admin'", [adminHash]);
    }
    const agent = db.queryOne("SELECT * FROM users WHERE username='agent'");
    if (!agent) {
      db.insert("INSERT INTO users (username,password_hash,role,display_name) VALUES ('agent',?,'专员','数据专员')", [agentHash]);
    } else if (agent.password_hash !== agentHash || agent.role !== '专员') {
      db.run("UPDATE users SET password_hash=?, role='专员', display_name='数据专员' WHERE username='agent'", [agentHash]);
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
