/**
 * 企业微信智能机器人 — WebSocket 长连接模块
 *
 * 基于 @wecom/aibot-node-sdk，通过长连接接收和回复消息。
 * 与群机器人 Webhook 不同，无需回调 URL / Token / corpid。
 *
 * 配置来源：config.json 中的 botId 和 botSecret。
 * 来源路径：企业微信「工作台」→「智能机器人」→ API 模式 → 使用长连接。
 */

const AiBot = require('@wecom/aibot-node-sdk');
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

/** 剥离 UTF-8 BOM */
function stripBOM(str) {
  if (typeof str !== 'string') return str;
  return str.codePointAt(0) === 0xFEFF ? str.slice(1) : str;
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(stripBOM(raw));
  } catch {
    return {};
  }
}

/** @type {import('@wecom/aibot-node-sdk').WSClient|null} */
let wsClient = null;
let textMessageHandler = null;
let fileMessageHandler = null;

// ── 状态跟踪 ──
const state = {
  connected: false,
  authenticated: false,
  lastError: null,
  reconnectAttempt: 0,
  startedAt: null,
  lastInboundAt: null,
  lastInboundType: '',
  lastReplyAt: null,
  lastReplyError: null,
};

/**
 * 初始化并连接智能机器人
 * @returns {Promise<object>} 状态摘要
 */
async function start() {
  const cfg = loadConfig();
  const botId = cfg.botId;
  const secret = cfg.botSecret;

  if (!botId || !secret) {
    console.log('[wecom-bot] ⚠️  未配置 botId / botSecret，跳过智能机器人连接');
    return { ok: false, reason: 'botId 或 botSecret 未配置' };
  }

  // 每次建立新连接前清理旧状态，避免配置更新后的历史错误残留在设置页中。
  state.connected = false;
  state.authenticated = false;
  state.lastError = null;
  state.reconnectAttempt = 0;
  state.startedAt = null;
  state.lastInboundAt = null;
  state.lastInboundType = '';
  state.lastReplyAt = null;
  state.lastReplyError = null;

  // 如果已存在连接则先断开
  if (wsClient) {
    try { wsClient.disconnect(); } catch {}
  }

  wsClient = new AiBot.WSClient({
    botId,
    secret,
    reconnectInterval: 1000,
    maxReconnectAttempts: -1, // 无限重连
    heartbeatInterval: 30000,
    requestTimeout: 10000,
  });

  // ── 连接事件 ──
  wsClient.on('connected', () => {
    state.connected = true;
    console.log('[wecom-bot] 🔗 WebSocket 已连接');
  });

  wsClient.on('authenticated', () => {
    state.authenticated = true;
    state.startedAt = new Date().toISOString();
    console.log('[wecom-bot] 🔐 认证成功，智能机器人已就绪');
  });

  wsClient.on('disconnected', (reason) => {
    state.connected = false;
    state.authenticated = false;
    console.log(`[wecom-bot] 🔌 连接断开: ${reason}`);
  });

  wsClient.on('reconnecting', (attempt) => {
    state.reconnectAttempt = attempt;
    console.log(`[wecom-bot] 🔄 正在重连 (第 ${attempt} 次)...`);
  });

  wsClient.on('error', (err) => {
    state.lastError = err.message;
    console.error(`[wecom-bot] ❌ 错误: ${err.message}`);
  });

  // ── 消息事件 ──
  wsClient.on('message.text', async (frame) => {
    const content = frame.body?.text?.content || '';
    state.lastInboundAt = new Date().toISOString();
    state.lastInboundType = '文本消息';
    state.lastReplyError = null;
    console.log('[wecom-bot] 💬 收到文本消息');

    const streamId = AiBot.generateReqId('stream');
    try {
      // 先立即给出处理中状态，符合企业微信机器人对首帧时效的要求；
      // 再发送最终查询结果，避免只有最终帧时部分客户端不展示回复。
      await wsClient.replyStream(frame, streamId, '正在查询经营数据…', false);
      const reply = textMessageHandler
        ? await textMessageHandler(content, frame)
        : `收到：「${content}」`;
      await wsClient.replyStream(frame, streamId, reply || '暂时无法理解这个问题。回复“帮助”可查看可用查询。', true);
      state.lastReplyAt = new Date().toISOString();
      console.log('[wecom-bot] ✅ 文本回复已发送');
    } catch (e) {
      state.lastReplyError = e.message;
      console.error('[wecom-bot] 回复失败:', e.message);
    }
  });

  wsClient.on('message.image', (frame) => {
    state.lastInboundAt = new Date().toISOString();
    state.lastInboundType = '图片消息';
    console.log('[wecom-bot] 🖼️ 收到图片消息');
    wsClient.replyStream(frame, AiBot.generateReqId('stream'), '收到图片 👍', true)
      .then(() => { state.lastReplyAt = new Date().toISOString(); })
      .catch((e) => { state.lastReplyError = e.message; });
  });

  wsClient.on('message.voice', (frame) => {
    state.lastInboundAt = new Date().toISOString();
    state.lastInboundType = '语音消息';
    const voiceText = frame.body?.voice?.text || '';
    console.log('[wecom-bot] 🎤 收到语音消息');
    wsClient.replyStream(frame, AiBot.generateReqId('stream'), `语音识别：「${voiceText}」`, true)
      .then(() => { state.lastReplyAt = new Date().toISOString(); })
      .catch((e) => { state.lastReplyError = e.message; });
  });

  wsClient.on('message.mixed', (frame) => {
    state.lastInboundAt = new Date().toISOString();
    state.lastInboundType = '图文消息';
    console.log('[wecom-bot] 📋 收到图文消息');
    wsClient.replyStream(frame, AiBot.generateReqId('stream'), '收到图文消息 👍', true)
      .then(() => { state.lastReplyAt = new Date().toISOString(); })
      .catch((e) => { state.lastReplyError = e.message; });
  });

  wsClient.on('message.file', async (frame) => {
    state.lastInboundAt = new Date().toISOString();
    state.lastInboundType = '文件消息';
    const file = frame.body?.file || {};
    const fileName = file.filename || file.name || '未知文件';
    console.log(`[wecom-bot] 📎 收到文件：${fileName}`);
    const streamId = AiBot.generateReqId('stream');
    try {
      if (!file.url) throw new Error('文件缺少下载地址');
      const downloaded = await wsClient.downloadFile(file.url, file.aeskey);
      const buffer = downloaded?.buffer;
      if (!buffer || !buffer.length) throw new Error('文件下载为空');
      const resolvedName = downloaded?.filename || fileName;
      console.log(`[wecom-bot] ⬇️ 文件已下载：${resolvedName} (${buffer.length} bytes)`);
      const reply = fileMessageHandler
        ? await fileMessageHandler({ buffer, filename: resolvedName, frame })
        : `已收到文件「${resolvedName}」，但当前没有可用的文件处理逻辑。`;
      await wsClient.replyStream(frame, streamId, reply || '文件已接收。', true);
      state.lastReplyAt = new Date().toISOString();
      console.log('[wecom-bot] ✅ 文件处理回复已发送');
    } catch (e) {
      state.lastReplyError = e.message;
      console.error('[wecom-bot] 文件处理失败:', e.message);
      await wsClient.replyStream(frame, streamId, `文件处理失败：${e.message}`, true).catch(() => {});
    }
  });

  // ── 事件回调 ──
  wsClient.on('event.enter_chat', (frame) => {
    console.log('[wecom-bot] 👋 用户进入了会话');
    wsClient.replyWelcome(frame, {
      msgtype: 'text',
      text: { content: '您好！我是鹅太公经营助手 🦆\n可以直接问我：昨天全门店营业额、某门店本月实收、外卖本周订单量。回复“帮助”查看示例。' },
    }).catch(() => {});
  });

  wsClient.on('event.template_card_event', (frame) => {
    console.log('[wecom-bot] 🃏 模板卡片事件:', JSON.stringify(frame.body?.event).slice(0, 200));
  });

  wsClient.on('event.feedback_event', (frame) => {
    console.log('[wecom-bot] ⭐ 用户反馈:', JSON.stringify(frame.body?.event).slice(0, 200));
  });

  // ── 建立连接 ──
  wsClient.connect();
  console.log('[wecom-bot] 🚀 智能机器人正在连接...');
  return { ok: true };
}

