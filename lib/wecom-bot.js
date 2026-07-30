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

// ── 状态跟踪 ──
const state = {
  connected: false,
  authenticated: false,
  lastError: null,
  reconnectAttempt: 0,
  startedAt: null,
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
    const userName = frame.body?.from?.userid || '未知用户';
    console.log(`[wecom-bot] 💬 ${userName}: ${content}`);

    // 简单回显（后续可接入 AI 处理）
    const streamId = AiBot.generateReqId('stream');
    try {
      await wsClient.replyStream(frame, streamId, `收到：「${content}」`, true);
    } catch (e) {
      console.error('[wecom-bot] 回复失败:', e.message);
    }
  });

  wsClient.on('message.image', (frame) => {
    const userName = frame.body?.from?.userid || '未知用户';
    console.log(`[wecom-bot] 🖼️  ${userName}: [图片消息]`);
    wsClient.replyStream(frame, AiBot.generateReqId('stream'), '收到图片 👍', true).catch(() => {});
  });

  wsClient.on('message.voice', (frame) => {
    const userName = frame.body?.from?.userid || '未知用户';
    const voiceText = frame.body?.voice?.text || '';
    console.log(`[wecom-bot] 🎤 ${userName}: ${voiceText}`);
    wsClient.replyStream(frame, AiBot.generateReqId('stream'), `语音识别：「${voiceText}」`, true).catch(() => {});
  });

  wsClient.on('message.mixed', (frame) => {
    const userName = frame.body?.from?.userid || '未知用户';
    console.log(`[wecom-bot] 📋 ${userName}: [图文混排消息]`);
    wsClient.replyStream(frame, AiBot.generateReqId('stream'), '收到图文消息 👍', true).catch(() => {});
  });

  wsClient.on('message.file', (frame) => {
    const userName = frame.body?.from?.userid || '未知用户';
    const fileName = frame.body?.file?.filename || '未知文件';
    console.log(`[wecom-bot] 📎 ${userName}: ${fileName}`);
    wsClient.replyStream(frame, AiBot.generateReqId('stream'), `收到文件「${fileName}」`, true).catch(() => {});
  });

  // ── 事件回调 ──
  wsClient.on('event.enter_chat', (frame) => {
    const userName = frame.body?.from?.userid || '新朋友';
    console.log(`[wecom-bot] 👋 ${userName} 进入了会话`);
    wsClient.replyWelcome(frame, {
      msgtype: 'text',
      text: { content: `您好！我是鹅太公智能助手 🦆\n有什么可以帮您的吗？` },
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
  };
}

/**
 * 获取 WSClient 实例（供高级用途）
 */
function getClient() {
  return wsClient;
}

module.exports = { start, stop, getStatus, getClient };
