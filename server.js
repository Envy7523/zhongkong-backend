/**
 * 中控后台 - 后端服务
 * 负责：代理企业微信 API 调用、Webhook 消息推送
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3456;

// 配置文件路径
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ===== 中间件 =====
app.use(express.json());
app.use(express.static(__dirname)); // 提供前端静态文件

// ===== 工具函数 =====

/** 读取本地配置 */
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return { corpid: '', corpsecret: '', webhook: '', webhookName: '' };
  }
}

/** 保存本地配置 */
function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/** 通用 HTTP 请求 */
async function httpPost(url, body, headers = {}) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function httpGet(url, headers = {}) {
  const resp = await fetch(url, { headers });
  return resp.json();
}

// ===== API: 配置管理 =====

/** GET /api/config — 获取当前配置（脱敏） */
app.get('/api/config', (_req, res) => {
  const cfg = loadConfig();
  res.json({
    corpid: cfg.corpid || '',
    corpsecret_masked: cfg.corpsecret
      ? cfg.corpsecret.slice(0, 6) + '****' + cfg.corpsecret.slice(-4)
      : '',
    webhook: cfg.webhook || '',
    webhookName: cfg.webhookName || '',
    configured: !!(cfg.corpid && cfg.corpsecret),
    webhookConfigured: !!cfg.webhook,
  });
});

/** POST /api/config — 保存配置 */
app.post('/api/config', (req, res) => {
  const { corpid, corpsecret, webhook, webhookName } = req.body;
  const cfg = loadConfig();

  if (corpid !== undefined) cfg.corpid = corpid.trim();
  if (corpsecret !== undefined) cfg.corpsecret = corpsecret.trim();
  if (webhook !== undefined) cfg.webhook = webhook.trim();
  if (webhookName !== undefined) cfg.webhookName = webhookName.trim();

  saveConfig(cfg);

  res.json({
    ok: true,
    configured: !!(cfg.corpid && cfg.corpsecret),
    webhookConfigured: !!cfg.webhook,
  });
});

// ===== API: 企业微信 =====

/** 内存缓存 access_token */
let tokenCache = { token: null, expiresAt: 0 };