/**
 * 断开机器人连接
 */
function stop() {
  if (wsClient) {
    try { wsClient.disconnect(); } catch {}
    wsClient = null;
  }
  state.connected = false;
  state.authenticated = false;
  console.log('[wecom-bot] ⏹️  智能机器人已断开');
}

/**
 * 重新读取 config.json 并建立新的长连接。
 * 保存机器人凭据后调用，避免必须重启整个后端服务。
 */
async function restart() {
  stop();
  return start();
}

/**
 * 获取当前状态
 * @returns {object}
 */
function getStatus() {
  const cfg = loadConfig();
  return {
    configured: !!(cfg.botId && cfg.botSecret),
    botIdMasked: cfg.botId
      ? cfg.botId.slice(0, 6) + '****' + cfg.botId.slice(-4)
      : '',
    connected: state.connected,
    authenticated: state.authenticated,
    startedAt: state.startedAt,
    lastError: state.lastError,
    reconnectAttempt: state.reconnectAttempt,
    businessQueryEnabled: !!textMessageHandler,
    lastInboundAt: state.lastInboundAt,
    lastInboundType: state.lastInboundType,
    lastReplyAt: state.lastReplyAt,
    lastReplyError: state.lastReplyError,
  };
}

function setTextMessageHandler(handler) {
  textMessageHandler = typeof handler === 'function' ? handler : null;
}

/** 注册文件消息处理：收到企微文件（如下发的员工表格）后下载解密并交给业务处理 */
function setFileMessageHandler(handler) {
  fileMessageHandler = typeof handler === 'function' ? handler : null;
}

/**
 * 获取 WSClient 实例（供高级用途）
 */
function getClient() {
  return wsClient;
}

module.exports = { start, stop, restart, getStatus, getClient, setTextMessageHandler, setFileMessageHandler };
