/**
 * 中控后台 - 后端服务 v0.3.0
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

const app = express();
const PORT = process.env.PORT || 3456;
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ===== 中间件 =====
app.use(express.json({ limit: '50mb' }));

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
  res.json({ corpid: cfg.corpid || '', corpsecret_masked: cfg.corpsecret ? cfg.corpsecret.slice(0, 6) + '****' + cfg.corpsecret.slice(-4) : '', webhook: cfg.webhook || '', webhookName: cfg.webhookName || '', configured: !!(cfg.corpid && cfg.corpsecret), webhookConfigured: !!cfg.webhook });
});
app.post('/api/config', (req, res) => {
  const { corpid, corpsecret, webhook, webhookName } = req.body;
  const cfg = loadConfig();
  if (corpid !== undefined) cfg.corpid = corpid.trim();
  if (corpsecret !== undefined) cfg.corpsecret = corpsecret.trim();
  if (webhook !== undefined) cfg.webhook = webhook.trim();
  if (webhookName !== undefined) cfg.webhookName = webhookName.trim();
  saveConfig(cfg);
  res.json({ ok: true, configured: !!(cfg.corpid && cfg.corpsecret), webhookConfigured: !!cfg.webhook });
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

app.get('/api/stores/:id', (req, res) => { try { const stores = loadStores(); const s = stores.find(s => s.id === req.params.id); if (!s) return res.status(404).json({ error: '门店不存在' }); res.json({ ok: true, store: s }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/stores/:id', (req, res) => { try { const stores = loadStores(); const idx = stores.findIndex(s => s.id === req.params.id); if (idx === -1) return res.status(404).json({ error: '门店不存在' }); STORE_FIELDS.forEach(f => { if (req.body[f] !== undefined) stores[idx][f] = String(req.body[f]).trim(); }); saveStores(stores); res.json({ ok: true, store: stores[idx] }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put('/api/stores/:id', (req, res) => { try { const stores = loadStores(); const idx = stores.findIndex(s => s.id === req.params.id); if (idx === -1) return res.status(404).json({ error: '门店不存在' }); STORE_FIELDS.forEach(f => { if (req.body[f] !== undefined) stores[idx][f] = String(req.body[f]).trim(); }); saveStores(stores); res.json({ ok: true, store: stores[idx] }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/stores/:id', (req, res) => { try { let stores = loadStores(); const idx = stores.findIndex(s => s.id === req.params.id); if (idx === -1) return res.status(404).json({ error: '门店不存在' }); const removed = stores[idx]; stores = stores.filter(s => s.id !== req.params.id); saveStores(stores); res.json({ ok: true, message: '门店已删除', removed }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/stores/init', (req, res) => { try { const excelStores = parseDailyExcel(); let stores = loadStores(); excelStores.forEach(es => { const existing = stores.find(s => s.id === es.id); if (!existing) { const s = { id: es.id }; STORE_FIELDS.forEach(f => { s[f] = ''; }); s.storeName = es.storeName; stores.push(s); } else if (!existing.storeName || existing.storeName !== es.storeName) existing.storeName = es.storeName; }); stores.sort((a, b) => { const na = parseInt(a.id.replace('store_', '')), nb = parseInt(b.id.replace('store_', '')); return na - nb; }); saveStores(stores); res.json({ ok: true, stores, count: stores.length }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ==========================================
//  SQLite 版门店管理（新路由，路径 /api/db/stores）
// ==========================================

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
  try { const { store_name, status, store_type, legal_person, payment_type, region, province, city, district, address, phone, business_hours, opening_date, table_2person, table_4person, store_size } = req.body; if (!store_name) return res.status(400).json({ error: '门店名称不能为空' }); const id = db.insert('INSERT INTO stores (store_name,status,store_type,legal_person,payment_type,region,province,city,district,address,phone,business_hours,opening_date,table_2person,table_4person,store_size) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [store_name, status||'正常营业', store_type||'直营店', legal_person||'', payment_type||'法人收款', region||'', province||'', city||'', district||'', address||'', phone||'', business_hours||'', opening_date||null, table_2person||0, table_4person||0, store_size||'']); db.save(); res.json({ ok: true, id }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/db/stores/:id', (req, res) => {
  try { const allowedFields = ['store_name','status','store_type','legal_person','payment_type','region','province','city','district','address','phone','business_hours','opening_date','table_2person','table_4person','store_size']; const sets = [], params = []; allowedFields.forEach(f => { if (req.body[f] !== undefined) { sets.push(`${f}=?`); params.push(req.body[f]); } }); if (!sets.length) return res.status(400).json({ error: '没有要更新的字段' }); sets.push("updated_at=datetime('now','localtime')"); params.push(req.params.id); const affected = db.run(`UPDATE stores SET ${sets.join(',')} WHERE id=?`, params); db.save(); if (!affected) return res.status(404).json({ error: '门店不存在' }); res.json({ ok: true, message: '已更新' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/db/stores/:id', (req, res) => {
  try { const affected = db.run('DELETE FROM stores WHERE id=?', [req.params.id]); db.save(); if (!affected) return res.status(404).json({ error: '门店不存在' }); res.json({ ok: true, message: '已删除' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 第三方平台 =====
app.get('/api/stores/:id/platforms', (req, res) => { try { res.json({ ok: true, platforms: db.queryAll('SELECT * FROM store_platforms WHERE store_id=?', [req.params.id]) }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/stores/:id/platforms', (req, res) => { try { const { platform_name, platform_id } = req.body; if (!platform_name) return res.status(400).json({ error: '平台名称不能为空' }); const id = db.insert('INSERT INTO store_platforms (store_id,platform_name,platform_id) VALUES (?,?,?)', [req.params.id, platform_name, platform_id||'']); db.save(); res.json({ ok: true, id }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put('/api/platforms/:id', (req, res) => { try { const { platform_name, platform_id } = req.body; db.run('UPDATE store_platforms SET platform_name=COALESCE(?,platform_name), platform_id=COALESCE(?,platform_id) WHERE id=?', [platform_name, platform_id, req.params.id]); db.save(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/platforms/:id', (req, res) => { try { db.run('DELETE FROM store_platforms WHERE id=?', [req.params.id]); db.save(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ===== 员工 =====
app.get('/api/stores/:id/employees', (req, res) => {
  try { const { status } = req.query; let sql = 'SELECT * FROM employees WHERE store_id=?'; const params = [req.params.id]; if (status) { sql += ' AND status=?'; params.push(status); } sql += ' ORDER BY id'; res.json({ ok: true, employees: db.queryAll(sql, params) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/stores/:id/employees', (req, res) => { try { const { name, status, hire_date, hire_type, position, salary } = req.body; if (!name) return res.status(400).json({ error: '员工姓名不能为空' }); const id = db.insert('INSERT INTO employees (store_id,name,status,hire_date,hire_type,position,salary) VALUES (?,?,?,?,?,?,?)', [req.params.id, name, status||'在职', hire_date||null, hire_type||'全职', position||'', salary||0]); db.save(); res.json({ ok: true, id }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put('/api/employees/:id', (req, res) => { try { const fields = ['store_id','name','status','hire_date','hire_type','position','salary','leave_date']; const sets = [], params = []; fields.forEach(f => { if (req.body[f] !== undefined) { sets.push(`${f}=?`); params.push(req.body[f]); } }); if (!sets.length) return res.status(400).json({ error: '没有要更新的字段' }); params.push(req.params.id); db.run(`UPDATE employees SET ${sets.join(',')} WHERE id=?`, params); db.save(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/employees/:id', (req, res) => { try { db.run('DELETE FROM employees WHERE id=?', [req.params.id]); db.save(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ===== 固定成本 =====
app.get('/api/stores/:id/fixed-costs', (req, res) => { try { res.json({ ok: true, costs: db.queryAll('SELECT * FROM store_fixed_costs WHERE store_id=?', [req.params.id]) }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put('/api/fixed-costs/:id', (req, res) => { try { const { amount, cost_type } = req.body; const sets = [], params = []; if (amount !== undefined) { sets.push('amount=?'); params.push(amount); } if (cost_type !== undefined) { sets.push('cost_type=?'); params.push(cost_type); } if (!sets.length) return res.status(400).json({ error: '没有要更新的字段' }); params.push(req.params.id); db.run(`UPDATE store_fixed_costs SET ${sets.join(',')} WHERE id=?`, params); db.save(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ===== 运营成本 =====
app.get('/api/stores/:id/operating-costs', (req, res) => { try { res.json({ ok: true, costs: db.queryAll('SELECT * FROM store_operating_costs WHERE store_id=? ORDER BY date DESC, id DESC', [req.params.id]) }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/stores/:id/operating-costs', (req, res) => { try { const { store_name, date, item, amount } = req.body; if (!item) return res.status(400).json({ error: '事项不能为空' }); const id = db.insert('INSERT INTO store_operating_costs (store_id,store_name,date,item,amount) VALUES (?,?,?,?,?)', [req.params.id, store_name||'', date||new Date().toISOString().slice(0,10), item, amount||0]); db.save(); res.json({ ok: true, id }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/operating-costs/:id', (req, res) => { try { db.run('DELETE FROM store_operating_costs WHERE id=?', [req.params.id]); db.save(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ===== 菜品管理 =====
app.get('/api/menu', (req, res) => {
  try { const { store_id, category, status } = req.query; let sql = 'SELECT m.*, s.store_name FROM menu_items m LEFT JOIN stores s ON m.store_id=s.id WHERE 1=1'; const params = []; if (store_id) { sql += ' AND m.store_id=?'; params.push(store_id); } if (category) { sql += ' AND m.category=?'; params.push(category); } if (status) { sql += ' AND m.status=?'; params.push(status); } sql += ' ORDER BY m.id'; res.json({ ok: true, items: db.queryAll(sql, params), count: db.queryAll(sql, params).length }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/menu', (req, res) => { try { const { store_id, name, category, price, cost, expiry_days } = req.body; if (!name) return res.status(400).json({ error: '菜品名称不能为空' }); const id = db.insert('INSERT INTO menu_items (store_id,name,category,price,cost,expiry_days) VALUES (?,?,?,?,?,?)', [store_id||1, name, category||'', price||0, cost||0, expiry_days||null]); db.save(); res.json({ ok: true, id }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put('/api/menu/:id', (req, res) => { try { const fields = ['name','category','price','cost','expiry_days','status']; const sets = [], params = []; fields.forEach(f => { if (req.body[f] !== undefined) { sets.push(`${f}=?`); params.push(req.body[f]); } }); if (!sets.length) return res.status(400).json({ error: '没有要更新的字段' }); params.push(req.params.id); db.run(`UPDATE menu_items SET ${sets.join(',')} WHERE id=?`, params); db.save(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/menu/:id', (req, res) => { try { db.run('DELETE FROM menu_items WHERE id=?', [req.params.id]); db.save(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

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

// ===== 用户管理 =====
app.get('/api/users', (req, res) => { try { res.json({ ok: true, users: db.queryAll('SELECT id,username,role,display_name,created_at FROM users ORDER BY id') }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/users', (req, res) => { try { const { username, password, role, display_name } = req.body; if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' }); const hash = crypto.createHash('md5').update(password).digest('hex'); const id = db.insert('INSERT INTO users (username,password_hash,role,display_name) VALUES (?,?,?,?)', [username, hash, role||'客服', display_name||username]); db.save(); res.json({ ok: true, id }); } catch (e) { if (e.message?.includes('UNIQUE')) return res.status(400).json({ error: '用户名已存在' }); res.status(500).json({ error: e.message }); } });
app.put('/api/users/:id', (req, res) => { try { const { password, role, display_name } = req.body; const sets = [], params = []; if (password) { sets.push('password_hash=?'); params.push(crypto.createHash('md5').update(password).digest('hex')); } if (role) { sets.push('role=?'); params.push(role); } if (display_name) { sets.push('display_name=?'); params.push(display_name); } if (!sets.length) return res.status(400).json({ error: '没有要更新的字段' }); params.push(req.params.id); db.run(`UPDATE users SET ${sets.join(',')} WHERE id=?`, params); db.save(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/users/:id', (req, res) => { try { db.run('DELETE FROM users WHERE id=?', [req.params.id]); db.save(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ===== 数据分析 =====
app.get('/api/analysis/revenue', (req, res) => {
  try { const { store_id, date } = req.query; let sql = 'SELECT * FROM daily_reports WHERE 1=1'; const params = []; if (store_id) { sql += ' AND store_id=?'; params.push(store_id); } if (date) { sql += ' AND date=?'; params.push(date); } else { sql += " AND date=(SELECT MAX(date) FROM daily_reports)"; } const rows = db.queryAll(sql, params); const channels = { instore:0, pickup:0, mtWaimai:0, tbFlash:0, jdWaimai:0, mtPay:0, mtTuan:0, dyTuan:0, stored:0, coupon:0 }; rows.forEach(r => { channels.instore += r.instore||0; channels.pickup += r.pickup||0; channels.mtWaimai += r.mt_waimai||0; channels.tbFlash += r.tb_flash||0; channels.jdWaimai += r.jd_waimai||0; channels.mtPay += r.mt_pay||0; channels.mtTuan += r.mt_tuan||0; channels.dyTuan += r.dy_tuan||0; channels.stored += r.stored_value||0; channels.coupon += r.coupon||0; }); res.json({ ok: true, channels, totalRevenue: rows.reduce((s,r)=>s+(r.revenue||0),0) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/analysis/cost', (req, res) => { try { const { store_id } = req.query; let sql = 'SELECT * FROM cost_accounting WHERE 1=1'; const params = []; if (store_id) { sql += ' AND store_id=?'; params.push(store_id); } sql += ' ORDER BY date DESC LIMIT 30'; res.json({ ok: true, rows: db.queryAll(sql, params) }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/analysis/sales', (req, res) => { try { res.json({ ok: true, rows: db.queryAll('SELECT store_name,date,revenue,actual_revenue,order_count,discount_amount FROM daily_reports ORDER BY date DESC LIMIT 50') }); } catch (e) { res.status(500).json({ error: e.message }); } });

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

// ===== 启动 =====
(async () => {
  setupConsoleEncoding();
  await db.init();
  db.seed();

  console.log('═'.repeat(50));
  console.log('  编码环境确认');
  console.log('  系统平台 :', os.platform());
  console.log('  文件编码 : UTF-8 (所有 fs 读写均显式指定)');
  console.log('  响应编码 : Content-Type + charset=utf-8');
  console.log('═'.repeat(50));
  app.listen(PORT, () => {
    console.log(`🚀 中控后台已启动: http://localhost:${PORT}`);
    console.log(`📦 数据库: data/database.sqlite`);
  });
})();