/** GET /api/wechat/token — 获取 access_token */
app.get('/api/wechat/token', async (_req, res) => {
  const cfg = loadConfig();
  if (!cfg.corpid || !cfg.corpsecret) {
    return res.status(400).json({ error: '请先配置 corpid 和 corpsecret' });
  }

  // 检查缓存
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return res.json({
      ok: true,
      access_token: tokenCache.token,
      cached: true,
      expires_in: Math.floor((tokenCache.expiresAt - Date.now()) / 1000),
    });
  }

  try {
    const data = await httpGet(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${cfg.corpid}&corpsecret=${cfg.corpsecret}`
    );

    if (data.errcode === 0) {
      tokenCache = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in - 300) * 1000, // 提前 5 分钟刷新
      };
      res.json({ ok: true, access_token: data.access_token, cached: false, expires_in: data.expires_in });
    } else {
      res.status(400).json({ error: `获取 token 失败: [${data.errcode}] ${data.errmsg}` });
    }
  } catch (err) {
    res.status(500).json({ error: `网络错误: ${err.message}` });
  }
});

/** POST /api/wechat/send — 通过 Webhook 发送消息到群聊 */
app.post('/api/wechat/send', async (req, res) => {
  const cfg = loadConfig();
  const webhookUrl = req.body.webhook || cfg.webhook;

  if (!webhookUrl) {
    return res.status(400).json({ error: '请先配置 Webhook 地址' });
  }

  const {
    msgtype = 'text',
    content,
    title,
    picurl,
    url,
    mentioned_list,
    mentioned_mobile_list,
  } = req.body;

  // 构建 @提醒 数据
  const mentions = {};
  if (mentioned_list && mentioned_list.length) {
    mentions.mentioned_list = mentioned_list;
  }
  if (mentioned_mobile_list && mentioned_mobile_list.length) {
    mentions.mentioned_mobile_list = mentioned_mobile_list;
  }

  let payload;
  if (msgtype === 'text') {
    payload = {
      msgtype: 'text',
      text: { content: content || '（空消息）', ...mentions },
    };
  } else if (msgtype === 'markdown') {
    payload = {
      msgtype: 'markdown',
      markdown: { content: content || '' },
    };
    // markdown 也支持 mentioned_list（企业微信部分版本支持）
    if (Object.keys(mentions).length) {
      payload.markdown = { ...payload.markdown, ...mentions };
    }
  } else if (msgtype === 'news') {
    // news 类型必须提供 url，否则企业微信 API 返回 40039
    if (!url) {
      return res.status(400).json({
        error: '图文消息(msgtype=news)缺少必填参数 url（文章跳转链接）。\n提示：请在前端自定义消息表单中填入链接地址。',
      });
    }
    const article = {
      title: title || content || '消息',
      description: content || '',
      url: url,
    };
    if (picurl) article.picurl = picurl;
    payload = { msgtype: 'news', news: { articles: [article] } };
  } else {
    payload = { msgtype, ...req.body.extra };
  }

  try {
    const data = await httpPost(webhookUrl, payload);
    if (data.errcode === 0) {
      res.json({ ok: true, message: '消息发送成功' });
    } else {
      res.status(400).json({ error: `发送失败: [${data.errcode}] ${data.errmsg}` });
    }
  } catch (err) {
    res.status(500).json({ error: `网络错误: ${err.message}` });
  }
});

/** POST /api/wechat/doc — 读取企业微信文档/数据（框架） */
app.post('/api/wechat/doc', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.corpid || !cfg.corpsecret) {
    return res.status(400).json({ error: '请先配置 corpid 和 corpsecret' });
  }

  // 先获取 token
  let token;
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    token = tokenCache.token;
  } else {
    try {
      const tokenData = await httpGet(
        `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${cfg.corpid}&corpsecret=${cfg.corpsecret}`
      );
      if (tokenData.errcode !== 0) {
        return res.status(400).json({ error: `获取 token 失败: [${tokenData.errcode}] ${tokenData.errmsg}` });
      }
      token = tokenData.access_token;
      tokenCache = {
        token,
        expiresAt: Date.now() + (tokenData.expires_in - 300) * 1000,
      };
    } catch (err) {
      return res.status(500).json({ error: `网络错误: ${err.message}` });
    }
  }

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

  try {
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
        // 拼接额外参数
        for (const [k, v] of Object.entries(params)) {
          if (k !== 'path') url += `&${k}=${encodeURIComponent(v)}`;
        }
        result = await httpGet(url);
        break;

      default:
        return res.status(400).json({ error: `未知 API: ${api}` });
    }

    if (result.errcode !== undefined && result.errcode !== 0) {
      return res.status(400).json({
        error: `API 调用失败: [${result.errcode}] ${result.errmsg}`,
        detail: result,
      });
    }

    res.json({ ok: true, api, data: result });
  } catch (err) {
    res.status(500).json({ error: `网络错误: ${err.message}` });
  }
});

/** POST /api/wechat/pipeline — 组合操作：读取数据 → 推送到群 */
app.post('/api/wechat/pipeline', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.corpid || !cfg.corpsecret) {
    return res.status(400).json({ error: '请先配置 corpid 和 corpsecret' });
  }
  if (!cfg.webhook) {
    return res.status(400).json({ error: '请先配置 Webhook 地址' });
  }

  const { api, params = {}, msgtype = 'markdown', format } = req.body;

  // 先获取 token（复用缓存）
  let token;
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    token = tokenCache.token;
  } else {
    try {
      const tokenData = await httpGet(
        `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${cfg.corpid}&corpsecret=${cfg.corpsecret}`
      );
      if (tokenData.errcode !== 0) {
        return res.status(400).json({ error: `获取 token 失败: [${tokenData.errcode}] ${tokenData.errmsg}` });
      }
      token = tokenData.access_token;
      tokenCache = { token, expiresAt: Date.now() + (tokenData.expires_in - 300) * 1000 };
    } catch (err) {
      return res.status(500).json({ error: `网络错误: ${err.message}` });
    }
  }

  // 读取数据
  let dataResult;
  try {
    let url;
    switch (api) {
      case 'department_list':
        url = `https://qyapi.weixin.qq.com/cgi-bin/department/list?access_token=${token}`;
        dataResult = await httpGet(url);
        break;
      case 'user_list':
        url = `https://qyapi.weixin.qq.com/cgi-bin/user/list?access_token=${token}&department_id=${params.department_id || 1}&fetch_child=1`;
        dataResult = await httpGet(url);
        break;
      default:
        return res.status(400).json({ error: `不支持的 pipeline API: ${api}` });
    }

    if (dataResult.errcode !== undefined && dataResult.errcode !== 0) {
      return res.status(400).json({ error: `数据读取失败: [${dataResult.errcode}] ${dataResult.errmsg}` });
    }
  } catch (err) {
    return res.status(500).json({ error: `读取数据网络错误: ${err.message}` });
  }

  // 格式化消息
  let messageContent;
  if (typeof format === 'function') {
    // 前端传不了函数，这里忽略
    messageContent = JSON.stringify(dataResult, null, 2);
  } else {
    messageContent = formatDataForMessage(api, dataResult);
  }

  // 发送到群
  try {
    const payload = msgtype === 'markdown'
      ? { msgtype: 'markdown', markdown: { content: messageContent } }
      : { msgtype: 'text', text: { content: messageContent } };

    const sendResult = await httpPost(cfg.webhook, payload);

    if (sendResult.errcode === 0) {
      res.json({ ok: true, message: '数据已读取并推送到群', data: dataResult });
    } else {
      res.status(400).json({
        error: `数据已读取但发送失败: [${sendResult.errcode}] ${sendResult.errmsg}`,
        data: dataResult,
      });
    }
  } catch (err) {
    res.status(500).json({ error: `数据已读取但发送网络错误: ${err.message}`, data: dataResult });
  }
});

