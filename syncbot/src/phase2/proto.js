'use strict';
/**
 * 阶段2：Unix Socket 宿主协议（客户端/服务端共用的最小 NDJSON 协议）
 * 传输：每行一个 JSON 请求 {id, cmd, args}，每行一个 JSON 响应 {id, ok, result, error}
 */
const net = require('net');

const PROTOCOL_VERSION = 1;

/** 供服务端：把 socket 上的字节流切成一行行 JSON */
function createLineDecoder(onMessage) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        onMessage({ __parseError: e.message });
        continue;
      }
      onMessage(msg);
    }
    if (buf.length > 4 * 1024 * 1024) buf = ''; // 防御：异常巨行
  };
}

/** 供客户端：一次连接发一个命令并等待一个响应 */
function request(socketPath, cmd, args = {}, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let done = false;
    let buf = '';
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch (_) {}
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error(`宿主响应超时（${timeoutMs}ms）：${cmd}`)), timeoutMs);
    sock.on('connect', () => {
      sock.write(JSON.stringify({ id: Date.now(), v: PROTOCOL_VERSION, cmd, args }) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      clearTimeout(timer);
      let resp;
      try {
        resp = JSON.parse(buf.slice(0, idx));
      } catch (e) {
        return finish(reject, new Error(`宿主响应不是合法 JSON：${e.message}`));
      }
      if (resp.ok) finish(resolve, resp.result);
      else finish(reject, new Error(resp.error || '宿主返回失败'));
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      const hint =
        e.code === 'ENOENT'
          ? '（未找到宿主 socket：请确认 syncbot-browser.service 正在运行）'
          : e.code === 'ECONNREFUSED'
            ? '（宿主 socket 存在但无人监听：请重启 syncbot-browser.service）'
            : '';
      finish(reject, new Error(`连接宿主失败：${e.code || e.message}${hint}`));
    });
  });
}

module.exports = { PROTOCOL_VERSION, createLineDecoder, request };