/** 格式化 API 返回数据为群消息 */
function formatDataForMessage(api, data) {
  const now = new Date().toLocaleString('zh-CN');

  switch (api) {
    case 'department_list': {
      const depts = data.department || [];
      let msg = `## 📋 部门列表\n> 更新时间：${now}\n> 共 **${depts.length}** 个部门\n\n`;
      depts.forEach(d => {
        msg += `- **${d.name}** (ID: ${d.id})\n`;
      });
      return msg;
    }

    case 'user_list': {
      const users = data.userlist || [];
      let msg = `## 👥 成员列表\n> 更新时间：${now}\n> 共 **${users.length}** 人\n\n`;
      users.forEach(u => {
        msg += `- **${u.name}**`;
        if (u.position) msg += ` — ${u.position}`;
        if (u.mobile) msg += ` 📱${u.mobile}`;
        msg += `\n`;
      });
      return msg;
    }

    default:
      return `## 📊 数据查询结果\n> 时间：${now}\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  }
}

// ===== 辅助：获取 access_token（带缓存） =====
async function ensureToken() {
  const cfg = loadConfig();
  if (!cfg.corpid || !cfg.corpsecret) {
    throw new Error('请先配置 corpid 和 corpsecret');
  }
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  const data = await httpGet(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${cfg.corpid}&corpsecret=${cfg.corpsecret}`
  );
  if (data.errcode !== 0) {
    throw new Error(`获取 token 失败: [${data.errcode}] ${data.errmsg}`);
  }
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 300) * 1000,
  };
  return tokenCache.token;
}

// ===== API: 企业微信文档/智能表格 =====

/** POST /api/wechat/table/info — 获取文档基础信息 */
app.post('/api/wechat/table/info', async (req, res) => {
  try {
    const token = await ensureToken();
    const { doc_id } = req.body;
    if (!doc_id) return res.status(400).json({ error: '缺少 doc_id 参数（文档 ID）' });

    const result = await httpPost(
      `https://qyapi.weixin.qq.com/cgi-bin/wedoc/get_doc_base_info?access_token=${token}`,
      { docid: doc_id }
    );
    if (result.errcode !== 0) {
      return res.status(400).json({ error: `[${result.errcode}] ${result.errmsg}`, detail: result });
    }
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/wechat/table/sheets — 获取表格的工作表列表 */
app.post('/api/wechat/table/sheets', async (req, res) => {
  try {
    const token = await ensureToken();
    const { doc_id } = req.body;
    if (!doc_id) return res.status(400).json({ error: '缺少 doc_id 参数（文档 ID）' });

    const result = await httpPost(
      `https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/get_sheet?access_token=${token}`,
      { docid: doc_id }
    );
    if (result.errcode !== 0) {
      return res.status(400).json({ error: `[${result.errcode}] ${result.errmsg}`, detail: result });
    }
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/wechat/table/records — 读取表格记录 */
app.post('/api/wechat/table/records', async (req, res) => {
  try {
    const token = await ensureToken();
    const {
      doc_id,        // 文档 ID（必填）
      sheet_id,      // 工作表 ID（必填）
      limit = 100,   // 返回记录数
      offset = 0,    // 偏移量
      view_id,       // 视图 ID（可选）
      sort,          // 排序（可选）
      filter_spec,   // 筛选条件（可选）
    } = req.body;

    if (!doc_id) return res.status(400).json({ error: '缺少 doc_id 参数（文档 ID）' });
    if (!sheet_id) return res.status(400).json({ error: '缺少 sheet_id 参数（工作表 ID）' });

    const requestBody = {
      docid: doc_id,
      sheet_id: sheet_id,
      limit: Math.min(limit, 500),
      offset: offset,
    };
    if (view_id) requestBody.view_id = view_id;
    if (sort) requestBody.sort = sort;
    if (filter_spec) requestBody.filter_spec = filter_spec;

    const result = await httpPost(
      `https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/get_records?access_token=${token}`,
      requestBody
    );
    if (result.errcode !== 0) {
      return res.status(400).json({ error: `[${result.errcode}] ${result.errmsg}`, detail: result });
    }
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/wechat/table/pipeline — 读取表格数据 → 推送到群 */
app.post('/api/wechat/table/pipeline', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.webhook) return res.status(400).json({ error: '请先配置 Webhook 地址' });

  try {
    const token = await ensureToken();
    const { doc_id, sheet_id, limit = 100, offset = 0 } = req.body;

    if (!doc_id || !sheet_id) return res.status(400).json({ error: '缺少 doc_id 或 sheet_id' });

    // 读取表格记录
    const recordsResult = await httpPost(
      `https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/get_records?access_token=${token}`,
      { docid: doc_id, sheet_id, limit: Math.min(limit, 500), offset }
    );

    if (recordsResult.errcode !== 0) {
      return res.status(400).json({ error: `读取表格失败: [${recordsResult.errcode}] ${recordsResult.errmsg}` });
    }

    // 格式化为消息
    const records = recordsResult.records || [];
    const now = new Date().toLocaleString('zh-CN');
    let msg = `## 📊 表格数据\n> 更新时间：${now}\n> 共 **${records.length}** 条记录\n\n`;

    // 取前 20 条格式化
    records.slice(0, 20).forEach((rec, i) => {
      const values = rec.values || {};
      msg += `**${i + 1}.** `;
      const fields = Object.entries(values).slice(0, 5).map(([k, v]) => {
        const val = Array.isArray(v) ? v.map(x => x.text || x).join(', ') : v;
        return `${k}: ${val}`;
      }).join(' | ');
      msg += fields + '\n';
    });

    if (records.length > 20) msg += `\n> ... 还有 ${records.length - 20} 条记录`;

    // 发送到群
    const sendResult = await httpPost(cfg.webhook, {
      msgtype: 'markdown',
      markdown: { content: msg },
    });

    if (sendResult.errcode !== 0) {
      return res.status(400).json({ error: `表格已读取但发送失败: [${sendResult.errcode}] ${sendResult.errmsg}` });
    }

    res.json({ ok: true, message: '表格数据已推送到群', recordCount: records.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 启动服务 =====
app.listen(PORT, () => {
  console.log(`🚀 中控后台已启动: http://localhost:${PORT}`);
  console.log(`📋 API 文档:`);
  console.log(`   GET  /api/config               — 查看配置`);
  console.log(`   POST /api/config               — 保存配置`);
  console.log(`   GET  /api/wechat/token         — 获取 access_token`);
  console.log(`   POST /api/wechat/send          — 发送消息到群`);
  console.log(`   POST /api/wechat/doc           — 读取企业数据`);
  console.log(`   POST /api/wechat/pipeline      — 读取数据并推送到群`);
  console.log(`   POST /api/wechat/table/info    — 获取文档信息`);
  console.log(`   POST /api/wechat/table/sheets  — 获取工作表列表`);
  console.log(`   POST /api/wechat/table/records — 读取表格记录`);
  console.log(`   POST /api/wechat/table/pipeline— 读取表格并推送到群`);
});
